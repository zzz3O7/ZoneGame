// Manual seed script — run with `node server/scripts/seedBots.js` after
// deploying. Idempotent (findOrCreateBotPlayer is keyed off a stable
// google_sub), safe to re-run. Not invoked automatically on server boot,
// so a new bot only enters the pool when you deliberately add one here
// and run this. See docs/BOTS.md.

import { findOrCreateBotPlayer } from "../bot/botRepository.js";

// Phase 2 tiers land one at a time (docs/BOTS.md) — add an entry here
// (and a matching key in server/bot/botRegistry.js) as each one ships.
const BOTS = [
  { key: "random-01", nickname: "Bot_Random_01" },
  { key: "no-waste-01", nickname: "Bot_NoWaste_01" },
  { key: "solver-greedy-01", nickname: "Bot_SolverGreedy_01" },
  { key: "solver-greedy-weak-01", nickname: "Bot_SolverGreedyWeak_01" },
  { key: "solver-greedy-strong-01", nickname: "Bot_SolverGreedyStrong_01" },
  { key: "solver-greedy-strong-02", nickname: "Bot_SolverGreedyStrong_02" },
];

for (const { key, nickname } of BOTS) {
  const bot = findOrCreateBotPlayer(key, nickname);
  console.log(`${bot.nickname} (id=${bot.id}, mu=${bot.rating_mu}, sigma=${bot.rating_sigma})`);
}
