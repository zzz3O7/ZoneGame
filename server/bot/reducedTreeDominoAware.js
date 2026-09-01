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
// Both reduce to the exact same shape: one possible move, leaving
// exactly one live remaining piece (none - it's empty). One shared node
// covers all of them, regardless of which of the two sizes or which
// specific shape. children is an array of arrays (see buildParts below
// for why): one move, resulting in one live part, which is EMPTY_NODE.
const SINGLE_MOVE_TO_EMPTY_NODE = { leaf: false, children: [[EMPTY_NODE]] };

// A component too large to build a tree for at all - the domino-aware
// analogue of the classical solver's own grundyOf() returning null past
// maxBlobSize. Genuinely necessary: this engine dropped grundyOf
// entirely once node.grundy turned out to be redundant for
// canonicalization, which silently also dropped the only path
// maxBlobSize's protection reached through - buildTree has no size gate
// of its own without this. Measured directly: a single 24-cell solid
// blob took ~4.6s to build, 28 cells didn't finish in 30s, and larger
// components with real internal structure (not just solid rectangles)
// measured up to 38s at 28 cells with one case not finishing in 90s -
// the same shape of blowup maxBlobSize exists to prevent, just for this
// engine's own recursion instead of grundyOf's.
//
// Deliberately NOT leaf and NOT given real children - jointDominoAware
// treats this as neither "known to be a pure domino residual" nor
// "known to have enumerable classical moves", just "unknown", and
// propagates that rather than guessing. A domino-count-majority guess
// was considered and rejected: verified directly that some very
// ordinary shapes (plain rectangles - 3x4, 3x5, 4x5, all comfortably
// smaller than maxComponentSize's default) have their outcome decided
// ENTIRELY by classical structure, independent of domino count even at
// a 7-vs-1 edge - a 3x5 rectangle loses for the domino-majority side at
// every domino combination tested, including equal. Whether "big
// enough" components reliably favor domino count too is genuinely
// unclear - some larger irregular shapes tested did show the pattern,
// but confirming it at the sizes where this gate actually fires would
// require solving those sizes exactly, which is the exact computation
// this gate exists to avoid. Given a wrong confident guess is worse
// than an honest "unknown" here, this stays conservative.
const UNDETERMINED_NODE = { leaf: false, undetermined: true, children: [] };

// Below this cell count, buildTree's own recursion (hash-consing aside)
// stays fast; above it, the measurements above apply. Deliberately
// matches the classical solver's own maxBlobSize default for
// consistency, not because the two costs are identical - it's a
// reasonable starting point, tune independently if real gameplay data
// suggests otherwise.
const DEFAULT_MAX_COMPONENT_SIZE = 12;

// General structural sharing (hash-consing), beyond the two hand-picked
// cases above: after a node's children are built (already canonical,
// by induction, since children are always built before their parent),
// check whether a node with the exact same shape already exists
// somewhere - same leaf-ness, same SET of canonical children (order
// doesn't matter, duplicates collapse) - and reuse it instead of
// keeping a second copy. This is exactly what makes
// SINGLE_MOVE_TO_EMPTY_NODE-style sharing safe in general, not just for
// the two sizes verified by hand: jointDominoAware only ever inspects
// leaf/children/fragments, so two nodes with identical values there are
// provably interchangeable in every context, not just the ones checked
// so far. Deliberately GLOBAL (module-level, not scoped per zone or per
// component): nothing about a node's behavior depends on which
// ZoneSolver instance or which zone produced it, so two unrelated zones
// that happen to reduce to the same shape share the saving too.
//
// Each entry in children is itself an ARRAY of parts (one move can
// leave behind more than one live piece - see buildParts), so the key
// for one move is the SORTED ids of its parts joined together (order
// among a single move's own parts doesn't matter either), and the outer
// key collapses moves that lead to the identical set of parts the same
// way the old single-node version collapsed moves leading to the
// identical single node.
const canonicalRegistry = new Map();
function canonicalize(rawNode) {
  const key = rawNode.leaf
    ? `L:${rawNode.fragments.join(",")}`
    : `N:${[...new Set(rawNode.children.map((parts) => parts.map(id).sort((a, b) => a - b).join("-")))].sort().join(",")}`;
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

// A move's result isn't always one connected shape. Removing a
// tromino/tetromino from the "waist" of a shape can sever it into two
// or more disjoint pieces - still governed by the SAME zone's shared
// local turn (a move in either resulting piece is available to
// whoever holds it), so this is exactly the same relationship the
// top-level N-component array already models, just discovered one
// level deeper instead of handed in from outside.
//
// Before this, a post-split mask fell through to buildTree's general
// branch and got treated as ONE flat combined shape via _movesAt on the
// whole thing - correct, since _movesAt/_components already handle
// multi-piece masks, but it forfeits exactly the caching benefit
// separate per-piece trees exist for, at precisely the point where a
// big connected blob turns into several smaller ones - the same
// direction that was already shown to be far cheaper (24 cells: 129
// joint-memo entries at N=2 vs 7 at N=6). So a split happening deeper
// in the tree used to get none of that benefit; now it does, uniformly,
// at whatever depth it actually occurs.
//
// Returns an array of 1+ nodes: one per live piece remaining, or
// [EMPTY_NODE] if mask is empty or only dead (isolated, size-1) cells
// are left. Always decomposing this way - even in the ordinary
// "no split happened" case, where this just returns a 1-element array -
// keeps the representation uniform: a move's result is always an array
// of parts, never sometimes-a-node-sometimes-an-array.
function buildParts(zoneSolver, mask, memo, maxComponentSize) {
  if (mask === 0n) return [EMPTY_NODE];
  const live = zoneSolver._components(mask).filter((c) => zoneSolver._popcount(c) > 1);
  if (live.length === 0) return [EMPTY_NODE];
  return live.map((comp) => buildTree(zoneSolver, comp, memo, maxComponentSize));
}

function buildTree(zoneSolver, mask, memo, maxComponentSize) {
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
    // Checking current move availability, and (if there are none)
    // extracting fragment lengths, are both cheap linear walks over
    // this specific mask - neither is what the size gate below needs
    // to guard against. Only exploring FUTURE structure via buildParts
    // is the expensive, potentially-exponential part. So a component
    // that has ALREADY exhausted its classical moves gets resolved
    // exactly here regardless of size - dominoSolver's own capacity
    // fast path already handles arbitrarily many fragments cheaply
    // (see dominoSolver.js and Note 1: the hard 9x9 zone cap means
    // there's no realistic case that fast path doesn't cover). The
    // gate only actually fires for a component that STILL has
    // classical moves and is too large to explore further.
    const moves = zoneSolver._movesAt(stripped);
    if (moves.length === 0) {
      const fragments = _canonicalFragments(fragmentLengthsOf(zoneSolver, stripped));
      node = canonicalize({ leaf: true, fragments });
    } else if (zoneSolver._popcount(stripped) > maxComponentSize) {
      node = UNDETERMINED_NODE;
    } else {
      const children = moves.map((m) => buildParts(zoneSolver, stripped & ~m, memo, maxComponentSize));
      node = canonicalize({ leaf: false, children });
    }
  }

  memo.set(mask, node);
  if (stripped !== mask) memo.set(stripped, node);
  return node;
}

export function buildComponentTree(zoneSolver, mask, memo = new Map(), maxComponentSize = DEFAULT_MAX_COMPONENT_SIZE) {
  return buildTree(zoneSolver, mask, memo, maxComponentSize);
}

// External equivalent of buildParts, for callers (jointMoveGenerator.js)
// that need the same split-aware decomposition for a move's result but
// can't safely reuse a canonical node's .children to get it (see that
// file's own comment on why: a shared node's children only correspond
// to a SPECIFIC mask's moves for whichever mask originally built it).
export function buildComponentParts(zoneSolver, mask, memo = new Map(), maxComponentSize = DEFAULT_MAX_COMPONENT_SIZE) {
  return buildParts(zoneSolver, mask, memo, maxComponentSize);
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
// `nodes` is an unordered collection, not a fixed pair: which array slot
// a component sits in has no bearing on the game, only which components
// remain and what shape each one is. So the memo key sorts the ids
// rather than trusting array order - without that, "move in component 0
// then component 2" and "move in component 2 then component 0" reach
// the identical resulting state but would never share a cache entry,
// and that duplication only gets worse as N grows (up to N! ways to
// reach the same state). This also fixes a real (if minor) inefficiency
// the old fixed-pair version had: jointDominoAware(X, Y, ...) and
// jointDominoAware(Y, X, ...) used to be different memo entries for the
// same state; sorting collapses them into one.
//
// An empty array falls out correctly with no special-casing: every() on
// [] is vacuously true, fragments is [], and solveResidual already
// returns win:false for an empty fragment list - so a zone with zero
// live components just correctly reports "mover loses" without this
// function needing to know that's a degenerate case.
// Global by default, unlike buildMemo in buildComponentTree - and safe
// to be, for a different reason than canonicalRegistry's "shape is
// shape regardless of zone" argument, though it lands in the same
// place: a key here is (sorted canonical node ids, moverDom, oppDom).
// Node ids are only ever assigned to nodes that already went through
// canonicalize(), so two unrelated zones producing the "same" shape
// were already sharing one node object before id() ever saw it - the
// id is just a stable label for that already-shared identity. A cached
// win/loss result under that id is correct forever, independent of
// which zone or which ZoneSolver instance the shape came from, so
// there's no analogue here of the raw-mask hazard buildMemo has (see
// buildComponentTree/buildTree - THAT one must stay per-call/explicit,
// since a raw mask only means something relative to one specific
// ZoneSolver's own cell-to-bit assignment, and the bot constructs a
// fresh ZoneSolver for nearly every evaluation - see solverBot.js -
// so there isn't even a stable instance to key persistence off of).
// A caller can still pass its own memo (every existing call site does,
// for test isolation) - this only changes what happens when one isn't
// supplied.
const globalJointMemo = new Map();
// Three return values now, not two: true (proven win), false (proven
// loss - every reachable state was fully determined and none of them
// leave the opponent losing), or null (undetermined - see
// UNDETERMINED_NODE). Priority order matters and is deliberate: a
// PROVEN win anywhere wins outright, even if some other, unexplored
// branch is undetermined - we don't need to know what an unrelated
// oversized component would have done once we've already found a
// concrete way to win. Only when no proven win exists AND at least one
// branch was undetermined does the overall result become null instead
// of a confident false - a component we truly know nothing about might
// have hidden a winning option we couldn't see, so "definitely a loss"
// would be an overclaim; "unknown" is the honest answer. This exactly
// mirrors the classical solver's own grundyOf() convention (any
// undetermined branch makes the combined value unknown), just refined
// to not let an unrelated unknown erase an already-proven win.
export function jointDominoAware(nodes, moverDom, oppDom, memo = globalJointMemo) {
  // An undetermined node already present in `nodes` can never be
  // removed by any move made from here - moves only ever replace a
  // DIFFERENT array slot (see the splice below), never the undetermined
  // one itself, since it has no children to move into. So it persists
  // through every reachable continuation from this state onward. By
  // induction, any such continuation's own recursive check would ALSO
  // immediately hit this same fact and return null - meaning exploring
  // further from here can only ever rediscover null, never a proven
  // true or false. Returning null immediately is therefore exactly
  // equivalent to doing that exploration, just without the wasted work.
  // (This is specific to a component that's undetermined because it
  // still has classical moves - domino moves require every component
  // simultaneously exhausted, so as long as this one persists, that
  // condition can never be confirmed for anyone, anywhere in the zone.)
  if (nodes.some((n) => n.undetermined)) return null;

  const key = `${nodes.map(id).sort((a, b) => a - b).join(",")}|${moverDom}|${oppDom}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let result = false;
  let sawUndetermined = nodes.some((n) => n.undetermined);

  if (!sawUndetermined && nodes.every((n) => n.leaf)) {
    const fragments = nodes.flatMap((n) => n.fragments);
    result = solveResidual(fragments, moverDom, oppDom).win;
  } else {
    outer: for (let i = 0; i < nodes.length; i++) {
      // An undetermined node contributes no explorable moves - we
      // simply don't know them - so it's skipped exactly like a leaf
      // would be here; the difference (leaf vs. genuinely unknown) is
      // what sawUndetermined, set above, already captures.
      if (nodes[i].leaf || nodes[i].undetermined) continue;
      for (const childParts of nodes[i].children) {
        const next = [...nodes.slice(0, i), ...childParts, ...nodes.slice(i + 1)];
        const reply = jointDominoAware(next, oppDom, moverDom, memo);
        if (reply === null) {
          sawUndetermined = true;
          continue;
        }
        if (!reply) {
          result = true;
          break outer;
        }
      }
    }
    if (!result && sawUndetermined) result = null;
  }

  memo.set(key, result);
  return result;
}
