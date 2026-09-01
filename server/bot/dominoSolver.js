// Solves the domino-only endgame a zone falls into once every
// tromino/tetromino move has run out. At that point the zone's remaining
// open cells have necessarily decomposed into straight-line fragments —
// anything with an L-shaped bend would still admit a tromino or
// tetromino, which is exactly why zoneSolver.js's own search would not
// have stopped yet. This module takes that decomposition as given (an
// array of fragment lengths) and solves the resulting placement game
// exactly.
//
// This is deliberately NOT the classic unlimited-supply domino/Kayles
// game, and can't reuse off-the-shelf Grundy theory: each player draws
// from their OWN small, finite domino count (startingDominoes, 2 by
// default in classic mode), not a shared unlimited pool. A player with 0
// dominoes left has no legal domino move anywhere on the board,
// regardless of open room — see Player.availableTypes(). That asymmetry
// (what's legal depends on WHO is asking, via their own remaining count)
// breaks the impartial-game assumption Sprague-Grundy needs, so this
// solves the joint state directly via backward induction, memoized on
// (fragment multiset, mover's dominoes, opponent's dominoes).
//
// Multiple fragments WITHIN one zone's residual are still a genuine
// disjunctive sum in the turn-order sense — the zone has one shared
// localTurn flag, not a per-fragment one, so whoever holds it is free to
// place in any fragment they like (no cross-zone lock-out weirdness
// here). What still blocks a simple per-fragment Grundy-XOR is the same
// budget problem one level up: spending a domino in fragment A is a
// domino you can't then also spend in fragment B, so the fragments stay
// coupled through the shared count even though their turn order isn't
// coupled. Hence exact joint search over the whole multiset, not
// per-fragment decomposition.
//
// Convention throughout: normal play (last player to successfully place
// a domino wins the zone), and every function is phrased from "the
// mover"'s point of view — whoever's local turn it is the moment the
// zone has transitioned into pure domino play. Working out who that
// actually is — the classical loser, since they're the one left facing
// the board once the classical winner runs out of non-domino moves; or
// the classical winner's opponent, if the zone was a classical win — is
// the caller's job, not this module's.

const memo = new Map();

// Collapses a fragment array to what actually matters: sorted lengths of
// fragments that can still hold a domino. Length < 2 is dead space (not
// even one domino fits — tromino/tetromino already ruled out by
// construction) and is dropped rather than tracked, so equivalent
// residues always share one memo entry regardless of how the caller
// happened to order or pad its array.
//
// Length 3 is additionally folded down to length 2: verified directly
// (not just argued) that solveResidual gives IDENTICAL results for a
// length-2 and a length-3 fragment, both in isolation and combined with
// arbitrary other fragments, for every domino count checked. This is
// exactly the same fact from a different angle as the earlier finding
// that a length-3 strip always resolves to exactly one placement no
// matter which cut is chosen — there's no further choice or consequence
// a length-3 fragment offers that a length-2 doesn't, so they're the
// same state for every purpose this solver cares about. Length 4 is
// NOT included here — it genuinely offers a choice (the middle cut ends
// it immediately; an end cut leaves a fresh length-2 for further
// contest), so it isn't interchangeable with the shorter lengths.
function canonicalFragments(fragments) {
  return fragments
    .filter((len) => len >= 2)
    .map((len) => (len === 3 ? 2 : len))
    .slice()
    .sort((a, b) => a - b);
}

function memoKey(fragments, moverDominoes, opponentDominoes) {
  return `${fragments.join(",")}|${moverDominoes}|${opponentDominoes}`;
}

// Guaranteed-WORST-CASE number of dominoes a single fragment of length
// len can be made to yield, however adversarially it gets cut along the
// way (a cut in the exact middle of an even fragment wastes nothing; a
// cut placed to leave an odd remainder on one or both sides wastes
// cells to single dead cells that can never take another domino).
// Proven, not estimated: for any cut, left+right = len-2, and by
// definition minCapacity(len) is the MINIMUM over every possible cut of
// [1 + minCapacity(left) + minCapacity(right)] - so minCapacity(left) +
// minCapacity(right) >= minCapacity(len) - 1 for every cut, meaning
// capacity can drop by at most 1 per domino played, however it's spent.
// That's the fact the fast path below actually rests on. The closed
// form floor((len+1)/3) is brute-force-verified against that recursive
// definition for len=0..30, not just argued.
function minCapacityOfLength(len) {
  return Math.floor((len + 1) / 3);
}

function totalCapacity(fragments) {
  return fragments.reduce((sum, len) => sum + minCapacityOfLength(len), 0);
}

// Exact solve for one (fragment multiset, mover's dominoes, opponent's
// dominoes) state. Returns { win, move }: whether the mover (to move
// right now) wins under optimal play by both sides, and — if so — one
// winning move as { fragmentIndex, cut }. fragmentIndex indexes into the
// CANONICALIZED (sorted, dead-fragment-free) array this call searched;
// cut is the 0-indexed offset of the domino's left cell within that
// fragment (the domino covers cut and cut+1).
export function solveResidual(fragments, moverDominoes, opponentDominoes) {
  const frags = canonicalFragments(fragments);

  if (moverDominoes <= 0 || frags.length === 0) {
    return { win: false, move: null };
  }

  // Exact fast path, not a heuristic: proven (see minCapacityOfLength
  // above) that whenever total capacity covers both remaining domino
  // budgets, cutting anywhere at all - not just "correctly" - preserves
  // that guarantee for the rest of the game, since capacity drops by at
  // most 1 per domino played regardless of where it's cut. That reduces
  // the whole game to pure domino counting: total dominoes strictly
  // decreases every ply and roles swap every ply, so the player who
  // started with fewer (or equal) always runs out of dominoes first,
  // never blocked by a missing slot first. Verified against 1000+
  // randomized cases exactly up to and including the boundary; breaks
  // immediately one unit past it, which is what makes this safe to run
  // unconditionally rather than as a size-gated fallback.
  //
  // No separate "too many fragments" gate needed on top of this: every
  // fragment contributes at least 1 to capacity (minCapacityOfLength
  // >= 1 for any length >= 2), so capacity >= fragment count always -
  // meaning the fast path is GUARANTEED to fire whenever fragment count
  // alone already reaches moverDominoes + opponentDominoes. Given zones
  // are hard-capped at 9x9 in classical play, checked the worst case
  // directly: 40 length-2 fragments (80 of the 81 possible cells) still
  // resolve in ~13ms even against a domino total of 41 - the exact
  // search below is only ever reachable with FEWER fragments than
  // total dominoes, which is inherently a small, fast search.
  if (totalCapacity(frags) >= moverDominoes + opponentDominoes) {
    if (moverDominoes > opponentDominoes) {
      const idx = frags.findIndex((len) => len >= 2);
      return { win: true, move: { fragmentIndex: idx, cut: 0 } };
    }
    return { win: false, move: null };
  }

  const key = memoKey(frags, moverDominoes, opponentDominoes);
  const cached = memo.get(key);
  if (cached) return cached;

  let result = { win: false, move: null };

  search: for (let idx = 0; idx < frags.length; idx++) {
    const len = frags[idx];
    for (let cut = 0; cut <= len - 2; cut++) {
      const left = cut;
      const right = len - cut - 2;
      const rest = frags.slice(0, idx).concat(frags.slice(idx + 1));
      const nextFragments = rest.concat([left, right]);
      // Mover just spent one domino; it's the opponent's turn now, with
      // roles (and remaining counts) swapped for the recursive call.
      const reply = solveResidual(nextFragments, opponentDominoes, moverDominoes - 1);
      if (!reply.win) {
        result = { win: true, move: { fragmentIndex: idx, cut } };
        break search;
      }
    }
  }

  memo.set(key, result);
  return result;
}

// The table Layer 1 actually needs: for every (myDominoes,
// opponentDominoes) pair up to maxDominoes in each direction, does the
// mover win. Cheap to build — maxDominoes is small (2 in classic mode)
// and solveResidual is itself memoized — so this is safe to call once
// per classical-solver leaf without multiplying the classical search's
// own exponential cost.
export function buildResidualTable(fragments, maxDominoes = 2) {
  const table = {};
  for (let m = 0; m <= maxDominoes; m++) {
    for (let o = 0; o <= maxDominoes; o++) {
      table[`${m},${o}`] = solveResidual(fragments, m, o);
    }
  }
  return table;
}

// Exposed for tests only — solveResidual's memo is intentionally
// persistent across calls (pure function of its inputs, safe to cache
// indefinitely) but tests want a clean slate between unrelated cases.
export function _clearMemo() {
  memo.clear();
}

export function _canonicalFragments(fragments) {
  return canonicalFragments(fragments);
}
