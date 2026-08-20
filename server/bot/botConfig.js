// Tunables for bot behavior — see docs/BOTS.md.

// Human-ish pacing before a bot submits its move. Uniform random in
// [BOT_THINK_MIN_MS, BOT_THINK_MIN_MS + BOT_THINK_RANGE_MS), before any
// clock-safety clamping (see botTiming.js).
export const BOT_THINK_MIN_MS = 100;
export const BOT_THINK_RANGE_MS = 100;

// Time-control safety: a bot should never lose on time because of its
// own artificial delay, so it never spends more than this fraction of
// "spendable" time (remaining minus the bank), and always tries to keep
// at least this much in reserve.
export const BOT_MIN_BANK_MS = 1000;
export const BOT_MAX_THINK_FRACTION = 0.5;
