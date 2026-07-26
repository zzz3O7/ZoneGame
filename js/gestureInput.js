import { Board } from "./board.js";
import { GestureRecognizer } from "./gestureRecognizer.js";

// Owns the freehand gesture-drawing state machine: tracks the path while the
// mouse is down, recognizes it into a shape once released, and holds that
// pending shape until the player confirms or cancels it. Knows nothing about
// the game, rendering, or DOM — GameUI drives it and reacts to its state.
export class GestureInput {
  constructor() {
    this.isDrawing = false;
    this.path = [];
    this.seen = new Set();
    this.pending = null; // { type, shape, anchorRow, anchorCol } or null
    this.suppressNextClick = false;
  }

  start(cell) {
    if (this.pending) return;
    this.isDrawing = true;
    this.path = [cell];
    this.seen = new Set([Board.key(...cell)]);
  }

  extend(cell) {
    if (!this.isDrawing) return;
    const key = Board.key(...cell);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.path.push(cell);
  }

  finish() {
    if (!this.isDrawing) return false;
    this.isDrawing = false;
    this.pending = GestureRecognizer.recognize(this.path);
    this.path = [];
    this.seen = new Set();
    this.suppressNextClick = true; // the click right after mouseup shouldn't also place a piece
    return true;
  }

  cancel() {
    this.isDrawing = false;
    this.pending = null;
    this.path = [];
    this.seen = new Set();
  }

  // Full reset, including the post-mouseup click suppression — used when
  // switching input mode entirely (e.g. selecting a different piece type).
  reset() {
    this.cancel();
    this.suppressNextClick = false;
  }

  // Confirms the pending gesture via onConfirm(type, shape, anchorRow, anchorCol).
  // Returns true if a gesture was actually confirmed, false if nothing was pending.
  confirm(onConfirm) {
    if (!this.pending) return false;
    const { type, shape, anchorRow, anchorCol } = this.pending;
    onConfirm(type, shape, anchorRow, anchorCol);
    this.pending = null;
    return true;
  }

  // The click right after a mouseup that just finished a gesture shouldn't
  // also place a piece — call this from the click handler and bail out if
  // it returns true.
  consumeSuppressedClick() {
    if (!this.suppressNextClick) return false;
    this.suppressNextClick = false;
    return true;
  }
}
