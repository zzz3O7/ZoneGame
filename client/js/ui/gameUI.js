import { Shape, SHAPES_BASE } from "../../../shared/engine/shape.js";
import { formatTimeControlLabel } from "../../../shared/clock.js";
import { GestureInput } from "../input/gestureInput.js";
import { CalcDrawing } from "../input/calcDrawing.js";
import { ZoneTooltip } from "./zoneTooltip.js";
import { HistoryPanel } from "./historyPanel.js";
import { sound } from "../audio/soundManager.js";
import { InputController } from "./gameUIInput.js";
import { RenderSync } from "./gameUIRender.js";
import { ClockController } from "./gameUIClock.js";
import { EndcardController } from "./gameUIEndcard.js";
import * as localGameStore from "../localGameStore.js";

const KEY_TO_TYPE = { 1: "gesture", 2: "domino", 3: "tromino", 4: "tetromino", 5: "calc" };

// GameUI is the orchestrator and single source of truth for all UI state —
// it owns every piece of state below directly. The actual logic for each
// concern (pointer/touch input, DOM/canvas rendering, clock ticking, the
// endgame/rematch flow) lives in the four sub-controllers constructed
// below (this.input / this.render / this.clockCtrl / this.endcard), each
// of which reads and writes this state directly rather than holding its
// own copy. See gameUIInput.js / gameUIRender.js / gameUIClock.js /
// gameUIEndcard.js.
export class GameUI {
  constructor(game, renderer, canvas, matchClient = null, resumeClockSnapshot = null) {
    this.game = game;
    this.renderer = renderer;
    this.canvas = canvas;
    this.matchClient = matchClient; // null = local hotseat
    this._resumeClockSnapshot = resumeClockSnapshot; // consumed once by ClockController.startClockTicker() — see localGameStore.js

    // main.js reuses the same #board-canvas / document / control buttons
    // across matches instead of recreating them, so every listener this
    // instance registers must be revocable in one shot via destroy()
    this._abort = new AbortController();

    this.selectedType = "gesture";
    this.rotationStep = 0;
    this.flipped = false;
    this.cursorCell = null;
    this._placementLocked = false; // requireConfirm: a plain piece was staged by a click and should survive further mouse movement until Confirm/Discard resolves it

    // Board-local pinch-zoom/pan (mobile). Lives entirely as a CSS transform
    // on the canvas, clipped by .board-wrap's overflow:hidden — the board's
    // on-page footprint never changes, only what's visible inside it.
    // _cellFromPoint needs no awareness of this: getBoundingClientRect()
    // already reflects the live transform.
    this.viewTransform = { scale: 1, x: 0, y: 0 };
    this._pinch = null; // { dist, midX, midY } while 2+ touches are down
    this._pendingTouch = null; // { cell } during the pinch-disambiguation delay
    this._pendingTouchTimer = null;
    this._suppressHoverUntilLift = false; // true for a leftover finger after a pinch ends
    this._touchStartInfo = null; // { x, y, time } of the current single touch, for tap detection
    this._lastTap = null; // { time, x, y } of the previous qualifying tap, for double-tap

    this.gesture = new GestureInput();
    this.calcDrawing = new CalcDrawing(); // desktop-only planning overlay — see selectType("calc")
    this.zoneTooltip = new ZoneTooltip(canvas);

    this.hoveredMoveIndex = null;
    this.hoveredZoneIds = null;
    this.historyPanelHovered = false;

    this._endOverride = null; // set via showForcedEnd() for a forfeit — see gameUIEndcard.js
    this._peekingBoard = false; // toggled via btnPeekBoard — see EndcardController.toggleBoardPeek
    this._clockInterval = null; // see ClockController/destroy

    this.sound = sound; // shared page-level singleton — see soundManager.js
    // Edge-detection flags — render()/tickClocks() re-derive DOM state
    // every cycle, but these sounds should only fire once per transition,
    // not replay on every idempotent redraw.
    this._gameOverSoundPlayed = game.gameOver; // already-over game (e.g. reconnect into a finished match) shouldn't fanfare on load
    this._lowTimeWarned = { 0: false, 1: false }; // reset per move, see RenderSync.render()
    this.clock = null; // hotseat's OWN authoritative Clock — null for online (server owns it) or when this.game.timeControl is unset
    this._hotseatFlagTimer = null; // hotseat's own flag-fall timer, mirrors Match._flagTimer exactly — see ClockController

    // Sub-controllers — each holds a reference back to this GameUI
    // instance and reads/writes the state above directly.
    this.input = new InputController(this);
    this.render = new RenderSync(this);
    this.clockCtrl = new ClockController(this);
    this.endcard = new EndcardController(this);

    this.historyPanel = new HistoryPanel(
      document.querySelector(".move-history__body"),
      (index) => this.hoverMove(index),
      (zoneIds) => this.hoverZone(zoneIds),
      (active) => this.hoverPanel(active),
    );

    this.input.bindCanvasEvents();
    this._bindControls();
  }

  init() {
    this._syncMatchInfo();
    this.input.resetView();
    this.render.render();
    this.clockCtrl.startClockTicker();
  }

  _syncMatchInfo() {
    const { game } = this;
    const modeEl = document.getElementById("modeValue");
    const seedEl = document.getElementById("seedValue");
    const boardSizeEl = document.getElementById("boardSizeValue");
    const zoneRadiusEl = document.getElementById("zoneRadiusValue");
    const startingDominoesEl = document.getElementById("startingDominoesValue");
    const timeControlEl = document.getElementById("timeControlValue");

    if (modeEl) modeEl.textContent = game.mode === "classic" ? "Classic" : "Custom";
    if (seedEl) seedEl.textContent = game.seed;
    if (boardSizeEl) boardSizeEl.textContent = `${game.board.cols} x ${game.board.rows}`;
    if (zoneRadiusEl) zoneRadiusEl.textContent = game.zoneRadius;
    if (startingDominoesEl) startingDominoesEl.textContent = game.startingDominoes;
    if (timeControlEl) timeControlEl.textContent = formatTimeControlLabel(game.timeControl);
  }

  refresh() {
    // public alias, so main.js can trigger re-render on remote moves.
    // matchClient already applied the move to this.game before calling this
    // (see MatchClient._handleMoveApplied), so history.last() is it — covers
    // both the mover's own confirmed move and the opponent's.
    this._playEntrySound(this.game.history.last());
    this._clearCalcIfOwnMove();
    this.render.render();
  }

  // Auto-clears calc marks once the viewer's own move actually lands —
  // they've kept thinking, but a plan shouldn't outlive the move it was
  // drawn for. No-op for the opponent's moves online, so marks survive
  // across their turn while the viewer keeps calculating.
  _clearCalcIfOwnMove() {
    const last = this.game.history.last();
    if (!last) return;
    const viewerIndex = this.matchClient ? this.matchClient.myPlayerIndex : null;
    if (viewerIndex == null || last.playerIndex === viewerIndex) {
      this.calcDrawing.clear();
    }
  }

  // ===================== network gating =====================

  _isMyTurn() {
    return !this.matchClient || this.matchClient.isMyTurn();
  }

  _submitPlacement(pieceType, shape, anchorRow, anchorCol) {
    if (!this._isMyTurn()) {
      this.sound.reject();
      return;
    }

    if (this.matchClient) {
      this.matchClient.sendMove(pieceType, shape, anchorRow, anchorCol);
      // no local mutation, no render() here — wait for moveApplied broadcast
    } else {
      const applied = this.game.attemptPlacement(pieceType, shape, anchorRow, anchorCol);
      if (applied) {
        this._playEntrySound(applied);
        this.clockCtrl.advanceHotseatClock();
        this._clearCalcIfOwnMove();
        localGameStore.save(this.game, this.clock);
      } else {
        this.sound.reject();
      }
      this.render.render();
    }
  }

  _submitPass() {
    if (!this._isMyTurn()) {
      this.sound.reject();
      return;
    }

    if (this.matchClient) {
      this.matchClient.sendPass();
      // same: wait for broadcast, don't mutate/render yet
    } else {
      const entry = this.game.pass();
      if (!entry) {
        this.sound.reject();
        return;
      }
      this._playEntrySound(entry);
      this.clockCtrl.advanceHotseatClock();
      this._clearCalcIfOwnMove();
      localGameStore.save(this.game, this.clock);
      this.render.render();
    }
  }

  // Shared by the local hotseat path above and refresh() (online) below —
  // both end up with a freshly-recorded history entry and need the same
  // place/pass/zone-completion sound logic applied to it.
  _playEntrySound(entry) {
    if (!entry) return;
    // Online: always the viewer's own seat. Hotseat: whoever just moved —
    // shared screen has no fixed "self", so frame the sound from the
    // mover's side rather than always player 0.
    const viewerIndex = this.matchClient ? this.matchClient.myPlayerIndex : entry.playerIndex;

    if (entry.type === "pass") {
      this.sound.pass();
    } else {
      this.sound.place();
    }

    (entry.completions ?? []).forEach((completion, i) => {
      this.sound.zoneWon(completion.winnerIndex === viewerIndex, i * 0.2);
    });
  }

  // Public entry point for main.js's matchClient.onRejected — a
  // server-side "Illegal move" / "Not your turn" MOVE_REJECTED.
  playReject() {
    this.sound.reject();
  }

  // ===================== intents: piece selection & transforms =====================

  selectType(type) {
    this.sound.uiClick();
    this.selectedType = type;
    this.rotationStep = 0;
    this.flipped = false;
    this.cursorCell = null;
    this._placementLocked = false;
    this.gesture.reset();
    // Changes the ghost (canvas), which piece button is marked selected,
    // and hasStaged (cursorCell/gesture just got reset) — but never the
    // history panel, side plates, or game-over overlay.
    this.render.syncCanvas();
    this.render.syncControls();
  }

  rotate(direction) {
    if (this.selectedType === "gesture" || this.selectedType === "calc") return; // no shape to rotate in these modes — also silences mouse-wheel scrolling with no effect
    this.sound.uiClick();
    this.rotationStep = (this.rotationStep + direction + 4) % 4;
    // Only the ghost shape's orientation changes — no button, panel, or
    // plate depends on rotationStep.
    this.render.syncCanvas();
  }

  flip() {
    if (this.selectedType === "gesture" || this.selectedType === "calc") return; // same as rotate: no shape to flip
    this.sound.uiClick();
    this.flipped = !this.flipped;
    // Same as rotate: canvas-only.
    this.render.syncCanvas();
  }

  currentShape() {
    if (this.selectedType === "gesture" || this.selectedType === "calc") return null;
    let cells = SHAPES_BASE[this.selectedType];
    if (this.flipped) cells = Shape.reflect(cells);
    for (let i = 0; i < this.rotationStep; i++) cells = Shape.rotate(cells);
    return cells;
  }

  hoverMove(index) {
    this.hoveredMoveIndex = index;
    this.render.syncCanvas();
  }

  hoverZone(zoneIds) {
    this.hoveredZoneIds = zoneIds;
    this.render.syncCanvas();
  }

  hoverPanel(active) {
    this.historyPanelHovered = active;
    if (!active) {
      this.hoveredMoveIndex = null;
      this.hoveredZoneIds = null;
    }
    this.render.syncCanvas();
  }

  skipTurn() {
    this._submitPass();
  }

  // Online only, guarded so a stray click can't fire it in local
  // hotseat or after the game's already over — the button is hidden in
  // both cases (see RenderSync.syncOnlineActions).
  // No optimistic local effect: the actual end comes back through
  // MATCH_ENDED -> showForcedEnd, same as if the opponent had resigned.
  resign() {
    if (!this.matchClient || this.game.gameOver) return;
    const confirmed = window.confirm("Resign this match?");
    if (!confirmed) return;
    this.matchClient.resign();
  }

  // ===================== endgame / rematch: thin public delegators =====================
  // main.js calls these directly on the GameUI instance (via matchClient
  // callbacks), so they stay here as the public surface even though the
  // actual logic lives in EndcardController.

  showForcedEnd(info) {
    this.endcard.showForcedEnd(info);
  }

  showOpponentWantsRematch() {
    this.endcard.showOpponentWantsRematch();
  }

  resetRematchPrompt() {
    this.endcard.resetRematchPrompt();
  }

  // ===================== control bindings =====================

  _bindControls() {
    const signal = this._abort.signal;

    // Single shared control row (lives in the left "Controls" panel) — it
    // always acts on whichever player's turn it currently is.
    document.querySelectorAll(".piece-selector button[data-type]").forEach((btn) => {
      btn.addEventListener("click", () => this.selectType(btn.dataset.type), { signal });
    });

    document.querySelectorAll(".piece-btn--skip").forEach((btn) => {
      btn.addEventListener("click", () => this.skipTurn(), { signal });
    });

    document.getElementById("btnRotateLeft")?.addEventListener("click", () => this.rotate(-1), { signal });
    document.getElementById("btnRotateRight")?.addEventListener("click", () => this.rotate(1), { signal });
    document.getElementById("btnFlip")?.addEventListener("click", () => this.flip(), { signal });
    document.getElementById("btnConfirm")?.addEventListener("click", () => this.input.confirmStaged(), { signal });
    document.getElementById("btnDiscard")?.addEventListener("click", () => this.input.discardStaged(), { signal });
    document.getElementById("btnResign")?.addEventListener("click", () => this.resign(), { signal });
    document
      .getElementById("btnOnlineRematch")
      ?.addEventListener("click", () => this.endcard.requestRematch(), { signal });
    document.getElementById("btnPeekBoard")?.addEventListener("click", () => this.endcard.toggleBoardPeek(), {
      signal,
    });
    document.getElementById("btnCalcUndo")?.addEventListener("click", () => this.input.undoCalc(), { signal });
    document.getElementById("btnCalcRedo")?.addEventListener("click", () => this.input.redoCalc(), { signal });
    document.getElementById("btnCalcClear")?.addEventListener("click", () => this.input.clearCalc(), { signal });

    document.addEventListener(
      "keydown",
      (event) => {
        // Settings panel (or any future modal) owns the keyboard while open
        // — otherwise Escape-to-close-settings would also discard a staged
        // piece underneath it.
        if (!document.getElementById("settingsOverlay")?.hidden) return;
        if ((event.key === "z" || event.key === "Z") && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          if (event.shiftKey) this.input.redoCalc();
          else this.input.undoCalc();
          return;
        }
        const type = KEY_TO_TYPE[event.key];
        if (type) {
          this.selectType(type);
          return;
        }
        if (event.key === "r") {
          this.rotate(1);
          return;
        }
        if (event.key === "f") {
          this.input.secondaryAction();
          return;
        }
        if (event.key === "Enter") {
          this.input.confirmStaged();
          return;
        }
        if (event.key === "Escape") {
          this.input.discardStaged();
          return;
        }
      },
      { signal },
    );
  }

  // Revoke every listener this instance registered (canvas, document,
  // and the shared control buttons) in one shot. main.js must call this
  // before creating a new GameUI for a rematch.
  destroy() {
    this._abort.abort();
    this.historyPanel.destroy();
    clearInterval(this._clockInterval);
    clearTimeout(this._hotseatFlagTimer);
  }
}
