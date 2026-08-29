// Bot self-play scheduler — docs/BOTS.md Phase 3 ("Population health").
// Plays eve games directly against shared/engine/game.js, no Match/
// PlayerAgent/WebSocket/wall-clock pacing involved (there's no human to
// notify or pace for — see that doc's reasoning for the fast-sim path).
// Feeds finished games into ratingService.js's finalizeRatedGame, the
// exact same rating pipeline a live networked Match uses (see that
// file's top comment for the other producer, matchManager.js).
//
// Pairing: round-robin over every pair of currently-active bots (not
// just neighboring ones) — games are cheap, and every additional
// pairing is more information about the ladder, so there's no reason to
// prefer a narrower rating-proximity match here the way human
// matchmaking does. The pair list is rebuilt from listActiveBotPlayers()
// on every single game, so an admin toggling a bot active/inactive
// takes effect on the very next game, not just at process start.
//
// Cadence: one game at a time, continuous (no delay between games) —
// but each individual MOVE yields the event loop via setImmediate
// rather than running a whole game in one synchronous call stack.
// Solver-tier bots can spend real time per move (see
// coordinatorSearch.js/endgameSolver.js), and this process also serves
// live player traffic — a self-play game must never be able to stall a
// real player's WebSocket message or a heartbeat ping just because it's
// mid-search. This is also what lets toggling the scheduler off take
// effect within one move rather than only after a whole game finishes.

import { Game } from "../../shared/engine/game.js";
import { resolveParams } from "../../shared/params.js";
import { createRng } from "../../shared/engine/rng.js";
import { chooseMoveForBotKey } from "./botRegistry.js";
import { listActiveBotPlayers, botKeyFromRow } from "./botRepository.js";
import { finalizeRatedGame } from "../ratingService.js";
import { log } from "../logger.js";
import { SELF_PLAY_RETRY_MS, SELF_PLAY_MAX_MOVES } from "./botConfig.js";

const MATCH_TYPE = "eve";
const ORIGIN = "self_play_scheduler";

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
let looping = false; // true while a game (or the retry wait) is in flight — guards against a second concurrent loop
let cursor = 0; // index into the current game's freshly-built pair list, see nextPair()
const pairGameCount = new Map(); // pairKey -> games played, so seats (and so who moves first) alternate per pair

const stats = {
  gamesPlayed: 0,
  lastGameEndedAt: null,
  lastError: null,
};

function pairKey(idA, idB) {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

// Every unordered pair of currently-active bots, id-sorted for a stable
// (while the pool doesn't change) round-robin order. Rebuilt fresh on
// every call rather than cached — see this file's top comment.
function allPairs() {
  const bots = [...listActiveBotPlayers()].sort((a, b) => a.id - b.id);
  const pairs = [];
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) pairs.push([bots[i], bots[j]]);
  }
  return pairs;
}

// Returns the next [botA, botB] to play, or null if fewer than 2 active
// bots exist right now. cursor wraps once a full sweep of the current
// pair list completes, starting the round-robin over again — if the
// active bot set changed since the last game, this may skip or repeat a
// pair once, a fine trade for always reflecting the live set rather than
// a snapshot from whenever the scheduler started.
function nextPair() {
  const pairs = allPairs();
  if (pairs.length === 0) return null;
  if (cursor >= pairs.length) cursor = 0;
  return pairs[cursor++];
}

function playOneGame([botA, botB], onDone) {
  const key = pairKey(botA.id, botB.id);
  const count = pairGameCount.get(key) ?? 0;
  pairGameCount.set(key, count + 1);
  // Alternate who holds seat 0 (and so moves first) per pair, same
  // reasoning scripts/solverSelfPlay.js uses — a bot's seat/tempo
  // advantage shouldn't leak into its rating any more than a human's
  // rematch seat should (see match.js's own starting-player alternation).
  const aFirst = count % 2 === 0;
  const bots = aFirst ? [botA, botB] : [botB, botA];
  const moveFns = bots.map((b) => chooseMoveForBotKey(botKeyFromRow(b)));

  const boardSeed = nextBoardSeed();
  const params = resolveParams("classic", { seed: boardSeed });
  const game = new Game(params);
  const startedAt = Date.now();
  let moves = 0;

  function step() {
    // Checked on every move, not just between games — this is what lets
    // an admin "off" toggle take effect mid-game rather than only after
    // the current game finishes. An aborted game is simply never
    // recorded (no partial-game row) — it never really happened.
    if (!enabled) {
      looping = false;
      return;
    }
    if (game.gameOver) return finish();
    if (moves >= SELF_PLAY_MAX_MOVES) {
      stats.lastError =
        `exceeded ${SELF_PLAY_MAX_MOVES} moves (seed=${boardSeed}, ${botA.nickname} vs ${botB.nickname}) — ` +
        "likely an infinite pass/placement loop bug, stopping scheduler rather than trusting the result";
      log(`self-play: ${stats.lastError}`);
      enabled = false;
      looping = false;
      return;
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
      looping = false;
      return;
    }

    moves++;
    setImmediate(step);
  }

  function finish() {
    const endedAt = Date.now();
    finalizeRatedGame({
      player0AccountId: bots[0].id,
      player1AccountId: bots[1].id,
      winnerIndex: game.winnerIndex,
      // Self-play always runs to the engine's own natural end — there's
      // no clock and nothing to resign/abort, so this is never anything
      // but "no-moves", same value a live match's equivalent path uses.
      endReason: "no-moves",
      scores: game.players.map((p) => p.score),
      totalBoardPoints: game.totalBoardPoints,
      remainingPossiblePoints: game.remainingPossiblePoints,
      seed: boardSeed,
      paramsJson: JSON.stringify(params),
      startedAt,
      endedAt,
      matchType: MATCH_TYPE,
      origin: ORIGIN,
      logLabel: `self-play ${bots[0].nickname} vs ${bots[1].nickname}`,
    });
    stats.gamesPlayed++;
    stats.lastGameEndedAt = endedAt;
    onDone();
  }

  step();
}

function loopTick() {
  if (!enabled) {
    looping = false;
    return;
  }
  const pair = nextPair();
  if (!pair) {
    // Not enough active bots right now — wait rather than spin a tight
    // retry loop for a condition that only changes via a rare admin
    // action (enabling a second bot, or all-but-one going inactive).
    setTimeout(loopTick, SELF_PLAY_RETRY_MS);
    return;
  }
  playOneGame(pair, () => setImmediate(loopTick));
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

// Also idempotent. The in-flight step()/loopTick() notices `enabled` on
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
    gamesPlayed: stats.gamesPlayed,
    lastGameEndedAt: stats.lastGameEndedAt,
    lastError: stats.lastError,
  };
}
