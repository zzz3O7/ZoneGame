// Manual seed script — run with `node server/scripts/seedBots.js` after
// deploying. Idempotent (findOrCreateBotPlayer is keyed off a stable
// google_sub), safe to re-run. Not invoked automatically on server boot,
// so a new bot only enters the pool when you deliberately add one here
// and run this. See docs/BOTS.md.

import { findOrCreateBotPlayer } from "../bot/botRepository.js";

// Keys/nicknames must match botRegistry.js's CHOOSE_MOVE_BY_KEY exactly
// (key = nickname lowercased, "_" -> "-"). Two families:
//  - Random (bot-random-0/1): tier 1 (uniform random) and tier 2
//    (no-waste) — grouped together since neither does real evaluation.
//  - Solver (bot-solver-0..3): server/bot/solverBotPresets.js's four
//    configs, numbered weakest (0) to strongest (3).
// Renamed from the old random-01/no-waste-01 keys — safe since no real
// bot-row data exists yet; if it ever does, the old rows become orphaned
// (chooseMoveForBotKey falls back to random-01's logic for an unknown
// key) and should be removed via the admin tool rather than left around.
const BOTS = [
  { key: "bot-random-0", nickname: "Bot_Random_0" },
  { key: "bot-random-1", nickname: "Bot_Random_1" },
  { key: "bot-solver-0", nickname: "Bot_Solver_0" },
  { key: "bot-solver-1", nickname: "Bot_Solver_1" },
  { key: "bot-solver-2", nickname: "Bot_Solver_2" },
  { key: "bot-solver-3", nickname: "Bot_Solver_3" },
];

for (const { key, nickname } of BOTS) {
  const bot = findOrCreateBotPlayer(key, nickname);
  console.log(`${bot.nickname} (id=${bot.id}, mu=${bot.rating_mu}, sigma=${bot.rating_sigma})`);
}
