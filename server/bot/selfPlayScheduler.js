// Bot self-play scheduler — docs/BOTS.md Phase 3 ("Population health").
// Plays eve games directly against shared/engine/game.js, no Match/
// PlayerAgent/WebSocket/wall-clock pacing involved (there's no human to
// notify or pace for — see that doc's reasoning for the fast-sim path).
// Feeds finished games into ratingService.js's finalizeRatedGame, the
// exact same rating pipeline a live networked Match uses (see that
// file's top comment for the other producer, matchManager.js).
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
// ceiling even if a cycle finishes faster than its budgeted share.
// Independently of that, every individual MOVE (not just each pairing
// or cycle) still yields the event loop via setImmediate — solver-tier
// bots can spend real time per move, and this process also serves live
// player traffic, so a self-play game must never be able to stall a
// real player's WebSocket message or a heartbeat ping just because it's
// mid-search. This is also what lets toggling the scheduler off take
// effect within one move rather than only after a whole cycle finishes.

import { Game } from "../../shared/engine/game.js";
import { resolveParams } from "../../shared/params.js";
import { createRng } from "../../shared/engine/rng.js";
import { chooseMoveForBotKey } from "./botRegistry.js";
import { listActiveBotPlayers, botKeyFromRow } from "./botRepository.js";
import { finalizeRatedGame } from "../ratingService.js";
import { log } from "../logger.js";
import { SELF_PLAY_RETRY_MS, SELF_PLAY_MAX_MOVES, SELF_PLAY_CYCLES_PER_HOUR } from "./botConfig.js";

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

// Plays a single game to completion (bots[0] in seat 0), yielding the
// event loop after every move — see this file's top comment for why.
// Calls onDone(gameResult) once finished, or onAbort() if the scheduler
// was disabled (or hit a bug) mid-game — nothing is recorded for an
// aborted game, it never really happened.
function playOneGame(bots, boardSeed, params, onDone, onAbort) {
  const moveFns = bots.map((b) => chooseMoveForBotKey(botKeyFromRow(b)));
  const game = new Game(params);
  const startedAt = Date.now();
  let moves = 0;

  function step() {
    if (!enabled) return onAbort();
    if (game.gameOver) {
      return onDone({
        winnerIndex: game.winnerIndex,
        scores: game.players.map((p) => p.score),
        totalBoardPoints: game.totalBoardPoints,
        remainingPossiblePoints: game.remainingPossiblePoints,
        startedAt,
        endedAt: Date.now(),
      });
    }
    if (moves >= SELF_PLAY_MAX_MOVES) {
      stats.lastError =
        `exceeded ${SELF_PLAY_MAX_MOVES} moves (seed=${boardSeed}, ${bots[0].nickname} vs ${bots[1].nickname}) — ` +
        "likely an infinite pass/placement loop bug, stopping scheduler rather than trusting the result";
      log(`self-play: ${stats.lastError}`);
      enabled = false;
      return onAbort();
    }

    const idx = game.currentPlayerIndex;
    const move = moveFns[idx](game, idx);
    const applied = move
      ? game.attemptPlacement(move.pieceType, move.shape, move.anchorRow, move.anchorCol)
      : game.pass();
    if (!applied) {
      stats.lastError = `illegal move/pass from ${bots[idx].nickname} (seed=${boardSeed}): ${JSON.stringify(move)}`;
      log(`self-play: ${stats.lastError} — stopping scheduler`);
      enabled = false;
      return onAbort();
    }

    moves++;
    setImmediate(step);
  }

  step();
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

// One pairing = one board seed, played twice with seats swapped — see
// this file's top comment. onComplete() fires once both games are
// recorded; onAbort() fires instead if the pairing was abandoned
// partway through.
//
// Note the asymmetry: if the scheduler is disabled in the narrow window
// between game 1 and game 2 of a pairing, game 1's rating update has
// already been committed (finalizeRatedGame runs immediately per game,
// not batched per pairing) — there's no way to "undo" it without
// reversing a real rating change, which is worse than leaving it. So an
// admin stop can, rarely, leave a single unmirrored game on the books
// instead of a clean same-seed pair. This is intentionally accepted as
// a rare, low-impact edge case of a manual admin action rather than
// something worth adding cross-game transactional complexity for.
function runOnePairing([botA, botB], onComplete, onAbort) {
  const boardSeed = nextBoardSeed();
  const params = resolveParams("classic", { seed: boardSeed });

  playOneGame(
    [botA, botB],
    boardSeed,
    params,
    (resultA) => {
      recordGame([botA, botB], boardSeed, params, resultA);
      if (!enabled) return onAbort(); // toggled off between the two games of this pairing
      playOneGame(
        [botB, botA],
        boardSeed,
        params,
        (resultB) => {
          recordGame([botB, botA], boardSeed, params, resultB);
          stats.pairingsPlayed++;
          onComplete();
        },
        onAbort,
      );
    },
    onAbort,
  );
}

// Plays every pairing in `pairs`, in order, back-to-back (no throttle
// between pairings — only the cycle as a whole is paced, see this
// file's top comment). onComplete() fires once every pairing in the
// list has finished; onAbort() fires instead the moment any pairing is
// abandoned, and nothing further in the list is attempted.
function runCycle(pairs, index, onComplete, onAbort) {
  if (!enabled) return onAbort();
  if (index >= pairs.length) return onComplete();
  runOnePairing(pairs[index], () => runCycle(pairs, index + 1, onComplete, onAbort), onAbort);
}

function loopTick() {
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
  runCycle(
    pairs,
    0,
    () => {
      stats.cyclesPlayed++;
      // Pace the NEXT cycle's start to hit the configured rate ceiling
      // — if this cycle took longer than its budgeted share, start the
      // next one immediately rather than compounding a growing backlog.
      const elapsed = Date.now() - cycleStartedAt;
      const delay = Math.max(0, cycleIntervalMs() - elapsed);
      setTimeout(loopTick, delay);
    },
    () => {
      looping = false; // cycle was abandoned (disabled or hit a bug) — just stop, no next cycle scheduled
    },
  );
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

// Also idempotent. The in-flight step()/runCycle() notices `enabled` on
// its own very next tick and unwinds cleanly — this function can't (and
// doesn't try to) force an in-progress game to stop instantly.
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
