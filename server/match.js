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
    this.game = new Game(finalParams);

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

    if (this.game.gameOver) this.status = "over"; // ADDED: game ended normally — not terminal, rematch still possible

    this.broadcast({
      type: MSG.MOVE_APPLIED,
      action: { kind: "placement", pieceType, shape, anchorRow, anchorCol, playerIndex: player.playerIndex },
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

    if (this.game.gameOver) this.status = "over"; // ADDED: game ended normally — not terminal, rematch still possible

    this.broadcast({
      type: MSG.MOVE_APPLIED,
      action: { kind: "pass", playerIndex: player.playerIndex },
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
    if (opponent?.connected) {
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
    if (remaining) {
      this._sendTo(remaining.ws, { type: MSG.MATCH_ENDED, reason: "abort", winnerIndex: remaining.playerIndex });
    }
    this._onClose?.();
  }

  // ADDED: guarded single-socket send, used by reject paths
  _sendTo(ws, msg) {
    if (ws.readyState !== ws.OPEN) return;
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
