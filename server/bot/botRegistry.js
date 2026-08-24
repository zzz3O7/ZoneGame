import { randomBotMove } from "./randomBot.js";
import { noWasteBotMove } from "./noWasteBot.js";
import { createSolverBot } from "./solverBot.js";
import { BOT_SOLVER_0, BOT_SOLVER_1, BOT_SOLVER_2, BOT_SOLVER_3 } from "./solverBotPresets.js";

// Two families:
//  - "Random" (bot-random-0/1): no real evaluation, just constrained
//    randomness — tier 1 (uniform over all legal moves) and tier 2 (same,
//    but never wastes a domino unless nothing else is legal) are close
//    enough in kind to share a family name/numbering.
//  - "Solver" (bot-solver-0..3): server/bot/solverBot.js's
//    createSolverBot(config), configs from solverBotPresets.js — see
//    docs/BOTS.md's "Tier 3 — the solver bot family" section. Numbered
//    weakest (0) to strongest (3), matching solverBotPresets.js's own
//    documented ladder.
//
// Keyed by the same botKey used in seedBots.js / findOrCreateBotPlayer
// (see botRepository.js) — that key is what's encoded into the player
// row's google_sub as `bot:${botKey}`, so a bot row and its move logic
// are matched up by that key, not by nickname (free to change) or id
// (DB-assigned).
const CHOOSE_MOVE_BY_KEY = {
  "bot-random-0": randomBotMove,
  "bot-random-1": noWasteBotMove,
  "bot-solver-0": createSolverBot(BOT_SOLVER_0),
  "bot-solver-1": createSolverBot(BOT_SOLVER_1),
  "bot-solver-2": createSolverBot(BOT_SOLVER_2),
  "bot-solver-3": createSolverBot(BOT_SOLVER_3),
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
