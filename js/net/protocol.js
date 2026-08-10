export const MSG = {
  CREATE_MATCH: "createMatch", // client -> server
  MATCH_CREATED: "matchCreated", // server -> match creator; carries sessionId
  JOIN_MATCH: "joinMatch", // client -> server
  MATCH_JOINED: "matchJoined", // server -> sender only; carries sessionId
  MATCH_START: "matchStart", // server -> both; also used to kick off a rematch
  MOVE_ATTEMPT: "moveAttempt", // client -> server
  PASS_ATTEMPT: "passAttempt", // client -> server
  MOVE_APPLIED: "moveApplied", // server -> both
  MOVE_REJECTED: "moveRejected", // server -> sender only

  OPPONENT_DISCONNECTED: "opponentDisconnected", // server -> client; carries abortInMs
  OPPONENT_RECONNECTED: "opponentReconnected", // server -> client
  RECONNECT_ATTEMPT: "reconnectAttempt", // client -> server: { matchId, sessionId }
  RECONNECT_FAILED: "reconnectFailed", // server -> client: { reason }

  // State sync — shared by reconnect success AND hash-mismatch resync
  REQUEST_RESYNC: "requestResync", // client -> server
  SYNC_STATE: "syncState", // server -> client: { yourPlayerIndex, players, params, actions, hash, status, endInfo? }

  // Leaving / ending outside the normal move flow
  RESIGN: "resign", // client -> server
  LEAVE_MATCH: "leaveMatch", // client -> server (waiting-room cancel, or mid/post-game leave — mid-game counts as resign)
  // reason: "resign" | "abort" — abort covers both a live-game forfeit-by-
  // disconnect-timeout AND the natural "no-moves" end broadcast via moveApplied's
  // own gameOver flag; MATCH_ENDED is specifically for endings that don't come
  // from a move being applied. winnerIndex is null only if truly moot (shouldn't happen).
  MATCH_ENDED: "matchEnded", // server -> remaining/both: { reason, winnerIndex }
  OPPONENT_LEFT: "opponentLeft", // server -> remaining client (match was already over — no forfeit, just no rematch coming)

  REMATCH_REQUEST: "rematchRequest", // client -> server
  OPPONENT_WANTS_REMATCH: "opponentWantsRematch", // server -> other client
  REMATCH_CANCELLED: "rematchCancelled", // server -> waiting client: { reason }

  ERROR: "error",
};
