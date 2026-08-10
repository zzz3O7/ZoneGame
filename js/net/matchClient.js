import { Game } from "../game.js";
import { MSG } from "./protocol.js";

const SESSION_KEY = "zonegame.session";

export class MatchClient {
  constructor(connection) {
    this.matchId = null;
    this.inviteCode = null;
    this.myPlayerIndex = null;
    this.playerNames = null;
    this.game = null;
    this.sessionId = null;
    this.status = null; // "waiting" | "active" | "over" | "aborted"
    this.clock = null;

    this.onCreated = null; // (inviteCode) => void
    this.onMatchStart = null; // (game) => void
    this.onMoveApplied = null; // () => void
    this.onRejected = null; // (reason) => void
    this.onError = null; // (message) => void
    this.onOpponentDisconnected = null; // (playerIndex, abortInMs) => void
    this.onOpponentReconnected = null; // (playerIndex) => void
    this.onMatchEnded = null; // ({ reason, winnerIndex }) => void
    this.onOpponentLeft = null; // () => void
    this.onSynced = null; // (game | null, syncMsg) => void — after reconnect or resync
    this.onReconnectFailed = null; // (reason) => void
    this.onConnectionLost = null; // () => void
    this.onOpponentWantsRematch = null; // () => void
    this.onRematchCancelled = null; // (reason) => void

    this._bind(connection);
  }

  _bind(connection) {
    this.connection = connection;

    connection.on(MSG.MATCH_CREATED, (msg) => this._handleCreated(msg));
    connection.on(MSG.MATCH_JOINED, (msg) => this._handleJoined(msg));
    connection.on(MSG.MATCH_START, (msg) => this._handleMatchStart(msg));
    connection.on(MSG.MOVE_APPLIED, (msg) => this._handleMoveApplied(msg));
    connection.on(MSG.MOVE_REJECTED, (msg) => this.onRejected?.(msg.reason));
    connection.on(MSG.OPPONENT_DISCONNECTED, (msg) => this.onOpponentDisconnected?.(msg.playerIndex, msg.abortInMs));
    connection.on(MSG.OPPONENT_RECONNECTED, (msg) => this.onOpponentReconnected?.(msg.playerIndex));
    connection.on(MSG.MATCH_ENDED, (msg) => this._handleMatchEnded(msg));
    connection.on(MSG.OPPONENT_LEFT, () => this._handleOpponentLeft());
    connection.on(MSG.SYNC_STATE, (msg) => this._handleSyncState(msg));
    connection.on(MSG.RECONNECT_FAILED, (msg) => this._handleReconnectFailed(msg));
    connection.on(MSG.OPPONENT_WANTS_REMATCH, () => this.onOpponentWantsRematch?.());
    connection.on(MSG.REMATCH_CANCELLED, (msg) => this.onRematchCancelled?.(msg.reason));
    connection.on(MSG.ERROR, (msg) => this.onError?.(msg.message));
    connection.on("__close", () => {
      if (!connection.intentionalClose) this.onConnectionLost?.();
    });
  }

  rebindConnection(connection) {
    this._bind(connection);
  }

  attemptReconnect() {
    if (!this.matchId || !this.sessionId) return false;
    this.connection.send({ type: MSG.RECONNECT_ATTEMPT, matchId: this.matchId, sessionId: this.sessionId });
    return true;
  }

  restoreSession({ matchId, sessionId }) {
    this.matchId = matchId;
    this.sessionId = sessionId;
  }

  // hash-mismatch resync.
  requestResync() {
    this.connection.send({ type: MSG.REQUEST_RESYNC });
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

  _namesByIndex(players) {
    const names = [];
    for (const p of players) names[p.index] = p.nickname;
    return names;
  }

  sendMove(pieceType, shape, anchorRow, anchorCol) {
    const ok = this.connection.send({ type: MSG.MOVE_ATTEMPT, pieceType, shape, anchorRow, anchorCol });
    if (!ok) this.onConnectionLost?.();
  }

  sendPass() {
    const ok = this.connection.send({ type: MSG.PASS_ATTEMPT });
    if (!ok) this.onConnectionLost?.();
  }

  resign() {
    this.connection.send({ type: MSG.RESIGN });
  }

  // Waiting-room cancel, or leaving mid/post-game — server treats a
  // mid-game leave as a resign (see Match.leave), so this is safe to call
  // unconditionally regardless of what status we think we're in.
  leaveMatch() {
    this.connection.send({ type: MSG.LEAVE_MATCH });
  }

  // Symmetric — server starts the rematch once both players have
  // called this (see Match.requestRematch). Only meaningful once status is
  // "over" (a naturally-completed game); MatchClient doesn't gate on that
  // itself, the server is the source of truth and just no-ops otherwise.
  requestRematch() {
    this.connection.send({ type: MSG.REMATCH_REQUEST });
  }

  _handleCreated(msg) {
    this.matchId = msg.matchId;
    this.inviteCode = msg.inviteCode;
    this.myPlayerIndex = msg.yourPlayerIndex;
    this.sessionId = msg.sessionId;
    this._saveSession();
    this.onCreated?.(this.inviteCode);
  }

  _handleJoined(msg) {
    this.matchId = msg.matchId;
    this.myPlayerIndex = msg.yourPlayerIndex;
    this.sessionId = msg.sessionId;
    this._saveSession();
  }

  // Session persistence — matchId + sessionId is enough for the
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

  // Read back on load, e.g. to decide whether to offer reconnect.
  static loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // Called once a match is truly over for this client (resigned,
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
    this.playerNames = this._namesByIndex(msg.players);
    this.status = "active";
    this.clock = msg.clock ?? null;
    this.onMatchStart?.(this.game);
  }

  _handleMoveApplied(msg) {
    const { action } = msg;
    if (action.kind === "pass") {
      this.game.pass();
    } else {
      this.game.attemptPlacement(action.pieceType, action.shape, action.anchorRow, action.anchorCol);
    }

    if (msg.gameOver) this.status = "over";

    this.clock = msg.clock ?? null;

    const localHash = this.game.getStateHash();
    if (localHash !== msg.hash) {
      console.warn("ZoneGame: state hash mismatch, requesting resync");
      this.requestResync();
    }

    this.onMoveApplied?.();
  }

  // Shared by reconnect success and hash-mismatch resync. Rebuilds
  // by doing exactly what a live game already does — new Game(params), then
  // replay each action through the same attemptPlacement/pass calls.
  _handleSyncState(msg) {
    this.myPlayerIndex = msg.yourPlayerIndex;
    this.playerNames = this._namesByIndex(msg.players);
    this.inviteCode = msg.inviteCode;
    this.params = msg.params;
    this.status = msg.status;
    this.endInfo = msg.endInfo;
    this.clock = msg.clock ?? null;
    this._saveSession();

    if (msg.status === "waiting") {
      // Nobody's opponent has joined yet — nothing to replay, no board yet.
      this.game = null;
      this.onSynced?.(null, msg);
      return;
    }

    const game = new Game(msg.params);
    for (const action of msg.actions) {
      if (action.kind === "pass") game.pass();
      else game.attemptPlacement(action.pieceType, action.shape, action.anchorRow, action.anchorCol);
    }

    if (msg.hash != null && game.getStateHash() !== msg.hash) {
      // Replay landed somewhere different than the server — a real
      // client/server logic divergence, not just a missed message (this IS
      // the replay, there's nothing further to resync against). Surface
      // it loudly rather than silently showing a possibly-wrong board.
      console.error("ZoneGame: resync replay hash mismatch — client and server simulation have diverged");
    }

    this.game = game;
    this.onSynced?.(game, msg);
  }

  _handleReconnectFailed(msg) {
    MatchClient.clearSession();
    this.onReconnectFailed?.(msg.reason);
  }

  // Forfeit-by-abandonment — match is already gone server-side.
  _handleMatchEnded(msg) {
    // Mirrors Match's own transition.
    this.status = msg.reason === "abort" ? "aborted" : "over";
    this.clock = msg.clock ?? this.clock;
    if (this.status === "aborted") MatchClient.clearSession();
    this.onMatchEnded?.(msg);
  }

  // Match already concluded normally and the opponent isn't coming
  // back — also already gone server-side, but not a forfeit, nothing to
  // recompute, just no rematch coming.
  _handleOpponentLeft() {
    MatchClient.clearSession();
    this.status = "aborted";
    this.onOpponentLeft?.();
  }
}
