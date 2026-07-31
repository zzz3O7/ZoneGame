import { Game } from "../js/game.js";
import { MSG } from "../js/net/protocol.js";

const DEFAULT_COLS = 20; // TODO game creation by gamemode object
const DEFAULT_ROWS = 20;

export class Match {
  constructor(matchId, inviteCode) {
    this.matchId = matchId;
    this.inviteCode = inviteCode;
    this.players = []; // { nickname, playerIndex, ws }
    this.status = "waiting"; // waiting | active | done
    this.game = null;
  }

  addPlayer(nickname, ws) {
    const playerIndex = this.players.length;
    const player = { nickname, playerIndex, ws };
    this.players.push(player);
    if (this.players.length === 2) this._start();
    return player;
  }

  isFull() {
    return this.players.length >= 2;
  }

  _start() {
    this.status = "active";
    const seed = Date.now();
    this.game = new Game(DEFAULT_COLS, DEFAULT_ROWS, seed);

    this.broadcastPersonalized((p) => ({
      type: MSG.MATCH_START,
      matchId: this.matchId,
      seed: this.game.seed,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
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
