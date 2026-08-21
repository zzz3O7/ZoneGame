import { db } from "../db.js";

// Bots are real rows in `players` (is_bot=1), scored by the exact same
// rating pipeline as any human — see docs/BOTS.md. This module is just
// the bot-specific slice of player-row access; findOrCreatePlayerByGoogleSub
// et al. in playerRepository.js stay human-only.

const insertBot = db.prepare(
  `INSERT INTO players (google_sub, email, nickname, created_at, is_bot) VALUES (?, ?, ?, ?, 1)`,
);
const getByGoogleSub = db.prepare(`SELECT * FROM players WHERE google_sub = ?`);
const listBots = db.prepare(`SELECT * FROM players WHERE is_bot = 1`);

// Idempotent — safe to re-run a seed script. botKey is a stable internal
// identifier distinct from nickname: debug-readable now (e.g.
// "random-01"), a generated human-like name eventually (docs/BOTS.md
// Phase 4) — same underlying bot row either way, keyed off google_sub
// rather than nickname so a nickname change never orphans the row.
export function findOrCreateBotPlayer(botKey, nickname) {
  const googleSub = `bot:${botKey}`;
  const existing = getByGoogleSub.get(googleSub);
  if (existing) return existing;
  insertBot.run(googleSub, `${botKey}@bots.zonegame.local`, nickname, Date.now());
  return getByGoogleSub.get(googleSub);
}

export function listBotPlayers() {
  return listBots.all();
}

// Nearest bot by rating_mu; unknown target (guest) or no comparable
// info falls back to a random bot from the pool. Only one bot exists in
// Phase 1, so this is trivially correct today and does the real work
// once more tiers exist (docs/BOTS.md Phase 2).
export function pickClosestBot(targetMu) {
  const bots = listBotPlayers();
  if (bots.length === 0) return null;
  if (targetMu == null) return bots[Math.floor(Math.random() * bots.length)];
  return bots.reduce((best, b) => (Math.abs(b.rating_mu - targetMu) < Math.abs(best.rating_mu - targetMu) ? b : best));
}
