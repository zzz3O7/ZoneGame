import { extrapolateRemaining, formatClockMs, Clock, LOW_TIME_THRESHOLD_MS } from "../../../shared/clock.js";

// How often the online clock display re-paints between authoritative
// server snapshots. Display-only — how smooth the ticking looks.
const CLOCK_TICK_INTERVAL_MS = 100;

// This is deliberately display-only for the online path: it never decides a
// flag-fall (that's server-authoritative, see Match._onFlagFall), it
// just paints whatever the latest snapshot implies "right now" looks
// like, re-extrapolated on every tick from snapshot.now so it stays
// smooth between the (much sparser) authoritative corrections that
// arrive on every MOVE_APPLIED/MATCH_START/sync.
//
// Hotseat has no server at all, so this controller is authoritative there
// — it owns a real Clock (ui.clock) and runs the exact same
// startTurn/stopTurn/flag-fall shape Match does, just locally.
export class ClockController {
  constructor(ui) {
    this.ui = ui;
  }

  startClockTicker() {
    const { ui } = this;
    clearInterval(ui._clockInterval);
    clearTimeout(ui._hotseatFlagTimer);

    if (ui.matchClient) {
      ui._clockInterval = setInterval(() => this.tickClocks(), CLOCK_TICK_INTERVAL_MS);
      return;
    }

    if (ui.game.timeControl) {
      ui.clock = Clock.fromConfig(ui.game.timeControl);
      const now = Date.now();
      ui.clock.startTurn(ui.game.currentPlayerIndex, now);
      this._armHotseatFlagTimer(now);
      ui._clockInterval = setInterval(() => this.tickClocks(), CLOCK_TICK_INTERVAL_MS);
    }
    // else: no time control at all — render()'s one-shot tickClocks()
    // call still paints the "--:--" placeholder, no interval needed.
  }

  tickClocks() {
    const { ui } = this;
    const now = Date.now();
    // Online: read the server's latest broadcast snapshot. Hotseat: ask our
    // own Clock to extrapolate one, in the exact same shape (see
    // Clock#snapshot) — so _renderClockFor below can't tell the difference.
    const snapshot = ui.matchClient ? (ui.matchClient.clock ?? null) : (ui.clock?.snapshot(now) ?? null);
    ui.game.players.forEach((player) => this._renderClockFor(player.id, snapshot, now));
  }

  // Mirrors Match._advanceClockAfterMove exactly, just local instead of over a websocket. Called
  // right after a successful hotseat move/pass, once currentPlayerIndex has already advanced.
  advanceHotseatClock() {
    const { ui } = this;
    if (!ui.clock) return;
    clearTimeout(ui._hotseatFlagTimer); // was armed for the mover's own turn — stale now regardless of outcome
    const now = Date.now();
    ui.clock.stopTurn(now);
    if (!ui.game.gameOver) {
      ui.clock.startTurn(ui.game.currentPlayerIndex, now);
      this._armHotseatFlagTimer(now);
    }
  }

  // Mirrors Match._armFlagTimer exactly.
  _armHotseatFlagTimer(now) {
    const { ui } = this;
    clearTimeout(ui._hotseatFlagTimer);
    if (!ui.clock || ui.clock.currentPlayerIndex === null) return;
    const remaining = ui.clock.getRemaining(ui.clock.currentPlayerIndex, now);
    ui._hotseatFlagTimer = setTimeout(() => this._onHotseatFlagFall(), remaining);
  }

  // Mirrors Match._onFlagFall exactly, including the same
  // setTimeout-slop re-verification. Ends the game the same way an online
  // forfeit does — via showForcedEnd, so the endcard's winner/reason don't
  // go through Game.winnerIndex's score-comparison getter.
  _onHotseatFlagFall() {
    const { ui } = this;
    if (!ui.clock || ui.clock.currentPlayerIndex === null || ui.game.gameOver) return;

    const now = Date.now();
    if (!ui.clock.isFlagged(now)) {
      this._armHotseatFlagTimer(now);
      return;
    }

    const flaggedIndex = ui.clock.currentPlayerIndex;
    ui.clock.freeze(now); // no increment — running out isn't a completed move
    ui.endcard.showForcedEnd({ reason: "timeout", winnerIndex: 1 - flaggedIndex });
  }

  _renderClockFor(playerId, snapshot, now) {
    const { ui } = this;
    const myIndex = ui.matchClient ? ui.matchClient.myPlayerIndex : 0;
    const plate = document.querySelector(`.side-plate[data-position="${playerId === myIndex ? "self" : "opponent"}"]`);
    const clockEl = plate?.querySelector(".side-plate__clock");
    if (!clockEl) return;

    if (!snapshot) {
      clockEl.textContent = "--:--";
      clockEl.classList.remove("side-plate__clock--low");
      return;
    }

    const remaining = extrapolateRemaining(snapshot, playerId, now);
    clockEl.textContent = formatClockMs(remaining);

    // Turn-based styling (.side-plate--active) already exists and covers
    // "is this the ticking player" via RenderSync._syncSidePlate — --low only
    // adds the extra "and they're running out" urgency state on top of that.
    const isTicking = playerId === snapshot.currentPlayerIndex;
    const isLow = isTicking && remaining <= LOW_TIME_THRESHOLD_MS;
    clockEl.classList.toggle("side-plate__clock--low", isLow);

    // Warn once per crossing. Online: only the viewer's own clock. Hotseat:
    // whoever's actually ticking — shared screen, so both players' own
    // countdowns matter, not just player 0's. See _lowTimeWarned reset in
    // RenderSync.render() (fires again next time they're low).
    const warnsFor = ui.matchClient ? myIndex : snapshot.currentPlayerIndex;
    if (isLow && playerId === warnsFor && !ui._lowTimeWarned[playerId]) {
      ui._lowTimeWarned[playerId] = true;
      ui.sound.lowTime();
    }
  }
}
