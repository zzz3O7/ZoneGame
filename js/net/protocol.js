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

  // ADDED: disconnect / reconnect
  OPPONENT_DISCONNECTED: "opponentDisconnected", // server -> client; carries abortInMs
  OPPONENT_RECONNECTED: "opponentReconnected", // server -> client
  RECONNECT_ATTEMPT: "reconnectAttempt", // client -> server: { matchId, sessionId }
  RECONNECT_FAILED: "reconnectFailed", // server -> client: { reason }
  MATCH_ABORTED: "matchAborted", // server -> remaining client: { reason }

  // ADDED: state sync — shared by reconnect success AND hash-mismatch resync
  REQUEST_RESYNC: "requestResync", // client -> server
  SYNC_STATE: "syncState", // server -> client: { yourPlayerIndex, players, params, actions, hash, status, endInfo? }

  // ADDED: leaving / ending outside the normal move flow
  RESIGN: "resign", // client -> server
  LEAVE_MATCH: "leaveMatch", // client -> server (waiting-room cancel, or mid/post-game leave — mid-game counts as resign)
  MATCH_ENDED: "matchEnded", // server -> both: { reason: "resign" | "abort", winnerIndex }
  OPPONENT_LEFT: "opponentLeft", // server -> remaining client

  // ADDED: rematch
  REMATCH_REQUEST: "rematchRequest", // client -> server
  OPPONENT_WANTS_REMATCH: "opponentWantsRematch", // server -> other client
  REMATCH_CANCELLED: "rematchCancelled", // server -> waiting client: { reason }

  ERROR: "error",
};
