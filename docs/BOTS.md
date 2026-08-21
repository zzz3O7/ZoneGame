# Bots & Matchmaking — Design Doc

Status: Phase 0 and Phase 1 complete and deployed. Phase 2 (real position
evaluation) is next, intended as its own dedicated session — this doc is
written to be a complete handoff for that session to start cold.

## Problem

New users hitting an empty matchmaking queue. Need bot opponents that are seamless,
gameable at multiple strengths, and don't corrupt the rating system or human-only stats.

## Core abstraction: PlayerAgent

`match.js` / `matchManager.js` never know whether they're talking to a human or a bot.
They talk to a `PlayerAgent` only, defined in `server/playerAgent.js`.

**Actual interface (simpler than originally sketched):**

```
PlayerAgent
  send(msg)   // the only method Match ever calls
```

That's it. No `submitIntent`/`notifyYourTurn`/etc. — `Match` broadcasts protocol
messages the exact same way to every player regardless of type, via
`_sendTo(agent, msg)` / `agent.send(msg)`. A human's moves arrive over the real
WebSocket and get forwarded into `match.attemptMove()`/`attemptPass()` by
`server/index.js`'s message handlers; a bot calls those same `Match` methods
directly, using itself (`this`) as the agent for identity lookups
(`match.players.find(p => p.agent === this)`).

- **`HumanAgent`** — wraps a live WebSocket. `send(msg)` guards against a
  closed/null socket and serializes to JSON.
- **`BotAgent`** — constructed with a direct `Match` reference and an injected
  `chooseMove(game, playerIndex)` function. Reacts to `send(msg)` by:
  - `MATCH_START` / `MOVE_APPLIED` (non-terminal) → schedules a "think" via
    `_maybeThink()`, which checks whether it's actually this bot's turn before
    scheduling anything.
  - `MOVE_APPLIED` with `gameOver: true`, or `MATCH_ENDED` → `_onGameOver()`
    (see rematch/leave behavior below).
  - `OPPONENT_LEFT` → clears any pending timers.
  - `OPPONENT_WANTS_REMATCH` → see below.

Match code has zero branching on player type — no `if (isBot)` anywhere in
`match.js`. This is what makes bot play seamless: not by faking a socket, but
because there is structurally one path a move can take into the engine
regardless of source. Also the extension point for any future non-human agent
(hint bot, replay/analysis agent, etc.) without touching match code again.

Disconnect/reconnect/abort-timeout are deliberately **not** part of the
`PlayerAgent` interface — they're human-specific concepts `Match` itself tracks
via `player.connected`, driven by `handleDisconnect()`/`reconnect()` being
called (or not) from `index.js`. A `BotAgent` is simply never subject to those
calls, so it reads as permanently connected with no special-casing.

## Classification fields

Two independent fields on `match`, answering two different questions. Both
persisted to the `games` table (see Schema below).

### `match.matchType` — `'pvp' | 'pve' | 'eve'`

Who is playing. Drives leaderboard inclusion, rating-weight training on
human-only games, stats queries. (`eve` isn't wired up anywhere yet — Phase 3.)

### `match.origin` — `'matchmaking' | 'direct_debug' | 'self_play_scheduler'`

How the match was entered. Drives side effects:

- move-pacing delay (on for `matchmaking`, off for `direct_debug`)
- rating impact (off only for `direct_debug`)
- bot post-game behavior (accept-and-linger vs. leave-after-a-pause)
- queue involvement

(`self_play_scheduler` isn't wired up anywhere yet — Phase 3.)

### `player.isBot`

Lives on the player row (`is_bot` column), independent of any specific match.
Bots are real rows in `players` with real `rating_mu`/`rating_sigma` — not a
separate table — so the existing rating pipeline treats them identically to
humans with zero special-casing. Used to exclude bots from player lists,
leaderboards, etc.

### Decided combinations (all implemented)

| match_type | origin               | delay        | rating impact | rematch behavior                             |
| ---------- | --------------------- | ------------ | -------------- | --------------------------------------------- |
| pvp        | matchmaking            | n/a (human)  | yes            | normal — either side can request              |
| pve        | matchmaking            | human-pacing | yes            | bot never accepts; leaves 1–5s after game end |
| pve        | direct_debug           | none         | **no**         | bot always accepts instantly; lingers otherwise |
| eve        | self_play_scheduler    | n/a (Phase 3, not implemented) | yes  | n/a                                    |

---

## What's actually built (Phase 0 + Phase 1, complete)

### Files

```
server/playerAgent.js          HumanAgent, BotAgent
server/bot/botConfig.js        all tunable constants (see below)
server/bot/botTiming.js        botThinkDelayMs() — clock-aware move delay
server/bot/randomBot.js        randomBotMove() — Phase 1's only strength tier
server/bot/botRepository.js    findOrCreateBotPlayer, listBotPlayers, pickClosestBot
server/scripts/seedBots.js     manual, idempotent, run after deploy — not auto-run
shared/engine/rules.js         + Rules.allLegalPlacements() (board-wide move enumeration)
```

### Bot decision-making

`randomBotMove(game, playerIndex)` — uniformly random among
`Rules.allLegalPlacements()`. Deliberately dumb; Phase 1 was about proving the
pipeline, not bot strength. `BotAgent` takes `chooseMove` as a constructor
argument specifically so Phase 2 can swap in a real evaluator without touching
`BotAgent` itself.

### Move timing (`botTiming.js`)

```js
botThinkDelayMs({ clock, playerIndex, origin, now })
```

- `direct_debug` → always `0` (debug mode shouldn't waste time).
- No clock on the match → random delay in
  `[BOT_THINK_MIN_MS, BOT_THINK_MIN_MS + BOT_THINK_RANGE_MS)`.
- Clock present → same random base, but clamped so the bot never spends more
  than `BOT_MAX_THINK_FRACTION` of whatever's left beyond `BOT_MIN_BANK_MS` —
  a bot can never lose on time purely because of its own artificial pacing;
  the delay shrinks toward zero on its own as the clock gets low.

Current tuned values (`server/bot/botConfig.js`):

```js
BOT_THINK_MIN_MS = 1000
BOT_THINK_RANGE_MS = 9000      // up to ~10s per move on an untimed match
BOT_MIN_BANK_MS = 1000
BOT_MAX_THINK_FRACTION = 0.5
```

### Matchmaking fallback (human-first lock)

`matchmakingQueue.js`'s `expireStale(now, maxWaitMs)` reports (but does
**not** remove) any queued entry that's waited past `MATCHMAKING_BOT_FALLBACK_MS`
(currently `10_000`ms) — returns `[entry, resolvedTimeMode, rated, remove]`
tuples. The caller (`index.js`'s sweep tick, right after the normal `sweep()`
human-pairing pass) only calls `remove()` once it's actually found a bot to
fall back to via `pickClosestBot(entry.mu)`. **If no bot exists yet
(`seedBots.js` never run), the entry is left queued exactly as it was** —
it keeps getting a fair shot at a human pair on every subsequent sweep tick,
rather than being silently dropped. This was a real bug caught during
testing, not a hypothetical.

### `direct_debug` PvE mode

New protocol messages (`shared/net/protocol.js`):

- `BOT_LIST_REQUEST` / `BOT_LIST` — client asks for available bots
  (`{ id, nickname, rating }[]`), used to populate the Bots tab.
- `PLAY_BOT_REQUEST` (`{ botId, nickname, params }`) → `matchManager.createPvEMatch()`
  builds a match directly (no invite-code round trip, no queue), always
  `rated: false`, `origin: "direct_debug"`.

`matchManager.createPvEMatch({ humanNickname, humanAgent, humanAccountPlayerId,
botNickname, botAccountPlayerId, makeBotAgent, params, rated, origin })` —
builds the `Match` first, then calls `makeBotAgent(match)` (so the `BotAgent`
has a real match reference from construction), then adds both players. Only
the human gets bound for reconnect — a bot never disconnects, nothing to
reconnect into.

### Bot post-game behavior (rematch / leave)

In `BotAgent._onGameOver()`:

- **`direct_debug`**: does nothing on its own. Reacts to
  `OPPONENT_WANTS_REMATCH` by immediately calling `match.requestRematch(this)`
  — always accepts, instantly. Otherwise just sits there.
- **Every other origin**: schedules `match.leave(this)` after a random delay
  in `[BOT_LEAVE_MIN_MS, BOT_LEAVE_MIN_MS + BOT_LEAVE_RANGE_MS)` (currently
  1–10s) and ignores `OPPONENT_WANTS_REMATCH` entirely. Neither vanishing
  instantly nor sitting there indefinitely reads as a real player — the
  randomized pause is what avoids breaking the illusion either direction.

An earlier version gave `direct_debug` bots their own long idle-timeout so an
abandoned tab wouldn't hold the match in memory forever. That was **removed**
in favor of a general fix at the `Match` level instead (see next section) —
cleaner, and it turned out to be a real gap for plain PvP too, not just bots.

### Universal post-game idle cleanup (not bot-specific, but found via bot testing)

`Match` now arms `MATCH_POST_GAME_IDLE_MS` (5 minutes) whenever a game ends in
`"over"` status (`_armPostGameIdleTimer()`, called from `_logMatchEnd`). If
nobody's requested a rematch and nobody's disconnected by the time it fires,
`_onPostGameIdle()` broadcasts `OPPONENT_LEFT` to whoever's still connected
(could be both sides — unlike `leave()`/disconnect-abort, nobody necessarily
triggered this, so it can't assume "the other one" is the audience) and closes
the match. Cleared whenever a real rematch starts or someone explicitly
leaves. Applies to every match — PvP, PvE, EvE alike.

This closed a genuine resource leak: previously, two humans finishing a game
and just leaving the tab open — no disconnect, no rematch, no explicit leave —
held the match in server memory forever. Nothing timed that out. Confirmed via
a from-scratch test with zero bots involved.

### Client UI (Bots tab)

`client/index.html`/`menu.js`/`main.js`/`matchClient.js` — new "Bots" tab
(ordered: Local, Bots, Create, Join, Quick play, Ranked). Bot picker + full
board/time-control section (reusing the same `_makeBoardSection()` pattern as
Local/Create, including Custom board + seed) + nickname + Play button.

Connection lifecycle: browsing the Bots tab opens a connection just to fetch
the list, kept deliberately separate from `currentConnection`/
`currentMatchClient` until Play is actually clicked (so idly browsing can
never clobber an unrelated in-progress flow elsewhere in the menu). Any other
flow started while a bots-list connection is open closes it first
(`closeDanglingBrowsingConnections()` — shared with the join-preview flow
below, itself unrelated to bots but built in the same pass).

Returning to the menu re-fetches the bot list if the Bots tab happens to
already be the active one (`showScreen()` calls
`menu.refreshBotsTabIfActive()`) — needed because nothing else re-triggers a
tab-select event if the tab was never actually re-clicked, which otherwise
left Play silently pointing at an already-consumed connection after a
previous bot match.

### Rated-match integrity (adjacent to bot work, not bot-specific)

Landed alongside Phase 1 because it came up directly while building the Bots
tab and the Create-match rated toggle:

- **Rated matches are restricted to the Classic board + a recognized timed
  preset** (bullet/blitz/rapid/classical — not "no clock", not "custom").
  Enforced server-side in `CREATE_MATCH` (authoritative) and mirrored
  client-side in `Menu`'s `isRatable()` check for the toggle's disabled state.
  Reasoning: an arbitrary custom board/clock isn't comparable to any other
  rated game, which breaks the rating system's core assumption and blocks
  ever splitting ratings per-mode later. Watch out for `TIME_PRESETS.none` —
  it's a real, truthy entry (the no-clock sentinel), so this needs an
  explicit exclusion, not a plain truthiness check. Got this wrong on the
  first pass; both server and client versions were fixed the same way.
- **Self-challenge prevention for rated invite-code matches** —
  `matchManager.joinMatch()` now rejects joining your own rated match (same
  `accountPlayerId` as the creator). Matchmaking already prevented this by
  construction; invite-code play didn't.
- **An explicitly-specified custom seed now survives rematches** — `Match`
  reads the seed from `this.params` (the original, never-mutated config)
  rather than always regenerating with `Date.now()` on every `_start()` call.
  A specified seed stays fixed across every game the `Match` plays, rematches
  included; no seed specified still gets a fresh one every game, same as
  before. This was a **pre-existing bug** (affecting Create/Join/Quick
  Play/Ranked too, not just Bots) surfaced while testing the Bots tab's
  Custom-seed field.
- **Join preview screen** — `MATCH_PREVIEW_REQUEST`/`MATCH_PREVIEW` lets a
  joiner see board/time params, rated status, and the creator's nickname
  before actually seating themselves, with Accept/Decline. No server-side
  "decline" message exists by design — declining just means never sending
  `JOIN_MATCH`; the creator's match keeps waiting untouched.

### Schema migration pattern (now established, reusable for any future column)

`server/db.js` — `CREATE TABLE IF NOT EXISTS` alone doesn't retrofit a table
that already exists (the real VPS `zonegame.db` predates `is_bot`/
`match_type`/`origin`). Added `addColumnIfMissing(table, columnDef)`: tries
`ALTER TABLE ... ADD COLUMN`, catches and ignores the "duplicate column name"
error, throws anything else. Safe to run on every boot, self-healing schema.
**New tables**: `CREATE TABLE IF NOT EXISTS` already handles this correctly,
no extra step. **New columns** on an existing table: add one
`addColumnIfMissing(...)` call, append-only, forever. Doesn't help with
column type changes or drops — those still need a real one-off migration
(create-copy-drop-rename), same as with any migration tool.

---

## Phase 2 — Position evaluation & engine (dedicated session, not started)

- [ ] Engine architecture — what a "strength dial" means (search depth? eval noise?
      move-ordering randomness at weak tiers?)
- [ ] Performance / concurrency model decided together with the engine, not bolted on
      later — worker threads vs main event loop, per-move time budget
- [ ] Multiple strength tiers built on top of the same evaluator

**Starting point for this session**: `randomBotMove(game, playerIndex)` in
`server/bot/randomBot.js` is the only thing that needs replacing/extending —
its signature (`(game, playerIndex) -> move | null`) is exactly what
`BotAgent` expects via its injected `chooseMove`. `Rules.allLegalPlacements()`
already exists as the move-enumeration primitive a real evaluator would score
against. `botThinkDelayMs()` currently has no concept of "how long did the
engine actually take to think" — worth deciding whether real search time
replaces the artificial random delay, or layers with it.

## Phase 3 — Population health (not started)

- [ ] EvE fast-sim path via `self_play_scheduler`: no PlayerAgent notification overhead
      needed (no human to notify), no wall-clock pacing. Can reuse `shared/engine/game.js`
      directly rather than the full match orchestration layer — no seamlessness
      requirement to protect here, only ruleset correctness.
- [ ] Scheduler cadence/backlog strategy for keeping bot ratings live
- [ ] Move variance for bots without a real eval-noise model (ties back to Phase 2)
- [ ] Occasional bot-for-human matchmaking at scale, to keep human ratings from going
      stale when there aren't enough humans online (lowest priority — different problem
      from Phase 1's sparsity fallback; this is about staleness at higher population)

## Phase 4 — Polish (not started)

- [ ] Generated human-like bot nicknames (debug names remain available/toggleable)

## Open questions (revisit when we get there)

- EvE execution path: how much of match.js/PlayerAgent machinery does the fast-sim
  runner actually reuse vs. reimplement directly against the rules engine?
- Bot skill-tier definitions once Phase 2 lands — how many tiers, how are they spaced
  across the rating range?
- Self-play scheduler cadence and how many concurrent EvE games are healthy vs. wasteful.
- Does `pve` via `matchmaking` origin ever need a "no rating impact" variant? Current
  answer is no — only `direct_debug` is exempt, a matchmaking-sourced fallback is a
  real match and should count — but worth re-confirming once real bot strength exists
  and rating impact actually matters in practice.