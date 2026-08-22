import { Rules } from "../../shared/engine/rules.js";
import { Board } from "../../shared/engine/board.js";
import { Zone } from "../../shared/engine/zone.js";
import { Shape, SHAPE_VARIANTS } from "../../shared/engine/shape.js";
import { ZoneSolver } from "./zoneSolver.js";

const NON_DOMINO_TYPES = ["tromino", "tetromino"];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
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

// Classifies one of the mover's currently-active zones (their own
// localTurn) as "winnable" / "uncertain" / "lost", using the
// domino-free solver — see docs/BOTS.md for why dominoes are excluded
// from this model entirely rather than merely deprioritized.
function classifyActiveZone(board, zone) {
  const openCells = openCellKeysOfZone(board, zone);
  if (openCells.length === 0) {
    // Shouldn't really be reachable — a zone with no open cells and a
    // pending localTurn would already have auto-completed in
    // Game._checkZoneCompletions — but if it ever is, there's no move
    // to make here regardless of label.
    return { zone, outcome: "lost", solver: null };
  }
  const solver = new ZoneSolver(openCells);
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
function evaluateCreationCandidate(game, preview, move) {
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
    const solver = new ZoneSolver(openCells);
    const opponentWins = solver.solveFull();
    outcome = opponentWins === true ? "lost" : opponentWins === false ? "winnable" : "uncertain";
  }
  return { move, outcome, cost: preview.cost };
}

function zoneCreationCandidates(game, player) {
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
    evaluated.push(evaluateCreationCandidate(game, preview, move));
  }
  return evaluated;
}

// Tier 3: exact zone solver + greedy global coordinator. Dominoes are
// excluded from the solver's model entirely and are the absolute last
// resort at the coordinator level too — see docs/BOTS.md for the full
// design discussion behind this ordering.
//
// Priority order:
//   1. An active zone (my local turn) already provably winnable ->
//      play the/a winning move there (random among winnable zones).
//   2. Otherwise, try to CREATE a zone: prefer a provably winnable one
//      (biggest first), then any uncertain one, then the smallest
//      provably lost one (better than nothing — see docs/BOTS.md's
//      "big zone is a tempo trap" note for why smallest, not biggest,
//      once none are winnable).
//   3. Otherwise, an uncertain active zone -> random non-domino move.
//   4. Otherwise, a lost active zone -> random non-domino move.
//   5. Otherwise, dominoes are the only moves left anywhere -> play
//      one in the most valuable (highest-cost) available zone.
//   6. Otherwise, no legal move exists at all -> pass (null).
export function tier3BotMove(game, playerIndex) {
  const player = game.players[playerIndex];
  const { board, zones } = game;

  const activeZones = zones.filter((z) => z.active && z.localTurn === playerIndex);
  const classified = activeZones.map((zone) => classifyActiveZone(board, zone));

  // 1. Already-active winnable zone.
  const winnableActive = classified.filter((c) => c.outcome === "winnable");
  if (winnableActive.length > 0) {
    const choice = pickRandom(winnableActive);
    const winMask = choice.solver.findWinningMove();
    const placement = placementFromMask(choice.solver, winMask);
    if (placement) return placement;
    // Unreachable per findWinningMove's own correctness note, but
    // don't get stuck if it ever is — fall through to the rest.
  }

  // 2. Try to create a zone.
  const creationCandidates = zoneCreationCandidates(game, player);
  if (creationCandidates.length > 0) {
    const winnableCreation = creationCandidates.filter((c) => c.outcome === "winnable");
    if (winnableCreation.length > 0) {
      winnableCreation.sort((a, b) => b.cost - a.cost);
      return winnableCreation[0].move;
    }
    const uncertainCreation = creationCandidates.filter((c) => c.outcome === "uncertain");
    if (uncertainCreation.length > 0) {
      return pickRandom(uncertainCreation).move;
    }
    const lostCreation = creationCandidates.filter((c) => c.outcome === "lost");
    if (lostCreation.length > 0) {
      lostCreation.sort((a, b) => a.cost - b.cost);
      return lostCreation[0].move;
    }
  }

  // 3. Uncertain active zone.
  const uncertainActive = classified.filter((c) => c.outcome === "uncertain");
  if (uncertainActive.length > 0) {
    const zone = pickRandom(uncertainActive).zone;
    const moves = nonDominoMovesInZone(board, zones, player, zone);
    if (moves.length > 0) return pickRandom(moves);
  }

  // 4. Lost active zone — still better than passing or spending a domino.
  const lostActive = classified.filter((c) => c.outcome === "lost");
  if (lostActive.length > 0) {
    const zone = pickRandom(lostActive).zone;
    const moves = nonDominoMovesInZone(board, zones, player, zone);
    if (moves.length > 0) return pickRandom(moves);
  }

  // 5. Dominoes are the only moves left anywhere — move to the most
  // valuable zone that currently accepts one.
  const dominoOptions = [];
  for (const zone of zones) {
    if (!zone.active || zone.localTurn !== playerIndex) continue;
    const moves = dominoMovesInZone(board, zones, player, zone);
    if (moves.length > 0) dominoOptions.push({ zone, move: moves[0] });
  }
  if (dominoOptions.length > 0) {
    dominoOptions.sort((a, b) => b.zone.cost - a.zone.cost);
    return dominoOptions[0].move;
  }

  // 6. Truly nothing legal anywhere — the rules only allow a pass here.
  return null;
}
