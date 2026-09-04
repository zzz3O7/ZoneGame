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
import { loadCanonicalCaches, saveCanonicalCaches } from "./canonicalCacheStore.js";

// canonicalCacheStore.js talks to solverCache.db, not the live
// player-facing zonegame.db — this file's "no DB access" rule above is
// about keeping match/player/account data on the main thread, not
// about solver infrastructure that's designed to be used from exactly
// this kind of context. Loads once per worker spawn, for BOTH channels
// (this file is shared — see botWorkerClient.js's top comment), so a
// live-move worker's very first move can already benefit from shapes
// self-play accumulated in a previous run, not just shapes solved
// within its own lifetime.
{
  const { grundyLoaded, treeLoaded } = loadCanonicalCaches();
  log(`bot worker: loaded canonical cache (${grundyLoaded} grundy, ${treeLoaded} tree)`);
}

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

  return {
    winnerIndex: game.winnerIndex,
    scores: game.players.map((p) => p.score),
    totalBoardPoints: game.totalBoardPoints,
    remainingPossiblePoints: game.remainingPossiblePoints,
    startedAt,
    endedAt: Date.now(),
  };
}

// Flushes this thread's newly-solved canonical shapes to solverCache.db
// — see canonicalCacheStore.js's incremental-save tracking (only
// entries added since this thread's own last save actually get
// written, so repeated calls stay cheap). Triggered from the main
// thread at whatever point makes sense for the caller's channel — see
// selfPlayScheduler.js (self-play, once per cycle) and
// playerAgent.js's BotAgent._onGameOver (live matches, once per
// finished PvE game). Same handler serves both channels; only the
// call site differs.
function saveCache() {
  return saveCanonicalCaches();
}

const HANDLERS = { chooseMove, playSelfPlayGame, saveCache };

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
