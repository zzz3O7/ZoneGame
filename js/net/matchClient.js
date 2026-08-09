import { Game } from "../game.js";
import { MSG } from "./protocol.js";

const SESSION_KEY = "zonegame.session"; // ADDED

export class MatchClient {
  constructor(connection) {
    this.matchId = null;
    this.inviteCode = null;
    this.myPlayerIndex = null;
    this.playerNames = null;
    this.game = null;
    this.sessionId = null; // ADDED: durable identity, survives a ws reconnect
    this.status = null; // ADDED: mirrors Match.status once known — "waiting" | "active" | "over" | "aborted"
    this.clock = null; // ADDED: latest clock snapshot from the server ({remainingMs, currentPlayerIndex, now}), or null for a no-time-control match — see js/clock.js for the shape and extrapolateRemaining/formatClockMs for turning it into a display value

    this.onCreated = null; // (inviteCode) => void
    this.onMatchStart = null; // (game) => void
    this.onMoveApplied = null; // () => void
    this.onRejected = null; // (reason) => void
    this.onError = null; // (message) => void
    this.onOpponentDisconnected = null; // (playerIndex, abortInMs) => void
    this.onOpponentReconnected = null; // (playerIndex) => void // ADDED
    this.onMatchEnded = null; // ({ reason, winnerIndex }) => void // ADDED
    this.onOpponentLeft = null; // () => void // ADDED
    this.onSynced = null; // (game | null, syncMsg) => void — after reconnect or resync // ADDED
    this.onReconnectFailed = null; // (reason) => void // ADDED
    this.onConnectionLost = null; // () => void
    this.onOpponentWantsRematch = null; // () => void // ADDED
    this.onRematchCancelled = null; // (reason) => void // ADDED

    this._bind(connection);
  }

  // ADDED: factored out of the constructor so a fresh Connection (built
  // after an unexpected drop) can be wired up the same way, via rebindConnection().
  _bind(connection) {
    this.connection = connection;

    connection.on(MSG.MATCH_CREATED, (msg) => this._handleCreated(msg));
    connection.on(MSG.MATCH_JOINED, (msg) => this._handleJoined(msg));
    connection.on(MSG.MATCH_START, (msg) => this._handleMatchStart(msg));
    connection.on(MSG.MOVE_APPLIED, (msg) => this._handleMoveApplied(msg));
    connection.on(MSG.MOVE_REJECTED, (msg) => this.onRejected?.(msg.reason));
    connection.on(MSG.OPPONENT_DISCONNECTED, (msg) => this.onOpponentDisconnected?.(msg.playerIndex, msg.abortInMs));
    connection.on(MSG.OPPONENT_RECONNECTED, (msg) => this.onOpponentReconnected?.(msg.playerIndex)); // ADDED
    connection.on(MSG.MATCH_ENDED, (msg) => this._handleMatchEnded(msg)); // ADDED
    connection.on(MSG.OPPONENT_LEFT, () => this._handleOpponentLeft()); // ADDED
    connection.on(MSG.SYNC_STATE, (msg) => this._handleSyncState(msg)); // ADDED
    connection.on(MSG.RECONNECT_FAILED, (msg) => this._handleReconnectFailed(msg)); // ADDED
    connection.on(MSG.OPPONENT_WANTS_REMATCH, () => this.onOpponentWantsRematch?.()); // ADDED
    connection.on(MSG.REMATCH_CANCELLED, (msg) => this.onRematchCancelled?.(msg.reason)); // ADDED
    connection.on(MSG.ERROR, (msg) => this.onError?.(msg.message));
    // FIXED: don't fire onConnectionLost for a close *we* asked for (back to
    // menu, cancel, or the reconnect flow tearing down a dead socket before
    // opening a new one) — only for a genuinely unexpected drop.
    connection.on("__close", () => {
      if (!connection.intentionalClose) this.onConnectionLost?.();
    });
  }

  // ADDED: swap in a freshly-connected socket after an unexpected drop,
  // without losing any of the game/session state already held here.
  rebindConnection(connection) {
    this._bind(connection);
  }

  // ADDED: sends RECONNECT_ATTEMPT on whatever connection is currently
  // bound. Caller (main.js) is responsible for making sure that connection
  // is actually open first.
  attemptReconnect() {
    if (!this.matchId || !this.sessionId) return false;
    this.connection.send({ type: MSG.RECONNECT_ATTEMPT, matchId: this.matchId, sessionId: this.sessionId });
    return true;
  }

  // ADDED: for a page-load reconnect, where matchId/sessionId come from
  // sessionStorage rather than a fresh createMatch/joinMatch response.
  restoreSession({ matchId, sessionId }) {
    this.matchId = matchId;
    this.sessionId = sessionId;
  }

  // ADDED: hash-mismatch resync — same request regardless of why the client
  // thinks it's out of sync.
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

  // ADDED: builds a playerIndex-indexed array from the { index, nickname }
  // list the server sends. Was previously just `.map(p => p.nickname)`,
  // which drops the index entirely and relies on array order happening to
  // already match playerIndex order — true today (players are always
  // pushed in join order), but an implicit assumption for zero benefit
  // when the field to do it properly is right there.
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

  // ADDED
  resign() {
    this.connection.send({ type: MSG.RESIGN });
  }

  // ADDED: waiting-room cancel, or leaving mid/post-game — server treats a
  // mid-game leave as a resign (see Match.leave), so this is safe to call
  // unconditionally regardless of what status we think we're in.
  leaveMatch() {
    this.connection.send({ type: MSG.LEAVE_MATCH });
  }

  // ADDED: symmetric — server starts the rematch once both players have
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
    this.playerNames = this._namesByIndex(msg.players); // FIXED: was .map(p => p.nickname), relying on array order silently matching playerIndex
    this.status = "active"; // ADDED
    this.clock = msg.clock ?? null; // ADDED
    this.onMatchStart?.(this.game);
  }

  _handleMoveApplied(msg) {
    const { action } = msg;
    if (action.kind === "pass") {
      this.game.pass();
    } else {
      this.game.attemptPlacement(action.pieceType, action.shape, action.anchorRow, action.anchorCol);
    }

    this.clock = msg.clock ?? null; // ADDED — must land before onMoveApplied fires, GameUI reads it from there

    const localHash = this.game.getStateHash();
    if (localHash !== msg.hash) {
      // FIXED: was a TODO — now actually resyncs instead of just logging.
      // The reconstruction path (rebuild from params + replay actions) is
      // exactly what _handleSyncState already does, so this just asks the
      // server for that same payload rather than trying to patch state locally.
      console.warn("ZoneGame: state hash mismatch, requesting resync");
      this.requestResync();
    }

    this.onMoveApplied?.();
  }

  // ADDED: shared by reconnect success and hash-mismatch resync. Rebuilds
  // by doing exactly what a live game already does — new Game(params), then
  // replay each action through the same attemptPlacement/pass calls — so
  // there's one reconstruction code path, not a second bespoke one.
  _handleSyncState(msg) {
    this.myPlayerIndex = msg.yourPlayerIndex;
    this.playerNames = this._namesByIndex(msg.players); // FIXED: see _handleMatchStart
    this.inviteCode = msg.inviteCode;
    this.params = msg.params; // ADDED: needed by populateWaitingRoom for the "waiting" case; harmless otherwise
    this.status = msg.status;
    this.endInfo = msg.endInfo;
    this.clock = msg.clock ?? null; // ADDED — a fresh, already-caught-up snapshot (see Match.buildSyncState)
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

  // ADDED
  _handleReconnectFailed(msg) {
    MatchClient.clearSession();
    this.onReconnectFailed?.(msg.reason);
  }

  // ADDED: forfeit-by-abandonment — match is already gone server-side.
  _handleMatchEnded(msg) {
    // Mirrors Match's own transition: resign leaves the match alive
    // (status "over", still reconnectable/rematchable) — only clear the
    // stored session once it's genuinely gone (abort-forfeit removes the
    // match immediately server-side). FIXED: this used to clear the
    // session unconditionally, which meant a refresh right after resigning
    // (before doing anything else) would lose the ability to reconnect
    // back into your own still-alive, still-rematchable "over" match.
    this.status = msg.reason === "resign" ? "over" : "aborted";
    this.clock = msg.clock ?? this.clock; // ADDED — final frozen snapshot; falls back to whatever we last had rather than wiping it if this particular message somehow omits it
    if (this.status === "aborted") MatchClient.clearSession();
    this.onMatchEnded?.(msg);
  }

  // ADDED: match already concluded normally and the opponent isn't coming
  // back — also already gone server-side, but not a forfeit, nothing to
  // recompute, just no rematch coming.
  _handleOpponentLeft() {
    MatchClient.clearSession();
    this.status = "aborted"; // terminal from the client's perspective either way — match is gone server-side once this arrives
    this.onOpponentLeft?.();
  }
}
