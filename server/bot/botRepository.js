import { db } from "../db.js";

// Bots are real rows in `players` (is_bot=1), scored by the exact same
// rating pipeline as any human — see docs/BOTS.md. This module is just
// the bot-specific slice of player-row access; findOrCreatePlayerByGoogleSub
// et al. in playerRepository.js stay human-only.

const insertBot = db.prepare(
  `INSERT INTO players (google_sub, email, nickname, created_at, is_bot, rating_mu, rating_sigma)
   VALUES (?, ?, ?, ?, 1, ?, ?)`,
);
const getByGoogleSub = db.prepare(`SELECT * FROM players WHERE google_sub = ?`);
const listBots = db.prepare(`SELECT * FROM players WHERE is_bot = 1`);
const listActiveBots = db.prepare(`SELECT * FROM players WHERE is_bot = 1 AND is_active = 1`);
const setBotActiveStmt = db.prepare(`UPDATE players SET is_active = ? WHERE id = ? AND is_bot = 1`);

// Idempotent — safe to re-run a seed script. botKey is a stable internal
// identifier distinct from nickname: debug-readable now (e.g.
// "bot-random-0"), a generated human-like name eventually (docs/BOTS.md
// Phase 4) — same underlying bot row either way, keyed off google_sub
// rather than nickname so a nickname change never orphans the row.
//
// `initialRating` only applies at creation — an existing row's mu/sigma
// reflects whatever rated games it's actually played since, and
// re-running the seed script must never reset that. Omit it (or either
// field) to fall back to the table's normal new-player default
// (1500 / 350, same as any human's first game) — see db.js.
export function findOrCreateBotPlayer(botKey, nickname, initialRating = {}) {
  const googleSub = `bot:${botKey}`;
  const existing = getByGoogleSub.get(googleSub);
  if (existing) return existing;
  const { mu = 1500, sigma = 350 } = initialRating;
  insertBot.run(googleSub, `${botKey}@bots.zonegame.local`, nickname, Date.now(), mu, sigma);
  return getByGoogleSub.get(googleSub);
}

export function listBotPlayers() {
  return listBots.all();
}

// Only bots actually offered for real play — matchmaking fallback and
// the direct-debug bot list should both use this, not listBotPlayers(),
// so a disabled bot immediately stops appearing for new matches without
// touching its row or history. The admin tool is the one caller that
// wants every bot regardless of active state, so it keeps using
// listBotPlayers() directly.
export function listActiveBotPlayers() {
  return listActiveBots.all();
}

// Admin-only mutation — toggles a bot's availability for new matches.
// No-op (returns false) if id doesn't refer to a bot row, so a caller
// can't accidentally flip an unrelated human player's flag by passing
// the wrong id.
export function setBotActive(id, active) {
  const info = setBotActiveStmt.run(active ? 1 : 0, id);
  return info.changes > 0;
}

// Inverse of findOrCreateBotPlayer's `bot:${botKey}` encoding — this is
// how a bot player row gets matched back up to its chooseMove function
// in botRegistry.js. Any row with is_bot=1 went through
// findOrCreateBotPlayer, so this prefix is always present; a non-bot
// row is a caller bug, not a data case to handle quietly.
export function botKeyFromRow(bot) {
  return bot.google_sub.slice("bot:".length);
}

// Nearest bot by rating_mu; unknown target (guest) or no comparable
// info falls back to a random bot from the pool. Only active bots are
// eligible — a disabled bot should never be silently handed to a real
// player via matchmaking fallback. Only one bot exists in Phase 1, so
// this is trivially correct today and does the real work once more
// tiers exist (docs/BOTS.md Phase 2).
export function pickClosestBot(targetMu) {
  const bots = listActiveBotPlayers();
  if (bots.length === 0) return null;
  if (targetMu == null) return bots[Math.floor(Math.random() * bots.length)];
  return bots.reduce((best, b) => (Math.abs(b.rating_mu - targetMu) < Math.abs(best.rating_mu - targetMu) ? b : best));
}
