import { randomUUID } from "crypto";
import { Game } from "../shared/engine/game.js";
import { Clock } from "../shared/clock.js";
import { resolveParams } from "../shared/params.js";
import { MSG } from "../shared/net/protocol.js";
import { DISCONNECT_ABORT_MS, REMATCH_TIMEOUT_MS } from "../shared/config.js";
import { log, shortId, formatDuration } from "./logger.js";
import { getPlayerById, displayRating } from "./playerRepository.js";

export class Match {
  constructor(matchId, inviteCode, rawParams, onClose, onGameEnd = null, rated = false) {
    this.matchId = matchId;
    this.inviteCode = inviteCode;
    this.players = []; // { nickname, playerIndex, ws, sessionId, connected, accountPlayerId }
    // waiting: <2 players. active: game in progress. over: game ended
    // normally (rematch or leave still possible). aborted: a disconnect
    // grace period expired — terminal, about to be removed.
    this.status = "waiting";
    this.rated = rated; // set once at creation, never toggled mid-match
    this.game = null;
    this.activeParams = null; // the actual (seeded) params the current Game was built with — needed to replay it identically on reconnect
    this.actions = []; // ordered log of applied actions, replayable through a fresh Game — this IS the reconnect/resync payload
    this.endInfo = null; // { reason, winnerIndex } once status is "over" or "aborted"
    this.clock = null; // server-authoritative Clock for the current game, or null if this match has no time control
    this._onClose = onClose;
    this._onGameEnd = onGameEnd; // fired once per finished game, only when a game actually started — see _logMatchEnd
    this._abortTimer = null;
    this._rematchTimer = null;
    this._flagTimer = null;
    this.rematchRequestedBy = new Set(); // playerIndex values that have asked for a rematch
    this.lastStartingPlayerIndex = null; // who moved first in the most recent game — null until the first game starts
    this._gameCount = 0; // incremented in _start() — first game vs rematch, for logging
    this._gameStartedAt = null; // Date.now() at last _start() — for logging match duration

    // Re-resolve on the server: the creator's client already clamped these,
    // but the server never trusts client-sent values directly. This is the
    // same function the client uses, so there's exactly one place that
    // defines what a valid params object looks like.
    this.params = resolveParams(rawParams?.mode, rawParams);
  }

  // sessionId is the durable player identity — a ws is just whichever
  // socket currently happens to be attached to that identity, and it's
  // expected to change across reconnects/refreshes. Never key player state
  // off ws itself for anything meant to survive a reconnect.
  addPlayer(nickname, ws, accountPlayerId = null) {
    const playerIndex = this.players.length;
    const sessionId = randomUUID();
    const player = { nickname, playerIndex, ws, sessionId, connected: true, accountPlayerId };
    this.players.push(player);
    if (this.players.length === 2) this._start();
    return player;
  }

  // lookup used by the reconnect/resync handshake, before a new ws
  // has been associated with this match.
  findPlayerBySessionId(sessionId) {
    return this.players.find((p) => p.sessionId === sessionId) || null;
  }

  isFull() {
    return this.players.length >= 2;
  }

  _start() {
    this.status = "active";

    const startingPlayerIndex =
      this.lastStartingPlayerIndex === null ? (Math.random() < 0.5 ? 0 : 1) : 1 - this.lastStartingPlayerIndex;
    this.lastStartingPlayerIndex = startingPlayerIndex;

    const finalParams = { ...this.params, seed: Date.now(), startingPlayerIndex };
    this.activeParams = finalParams; // exact params to replay from, seed included
    this.game = new Game(finalParams);
    this.actions = []; // fresh log for this game (matters once rematch reuses this Match)
    this.endInfo = null;
    clearTimeout(this._rematchTimer); // a fresh game means any pending rematch request is moot
    this.rematchRequestedBy.clear();

    // (re)build the clock fresh for every game, including rematches.
    // Matches with no timeControl just stay clockless (this.clock === null).
    clearTimeout(this._flagTimer);
    const now = Date.now();
    if (finalParams.timeControl) {
      this.clock = Clock.fromConfig(finalParams.timeControl);
      this.clock.startTurn(startingPlayerIndex, now);
      this._armFlagTimer(now);
    } else {
      this.clock = null;
    }

    this.broadcastPersonalized((p) => ({
      type: MSG.MATCH_START,
      matchId: this.matchId,
      params: finalParams,
      yourPlayerIndex: p.playerIndex,
      players: this._playersPayload(),
      rated: this.rated,
      clock: this.clock ? this.clock.snapshot(now) : null,
    }));

    this._gameCount++;
    this._gameStartedAt = now;
    const starter = this.players.find((p) => p.playerIndex === startingPlayerIndex);
    const label = this._gameCount === 1 ? "started" : `rematch #${this._gameCount} started`;
    log(
      `Match ${shortId(this.matchId)} ${label}: ${this.players[0].nickname} vs ${this.players[1].nickname} (${starter?.nickname} first)`,
    );
  }

  // Shared by every game-ending path (no-moves, resign, timeout, abort).
  // Called after this.status/this.endInfo are already set.
  _logMatchEnd(reason) {
    if (!this.game) {
      // waiting-room abandonment — no game ever started, nothing to score
      log(`Match ${shortId(this.matchId)} closed: reason=${reason} (never started)`);
      return;
    }
    const duration = this._gameStartedAt ? formatDuration(Date.now() - this._gameStartedAt) : "?";
    const scores = this.game.players.map((p) => p.score).join("-");
    const winnerIndex = this.endInfo?.winnerIndex;
    const winnerName =
      winnerIndex != null ? (this.players.find((p) => p.playerIndex === winnerIndex)?.nickname ?? "?") : "draw";
    log(
      `Match ${shortId(this.matchId)} ended: reason=${reason} winner=${winnerName} score=${scores} duration=${duration}`,
    );
    this._onGameEnd?.(reason);
  }

  // (re)arms the flag-fall timer for whoever the clock says is
  // currently ticking, sized to exactly how much time they have left as of
  // `now`. Always call this right after a startTurn (or after resuming
  // ticking on reconnect) — never left armed across a stopTurn/freeze.
  _armFlagTimer(now) {
    clearTimeout(this._flagTimer);
    if (!this.clock || this.clock.currentPlayerIndex === null) return;
    const remaining = this.clock.getRemaining(this.clock.currentPlayerIndex, now);
    this._flagTimer = setTimeout(() => this._onFlagFall(), remaining);
  }

  // fires when a player's bank hits 0. setTimeout has some slop, so
  // this re-verifies against the clock's own math (isFlagged) rather than
  // trusting the timer alone — if it fired a hair early, just re-arm for
  // the remainder instead of ending the match prematurely.
  _onFlagFall() {
    if (this.status !== "active" || !this.clock || this.clock.currentPlayerIndex === null) return;

    const now = Date.now();
    if (!this.clock.isFlagged(now)) {
      this._armFlagTimer(now);
      return;
    }

    const flaggedIndex = this.clock.currentPlayerIndex;
    const winner = this.players.find((p) => p.playerIndex !== flaggedIndex);
    this.clock.freeze(now); // no increment — running out is not a completed move

    this.status = "over"; // a decided result, same standing as any other natural end — rematch still possible
    this.endInfo = { reason: "timeout", winnerIndex: winner?.playerIndex ?? null };
    this._logMatchEnd("timeout");
    this.broadcast({
      type: MSG.MATCH_ENDED,
      reason: "timeout",
      winnerIndex: winner?.playerIndex ?? null,
      clock: this.clock.snapshot(now), // clock is guaranteed non-null on this path
    });
  }

  attemptMove(ws, pieceType, shape, anchorRow, anchorCol) {
    if (this.status !== "active") return;

    const player = this.players.find((p) => p.ws === ws);
    if (!player) return;
    if (player.playerIndex !== this.game.currentPlayerIndex) {
      this._sendTo(ws, { type: MSG.MOVE_REJECTED, reason: "Not your turn" });
      return;
    }

    // race guard — the flag-fall timer is armed for exactly the
    // player's remaining time, but a move can still land in the same tick
    // it fires. Re-check against the clock's own math rather than trusting
    // the timer to have already caught it, so a move can't sneak in after
    // time was genuinely up.
    const now = Date.now();
    if (this.clock && this.clock.isFlagged(now)) {
      this._onFlagFall();
      return;
    }

    const applied = this.game.attemptPlacement(pieceType, shape, anchorRow, anchorCol);
    if (!applied) {
      this._sendTo(ws, { type: MSG.MOVE_REJECTED, reason: "Illegal move" });
      return;
    }

    if (this.game.gameOver) {
      this.status = "over"; // game ended normally — not terminal, rematch still possible
      this.endInfo = { reason: "no-moves", winnerIndex: this.game.winnerIndex };
      this._logMatchEnd("no-moves");
    }

    this._advanceClockAfterMove(now);

    const action = { kind: "placement", pieceType, shape, anchorRow, anchorCol, playerIndex: player.playerIndex };
    this.actions.push(action); // replay log for reconnect/resync

    this.broadcast({
      type: MSG.MOVE_APPLIED,
      action,
      hash: this.game.getStateHash(),
      gameOver: this.game.gameOver,
      winnerIndex: this.game.gameOver ? this.game.winnerIndex : null,
      clock: this.clock ? this.clock.snapshot(now) : null,
    });
  }

  attemptPass(ws) {
    if (this.status !== "active") return;

    const player = this.players.find((p) => p.ws === ws);
    if (!player) return;
    if (player.playerIndex !== this.game.currentPlayerIndex) {
      this._sendTo(ws, { type: MSG.MOVE_REJECTED, reason: "Not your turn" });
      return;
    }

    // same race guard as attemptMove — see comment there.
    const now = Date.now();
    if (this.clock && this.clock.isFlagged(now)) {
      this._onFlagFall();
      return;
    }

    const applied = this.game.pass();
    if (!applied) {
      this._sendTo(ws, { type: MSG.MOVE_REJECTED, reason: "Cannot pass, you have a move" });
      return;
    }

    if (this.game.gameOver) {
      this.status = "over"; // game ended normally — not terminal, rematch still possible
      this.endInfo = { reason: "no-moves", winnerIndex: this.game.winnerIndex };
      this._logMatchEnd("no-moves");
    }

    this._advanceClockAfterMove(now);

    const action = { kind: "pass", playerIndex: player.playerIndex };
    this.actions.push(action); // replay log for reconnect/resync

    this.broadcast({
      type: MSG.MOVE_APPLIED,
      action,
      hash: this.game.getStateHash(),
      gameOver: this.game.gameOver,
      winnerIndex: this.game.gameOver ? this.game.winnerIndex : null,
      clock: this.clock ? this.clock.snapshot(now) : null,
    });
  }

  // Shared by attemptMove/attemptPass on a successful, applied move.
  // Stops the mover's clock (banking their Fischer increment) and, if the
  // game isn't over, starts the next player's clock and re-arms the
  // flag-fall timer for them. If the game just ended, deliberately leaves
  // the clock stopped (stopTurn already cleared currentPlayerIndex) rather
  // than starting anyone new — there's no next turn to time.
  _advanceClockAfterMove(now) {
    if (!this.clock) return;
    clearTimeout(this._flagTimer); // was armed for the mover's own turn — stale the instant they move, whether or not the game just ended
    this.clock.stopTurn(now);
    if (!this.game.gameOver) {
      this.clock.startTurn(this.game.currentPlayerIndex, now);
      this._armFlagTimer(now);
    }
  }

  handleDisconnect(ws) {
    const player = this.players.find((p) => p.ws === ws);
    if (!player) return; // already superseded by a reconnect, or unknown socket

    player.connected = false;
    player.ws = null;
    player.disconnectedAt = Date.now();

    if (this.status === "aborted") return; // already terminal, nothing left to do

    const opponent = this.players.find((p) => p !== player);

    if (opponent?.connected && this.status === "active") {
      this._sendTo(opponent.ws, {
        type: MSG.OPPONENT_DISCONNECTED,
        playerIndex: player.playerIndex,
        abortInMs: DISCONNECT_ABORT_MS,
      });
      log(
        `Match ${shortId(this.matchId)}: ${player.nickname} disconnected, aborting in ${Math.round(DISCONNECT_ABORT_MS / 1000)}s if not back`,
      );
    }

    this._armAbortTimer();
  }

  _armAbortTimer() {
    clearTimeout(this._abortTimer);
    this._abortTimer = setTimeout(() => this._onAbortTimeout(), DISCONNECT_ABORT_MS);
  }

  // Called for RECONNECT_ATTEMPT — sessionId is the durable identity,
  // ws is whatever fresh socket just connected. Returns the SYNC_STATE
  // payload to send back, or null if this session can't reconnect here
  // (unknown, or the match is already terminal).
  reconnect(sessionId, ws) {
    if (this.status === "aborted") return null;

    const player = this.findPlayerBySessionId(sessionId);
    if (!player) return null;

    clearTimeout(this._abortTimer);
    const goneMs = player.disconnectedAt ? Date.now() - player.disconnectedAt : null;
    player.ws = ws;
    player.connected = true;
    player.disconnectedAt = null;

    const opponent = this.players.find((p) => p !== player);
    if (opponent?.connected) {
      this._sendTo(opponent.ws, { type: MSG.OPPONENT_RECONNECTED, playerIndex: player.playerIndex });
    }
    if (goneMs != null) {
      log(`Match ${shortId(this.matchId)}: ${player.nickname} reconnected after ${formatDuration(goneMs)}`);
    }

    return this.buildSyncState(player);
  }

  // The reconstruction payload — shared by reconnect success AND
  // hash-mismatch resync (REQUEST_RESYNC). Deliberately ships the action
  // log, not a snapshot: the client rebuilds by doing exactly what it
  // already does for a live game (new Game(params) + replay each action
  // through the same attemptPlacement/pass calls), so there's exactly one
  // code path that knows how to construct game state, not two to keep in
  // sync. hash lets the client verify the replay actually landed on the
  // same state instead of just trusting it did.
  buildSyncState(forPlayer) {
    return {
      type: MSG.SYNC_STATE,
      yourPlayerIndex: forPlayer.playerIndex,
      players: this._playersPayload(),
      rated: this.rated,
      inviteCode: this.inviteCode, // only meaningful while status === "waiting"
      params: this.activeParams ?? this.params, // fall back to the un-seeded config params while still "waiting" — activeParams isn't set until the game actually starts
      actions: this.actions,
      hash: this.game ? this.game.getStateHash() : null,
      status: this.status,
      endInfo: this.endInfo,
      // A fresh snapshot, not a cached one — the clock keeps running
      // through a disconnect, so whatever time passed while this player was gone must
      // already be reflected in what they're handed on the way back in.
      clock: this.clock ? this.clock.snapshot(Date.now()) : null,
    };
  }

  // Shared by MATCH_START and buildSyncState — rating is only looked up
  // (and only meaningful) for rated matches; unrated always sends null so
  // the client has a uniform "no rating to show" signal either way.
  _playersPayload() {
    return this.players.map((p) => ({
      index: p.playerIndex,
      nickname: p.nickname,
      rating: this.rated && p.accountPlayerId != null ? displayRating(getPlayerById(p.accountPlayerId)) : null,
    }));
  }

  // Two genuinely different situations, must not conflate them.
  // A disconnect can time out while the match is still "active" (game was
  // genuinely interrupted — this is a real forfeit) OR after it already
  // flipped to "over" in the meantime (the still-connected player finished
  // the game on their own turns while the timer was counting down — the
  // result is already decided, there is nothing left to forfeit).
  _onAbortTimeout() {
    const stillDisconnected = this.players.some((p) => !p.connected);
    if (!stillDisconnected) return; // reconnected before the timer fired

    const remaining = this.players.find((p) => p.connected);

    if (this.status === "over") {
      // Game already concluded on its own merits — just let the other
      // player know no rematch is coming, no result to change.
      clearTimeout(this._rematchTimer); // nothing left to rematch
      if (remaining) this._sendTo(remaining.ws, { type: MSG.OPPONENT_LEFT });
      this._onClose?.();
      return;
    }

    // status is "active" (or "waiting", with no opponent to notify) —
    // a genuine forfeit-by-abandonment. Deliberately NOT touching
    // this.game here: winnerIndex there is a getter derived from score
    // comparison, not something a forfeit should override — a forfeit
    // winner and a score-based winner are different concepts, and the
    // disconnected player may well have been ahead on points. The forfeit
    // outcome lives only in this message; the client treats MATCH_ENDED as
    // authoritative and shows the endcard from it directly.
    this.status = "aborted";
    this.endInfo = { reason: "abort", winnerIndex: remaining?.playerIndex ?? null };
    this._logMatchEnd("abort");

    // Same reasoning as resign() — an abandonment isn't a completed
    // move, freeze rather than stopTurn, and clear the flag timer so it
    // can't fire after the match is already terminal.
    clearTimeout(this._flagTimer);
    const now = Date.now();
    if (this.clock) this.clock.freeze(now);

    if (remaining) {
      this._sendTo(remaining.ws, {
        type: MSG.MATCH_ENDED,
        reason: "abort",
        winnerIndex: remaining.playerIndex,
        clock: this.clock ? this.clock.snapshot(now) : null,
      });
    }
    this._onClose?.();
  }

  // Deliberate, immediate forfeit — only meaningful mid-game.
  // Match stays alive afterward (status "over", same as a natural end) since
  // this is an active decision by an engaged player, not an abandonment —
  // no reason to assume nobody's coming back for a rematch.
  resign(ws) {
    if (this.status !== "active") return;
    const player = this.players.find((p) => p.ws === ws);
    if (!player) return;
    const opponent = this.players.find((p) => p !== player);

    this.status = "over";
    this.endInfo = { reason: "resign", winnerIndex: opponent.playerIndex };
    this._logMatchEnd("resign");

    // resigning isn't a completed move — freeze (not stopTurn), and
    // clear the flag timer so a stale timeout can't fire after the match
    // has already ended for a different reason.
    clearTimeout(this._flagTimer);
    const now = Date.now();
    if (this.clock) this.clock.freeze(now);

    this.broadcast({
      type: MSG.MATCH_ENDED,
      reason: "resign",
      winnerIndex: opponent.playerIndex,
      clock: this.clock ? this.clock.snapshot(now) : null,
    });
  }

  // Explicit "I'm done with this match" signal — waiting-room
  // cancel, mid-game leave (counts as resign — no free walk-away from a
  // losing position), or leaving after the game already ended. Unlike a
  // mere disconnect, this is deliberate: no ambiguity to wait out, so it
  // always ends in immediate cleanup rather than a grace period.
  leave(ws) {
    const player = this.players.find((p) => p.ws === ws);
    if (!player) return;

    if (this.status === "active") {
      this.resign(ws);
      // Deliberately not closing here: an active opponent might still be
      // sitting on the resulting endcard wanting a rematch — the match
      // should live on exactly as it would after a natural game end, not be
      // torn down just because the loser happened to be the one who left.
      return;
    }

    if (this.status === "waiting") {
      // Solo creator backing out before anyone joined — nobody else is
      // waiting on anything, clean up immediately.
      this.status = "aborted";
      this._onClose?.();
      return;
    }

    // status is already "over" or "aborted" — this is someone leaving after
    // the result was already decided (declining a rematch, or just moving
    // on). Nothing about the outcome changes; let a still-present opponent
    // know no rematch is coming, then close it out for good.
    clearTimeout(this._rematchTimer);
    const opponent = this.players.find((p) => p !== player);
    if (opponent?.connected) {
      this._sendTo(opponent.ws, { type: MSG.OPPONENT_LEFT });
    }
    this._onClose?.();
  }

  // Symmetric, no explicit accept/decline — first request marks that
  // player ready and pings the opponent; once both have asked, the match
  // just starts (same _start() as the very first game, on the same
  // matchId/players — see the alternating-first-mover logic there). Not
  // clicking rematch and clicking "back to menu" are effectively the same
  // thing (see leave()), so there's no real "decline" message to send.
  requestRematch(ws) {
    if (this.status !== "over") return; // only a naturally-completed game can be rematched — not mid-game, not a forfeit/abort
    const player = this.players.find((p) => p.ws === ws);
    if (!player) return;

    this.rematchRequestedBy.add(player.playerIndex);

    if (this.rematchRequestedBy.size === 2) {
      clearTimeout(this._rematchTimer);
      this._start(); // broadcasts a fresh MATCH_START to both — same message a first game uses
      return;
    }

    const opponent = this.players.find((p) => p !== player);
    if (opponent?.connected) {
      this._sendTo(opponent.ws, { type: MSG.OPPONENT_WANTS_REMATCH });
    }

    clearTimeout(this._rematchTimer);
    this._rematchTimer = setTimeout(() => this._onRematchTimeout(), REMATCH_TIMEOUT_MS);
  }

  _onRematchTimeout() {
    if (this.rematchRequestedBy.size === 0) return; // already resolved (both asked, or match moved on)
    this.rematchRequestedBy.clear();

    // Both sides have a stale UI state to clear here: the requester's
    // "waiting on opponent" prompt, and the opponent's "opponent wants a
    // rematch" nudge — the offer expiring unaccepted moots both of them.
    this.broadcast({ type: MSG.REMATCH_CANCELLED, reason: "timeout" });
  }

  // Guarded single-socket send, used by reject paths
  _sendTo(ws, msg) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("send failed:", err.message);
    }
  }

  broadcast(msg) {
    for (const p of this.players) {
      this._sendTo(p.ws, msg);
    }
  }

  broadcastPersonalized(buildMsg) {
    for (const p of this.players) {
      this._sendTo(p.ws, buildMsg(p));
    }
  }
}
