import { fragmentsOf } from "./fragmentExtractor.js";
import { buildComponentTree, buildComponentParts, jointDominoAware } from "./reducedTreeDominoAware.js";

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
// arbitrary pick, when moverWins is true. Many entries are genuinely
// equivalent (both cuts of a length-3 fragment; two different classical
// placements that both zero out the same residual) - that's expected,
// not noise to dedupe away here.
//
// moverWins is true, false, or null (undetermined - see
// UNDETERMINED_NODE in reducedTreeDominoAware.js). moves is NOT simply
// "moves.length > 0 iff moverWins" here: when moverWins is false or
// null, every candidate would independently re-derive the same
// non-win, so that per-candidate check is skipped entirely and moves
// instead holds the plain legal-move list, unverified - the caller
// still needs something to play even when nothing provably helps.
// Only when moverWins is true does moves mean "verified winning."
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
// promised. (buildComponentTree is cheap to call this way: once it
// strips down to an already-seen shape it hits buildMemo immediately
// rather than repeating the full recursive descent - see buildMemo
// below.)
//
// memo has NO default of its own here (unlike buildMemo) - left
// undefined when the caller doesn't pass one, so it falls through to
// jointDominoAware's own default (a permanent, global, safe-to-share
// map - see reducedTreeDominoAware.js) instead of shadowing it with a
// fresh, isolated Map every call. A caller that wants isolation (tests
// comparing against a from-scratch baseline) still passes its own
// explicit memo, same as always - this only changes what a caller gets
// when it doesn't bother.
//
// buildMemo DOES default to a fresh Map - that one can never safely be
// global (a raw mask only means something relative to one ZoneSolver's
// own cell-to-bit assignment), so a caller making many calls for the
// SAME rawMasks with different (moverDom, oppDom) - exactly what a
// per-zone (M,M') table needs - must explicitly thread the same
// buildMemo through every call. Without that, each call re-walks the
// entire tree from scratch even though the shape hasn't changed at all
// between calls (measured: no warming trend across 9 repeated calls on
// one 12+12 zone, 8-24ms every time). With a shared buildMemo, only the
// first call pays that cost.
export function winningMoves(zoneSolver, rawMasks, moverDom, oppDom, memo, buildMemo = new Map(), maxComponentSize) {
  const currentNodes = rawMasks.map((m) => buildComponentTree(zoneSolver, m, buildMemo, maxComponentSize));
  const moverWins = jointDominoAware(currentNodes, moverDom, oppDom, memo);
  const allLeaf = currentNodes.every((n) => n.leaf);
  const moves = [];

  // If there's no proven win - moverWins is false, or honestly null -
  // every candidate below would independently report the same "opponent
  // still wins" (or "unknown"), since this top-level check already
  // explored that exact set of reachable states internally. Re-checking
  // each one via its own jointDominoAware call would just rediscover
  // that at real cost for no new information, so skip verification
  // entirely and just list what's legal - the caller still needs
  // something to play even when nothing provably helps.
  const verifyEach = moverWins === true;

  if (allLeaf) {
    if (moverDom > 0) {
      for (let i = 0; i < rawMasks.length; i++) {
        for (const { cells, resultMask } of concreteDominoMoves(zoneSolver, rawMasks[i])) {
          if (!verifyEach) {
            moves.push({ componentIndex: i, type: "domino", cells, resultMask });
            continue;
          }
          const nextNodes = currentNodes.slice();
          nextNodes[i] = buildComponentTree(zoneSolver, resultMask, buildMemo, maxComponentSize);
          // Strict === false, not !result: a null (undetermined) reply
          // is not a proven opponent loss, and !null is true in JS -
          // treating it as falsy here would silently count an unknown
          // reply as a winning move.
          if (jointDominoAware(nextNodes, oppDom, moverDom - 1, memo) === false) {
            moves.push({ componentIndex: i, type: "domino", cells, resultMask });
          }
        }
      }
    }
  } else {
    for (let i = 0; i < rawMasks.length; i++) {
      for (const m of zoneSolver._movesAt(rawMasks[i])) {
        const resultMask = rawMasks[i] & ~m;
        if (!verifyEach) {
          moves.push({ componentIndex: i, type: "classical", cells: zoneSolver.cellsOfMask(m), resultMask });
          continue;
        }
        const resultParts = buildComponentParts(zoneSolver, resultMask, buildMemo, maxComponentSize);
        const nextNodes = [...currentNodes.slice(0, i), ...resultParts, ...currentNodes.slice(i + 1)];
        if (jointDominoAware(nextNodes, oppDom, moverDom, memo) === false) {
          moves.push({ componentIndex: i, type: "classical", cells: zoneSolver.cellsOfMask(m), resultMask });
        }
      }
    }
  }

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
export function buildZoneDominoTable(zoneSolver, rawMasks, maxDominoes = 2, maxComponentSize) {
  const jointMemo = new Map();
  const buildMemo = new Map();
  const table = {};
  for (let m = 0; m <= maxDominoes; m++) {
    for (let o = 0; o <= maxDominoes; o++) {
      table[`${m},${o}`] = winningMoves(zoneSolver, rawMasks, m, o, jointMemo, buildMemo, maxComponentSize);
    }
  }
  return table;
}
