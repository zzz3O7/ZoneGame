// Named configs for the solver bot family (server/bot/solverBot.js).
// See docs/BOTS.md for the full design discussion. Ladder strength,
// weakest to strongest: BOT_SOLVER_0/1 < BOT_SOLVER_2 < BOT_SOLVER_3 —
// exact win rates aren't pinned here since they drift as the configs
// themselves change (most recently: creationUncertain switched from
// "smallest" to "safeSmallest" for bots 1-3, see below); re-run
// server/scripts/solverSelfPlay.js for current numbers rather than
// trusting a stale comment.
//
// Note on 0 vs 1: these two land close to each other — the shared
// shuffled actionPriority dominates game-to-game variance more than the
// zoneSelection tie-break refinement does. Kept as separate configs
// anyway since the design intent differs and future maxBlobSize/
// avoidLosingMove tuning may separate them further once rating data
// exists.
//
// creationUncertain: "safeSmallest" (bots 1-3) — plain "smallest" picks
// the cheapest uncertain zone to create, but creating a zone hands the
// very next move in it to the OPPONENT (Zone.create flips localTurn), and
// a small uncertain zone is disproportionately easy for the opponent's
// pickMoveAvoidingLoss to crack outright: one placement removes at most
// 4 cells, so only a zone small enough that a single cut can leave two
// maxBlobSize-sized halves is at real risk of being fully solved against
// you. "safeSmallest" filters candidates down to those above that
// cell-count margin before picking smallest-by-cost, instead of
// optimizing for cost alone — see solverBot.js's safeCreationMargin/
// selectSafeSmallest for the exact threshold and reasoning.

// Weakest reasonable solver bot — still smarter than no-waste (it does
// real zone-outcome solving), but its priority order is fully shuffled
// every move (only "domino" pinned last), so it can walk past a
// guaranteed win to create a zone it already knows is lost. Tie-breaks
// within a category are all random.
export const BOT_SOLVER_0 = {
  maxBlobSize: 12,
  actionPriority: {
    shuffle: true,
    order: [
      { category: "creationWinnable" },
      { category: "lostActive" },
      { category: "uncertainActive" },
      { category: "creationUncertain" },
      { category: "winnableActive" },
      { category: "creationLost" },
      { category: "domino", pinned: true },
    ],
  },
  zoneSelection: {
    winnableActive: "random",
    uncertainActive: "random",
    lostActive: "random",
    creationWinnable: "random",
    creationUncertain: "random",
    creationLost: "random",
    dominoFallback: "biggest",
  },
  avoidLosingMove: { enabled: true, maxTries: 15 },
};

// Same fully-shuffled priority order (same structural weakness) as
// BOT_SOLVER_0, but damage-limiting tie-breaks within each category:
// bank small wins/uncertain zones fast, maximize a guaranteed creation,
// minimize exposure on an uncertain/lost creation.
export const BOT_SOLVER_1 = {
  maxBlobSize: 12,
  actionPriority: {
    shuffle: true,
    order: [
      { category: "creationWinnable" },
      { category: "lostActive" },
      { category: "uncertainActive" },
      { category: "creationUncertain" },
      { category: "winnableActive" },
      { category: "creationLost" },
      { category: "domino", pinned: true },
    ],
  },
  zoneSelection: {
    winnableActive: "smallest",
    uncertainActive: "smallest",
    lostActive: "random",
    creationWinnable: "biggest",
    creationUncertain: "safeSmallest",
    creationLost: "smallest",
    dominoFallback: "biggest",
  },
  avoidLosingMove: { enabled: true, maxTries: 15 },
};

// BOT_SOLVER_1's tie-breaks, but "creationUncertain"/"creationLost" are
// now pinned — the shuffle can no longer put either of them ahead of
// winnableActive/creationWinnable/uncertainActive/lostActive, closing
// off the "walks past a guaranteed win to create a known-bad zone"
// mistake structurally rather than just making it less costly.
export const BOT_SOLVER_2 = {
  maxBlobSize: 12,
  actionPriority: {
    shuffle: true,
    order: [
      { category: "creationWinnable" },
      { category: "lostActive" },
      { category: "uncertainActive" },
      { category: "winnableActive" },
      { category: "creationUncertain", pinned: true },
      { category: "creationLost", pinned: true },
      { category: "domino", pinned: true },
    ],
  },
  zoneSelection: {
    winnableActive: "smallest",
    uncertainActive: "smallest",
    lostActive: "random",
    creationWinnable: "biggest",
    creationUncertain: "safeSmallest",
    creationLost: "smallest",
    dominoFallback: "biggest",
  },
  avoidLosingMove: { enabled: true, maxTries: 15 },
};

// BOT_SOLVER_2's tie-breaks with a fully fixed (unshuffled) priority
// order: creates winning zones and clears lost zones first, deliberately
// banking already-winnable active zones as reserve tempo rather than
// cashing them in immediately — leaves "winnableActive" until position 5,
// after every creation/uncertain option is exhausted. Strongest of the
// family — see server/scripts/solverSelfPlay.js for current self-play
// numbers rather than a comment that will drift out of date.
export const BOT_SOLVER_3 = {
  maxBlobSize: 12,
  actionPriority: {
    shuffle: false,
    order: [
      { category: "creationWinnable" },
      { category: "lostActive" },
      { category: "uncertainActive" },
      { category: "creationUncertain" },
      { category: "winnableActive" },
      { category: "creationLost" },
      { category: "domino", pinned: true },
    ],
  },
  zoneSelection: {
    winnableActive: "smallest",
    uncertainActive: "smallest",
    lostActive: "random",
    creationWinnable: "biggest",
    creationUncertain: "safeSmallest",
    creationLost: "smallest",
    dominoFallback: "biggest",
  },
  avoidLosingMove: { enabled: true, maxTries: 15 },
};
