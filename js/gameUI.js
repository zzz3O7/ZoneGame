import { Shape, SHAPES_BASE } from "./shape.js";
import { PASS_PENALTY, LAYOUT } from "./config.js";
import { GestureInput } from "./gestureInput.js";
import { ZoneTooltip } from "./zoneTooltip.js";
import { Zone } from "./zone.js";
import { Board } from "./board.js";
import { HistoryPanel } from "./historyPanel.js";
import { extrapolateRemaining, formatClockMs, Clock } from "./clock.js";

const KEY_TO_TYPE = { 1: "gesture", 2: "domino", 3: "tromino", 4: "tetromino" };

// Below this, the ticking player's clock is shown as "low" (see
// _renderClockFor) — purely a display threshold.
const LOW_TIME_THRESHOLD_MS = 10_000;

// How often the online clock display re-paints between authoritative
// server snapshots. Display-only — how smooth the ticking looks.
const CLOCK_TICK_INTERVAL_MS = 250;

// The "reason" a match ended, for the endcard's reason line.
// "resign" isn't here — it's inherently viewer-relative
// ("You resigned" vs "Opponent resigned"), so it's computed dynamically in _endReasonText.
const END_REASON_TEXT = {
  "no-moves": "No more moves available",
  abort: "Opponent disconnected and didn't return",
  timeout: "On time",
};

// Touch gesture-arbiter tuning. A single-finger touchstart can't tell
// whether it's the start of a placement drag or the first-arriving finger
// of a two-finger pinch — both look identical for the first ~tens of ms.
// PINCH_DISAMBIGUATE_MS is how long we hold off committing to "placement"
// before a second finger would prove it wrong.
const PINCH_DISAMBIGUATE_MS = 50;
// Tap/double-tap detection — a touch counts
// as a tap if it didn't move far and didn't linger.
const TAP_MAX_DIST = 10;
const TAP_MAX_DURATION_MS = 250;
const DOUBLE_TAP_MAX_INTERVAL_MS = 300;
const DOUBLE_TAP_MAX_DIST = 30;

export class GameUI {
  constructor(game, renderer, canvas, matchClient = null) {
    this.game = game;
    this.renderer = renderer;
    this.canvas = canvas;
    this.matchClient = matchClient; // null = local hotseat

    // main.js reuses the same #board-canvas / document / control buttons
    // across matches instead of recreating them, so every listener this
    // instance registers must be revocable in one shot via destroy()
    this._abort = new AbortController();

    this.selectedType = "gesture";
    this.rotationStep = 0;
    this.flipped = false;
    this.cursorCell = null;

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
    this.zoneTooltip = new ZoneTooltip(canvas);

    this.hoveredMoveIndex = null;
    this.hoveredZoneIds = null;
    this.historyPanelHovered = false;

    this._endOverride = null; // set via showForcedEnd() for a forfeit — see END_REASON_TEXT
    this._clockInterval = null; // see _startClockTicker/destroy
    this.clock = null; // hotseat's OWN authoritative Clock — null for online (server owns it) or when this.game.timeControl is unset
    this._hotseatFlagTimer = null; // hotseat's own flag-fall timer, mirrors Match._flagTimer exactly — see _armHotseatFlagTimer/_onHotseatFlagFall

    this.historyPanel = new HistoryPanel(
      document.querySelector(".move-history__body"),
      (index) => this.hoverMove(index),
      (zoneIds) => this.hoverZone(zoneIds),
      (active) => this.hoverPanel(active),
    );

    this._bindCanvasEvents();
    this._bindControls();
  }

  init() {
    this._syncMatchInfo();
    this.resetView();
    this._render();
    this._startClockTicker();
  }

  _syncMatchInfo() {
    const { game } = this;
    const modeEl = document.getElementById("modeValue");
    const seedEl = document.getElementById("seedValue");
    const boardSizeEl = document.getElementById("boardSizeValue");
    const zoneRadiusEl = document.getElementById("zoneRadiusValue");
    const startingDominoesEl = document.getElementById("startingDominoesValue");

    if (modeEl) modeEl.textContent = game.mode === "classic" ? "Classic" : "Custom";
    if (seedEl) seedEl.textContent = game.seed;
    if (boardSizeEl) boardSizeEl.textContent = `${game.board.cols} x ${game.board.rows}`;
    if (zoneRadiusEl) zoneRadiusEl.textContent = game.zoneRadius;
    if (startingDominoesEl) startingDominoesEl.textContent = game.startingDominoes;
  }

  refresh() {
    // public alias, so main.js can trigger re-render on remote moves
    this._render();
  }

  // ===================== network gating =====================

  _isMyTurn() {
    return !this.matchClient || this.matchClient.isMyTurn();
  }

  _submitPlacement(pieceType, shape, anchorRow, anchorCol) {
    if (!this._isMyTurn()) return;

    if (this.matchClient) {
      this.matchClient.sendMove(pieceType, shape, anchorRow, anchorCol);
      // no local mutation, no _render() here — wait for moveApplied broadcast
    } else {
      const applied = this.game.attemptPlacement(pieceType, shape, anchorRow, anchorCol);
      if (applied) this._advanceHotseatClock();
      this._render();
    }
  }

  _submitPass() {
    if (!this._isMyTurn()) return;

    if (this.matchClient) {
      this.matchClient.sendPass();
      // same: wait for broadcast, don't mutate/render yet
    } else {
      if (!this.game.pass()) return;
      this._advanceHotseatClock();
      this._render();
    }
  }

  // ===================== intents: piece selection & transforms =====================

  selectType(type) {
    this.selectedType = type;
    this.rotationStep = 0;
    this.flipped = false;
    this.cursorCell = null;
    this.gesture.reset();
    // Changes the ghost (canvas), which piece button is marked selected,
    // and hasStaged (cursorCell/gesture just got reset) — but never the
    // history panel, side plates, or game-over overlay.
    this._syncCanvas();
    this._syncControls();
  }

  rotate(direction) {
    this.rotationStep = (this.rotationStep + direction + 4) % 4;
    // Only the ghost shape's orientation changes — no button, panel, or
    // plate depends on rotationStep.
    this._syncCanvas();
  }

  flip() {
    this.flipped = !this.flipped;
    // Same as rotate: canvas-only.
    this._syncCanvas();
  }

  currentShape() {
    if (this.selectedType === "gesture") return null;
    let cells = SHAPES_BASE[this.selectedType];
    if (this.flipped) cells = Shape.reflect(cells);
    for (let i = 0; i < this.rotationStep; i++) cells = Shape.rotate(cells);
    return cells;
  }

  hoverMove(index) {
    this.hoveredMoveIndex = index;
    this._syncCanvas();
  }

  hoverZone(zoneIds) {
    this.hoveredZoneIds = zoneIds;
    this._syncCanvas();
  }

  hoverPanel(active) {
    this.historyPanelHovered = active;
    if (!active) {
      this.hoveredMoveIndex = null;
      this.hoveredZoneIds = null;
    }
    this._syncCanvas();
  }

  // ===================== intents: gesture drawing =====================

  startGesture(cell) {
    if (this.selectedType !== "gesture") return;
    this.gesture.start(cell);
    // Path/ghost on canvas + staged-button state — same footprint as a
    // hover, so reuse it instead of a full render.
    this._renderHover();
  }

  finishGesture() {
    if (!this.gesture.finish()) return;
    // finish() may populate gesture.pending, which flips hasStaged —
    // canvas + staged buttons is exactly what changed.
    this._renderHover();
  }

  cancelGesture() {
    this.gesture.cancel();
    this._renderHover();
  }

  confirmGesture() {
    const confirmed = this.gesture.confirm((type, shape, anchorRow, anchorCol) => {
      this._submitPlacement(type, shape, anchorRow, anchorCol);
    });
    if (!confirmed) return; // nothing was pending — nothing changed

    // Local placements: _submitPlacement() above already ran a full
    // _render() (real game state changed — history, scores, turn, etc).
    // Anything else (matchClient waiting on the server broadcast, or a
    // turn-gated no-op) only cleared gesture state, so the cheap path
    // is enough to make the now-empty ghost/path disappear.
    if (this.matchClient) this._renderHover();
  }

  secondaryAction() {
    if (this.selectedType === "gesture") {
      this.cancelGesture();
    } else {
      this.flip();
    }
  }

  // ===================== intents: board interaction =====================

  hover(cell) {
    // mousemove/touchmove fire far more often than the resolved board cell
    // actually changes (many events per cell while the pointer sits still
    // or crawls within one cell) — bail before touching state or rendering
    // anything. Clicks, piece-select, rotate/flip, gesture confirm etc. all
    // trigger their own _render() independently of this, so this guard only
    // ever skips genuinely redundant hover work, never a real update.
    if (this.cursorCell && cell[0] === this.cursorCell[0] && cell[1] === this.cursorCell[1]) return;
    this.cursorCell = cell;
    this.gesture.extend(cell);
    this._renderHover();
  }

  clearHover() {
    if (!this.cursorCell) return;
    this.cursorCell = null;
    this._renderHover();
  }

  placeAt([row, col]) {
    this._submitPlacement(this.selectedType, this.currentShape(), row, col);
  }

  skipTurn() {
    this._submitPass();
  }

  // Online only, guarded so a stray click can't fire it in local
  // hotseat or after the game's already over — the button is hidden in
  // both cases (see _syncOnlineActions).
  // No optimistic local effect: the actual end comes back through
  // MATCH_ENDED -> showForcedEnd, same as if the opponent had resigned.
  resign() {
    if (!this.matchClient || this.game.gameOver) return;
    const confirmed = window.confirm("Resign this match?");
    if (!confirmed) return;
    this.matchClient.resign();
  }

  // ===================== board zoom / pan (touch) =====================

  resetView() {
    this.viewTransform = { scale: 1, x: 0, y: 0 };
    this._applyViewTransform();
  }

  _applyViewTransform() {
    const { scale, x, y } = this.viewTransform;
    // Goes through the renderer so both the static and dynamic canvases
    // zoom/pan together — GameUI doesn't need to know there are two.
    this.renderer.applyTransform(`translate(${x}px, ${y}px) scale(${scale})`);
  }

  _clampView() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const { scale } = this.viewTransform;
    this.viewTransform.x = Math.min(0, Math.max(rect.width - rect.width * scale, this.viewTransform.x));
    this.viewTransform.y = Math.min(0, Math.max(rect.height - rect.height * scale, this.viewTransform.y));
  }

  _touchDist(t0, t1) {
    return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
  }

  _touchMid(t0, t1) {
    return { midX: (t0.clientX + t1.clientX) / 2, midY: (t0.clientY + t1.clientY) / 2 };
  }

  _startPinch(touches) {
    this._pinch = { dist: this._touchDist(touches[0], touches[1]), ...this._touchMid(touches[0], touches[1]) };
    // The tooltip is a DOM element, not part of either canvas, so it never
    // inherits the CSS transform pinch/pan applies to the board — left
    // alone it stays visually stuck in place while the zone underneath it
    // moves/scales. No hover fires during a pinch (_suppressHoverUntilLift)
    // to refresh its position either, so just hide it; it reappears
    // correctly positioned on the next real hover once the pinch ends.
    this.zoneTooltip.hide();
  }

  _applyPinch(touches) {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dist = this._touchDist(touches[0], touches[1]);
    const { midX, midY } = this._touchMid(touches[0], touches[1]);

    const ratio = dist / this._pinch.dist;
    const newScale = Math.min(LAYOUT.maxZoom, Math.max(1, this.viewTransform.scale * ratio));

    // Keep the point under the fingers stationary on screen while scaling.
    const localX = (this._pinch.midX - rect.left - this.viewTransform.x) / this.viewTransform.scale;
    const localY = (this._pinch.midY - rect.top - this.viewTransform.y) / this.viewTransform.scale;
    this.viewTransform.x = midX - rect.left - localX * newScale;
    this.viewTransform.y = midY - rect.top - localY * newScale;
    this.viewTransform.scale = newScale;

    this._clampView();
    this._applyViewTransform();
    this._pinch = { dist, midX, midY };
  }

  // Touch has no hover, so a non-gesture placement is staged on cursorCell
  // (set by touchmove) instead of placed immediately — confirm/discard
  // buttons resolve it. Mouse click still places directly, unaffected.
  confirmStaged() {
    if (this.gesture.pending) {
      this.confirmGesture();
      return;
    }
    if (this.selectedType !== "gesture" && this.cursorCell) {
      this.placeAt(this.cursorCell);
      this.clearHover();
    }
  }

  discardStaged() {
    if (this.gesture.pending) {
      this.cancelGesture();
      return;
    }
    this.clearHover();
  }

  // ===================== input: DOM event listeners =====================

  _cellFromPoint(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = (clientX - rect.left - this.canvas.clientLeft) * scaleX;
    const y = (clientY - rect.top - this.canvas.clientTop) * scaleY;
    const cellSize = this.renderer.cellSize;
    const board = this.game.board;
    const col = Math.min(Math.max(Math.floor(x / cellSize), 0), board.cols - 1);
    const row = Math.min(Math.max(Math.floor(y / cellSize), 0), board.rows - 1);
    return [row, col];
  }

  _cellFromEvent(event) {
    return this._cellFromPoint(event.clientX, event.clientY);
  }

  _cellFromTouch(touch) {
    return this._cellFromPoint(touch.clientX, touch.clientY);
  }

  _bindCanvasEvents() {
    const signal = this._abort.signal;

    this.canvas.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 0) return;
        this.startGesture(this._cellFromEvent(e));
      },
      { signal },
    );

    document.addEventListener("mouseup", () => this.finishGesture(), { signal });

    this.canvas.addEventListener("mousemove", (e) => this.hover(this._cellFromEvent(e)), { signal });
    this.canvas.addEventListener("mouseleave", () => this.clearHover(), { signal });

    this.canvas.addEventListener(
      "click",
      (e) => {
        if (this.gesture.consumeSuppressedClick()) return;
        if (this.gesture.pending) {
          this.confirmGesture();
          return;
        }
        if (this.selectedType === "gesture") return; // nothing drawn/confirmed yet
        this.placeAt(this._cellFromEvent(e));
      },
      { signal },
    );

    this.canvas.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        this.secondaryAction();
      },
      { signal },
    );

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.rotate(e.deltaY > 0 ? 1 : -1);
      },
      { signal },
    );

    // Touch: 1 finger = existing mouse-equivalent flow (hover / gesture
    // draw), never touches the view transform. 2 fingers = pinch-zoom/pan,
    // never touches placement state. A short delay before committing a
    // fresh single-finger touch (see PINCH_DISAMBIGUATE_MS) stops the
    // ghost/gesture-path from flashing at finger 1's position the instant
    // before finger 2 lands for a pinch-from-rest.
    this.canvas.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        if (e.touches.length === 1) {
          const touch = e.touches[0];
          this._pinch = null;
          this._suppressHoverUntilLift = false;
          this._touchStartInfo = { x: touch.clientX, y: touch.clientY, time: Date.now() };
          this._pendingTouch = { cell: this._cellFromTouch(touch) };
          this._pendingTouchTimer = setTimeout(() => {
            this._pendingTouchTimer = null;
            const pending = this._pendingTouch;
            this._pendingTouch = null;
            if (!pending) return;
            this.hover(pending.cell);
            this.startGesture(pending.cell);
          }, PINCH_DISAMBIGUATE_MS);
        } else if (e.touches.length === 2) {
          if (this._pendingTouchTimer) {
            // Second finger arrived before we committed finger 1 to
            // anything — this was a pinch from rest, not an interrupted
            // drag. Drop the pending commit entirely.
            clearTimeout(this._pendingTouchTimer);
            this._pendingTouchTimer = null;
            this._pendingTouch = null;
          } else if (this.gesture.isDrawing) {
            // Delay already resolved — a real single-finger draw was in
            // progress and got interrupted by a second finger.
            this.cancelGesture();
          }
          this._suppressHoverUntilLift = true;
          this._startPinch(e.touches);
        }
      },
      { passive: false, signal },
    );

    this.canvas.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        if (e.touches.length === 1) {
          if (this._pendingTouch) {
            // Still inside the disambiguation window — track where the
            // finger is, but don't act on it until it resolves.
            this._pendingTouch.cell = this._cellFromTouch(e.touches[0]);
          } else if (!this._suppressHoverUntilLift) {
            this.hover(this._cellFromTouch(e.touches[0]));
          }
        } else if (e.touches.length >= 2) {
          this._applyPinch(e.touches);
        }
      },
      { passive: false, signal },
    );

    this.canvas.addEventListener(
      "touchend",
      (e) => {
        e.preventDefault();
        const remaining = e.touches.length;

        if (remaining === 0) {
          if (this._pendingTouchTimer) {
            // Lifted before the delay resolved — a genuine quick tap,
            // not an aborted pinch. Commit it now rather than dropping it.
            clearTimeout(this._pendingTouchTimer);
            this._pendingTouchTimer = null;
            const pending = this._pendingTouch;
            this._pendingTouch = null;
            if (pending) {
              this.hover(pending.cell);
              this.startGesture(pending.cell);
            }
          }
          this._pinch = null;
          this._suppressHoverUntilLift = false;
          this._checkDoubleTap(e.changedTouches[0]);
          this.finishGesture();
        } else if (remaining === 1) {
          // Dropped from a pinch back to one finger — that finger was
          // mid-pinch, not placing. Wait for a fresh touchstart rather
          // than repurposing it as a placement drag.
          this._pinch = null;
          this._suppressHoverUntilLift = true;
        } else {
          this._startPinch(e.touches); // still 2+, rebase to avoid a jump
        }
      },
      { passive: false, signal },
    );
  }

  _checkDoubleTap(touch) {
    if (!touch || !this._touchStartInfo) return;
    const dist = Math.hypot(touch.clientX - this._touchStartInfo.x, touch.clientY - this._touchStartInfo.y);
    const duration = Date.now() - this._touchStartInfo.time;
    this._touchStartInfo = null;

    if (dist >= TAP_MAX_DIST || duration >= TAP_MAX_DURATION_MS) {
      this._lastTap = null; // a drag breaks the double-tap chain
      return;
    }

    const last = this._lastTap;
    const withinInterval = last && Date.now() - last.time < DOUBLE_TAP_MAX_INTERVAL_MS;
    const withinDist = last && Math.hypot(touch.clientX - last.x, touch.clientY - last.y) < DOUBLE_TAP_MAX_DIST;
    if (withinInterval && withinDist) {
      // The two taps that make up this double-tap each staged a ghost via
      // the normal single-tap flow already (see touchend) — a double-tap
      // is a meta action, not a placement gesture, so undo that instead of
      // leaving a piece preview behind that the user never asked to place.
      this.resetView();
      this.clearHover();
      if (this.gesture.isDrawing || this.gesture.pending) this.cancelGesture();
      this._lastTap = null;
    } else {
      this._lastTap = { time: Date.now(), x: touch.clientX, y: touch.clientY };
    }
  }

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
    document.getElementById("btnConfirm")?.addEventListener("click", () => this.confirmStaged(), { signal });
    document.getElementById("btnDiscard")?.addEventListener("click", () => this.discardStaged(), { signal });
    document.getElementById("btnResign")?.addEventListener("click", () => this.resign(), { signal });
    document.getElementById("btnOnlineRematch")?.addEventListener("click", () => this.requestRematch(), { signal });

    document.addEventListener(
      "keydown",
      (event) => {
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
          this.secondaryAction();
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

  // ===================== render: fully re-derive the DOM from state =====================

  _activePlacement() {
    if (this.gesture.pending) {
      return [[this.gesture.pending.anchorRow, this.gesture.pending.anchorCol], this.gesture.pending.shape];
    }
    if (this.selectedType === "gesture") return [null, null];
    if (!this.cursorCell) return [null, null];
    return [this.cursorCell, this.currentShape()];
  }

  // Full re-sync: everything that can only change on an actual game-state
  // event (placement, pass, selection/rotation/flip, gesture lifecycle,
  // remote move applied, game over). Never call this from hover/pointer
  // movement — see _renderHover below.
  _render() {
    this.renderer.setWaiting(!this._isMyTurn());
    this._syncStaticCanvas();
    this._syncCanvas();
    this._syncControls();
    this._syncSidePlates();
    this._syncGameOver();
    this._tickClocks();

    const baseIndex = this.matchClient ? this.matchClient.myPlayerIndex : 0;
    this.historyPanel.render(this.game.history.all(), baseIndex);
  }

  // Board grid, zone fills/borders, placed pieces — the static layer.
  // Redrawn only here, i.e. only on a genuine game-state event, never on
  // hover/rotate/flip/selection.
  _syncStaticCanvas() {
    const viewerIndex = this.matchClient ? this.matchClient.myPlayerIndex : this.game.currentPlayerIndex;
    this.renderer.renderStatic(this.game.board, this.game.zones, viewerIndex, this.game.history.all());
  }

  // Cheap path for pointer movement (hover/clearHover). Only touches what
  // cursor position can actually affect: the canvas (ghost/zone-preview/
  // tooltip) and the confirm/discard buttons (staged-placement enablement
  // depends on cursorCell for non-gesture piece types). Everything else in
  // _render() — history panel rebuild, piece-selector buttons, side plates,
  // game-over overlay — is invariant under hover and would just be wasted
  // DOM/canvas work on every mousemove.
  _renderHover() {
    this._syncCanvas();
    this._syncStagedButtons();
  }

  _syncCanvas() {
    const [anchorCell, anchorShape] = this._activePlacement();
    const pieceType = this.gesture.pending ? this.gesture.pending.type : this.selectedType;
    const viewerIndex = this.matchClient ? this.matchClient.myPlayerIndex : this.game.currentPlayerIndex;

    const zonePreview = anchorCell
      ? Zone.preview(this.game.board, anchorCell[0], anchorCell[1], this.game.zoneRadius)
      : null;
    const cursorInPreview =
      zonePreview && this.cursorCell && zonePreview.cellSet.has(Board.key(this.cursorCell[0], this.cursorCell[1]));

    const entries = this.game.history.all();
    const highlightIndex = this.hoveredMoveIndex;
    const highlightEntry = highlightIndex != null && highlightIndex >= 0 ? entries[highlightIndex] : null;

    this.renderer.renderDynamic(
      this.game.board,
      this.game.zones,
      this.game.currentPlayerIndex,
      this.game.players[viewerIndex],
      pieceType,
      anchorShape,
      anchorCell,
      this.cursorCell,
      this.gesture.path,
      highlightEntry,
      this.hoveredZoneIds,
      zonePreview,
    );

    this.zoneTooltip.update(
      this.game.gameOver ? null : this.cursorCell,
      this.game.board,
      this.game.zones,
      !this.game.gameOver && cursorInPreview ? zonePreview : null,
    );
  }

  _syncControls() {
    this._syncPieceButtons();
    this._syncStagedButtons();
    this._syncOnlineActions();
    this._syncLocalActions();
  }

  // Resign is only meaningful for an online match that's still live —
  // hidden entirely in local hotseat, and hidden again once the game ends
  _syncOnlineActions() {
    const el = document.getElementById("onlineMatchActions");
    if (el) el.hidden = !this.matchClient || this.game.gameOver;
  }

  // Mirrors _syncOnlineActions above, but for local hotseat's
  // mid-game "Back to menu" — hotseat has no forfeit concept, so this is
  // always safe to show while a local game is live. Hidden once the game
  // ends since the endcard's own "Back to menu" covers that case.
  _syncLocalActions() {
    const el = document.getElementById("localMatchActions");
    if (el) el.hidden = !!this.matchClient || this.game.gameOver;
  }

  // Piece-type buttons + skip button: depend on selectedType, dominoLeft,
  // turn/gameOver state — never on cursorCell. Only needs to run after
  // real game/selection events, not on every hover.
  //
  // Piece-type buttons reflect the VIEWER's own pieces, not whoever's turn it currently is
  // In local hotseat, viewer === currentPlayer, so this is unchanged there.
  _syncPieceButtons() {
    const viewerIndex = this.matchClient ? this.matchClient.myPlayerIndex : this.game.currentPlayerIndex;
    const viewerPlayer = this.game.players[viewerIndex];
    const canMove = this.game.canCurrentPlayerMove();
    const myTurn = this._isMyTurn(); // true always in local mode, real check online

    document.querySelectorAll(".piece-selector button[data-type]").forEach((btn) => {
      const type = btn.dataset.type;
      const disabled = this.game.gameOver || (type === "domino" && viewerPlayer.dominoLeft <= 0);
      btn.disabled = disabled;
      btn.classList.toggle("piece-btn--selected", type === this.selectedType);
    });

    const skipBtn = document.querySelector(".piece-btn--skip");
    if (skipBtn) {
      skipBtn.disabled = this.game.gameOver || !myTurn || canMove;
      const skipPenalty = viewerPlayer.score - Math.floor(viewerPlayer.score * PASS_PENALTY);
      const countEl = skipBtn.querySelector(".piece-btn__count");
      if (countEl) countEl.textContent = `-${skipPenalty}`;
    }
  }

  // Confirm/discard buttons: hasStaged depends on cursorCell for non-gesture
  // piece types (mouse hover alone stages a placement, same as touch), so
  // this DOES need to run on hover — kept separate from _syncPieceButtons
  // so hover doesn't pay for the querySelectorAll piece-button loop too.
  _syncStagedButtons() {
    const myTurn = this._isMyTurn();
    const hasStaged = !!this.gesture.pending || (this.selectedType !== "gesture" && !!this.cursorCell);
    const confirmBtn = document.getElementById("btnConfirm");
    const discardBtn = document.getElementById("btnDiscard");
    if (confirmBtn) confirmBtn.disabled = this.game.gameOver || !myTurn || !hasStaged;
    if (discardBtn) discardBtn.disabled = this.game.gameOver || !hasStaged;
  }

  _syncSidePlates() {
    const myIndex = this.matchClient ? this.matchClient.myPlayerIndex : 0; // local: doesn't matter, arbitrary anchor
    this.game.players.forEach((player) => {
      const isSelf = player.id === myIndex;
      this._syncSidePlate(player, isSelf);
    });
  }

  _syncSidePlate(player, isSelf) {
    const plate = document.querySelector(`.side-plate[data-position="${isSelf ? "self" : "opponent"}"]`);
    if (!plate) return;

    const isActive = player.id === this.game.currentPlayerIndex;
    plate.classList.toggle("side-plate--active", isActive);

    const nameEl = plate.querySelector(".side-plate__name");
    if (nameEl) {
      nameEl.textContent = this.matchClient?.playerNames?.[player.id] ?? `player_${player.id + 1}`;
    }

    const scoreEl = plate.querySelector(".side-plate__score");
    if (scoreEl) scoreEl.textContent = player.score;

    const dominoCountEl = plate.querySelector('.side-piece__count[data-piece="domino"]');
    if (dominoCountEl) dominoCountEl.textContent = player.dominoLeft;
  }

  // Fallback when no matchClient (local hotseat) or names aren't loaded yet —
  // Player already carries a default "Player 1"/"Player 2" name.
  _playerName(index) {
    return this.matchClient?.playerNames?.[index] ?? this.game.players[index].name;
  }

  // This is deliberately display-only for the online path: it never decides a
  // flag-fall (that's server-authoritative, see Match._onFlagFall), it
  // just paints whatever the latest snapshot implies "right now" looks
  // like, re-extrapolated on every tick from snapshot.now so it stays
  // smooth between the (much sparser) authoritative corrections that
  // arrive on every MOVE_APPLIED/MATCH_START/sync.
  //
  // Hotseat has no server at all, so GameUI itself is authoritative there
  // — it owns a real Clock (this.clock) and runs the exact same
  // startTurn/stopTurn/flag-fall shape Match does, just locally. See
  // _advanceHotseatClock/_armHotseatFlagTimer/_onHotseatFlagFall below.
  _startClockTicker() {
    clearInterval(this._clockInterval);
    clearTimeout(this._hotseatFlagTimer);

    if (this.matchClient) {
      this._clockInterval = setInterval(() => this._tickClocks(), CLOCK_TICK_INTERVAL_MS);
      return;
    }

    if (this.game.timeControl) {
      this.clock = Clock.fromConfig(this.game.timeControl);
      const now = Date.now();
      this.clock.startTurn(this.game.currentPlayerIndex, now);
      this._armHotseatFlagTimer(now);
      this._clockInterval = setInterval(() => this._tickClocks(), CLOCK_TICK_INTERVAL_MS);
    }
    // else: no time control at all — _render()'s one-shot _tickClocks()
    // call still paints the "--:--" placeholder, no interval needed.
  }

  _tickClocks() {
    const now = Date.now();
    // Online: read the server's latest broadcast snapshot. Hotseat: ask our
    // own Clock to extrapolate one, in the exact same shape (see
    // Clock#snapshot) — so _renderClockFor below can't tell the difference.
    const snapshot = this.matchClient ? (this.matchClient.clock ?? null) : (this.clock?.snapshot(now) ?? null);
    this.game.players.forEach((player) => this._renderClockFor(player.id, snapshot, now));
  }

  // Mirrors Match._advanceClockAfterMove exactly, just local instead of over a websocket. Called
  // right after a successful hotseat move/pass, once currentPlayerIndex has already advanced.
  _advanceHotseatClock() {
    if (!this.clock) return;
    clearTimeout(this._hotseatFlagTimer); // was armed for the mover's own turn — stale now regardless of outcome
    const now = Date.now();
    this.clock.stopTurn(now);
    if (!this.game.gameOver) {
      this.clock.startTurn(this.game.currentPlayerIndex, now);
      this._armHotseatFlagTimer(now);
    }
  }

  // Mirrors Match._armFlagTimer exactly.
  _armHotseatFlagTimer(now) {
    clearTimeout(this._hotseatFlagTimer);
    if (!this.clock || this.clock.currentPlayerIndex === null) return;
    const remaining = this.clock.getRemaining(this.clock.currentPlayerIndex, now);
    this._hotseatFlagTimer = setTimeout(() => this._onHotseatFlagFall(), remaining);
  }

  // Mirrors Match._onFlagFall exactly, including the same
  // setTimeout-slop re-verification. Ends the game the same way an online
  // forfeit does — via showForcedEnd, so the endcard's winner/reason don't
  // go through Game.winnerIndex's score-comparison getter.
  _onHotseatFlagFall() {
    if (!this.clock || this.clock.currentPlayerIndex === null || this.game.gameOver) return;

    const now = Date.now();
    if (!this.clock.isFlagged(now)) {
      this._armHotseatFlagTimer(now);
      return;
    }

    const flaggedIndex = this.clock.currentPlayerIndex;
    this.clock.freeze(now); // no increment — running out isn't a completed move
    this.showForcedEnd({ reason: "timeout", winnerIndex: 1 - flaggedIndex });
  }

  _renderClockFor(playerId, snapshot, now) {
    const myIndex = this.matchClient ? this.matchClient.myPlayerIndex : 0;
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
    // "is this the ticking player" via _syncSidePlate — --low only adds the
    // extra "and they're running out" urgency state on top of that.
    const isTicking = playerId === snapshot.currentPlayerIndex;
    clockEl.classList.toggle("side-plate__clock--low", isTicking && remaining <= LOW_TIME_THRESHOLD_MS);
  }

  // End the match from outside the normal move flow. Deliberately not
  // touching this.game.winnerIndex — that getter is a score comparison and
  // a forfeit winner is a different concept. The override lives alongside the game,
  // not inside it, and only affects the endcard header.
  showForcedEnd({ reason, winnerIndex }) {
    this._endOverride = { reason, winnerIndex };
    this.game.gameOver = true;
    this._render();
  }

  _syncGameOver() {
    const overlay = document.getElementById("gameOverOverlay");
    if (!overlay) return;

    if (!this.game.gameOver) {
      overlay.hidden = true;
      return;
    }
    overlay.hidden = false;

    this._syncEndcardHeader();
    this._syncEndcardScores();
    this._syncEndcardBreakdown();
    this._syncEndcardActions();
  }

  _syncEndcardHeader() {
    const winner = this._endOverride ? this._endOverride.winnerIndex : this.game.winnerIndex;
    const winnerEl = document.getElementById("endcardWinner");
    const reasonEl = document.getElementById("endcardReason");
    const myIndex = this.matchClient ? this.matchClient.myPlayerIndex : 0;

    if (winnerEl) {
      if (winner === null || winner === undefined) {
        winnerEl.textContent = "Draw";
      } else {
        const cls = winner === myIndex ? "name-a" : "name-b";
        winnerEl.innerHTML = `<span class="${cls}">${this._playerName(winner)}</span> wins`;
      }
    }
    if (reasonEl) {
      reasonEl.textContent = this._endOverride
        ? this._endReasonText(this._endOverride.reason, this._endOverride.winnerIndex, myIndex)
        : END_REASON_TEXT["no-moves"];
    }
  }

  _endReasonText(reason, winnerIndex, myIndex) {
    if (reason === "resign") {
      return winnerIndex === myIndex ? "Opponent resigned" : "You resigned";
    }
    return END_REASON_TEXT[reason] ?? "Match ended";
  }

  _syncEndcardScores() {
    const myIndex = this.matchClient ? this.matchClient.myPlayerIndex : 0;
    const opponentIndex = 1 - myIndex;
    const winner = this._endOverride ? this._endOverride.winnerIndex : this.game.winnerIndex;

    const nameA = document.getElementById("scoreNameA");
    const nameB = document.getElementById("scoreNameB");
    const valueA = document.getElementById("scoreValueA");
    const valueB = document.getElementById("scoreValueB");
    const sideA = document.querySelector('.score-side[data-side="a"]');
    const sideB = document.querySelector('.score-side[data-side="b"]');

    if (nameA) nameA.textContent = this._playerName(myIndex);
    if (nameB) nameB.textContent = this._playerName(opponentIndex);
    if (valueA) valueA.textContent = this.game.players[myIndex].score;
    if (valueB) valueB.textContent = this.game.players[opponentIndex].score;
    sideA?.classList.toggle("winner", winner === myIndex || winner === null);
    sideB?.classList.toggle("winner", winner === opponentIndex || winner === null);
  }

  _syncEndcardBreakdown() {
    const columnA = document.getElementById("breakdownColumnA");
    const columnB = document.getElementById("breakdownColumnB");
    if (!columnA || !columnB) return;

    const myIndex = this.matchClient ? this.matchClient.myPlayerIndex : 0;
    const opponentIndex = 1 - myIndex;

    const rowsByPlayer = [[], []];
    for (const entry of this.game.history.all()) {
      if (entry.type === "piece") {
        for (const completion of entry.completions) {
          rowsByPlayer[completion.winnerIndex].push({
            label: `Zone #${completion.zoneId + 1} completed`,
            points: completion.points,
          });
        }
      } else if (entry.type === "pass" && entry.penalty > 0) {
        rowsByPlayer[entry.playerIndex].push({ label: "Pass penalty", points: -entry.penalty });
      }
    }

    this._renderBreakdownColumn(columnA, rowsByPlayer[myIndex]);
    this._renderBreakdownColumn(columnB, rowsByPlayer[opponentIndex]);
  }

  _renderBreakdownColumn(container, rows) {
    container.innerHTML = "";

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "breakdown__empty";
      empty.textContent = "No scoring events.";
      container.appendChild(empty);
      return;
    }

    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "breakdown__row";
      const sign = row.points >= 0 ? "+" : "";
      el.innerHTML = `
        <span class="label">${row.label}</span>
        <span class="pts ${row.points >= 0 ? "pos" : "neg"}">${sign}${row.points}</span>
      `;
      container.appendChild(el);
    }
  }

  _syncEndcardActions() {
    // Rematch/same-board replay locally by reconstructing Game — no server
    // protocol for this yet, so keep it local-hotseat only for now.
    const localActions = document.getElementById("endcardLocalActions");
    if (localActions) localActions.hidden = !!this.matchClient;

    // Online rematch — only offered while the match is still alive
    // server-side for it (status "over": a naturally-completed or resigned
    // game). Once it's "aborted" (forfeit-by-disconnect, or the opponent
    // explicitly left), the match is already gone server-side — nothing to
    // rematch, just leave "Back to menu".
    const onlineActions = document.getElementById("endcardOnlineActions");
    if (onlineActions) onlineActions.hidden = !this.matchClient || this.matchClient.status !== "over";

    // Fresh endcard render, fresh status — clear any stale "waiting on
    // opponent" text/disabled-button state left over from a previous game.
    this.resetRematchPrompt();
  }

  // Bound to btnOnlineRematch. Symmetric with the opponent's own
  // click — server just waits for both (see Match.requestRematch) and
  // fires a normal MATCH_START once it has them, which the existing
  // onMatchStart -> startGame() path already handles with no further
  // wiring needed here.
  requestRematch() {
    if (!this.matchClient || this.matchClient.status !== "over") return;
    this.matchClient.requestRematch();
    this.setRematchStatus("Waiting for opponent to accept…");
    const btn = document.getElementById("btnOnlineRematch");
    if (btn) btn.disabled = true;
  }

  // Opponent clicked rematch before we did — nudge, doesn't disable
  // our own button, since clicking it now is exactly how we accept.
  showOpponentWantsRematch() {
    this.setRematchStatus("Opponent wants a rematch — click Rematch to accept!", { active: true });
  }

  // Small imperative status-line helper for the online rematch
  // prompt. Event-driven (who clicked/asked what) rather than derived from
  // persistent state like the rest of _render(), so it lives outside the
  // normal _syncX() cycle and is called directly from main.js's
  // matchClient callbacks as well as from here.
  setRematchStatus(text, { active = false } = {}) {
    const el = document.getElementById("endcardRematchStatus");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      return;
    }
    el.textContent = text;
    el.hidden = false;
    el.classList.toggle("endcard__rematch-status--active", active);
  }

  // Rematch fizzled (timeout) or is otherwise moot — clear the
  // prompt and re-enable the button so they can try again.
  resetRematchPrompt() {
    this.setRematchStatus(null);
    const btn = document.getElementById("btnOnlineRematch");
    if (btn) btn.disabled = false;
  }
}
