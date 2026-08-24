// Headless self-play harness for the solver bot family (server/bot/solverBot.js
// + server/bot/solverBotPresets.js). Plays real games directly against the
// shared game engine (no server, no network, no DB) using real random board
// seeds, and reports win-rate / margin / game-length stats per matchup.
//
// Usage (from server/):
//   node scripts/solverSelfPlay.js
//   node scripts/solverSelfPlay.js --games=200
//   node scripts/solverSelfPlay.js --games=200 --presets=BOT_SOLVER_2,BOT_SOLVER_3
//   node scripts/solverSelfPlay.js --games=200 --seed=12345   (reproducible run)
//
// Every matchup is round-robin over whichever presets are selected (all four
// by default). For each matchup, `games` total games are played, split as
// evenly as possible between "A moves first" and "B moves first" so a bot's
// seat/tempo advantage doesn't leak into the win-rate — this is the same
// reason match.js alternates starting player between rematches.
//
// A "legit seed" here just means: a real board seed fed through the actual
// CaveGenerator (same as any live game), not a hand-picked or degenerate
// board. Seeds are drawn from a seeded master RNG so `--seed` makes a whole
// run reproducible, while omitting it gives a fresh set of boards every run.

import { Game } from "../../shared/engine/game.js";
import { resolveParams } from "../../shared/params.js";
import { createRng } from "../../shared/engine/rng.js";
import { createSolverBot } from "../bot/solverBot.js";
import * as presetsModule from "../bot/solverBotPresets.js";

// --- CLI args -------------------------------------------------------------

function parseArgs(argv) {
  const args = { games: 100, seed: null, presets: null, maxMoves: 4000 };
  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/, "").split("=");
    if (key === "games") args.games = Math.max(2, parseInt(value, 10));
    else if (key === "seed") args.seed = parseInt(value, 10);
    else if (key === "maxMoves") args.maxMoves = parseInt(value, 10);
    else if (key === "presets") args.presets = value.split(",").map((s) => s.trim());
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const ALL_PRESET_NAMES = Object.keys(presetsModule).filter((k) => k.startsWith("BOT_SOLVER_"));
const presetNames = args.presets ?? ALL_PRESET_NAMES;
for (const name of presetNames) {
  if (!presetsModule[name]) {
    console.error(`Unknown preset "${name}". Available: ${ALL_PRESET_NAMES.join(", ")}`);
    process.exit(1);
  }
}
if (presetNames.length < 2) {
  console.error("Need at least 2 presets to play a matchup.");
  process.exit(1);
}

// Master RNG only decides which board seeds get used this run — has nothing
// to do with in-game randomness, which is entirely inside each Game's own
// createRng(seed) and each bot's own Math.random() calls.
const masterSeed = args.seed ?? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
const masterRng = createRng(masterSeed);
function nextBoardSeed() {
  // Avoid 0 — resolveParams treats a falsy seed as "generate one instead"
  // (see shared/params.js), which would silently break reproducibility.
  let s = 0;
  while (s === 0) s = Math.floor(masterRng() * 0xffffffff);
  return s;
}

// --- One game -------------------------------------------------------------

// moveFns[i] is the chooseMove function playing as game.players[i].
function playOneGame(boardSeed, moveFns, maxMoves) {
  const params = resolveParams("classic", { seed: boardSeed });
  const game = new Game(params);

  let moves = 0;
  while (!game.gameOver) {
    if (moves >= maxMoves) {
      throw new Error(
        `Game exceeded maxMoves=${maxMoves} without ending (seed=${boardSeed}) — ` +
          "likely an infinite pass/placement loop bug, investigate before trusting stats.",
      );
    }
    const idx = game.currentPlayerIndex;
    const move = moveFns[idx](game, idx);
    if (move) {
      const applied = game.attemptPlacement(move.pieceType, move.shape, move.anchorRow, move.anchorCol);
      if (!applied) {
        throw new Error(
          `Bot proposed an illegal move (seed=${boardSeed}, player=${idx}): ${JSON.stringify(move)}`,
        );
      }
    } else {
      const applied = game.pass();
      if (!applied) {
        throw new Error(`Bot passed but pass() was rejected (seed=${boardSeed}, player=${idx}) — bot/rules mismatch.`);
      }
    }
    moves++;
  }

  return {
    winnerIndex: game.winnerIndex, // 0, 1, or null (draw)
    scores: game.players.map((p) => p.score),
    moves,
  };
}

// --- One matchup: preset A vs preset B, `games` total, seats alternated ---

function runMatchup(nameA, nameB, games, maxMoves) {
  const chooseA = createSolverBot(presetsModule[nameA]);
  const chooseB = createSolverBot(presetsModule[nameB]);

  const stats = {
    winsA: 0,
    winsB: 0,
    draws: 0,
    marginSum: 0, // A's score minus B's score, summed
    movesSum: 0,
    games: 0,
  };

  for (let i = 0; i < games; i++) {
    const boardSeed = nextBoardSeed();
    const aGoesFirst = i % 2 === 0; // alternate who holds player-index 0
    const moveFns = aGoesFirst ? [chooseA, chooseB] : [chooseB, chooseA];

    if (process.stdout.isTTY) {
      process.stdout.write(`\r  ${nameA} vs ${nameB}: game ${i + 1}/${games}...`);
    }
    const result = playOneGame(boardSeed, moveFns, maxMoves);

    const scoreA = aGoesFirst ? result.scores[0] : result.scores[1];
    const scoreB = aGoesFirst ? result.scores[1] : result.scores[0];
    const winnerIsA =
      result.winnerIndex === null ? null : aGoesFirst ? result.winnerIndex === 0 : result.winnerIndex === 1;

    if (winnerIsA === null) stats.draws++;
    else if (winnerIsA) stats.winsA++;
    else stats.winsB++;

    stats.marginSum += scoreA - scoreB;
    stats.movesSum += result.moves;
    stats.games++;
  }

  return stats;
}

// --- Round robin over all selected presets --------------------------------

function pct(n, d) {
  return d === 0 ? "  -  " : `${((100 * n) / d).toFixed(1)}%`.padStart(6);
}

// Rough 95% CI half-width for a win-rate estimate, treating draws as
// removed from the denominator (binomial over decisive games only).
function winRateCI(wins, decisive) {
  if (decisive === 0) return null;
  const p = wins / decisive;
  const se = Math.sqrt((p * (1 - p)) / decisive);
  return 1.96 * se;
}

console.log(`solver bot self-play — masterSeed=${masterSeed}, ${args.games} games/matchup, maxMoves=${args.maxMoves}`);
console.log(`presets: ${presetNames.join(", ")}\n`);

const ladder = {};
for (const name of presetNames) ladder[name] = { wins: 0, losses: 0, draws: 0 };

const startedAt = Date.now();
for (let i = 0; i < presetNames.length; i++) {
  for (let j = i + 1; j < presetNames.length; j++) {
    const nameA = presetNames[i];
    const nameB = presetNames[j];
    const stats = runMatchup(nameA, nameB, args.games, args.maxMoves);
    if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(60) + "\r");

    ladder[nameA].wins += stats.winsA;
    ladder[nameA].losses += stats.winsB;
    ladder[nameA].draws += stats.draws;
    ladder[nameB].wins += stats.winsB;
    ladder[nameB].losses += stats.winsA;
    ladder[nameB].draws += stats.draws;

    const decisive = stats.winsA + stats.winsB;
    const ci = winRateCI(stats.winsA, decisive);
    const avgMargin = (stats.marginSum / stats.games).toFixed(1);
    const avgMoves = (stats.movesSum / stats.games).toFixed(1);

    console.log(`${nameA} vs ${nameB}  (${stats.games} games)`);
    console.log(
      `  ${nameA}: ${stats.winsA} wins (${pct(stats.winsA, stats.games)})` +
        `   ${nameB}: ${stats.winsB} wins (${pct(stats.winsB, stats.games)})` +
        `   draws: ${stats.draws}`,
    );
    console.log(
      `  ${nameA} win rate of decisive games: ${pct(stats.winsA, decisive)}` +
        (ci !== null ? ` ± ${(100 * ci).toFixed(1)}pp (95% CI)` : ""),
    );
    console.log(`  avg score margin (A-B): ${avgMargin}   avg game length: ${avgMoves} moves\n`);
  }
}

console.log(`--- Ladder (aggregate across all matchups, ${(Date.now() - startedAt) / 1000}s total) ---`);
const ranked = presetNames
  .map((name) => {
    const l = ladder[name];
    const decisive = l.wins + l.losses;
    return { name, ...l, winRate: decisive === 0 ? null : l.wins / decisive };
  })
  .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));

for (const r of ranked) {
  console.log(
    `  ${r.name.padEnd(14)}  W:${String(r.wins).padStart(4)}  L:${String(r.losses).padStart(4)}  D:${String(
      r.draws,
    ).padStart(3)}   win rate: ${r.winRate === null ? "-" : pct(r.wins, r.wins + r.losses)}`,
  );
}
