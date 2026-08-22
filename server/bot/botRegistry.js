import { randomBotMove } from "./randomBot.js";
import { noWasteBotMove } from "./noWasteBot.js";
import { createSolverGreedyBot, tier3BotMove } from "./tier3Bot.js";

// Named configs of the same createSolverGreedyBot factory (see
// tier3Bot.js's DEFAULT_CONFIG comment for what each field means) —
// this is the actual bot "family" tier3Bot.js was built to support.
// "solver-greedy-01" (below) is createSolverGreedyBot() with no
// overrides at all, which happens to already equal the "weak, avoidance
// on" variant, so it isn't repeated here.
//
// solver-greedy-weak-01: same zone preferences as solver-greedy-01
// (all random, dominoFallback biggest) but with pickMoveAvoidingLoss
// switched off entirely — the weakest realistic variant, since it never
// spends the extra solves to catch a hidden win or dodge a loss.
const solverGreedyWeakBot = createSolverGreedyBot({
  zoneSelection: {
    winnableActive: "random",
    creationUncertain: "random",
    uncertainActive: "random",
    lostActive: "random",
    dominoFallback: "biggest",
  },
  avoidLosingMove: { enabled: false },
});

// solver-greedy-strong-01: prefers smaller winnable/creation/uncertain
// targets (bank easy wins fast, don't let an uncertain zone grow before
// dealing with it) but the BIGGEST lost zone (since a lost zone is
// already a sunk cost — better to at least maximize whatever
// tempo/board-presence value is left in it before it closes).
const solverGreedyStrongBot = createSolverGreedyBot({
  zoneSelection: {
    winnableActive: "smallest",
    creationUncertain: "smallest",
    uncertainActive: "smallest",
    lostActive: "biggest",
    dominoFallback: "biggest",
  },
});

// solver-greedy-strong-02: solver-greedy-strong-01's zone preferences,
// with both strength dials pushed further — maxBlobSize 12 -> 18 (still
// well within budget: 47ms worst case on a fully-open, unfragmented
// 18-cell blob, see docs/BOTS.md) and avoidLosingMove.maxTries doubled
// 15 -> 30.
const solverGreedyStrongPlusBot = createSolverGreedyBot({
  maxBlobSize: 18,
  zoneSelection: {
    winnableActive: "smallest",
    creationUncertain: "smallest",
    uncertainActive: "smallest",
    lostActive: "biggest",
    dominoFallback: "biggest",
  },
  avoidLosingMove: { enabled: true, maxTries: 30 },
});

// One entry per strength tier. Keyed by the same botKey used in
// seedBots.js / findOrCreateBotPlayer (see botRepository.js) — that key
// is what's encoded into the player row's google_sub as `bot:${botKey}`,
// so a bot row and its move logic are matched up by that key, not by
// nickname (which is free to change) or id (which is DB-assigned).
const CHOOSE_MOVE_BY_KEY = {
  "random-01": randomBotMove,
  "no-waste-01": noWasteBotMove,
  "solver-greedy-01": tier3BotMove,
  "solver-greedy-weak-01": solverGreedyWeakBot,
  "solver-greedy-strong-01": solverGreedyStrongBot,
  "solver-greedy-strong-02": solverGreedyStrongPlusBot,
};

// Unknown/missing key (e.g. a bot row seeded before its tier's code
// existed) falls back to the weakest tier rather than throwing — a bot
// should always be able to move, never crash a match.
export function chooseMoveForBotKey(botKey) {
  return CHOOSE_MOVE_BY_KEY[botKey] ?? randomBotMove;
}
