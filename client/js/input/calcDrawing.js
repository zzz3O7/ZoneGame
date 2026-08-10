import { Board } from "../../../shared/engine/board.js";
import { GestureInput } from "./gestureInput.js";

// Owns calc-mode's annotation state: freehand cell painting for planning
// ahead. Purely a scratchpad — never touches Game or the network, and
// never produces a move.
//
// Marks are stored as individual strokes (like Game.history stores placed
// pieces), not a flat cell set, so the renderer can draw each stroke the
// same way it draws a placed piece: inset squares bridged within the
// stroke, distinct shapes instead of one undifferentiated fill. Two colors
// ("self"/"opponent") let a player sketch an exchange: their own planned
// move and the response they're expecting.
//
// Undo/redo is a stack of whole-stroke-list snapshots taken *before* each
// mutating action (a finished stroke, or a clear) — same contract as
// GestureInput otherwise: GameUI drives it and reacts to its state, this
// class knows nothing about rendering or DOM.
export class CalcDrawing {
  constructor() {
    this.strokes = []; // { color, cells: Set<key> }[], oldest first
    this._history = []; // strokes-array snapshots, most recent last
    this._redo = [];
    this._current = null; // { color, cells } while a stroke is in progress
    this._lastCell = null;
  }

  get isDrawing() {
    return this._current !== null;
  }

  get isEmpty() {
    return this.strokes.length === 0;
  }

  get canUndo() {
    return this._history.length > 0;
  }

  get canRedo() {
    return this._redo.length > 0;
  }

  // Finished strokes plus the in-progress one (if any), for the renderer —
  // GameUI doesn't need to know the in-progress stroke is tracked separately.
  get displayStrokes() {
    return this._current ? [...this.strokes, this._current] : this.strokes;
  }

  start(cell, color = "self") {
    if (this.isDrawing) return;
    this._current = { color, cells: new Set() };
    this._paint(cell);
  }

  extend(cell) {
    if (!this.isDrawing) return false;
    // Consecutive mousemove events can be more than one cell apart on a
    // slow frame — same fix as GestureInput, and the same line-walk.
    const cells = this._lastCell ? GestureInput._lineCells(this._lastCell, cell) : [cell];
    let changed = false;
    for (const c of cells) {
      if (this._paint(c)) changed = true;
    }
    return changed;
  }

  _paint(cell) {
    const key = Board.key(...cell);
    this._lastCell = cell;
    if (this._current.cells.has(key)) return false;
    this._current.cells.add(key);
    return true;
  }

  // Returns true if the stroke actually painted anything (so GameUI knows
  // whether a render is needed / an undo entry was pushed).
  finish() {
    if (!this.isDrawing) return false;
    const stroke = this._current;
    this._current = null;
    this._lastCell = null;
    if (stroke.cells.size === 0) return false;

    this._history.push(this.strokes);
    this._redo = [];
    this.strokes = [...this.strokes, stroke];
    return true;
  }

  clear() {
    if (this.isEmpty) return false;
    this._history.push(this.strokes);
    this._redo = [];
    this.strokes = [];
    return true;
  }

  undo() {
    if (!this.canUndo) return false;
    this._redo.push(this.strokes);
    this.strokes = this._history.pop();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this._history.push(this.strokes);
    this.strokes = this._redo.pop();
    return true;
  }
}
