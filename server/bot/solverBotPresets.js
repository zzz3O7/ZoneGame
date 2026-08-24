// Named configs for the solver bot family (server/bot/solverBot.js).
// See docs/BOTS.md for the full design discussion and self-play
// verification of these four. Ladder strength, weakest to strongest:
// BOT_SOLVER_0 < BOT_SOLVER_1 ~= BOT_SOLVER_0 (see note) < BOT_SOLVER_2 < BOT_SOLVER_3.
//
// Note on 0 vs 1: self-play (116 games) showed these two land within
// noise of each other (48%/50%) — the shared shuffled actionPriority
// dominates the game-to-game variance more than the zoneSelection
// tie-break refinement does. Kept as separate configs anyway since the
// design intent differs and future maxBlobSize/avoidLosingMove tuning
// may separate them further once rating data exists.

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
    creationUncertain: "smallest",
    creationLost: "smallest",
    dominoFallback: "biggest",
  },
  avoidLosingMove: { enabled: true, maxTries: 15 },
};

export const BOT_SOLVER_1_5 = {
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
    creationUncertain: "random",
    creationLost: "smallest",
    dominoFallback: "biggest",
  },
  avoidLosingMove: { enabled: true, maxTries: 15 },
};

export const BOT_SOLVER_1_6 = {
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
    creationUncertain: "biggest",
    creationLost: "smallest",
    dominoFallback: "biggest",
  },
  avoidLosingMove: { enabled: true, maxTries: 15 },
};

// BOT_SOLVER_1's tie-breaks, but "creationUncertain"/"creationLost" are
// now pinned — the shuffle can no longer put either of them ahead of
// winnableActive/creationWinnable/uncertainActive/lostActive, closing
// off the "walks past a guaranteed win to create a known-bad zone"
// mistake structurally rather than just making it less costly. Verified
// stronger than BOT_SOLVER_1 in self-play (23-17 over 40 games).
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
    creationUncertain: "smallest",
    creationLost: "smallest",
    dominoFallback: "biggest",
  },
  avoidLosingMove: { enabled: true, maxTries: 15 },
};

// BOT_SOLVER_2's tie-breaks with a fully fixed (unshuffled) priority
// order: creates winning zones and clears lost zones first, deliberately
// banking already-winnable active zones as reserve tempo rather than
// cashing them in immediately — leaves "winnableActive" until position 5,
// after every creation/uncertain option is exhausted. Verified strongest
// of the family in self-play: beat BOT_SOLVER_2 30-10 (40 games) and
// BOT_SOLVER_0 35-5 (40 games).
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
    creationUncertain: "smallest",
    creationLost: "smallest",
    dominoFallback: "biggest",
  },
  avoidLosingMove: { enabled: true, maxTries: 15 },
};
