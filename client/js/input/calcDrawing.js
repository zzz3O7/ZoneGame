import { Board } from "../../../shared/engine/board.js";
import { GestureInput } from "./gestureInput.js";

// Owns calc-mode's annotation state: freehand cell painting for planning
// ahead. Purely a scratchpad — never touches Game or the network, and
// never produces a move. Two colors ("self"/"opponent") let a player
// sketch an exchange: their own planned move and the response they're
// expecting. Same contract as GestureInput — GameUI drives it and reacts
// to its state, this class knows nothing about rendering or DOM.
//
// Undo/redo is a stack of whole-board snapshots taken *before* each
// mutating action (a finished stroke, or a clear).
export class CalcDrawing {
  constructor() {
    this.cells = new Map(); // key -> "self" | "opponent"
    this._history = []; // Snapshots, most recent last
    this._redo = [];
    this._strokeColor = null; // set while a stroke is in progress
    this._strokeBefore = null; // snapshot taken at stroke start
    this._lastCell = null;
  }

  get isDrawing() {
    return this._strokeColor !== null;
  }

  get canUndo() {
    return this._history.length > 0;
  }

  get canRedo() {
    return this._redo.length > 0;
  }

  start(cell, color = "self") {
    if (this.isDrawing) return;
    this._strokeColor = color;
    this._strokeBefore = new Map(this.cells);
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
    if (this.cells.get(key) === this._strokeColor) return false;
    this.cells.set(key, this._strokeColor);
    return true;
  }

  // Returns true if the stroke actually painted anything (so GameUI knows
  // whether a render is needed / an undo entry was pushed).
  finish() {
    if (!this.isDrawing) return false;
    const changed = !this._sameAs(this._strokeBefore);
    if (changed) {
      this._history.push(this._strokeBefore);
      this._redo = [];
    }
    this._strokeColor = null;
    this._strokeBefore = null;
    this._lastCell = null;
    return changed;
  }

  clear() {
    if (this.cells.size === 0) return false;
    this._history.push(new Map(this.cells));
    this._redo = [];
    this.cells = new Map();
    return true;
  }

  undo() {
    if (this._history.length === 0) return false;
    this._redo.push(new Map(this.cells));
    this.cells = this._history.pop();
    return true;
  }

  redo() {
    if (this._redo.length === 0) return false;
    this._history.push(new Map(this.cells));
    this.cells = this._redo.pop();
    return true;
  }

  _sameAs(map) {
    if (map.size !== this.cells.size) return false;
    for (const [key, color] of map) {
      if (this.cells.get(key) !== color) return false;
    }
    return true;
  }
}
