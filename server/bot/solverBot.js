import { Rules } from "../../shared/engine/rules.js";
import { Board } from "../../shared/engine/board.js";
import { Zone } from "../../shared/engine/zone.js";
import { Shape, SHAPE_VARIANTS } from "../../shared/engine/shape.js";
import { ZoneSolver } from "./zoneSolver.js";

const NON_DOMINO_TYPES = ["tromino", "tetromino"];

// The seven action types this bot family can take on its turn, in the
// vocabulary the config speaks. "pass" is deliberately NOT a category
// here — see createSolverBot's final fallback for why it's a structural
// fallthrough rather than something orderable/shufflable.
const CATEGORIES = [
  "winnableActive",
  "uncertainActive",
  "lostActive",
  "creationWinnable",
  "creationUncertain",
  "creationLost",
  "domino",
];

const DEFAULT_ACTION_ORDER = [
  { category: "creationWinnable" },
  { category: "lostActive" },
  { category: "uncertainActive" },
  { category: "creationUncertain" },
  { category: "winnableActive" },
  { category: "creationLost" },
  { category: "domino", pinned: true },
];

// Every tunable this bot family exposes. See docs/BOTS.md for the full
// design discussion of what each field means and why.
//
//   maxBlobSize        — STRENGTH DIAL. How large a connected,
//                         unfragmented region the solver will fully
//                         search before giving up ("uncertain"). Higher
//                         = solves more positions exactly = stronger, at
//                         a genuine exponential cost (see zoneSolver.js).
//   actionPriority     — which action type to attempt first, second,
//                         etc. `order` is all 7 categories, each
//                         optionally `pinned: true` to exclude it from
//                         shuffling. `shuffle: true` re-randomizes the
//                         order of all non-pinned entries on every
//                         single move (see resolveOrder) — e.g. a config
//                         with only "domino" pinned and shuffle on picks
//                         uniformly among whichever of the other six
//                         action types currently has a candidate, a
//                         genuinely different bot from tier-1's
//                         uniform-over-all-legal-moves randomness.
//   zoneSelection      — among multiple candidates WITHIN one chosen
//                         category, how to break the tie: "random" /
//                         "smallest" / "biggest" (by zone or candidate
//                         cost). One independent dial per category, no
//                         more hardcoded pairing between any two.
//                         "safeSmallest" is an extra option valid ONLY for
//                         creationUncertain: smallest-by-cost among
//                         candidates whose open-cell count clears
//                         safeCreationMargin (see that function) — avoids
//                         "smallest" wandering into zones cheap enough to
//                         be cost-efficient but small enough that the
//                         opponent's avoidLosingMove search can often
//                         crack them outright.
//   avoidLosingMove    — STRENGTH DIAL. Within a chosen uncertain/lost
//                         zone, how hard to search for a move that wins
//                         outright or at least avoids a provable loss
//                         before falling back to a plain random pick.
//                         maxTries higher = stronger, linear cost.
const DEFAULT_CONFIG = {
  maxBlobSize: 12,
  actionPriority: {
    shuffle: false,
    order: DEFAULT_ACTION_ORDER,
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
  avoidLosingMove: {
    enabled: true,
    maxTries: 15,
  },
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffledCopy(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Validates that `order` contains every category exactly once — a
// config typo (missing/duplicate/unknown category) fails loudly at bot
// construction time rather than silently producing a bot that can never
// take some action, or crashing mid-game on an undefined handler.
function validateOrder(order) {
  const seen = new Set();
  for (const entry of order) {
    if (!CATEGORIES.includes(entry.category)) {
      throw new Error(`solverBot: unknown action category "${entry.category}"`);
    }
    if (seen.has(entry.category)) {
      throw new Error(`solverBot: duplicate action category "${entry.category}" in actionPriority.order`);
    }
    seen.add(entry.category);
  }
  for (const category of CATEGORIES) {
    if (!seen.has(category)) {
      throw new Error(`solverBot: actionPriority.order is missing category "${category}"`);
    }
  }
}

function mergeConfig(config) {
  const cfg = {
    maxBlobSize: config.maxBlobSize ?? DEFAULT_CONFIG.maxBlobSize,
    actionPriority: {
      shuffle: config.actionPriority?.shuffle ?? DEFAULT_CONFIG.actionPriority.shuffle,
      order: config.actionPriority?.order ?? DEFAULT_CONFIG.actionPriority.order,
    },
    zoneSelection: { ...DEFAULT_CONFIG.zoneSelection, ...config.zoneSelection },
    avoidLosingMove: { ...DEFAULT_CONFIG.avoidLosingMove, ...config.avoidLosingMove },
  };
  validateOrder(cfg.actionPriority.order);
  return cfg;
}

// Resolves actionPriority into a plain array of 7 category strings for
// this particular move. Non-pinned entries get shuffled AMONG THEIR OWN
// SLOT POSITIONS when shuffle is on; pinned entries never move from
// their configured position. This is what lets e.g. domino stay fixed
// last while everything else is genuinely uniformly randomized — a
// pinned entry's rank relative to every other pinned entry is fixed by
// the config, but non-pinned categories are equally likely to land in
// any of the non-pinned slots.
function resolveOrder({ shuffle, order }) {
  if (!shuffle) return order.map((e) => e.category);

  const nonPinnedSlots = [];
  order.forEach((e, i) => {
    if (!e.pinned) nonPinnedSlots.push(i);
  });
  const shuffledCategories = shuffledCopy(nonPinnedSlots.map((i) => order[i].category));

  const result = order.map((e) => e.category);
  nonPinnedSlots.forEach((slot, k) => {
    result[slot] = shuffledCategories[k];
  });
  return result;
}

// Applies one of "random" / "smallest" / "biggest" to break a tie among
// same-category candidates. `costOf` lets callers reuse this across
// differently-shaped bucket items (classified zones, creation
// candidates, domino options) that each carry cost in a different place.
function selectByStrategy(items, strategy, costOf) {
  if (items.length === 0) return null;
  if (strategy === "random") return pickRandom(items);
  if (strategy === "smallest") return items.reduce((best, x) => (costOf(x) < costOf(best) ? x : best));
  if (strategy === "biggest") return items.reduce((best, x) => (costOf(x) > costOf(best) ? x : best));
  throw new Error(`solverBot: unknown zone selection strategy "${strategy}"`);
}

// A single non-domino piece placement removes at most this many cells
// (the largest tetromino/tromino shape) — see SHAPE_VARIANTS.
const MAX_NON_DOMINO_PIECE_CELLS = 4;

// "safeSmallest" for creationUncertain only (see creationBucket): plain
// "smallest" picks by cost, but a small UNCERTAIN zone is disproportionately
// exploitable, not just cheap. pickMoveAvoidingLoss only wins outright when
// one placement leaves a residual that fully decomposes into components
// each <= maxBlobSize — impossible if the zone's open-cell count is above
// 2*maxBlobSize + (biggest piece), since no single placement can carve it
// into two solver-sized halves. Below that threshold a lucky cut can, so
// that's the exploitable range "smallest" keeps wandering into.
//
// This is a size-based proxy for exploitability, not a simulation of it —
// cheap (no extra ZoneSolver calls) but not exact: an odd-shaped blob just
// above the margin could still have a bottleneck a single piece exploits.
// Trades a bit of precision for staying O(candidates) instead of
// O(candidates * maxTries) like actually simulating the opponent would be.
function safeCreationMargin(maxBlobSize) {
  return 2 * maxBlobSize + MAX_NON_DOMINO_PIECE_CELLS;
}

function selectSafeSmallest(items, costOf, cellCountOf, maxBlobSize) {
  const margin = safeCreationMargin(maxBlobSize);
  const safe = items.filter((x) => cellCountOf(x) > margin);
  // Nothing clears the margin (e.g. maxBlobSize itself is large relative
  // to available zones) — fall back to the full candidate set rather than
  // returning nothing.
  const pool = safe.length > 0 ? safe : items;
  // Within the safe pool, still prefer cheap — no reason to pay more cost
  // than necessary once exploitability risk is already controlled for.
  return pool.reduce((best, x) => (costOf(x) < costOf(best) ? x : best));
}

function openCellKeysOfZone(board, zone) {
  const open = [];
  for (const key of zone.cellSet) {
    if (!board.occupied.has(key)) open.push(key);
  }
  return open;
}

function nonDominoMovesInZone(board, zones, player, zone) {
  const moves = [];
  for (const type of NON_DOMINO_TYPES) {
    for (const shape of SHAPE_VARIANTS[type]) {
      for (const key of zone.cellSet) {
        if (board.occupied.has(key)) continue;
        const [r, c] = Board.parse(key);
        if (Rules.canPlaceHere(board, zones, player, type, shape, r, c)) {
          moves.push({ pieceType: type, shape, anchorRow: r, anchorCol: c });
        }
      }
    }
  }
  return moves;
}

function dominoMovesInZone(board, zones, player, zone) {
  if (player.dominoLeft <= 0) return [];
  const moves = [];
  for (const shape of SHAPE_VARIANTS.domino) {
    for (const key of zone.cellSet) {
      if (board.occupied.has(key)) continue;
      const [r, c] = Board.parse(key);
      if (Rules.canPlaceHere(board, zones, player, "domino", shape, r, c)) {
        moves.push({ pieceType: "domino", shape, anchorRow: r, anchorCol: c });
      }
    }
  }
  return moves;
}

// Recovers a real (pieceType, shape, anchorRow, anchorCol) placement
// matching the exact cell-set a solver's findWinningMove() mask covers.
// ZoneSolver deliberately never touches real placements itself (see its
// own header) — this is the one place that bridges its abstract
// bitmask answer back into something the game engine understands.
function placementFromMask(solver, mask) {
  const targetCells = new Set(solver.cellsOfMask(mask).map(([r, c]) => Board.key(r, c)));
  for (const type of NON_DOMINO_TYPES) {
    for (const shape of SHAPE_VARIANTS[type]) {
      for (const key of targetCells) {
        const [r, c] = Board.parse(key);
        const placedCells = Shape.cellsAt(shape, r, c);
        if (placedCells.length !== targetCells.size) continue;
        if (placedCells.every(([pr, pc]) => targetCells.has(Board.key(pr, pc)))) {
          return { pieceType: type, shape, anchorRow: r, anchorCol: c };
        }
      }
    }
  }
  return null; // unreachable if mask came from this solver's own findWinningMove()
}

// Given a zone's real, currently-legal non-domino moves, tries up to
// `maxTries` of them in random order, solving the resulting position
// each time, and returns the first one that outright WINS (the
// opponent, now mover, provably loses) — exiting immediately the
// instant one is found. This can genuinely find a win the top-level
// zone classification missed: a zone gets classified "uncertain" only
// because its FULL open-cell mask was too large to solve directly, but
// one specific candidate move can shrink/fragment it into something the
// solver resolves cleanly, sometimes into an outright win.
//
// If no winning move turns up in the sample, prefers a move that's at
// least still "uncertain" over one that's a provable loss; if every
// sampled move is a provable loss, just returns the last one tried —
// still strictly better than passing or spending a domino.
function pickMoveAvoidingLoss(board, zone, moves, { maxBlobSize, maxTries }) {
  const zoneOpen = openCellKeysOfZone(board, zone);
  const sample = shuffledCopy(moves).slice(0, Math.min(maxTries, moves.length));

  let uncertainFallback = null;
  let lastTried = null;

  for (const move of sample) {
    lastTried = move;
    const placedCells = new Set(
      Shape.cellsAt(move.shape, move.anchorRow, move.anchorCol).map(([r, c]) => Board.key(r, c)),
    );
    const childOpen = zoneOpen.filter((key) => !placedCells.has(key));
    const childResult = new ZoneSolver(childOpen, { maxBlobSize }).solveFull();
    if (childResult === false) return move; // opponent, now mover, loses -> this move wins outright
    if (childResult === null && uncertainFallback === null) uncertainFallback = move;
  }
  return uncertainFallback ?? lastTried;
}

// Classifies one of the mover's currently-active zones (their own
// localTurn) as "winnable" / "uncertain" / "lost", using the
// domino-free solver — see docs/BOTS.md for why dominoes are excluded
// from this model entirely rather than merely deprioritized.
function classifyActiveZone(board, zone, maxBlobSize) {
  const openCells = openCellKeysOfZone(board, zone);
  if (openCells.length === 0) {
    // Shouldn't really be reachable — a zone with no open cells and a
    // pending localTurn would already have auto-completed in
    // Game._checkZoneCompletions — but if it ever is, there's no move
    // to make here regardless of label.
    return { zone, outcome: "lost", solver: null };
  }
  const solver = new ZoneSolver(openCells, { maxBlobSize });
  const win = solver.solveFull();
  const outcome = win === true ? "winnable" : win === false ? "lost" : "uncertain";
  return { zone, outcome, solver };
}

// Evaluates a single candidate zone-CREATION move. Note the inversion
// versus classifyActiveZone: creating a zone hands the very next local
// turn in it to the OPPONENT (Zone.create sets localTurn = 1 -
// creator), so "good for me to create" means the opponent, as mover,
// loses — the solver's own win/loss sense is flipped here on purpose.
//
// Zone.floodFill's result depends only on the anchor cell and radius,
// not on the piece shape placed there (see Zone.preview/floodFill) —
// so this only ever needs one flood-fill per distinct anchor, which the
// caller is responsible for reusing across a candidate's shape variants
// (see zoneCreationCandidates below).
function evaluateCreationCandidate(preview, move, maxBlobSize) {
  const shapeCells = new Set(
    Shape.cellsAt(move.shape, move.anchorRow, move.anchorCol).map(([r, c]) => Board.key(r, c)),
  );
  const openCells = [...preview.cellSet].filter((key) => !shapeCells.has(key));

  let outcome;
  if (openCells.length === 0) {
    // Opponent would have literally nothing to play in it — the zone
    // auto-completes back to the CREATOR the instant it's made. Best
    // possible outcome.
    outcome = "winnable";
  } else {
    const solver = new ZoneSolver(openCells, { maxBlobSize });
    const opponentWins = solver.solveFull();
    outcome = opponentWins === true ? "lost" : opponentWins === false ? "winnable" : "uncertain";
  }
  // cellCount is the open-cell count the OPPONENT's solver will actually
  // see (post-placement, pre-bonus) — the thing "safeSmallest" reasons
  // about. Deliberately separate from `cost`, which also folds in bonus
  // markers (see Zone.preview) and isn't what determines solvability.
  return { move, outcome, cost: preview.cost, cellCount: openCells.length };
}

function zoneCreationCandidates(game, player, maxBlobSize) {
  const { board, zones, zoneRadius } = game;
  const legalMoves = Rules.allLegalPlacements(board, zones, player).filter(
    (m) => m.pieceType !== "domino" && board.zoneIdAt(m.anchorRow, m.anchorCol) === null,
  );

  // One flood-fill per distinct anchor cell, reused across every shape
  // variant anchored there — see evaluateCreationCandidate's header.
  const previewByAnchor = new Map();
  const evaluated = [];
  for (const move of legalMoves) {
    const anchorKey = Board.key(move.anchorRow, move.anchorCol);
    let preview = previewByAnchor.get(anchorKey);
    if (preview === undefined) {
      preview = Zone.preview(board, move.anchorRow, move.anchorCol, zoneRadius);
      previewByAnchor.set(anchorKey, preview);
    }
    if (!preview) continue; // defensive — allLegalPlacements already implies this is valid
    evaluated.push(evaluateCreationCandidate(preview, move, maxBlobSize));
  }
  return evaluated;
}

// Domino-based zone-creation candidates — parallels
// zoneCreationCandidates, but for the one case that function
// deliberately excludes: a domino CAN legally create a brand-new zone
// under the real rules (Rules.canPlaceHere has no domino-specific
// restriction against it, only the domino-budget check), so once
// dominoes are the only moves left anywhere, this needs its own pass
// rather than reusing the non-domino search. No win/loss classification
// here — this only runs once every better option is already exhausted,
// so a plain cost-based ranking (same as any other domino fallback
// option) is all that's needed.
function dominoCreationCandidates(game, player) {
  const { board, zones, zoneRadius } = game;
  const legalMoves = Rules.allLegalPlacements(board, zones, player).filter(
    (m) => m.pieceType === "domino" && board.zoneIdAt(m.anchorRow, m.anchorCol) === null,
  );
  const previewByAnchor = new Map();
  const candidates = [];
  for (const move of legalMoves) {
    const anchorKey = Board.key(move.anchorRow, move.anchorCol);
    let preview = previewByAnchor.get(anchorKey);
    if (preview === undefined) {
      preview = Zone.preview(board, move.anchorRow, move.anchorCol, zoneRadius);
      previewByAnchor.set(anchorKey, preview);
    }
    if (!preview) continue;
    candidates.push({ move, cost: preview.cost });
  }
  return candidates;
}

// Builds the 7 category -> (move | null) handlers for one chooseMove
// call. Each handler lazily computes and memoizes the classification
// work it needs (active-zone solving, creation-candidate solving,
// domino enumeration) on first access, since actionPriority can put any
// category first — unlike the old fixed-order bot, we can no longer
// assume "active zones always get classified before creation
// candidates are even considered."
function buildCategoryHandlers(game, playerIndex, cfg) {
  const player = game.players[playerIndex];
  const { board, zones } = game;

  let _classified = null;
  function classified() {
    if (_classified === null) {
      const activeZones = zones.filter((z) => z.active && z.localTurn === playerIndex);
      _classified = activeZones.map((zone) => classifyActiveZone(board, zone, cfg.maxBlobSize));
    }
    return _classified;
  }

  let _creation = null;
  function creation() {
    if (_creation === null) _creation = zoneCreationCandidates(game, player, cfg.maxBlobSize);
    return _creation;
  }

  let _dominoOptions = null;
  function dominoOptions() {
    if (_dominoOptions === null) {
      const opts = [];
      for (const zone of zones) {
        if (!zone.active || zone.localTurn !== playerIndex) continue;
        const moves = dominoMovesInZone(board, zones, player, zone);
        if (moves.length > 0) opts.push({ cost: zone.cost, move: moves[0] });
      }
      for (const candidate of dominoCreationCandidates(game, player)) opts.push(candidate);
      _dominoOptions = opts;
    }
    return _dominoOptions;
  }

  function activeMovable(outcome, strategy) {
    const bucket = classified()
      .filter((c) => c.outcome === outcome)
      .map((c) => ({ ...c, moves: nonDominoMovesInZone(board, zones, player, c.zone) }))
      .filter((c) => c.moves.length > 0);
    if (bucket.length === 0) return null;
    const choice = selectByStrategy(bucket, strategy, (c) => c.zone.cost);
    return cfg.avoidLosingMove.enabled
      ? pickMoveAvoidingLoss(board, choice.zone, choice.moves, {
          maxBlobSize: cfg.maxBlobSize,
          maxTries: cfg.avoidLosingMove.maxTries,
        })
      : pickRandom(choice.moves);
  }

  function creationBucket(outcome, strategy) {
    const bucket = creation().filter((c) => c.outcome === outcome);
    if (bucket.length === 0) return null;
    if (strategy === "safeSmallest") {
      return selectSafeSmallest(bucket, (c) => c.cost, (c) => c.cellCount, cfg.maxBlobSize).move;
    }
    return selectByStrategy(bucket, strategy, (c) => c.cost).move;
  }

  return {
    winnableActive() {
      const bucket = classified().filter((c) => c.outcome === "winnable");
      if (bucket.length === 0) return null;
      const choice = selectByStrategy(bucket, cfg.zoneSelection.winnableActive, (c) => c.zone.cost);
      const winMask = choice.solver.findWinningMove();
      // Any winning move is equivalent under the current domino-free
      // model — no dial here (see DEFAULT_CONFIG's own comment).
      return placementFromMask(choice.solver, winMask);
      // If this is ever null (unreachable per findWinningMove's own
      // correctness note), the category simply produced no move and
      // the caller moves on to the next category in priority order.
    },
    uncertainActive() {
      return activeMovable("uncertain", cfg.zoneSelection.uncertainActive);
    },
    lostActive() {
      return activeMovable("lost", cfg.zoneSelection.lostActive);
    },
    creationWinnable() {
      return creationBucket("winnable", cfg.zoneSelection.creationWinnable);
    },
    creationUncertain() {
      return creationBucket("uncertain", cfg.zoneSelection.creationUncertain);
    },
    creationLost() {
      return creationBucket("lost", cfg.zoneSelection.creationLost);
    },
    domino() {
      const bucket = dominoOptions();
      if (bucket.length === 0) return null;
      return selectByStrategy(bucket, cfg.zoneSelection.dominoFallback, (o) => o.cost).move;
    },
  };
}

// Creates a configurable solver-backed bot's chooseMove function, i.e.
// (game, playerIndex) -> move | null, matching what BotAgent expects.
// `config` deep-merges over DEFAULT_CONFIG — see that constant's own
// comment for what each field controls, and docs/BOTS.md for the full
// design discussion.
//
// This single factory can reproduce every bot in the old fixed-priority
// solver-greedy family (and the "try to create a winning zone before
// touching an existing one" idea, and a "uniform-random-among-action-
// types" bot, and anything in between) purely through config — the
// action-type PRIORITY ORDER is now itself a dial, not a fixed rule.
export function createSolverBot(config = {}) {
  const cfg = mergeConfig(config);

  return function chooseMove(game, playerIndex) {
    const player = game.players[playerIndex];
    const { board, zones } = game;
    const handlers = buildCategoryHandlers(game, playerIndex, cfg);
    const order = resolveOrder(cfg.actionPriority);

    for (const category of order) {
      const move = handlers[category]();
      if (move) return move;
    }

    // Every category came back empty. Per the rules this should only
    // happen when truly no legal move exists anywhere — but with this
    // many independently-configurable categories, a bug in any single
    // one's bucket/filter logic could reach this point while a real
    // move still exists elsewhere. Rather than trusting that on faith,
    // verify against Rules.canPlayerMove and fall back to a uniformly
    // random real legal move if one is actually there — this makes an
    // incorrect pass structurally impossible regardless of config,
    // turning any future logic bug into "plays a suboptimal move" at
    // worst rather than "gets stuck / passes illegally."
    if (Rules.canPlayerMove(board, zones, player)) {
      const fallbackMoves = Rules.allLegalPlacements(board, zones, player);
      console.warn(
        "solverBot: all action categories returned no move, but a legal move exists — " +
          "falling back to a random legal move. This indicates a bug in one of the " +
          "category handlers and is worth investigating.",
      );
      return pickRandom(fallbackMoves);
    }
    return null;
  };
}

// Default-configured instance — reproduces the pre-generalization
// tier3Bot's exact behavior (see DEFAULT_ACTION_ORDER's comment).
export const defaultSolverBotMove = createSolverBot();
