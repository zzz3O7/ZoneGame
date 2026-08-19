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

  // Matchmaking — separate from the invite-code create/join flow above.
  // { rated: boolean, nickname?, params } -> server. rated:true requires
  // an authenticated session; nickname is ignored for rated (the
  // account's own nickname is used instead) and required for unrated.
  JOIN_QUEUE: "joinQueue", // client -> server
  LEAVE_QUEUE: "leaveQueue", // client -> server
  QUEUED: "queued", // server -> client: still waiting for an opponent
  QUEUE_CANCELLED: "queueCancelled", // server -> client: left the queue
  // Sent individually to each paired player once matched — carries the
  // same identity info MATCH_JOINED does, since queue-matched players
  // never go through create/join. Note: the Match's own MATCH_START
  // broadcast fires (and arrives client-side) before this message does.
  QUEUE_MATCHED: "queueMatched", // server -> each matched client

  // Direct-debug PvE — bypasses the queue entirely, picks a bot by id,
  // unrated, zero move delay. See docs/BOTS.md "direct_debug" origin.
  // { botId, nickname? } -> server. nickname is required for guests,
  // same rule as unrated JOIN_QUEUE.
  PLAY_BOT_REQUEST: "playBotRequest", // client -> server
  BOT_LIST_REQUEST: "botListRequest", // client -> server: asks for available bots to debug against
  BOT_LIST: "botList", // server -> client: [{ id, nickname, rating }]

  // Sent personalized to each player right after a rated game's result is
  // persisted (see ratingService.finalizeRatedGame) — always arrives BEFORE
  // the game-ending message itself (MOVE_APPLIED's gameOver flag, or
  // MATCH_ENDED for resign/timeout/abort), since finalizeRatedGame runs
  // synchronously inside _logMatchEnd, ahead of that broadcast. Consumers
  // should just stash this and let the subsequent game-ending render pick
  // it up — the endcard isn't shown yet when this arrives.
  RATING_UPDATE: "ratingUpdate", // server -> each player: { ratingBefore, ratingAfter, opponentRatingBefore, opponentRatingAfter }

  ERROR: "error",
};
