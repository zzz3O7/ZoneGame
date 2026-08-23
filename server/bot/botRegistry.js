import { randomBotMove } from "./randomBot.js";
import { noWasteBotMove } from "./noWasteBot.js";

// The old fixed-priority solver-greedy family (tier3Bot.js,
// "solver-greedy-01/weak-01/strong-01/strong-02") has been removed
// entirely and replaced by server/bot/solverBot.js's generalized
// createSolverBot(config) — see docs/BOTS.md's "Tier 3 — the solver bot
// family" section. New named bots built on it will be added here (and
// to server/scripts/seedBots.js) once the new roster's configs are
// decided; deliberately empty until then rather than half-migrated.
//
// import { createSolverBot } from "./solverBot.js";

// Keyed by the same botKey used in seedBots.js / findOrCreateBotPlayer
// (see botRepository.js) — that key is what's encoded into the player
// row's google_sub as `bot:${botKey}`, so a bot row and its move logic
// are matched up by that key, not by nickname (free to change) or id
// (DB-assigned).
const CHOOSE_MOVE_BY_KEY = {
  "random-01": randomBotMove,
  "no-waste-01": noWasteBotMove,
};

// Unknown/missing key (e.g. a bot row seeded before its tier's code
// existed) falls back to the weakest tier rather than throwing — a bot
// should always be able to move, never crash a match.
export function chooseMoveForBotKey(botKey) {
  return CHOOSE_MOVE_BY_KEY[botKey] ?? randomBotMove;
}

// Exposed so the admin tool can validate a botKey against a real
// strategy before creating a new bot row, rather than silently handing
// back a random-mover for a typo'd key (see chooseMoveForBotKey's
// fallback above — that fallback is a safety net for existing rows, not
// something new bot creation should rely on).
export const KNOWN_BOT_KEYS = Object.keys(CHOOSE_MOVE_BY_KEY);
