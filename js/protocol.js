// server/protocol.js
export const MSG = {
  CREATE_MATCH: "createMatch", // client -> server
  MATCH_CREATED: "matchCreated", // server -> match creator
  JOIN_MATCH: "joinMatch", // client -> server
  MATCH_JOINED: "matchJoined", // server -> sender only
  MATCH_START: "matchStart", // server -> both
  MOVE_ATTEMPT: "moveAttempt", // client -> server
  MOVE_APPLIED: "moveApplied", // server -> both
  MOVE_REJECTED: "moveRejected", // server -> sender only
  ERROR: "error",
};
