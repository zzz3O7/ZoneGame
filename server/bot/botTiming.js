import { BOT_THINK_MIN_MS, BOT_THINK_RANGE_MS, BOT_MIN_BANK_MS, BOT_MAX_THINK_FRACTION } from "./botConfig.js";

// How long a bot should "think" before submitting its move.
//
// direct_debug matches skip this entirely — that mode exists
// specifically so testing doesn't waste time (see docs/BOTS.md).
//
// Otherwise: a random human-ish delay, clamped down by the clock so a
// bot can never lose on time purely because of its own artificial
// pacing. It always keeps BOT_MIN_BANK_MS in reserve and never spends
// more than BOT_MAX_THINK_FRACTION of whatever's left beyond that — so
// as the clock gets low the delay shrinks toward zero on its own,
// rather than the bot flagging half its games.
export function botThinkDelayMs({ clock, playerIndex, origin, now }) {
  if (origin === "direct_debug") return 0;

  const base = BOT_THINK_MIN_MS + Math.random() * BOT_THINK_RANGE_MS;
  if (!clock) return base; // untimed match — nothing to protect against

  const remaining = clock.getRemaining(playerIndex, now);
  const spendable = Math.max(0, remaining - BOT_MIN_BANK_MS);
  return Math.min(base, spendable * BOT_MAX_THINK_FRACTION);
}
