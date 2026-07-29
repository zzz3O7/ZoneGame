// js/net/matchClient.js
import { Game } from "../game.js";
import { MSG } from "../protocol.js";

export class MatchClient {
  constructor(connection) {
    this.connection = connection;
    this.matchId = null;
    this.inviteCode = null;
    this.myPlayerIndex = null;
    this.game = null;

    // set these from outside to react to events
    this.onMatchStart = null; // (game) => void
    this.onMoveApplied = null; // () => void
    this.onRejected = null; // (reason) => void
    this.onError = null; // (message) => void

    connection.on(MSG.MATCH_CREATED, (msg) => this._handleCreated(msg));
    connection.on(MSG.MATCH_JOINED, (msg) => this._handleJoined(msg));
    connection.on(MSG.MATCH_START, (msg) => this._handleMatchStart(msg));
    connection.on(MSG.MOVE_APPLIED, (msg) => this._handleMoveApplied(msg));
    connection.on(MSG.MOVE_REJECTED, (msg) => this.onRejected?.(msg.reason));
    connection.on(MSG.ERROR, (msg) => this.onError?.(msg.message));
  }

  createMatch(nickname) {
    this.connection.send({ type: MSG.CREATE_MATCH, nickname });
  }

  joinMatch(inviteCode, nickname) {
    this.connection.send({ type: MSG.JOIN_MATCH, inviteCode, nickname });
  }

  isMyTurn() {
    return this.game && this.game.currentPlayerIndex === this.myPlayerIndex;
  }

  sendMove(pieceType, shape, anchorRow, anchorCol) {
    this.connection.send({ type: MSG.MOVE_ATTEMPT, pieceType, shape, anchorRow, anchorCol });
  }

  _handleCreated(msg) {
    this.matchId = msg.matchId;
    this.inviteCode = msg.inviteCode;
    this.myPlayerIndex = msg.yourPlayerIndex;
  }

  _handleJoined(msg) {
    this.matchId = msg.matchId;
    this.myPlayerIndex = msg.yourPlayerIndex;
  }

  _handleMatchStart(msg) {
    this.game = new Game(msg.cols, msg.rows, msg.seed);
    this.onMatchStart?.(this.game);
  }

  _handleMoveApplied(msg) {
    const { pieceType, shape, anchorRow, anchorCol } = msg.action;
    this.game.attemptPlacement(pieceType, shape, anchorRow, anchorCol);

    const localHash = this.game.getStateHash();
    if (localHash !== msg.hash) {
      console.warn("ZoneGame: state hash mismatch, resync needed"); // TODO
    }

    this.onMoveApplied?.();
  }
}
