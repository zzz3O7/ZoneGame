// Manual seed script — run with `node server/scripts/seedBots.js` after
// deploying. Idempotent (findOrCreateBotPlayer is keyed off a stable
// google_sub), safe to re-run. Not invoked automatically on server boot,
// so a new bot only enters the pool when you deliberately add one here
// and run this. See docs/BOTS.md.

import { findOrCreateBotPlayer } from "../bot/botRepository.js";

// Phase 1: one bottom-tier bot, debug-readable name. More tiers arrive
// with Phase 2's evaluator (docs/BOTS.md) — add entries here as they do.
const BOTS = [{ key: "random-01", nickname: "Bot_Random_01" }];

for (const { key, nickname } of BOTS) {
  const bot = findOrCreateBotPlayer(key, nickname);
  console.log(`${bot.nickname} (id=${bot.id}, mu=${bot.rating_mu}, sigma=${bot.rating_sigma})`);
}
