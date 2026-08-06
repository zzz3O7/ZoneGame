import { Game } from "../game.js";
import { MSG } from "./protocol.js";

const SESSION_KEY = "zonegame.session"; // ADDED

export class MatchClient {
  constructor(connection) {
    this.connection = connection;
    this.matchId = null;
    this.inviteCode = null;
    this.myPlayerIndex = null;
    this.playerNames = null;
    this.game = null;
    this.sessionId = null; // ADDED: durable identity, survives a ws reconnect

    this.onCreated = null; // (inviteCode) => void
    this.onMatchStart = null; // (game) => void
    this.onMoveApplied = null; // () => void
    this.onRejected = null; // (reason) => void
    this.onError = null; // (message) => void
    this.onOpponentDisconnected = null; // (playerIndex) => void
    this.onConnectionLost = null; // () => void

    connection.on(MSG.MATCH_CREATED, (msg) => this._handleCreated(msg));
    connection.on(MSG.MATCH_JOINED, (msg) => this._handleJoined(msg));
    connection.on(MSG.MATCH_START, (msg) => this._handleMatchStart(msg));
    connection.on(MSG.MOVE_APPLIED, (msg) => this._handleMoveApplied(msg));
    connection.on(MSG.MOVE_REJECTED, (msg) => this.onRejected?.(msg.reason));
    connection.on(MSG.OPPONENT_DISCONNECTED, (msg) => this.onOpponentDisconnected?.(msg.playerIndex));
    connection.on("__close", () => this.onConnectionLost?.());
    connection.on(MSG.ERROR, (msg) => this.onError?.(msg.message));
  }

  createMatch(nickname, params) {
    this.connection.send({ type: MSG.CREATE_MATCH, nickname, params });
  }

  joinMatch(inviteCode, nickname) {
    this.connection.send({ type: MSG.JOIN_MATCH, inviteCode, nickname });
  }

  isMyTurn() {
    return this.game && this.game.currentPlayerIndex === this.myPlayerIndex;
  }

  sendMove(pieceType, shape, anchorRow, anchorCol) {
    const ok = this.connection.send({ type: MSG.MOVE_ATTEMPT, pieceType, shape, anchorRow, anchorCol });
    if (!ok) this.onConnectionLost?.();
  }

  sendPass() {
    const ok = this.connection.send({ type: MSG.PASS_ATTEMPT });
    if (!ok) this.onConnectionLost?.();
  }

  _handleCreated(msg) {
    this.matchId = msg.matchId;
    this.inviteCode = msg.inviteCode;
    this.myPlayerIndex = msg.yourPlayerIndex;
    this.sessionId = msg.sessionId; // ADDED
    this._saveSession(); // ADDED
    this.onCreated?.(this.inviteCode);
  }

  _handleJoined(msg) {
    this.matchId = msg.matchId;
    this.myPlayerIndex = msg.yourPlayerIndex;
    this.sessionId = msg.sessionId; // ADDED
    this._saveSession(); // ADDED
  }

  // ADDED: session persistence — matchId + sessionId is enough for the
  // server to identify this player on a fresh ws (see RECONNECT_ATTEMPT).
  // sessionStorage (not localStorage) is deliberate: a reconnect should
  // only be offered within the tab/session that was actually playing,
  // not silently resurrected in unrelated tabs later.
  _saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ matchId: this.matchId, sessionId: this.sessionId }));
    } catch {
      // storage unavailable (private browsing, etc.) — reconnect-on-refresh
      // just won't be offered; not fatal.
    }
  }

  // ADDED: read back on load, e.g. to decide whether to offer reconnect.
  static loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // ADDED: called once a match is truly over for this client (resigned,
  // aborted, opponent left, or they backed out) — nothing left to reconnect to.
  static clearSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
  }

  _handleMatchStart(msg) {
    this.myPlayerIndex = msg.yourPlayerIndex;
    this.game = new Game(msg.params);
    this.playerNames = msg.players.map((p) => p.nickname);
    this.onMatchStart?.(this.game);
  }

  _handleMoveApplied(msg) {
    const { action } = msg;
    if (action.kind === "pass") {
      this.game.pass();
    } else {
      this.game.attemptPlacement(action.pieceType, action.shape, action.anchorRow, action.anchorCol);
    }

    const localHash = this.game.getStateHash();
    if (localHash !== msg.hash) {
      console.warn("ZoneGame: state hash mismatch, resync needed"); // TODO
    }

    this.onMoveApplied?.();
  }
}
