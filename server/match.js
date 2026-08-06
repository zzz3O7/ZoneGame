import { randomUUID } from "crypto";
import { Game } from "../js/game.js";
import { resolveParams } from "../js/params.js";
import { MSG } from "../js/net/protocol.js";

export class Match {
  constructor(matchId, inviteCode, rawParams) {
    this.matchId = matchId;
    this.inviteCode = inviteCode;
    this.players = []; // { nickname, playerIndex, ws, sessionId }
    this.status = "waiting"; // waiting | active | done
    this.game = null;

    // Re-resolve on the server: the creator's client already clamped these,
    // but the server never trusts client-sent values directly. This is the
    // same function the client uses, so there's exactly one place that
    // defines what a valid params object looks like.
    this.params = resolveParams(rawParams?.mode, rawParams);
  }

  // ADDED: sessionId is the durable player identity — a ws is just whichever
  // socket currently happens to be attached to that identity, and it's
  // expected to change across reconnects/refreshes. Never key player state
  // off ws itself for anything meant to survive a reconnect.
  addPlayer(nickname, ws) {
    const playerIndex = this.players.length;
    const sessionId = randomUUID();
    const player = { nickname, playerIndex, ws, sessionId };
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

    this.broadcast({
      type: MSG.MOVE_APPLIED,
      action: { kind: "pass", playerIndex: player.playerIndex },
      hash: this.game.getStateHash(),
      gameOver: this.game.gameOver,
      winnerIndex: this.game.gameOver ? this.game.winnerIndex : null,
    });
  }

  // ADDED: called from server on ws 'close'
  handleDisconnect(ws) {
    const player = this.players.find((p) => p.ws === ws);
    if (!player) return;
    this.status = "done"; // no reconnect support yet, MVP: end match TODO
    const opponent = this.players.find((p) => p.ws !== ws);
    if (opponent) {
      this._sendTo(opponent.ws, {
        type: MSG.OPPONENT_DISCONNECTED,
        playerIndex: player.playerIndex,
      });
    }
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
