import { fragmentsOf } from "./fragmentExtractor.js";
import { buildComponentTree, jointDominoAware } from "./reducedTreeDominoAware.js";

// Concrete domino placements available in ONE component's CURRENT raw
// mask. Deliberately does NOT fold length-3 fragments down to length-2
// the way dominoSolver's canonicalFragments does for solving - that
// folding exists purely to make the ABSTRACT SOLVE cheaper (both cuts of
// a length-3 fragment provably reach the same outcome), but on the
// actual board they're still two physically distinct, independently
// legal moves, and the caller wants to see both - that's exactly the
// "many of them are equivalent" case, not a reason to hide one.
function concreteDominoMoves(zoneSolver, mask) {
  const moves = [];
  for (const frag of fragmentsOf(zoneSolver, mask)) {
    if (frag.length < 2) continue;
    for (let cut = 0; cut <= frag.length - 2; cut++) {
      const cells = [frag.cells[cut], frag.cells[cut + 1]];
      const coveredMask = cells.reduce((m, [r, c]) => m | (1n << BigInt(zoneSolver.indexOf.get(`${r},${c}`))), 0n);
      moves.push({ cells, resultMask: mask & ~coveredMask });
    }
  }
  return moves;
}

// Every concrete, currently-legal move across all N components that
// leaves the opponent facing a loss - the full winning SET, not one
// arbitrary pick. Many entries are genuinely equivalent (both cuts of a
// length-3 fragment; two different classical placements that both zero
// out the same residual) - that's expected, not noise to dedupe away
// here. Returns { moverWins, moves }: moverWins is redundant with
// "moves.length > 0" by construction (asserted in tests, not just
// assumed) but is convenient for a caller that only wants the verdict.
//
// rawMasks: current mask for each of the N top-level components (plain
// masks, not tree nodes) - built into trees internally so this is safe
// to call directly from a board position without the caller knowing
// anything about the tree representation.
//
// Correctness note - this is the part hash-consing made non-trivial:
// a canonical node's .children array corresponds index-for-index to
// _movesAt() of WHATEVER mask ORIGINALLY built that exact node, which
// is not necessarily rawMasks[i] - two structurally-identical
// components at different board locations share one canonical node
// once hash-consed, and _movesAt's result order is tied to absolute
// board coordinates (placements are anchored positions, not
// shape-relative offsets), so nothing guarantees children[k] lines up
// with the k-th move _movesAt(rawMasks[i]) reports for THIS mask.
// That's fine for jointDominoAware itself (it only needs the correct
// SET of reachable shapes, never "which index came from which move"),
// but it would be silently wrong here. So every move below is instead
// resolved by recomputing the ACTUAL resulting mask for that ACTUAL
// move and asking buildComponentTree for its canonical node fresh -
// correct regardless of what currentNodes[i] happens to be shared with,
// since it never relies on an index correspondence hash-consing never
// promised. (buildComponentTree is cheap to call this way - the global
// canonicalRegistry it shares with every other call still makes a
// previously-seen shape free, same as always.)
// resultMask, this call to buildComponentTree, once it strips down to the
// same shape, always finds it already sitting in buildMemo from when
// currentNodes[i] was originally built - so this is a cheap re-derivation
// down to a memo hit, not a repeat of the full recursive descent.
// buildMemo defaults to a fresh Map so a single call is always correct
// standalone, but a caller making many calls for the SAME rawMasks with
// different (moverDom, oppDom) - exactly what a per-zone (M,M') table
// needs - should pass the same buildMemo through every call. Without
// that, each call re-walks the entire tree from scratch even though the
// shape hasn't changed at all between calls (measured: no warming trend
// across 9 repeated calls on one 12+12 zone, 8-24ms every time). With a
// shared buildMemo, only the first call pays that cost.
export function winningMoves(zoneSolver, rawMasks, moverDom, oppDom, memo = new Map(), buildMemo = new Map()) {
  const currentNodes = rawMasks.map((m) => buildComponentTree(zoneSolver, m, buildMemo));
  const allLeaf = currentNodes.every((n) => n.leaf);
  const moves = [];

  if (allLeaf) {
    if (moverDom > 0) {
      for (let i = 0; i < rawMasks.length; i++) {
        for (const { cells, resultMask } of concreteDominoMoves(zoneSolver, rawMasks[i])) {
          const nextNodes = currentNodes.slice();
          nextNodes[i] = buildComponentTree(zoneSolver, resultMask, buildMemo);
          const oppWins = jointDominoAware(nextNodes, oppDom, moverDom - 1, memo);
          if (!oppWins) moves.push({ componentIndex: i, type: "domino", cells, resultMask });
        }
      }
    }
  } else {
    for (let i = 0; i < rawMasks.length; i++) {
      for (const m of zoneSolver._movesAt(rawMasks[i])) {
        const resultMask = rawMasks[i] & ~m;
        const nextNodes = currentNodes.slice();
        nextNodes[i] = buildComponentTree(zoneSolver, resultMask, buildMemo);
        const oppWins = jointDominoAware(nextNodes, oppDom, moverDom, memo);
        if (!oppWins) moves.push({ componentIndex: i, type: "classical", cells: zoneSolver.cellsOfMask(m), resultMask });
      }
    }
  }

  const moverWins = jointDominoAware(currentNodes, moverDom, oppDom, memo);
  return { moverWins, moves };
}

// The table a classical leaf actually needs (see dominoSolver.js's own
// buildResidualTable, which this mirrors one level up): for every
// (moverDominoes, opponentDominoes) pair up to maxDominoes, both the
// verdict AND the concrete move set - the classical search needs moves
// available for whichever budget the board-level allocator eventually
// settles on, not just a yes/no it has to re-derive moves for later.
//
// Builds ONE ZoneSolver's worth of scaffolding - one buildMemo, one
// joint memo - and threads both through every query, so only the FIRST
// (m, o) pair pays for tree construction; every subsequent one in the
// same table is answered from cache (see the earlier measurement: same
// zone, unshared memos, 8-24ms every query; shared, 21ms once then
// sub-millisecond-to-a-few-ms after). rawMasks must stay fixed for the
// life of one table - this is the (M,M') table for one specific,
// already-resolved classical leaf, not a moving target.
export function buildZoneDominoTable(zoneSolver, rawMasks, maxDominoes = 2) {
  const jointMemo = new Map();
  const buildMemo = new Map();
  const table = {};
  for (let m = 0; m <= maxDominoes; m++) {
    for (let o = 0; o <= maxDominoes; o++) {
      table[`${m},${o}`] = winningMoves(zoneSolver, rawMasks, m, o, jointMemo, buildMemo);
    }
  }
  return table;
}
