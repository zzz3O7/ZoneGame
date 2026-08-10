// A two-player Fischer-increment chess clock, as a pure function of
// (state, now) -> new state. Never reads Date.now() itself — every method
// takes `now` (a ms timestamp, same shape as Date.now()) from the caller.
//   - server (Match): authoritative, now = Date.now() at the top of a
//     message handler, threaded through so stop/start/snapshot agree
//   - online client (GameUI): display-only, now = Date.now() inside a
//     setInterval tick, corrected on every server snapshot
//   - hotseat client (GameUI): authoritative, same shape as the server role
//     but local — no network involved
// A null Clock (or null timeControl in params) means "no time control" —
// callers should just skip clock logic entirely rather than construct one.
export class Clock {
  constructor({ initialMs, incrementMs, remainingMs = null }) {
    this.initialMs = initialMs;
    this.incrementMs = incrementMs;
    this.remainingMs = remainingMs ? [...remainingMs] : [initialMs, initialMs];

    // null/null means nobody's clock is running right now (before
    // the first move, or after the game has ended).
    this.currentPlayerIndex = null;
    this.turnStartedAt = null;
  }

  static fromConfig({ initialMs, incrementMs }) {
    return new Clock({ initialMs, incrementMs });
  }

  // Rebuild a clock resuming from a snapshot
  static fromSnapshot(snapshot, { initialMs, incrementMs }, now) {
    const clock = new Clock({ initialMs, incrementMs, remainingMs: snapshot.remainingMs });
    if (snapshot.currentPlayerIndex !== null) {
      clock.currentPlayerIndex = snapshot.currentPlayerIndex;
      clock.turnStartedAt = now;
    }
    return clock;
  }

  // Begin counting down for playerIndex. Caller's job to have already
  // stopped whoever was previously ticking — starting a turn while another
  // is still running would silently abandon that player's elapsed time.
  startTurn(playerIndex, now) {
    this.currentPlayerIndex = playerIndex;
    this.turnStartedAt = now;
  }

  // End the current turn
  stopTurn(now) {
    if (this.currentPlayerIndex === null) return 0;
    const elapsed = Math.max(0, now - this.turnStartedAt);
    const i = this.currentPlayerIndex;
    this.remainingMs[i] = Math.max(0, this.remainingMs[i] - elapsed);
    this.remainingMs[i] += this.incrementMs;

    this.currentPlayerIndex = null;
    this.turnStartedAt = null;
    return elapsed;
  }

  // Stops the ticking player's clock WITHOUT an increment — unlike
  // stopTurn(), which is for a legitimate completed move. Use this when a
  // turn ends some other way: flag-fall, resign, abort/forfeit, or the game
  // ending on the opponent's move.
  freeze(now) {
    if (this.currentPlayerIndex === null) return;
    this.remainingMs[0] = this.getRemaining(0, now);
    this.remainingMs[1] = this.getRemaining(1, now);
    this.currentPlayerIndex = null;
    this.turnStartedAt = null;
  }

  getRemaining(playerIndex, now) {
    if (playerIndex !== this.currentPlayerIndex) return this.remainingMs[playerIndex];
    const elapsed = Math.max(0, now - this.turnStartedAt);
    return Math.max(0, this.remainingMs[playerIndex] - elapsed);
  }

  isFlagged(now) {
    if (this.currentPlayerIndex === null) return false;
    return this.getRemaining(this.currentPlayerIndex, now) <= 0;
  }

  // The payload shape
  // `now` is included explicitly rather than assumed.
  snapshot(now) {
    return {
      remainingMs: [this.getRemaining(0, now), this.getRemaining(1, now)],
      currentPlayerIndex: this.currentPlayerIndex,
      now,
    };
  }
}

// Pure, stateless helper for read-only display consumers that only have a
// snapshot (not a full Clock instance)
// Mirrors Clock#getRemaining's math exactly;
export function extrapolateRemaining(snapshot, playerIndex, now) {
  if (!snapshot) return null;
  const base = snapshot.remainingMs[playerIndex];
  if (playerIndex !== snapshot.currentPlayerIndex) return base;
  const elapsed = Math.max(0, now - snapshot.now);
  return Math.max(0, base - elapsed);
}

// m:ss, or h:mm:ss once an hour is on the bank. Ceil (not floor/round).
// Below LOW_TIME_THRESHOLD_MS, switches to tenths-of-a-second precision
// (m:ss.d) — whole seconds is too coarse to read a flag-fall coming.
export const LOW_TIME_THRESHOLD_MS = 10_000;

export function formatClockMs(ms) {
  const clamped = Math.max(0, ms);
  const pad = (n) => String(n).padStart(2, "0");

  if (clamped <= LOW_TIME_THRESHOLD_MS) {
    const totalTenths = Math.ceil(clamped / 100);
    const totalSeconds = Math.floor(totalTenths / 10);
    const tenths = totalTenths % 10;
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${pad(s)}.${tenths}`;
  }

  const totalSeconds = Math.ceil(clamped / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
