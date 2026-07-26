import { Shape, SHAPES_BASE } from "./shape.js";
import { PASS_PENALTY } from "./config.js";
import { GestureInput } from "./gestureInput.js";
import { ZoneTooltip } from "./zoneTooltip.js";

const KEY_TO_TYPE = { 1: "gesture", 2: "domino", 3: "tromino", 4: "tetromino" };

export class GameUI {
  constructor(game, renderer, canvas) {
    this.game = game;
    this.renderer = renderer;
    this.canvas = canvas;

    this.selectedType = "gesture";
    this.rotationStep = 0;
    this.flipped = false;
    this.cursorCell = null;

    this.gesture = new GestureInput();
    this.zoneTooltip = new ZoneTooltip(canvas);

    this._bindCanvasEvents();
    this._bindControls();
  }

  init() {
    this._render();
  }

  // ===================== intents: piece selection & transforms =====================

  selectType(type) {
    this.selectedType = type;
    this.rotationStep = 0;
    this.flipped = false;
    this.gesture.reset();
    this._render();
  }

  rotate(direction) {
    this.rotationStep = (this.rotationStep + direction + 4) % 4;
    this._render();
  }

  flip() {
    this.flipped = !this.flipped;
    this._render();
  }

  currentShape() {
    if (this.selectedType === "gesture") return null;
    let cells = SHAPES_BASE[this.selectedType];
    if (this.flipped) cells = Shape.reflect(cells);
    for (let i = 0; i < this.rotationStep; i++) cells = Shape.rotate(cells);
    return cells;
  }

  // ===================== intents: gesture drawing =====================

  startGesture(cell) {
    if (this.selectedType !== "gesture") return;
    this.gesture.start(cell);
    this._render();
  }

  finishGesture() {
    if (!this.gesture.finish()) return;
    this._render();
  }

  cancelGesture() {
    this.gesture.cancel();
    this._render();
  }

  confirmGesture() {
    const confirmed = this.gesture.confirm((type, shape, anchorRow, anchorCol) => {
      this.game.attemptPlacement(type, shape, anchorRow, anchorCol);
    });
    if (confirmed) this._render();
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
    this.cursorCell = cell;
    this.gesture.extend(cell);
    this.zoneTooltip.update(cell, this.game.board, this.game.zones);
    this._render();
  }

  clearHover() {
    this.cursorCell = null;
    this.zoneTooltip.hide();
    this._render();
  }

  placeAt([row, col]) {
    this.game.attemptPlacement(this.selectedType, this.currentShape(), row, col);
    this._render();
  }

  skipTurn() {
    if (!this.game.pass()) return;
    this._render();
  }

  // ===================== input: DOM event listeners =====================

  _cellFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = (event.clientX - rect.left - this.canvas.clientLeft) * scaleX;
    const y = (event.clientY - rect.top - this.canvas.clientTop) * scaleY;
    const cellSize = this.renderer.cellSize;
    const board = this.game.board;
    const col = Math.min(Math.max(Math.floor(x / cellSize), 0), board.cols - 1);
    const row = Math.min(Math.max(Math.floor(y / cellSize), 0), board.rows - 1);
    return [row, col];
  }

  _bindCanvasEvents() {
    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this.startGesture(this._cellFromEvent(e));
    });

    document.addEventListener("mouseup", () => this.finishGesture());

    this.canvas.addEventListener("mousemove", (e) => this.hover(this._cellFromEvent(e)));
    this.canvas.addEventListener("mouseleave", () => this.clearHover());

    this.canvas.addEventListener("click", (e) => {
      if (this.gesture.consumeSuppressedClick()) return;
      if (this.gesture.pending) {
        this.confirmGesture();
        return;
      }
      if (this.selectedType === "gesture") return; // nothing drawn/confirmed yet
      this.placeAt(this._cellFromEvent(e));
    });

    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.secondaryAction();
    });

    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.rotate(e.deltaY > 0 ? 1 : -1);
    });
  }

  _bindControls() {
    // Single shared control row (lives in the left "Controls" panel) — it
    // always acts on whichever player's turn it currently is.
    document.querySelectorAll(".piece-selector button[data-type]").forEach((btn) => {
      btn.addEventListener("click", () => this.selectType(btn.dataset.type));
    });

    document.querySelectorAll(".piece-btn--skip").forEach((btn) => {
      btn.addEventListener("click", () => this.skipTurn());
    });

    document.addEventListener("keydown", (event) => {
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
    });
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

  _render() {
    this._syncCanvas();
    this._syncControls();
    this._syncSidePlates();
    this._syncGameOver();
  }

  _syncCanvas() {
    const [anchorCell, anchorShape] = this._activePlacement();
    const pieceType = this.gesture.pending ? this.gesture.pending.type : this.selectedType;

    this.renderer.render(
      this.game.board,
      this.game.zones,
      this.game.currentPlayer,
      pieceType,
      anchorShape,
      anchorCell,
      this.cursorCell,
      this.gesture.path,
    );
  }

  // Controls (draw/domino/tromino/tetromino/skip) are a single shared row now —
  // there's no "inactive player's plate" anymore, the row always reflects
  // whichever player's turn it currently is.
  _syncControls() {
    const player = this.game.currentPlayer;
    const canMove = this.game.canCurrentPlayerMove();

    document.querySelectorAll(".piece-selector button[data-type]").forEach((btn) => {
      const type = btn.dataset.type;
      const disabled = this.game.gameOver || (type === "domino" && player.dominoLeft <= 0);
      btn.disabled = disabled;
      btn.classList.toggle("piece-btn--selected", type === this.selectedType);
    });

    const skipBtn = document.querySelector(".piece-btn--skip");
    if (skipBtn) {
      skipBtn.disabled = this.game.gameOver || canMove;
      const skipPenalty = player.score - Math.floor(player.score * PASS_PENALTY);
      const countEl = skipBtn.querySelector(".piece-btn__count");
      if (countEl) countEl.textContent = `-${skipPenalty}`;
    }
  }

  // Side plates (name/rating/score/clock/pieces remaining) are purely
  // informational — one per player, looked up by data-player id.
  _syncSidePlates() {
    this.game.players.forEach((player) => this._syncSidePlate(player));
  }

  _syncSidePlate(player) {
    const plate = document.querySelector(`.side-plate[data-player="${player.id}"]`);
    if (!plate) return;

    const isActive = player.id === this.game.currentPlayerIndex;
    plate.classList.toggle("side-plate--active", isActive);

    const scoreEl = plate.querySelector(".side-plate__score");
    if (scoreEl) scoreEl.textContent = player.score;

    const dominoCountEl = plate.querySelector('.side-piece__count[data-piece="domino"]');
    if (dominoCountEl) dominoCountEl.textContent = player.dominoLeft;
  }

  _syncGameOver() {
    const overlay = document.getElementById("gameOverOverlay");
    const message = document.getElementById("gameOverMessage");
    if (!overlay || !message) return;

    if (!this.game.gameOver) {
      overlay.hidden = true;
      return;
    }

    const winner = this.game.winnerIndex;
    message.textContent = winner === null ? "Draw" : `player_${winner + 1} wins`;
    overlay.hidden = false;
  }
}
