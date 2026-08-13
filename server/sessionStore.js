import { randomUUID } from "crypto";
import { getPlayerById } from "./playerRepository.js";

// Sessions are intentionally in-memory only: losing them on a server
// restart just means players need to log in again, no data loss, and
// it avoids needing a sessions table + expiry/cleanup logic in SQLite
// for what's a purely transient mapping.
const sessions = new Map(); // sessionId -> playerId

export function createSession(playerId) {
  const sessionId = randomUUID();
  sessions.set(sessionId, playerId);
  return sessionId;
}

// Always re-reads the player row fresh from the DB rather than caching
// it on the session, so a nickname/rating change is reflected on the
// player's very next request instead of only after their next login.
export function getSessionPlayer(sessionId) {
  const playerId = sessions.get(sessionId);
  if (playerId == null) return null;
  return getPlayerById(playerId);
}

export function destroySession(sessionId) {
  sessions.delete(sessionId);
}
