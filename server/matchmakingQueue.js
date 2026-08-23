import {
  MATCHMAKING_TIME_MODES,
  MATCHMAKING_ANY_FALLBACK,
  MATCHMAKING_WINDOW_BASE_DEVIATION,
  MATCHMAKING_WINDOW_GROWTH_PER_SEC,
  MATCHMAKING_UNKNOWN_OPPONENT_SCORE,
} from "../shared/config.js";
import { winProbability } from "./rating.js";

const SPECIFIC_TIME_MODES = MATCHMAKING_TIME_MODES.filter((t) => t !== "any");

// Board presets are always "classic" for now (the only entry in MODES,
// and resolveParams() itself only recognizes "classic" vs "custom" — see
// shared/params.js) — so there's deliberately no board-preset dimension
// here yet. If a second preset is ever added to matchmaking, this needs a
// preset key alongside `rated` below; not building that ahead of need.
//
// Pairing is rating-aware (see shared/config.js's MATCHMAKING_WINDOW_*
// for the design). Entries carry `mu`/`sigma` when known (always for
// rated — guests can't reach rated at all; for unrated whenever the
// player is logged in) and `null` for guests. A `null` rating on either
// side of a pairing means there's nothing to compare on the usual scale,
// so that pairing is always acceptable — but see _matchScore for how a
// known-vs-guest pairing is still deprioritized behind a genuinely good
// rated match, without needing separate gating logic. Two guests pair
// with each other exactly like plain FIFO.
//
// Within a rated/unrated pool, each specific time mode has its own
// waiting list. "any" is a separate flexible pool: an "any" waiter can
// pair against any specific-mode waiter (inheriting their time control)
// or another "any" waiter (falling back to MATCHMAKING_ANY_FALLBACK,
// since neither side has a real preference to inherit). Matching happens
// both synchronously on join() and via a periodic sweep() — see
// server/index.js for the timer — since a waiting pair's acceptance
// window keeps widening even when nobody new joins.
export class MatchmakingQueue {
  constructor() {
    this.rated = this._emptyPool();
    this.unrated = this._emptyPool();
  }

  _emptyPool() {
    return { specific: new Map(SPECIFIC_TIME_MODES.map((mode) => [mode, []])), any: [] };
  }

  _poolFor(rated) {
    return rated ? this.rated : this.unrated;
  }

  // --- rating-aware acceptance -------------------------------------

  // How far from a coinflip (0.5 win probability) this entry currently
  // accepts, given how long it's been waiting. Widens linearly, capped
  // at 0.5 (accept literally anyone).
  _deviationFor(entry, now) {
    const waitedSec = Math.max(0, (now - entry.joinedAt) / 1000);
    return Math.min(0.5, MATCHMAKING_WINDOW_BASE_DEVIATION + MATCHMAKING_WINDOW_GROWTH_PER_SEC * waitedSec);
  }

  // Predicted deviation-from-coinflip for a specific pairing, or null
  // when either side has no known rating (guest) — nothing to compare.
  _pairDeviation(a, b) {
    if (a.mu == null || b.mu == null) return null;
    return Math.abs(winProbability({ muA: a.mu, sigmaA: a.sigma, muB: b.mu, sigmaB: b.sigma }) - 0.5);
  }

  _acceptable(a, b, now) {
    // Never match a player against themself (two guests are both
    // accountPlayerId === null, which must NOT count as "same identity").
    if (a.accountPlayerId != null && b.accountPlayerId != null && a.accountPlayerId === b.accountPlayerId) {
      return false;
    }
    const dev = this._pairDeviation(a, b);
    if (dev == null) return true; // guest involved on either side — nothing comparable, never block on it (see _matchScore for how it's deprioritized instead)
    // Require BOTH sides' currently-widened tolerance to cover the gap —
    // not just the more patient one. A long-waiting player who's willing
    // to accept anyone shouldn't be able to snap up someone who joined a
    // second ago into a match they'd never have agreed to on their own;
    // a fresh joiner gets their own base tolerance's grace period first.
    return dev <= Math.min(this._deviationFor(a, now), this._deviationFor(b, now));
  }

  // Lower is a better match. Two known-rated entries score their real
  // deviation-from-coinflip. Two guests (nothing comparable on either
  // side) score 0 — an instant, best-case match. A known-vs-guest pair
  // scores the fixed MATCHMAKING_UNKNOWN_OPPONENT_SCORE sentinel — see
  // shared/config.js for why: this makes a rated match win out whenever
  // one is actually good, while still letting a guest win out over a
  // genuinely bad rated matchup, all without any separate gating logic.
  _matchScore(a, b) {
    const aKnown = a.mu != null;
    const bKnown = b.mu != null;
    if (aKnown && bKnown) return this._pairDeviation(a, b);
    if (!aKnown && !bKnown) return 0;
    return MATCHMAKING_UNKNOWN_OPPONENT_SCORE;
  }

  // --- flat candidate view of a pool, for both join() and sweep() ------

  // Every waiting entry, tagged with the time mode it resolves to if
  // matched (null = flexible, i.e. an "any" waiter), plus a `remove`
  // closure so a match can pull it out of wherever it actually lives.
  _flatten(pool) {
    const out = [];
    for (const [mode, list] of pool.specific) {
      for (const entry of list) {
        out.push({ entry, mode, remove: () => this._removeFrom(list, entry) });
      }
    }
    for (const entry of pool.any) {
      out.push({ entry, mode: null, remove: () => this._removeFrom(pool.any, entry) });
    }
    return out;
  }

  _removeFrom(list, entry) {
    const i = list.indexOf(entry);
    if (i !== -1) list.splice(i, 1);
  }

  // Whether two flat candidates can share a time control: same specific
  // mode, or either is flexible. Returns the resolved mode, or null if
  // incompatible (two different specific modes).
  _resolveMode(descA, descB) {
    if (descA.mode && descB.mode) return descA.mode === descB.mode ? descA.mode : null;
    return descA.mode || descB.mode || MATCHMAKING_ANY_FALLBACK;
  }

  // Finds the best acceptable match for `selfDesc` among `candidates`
  // (both {entry, mode} shaped). Ties broken by longest wait.
  _bestAgainst(selfDesc, candidates, now) {
    let best = null;
    for (const cand of candidates) {
      if (cand.entry === selfDesc.entry) continue;
      const resolvedMode = this._resolveMode(selfDesc, cand);
      if (resolvedMode == null) continue; // incompatible time controls
      if (!this._acceptable(selfDesc.entry, cand.entry, now)) continue;
      const score = this._matchScore(selfDesc.entry, cand.entry);
      if (!best || score < best.score || (score === best.score && cand.entry.joinedAt < best.cand.entry.joinedAt)) {
        best = { cand, score, resolvedMode };
      }
    }
    return best;
  }

  // Returns [entryA, entryB, resolvedTimeMode] if joining completed a
  // pair, or null if this player is now waiting alone. resolvedTimeMode
  // is always one of SPECIFIC_TIME_MODES, never "any".
  join(ws, entryData, rated, timeMode) {
    this.leave(ws); // guard against a double JOIN_QUEUE queuing twice
    const pool = this._poolFor(rated);
    const now = Date.now();
    const self = { ws, ...entryData, joinedAt: now };
    const selfDesc = { mode: timeMode === "any" ? null : timeMode, entry: self };

    const candidates =
      timeMode === "any"
        ? this._flatten(pool) // an "any" joiner can pair against literally anyone waiting
        : [
            ...pool.any.map((entry) => ({ entry, mode: null, remove: () => this._removeFrom(pool.any, entry) })),
            ...pool.specific.get(timeMode).map((entry) => ({
              entry,
              mode: timeMode,
              remove: () => this._removeFrom(pool.specific.get(timeMode), entry),
            })),
          ];

    const match = this._bestAgainst(selfDesc, candidates, now);
    if (match) {
      match.cand.remove();
      return [self, match.cand.entry, match.resolvedMode];
    }

    if (timeMode === "any") pool.any.push(self);
    else pool.specific.get(timeMode).push(self);
    return null;
  }

  // Re-checks everyone still waiting for a now-acceptable pairing —
  // windows widen purely with elapsed time, so two players who were both
  // already waiting when they last joined might match now even though
  // neither has taken a new action since. Called on a timer (see
  // server/index.js), not from any player-triggered event.
  //
  // Greedy: repeatedly pulls the single best remaining pairing out of
  // each pool until none are left. O(n^3) worst case across a full
  // sweep, which is negligible at the queue sizes this game will see —
  // see design discussion for why this wasn't worth optimizing further.
  //
  // Returns an array of [entryA, entryB, resolvedTimeMode, rated] tuples.
  sweep(now = Date.now()) {
    const results = [];
    for (const rated of [true, false]) {
      const pool = this._poolFor(rated);
      for (;;) {
        const flat = this._flatten(pool);
        if (flat.length < 2) break;

        let best = null;
        for (let i = 0; i < flat.length; i++) {
          const candidate = this._bestAgainst(flat[i], flat, now);
          if (candidate && (!best || candidate.score < best.match.score)) {
            best = { self: flat[i], match: candidate };
          }
        }
        if (!best) break;

        best.self.remove();
        best.match.cand.remove();
        results.push([best.self.entry, best.match.cand.entry, best.match.resolvedMode, rated]);
      }
    }
    return results;
  }

  // Read-only introspection for the admin tool — a plain-object view of
  // both pools, safe to JSON-serialize (drops `ws`/`remove`, neither of
  // which means anything outside this class). Not used by any matching
  // logic itself, so it's fine for this to be O(n) and rebuilt on demand.
  snapshot(now = Date.now()) {
    const describeEntry = (entry) => ({
      nickname: entry.nickname,
      accountPlayerId: entry.accountPlayerId,
      mu: entry.mu,
      sigma: entry.sigma,
      joinedAt: entry.joinedAt,
      waitedMs: now - entry.joinedAt,
    });
    const describePool = (pool) => ({
      specific: Object.fromEntries([...pool.specific].map(([mode, list]) => [mode, list.map(describeEntry)])),
      any: pool.any.map(describeEntry),
    });
    return { rated: describePool(this.rated), unrated: describePool(this.unrated) };
  }

  leave(ws) {
    for (const pool of [this.rated, this.unrated]) {
      pool.any = pool.any.filter((e) => e.ws !== ws);
      for (const [mode, queue] of pool.specific) {
        pool.specific.set(
          mode,
          queue.filter((e) => e.ws !== ws),
        );
      }
    }
  }

  // Pulls out (and removes) any waiting entry that's been queued at
  // least maxWaitMs — regardless of whether sweep() could find it a
  // human pair. This is the seam the bot-fallback lock hangs off (see
  // docs/BOTS.md point 5): human pairing gets a fair shot first via
  // sweep(), and only an entry still unmatched after that ages out here.
  // Deliberately separate from sweep()'s pairing logic — this function
  // only reports staleness, the caller decides what a stale entry means.
  // Returns [entry, resolvedTimeMode, rated, remove] tuples;
  // resolvedTimeMode falls back to MATCHMAKING_ANY_FALLBACK for an
  // "any" waiter, same as a real any-vs-any pairing would. remove is
  // NOT called automatically — the caller only calls it once it's
  // actually going to do something with this entry (e.g. found a bot to
  // fall back to); if there's nothing to fall back to yet, the entry
  // needs to stay queued rather than vanish silently.
  expireStale(now, maxWaitMs) {
    const results = [];
    for (const rated of [true, false]) {
      const pool = this._poolFor(rated);
      for (const { entry, mode, remove } of this._flatten(pool)) {
        if (now - entry.joinedAt >= maxWaitMs) {
          results.push([entry, mode || MATCHMAKING_ANY_FALLBACK, rated, remove]);
        }
      }
    }
    return results;
  }
}
