// Tunables for bot behavior — see docs/BOTS.md.

// Human-ish pacing before a bot submits its move. Uniform random in
// [BOT_THINK_MIN_MS, BOT_THINK_MIN_MS + BOT_THINK_RANGE_MS), before any
// clock-safety clamping (see botTiming.js).
export const BOT_THINK_MIN_MS = 1; // 1000; DEBUG
export const BOT_THINK_RANGE_MS = 9; // 9000; DEBUG

// Time-control safety: a bot should never lose on time because of its
// own artificial delay, so it never spends more than this fraction of
// "spendable" time (remaining minus the bank), and always tries to keep
// at least this much in reserve.
export const BOT_MIN_BANK_MS = 1000;
export const BOT_MAX_THINK_FRACTION = 0.5;

// How long a bot waits after a (non-debug) match ends before leaving.
// Neither vanishing the instant the game ends nor sitting there
// indefinitely reads as a real player — a short randomized pause does.
// See BotAgent._onGameOver in playerAgent.js.
export const BOT_LEAVE_MIN_MS = 1000;
export const BOT_LEAVE_RANGE_MS = 9000;

// Self-play scheduler (docs/BOTS.md Phase 3) — see selfPlayScheduler.js.
// Games run back-to-back with no wall-clock pacing (there's no human to
// pace for), so the only real "cadence" knob is how long to wait before
// re-checking the active bot pool when there currently aren't enough
// bots (0 or 1) to pair up — no point spinning a tight retry loop for a
// condition that only changes via a rare admin action.
export const SELF_PLAY_RETRY_MS = 5000;

// Same runaway-loop guard solverSelfPlay.js uses for its offline harness
// — a self-play game is expected to always end via the engine's own
// no-moves condition, so hitting this is a real bug (infinite pass/
// placement loop), not a game that's merely "long".
export const SELF_PLAY_MAX_MOVES = 4000;
