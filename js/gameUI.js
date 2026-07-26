import { Board } from "./board.js";
import { Shape, SHAPES_BASE } from "./shape.js";
import { GestureRecognizer } from "./gestureRecognizer.js";
import { PASS_PENALTY } from "./config.js";

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

    this.isDrawingGesture = false;
    this.gesturePath = [];
    this.gestureSeen = new Set();
    this.pendingGesture = null; // { type, shape, anchorRow, anchorCol } or null
    this.suppressNextClick = false;

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
    this.pendingGesture = null;
    this.isDrawingGesture = false;
    this.gesturePath = [];
    this.gestureSeen = new Set();
    this.suppressNextClick = false;
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
    if (this.pendingGesture) return;
    this.isDrawingGesture = true;
    this.gesturePath = [cell];
    this.gestureSeen = new Set([Board.key(...cell)]);
    this._render();
  }

  finishGesture() {
    if (!this.isDrawingGesture) return;
    this.isDrawingGesture = false;
    this.pendingGesture = GestureRecognizer.recognize(this.gesturePath);
    this.gesturePath = [];
    this.gestureSeen = new Set();
    this.suppressNextClick = true; // the click right after mouseup shouldn't also place a piece
    this._render();
  }

  cancelGesture() {
    this.isDrawingGesture = false;
    this.pendingGesture = null;
    this.gesturePath = [];
    this.gestureSeen = new Set();
    this._render();
  }

  confirmGesture() {
    if (!this.pendingGesture) return;
    const { type, shape, anchorRow, anchorCol } = this.pendingGesture;
    this.game.attemptPlacement(type, shape, anchorRow, anchorCol);
    this.pendingGesture = null;
    this._render();
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
    if (this.isDrawingGesture) {
      const key = Board.key(...cell);
      if (!this.gestureSeen.has(key)) {
        this.gestureSeen.add(key);
        this.gesturePath.push(cell);
      }
    }
    this._updateZoneTooltip(cell);
    this._render();
  }

  clearHover() {
    this.cursorCell = null;
    this._updateZoneTooltip(null);
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
      if (this.suppressNextClick) {
        this.suppressNextClick = false;
        return;
      }
      if (this.pendingGesture) {
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
    if (this.pendingGesture) {
      return [[this.pendingGesture.anchorRow, this.pendingGesture.anchorCol], this.pendingGesture.shape];
    }
    if (this.selectedType === "gesture") return [null, null];
    if (!this.cursorCell) return [null, null];
    return [this.cursorCell, this.currentShape()];
  }

  _boardRectInfo() {
    const rect = this.canvas.getBoundingClientRect();
    const wrapRect = this.canvas.parentElement.getBoundingClientRect();
    const board = this.game.board;
    return {
      cssCellW: rect.width / board.cols,
      cssCellH: rect.height / board.rows,
      offsetX: rect.left - wrapRect.left,
      offsetY: rect.top - wrapRect.top,
    };
  }

  _updateZoneTooltip(cell) {
    const tooltip = document.getElementById("zoneTooltip");
    if (!tooltip) return;

    const board = this.game.board;
    const zoneId = cell ? board.zoneIdAt(cell[0], cell[1]) : null;
    if (zoneId === null) {
      tooltip.hidden = true;
      return;
    }

    const zone = this.game.zones[zoneId];
    let minRow = Infinity,
      maxRow = -Infinity,
      minCol = Infinity,
      maxCol = -Infinity;
    for (const key of zone.cellSet) {
      const [r, c] = Board.parse(key);
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
    }

    const { cssCellW, cssCellH, offsetX, offsetY } = this._boardRectInfo();
    const centerX = offsetX + ((minCol + maxCol + 1) / 2) * cssCellW;
    const topY = offsetY + minRow * cssCellH;
    const bottomY = offsetY + (maxRow + 1) * cssCellH;
    const showAbove = topY > 30;

    tooltip.textContent = `Reward: ${zone.cost}`;
    tooltip.style.left = `${centerX}px`;
    tooltip.style.top = showAbove ? `${topY}px` : `${bottomY}px`;
    tooltip.classList.toggle("zone-tooltip--above", showAbove);
    tooltip.classList.toggle("zone-tooltip--below", !showAbove);
    tooltip.hidden = false;
  }

  _render() {
    this._syncCanvas();
    this._syncControls();
    this._syncSidePlates();
    this._syncGameOver();
  }

  _syncCanvas() {
    const [anchorCell, anchorShape] = this._activePlacement();
    const pieceType = this.pendingGesture ? this.pendingGesture.type : this.selectedType;

    this.renderer.render(
      this.game.board,
      this.game.zones,
      this.game.currentPlayer,
      pieceType,
      anchorShape,
      anchorCell,
      this.cursorCell,
      this.gesturePath,
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
