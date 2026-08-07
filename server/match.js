import { randomUUID } from "crypto";
import { Game } from "../js/game.js";
import { resolveParams } from "../js/params.js";
import { MSG } from "../js/net/protocol.js";
import { DISCONNECT_ABORT_MS } from "../js/config.js";

export class Match {
  // ADDED: onClose — called once this match is truly done and should be
  // removed from the manager's maps (abort timeout fires, or later a
  // both-players-left path). Match doesn't reach into the manager itself;
  // the manager hands down the one callback it needs.
  constructor(matchId, inviteCode, rawParams, onClose) {
    this.matchId = matchId;
    this.inviteCode = inviteCode;
    this.players = []; // { nickname, playerIndex, ws, sessionId, connected }
    // waiting: <2 players. active: game in progress. over: game ended
    // normally (rematch or leave still possible). aborted: a disconnect
    // grace period expired — terminal, about to be removed.
    this.status = "waiting";
    this.game = null;
    this.activeParams = null; // ADDED: the actual (seeded) params the current Game was built with — needed to replay it identically on reconnect
    this.actions = []; // ADDED: ordered log of applied actions, replayable through a fresh Game — this IS the reconnect/resync payload
    this.endInfo = null; // ADDED: { reason, winnerIndex } once status is "over" or "aborted"
    this._onClose = onClose;
    this._abortTimer = null;

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
  addPlayer(nickname, ws) {
    const playerIndex = this.players.length;
    const sessionId = randomUUID();
    const player = { nickname, playerIndex, ws, sessionId, connected: true };
    this.players.push(player);
    if (this.players.length === 2) this._start();
    return player;
  }

  // ADDED: lookup used by the reconnect/resync handshake, before a new ws
  // has been associated with this match.
  findPlayerBySessionId(sessionId) {
    return this.players.find((p) => p.sessionId === sessionId) || null;
  }

  isFull() {
    return this.players.length >= 2;
  }

  _start() {
    this.status = "active";
    const finalParams = { ...this.params, seed: Date.now() };
    this.activeParams = finalParams; // ADDED: exact params to replay from, seed included
    this.game = new Game(finalParams);
    this.actions = []; // ADDED: fresh log for this game (matters once rematch reuses this Match)
    this.endInfo = null; // ADDED

    this.broadcastPersonalized((p) => ({
      type: MSG.MATCH_START,
      matchId: this.matchId,
      params: finalParams,
      yourPlayerIndex: p.playerIndex,
      players: this.players.map((pp) => ({ index: pp.playerIndex, nickname: pp.nickname })),
    }));
  }

  attemptMove(ws, pieceType, shape, anchorRow, anchorCol) {
    if (this.status !== "active") return;

    const player = this.players.find((p) => p.ws === ws);
    if (!player) return;
    if (player.playerIndex !== this.game.currentPlayerIndex) {
      this._sendTo(ws, { type: MSG.MOVE_REJECTED, reason: "Not your turn" });
      return;
    }

    const applied = this.game.attemptPlacement(pieceType, shape, anchorRow, anchorCol);
    if (!applied) {
      this._sendTo(ws, { type: MSG.MOVE_REJECTED, reason: "Illegal move" });
      return;
    }

    if (this.game.gameOver) {
      this.status = "over"; // game ended normally — not terminal, rematch still possible
      this.endInfo = { reason: "no-moves", winnerIndex: this.game.winnerIndex }; // ADDED
    }

    const action = { kind: "placement", pieceType, shape, anchorRow, anchorCol, playerIndex: player.playerIndex };
    this.actions.push(action); // ADDED: replay log for reconnect/resync

    this.broadcast({
      type: MSG.MOVE_APPLIED,
      action,
      hash: this.game.getStateHash(),
      gameOver: this.game.gameOver,
      winnerIndex: this.game.gameOver ? this.game.winnerIndex : null,
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

    const applied = this.game.pass();
    if (!applied) {
      this._sendTo(ws, { type: MSG.MOVE_REJECTED, reason: "Cannot pass, you have a move" });
      return;
    }

    if (this.game.gameOver) {
      this.status = "over"; // game ended normally — not terminal, rematch still possible
      this.endInfo = { reason: "no-moves", winnerIndex: this.game.winnerIndex }; // ADDED
    }

    const action = { kind: "pass", playerIndex: player.playerIndex };
    this.actions.push(action); // ADDED: replay log for reconnect/resync

    this.broadcast({
      type: MSG.MOVE_APPLIED,
      action,
      hash: this.game.getStateHash(),
      gameOver: this.game.gameOver,
      winnerIndex: this.game.gameOver ? this.game.winnerIndex : null,
    });
  }

  // FIXED: disconnect is no longer terminal. Mark the player gone, tell the
  // opponent (if still around), and give it DISCONNECT_ABORT_MS to either
  // reconnect (step 3, not wired up yet) or time out. The manager no longer
  // removes the match from here — only _onAbortTimeout does, once it's
  // actually given up.
  handleDisconnect(ws) {
    const player = this.players.find((p) => p.ws === ws);
    if (!player) return; // already superseded by a reconnect, or unknown socket

    player.connected = false;
    player.ws = null;

    if (this.status === "aborted") return; // already terminal, nothing left to do

    const opponent = this.players.find((p) => p !== player);
    // FIXED: only worth an immediate "they might come back" notice while a
    // live game is actually in progress. Post-game (or pre-game "waiting"),
    // a disconnect isn't urgent — and is often just the tail end of a
    // deliberate resign/leave, whose own message already told the opponent
    // what happened; a follow-up "opponent disconnected" would just be
    // confusing noise after an already-settled result. The abort timer
    // still cleans the match up regardless of status.
    if (opponent?.connected && this.status === "active") {
      this._sendTo(opponent.ws, {
        type: MSG.OPPONENT_DISCONNECTED,
        playerIndex: player.playerIndex,
        abortInMs: DISCONNECT_ABORT_MS,
      });
    }

    this._armAbortTimer();
  }

  // ADDED
  _armAbortTimer() {
    clearTimeout(this._abortTimer);
    this._abortTimer = setTimeout(() => this._onAbortTimeout(), DISCONNECT_ABORT_MS);
  }

  // ADDED: called for RECONNECT_ATTEMPT — sessionId is the durable identity,
  // ws is whatever fresh socket just connected. Returns the SYNC_STATE
  // payload to send back, or null if this session can't reconnect here
  // (unknown, or the match is already terminal).
  reconnect(sessionId, ws) {
    if (this.status === "aborted") return null;

    const player = this.findPlayerBySessionId(sessionId);
    if (!player) return null;

    clearTimeout(this._abortTimer);
    player.ws = ws;
    player.connected = true;

    const opponent = this.players.find((p) => p !== player);
    if (opponent?.connected) {
      this._sendTo(opponent.ws, { type: MSG.OPPONENT_RECONNECTED, playerIndex: player.playerIndex });
    }

    return this.buildSyncState(player);
  }

  // ADDED: the reconstruction payload — shared by reconnect success AND
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
      players: this.players.map((p) => ({ index: p.playerIndex, nickname: p.nickname })),
      inviteCode: this.inviteCode, // only meaningful while status === "waiting"
      params: this.activeParams ?? this.params, // FIXED: fall back to the un-seeded config params while still "waiting" — activeParams isn't set until the game actually starts
      actions: this.actions,
      hash: this.game ? this.game.getStateHash() : null,
      status: this.status,
      endInfo: this.endInfo,
    };
  }

  // FIXED: two genuinely different situations, must not conflate them.
  // A disconnect can time out while the match is still "active" (game was
  // genuinely interrupted — this is a real forfeit) OR after it already
  // flipped to "over" in the meantime (the still-connected player finished
  // the game on their own turns while the timer was counting down — the
  // result is already decided, there is nothing left to forfeit).
  _onAbortTimeout() {
    const stillDisconnected = this.players.some((p) => !p.connected);
    if (!stillDisconnected) return; // reconnected before the timer fired (step 3)

    const remaining = this.players.find((p) => p.connected);

    if (this.status === "over") {
      // Game already concluded on its own merits — just let the other
      // player know no rematch is coming, no result to change.
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
    this.endInfo = { reason: "abort", winnerIndex: remaining?.playerIndex ?? null }; // ADDED
    if (remaining) {
      this._sendTo(remaining.ws, { type: MSG.MATCH_ENDED, reason: "abort", winnerIndex: remaining.playerIndex });
    }
    this._onClose?.();
  }

  // ADDED: deliberate, immediate forfeit — only meaningful mid-game.
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
    this.broadcast({ type: MSG.MATCH_ENDED, reason: "resign", winnerIndex: opponent.playerIndex });
  }

  // ADDED: explicit "I'm done with this match" signal — waiting-room
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
      // sitting on the resulting endcard (rematch, in a later step) — the
      // match should live on exactly as it would after a natural game end,
      // not be torn down just because the loser happened to be the one who left.
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
    const opponent = this.players.find((p) => p !== player);
    if (opponent?.connected) {
      this._sendTo(opponent.ws, { type: MSG.OPPONENT_LEFT });
    }
    this._onClose?.();
  }

  // ADDED: guarded single-socket send, used by reject paths
  _sendTo(ws, msg) {
    // FIXED: a disconnected player has ws === null (see handleDisconnect) —
    // broadcast() iterates all players unconditionally, and the game can
    // keep going with one player disconnected (their opponent can still
    // move on their own turns), so this is a real, reachable path now, not
    // just a defensive nicety.
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
