import { randomUUID } from "crypto";
import { db } from "./db.js";
import { getPlayerById } from "./playerRepository.js";
import { MAX_AGE_SECONDS } from "./cookies.js";

// Sessions are persisted in SQLite (same DB as players/games) rather than
// an in-memory Map: an in-memory store meant every dev restart silently
// logged everyone out even though their cookie was still valid and still
// sitting in their browser — the cookie pointed at a session the server
// no longer remembered. Persisting this mapping means a restart doesn't
// lose it. expires_at mirrors the cookie's own Max-Age (MAX_AGE_SECONDS)
// so a session row never outlives the cookie that references it.
const insertSession = db.prepare(`INSERT INTO sessions (id, player_id, created_at, expires_at) VALUES (?, ?, ?, ?)`);
const getSession = db.prepare(`SELECT player_id, expires_at FROM sessions WHERE id = ?`);
const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);
const deleteExpiredSessions = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`);

export function createSession(playerId) {
  // Opportunistic cleanup rather than a scheduled job — cheap indexed
  // delete, and login is already a low-frequency, non-hot-path action.
  deleteExpiredSessions.run(Date.now());

  const sessionId = randomUUID();
  const now = Date.now();
  insertSession.run(sessionId, playerId, now, now + MAX_AGE_SECONDS * 1000);
  return sessionId;
}

// Always re-reads the player row fresh from the DB rather than caching
// it on the session, so a nickname/rating change is reflected on the
// player's very next request instead of only after their next login.
export function getSessionPlayer(sessionId) {
  const row = getSession.get(sessionId);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    deleteSession.run(sessionId);
    return null;
  }
  return getPlayerById(row.player_id);
}

export function destroySession(sessionId) {
  deleteSession.run(sessionId);
}
