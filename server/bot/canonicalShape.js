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
// IMPORTANT - gates are strength dials, not just cost dials: maxBlobSize
// and maxComponentMoves exist to bound what a given caller is CAPABLE
// of, not merely how much it's willing to spend - different bot presets
// deliberately use different gate values to play at different
// strengths. So sharing is one-directional by construction: a cache
// entry may only ever be used by a caller whose own gate would already
// have permitted computing that same shape directly. This lets a caller
// skip REPEATED work within what it could already do, but never lets it
// borrow CAPABILITY - a small-gate caller must solve exactly what its
// own gate allows, nothing more, regardless of what a more generously-
// configured caller has already worked out. Both call sites enforce
// this themselves (checking their own gate before ever consulting the
// cache); this module only supplies the shared key and storage.
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

function compareNormalized(a, b) {
  // Numeric, element-by-element, short-circuits on the first
  // difference - a and b are always the same length (same cell count,
  // since these are 8 transforms of the same shape).
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0]) return a[i][0] - b[i][0];
    if (a[i][1] !== b[i][1]) return a[i][1] - b[i][1];
  }
  return 0;
}

// cells: array of [row, col] pairs - exactly what ZoneSolver.cellsOfMask()
// returns, so both engines can call this directly on their own mask
// without any format conversion. Order-independent and position-
// independent by construction (translate-to-origin happens per
// transform, before comparison), so callers never need to pre-sort or
// pre-normalize their input.
export function canonicalShapeKey(cells) {
  if (cells.length === 0) return "E";

  let bestArr = null;
  for (const transform of TRANSFORMS) {
    const transformed = cells.map(transform);
    let minR = Infinity;
    let minC = Infinity;
    for (const [r, c] of transformed) {
      if (r < minR) minR = r;
      if (c < minC) minC = c;
    }
    const normalized = transformed.map(([r, c]) => [r - minR, c - minC]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // Smallest across all 8 orientations - an arbitrary but fixed
    // tie-break, so every congruent shape agrees on exactly the same
    // representative regardless of which orientation happened to be
    // handed in first. Compared as arrays, not strings - only the
    // eventual winner ever gets serialized, below, instead of building
    // and then discarding 7 full strings every call.
    if (bestArr === null || compareNormalized(normalized, bestArr) < 0) bestArr = normalized;
  }
  return bestArr.map(([r, c]) => `${r},${c}`).join(";");
}

// canonicalKey -> Grundy number (zoneSolver.js's grundyOf). Only ever
// populated with a fully-computed result - see the "don't cache
// gate-caused gives-up" rule at the call site: a null caused by one
// particular caller's own maxBlobSize ceiling says nothing about the
// shape itself, so it must never be written here, only a real number.
// A number by itself carries its own eligibility: the caller already
// knows the shape's cell count before ever touching this cache, so
// checking "is this within MY OWN maxBlobSize" needs nothing extra
// stored alongside it.
export const canonicalGrundyCache = new Map();

// canonicalKey -> { node, requiredMoves } (reducedTreeDominoAware.js's
// buildTree). Same gate-caused-null rule: UNDETERMINED_NODE is never
// written here, only a fully-built node. Unlike the Grundy cache, a
// bare node isn't enough here - move count (the actual gate metric,
// not cell count) isn't free to know without recomputing _movesAt, so
// it's captured once at write time and compared cheaply at read time,
// letting the caller check "would MY OWN maxComponentMoves have
// allowed building this" without redoing the work the cache exists to
// avoid. requiredMoves is the shape's own root move count, which
// monotonically bounds every move count anywhere in its subtree -
// shrinking a mask can only remove legal placements, never add them.
export const canonicalTreeNodeCache = new Map();

// Test-only: both caches are intentionally persistent for the process
// lifetime (that's the whole point), but tests want a clean slate
// between unrelated cases.
export function _clearCanonicalCaches() {
  canonicalGrundyCache.clear();
  canonicalTreeNodeCache.clear();
}
