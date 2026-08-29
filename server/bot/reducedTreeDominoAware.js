import { fragmentLengthsOf } from "./fragmentExtractor.js";
import { solveResidual, _canonicalFragments } from "./dominoSolver.js";

// Shared, globally-memoized constants. A mask with nothing left behaves
// identically whether it's truly empty or a single dead cell (both have
// zero moves, and dominoSolver filters length-1 fragments anyway), so
// both collapse onto ONE object instead of one-per-distinct-mask.
const EMPTY_NODE = { leaf: true, fragments: [] };

// Verified directly (not just argued) for both sizes:
// - every non-collinear 3-cell connected blob is topologically an
//   L-tromino in some rotation - exactly one placement, using all 3
//   cells, zero left over.
// - every non-collinear 4-cell connected blob (square, L, T, S/Z
//   tetromino shapes all checked) has grundy 1, and every placement
//   leaves at most 1 dead cell - zero domino relevance either way.
// Both reduce to the exact same shape: grundy 1, one relevant child,
// that child is a dead end. One shared node covers all of them,
// regardless of which of the two sizes or which specific shape.
const SINGLE_MOVE_TO_EMPTY_NODE = { leaf: false, children: [EMPTY_NODE] };

// General structural sharing (hash-consing), beyond the two hand-picked
// cases above: after a node's children are built (already canonical,
// by induction, since children are always built before their parent),
// check whether a node with the exact same shape already exists
// somewhere - same leaf-ness, same grundy, same SET of canonical
// children (order doesn't matter, duplicates collapse) - and reuse it
// instead of keeping a second copy. This is exactly what makes
// SINGLE_MOVE_TO_EMPTY_NODE-style sharing safe in general, not just for
// the two sizes verified by hand: jointDominoAware only ever inspects
// leaf/grundy/children/fragments, so two nodes with identical values
// there are provably interchangeable in every context, not just the
// ones checked so far. Deliberately GLOBAL (module-level, not scoped
// per zone or per component): nothing about a node's behavior depends on
// which ZoneSolver instance or which zone produced it, so two unrelated
// zones that happen to reduce to the same shape share the saving too.
const canonicalRegistry = new Map();
function canonicalize(rawNode) {
  const key = rawNode.leaf
    ? `L:${rawNode.fragments.join(",")}`
    : `N:${[...new Set(rawNode.children.map(id))].sort((a, b) => a - b).join(",")}`;
  const existing = canonicalRegistry.get(key);
  if (existing) return existing;
  canonicalRegistry.set(key, rawNode);
  return rawNode;
}

function isCollinear(cells) {
  const rows = new Set(cells.map(([r]) => r));
  const cols = new Set(cells.map(([, c]) => c));
  return rows.size === 1 || cols.size === 1;
}

// Strips dead (isolated, size-1) components out of mask - they can
// never participate in any placement, so they only ever bloat the key
// two different masks use for what's really the same live state. Reuses
// the SAME _components() call to also report whether what's left is a
// single non-trivial (size >= 2) component, for the size-3/size-4 fast
// paths above.
function analyze(zoneSolver, mask) {
  const components = zoneSolver._components(mask);
  let stripped = mask;
  const liveComponents = [];
  for (const comp of components) {
    if (zoneSolver._popcount(comp) === 1) stripped &= ~comp;
    else liveComponents.push(comp);
  }
  return { stripped, liveComponents };
}

function buildTree(zoneSolver, mask, memo) {
  const cached = memo.get(mask);
  if (cached) return cached;
  if (mask === 0n) {
    memo.set(mask, EMPTY_NODE);
    return EMPTY_NODE;
  }

  const { stripped, liveComponents } = analyze(zoneSolver, mask);

  // A DIFFERENT raw mask may have already resolved to this exact
  // stripped form (same live structure, dead cells in different spots)
  // - if so, reuse it before doing any real work.
  if (stripped !== mask) {
    const strippedCached = memo.get(stripped);
    if (strippedCached) {
      memo.set(mask, strippedCached);
      return strippedCached;
    }
  }

  let node;
  if (stripped === 0n) {
    node = EMPTY_NODE;
  } else if (
    liveComponents.length === 1 &&
    [3, 4].includes(zoneSolver._popcount(stripped)) &&
    !isCollinear(zoneSolver.cellsOfMask(stripped))
  ) {
    node = SINGLE_MOVE_TO_EMPTY_NODE;
  } else {
    const moves = zoneSolver._movesAt(stripped);
    if (moves.length === 0) {
      const fragments = _canonicalFragments(fragmentLengthsOf(zoneSolver, stripped));
      node = canonicalize({ leaf: true, fragments });
    } else {
      const children = moves.map((m) => buildTree(zoneSolver, stripped & ~m, memo));
      node = canonicalize({ leaf: false, children });
    }
  }

  memo.set(mask, node);
  if (stripped !== mask) memo.set(stripped, node);
  return node;
}

export function buildComponentTree(zoneSolver, mask, memo = new Map()) {
  return buildTree(zoneSolver, mask, memo);
}

let nextId = 1;
const idOf = new WeakMap();
function id(node) {
  if (!idOf.has(node)) idOf.set(node, nextId++);
  return idOf.get(node);
}

// (moverDom, oppDom) instead of (domX, domY, moverIsX): no classical
// move ever spends a domino, so the two counts simply SWAP at each ply
// rather than needing a separate "whose turn" bit alongside two fixed,
// named-player totals. This also closes a real gap the old signature
// had - domino counts weren't part of the memo key at all before, which
// was harmless as long as one memo was only ever used for one (domX,
// domY) pair, but would have silently returned wrong cached results the
// moment a persistent memo got reused to build the table across several
// (M, M') values. Also compacts the space for a real reason, not just a
// smaller key: "X leads with 2 vs Y's 1" and "Y leads with 2 vs X's 1"
// are the same state now, since nothing in the game can tell X and Y
// apart except their counts.
export function jointDominoAware(nodeA, nodeB, moverDom, oppDom, memo = new Map()) {
  const key = `${id(nodeA)}|${id(nodeB)}|${moverDom}|${oppDom}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let result;
  if (nodeA.leaf && nodeB.leaf) {
    const fragments = [...nodeA.fragments, ...nodeB.fragments];
    result = solveResidual(fragments, moverDom, oppDom).win;
  } else {
    const options = [];
    if (!nodeA.leaf) for (const child of nodeA.children) options.push([child, nodeB]);
    if (!nodeB.leaf) for (const child of nodeB.children) options.push([nodeA, child]);

    result = false;
    for (const [newA, newB] of options) {
      const childWins = jointDominoAware(newA, newB, oppDom, moverDom, memo);
      if (!childWins) {
        result = true;
        break;
      }
    }
  }

  memo.set(key, result);
  return result;
}
