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

// Below this many cells, there's nothing worth caching in the first
// place regardless of overhead - the smallest placeable piece is a
// 2-cell domino, so a 0-1 cell fragment has no legal moves and is
// already an O(1) check. This was previously set to 16 on the theory
// that canonicalizing cost more than solving below that point - real
// hit/miss/timing data (see docs/TODO's dtest recovery + the
// CANONICAL_MIN_CELLS investigation) disproved that: measured
// canonicalization overhead stayed in single-digit microseconds across
// the entire 0-24 cell range tested, while even the cheapest misses
// cost 10-100x that. There's no measured crossover in that range - this
// constant is now just "don't bother with zero-move shapes", not a
// performance tradeoff.
export const CANONICAL_MIN_CELLS = 4;

// Above this many cells, a shape essentially never recurs ACROSS games
// (only within one game's own recursive exploration) - measured
// directly: hit rate stayed ~74-81% for <20-cell shapes regardless of
// cold/warm start, but sat flat at ~10% for 20-24-cell shapes whether
// the cache was empty or already held 170k+ entries from a prior
// cycle. The number of distinct possible shapes grows too fast with
// cell count (roughly 4x per additional cell) for two different
// procedurally-generated boards to produce an exact congruent match by
// chance. So shapes at/above this size go in canonicalGrundyCacheLarge
// instead of canonicalGrundyCache below - real reuse within their own
// game, no reuse worth keeping beyond it. Tree side isn't partitioned
// yet - no equivalent measurement exists there (needs a tree-capable
// bot active in self-play first); the same experiment should be
// repeated for move-count before assuming this same cell-count
// boundary or value applies.
export const CANONICAL_LARGE_SHAPE_CELLS = 20;

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

// Same key space, same value type as canonicalGrundyCache above, but
// NOT kept beyond one game (see clearLargeCanonicalCaches below, called
// once per finished game). Holds shapes at/above
// CANONICAL_LARGE_SHAPE_CELLS - still worth caching for the real reuse
// that happens within a single game's own recursive exploration, but
// measured to have negligible reuse ACROSS games, so keeping them
// around for a whole process's lifetime (which is what
// canonicalGrundyCache does) would just be memory cost with no return -
// see CANONICAL_LARGE_SHAPE_CELLS above for the actual numbers. A
// version of this cache also briefly persisted BOTH partitions to disk
// (canonicalCacheStore.js, since removed) - measured benefit there
// capped at roughly one self-play cycle's worth of warm-up regardless
// of how large the file grew, while the file itself grew ~10MB/game
// with no reason to expect that to slow down once tree-cache entries
// (heavier per row than a single grundy integer) start populating it
// too. Not worth it; removed rather than kept for a fixed, small,
// non-compounding return.
export const canonicalGrundyCacheLarge = new Map();

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

// Same key space and value shape as canonicalTreeNodeCache above, but
// NOT kept beyond one game - mirrors canonicalGrundyCacheLarge, and for
// the same reason: partitioned on the same CANONICAL_LARGE_SHAPE_CELLS
// cell-count gate already used to decide useCanonical in the first
// place (not on move count, even though move count is what the
// hit/miss buckets below report cost against - that's a reporting
// choice, this is a routing one, and reusing the existing gate keeps
// there being exactly one "is this shape big" signal rather than two
// unreconciled ones). Untested for the tree side specifically - this is
// a reasonable starting point given it's the same underlying shape
// diversity problem as the grundy cache, not a re-derived boundary.
export const canonicalTreeNodeCacheLarge = new Map();

// Test-only: both caches are intentionally persistent for the process
// lifetime (that's the whole point), but tests want a clean slate
// between unrelated cases.
export function _clearCanonicalCaches() {
  canonicalGrundyCache.clear();
  canonicalGrundyCacheLarge.clear();
  canonicalTreeNodeCache.clear();
  canonicalTreeNodeCacheLarge.clear();
}

// Production use (unlike the test-only reset above): discards
// everything in the large/ephemeral caches. Called once per finished
// game - self-play, directly inside botWorker.js's playSelfPlayGame
// (same thread, no plumbing needed); live matches, via a dedicated job
// from playerAgent.js's BotAgent._onGameOver (see botWorkerClient.js).
// Never touches canonicalGrundyCache or canonicalTreeNodeCache - those
// stay for the process's life, that's the whole small/large split.
// canonicalRegistry and globalJointMemo (reducedTreeDominoAware.js) are
// a separate, ungated concern - see clearEphemeralTreeCaches there.
export function clearLargeCanonicalCaches() {
  canonicalGrundyCacheLarge.clear();
  canonicalTreeNodeCacheLarge.clear();
}

// --- Hit/miss/timing stats -------------------------------------------
//
// CANONICAL_MIN_CELLS above was tuned once, empirically, against perf
// tests that never made it into git (see docs/TODO) - this is that
// measurement again, properly this time, against real running traffic
// instead of a synthetic benchmark: how often a shape ACTUALLY recurs
// in real self-play (recurrence rate isn't a property of the solver,
// it's a property of what boards/bots produce). This same
// instrumentation is also what showed CANONICAL_LARGE_SHAPE_CELLS's
// boundary and, previously, that a persisted disk cache (since removed)
// wasn't worth its cost - see that constant's comment above.
//
// zoneSolver.js and reducedTreeDominoAware.js call the record* functions
// below at their own cache-read/write sites - this module only owns the
// counters and bucketing, not the timing itself (each caller already has
// the tightest possible window around its own key-computation and
// solve/build work, and duplicating that logic here would just be
// further away from what it's timing).
//
// Bucketed rather than a single average because the two things this is
// trying to find - "is canonicalization overhead worth it at the
// threshold" and "how much does a hit save" - both vary by size, and
// averaging across sizes hides exactly the crossover point being looked
// for.
function bucketLabel(n, edges) {
  for (let i = 0; i < edges.length; i++) {
    if (n < edges[i]) return i === 0 ? `<${edges[i]}` : `${edges[i - 1]}-${edges[i] - 1}`;
  }
  return `${edges[edges.length - 1]}+`;
}

function addToBucket(buckets, label, timeMs) {
  const b = buckets[label] ?? (buckets[label] = { count: 0, timeMs: 0 });
  b.count++;
  b.timeMs += timeMs;
}

// Hits have no meaningful "time" (a Map.get, not worth timing
// separately from avgKeyTimeMs) - count-only bucket, so the stats
// output doesn't carry a confusing always-zero timeMs field.
function addCountToBucket(buckets, label) {
  buckets[label] = (buckets[label] ?? 0) + 1;
}

// Grundy buckets by CELL COUNT - that's what maxBlobSize gates on, and
// what zoneSolver.js's own comments describe the gate in terms of.
const GRUNDY_BUCKET_EDGES = [12, 16, 20, 25];
// Tree buckets by MOVE COUNT, not cell count - reducedTreeDominoAware.js
// is explicit that build cost tracks moves.length (branching factor),
// not cell count, so bucketing by cells here would hide the real signal.
const TREE_BUCKET_EDGES = [5, 10, 20, 40, 80];

function freshStats() {
  return {
    grundy: { hits: 0, misses: 0, keyTimeMs: 0, keyCalls: 0, hitBuckets: {}, solveBuckets: {} },
    tree: { hits: 0, misses: 0, gateRejected: 0, keyTimeMs: 0, keyCalls: 0, hitBuckets: {}, buildBuckets: {} },
  };
}

let stats = freshStats();

export function recordGrundyKeyTime(ms) {
  stats.grundy.keyTimeMs += ms;
  stats.grundy.keyCalls++;
}
// cells: this shape's own size, so hit rate can be read out per bucket
// alongside the existing miss-side solveBuckets - that comparison is
// the actual point (where does hit rate fall off, not just how
// expensive a miss is at that size).
export function recordGrundyHit(cells) {
  stats.grundy.hits++;
  addCountToBucket(stats.grundy.hitBuckets, bucketLabel(cells, GRUNDY_BUCKET_EDGES));
}
export function recordGrundyMiss(cells, solveMs) {
  stats.grundy.misses++;
  addToBucket(stats.grundy.solveBuckets, bucketLabel(cells, GRUNDY_BUCKET_EDGES), solveMs);
}

export function recordTreeKeyTime(ms) {
  stats.tree.keyTimeMs += ms;
  stats.tree.keyCalls++;
}
// moves: the cached entry's own requiredMoves (see reducedTreeDominoAware.js) -
// free to read on a hit, no extra work needed to get it.
export function recordTreeHit(moves) {
  stats.tree.hits++;
  addCountToBucket(stats.tree.hitBuckets, bucketLabel(moves, TREE_BUCKET_EDGES));
}
// moves: the shape's own move count (see reducedTreeDominoAware.js -
// this is what determines build cost, not cell count).
export function recordTreeMiss(moves, buildMs) {
  stats.tree.misses++;
  addToBucket(stats.tree.buildBuckets, bucketLabel(moves, TREE_BUCKET_EDGES), buildMs);
}
// A cache entry existed but THIS caller's own maxComponentMoves gate
// rejected it (see the strength-dial rule above) - distinct from a true
// miss: it means a more generously-gated caller already solved this
// shape, this caller just isn't allowed to use that answer. Still pays
// full rebuild cost, so still bucketed alongside true misses on the
// build-time side, just counted separately.
export function recordTreeGateRejected(moves, buildMs) {
  stats.tree.gateRejected++;
  addToBucket(stats.tree.buildBuckets, bucketLabel(moves, TREE_BUCKET_EDGES), buildMs);
}

// Snapshot + reset, meant to be called once per reporting period (e.g.
// once per self-play cycle) rather than polled continuously - a period
// boundary is what makes "misses this period" a meaningful rate rather
// than a since-process-start total that gets harder to read over time.
// Cache sizes themselves are NOT reset (they're just Map.size, not a
// counter this module owns resetting).
export function getAndResetCanonicalCacheStats() {
  const snapshot = {
    grundy: {
      cacheSize: canonicalGrundyCache.size,
      cacheSizeLarge: canonicalGrundyCacheLarge.size,
      hits: stats.grundy.hits,
      misses: stats.grundy.misses,
      hitRate:
        stats.grundy.hits + stats.grundy.misses > 0
          ? stats.grundy.hits / (stats.grundy.hits + stats.grundy.misses)
          : null,
      avgKeyTimeMs: stats.grundy.keyCalls > 0 ? stats.grundy.keyTimeMs / stats.grundy.keyCalls : null,
      totalKeyTimeMs: stats.grundy.keyTimeMs,
      hitBuckets: stats.grundy.hitBuckets,
      solveBuckets: stats.grundy.solveBuckets,
    },
    tree: {
      cacheSize: canonicalTreeNodeCache.size,
      cacheSizeLarge: canonicalTreeNodeCacheLarge.size,
      hits: stats.tree.hits,
      misses: stats.tree.misses,
      gateRejected: stats.tree.gateRejected,
      hitRate:
        stats.tree.hits + stats.tree.misses + stats.tree.gateRejected > 0
          ? stats.tree.hits / (stats.tree.hits + stats.tree.misses + stats.tree.gateRejected)
          : null,
      avgKeyTimeMs: stats.tree.keyCalls > 0 ? stats.tree.keyTimeMs / stats.tree.keyCalls : null,
      totalKeyTimeMs: stats.tree.keyTimeMs,
      hitBuckets: stats.tree.hitBuckets,
      buildBuckets: stats.tree.buildBuckets,
    },
  };
  stats = freshStats();
  return snapshot;
}

// Test-only, mirrors _clearCanonicalCaches.
export function _resetCanonicalCacheStats() {
  stats = freshStats();
}
