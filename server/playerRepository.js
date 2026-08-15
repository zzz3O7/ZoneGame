import { db } from "./db.js";

const NICKNAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;

export class NicknameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "invalid" | "taken"
  }
}

const insertPlayer = db.prepare(`INSERT INTO players (google_sub, email, created_at) VALUES (?, ?, ?)`);
const getByGoogleSub = db.prepare(`SELECT * FROM players WHERE google_sub = ?`);
const getById = db.prepare(`SELECT * FROM players WHERE id = ?`);
const updateNickname = db.prepare(`UPDATE players SET nickname = ? WHERE id = ?`);

// Looks up a player by their Google identity, creating a row on first
// login. Google sub is stable for a given account forever, so this is
// safe to call on every login, not just the first one.
export function findOrCreatePlayerByGoogleSub({ googleSub, email }) {
  const existing = getByGoogleSub.get(googleSub);
  if (existing) return existing;
  const info = insertPlayer.run(googleSub, email, Date.now());
  return getById.get(info.lastInsertRowid);
}

export function getPlayerById(id) {
  return getById.get(id) || null;
}

// Single source of truth for "what number does the player see" — always
// the rounded skill mean, floored so players never see a negative or
// unsettlingly-low number even in extreme cases (sigma/tau dynamics could
// in principle push a real beginner's internal mu quite low despite the
// INITIAL_MU headroom). sigma/tau never surface to clients directly.
export function displayRating(player) {
  return player ? Math.max(100, Math.round(player.rating_mu)) : null;
}

// Throws NicknameError("invalid" | "taken") rather than returning a
// boolean, so the route handler can give a specific error message
// instead of a generic "failed" — these are two different UX cases.
export function setNickname(playerId, rawNickname) {
  const nickname = rawNickname.trim();
  if (!NICKNAME_PATTERN.test(nickname)) {
    throw new NicknameError("invalid", "Nickname must be 3-20 characters: letters, numbers, underscore, hyphen only.");
  }
  try {
    updateNickname.run(nickname, playerId);
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new NicknameError("taken", "That nickname is already taken.");
    }
    throw err;
  }
  return getById.get(playerId);
}
