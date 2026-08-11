import { Board } from "../../../shared/engine/board.js";
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
    if (!this.isDrawing) return false;
    const last = this.path[this.path.length - 1];
    // Consecutive touchmove/mousemove events can be more than one cell
    // apart on a slow frame.
    const cells = last ? GestureInput._lineCells(last, cell) : [cell];
    let grew = false;
    for (const c of cells) {
      const key = Board.key(...c);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.path.push(c);
      grew = true;
    }
    return grew;
  }

  // Bresenham grid-line walk from `from` to `to`, exclusive of `from`
  // (which is already in the path) and inclusive of `to`.
  static _lineCells([r0, c0], [r1, c1]) {
    const cells = [];
    const dr = Math.abs(r1 - r0);
    const dc = Math.abs(c1 - c0);
    const sr = r0 < r1 ? 1 : -1;
    const sc = c0 < c1 ? 1 : -1;
    let err = dr - dc;
    let r = r0;
    let c = c0;
    while (r !== r1 || c !== c1) {
      const e2 = 2 * err;
      if (e2 > -dc) {
        err -= dc;
        r += sr;
      }
      if (e2 < dr) {
        err += dr;
        c += sc;
      }
      cells.push([r, c]);
    }
    return cells;
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

  // The click right after a mouseup that just finished a gesture shouldn't
  // also place a piece — call this from the click handler and bail out if
  // it returns true.
  consumeSuppressedClick() {
    if (!this.suppressNextClick) return false;
    this.suppressNextClick = false;
    return true;
  }
}
