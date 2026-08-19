# Bots & Matchmaking — Design Doc

Status: planning. Long-running doc, expect edits across many sessions (like the rating system doc).

## Problem

New users hitting an empty matchmaking queue. Need bot opponents that are seamless,
gameable at multiple strengths, and don't corrupt the rating system or human-only stats.

## Core abstraction: PlayerAgent

`matchManager` / `match.js` never know whether they're talking to a human or a bot.
They talk to a `PlayerAgent` interface only.

```
PlayerAgent
  outbound (match -> agent):
    notifyStateChange(state)
    notifyYourTurn()
    notifyMatchEnd(result)
  inbound (agent -> match):
    submitIntent(intent)   // same intents as today: move, resign, pass
```

- `HumanAgent` — wraps the WS connection. Outbound calls serialize + send over the socket.
  Inbound WS messages get parsed and call `match.submitIntent()`.
- `BotAgent` — wraps bot decision logic. `notifyStateChange` triggers a think step
  (after the appropriate delay, see `origin` below), which computes a move and calls
  `match.submitIntent()`.

Match code has zero branching on player type. This is what makes bot play seamless —
not by faking a socket, but because there is structurally one path a move can take into
the engine regardless of source. Also the natural extension point for future non-human
agents (hint bot for calc mode, replay/analysis agents, etc.) without touching match code.

## Classification fields

Two independent fields, answering two different questions.

### `match.match_type` — ENUM('pvp', 'pve', 'eve')

Who is playing. Drives leaderboard inclusion, rating-weight training on human-only
games, stats queries.

### `match.origin` — ENUM('matchmaking', 'direct_debug', 'self_play_scheduler')

How the match was entered. Drives side effects:

- delay behavior (human-pacing timer on/off)
- queue involvement
- rating impact
- bot display name

### `player.is_bot`

Lives on the player row, independent of any specific match. Needed to exclude bots
from global player lists, "active humans" counts, etc. Bots are real rows in `players`
with real `rating_mu` / `rating_sigma` — not a separate table — so the existing rating
pipeline treats them identically to humans with no special-casing.

### Decided combinations

| match_type | origin              | delay        | rating impact | notes                                                 |
| ---------- | ------------------- | ------------ | ------------- | ----------------------------------------------------- |
| pvp        | matchmaking         | n/a (human)  | yes           | normal ranked/unranked flow                           |
| pve        | matchmaking         | human-pacing | yes           | fallback when no human found in queue                 |
| pve        | direct_debug        | none         | **no**        | "play vs bot" debug/fun mode, user picks bot directly |
| eve        | self_play_scheduler | none         | yes           | keeps bot ratings calibrated                          |

Open: does `pve` via `matchmaking` origin ever need a "no rating" variant too? — no,
only `direct_debug` is exempt. Matchmaking-sourced PvE is a real fallback match and
should count.

## Phasing

### Phase 0 — Foundations

- [ ] `match_type` and `origin` columns on matches (clean drop, no existing rated data)
- [ ] `is_bot` flag on players
- [ ] `PlayerAgent` interface; refactor current human-socket handling into `HumanAgent`
      implementing it. Verify match.js has zero remaining direct-socket assumptions.
- [ ] Debug-readable bot names (`Bot_Weak_01`, etc.)

### Phase 1 — Dumbest possible bot, wired end-to-end

- [ ] `BotAgent` + bottom-tier bot: random legal move
- [ ] Human-ish move delay curve (not fixed latency) on `BotAgent`, gated by `origin`
- [ ] Matchmaking lock: human-first, timeout fallback to closest-skill bot
      (touches `matchmakingQueue.js` — shared path with existing ranked/unranked logic)
- [ ] `direct_debug` PvE mode: pick a bot directly, skip queue, skip delay, no rating impact.
      Big win for debugging match logic and bot behavior in isolation.

At this point: full pipeline works end-to-end (flags, matchmaking, timing, rating)
independent of how smart the bot actually is.

### Phase 2 — Position evaluation & engine (dedicated session)

- [ ] Engine architecture — what a "strength dial" means (search depth? eval noise?
      move-ordering randomness at weak tiers?)
- [ ] Performance / concurrency model decided together with the engine, not bolted on
      later — worker threads vs main event loop, per-move time budget
- [ ] Multiple strength tiers built on top of the same evaluator

### Phase 3 — Population health

- [ ] EvE fast-sim path via `self_play_scheduler`: no PlayerAgent notification overhead
      needed (no human to notify), no wall-clock pacing. Can reuse `shared/engine/game.js`
      directly rather than the full match orchestration layer — no seamlessness
      requirement to protect here, only ruleset correctness.
- [ ] Scheduler cadence/backlog strategy for keeping bot ratings live
- [ ] Move variance for bots without a real eval-noise model (ties back to Phase 2)
- [ ] Occasional bot-for-human matchmaking at scale, to keep human ratings from going
      stale when there aren't enough humans online (lowest priority — different problem
      from Phase 1's sparsity fallback; this is about staleness at higher population)

### Phase 4 — Polish

- [ ] Generated human-like bot nicknames (debug names remain available/toggleable)

## Open questions (revisit when we get there)

- EvE execution path: how much of match.js/PlayerAgent machinery does the fast-sim
  runner actually reuse vs. reimplement directly against the rules engine?
- Bot skill-tier definitions once Phase 2 lands — how many tiers, how are they spaced
  across the rating range?
- Self-play scheduler cadence and how many concurrent EvE games are healthy vs. wasteful.
