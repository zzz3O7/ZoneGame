import { LAYOUT } from "../../../shared/config.js";
import { settings } from "../settings.js";

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

// Owns everything pointer/touch/gesture/calc-drawing/staged-placement:
// canvas DOM listeners, pinch-zoom/pan, and resolving "what's currently
// staged" for confirm/discard. Reads and writes state directly on the
// GameUI instance (`ui`) it's constructed with — `ui` stays the single
// source of truth, this is just where the input-facing logic over that
// state lives.
export class InputController {
  constructor(ui) {
    this.ui = ui;
  }

  // ===================== intents: gesture drawing =====================

  startGesture(cell) {
    const { ui } = this;
    if (ui.selectedType !== "gesture") return;
    ui.gesture.start(cell);
    // Path/ghost on canvas + staged-button state — same footprint as a
    // hover, so reuse it instead of a full render.
    ui.render.renderHover();
  }

  finishGesture() {
    if (!this.ui.gesture.finish()) return;
    // finish() may populate gesture.pending, which flips hasStaged —
    // canvas + staged buttons is exactly what changed.
    this.ui.render.renderHover();
  }

  secondaryAction() {
    const { ui } = this;
    if (ui.selectedType === "gesture") {
      this.discardStaged();
    } else if (ui.selectedType === "calc") {
      this.clearCalc();
    } else {
      ui.flip();
    }
  }

  // ===================== intents: calc-mode drawing =====================
  // Desktop/pointer-only planning overlay: paints cells for the viewer to
  // think out loud on the board without it ever becoming a move. Persists
  // across mode switches and hover — only cleared by undo/redo/clear or
  // the viewer's own next real move (_clearCalcIfOwnMove).

  startCalc(cell, color) {
    const { ui } = this;
    if (ui.selectedType !== "calc") return;
    ui.calcDrawing.start(cell, color);
    ui.render.syncCanvas();
  }

  finishCalc() {
    const { ui } = this;
    if (!ui.calcDrawing.finish()) return;
    ui.render.syncCanvas();
    ui.render.syncCalcControls();
  }

  clearCalc() {
    const { ui } = this;
    if (ui.selectedType !== "calc") return;
    if (!ui.calcDrawing.clear()) return;
    ui.sound.uiDiscard();
    ui.render.syncCanvas();
    ui.render.syncCalcControls();
  }

  undoCalc() {
    const { ui } = this;
    if (ui.selectedType !== "calc") return;
    if (!ui.calcDrawing.undo()) return;
    ui.sound.uiClick();
    ui.render.syncCanvas();
    ui.render.syncCalcControls();
  }

  redoCalc() {
    const { ui } = this;
    if (ui.selectedType !== "calc") return;
    if (!ui.calcDrawing.redo()) return;
    ui.sound.uiClick();
    ui.render.syncCanvas();
    ui.render.syncCalcControls();
  }

  // ===================== intents: board interaction =====================

  hover(cell) {
    const { ui } = this;
    // requireConfirm locked a staged plain piece in place (see the click
    // handler below) — further mouse movement, including toward the
    // Confirm/Discard buttons, must not drift or clear it.
    if (ui._placementLocked) return;
    // mousemove/touchmove fire far more often than the resolved board cell
    // actually changes — bail before touching state or rendering anything.
    if (ui.cursorCell && cell[0] === ui.cursorCell[0] && cell[1] === ui.cursorCell[1]) return;
    ui.cursorCell = cell;
    ui.gesture.extend(cell);
    ui.calcDrawing.extend(cell);
    ui.render.renderHover();
  }

  clearHover() {
    const { ui } = this;
    if (ui._placementLocked) return;
    if (!ui.cursorCell) return;
    ui.cursorCell = null;
    ui.render.renderHover();
  }

  // ===================== board zoom / pan (touch) =====================

  resetView() {
    this.ui.viewTransform = { scale: 1, x: 0, y: 0 };
    this._applyViewTransform();
  }

  _applyViewTransform() {
    const { scale, x, y } = this.ui.viewTransform;
    // Goes through the renderer so both the static and dynamic canvases
    // zoom/pan together — this controller doesn't need to know there are two.
    this.ui.renderer.applyTransform(`translate(${x}px, ${y}px) scale(${scale})`);
  }

  _clampView() {
    const { ui } = this;
    const rect = ui.canvas.parentElement.getBoundingClientRect();
    const { scale } = ui.viewTransform;
    ui.viewTransform.x = Math.min(0, Math.max(rect.width - rect.width * scale, ui.viewTransform.x));
    ui.viewTransform.y = Math.min(0, Math.max(rect.height - rect.height * scale, ui.viewTransform.y));
  }

  _touchDist(t0, t1) {
    return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
  }

  _touchMid(t0, t1) {
    return { midX: (t0.clientX + t1.clientX) / 2, midY: (t0.clientY + t1.clientY) / 2 };
  }

  _startPinch(touches) {
    const { ui } = this;
    ui._pinch = { dist: this._touchDist(touches[0], touches[1]), ...this._touchMid(touches[0], touches[1]) };
    // The tooltip is a DOM element, not part of either canvas, so it never
    // inherits the CSS transform pinch/pan applies to the board — hide it
    // and let it reappear correctly positioned on the next real hover.
    ui.zoneTooltip.hide();
  }

  _applyPinch(touches) {
    const { ui } = this;
    const rect = ui.canvas.parentElement.getBoundingClientRect();
    const dist = this._touchDist(touches[0], touches[1]);
    const { midX, midY } = this._touchMid(touches[0], touches[1]);

    const ratio = dist / ui._pinch.dist;
    const newScale = Math.min(LAYOUT.maxZoom, Math.max(1, ui.viewTransform.scale * ratio));

    // Keep the point under the fingers stationary on screen while scaling.
    const localX = (ui._pinch.midX - rect.left - ui.viewTransform.x) / ui.viewTransform.scale;
    const localY = (ui._pinch.midY - rect.top - ui.viewTransform.y) / ui.viewTransform.scale;
    ui.viewTransform.x = midX - rect.left - localX * newScale;
    ui.viewTransform.y = midY - rect.top - localY * newScale;
    ui.viewTransform.scale = newScale;

    this._clampView();
    this._applyViewTransform();
    ui._pinch = { dist, midX, midY };
  }

  // One staging system for every piece type: a drawn-and-released gesture
  // (gesture.pending) or a hovered/tapped simple shape (cursorCell) are
  // both just "the currently staged placement" — this is the single place
  // that resolves either one into concrete { type, shape, anchorRow,
  // anchorCol }, or null if nothing is staged. Everything else (rendering
  // the ghost, enabling confirm/discard, confirming, discarding) reads
  // through this instead of branching on gesture-vs-plain itself.
  stagedPlacement() {
    const { ui } = this;
    if (ui.gesture.pending) {
      const { type, shape, anchorRow, anchorCol } = ui.gesture.pending;
      return { type, shape, anchorRow, anchorCol };
    }
    if (ui.selectedType === "gesture" || ui.selectedType === "calc") return null;
    if (!ui.cursorCell) return null;
    const shape = ui.currentShape();
    if (!shape) return null;
    return { type: ui.selectedType, shape, anchorRow: ui.cursorCell[0], anchorCol: ui.cursorCell[1] };
  }

  // Confirms whatever is currently staged. Desktop's control for this is a
  // canvas click; mobile's is the Confirm button (which also works on
  // desktop) — both funnel through here so drawn gestures and hovered
  // simple shapes resolve identically regardless of input method.
  confirmStaged() {
    const { ui } = this;
    const staged = this.stagedPlacement();
    if (!staged) return;
    // Reset staging state before submitting so a local hotseat's
    // resulting render() (or renderHover() below for online) never
    // paints a stale ghost/zone-highlight from the now-resolved placement.
    ui.gesture.cancel();
    ui.cursorCell = null;
    ui._placementLocked = false;
    ui._submitPlacement(staged.type, staged.shape, staged.anchorRow, staged.anchorCol);
    // Local hotseat: _submitPlacement() above already ran a full render().
    // matchClient: it only sent the move and is waiting on the broadcast,
    // so the cheap path is needed here to clear the now-empty ghost/path.
    if (ui.matchClient) ui.render.renderHover();
  }

  // Discards whatever is currently in progress or staged — a mid-draw
  // gesture, a finished-but-unconfirmed one, or a hovered/tapped plain
  // piece. Every "cancel" trigger routes through here: the Discard button,
  // right-click/secondaryAction, a two-finger pinch interrupting a draw,
  // and double-tap — they differ only in which control invokes it.
  discardStaged() {
    const { ui } = this;
    if (!ui.gesture.isDrawing && !ui.gesture.pending && !ui.cursorCell) return;
    ui.sound.uiDiscard();
    ui.gesture.cancel();
    ui.cursorCell = null;
    ui._placementLocked = false;
    ui.render.renderHover();
  }

  // ===================== input: DOM event listeners =====================

  _cellFromPoint(clientX, clientY) {
    const { ui } = this;
    const rect = ui.canvas.getBoundingClientRect();
    const scaleX = ui.canvas.width / rect.width;
    const scaleY = ui.canvas.height / rect.height;
    const x = (clientX - rect.left - ui.canvas.clientLeft) * scaleX;
    const y = (clientY - rect.top - ui.canvas.clientTop) * scaleY;
    const cellSize = ui.renderer.cellSize;
    const board = ui.game.board;
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

  bindCanvasEvents() {
    const { ui } = this;
    const signal = ui._abort.signal;

    ui.canvas.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 0) return;
        const cell = this._cellFromEvent(e);
        if (ui.selectedType === "calc") {
          this.startCalc(cell, e.shiftKey ? "opponent" : "self");
          return;
        }
        this.startGesture(cell);
      },
      { signal },
    );

    document.addEventListener(
      "mouseup",
      () => {
        this.finishGesture();
        this.finishCalc();
      },
      { signal },
    );

    ui.canvas.addEventListener("mousemove", (e) => this.hover(this._cellFromEvent(e)), { signal });
    ui.canvas.addEventListener("mouseleave", () => this.clearHover(), { signal });

    ui.canvas.addEventListener(
      "click",
      (e) => {
        if (ui.gesture.consumeSuppressedClick()) return;
        if (ui.selectedType === "gesture" || ui.selectedType === "calc") {
          // gesture pieces are drawn via drag, not click — a bare click
          // only confirms one that's already staged, unless Settings >
          // Require confirm is on, in which case only the Confirm button
          // (or Enter) may.
          if (ui.gesture.pending && !settings.requireConfirm) this.confirmStaged();
          return;
        }
        if (settings.requireConfirm) {
          // Click stages (or re-stages) the piece and locks it there —
          // set cursorCell directly rather than through hover(), which
          // now refuses to move a locked placement. Mouse movement
          // afterward (including leaving the canvas for the button row)
          // won't drift or clear it; only Confirm/Discard/Enter/Escape
          // resolve it from here.
          ui.sound.uiClick();
          ui.cursorCell = this._cellFromEvent(e);
          ui._placementLocked = true;
          ui.render.renderHover();
          return;
        }
        // cursorCell should already track this cell via the preceding
        // mousemove, but set it explicitly for the (rare) click that
        // arrives with no prior hover — click is desktop's confirm control.
        this.hover(this._cellFromEvent(e));
        this.confirmStaged();
      },
      { signal },
    );

    ui.canvas.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        this.secondaryAction();
      },
      { signal },
    );

    ui.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        ui.rotate(e.deltaY > 0 ? 1 : -1);
      },
      { signal },
    );

    // Touch: 1 finger = existing mouse-equivalent flow (hover / gesture
    // draw), never touches the view transform. 2 fingers = pinch-zoom/pan,
    // never touches placement state. A short delay before committing a
    // fresh single-finger touch (see PINCH_DISAMBIGUATE_MS) stops the
    // ghost/gesture-path from flashing at finger 1's position the instant
    // before finger 2 lands for a pinch-from-rest.
    ui.canvas.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        if (e.touches.length === 1) {
          const touch = e.touches[0];
          ui._pinch = null;
          ui._suppressHoverUntilLift = false;
          ui._touchStartInfo = { x: touch.clientX, y: touch.clientY, time: Date.now() };
          ui._pendingTouch = { cell: this._cellFromTouch(touch) };
          ui._pendingTouchTimer = setTimeout(() => {
            ui._pendingTouchTimer = null;
            const pending = ui._pendingTouch;
            ui._pendingTouch = null;
            if (!pending) return;
            this.hover(pending.cell);
            this.startGesture(pending.cell);
          }, PINCH_DISAMBIGUATE_MS);
        } else if (e.touches.length === 2) {
          if (ui._pendingTouchTimer) {
            // Second finger arrived before we committed finger 1 to
            // anything — this was a pinch from rest, not an interrupted
            // drag. Drop the pending commit entirely.
            clearTimeout(ui._pendingTouchTimer);
            ui._pendingTouchTimer = null;
            ui._pendingTouch = null;
          } else if (ui.gesture.isDrawing) {
            // Delay already resolved — a real single-finger draw was in
            // progress and got interrupted by a second finger.
            this.discardStaged();
          }
          ui._suppressHoverUntilLift = true;
          this._startPinch(e.touches);
        }
      },
      { passive: false, signal },
    );

    ui.canvas.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        if (e.touches.length === 1) {
          if (ui._pendingTouch) {
            // Still inside the disambiguation window — track where the
            // finger is, but don't act on it until it resolves.
            ui._pendingTouch.cell = this._cellFromTouch(e.touches[0]);
          } else if (!ui._suppressHoverUntilLift) {
            this.hover(this._cellFromTouch(e.touches[0]));
          }
        } else if (e.touches.length >= 2) {
          this._applyPinch(e.touches);
        }
      },
      { passive: false, signal },
    );

    ui.canvas.addEventListener(
      "touchend",
      (e) => {
        e.preventDefault();
        const remaining = e.touches.length;

        if (remaining === 0) {
          if (ui._pendingTouchTimer) {
            // Lifted before the delay resolved — a genuine quick tap,
            // not an aborted pinch. Commit it now rather than dropping it.
            clearTimeout(ui._pendingTouchTimer);
            ui._pendingTouchTimer = null;
            const pending = ui._pendingTouch;
            ui._pendingTouch = null;
            if (pending) {
              this.hover(pending.cell);
              this.startGesture(pending.cell);
            }
          }
          ui._pinch = null;
          ui._suppressHoverUntilLift = false;
          this._checkDoubleTap(e.changedTouches[0]);
          this.finishGesture();
        } else if (remaining === 1) {
          // Dropped from a pinch back to one finger — that finger was
          // mid-pinch, not placing. Wait for a fresh touchstart rather
          // than repurposing it as a placement drag.
          ui._pinch = null;
          ui._suppressHoverUntilLift = true;
        } else {
          this._startPinch(e.touches); // still 2+, rebase to avoid a jump
        }
      },
      { passive: false, signal },
    );
  }

  _checkDoubleTap(touch) {
    const { ui } = this;
    if (!touch || !ui._touchStartInfo) return;
    const dist = Math.hypot(touch.clientX - ui._touchStartInfo.x, touch.clientY - ui._touchStartInfo.y);
    const duration = Date.now() - ui._touchStartInfo.time;
    ui._touchStartInfo = null;

    if (dist >= TAP_MAX_DIST || duration >= TAP_MAX_DURATION_MS) {
      ui._lastTap = null; // a drag breaks the double-tap chain
      return;
    }

    const last = ui._lastTap;
    const withinInterval = last && Date.now() - last.time < DOUBLE_TAP_MAX_INTERVAL_MS;
    const withinDist = last && Math.hypot(touch.clientX - last.x, touch.clientY - last.y) < DOUBLE_TAP_MAX_DIST;
    if (withinInterval && withinDist) {
      // The two taps that make up this double-tap each staged a ghost via
      // the normal single-tap flow already (see touchend) — a double-tap
      // is a meta action, not a placement gesture, so undo that instead of
      // leaving a piece preview behind that the user never asked to place.
      this.resetView();
      this.clearHover();
      this.discardStaged();
      ui._lastTap = null;
    } else {
      ui._lastTap = { time: Date.now(), x: touch.clientX, y: touch.clientY };
    }
  }
}
