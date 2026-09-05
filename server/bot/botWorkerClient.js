// Main-thread side of the bot compute workers — see botWorker.js for
// what actually runs over there (the same worker code serves both
// channels below; only which channel a job is submitted to differs).
//
// TWO separate persistent workers, not one shared queue: a self-play
// game is submitted to its worker as a single atomic job (the whole
// game runs start to finish inside it — see botWorker.js), so if a live
// player's bot move shared a queue with self-play, it could get stuck
// waiting behind an entire in-progress self-play game (up to the
// 5-15+ seconds a heavy bot-vs-bot game can take), not just a single
// move. That's fine for self-play (nothing is waiting on it) but not
// for a real player mid-match. Splitting into liveMoveWorker and
// selfPlayWorker means the two can never queue behind each other —
// player experience takes priority over self-play throughput, which is
// also why liveMoveWorker's channel exists at all rather than making
// self-play wait for a livelier priority scheme instead.
//
// Each channel is still a single persistent worker, not a pool — one
// bot "thinking" at a time per channel, matching the original decision
// to keep self-play sequential, and there's no second CPU core on the
// current VPS to actually parallelize onto anyway (see botWorker.js's
// top comment). Two channels means at most two things can be
// genuinely running at once (one live move + one self-play game), which
// is a fine trade on a single core: the OS time-slices between them
// exactly like it already does between either worker and the main
// thread.
//
// If a worker crashes, every in-flight request ON THAT CHANNEL is
// rejected (there's no way to know what it was doing when it died) and
// a fresh worker for that channel is spawned automatically — callers
// don't need their own retry logic for "the worker process died," only
// for "my specific job failed." The other channel is unaffected.

import { Worker } from "worker_threads";
import { log } from "../logger.js";

const WORKER_PATH = new URL("./botWorker.js", import.meta.url);

// Creates one independent worker + request queue. `label` is just for
// log messages, so a crash/respawn on one channel is distinguishable
// from the other.
function createChannel(label) {
  let worker = null;
  let nextRequestId = 1;
  const pending = new Map(); // requestId -> { resolve, reject }

  function spawnWorker() {
    worker = new Worker(WORKER_PATH);

    worker.on("message", (msg) => {
      const p = pending.get(msg.id);
      if (!p) return; // response to a request we've already given up on — ignore
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });

    worker.on("error", (err) => {
      log(`bot worker (${label}) crashed: ${err.message} — respawning`);
      for (const p of pending.values()) p.reject(new Error(`bot worker (${label}) crashed: ${err.message}`));
      pending.clear();
      spawnWorker();
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        log(`bot worker (${label}) exited unexpectedly (code ${code}) — respawning`);
        spawnWorker();
      }
    });
  }

  spawnWorker();

  return function submit(type, payload) {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, payload });
    });
  };
}

const submitLiveMove = createChannel("live-move");
const submitSelfPlay = createChannel("self-play");

// A single live-match bot move. See playerAgent.js's BotAgent — this
// replaces what used to be a synchronous chooseMove(game, playerIndex)
// call on the main thread. `actions` should be the match's own replay
// log (match.actions) at the moment of the call; the worker reconstructs
// an equivalent Game from (params, actions) rather than needing the
// live Game object itself, which can't cross a thread boundary. Always
// goes through the dedicated live-move channel — never the self-play one.
export function chooseMoveViaWorker({ botKey, params, actions, playerIndex }) {
  return submitLiveMove("chooseMove", { botKey, params, actions, playerIndex });
}

// A full self-play game — see selfPlayScheduler.js. Runs entirely on
// its own worker's thread; resolves with the same shape a live match's
// finished-game data has (winnerIndex, scores, totalBoardPoints,
// remainingPossiblePoints, startedAt, endedAt). Always goes through the
// dedicated self-play channel — never the live-move one.
export function playSelfPlayGameViaWorker({ botKeyA, botKeyB, params }) {
  return submitSelfPlay("playSelfPlayGame", { botKeyA, botKeyB, params });
}

// Snapshot + reset of the self-play worker's canonical cache hit/miss/
// timing stats since the last call - see selfPlayScheduler.js, called
// once per cycle. Self-play only for now: it's the one channel with
// enough volume to make the numbers meaningful, and this is
// specifically for re-deriving CANONICAL_MIN_CELLS / CANONICAL_LARGE_SHAPE_CELLS
// against real traffic (see canonicalShape.js). Purely in-memory
// instrumentation - independent of whether anything gets persisted to
// disk (nothing does; see canonicalShape.js's history on that).
export function getSelfPlayCanonicalCacheStats() {
  return submitSelfPlay("getCanonicalStats", {});
}

// Discards the live-move worker's ephemeral large-shape cache - see
// CANONICAL_LARGE_SHAPE_CELLS in canonicalShape.js. Called from
// playerAgent.js's BotAgent._onGameOver, once per finished match (self-
// play's equivalent runs directly in-thread instead, see botWorker.js).
export function clearLiveMoveLargeCanonicalCache() {
  return submitLiveMove("clearLargeCache", {});
}
