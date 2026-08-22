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

## Phase 2 — Position evaluation & engine (in progress, one tier at a time)

Design discussion landed on a two-layer engine, driven by the actual structure
of the game rather than generic minimax:

- **Zones are impartial combinatorial games** (Conway/Berlekamp-Conway-Guy
  sense) — same move options for both players, strict local alternation,
  last player to move wins. In isolation, a zone's outcome is exactly solvable
  via backward induction/retrograde search over its occupancy state
  (realistic zones are small enough — ~30-50 cells, ~10 real moves deep once
  dead space is excluded — for this to be tractable, especially once the open
  area fragments into disconnected sub-regions, which lets the solver
  decompose via Sprague-Grundy and combine components by Grundy-XOR instead
  of searching the joint state space). The domino budget (capped at 2 per
  player match-wide) parameterizes a zone's solve rather than needing general
  resource-game machinery — enumerate the ≤9 `(dominoes-available-to-mover,
  dominoes-available-to-opponent)` combinations per zone state.
- **The global game is not a classical free disjunctive sum** — a zone locks
  a player out until `localTurn` comes back around to them (no "playing the
  same component twice while the opponent ignores it"), and the shared
  domino pool is the one real cross-zone coupling. This is why "traditional"
  score/material position evaluation doesn't work here — a zone one move from
  closing can matter more than raw point totals.
- **Playtesting surfaced real strategies that this framework explains rather
  than special-cases**: splitting a zone into two matching sub-regions to
  force a Tweedledum-Tweedledee mirroring win (exact search finds this for
  free — it *is* optimal play, no hand-coded pattern needed, though
  wall-avoiding placement — never touching a wall on your move — is worth
  keeping as an explicit move-ordering/weak-tier heuristic since it's what
  sets the split up in the first place); a zone that's already a guaranteed
  win for you is worth leaving open one step from closing rather than cashing
  it in immediately, since it's a free move-in-reserve for exactly the turn
  you'd otherwise have to pass or spend a domino on; opening the board's
  biggest zone is a tempo liability, not an advantage, since the opponent can
  simply never engage it and force you to run out of moves elsewhere first.
  This all lives at the global-coordinator layer, not the per-zone solver.
- **Zone creation uses the same solver, not a separate heuristic** — creating
  a zone is itself the zone's first move (anchor + flood fill happen
  together), so "where should I open a zone" is "solver-evaluate the
  resulting position for every candidate anchor/shape via `Zone.preview()`,
  prefer ones that come back as a guaranteed win."

**Tier ladder** (each one a real, shippable bot — "improve slightly every
time" rather than landing the full solver before anything ships):

1. `random-01` — uniform random. Shipped, Phase 1.
2. `no-waste-01` — uniform random, but never spends a domino unless every
   other piece type has zero legal placements. Shipped. See
   `server/bot/noWasteBot.js`.
3. `solver-greedy-01` — exact per-zone solver (`server/bot/zoneSolver.js`)
   + greedy zone selection (`server/bot/tier3Bot.js`). Shipped. Details below.
4. Tempo-aware coordinator — solver reports a "does this zone currently
   guarantee me an always-available move" flag; coordinator prefers holding
   near-won zones open and weighs new-zone tempo exposure, not just size.
   Not started. **Motivated by a real, measured gap** — see "known
   limitation" below.
5. Full endgame search — solve the whole remaining position exactly once
   few enough cells/zones remain. Not started.

Depth/noise variants within a tier (e.g. capped search depth, weighted-random
move selection instead of always-best) are additional dial settings on top of
this ladder, not separate tiers of their own.

### Tier 3 — the solver

`ZoneSolver` (`server/bot/zoneSolver.js`) deliberately excludes dominoes
from its model **entirely**, not just deprioritizes them — a zone is solved
as if only trominoes/tetrominoes exist, matching the coordinator rule that
dominoes are only even considered once every non-domino move anywhere is
exhausted. With the domino's shared, match-wide budget out of the picture,
a zone is a plain impartial combinatorial game with zero cross-region
coupling, so Sprague-Grundy decomposition applies exactly: a connected
component's Grundy number is solved fully independently of every other
component, and the position's outcome is the XOR of its components' numbers.
Decomposition is re-checked at every recursion node, not just the top level,
since a component very often fragments further mid-search as pieces get
placed inside it — that's where most of the real performance win comes from.

An earlier version tried to keep dominoes in the solver's model, with
decomposition worked around their shared budget. That coupling is a genuine,
non-trivial extension of Grundy theory (not a mechanical add-on) and was
dropped in favor of the domino-free model above, once the coordinator design
made "ignore dominoes until they're the only moves left, anywhere" the
actual rule rather than just a per-move preference.

**Correctness**: verified against an independent, unoptimized brute-force
joint-state search (no decomposition, no Grundy numbers) across 40 randomly
generated small shapes — zero mismatches. Also verified directly against the
motivating strategies from playtesting: two matching tromino-only regions
force a mover loss (mirroring/pairing), three matching regions flip it back
to a mover win (parity), and domino-scarcity (one side out, one side not)
correctly changes the outcome.

**Performance**: a connected component above `maxBlobSize` (default 12,
tunable per `ZoneSolver` construction) returns `null` (undetermined) rather
than being fully searched — this check happens *after* decomposition, on
each component individually, which is what makes a large-but-fragmented zone
solvable regardless of its raw open-cell count. `maxTotalCells` (default
10000) is a separate, purely defensive ceiling against pathological input
(e.g. an extreme custom zone radius) blowing up the one-time linear setup
cost — it does **not** decide solvability and is set high enough that it
should never fire on any realistic zone. (An earlier version of this ceiling
was set far too low — 300 — and gated on raw open-cell count *before*
decomposition ran at all, which meant a large zone that was mostly filled in
with only small scattered fragments left got incorrectly reported
"uncertain" purely because of its total count, even though every individual
fragment would have solved instantly. Fixed and verified: a 400-open-cell
zone made of 200 disconnected dead pairs, and a 300-open-cell zone made of
100 tromino-shaped fragments, both now resolve correctly in milliseconds.) A
fresh, fully-open zone at Classic's zone radius (up to ~80 cells, one big
unfragmented blob) still correctly and instantly bails out to `null` on the
`maxBlobSize` check — it's only once a zone has actually been played into
for a while, and fragments into small independent pieces, that `solveFull()`
determines an answer, typically in low single-digit milliseconds even for a
~28-open-cell midgame zone. A genuinely pathological zone (tested at 22,500
cells) still returns `null` in well under 50ms with no exception. The one
genuinely slow (but still bounded, non-crashing) case that remains is a
large, *fully open, never-fragmented* blob within `maxBlobSize` (a
fully-open 25-cell square took 2.5s in testing) — exactly the case
`maxBlobSize` exists to reject rather than attempt.

### Tier 3 — the coordinator, now a configurable bot family

`createSolverGreedyBot(config)` (`server/bot/tier3Bot.js`) builds a
`chooseMove` function from a config object, so the same core algorithm can
produce a whole family of bots that differ only in their tie-break
preferences — not a single fixed bot. `tier3BotMove` (still exported, still
`"solver-greedy-01"` in `botRegistry.js`) is just `createSolverGreedyBot()`
with defaults matching the original behavior.

**Every ordering decision, and which ones are dials vs. fixed rules** (see
`DEFAULT_CONFIG`'s own comment in the source for the numbered list):

1. Among multiple winnable *active* zones — `zoneSelection.winnableActive`
   (default `"random"`).
2. Among multiple winnable zone-*creation* candidates — **fixed** `"biggest"`
   (not exposed; paired with #4, see below).
3. Among multiple uncertain creation candidates — `zoneSelection.creationUncertain`
   (default `"random"`).
4. Among multiple lost creation candidates — **fixed** `"smallest"` (not
   exposed). #2 and #4 are kept as one fixed rule rather than two
   independent dials on purpose — a big *won* zone is a bonus, a big *lost*
   zone is a tempo trap you shouldn't have handed the opponent in the first
   place (see the design chat on strategy #2), so decoupling them would let
   a config accidentally prefer creating big zones even when losing them.
5. Among multiple uncertain active zones — `zoneSelection.uncertainActive`
   (default `"random"`).
6. Among multiple lost active zones — `zoneSelection.lostActive` (default
   `"random"`).
7. Among multiple domino-fallback targets — `zoneSelection.dominoFallback`
   (default `"biggest"`).
8. Which winning move to play within an already-winnable zone — no dial.
   Any winning move is equivalent under the current domino-free model, so
   whichever `findWinningMove()` happens to return stands. Will matter once
   the solver can compare remaining domino-shaped spots between candidate
   winning lines — not yet.
9. Which move to try first in an uncertain/lost zone — `avoidLosingMove`
   (`{ enabled, maxTries }`, default `{ enabled: true, maxTries: 15 }`). See
   below.

Selection strategies 1/3/5/6/7 each independently take `"random"`,
`"smallest"`, or `"biggest"` (by zone/candidate cost) via a shared
`selectByStrategy` helper — a config can mix strategies across decisions
freely (e.g. random for active zones, biggest for creation).

**Decision 9 — `pickMoveAvoidingLoss`**: within a chosen uncertain/lost
zone, tries up to `maxTries` of its real legal moves in random order,
solving the resulting position each time. If any move outright **wins**
(the opponent, now mover, provably loses), it's taken immediately — this
isn't just loss-avoidance, it can genuinely find a win the top-level zone
classification missed, since a zone is only "uncertain" because its *full*
open-cell mask was too large to solve, but one specific move can
shrink/fragment it into something the solver resolves cleanly. If no
winning move turns up in the sample, a move that's at least still
"uncertain" is preferred over a provable loss; if every sampled move is a
provable loss, the last one tried is returned regardless — still strictly
better than passing.

**Strength dials**: `maxBlobSize` and `avoidLosingMove.maxTries` aren't
just tie-break preferences like the `zoneSelection` options above — both
trade real playing strength for compute, the same role a search-depth limit
plays in a traditional engine. `maxBlobSize` controls how large an
unfragmented region the solver will fully search before giving up
("uncertain") — higher is strictly stronger (solves more positions
exactly) but hits a genuine exponential wall (see `zoneSolver.js`'s own
performance notes). `avoidLosingMove.maxTries` controls how many of a
zone's real candidate moves get checked before giving up and taking
whatever was tried last — higher is stronger (more likely to find a hidden
win or dodge a provable loss) at a cost that's linear, not exponential,
in `maxTries`. Both are natural levers for building weaker/stronger
variants within this bot family, alongside the `zoneSelection` tie-breaks.

**Priority order** (fixed across the whole family — only the tie-breaks
within each step are configurable):

1. An active zone (bot's own local turn) already provably winnable — play a
   winning move there.
2. Otherwise, try to **create** a zone — prefer a provably winnable one
   (biggest first), then any uncertain one, then the smallest provably lost
   one. Note the inversion here versus step 1: creating a zone hands the
   very next local turn to the *opponent* (`Zone.create` sets
   `localTurn = 1 - creator`), so "good to create" means solving the
   resulting position with the **opponent** as mover and wanting them to
   lose — the solver's win/loss sense is deliberately flipped for this case.
   `Zone.floodFill`'s result depends only on the anchor cell and radius, not
   the piece shape placed there, so evaluation only needs one flood-fill per
   distinct candidate anchor, reused across every shape variant anchored
   there.
3. Otherwise, an uncertain active zone **that currently has a real
   non-domino move available** — see the bug fix below for why this
   qualifier matters.
4. Otherwise, a lost active zone with a real move available (still better
   than passing or spending a domino).
5. Otherwise, dominoes are the only moves left anywhere — either in an
   existing active zone, or by **creating** a brand-new one (see the second
   bug fix below).
6. Otherwise, no legal move exists at all anywhere — pass. Confirmed this is
   the only condition under which the coordinator should ever pass, per the
   rules (a pass is never a strategic choice this bot makes).

#### Two real bugs found and fixed during this refactor

**Bug 1 — zone selected before checking it has a move.** Steps 3 and 4 used
to pick a *single* zone at random from the whole uncertain/lost bucket
*before* checking whether that specific zone currently has a non-domino
move — and a "lost" zone can legitimately have zero moves at all (that's
often *why* it's lost, e.g. a single leftover dead cell). If the unlucky
zone got picked, the code fell straight through to the domino fallback even
when a *different* zone in the very same bucket had a perfectly good move
sitting there. Fixed by filtering every zone in a bucket down to those with
a real move available *before* applying any selection strategy, not after.

**Bug 2 — dominoes can create zones too, and nothing accounted for it.**
`Rules.canPlaceHere` has no restriction against a domino placement creating
a brand-new zone — the only domino-specific check is the domino-budget
test. `zoneCreationCandidates` deliberately excludes dominoes (by design —
dominoes are supposed to be the absolute last resort), and the domino
fallback step only ever scanned *existing* zones, never unzoned floor. So
if the *only* legal moves left anywhere were dominoes opening brand-new
zones, the bot found nothing in either place and incorrectly passed, even
though `canCurrentPlayerMove()` correctly reported a move existed. Fixed
with a new `dominoCreationCandidates` (parallel to the non-domino version,
but for dominoes specifically, cost-ranked only — no win/loss
classification needed since this only runs once every better option is
exhausted).

**How these were found**: introducing per-decision configurability
surfaced a *third*, unrelated bug (see below) whose live diagnostics led
directly to bug 2. Bug 1 was identified by code inspection while designing
the fix for bug 2's neighbors, and structurally can't recur now (the fix
filters before selecting, not after) — a live reproduction of the exact
scenario originally reported in play was not obtained (150-game batch
search came up empty), so if it resurfaces, the exact game/seed/move number
would help pin it down further.

**Bug 3 (introduced and fixed within this same session) — wrong config
shape passed to `pickMoveAvoidingLoss`.** The call site passed the whole
`cfg` object, but the function destructures `{ maxBlobSize, maxTries }`
directly from its options argument — `maxTries` actually lives at
`cfg.avoidLosingMove.maxTries`, not `cfg.maxTries`. `Math.min(undefined,
moves.length)` → `NaN` → `.slice(0, NaN)` silently produces an **empty
array** (per spec, `NaN` as a slice argument coerces to `0`), so the
sampling loop never ran and the function returned `null` despite having
real moves available — even under the *default* config, since
`avoidLosingMove.enabled` defaults to `true`. This explains both a stuck
game (500-move cap hit, zero score) and a dip in measured win rate found
while re-testing after the refactor. Fixed by passing
`{ maxBlobSize: cfg.maxBlobSize, maxTries: cfg.avoidLosingMove.maxTries }`
explicitly at both call sites.

**Verified after all three fixes**: 60 self-play games across three
batches (10 games with an aggressive all-`"smallest"` custom config
exercising the exact previously-stuck scenarios, a 30-seed default-config
sweep, and a 10-seed P0/P1 seat-swap check) — zero illegal moves, zero
incorrect passes (every pass cross-checked against
`canCurrentPlayerMove()`), every game reaches completion. Win rate against
tier 2 (`no-waste`) is now 30/30 in the sweep and 10/10 in both seats —
higher than the previously-reported 19/20, consistent with
`pickMoveAvoidingLoss` actually running now instead of silently no-oping.

**Known limitation, motivating tier 4**: tier-3-vs-tier-3 self-play shows a
real, substantial *second-mover* advantage (P1 won 7/10 in earlier testing,
several by wide margins). This isn't a bug — it's the direct, expected
consequence of the coordinator having no cross-zone tempo reasoning yet.
It's greedy zone-by-zone and has no notion of strategy #2 (never engage the
opponent's biggest zone, starve them into passing/spending a domino instead)
or #3 (leave an already-won zone open one move from closing, as banked
tempo) — exactly what tier 4 needs to add.

**Known cost, not yet addressed**: the very first move of a fresh game (a
fully unzoned board — every zone-creation candidate anchor needs a flood
fill) took ~880ms in testing; every subsequent move stayed well under that.
One-time cost, not a per-move problem, but worth knowing about when
`botThinkDelayMs()` pacing is revisited.

**Adding a new tier**: write the `(game, playerIndex) -> move | null`
function, register it in `server/bot/botRegistry.js`'s
`CHOOSE_MOVE_BY_KEY`, add a `{ key, nickname }` entry to
`server/scripts/seedBots.js`, run the seed script. A bot player row's
`botKey` is recovered from its `google_sub` (`bot:${botKey}`) via
`botKeyFromRow()` in `botRepository.js` — this is how `index.js` picks the
right `chooseMove` for whichever bot row `pickClosestBot()`/`PLAY_BOT_REQUEST`
resolved to, without hardcoding a single bot everywhere the way Phase 1 did.

Performance/concurrency: staying on the main event loop for now (no worker
threads) — exact zone solving is only expensive for wide-open zones, which is
exactly where tier 3+ should fall back to a depth/state cap rather than fully
solving anyway. Revisit if real numbers ever show main-thread blocking.

`botThinkDelayMs()` still has no concept of real search time. Direction
agreed: weak tiers scale delay with legal move count (already true today via
the random pacing); smarter tiers should scale with move *complexity* —
proposed as the eval spread between the best and second-best candidate move
(decisive vs. close call) rather than raw search node count, since it mirrors
how a real player actually hesitates. Not implemented yet — no tier has a
real eval to take a spread from until tier 3 lands.

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