// Runs INSIDE a worker_threads Worker (see botWorkerClient.js for the
// main-thread side). Everything in this file executes on its own OS
// thread with its own V8 heap — that's the whole point: a solver-tier
// bot's search can take real, synchronous CPU time, and as long as that
// happens here rather than on the main thread, the OS scheduler keeps
// preempting it to give the main thread's event loop (where every real
// player's WebSocket connection lives) regular turns. That's true even
// on a single-core box — a second OS thread doesn't add compute
// capacity there, but it does let the OS time-slice fairly instead of
// the main thread being unable to yield until a whole synchronous
// search finishes.
//
// Deliberately has NO import of anything that touches the database
// (botRepository.js, playerRepository.js, gameRepository.js, db.js) —
// this module's only inputs are plain, structured-cloneable data over
// postMessage, and its only outputs are plain data back. All DB access
// stays on the main thread, in botWorkerClient.js's caller.

import { parentPort } from "worker_threads";
import { Game } from "../../shared/engine/game.js";
import { chooseMoveForBotKey } from "./botRegistry.js";
import { SELF_PLAY_MAX_MOVES } from "./botConfig.js";
import { log } from "../logger.js";
import { getAndResetCanonicalCacheStats, clearLargeCanonicalCaches } from "./canonicalShape.js";
import { clearEphemeralTreeCaches } from "./reducedTreeDominoAware.js";

// Reconstructs a Game from (params, actions) — the exact same
// "new Game(params), then replay every logged action" reconstruction
// match.js's buildSyncState comment describes as the one code path a
// live game, a reconnecting client, and a resync all already share
// (see client/js/net/matchClient.js and client/js/localGameStore.js for
// the other two). This is what lets a single live-match bot move be
// computed off-thread without the worker ever needing the real, live
// Game object (which can't cross a thread boundary) — just its replay
// log, which match.js already keeps for reconnect/resync anyway.
function rebuildGame(params, actions) {
  const game = new Game(params);
  for (const action of actions) {
    if (action.kind === "placement") {
      game.attemptPlacement(action.pieceType, action.shape, action.anchorRow, action.anchorCol);
    } else {
      game.pass();
    }
  }
  return game;
}

// A single live-match bot move. `actions` is match.actions (the
// reconnect/resync replay log) as of the moment BotAgent decided to
// think — see playerAgent.js. Returns the move descriptor, or null for
// a pass, exactly like a directly-called chooseMove(game, playerIndex)
// would on the main thread.
function chooseMove({ botKey, params, actions, playerIndex }) {
  const game = rebuildGame(params, actions);
  return chooseMoveForBotKey(botKey)(game, playerIndex) ?? null;
}

// A full self-play game, start to finish, entirely inside this worker —
// see selfPlayScheduler.js. Unlike a live match there's no client to
// keep in sync and nothing else this thread needs to do in the
// meantime, so this just runs to completion synchronously; no per-move
// yielding needed (that was only ever a main-thread concern).
function playSelfPlayGame({ botKeyA, botKeyB, params }) {
  const moveFns = [chooseMoveForBotKey(botKeyA), chooseMoveForBotKey(botKeyB)];
  const game = new Game(params);
  const startedAt = Date.now();
  let moves = 0;

  while (!game.gameOver) {
    if (moves >= SELF_PLAY_MAX_MOVES) {
      throw new Error(`exceeded ${SELF_PLAY_MAX_MOVES} moves — likely an infinite pass/placement loop bug`);
    }
    const idx = game.currentPlayerIndex;
    const move = moveFns[idx](game, idx);
    const applied = move
      ? game.attemptPlacement(move.pieceType, move.shape, move.anchorRow, move.anchorCol)
      : game.pass();
    if (!applied) {
      throw new Error(`illegal move/pass from seat ${idx}: ${JSON.stringify(move)}`);
    }
    moves++;
  }

  // A large shape's only real reuse is within its own game's recursive
  // exploration - see CANONICAL_LARGE_SHAPE_CELLS in canonicalShape.js.
  // canonicalRegistry/globalJointMemo (reducedTreeDominoAware.js) are a
  // separate, ungated, unmeasured concern - see clearEphemeralTreeCaches.
  // Same-thread call, no message plumbing needed (unlike the live-move
  // side, where a match spans many separate chooseMove calls instead of
  // one synchronous function like this).
  clearLargeCanonicalCaches();
  clearEphemeralTreeCaches();

  return {
    winnerIndex: game.winnerIndex,
    scores: game.players.map((p) => p.score),
    totalBoardPoints: game.totalBoardPoints,
    remainingPossiblePoints: game.remainingPossiblePoints,
    startedAt,
    endedAt: Date.now(),
  };
}

// Snapshot + reset of this thread's canonical cache hit/miss/timing
// stats since the last call - see canonicalShape.js. Currently only
// wired to the self-play channel (see botWorkerClient.js) since that's
// where the CANONICAL_MIN_CELLS question actually needs real traffic
// volume to answer.
function getCanonicalStats() {
  return getAndResetCanonicalCacheStats();
}

// Live-move counterpart to the direct in-thread call inside
// playSelfPlayGame above - a live match spans many separate chooseMove
// calls instead of one synchronous function, so there's no single place
// to call this directly; playerAgent.js's BotAgent._onGameOver triggers
// it via this job instead, once per finished match (see
// botWorkerClient.js).
function clearLargeCache() {
  clearLargeCanonicalCaches();
  clearEphemeralTreeCaches();
  return { ok: true };
}

const HANDLERS = { chooseMove, playSelfPlayGame, getCanonicalStats, clearLargeCache };

parentPort.on("message", (msg) => {
  try {
    const handler = HANDLERS[msg.type];
    if (!handler) throw new Error(`bot worker: unknown job type "${msg.type}"`);
    const result = handler(msg.payload);
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: err.message });
  }
});
