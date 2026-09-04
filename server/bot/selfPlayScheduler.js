// Bot self-play scheduler — docs/BOTS.md Phase 3 ("Population health").
// Every game is actually played inside the shared bot compute worker
// (botWorkerClient.js/botWorker.js), not on this (the main) thread —
// see that pair of files for why: this process also serves live player
// WebSocket traffic on a single-core box, and a solver-tier bot's
// search is real synchronous CPU work that must never run on the
// thread handling that traffic. This module is purely the coordinator:
// deciding who plays whom and when, submitting jobs to the worker, and
// doing the (cheap, DB-touching) finalizeRatedGame once a result comes
// back — none of which needs to be fast or non-blocking, since none of
// it does any heavy computation itself.
//
// Two units of work, one nested inside the other:
//
//   - A "pairing": one board seed, played twice by a given pair of bots
//     — once with each bot in seat 0 — so a pair's result isn't at the
//     mercy of whichever side got first-move advantage on that
//     particular board. Both games are still recorded as independent
//     rated rows; they just share a seed.
//
//   - A "cycle": one full round-robin sweep — every currently-active
//     bot pair gets exactly one pairing before the cycle is considered
//     complete. The bot pool is read fresh at the START of each cycle
//     (not re-checked mid-cycle), so an admin toggling a bot active/
//     inactive takes effect on the very next cycle, not mid-sweep.
//
// Cadence: THE CYCLE is what's throttled, to SELF_PLAY_CYCLES_PER_HOUR
// (botConfig.js) — pairings within a cycle run back-to-back with no
// delay between them, since a cycle should finish in a reasonable time
// regardless of how many bots are active. The scheduler paces the START
// of each cycle so the sustained rate stays at or below the configured
// ceiling even if a cycle finishes faster than its budgeted share. Since
// the worker only ever runs one job at a time (see botWorkerClient.js),
// this also naturally caps self-play at "one game thinking at a time,"
// same as before — it just no longer matters for main-thread lag either
// way.

import { resolveParams } from "../../shared/params.js";
import { createRng } from "../../shared/engine/rng.js";
import { botKeyFromRow, listActiveBotPlayers } from "./botRepository.js";
import { playSelfPlayGameViaWorker, saveSelfPlayCanonicalCache } from "./botWorkerClient.js";
import { finalizeRatedGame } from "../ratingService.js";
import { log } from "../logger.js";
import { SELF_PLAY_RETRY_MS, SELF_PLAY_CYCLES_PER_HOUR } from "./botConfig.js";

const MATCH_TYPE = "eve";
const ORIGIN = "self_play_scheduler";

// Target spacing between CYCLE starts (a full round-robin sweep), not
// between pairings — see this file's top comment. A pure function of
// the config constant (not a captured value) so changing
// SELF_PLAY_CYCLES_PER_HOUR and restarting the process is all that's
// needed to retune it.
export function cycleIntervalMs() {
  return (60 * 60 * 1000) / SELF_PLAY_CYCLES_PER_HOUR;
}

// Master RNG only decides which board seeds get used this run — same
// role as scripts/solverSelfPlay.js's masterRng, nothing to do with
// in-game randomness (each Game seeds its own createRng independently).
const masterRng = createRng((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
function nextBoardSeed() {
  // Avoid 0 — resolveParams treats a falsy seed as "generate one
  // instead" (see shared/params.js), which would break reproducibility
  // of the row this game eventually gets stored as.
  let s = 0;
  while (s === 0) s = Math.floor(masterRng() * 0xffffffff);
  return s;
}

let enabled = false;
let looping = false; // true while a cycle (or the retry/throttle wait) is in flight — guards against a second concurrent loop

const stats = {
  cyclesPlayed: 0,
  pairingsPlayed: 0,
  gamesPlayed: 0,
  lastGameEndedAt: null,
  lastError: null,
};

// Every unordered pair of currently-active bots, id-sorted for a stable
// (while the pool doesn't change) round-robin order. Read fresh at the
// start of each cycle — see this file's top comment.
function allPairs() {
  const bots = [...listActiveBotPlayers()].sort((a, b) => a.id - b.id);
  const pairs = [];
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) pairs.push([bots[i], bots[j]]);
  }
  return pairs;
}

function recordGame(bots, boardSeed, params, result) {
  finalizeRatedGame({
    player0AccountId: bots[0].id,
    player1AccountId: bots[1].id,
    winnerIndex: result.winnerIndex,
    // Self-play always runs to the engine's own natural end — there's
    // no clock and nothing to resign/abort, so this is never anything
    // but "no-moves", same value a live match's equivalent path uses.
    endReason: "no-moves",
    scores: result.scores,
    totalBoardPoints: result.totalBoardPoints,
    remainingPossiblePoints: result.remainingPossiblePoints,
    seed: boardSeed,
    paramsJson: JSON.stringify(params),
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    matchType: MATCH_TYPE,
    origin: ORIGIN,
    logLabel: `self-play ${bots[0].nickname} vs ${bots[1].nickname}`,
  });
  stats.gamesPlayed++;
  stats.lastGameEndedAt = result.endedAt;
}

// One pairing = one board seed, played twice with seats swapped, each
// game run via the worker (see this file's top comment). Note the
// asymmetry: if the scheduler is disabled in the narrow window between
// game 1 and game 2, game 1's rating update has already been committed
// (finalizeRatedGame runs immediately per game, not batched per
// pairing) — there's no way to "undo" it without reversing a real
// rating change, which is worse than leaving it. So an admin stop can,
// rarely, leave a single unmirrored game on the books instead of a
// clean same-seed pair. Accepted as a rare, low-impact edge case of a
// manual admin action rather than something worth adding cross-game
// transactional complexity for.
async function runOnePairing([botA, botB]) {
  const boardSeed = nextBoardSeed();
  const params = resolveParams("classic", { seed: boardSeed });
  const botKeyA = botKeyFromRow(botA);
  const botKeyB = botKeyFromRow(botB);

  const resultA = await playSelfPlayGameViaWorker({ botKeyA, botKeyB, params });
  recordGame([botA, botB], boardSeed, params, resultA);
  if (!enabled) return; // toggled off between the two games of this pairing

  const resultB = await playSelfPlayGameViaWorker({ botKeyA: botKeyB, botKeyB: botKeyA, params });
  recordGame([botB, botA], boardSeed, params, resultB);
  stats.pairingsPlayed++;
}

// Plays every pairing in `pairs`, in order, back-to-back (no throttle
// between pairings — only the cycle as a whole is paced, see this
// file's top comment). Returns true if every pairing in the list
// finished, or false if the sweep was abandoned partway through (the
// scheduler was disabled, or a pairing's worker job threw).
async function runCycle(pairs) {
  for (const pair of pairs) {
    if (!enabled) return false;
    try {
      await runOnePairing(pair);
    } catch (err) {
      stats.lastError = `self-play pairing failed (${pair[0].nickname} vs ${pair[1].nickname}): ${err.message}`;
      log(`self-play: ${stats.lastError} — stopping scheduler`);
      enabled = false;
      return false;
    }
  }
  return enabled;
}

async function loopTick() {
  if (!enabled) {
    looping = false;
    return;
  }

  const pairs = allPairs();
  if (pairs.length === 0) {
    // Not enough active bots right now — wait rather than spin a tight
    // retry loop for a condition that only changes via a rare admin
    // action (enabling a second bot, or all-but-one going inactive).
    // Doesn't count as a cycle and doesn't consume any of the throttle
    // budget — the first real cycle starts counting from when it
    // actually runs.
    setTimeout(loopTick, SELF_PLAY_RETRY_MS);
    return;
  }

  const cycleStartedAt = Date.now();
  const completed = await runCycle(pairs);
  if (completed) stats.cyclesPlayed++;

  // Once per cycle attempt, whether it ran to completion or was cut
  // short (disabled mid-sweep, or a pairing threw) — a partial cycle
  // still solved real shapes worth keeping. Never per-pairing or
  // per-game; see canonicalCacheStore.js for why batching like this is
  // the point, not just an optimization.
  try {
    const { grundySaved, treeSaved } = await saveSelfPlayCanonicalCache();
    if (grundySaved || treeSaved) {
      log(`self-play: saved canonical cache (+${grundySaved} grundy, +${treeSaved} tree)`);
    }
  } catch (err) {
    log(`self-play: canonical cache save failed: ${err.message}`);
  }

  if (!enabled) {
    looping = false; // cycle was abandoned (disabled or hit a bug) — just stop, no next cycle scheduled
    return;
  }
  // Pace the NEXT cycle's start to hit the configured rate ceiling — if
  // this cycle took longer than its budgeted share, start the next one
  // immediately rather than compounding a growing backlog.
  const elapsed = Date.now() - cycleStartedAt;
  const delay = Math.max(0, cycleIntervalMs() - elapsed);
  setTimeout(loopTick, delay);
}

// Idempotent — calling this while already enabled is a no-op, so a
// caller (the admin route) never needs to track whether it already
// started the loop.
export function startSelfPlayScheduler() {
  if (enabled) return;
  enabled = true;
  stats.lastError = null;
  if (!looping) {
    looping = true;
    loopTick();
  }
  log("self-play: scheduler enabled");
}

// Also idempotent. The in-flight runCycle() notices `enabled` between
// pairings and unwinds cleanly — this function can't (and doesn't try
// to) force an in-progress pairing's worker job to stop instantly.
export function stopSelfPlayScheduler() {
  if (!enabled) return;
  enabled = false;
  log("self-play: scheduler disabled");
}

export function isSelfPlaySchedulerEnabled() {
  return enabled;
}

// For the admin dashboard — see adminRoutes.js's GET /admin/self-play.
export function getSelfPlaySchedulerStatus() {
  return {
    enabled,
    activeBotCount: listActiveBotPlayers().length,
    cyclesPerHour: SELF_PLAY_CYCLES_PER_HOUR,
    cyclesPlayed: stats.cyclesPlayed,
    pairingsPlayed: stats.pairingsPlayed,
    gamesPlayed: stats.gamesPlayed,
    lastGameEndedAt: stats.lastGameEndedAt,
    lastError: stats.lastError,
  };
}
