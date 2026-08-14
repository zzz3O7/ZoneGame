import { MATCHMAKING_TIME_MODES, MATCHMAKING_ANY_FALLBACK } from "../shared/config.js";

const SPECIFIC_TIME_MODES = MATCHMAKING_TIME_MODES.filter((t) => t !== "any");

// Board presets are always "classic" for now (the only entry in MODES,
// and resolveParams() itself only recognizes "classic" vs "custom" — see
// shared/params.js) — so there's deliberately no board-preset dimension
// here yet. If a second preset is ever added to matchmaking, this needs a
// preset key alongside `rated` below; not building that ahead of need.
//
// Within a rated/unrated pool, each specific time mode has its own FIFO
// queue. "any" is a separate pool that cross-matches: joining "any" first
// tries to fill whichever specific queue already has someone waiting
// (inheriting their time control), and joining a specific queue first
// checks whether an "any" player is already waiting to fill it. Only if
// neither side finds a match does the entry actually wait — see join().
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

  // Returns [entryA, entryB, resolvedTimeMode] if joining completed a
  // pair, or null if this player is now waiting alone. resolvedTimeMode
  // is always one of SPECIFIC_TIME_MODES, never "any" — by the time a
  // pair exists, a concrete time control has always been settled on.
  join(ws, entry, rated, timeMode) {
    this.leave(ws); // guard against a double JOIN_QUEUE queuing twice
    const pool = this._poolFor(rated);
    const self = { ws, ...entry }; // attach once, so every return path below carries ws — a bare `entry` return here previously shipped without it

    if (timeMode !== "any") {
      // An "any" player already waiting is a ready-made match — they
      // take whatever specific mode this new joiner asked for.
      if (pool.any.length > 0) return [self, pool.any.shift(), timeMode];
      const queue = pool.specific.get(timeMode);
      queue.push(self);
      if (queue.length >= 2) return [queue.shift(), queue.shift(), timeMode];
      return null;
    }

    // timeMode === "any": fill the first specific queue that already has
    // someone waiting, inheriting their time control.
    for (const mode of SPECIFIC_TIME_MODES) {
      const queue = pool.specific.get(mode);
      if (queue.length > 0) return [self, queue.shift(), mode];
    }
    // Nobody specific waiting either — park in the "any" pool. Two "any"
    // players pairing with each other have nothing to inherit, so they
    // fall back to a fixed default time control.
    pool.any.push(self);
    if (pool.any.length >= 2) return [pool.any.shift(), pool.any.shift(), MATCHMAKING_ANY_FALLBACK];
    return null;
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
}
