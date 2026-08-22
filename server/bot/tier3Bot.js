import { Rules } from "../../shared/engine/rules.js";
import { Board } from "../../shared/engine/board.js";
import { Zone } from "../../shared/engine/zone.js";
import { Shape, SHAPE_VARIANTS } from "../../shared/engine/shape.js";
import { ZoneSolver } from "./zoneSolver.js";

const NON_DOMINO_TYPES = ["tromino", "tetromino"];

// Every ordering/selection decision this bot family makes, and whether
// it's an exposed dial (see createSolverGreedyBot's config) or a fixed
// rule (see docs/BOTS.md — decided together, not independently, since
// the two are opposite sides of one idea: a big won zone is a bonus, a
// big lost zone is a tempo trap you shouldn't have handed the opponent
// in the first place):
//   1. winnableActive   — configurable, default "random"
//   2. creationWinnable — FIXED "biggest" (not exposed)
//   3. creationUncertain— configurable, default "random"
//   4. creationLost     — FIXED "smallest" (not exposed)
//   5. uncertainActive  — configurable, default "random"
//   6. lostActive       — configurable, default "random"
//   7. dominoFallback   — configurable, default "biggest"
//   8. which winning move within an already-winnable zone — no dial;
//      any winning move is equivalent under this domino-free model, so
//      whichever findWinningMove() happens to return stands. Will
//      matter once the solver can compare remaining domino-shaped
//      spots between candidate winning lines — not yet.
//   9. which move to try first in an uncertain/lost zone — see
//      pickMoveAvoidingLoss's avoidLosingMove config.
const DEFAULT_CONFIG = {
  maxBlobSize: 12,
  zoneSelection: {
    winnableActive: "random",
    creationUncertain: "random",
    uncertainActive: "random",
    lostActive: "random",
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

// Applies one of the bot's three zone-selection strategies. `costOf`
// lets callers reuse this across differently-shaped bucket items
// (classified active zones, creation candidates, domino options) that
// each carry their cost in a different place.
function selectByStrategy(items, strategy, costOf) {
  if (items.length === 0) return null;
  if (strategy === "random") return pickRandom(items);
  if (strategy === "smallest") return items.reduce((best, x) => (costOf(x) < costOf(best) ? x : best));
  if (strategy === "biggest") return items.reduce((best, x) => (costOf(x) > costOf(best) ? x : best));
  throw new Error(`Unknown zone selection strategy: "${strategy}"`);
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
// one specific candidate move can shrink/fragment it into something
// the solver resolves cleanly, sometimes into an outright win.
//
// If no winning move turns up in the sample, prefers a move that's at
// least still "uncertain" over one that's a provable loss (never worth
// walking into a known loss when an unknown is available); if every
// sampled move is a provable loss, just returns the last one tried —
// still strictly better than passing or spending a domino, which is
// the failure mode this replaces (see docs/BOTS.md's note on the fixed
// zone-selection bug).
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
// so this only ever needs one flood-fill per distinct anchor, which
// the caller is responsible for reusing across a candidate's shape
// variants (see zoneCreationCandidates below).
function evaluateCreationCandidate(preview, move, maxBlobSize) {
  const shapeCells = new Set(
    Shape.cellsAt(move.shape, move.anchorRow, move.anchorCol).map(([r, c]) => Board.key(r, c)),
  );
  const openCells = [...preview.cellSet].filter((key) => !shapeCells.has(key));

  let outcome;
  if (openCells.length === 0) {
    // Opponent would have literally nothing to play in it — the zone
    // auto-completes back to the CREATOR the instant it's made (see
    // Game._checkZoneCompletions: no move for zone.localTurn awards
    // the OTHER player). Best possible outcome.
    outcome = "winnable";
  } else {
    const solver = new ZoneSolver(openCells, { maxBlobSize });
    const opponentWins = solver.solveFull();
    outcome = opponentWins === true ? "lost" : opponentWins === false ? "winnable" : "uncertain";
  }
  return { move, outcome, cost: preview.cost };
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

// Creates a solver-backed greedy bot's chooseMove function, i.e.
// (game, playerIndex) -> move | null, matching what BotAgent expects.
// `config` deep-merges over DEFAULT_CONFIG — see that constant's own
// comment for the numbered list of every decision this bot makes and
// which ones are/aren't exposed as dials, and docs/BOTS.md for the
// full design discussion.
//
// Priority order (fixed across the whole family — only the tie-breaks
// within each step are configurable):
//   1. An active zone (my local turn) already provably winnable ->
//      play a winning move there.
//   2. Otherwise, try to CREATE a zone: prefer a provably winnable one
//      (biggest cost — fixed), then any uncertain one, then the
//      smallest provably lost one (fixed — see docs/BOTS.md's "big
//      zone is a tempo trap" note for why smallest, not biggest, once
//      none are winnable).
//   3. Otherwise, an uncertain active zone with a real move available.
//   4. Otherwise, a lost active zone with a real move available.
//   5. Otherwise, dominoes are the only moves left anywhere.
//   6. Otherwise, no legal move exists at all -> pass (null).
//
// Steps 3 and 4 filter to zones that currently HAVE a non-domino move
// before applying any selection strategy — a zone being "uncertain" or
// especially "lost" does not imply it has one (a zone can be lost
// precisely because it has none left, e.g. a single leftover dead
// cell). Selecting a moveless zone first and only then discovering
// that used to fall through incorrectly to the domino fallback even
// when a different zone in the very same bucket had a real move
// available — fixed here by filtering before selecting, not after.
export function createSolverGreedyBot(config = {}) {
  const cfg = {
    maxBlobSize: config.maxBlobSize ?? DEFAULT_CONFIG.maxBlobSize,
    zoneSelection: { ...DEFAULT_CONFIG.zoneSelection, ...config.zoneSelection },
    avoidLosingMove: { ...DEFAULT_CONFIG.avoidLosingMove, ...config.avoidLosingMove },
  };

  return function chooseMove(game, playerIndex) {
    const player = game.players[playerIndex];
    const { board, zones } = game;

    const activeZones = zones.filter((z) => z.active && z.localTurn === playerIndex);
    const classified = activeZones.map((zone) => classifyActiveZone(board, zone, cfg.maxBlobSize));

    // 1. Already-active winnable zone.
    const winnableActive = classified.filter((c) => c.outcome === "winnable");
    if (winnableActive.length > 0) {
      const choice = selectByStrategy(winnableActive, cfg.zoneSelection.winnableActive, (c) => c.zone.cost);
      const winMask = choice.solver.findWinningMove();
      const placement = placementFromMask(choice.solver, winMask);
      if (placement) return placement;
      // Unreachable per findWinningMove's own correctness note, but
      // don't get stuck if it ever is — fall through to the rest.
    }

    // 2. Try to create a zone.
    const creationCandidates = zoneCreationCandidates(game, player, cfg.maxBlobSize);
    if (creationCandidates.length > 0) {
      const winnableCreation = creationCandidates.filter((c) => c.outcome === "winnable");
      if (winnableCreation.length > 0) {
        return selectByStrategy(winnableCreation, "biggest", (c) => c.cost).move;
      }
      const uncertainCreation = creationCandidates.filter((c) => c.outcome === "uncertain");
      if (uncertainCreation.length > 0) {
        return selectByStrategy(uncertainCreation, cfg.zoneSelection.creationUncertain, (c) => c.cost).move;
      }
      const lostCreation = creationCandidates.filter((c) => c.outcome === "lost");
      if (lostCreation.length > 0) {
        return selectByStrategy(lostCreation, "smallest", (c) => c.cost).move;
      }
    }

    // 3. Uncertain active zone with an actual move available.
    const uncertainMovable = classified
      .filter((c) => c.outcome === "uncertain")
      .map((c) => ({ ...c, moves: nonDominoMovesInZone(board, zones, player, c.zone) }))
      .filter((c) => c.moves.length > 0);
    if (uncertainMovable.length > 0) {
      const choice = selectByStrategy(uncertainMovable, cfg.zoneSelection.uncertainActive, (c) => c.zone.cost);
      return cfg.avoidLosingMove.enabled
        ? pickMoveAvoidingLoss(board, choice.zone, choice.moves, {
            maxBlobSize: cfg.maxBlobSize,
            maxTries: cfg.avoidLosingMove.maxTries,
          })
        : pickRandom(choice.moves);
    }

    // 4. Lost active zone with an actual move available — still
    // better than passing or spending a domino.
    const lostMovable = classified
      .filter((c) => c.outcome === "lost")
      .map((c) => ({ ...c, moves: nonDominoMovesInZone(board, zones, player, c.zone) }))
      .filter((c) => c.moves.length > 0);
    if (lostMovable.length > 0) {
      const choice = selectByStrategy(lostMovable, cfg.zoneSelection.lostActive, (c) => c.zone.cost);
      return cfg.avoidLosingMove.enabled
        ? pickMoveAvoidingLoss(board, choice.zone, choice.moves, {
            maxBlobSize: cfg.maxBlobSize,
            maxTries: cfg.avoidLosingMove.maxTries,
          })
        : pickRandom(choice.moves);
    }

    // 5. Dominoes are the only moves left anywhere — in an existing
    // active zone, or by creating a brand-new one (see
    // dominoCreationCandidates for why that needs its own pass).
    const dominoOptions = [];
    for (const zone of zones) {
      if (!zone.active || zone.localTurn !== playerIndex) continue;
      const moves = dominoMovesInZone(board, zones, player, zone);
      if (moves.length > 0) dominoOptions.push({ cost: zone.cost, move: moves[0] });
    }
    for (const candidate of dominoCreationCandidates(game, player)) {
      dominoOptions.push(candidate);
    }
    if (dominoOptions.length > 0) {
      return selectByStrategy(dominoOptions, cfg.zoneSelection.dominoFallback, (o) => o.cost).move;
    }

    // 6. Truly nothing legal anywhere — the rules only allow a pass here.
    return null;
  };
}

// Default-configured instance — this is "solver-greedy-01" in
// botRegistry.js. Reproduces the original, non-parametrized tier 3
// bot's behavior exactly (before the zone-selection bug fix above).
export const tier3BotMove = createSolverGreedyBot();
