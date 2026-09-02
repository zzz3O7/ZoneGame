// A shape's outcome - both the classical Grundy number (zoneSolver.js)
// and the domino-aware win/loss tree (reducedTreeDominoAware.js) - never
// depends on WHERE on the board it sits or how it's rotated/mirrored,
// only on the relative adjacency of its open cells. Both engines already
// discover this fact independently and after-the-fact (zoneSolver has no
// mechanism for it at all; reducedTreeDominoAware's own canonicalize()
// gets there implicitly, but only once a subtree is already fully built,
// since a parent's structural key is computed from its children's ids -
// see that file). This module computes the SAME fact up front, from raw
// cell coordinates, so a shape congruent to one already solved can skip
// the recursive build entirely rather than being rediscovered as
// equivalent only after paying for it.
//
// One canonical-key function, shared by both engines, backing two
// separate global caches (the two engines store different kinds of
// result against the same key space) - this is what makes it one
// unified canonicalization system rather than two ad hoc ones: a shape
// solved via one engine and later encountered by the other still shares
// the SAME key derivation, even though the two caches themselves are
// necessarily separate (a Grundy number and a domino-aware tree node
// are different kinds of answer to different questions - see the
// zoneSolver.js / reducedTreeDominoAware.js discussion this came out
// of).
//
// Deliberately keyed on cell geometry alone, never on which ZoneSolver
// instance produced it - callers construct a fresh ZoneSolver for
// nearly every evaluation (see solverBot.js), so per-instance caching
// would rebuild the same shape's answer over and over across unrelated
// evaluations that happen to hit the identical shape. Global, persistent
// for the lifetime of the process, by design.

// All 8 symmetries of the square (4 rotations x mirror) - a superset of
// what any individual piece shape needs, applied here to the WHOLE
// open-cell region rather than to a single placement, which is the
// right level: the region's shape is what determines its outcome, not
// any one piece within it.
const TRANSFORMS = [
  ([r, c]) => [r, c],
  ([r, c]) => [-r, c],
  ([r, c]) => [r, -c],
  ([r, c]) => [-r, -c],
  ([r, c]) => [c, r],
  ([r, c]) => [-c, r],
  ([r, c]) => [c, -r],
  ([r, c]) => [-c, -r],
];

// cells: array of [row, col] pairs - exactly what ZoneSolver.cellsOfMask()
// returns, so both engines can call this directly on their own mask
// without any format conversion. Order-independent and position-
// independent by construction (translate-to-origin happens per
// transform, before comparison), so callers never need to pre-sort or
// pre-normalize their input.
// Below this many cells, computing an 8-transform canonical key costs
// more than just solving the shape directly - measured, not guessed:
// small shapes are also visited enormously more often than large ones
// (every recursive call in both engines produces many small leftover
// fragments deep in the tree, far more than it produces large ones), so
// paying even a small constant cost at every one of them adds up to
// real, measured overhead - see the perf tests this shipped with.
// Both engines share this constant rather than tuning their own -
// that's what makes this one canonicalization system rather than two.
export const CANONICAL_MIN_CELLS = 16;

export function canonicalShapeKey(cells) {
  if (cells.length === 0) return "E";

  let best = null;
  for (const transform of TRANSFORMS) {
    const transformed = cells.map(transform);
    let minR = Infinity;
    let minC = Infinity;
    for (const [r, c] of transformed) {
      if (r < minR) minR = r;
      if (c < minC) minC = c;
    }
    const normalized = transformed
      .map(([r, c]) => [r - minR, c - minC])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const serialized = normalized.map(([r, c]) => `${r},${c}`).join(";");
    // Lexicographically smallest across all 8 orientations - an
    // arbitrary but fixed tie-break, so every congruent shape agrees on
    // exactly the same representative regardless of which orientation
    // happened to be handed in first.
    if (best === null || serialized < best) best = serialized;
  }
  return best;
}

// canonicalKey -> Grundy number (zoneSolver.js's grundyOf). Only ever
// populated with a fully-computed result - see the "don't cache
// gate-caused gives-up" rule at both call sites: a null caused by one
// particular caller's own maxBlobSize ceiling says nothing about the
// shape itself, so it must never be written here, only a real number.
export const canonicalGrundyCache = new Map();

// canonicalKey -> tree node (reducedTreeDominoAware.js's buildTree).
// Same rule: UNDETERMINED_NODE (a caller's own maxComponentMoves
// ceiling firing) is never written here, only a fully-built node.
export const canonicalTreeNodeCache = new Map();

// Test-only: both caches are intentionally persistent for the process
// lifetime (that's the whole point), but tests want a clean slate
// between unrelated cases.
export function _clearCanonicalCaches() {
  canonicalGrundyCache.clear();
  canonicalTreeNodeCache.clear();
}
