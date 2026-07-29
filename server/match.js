// server/Match.js
import { Game } from "../js/game.js";
import { MSG } from "../js/protocol.js";

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
    const seed = Date.now(); // server-picked, trustworthy
    this.game = new Game(DEFAULT_COLS, DEFAULT_ROWS, seed);

    this.broadcast({
      type: MSG.MATCH_START,
      matchId: this.matchId,
      seed: this.game.seed,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      players: this.players.map((p) => ({ index: p.playerIndex, nickname: p.nickname })),
    });
  }

  attemptMove(ws, pieceType, shape, anchorRow, anchorCol) {
    if (this.status !== "active") return;

    const player = this.players.find((p) => p.ws === ws);
    if (!player) return;
    if (player.playerIndex !== this.game.currentPlayerIndex) {
      ws.send(JSON.stringify({ type: MSG.MOVE_REJECTED, reason: "Not your turn" }));
      return;
    }

    const applied = this.game.attemptPlacement(pieceType, shape, anchorRow, anchorCol);
    if (!applied) {
      ws.send(JSON.stringify({ type: MSG.MOVE_REJECTED, reason: "Illegal move" }));
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
      ws.send(JSON.stringify({ type: MSG.MOVE_REJECTED, reason: "Not your turn" }));
      return;
    }

    const applied = this.game.pass();
    if (!applied) {
      ws.send(JSON.stringify({ type: MSG.MOVE_REJECTED, reason: "Cannot pass, you have a move" }));
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

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players) {
      if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
    }
  }
}
