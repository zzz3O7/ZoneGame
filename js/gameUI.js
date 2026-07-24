import { Board } from "./board.js";
import { Shape, SHAPES_BASE } from "./shape.js";
import { GestureRecognizer } from "./gestureRecognizer.js";

const KEY_TO_TYPE = { 1: "gesture", 2: "domino", 3: "tromino", 4: "tetromino" };

export class GameUI {
  constructor(game, renderer, canvas) {
    this.game = game;
    this.renderer = renderer;
    this.canvas = canvas;

    this.selectedType = "gesture";
    this.rotationStep = 0;
    this.flipped = false;
    this.hoverCell = null;

    this.isDrawingGesture = false;
    this.gesturePath = [];
    this.gestureSeen = new Set();
    this.pendingGesture = null; // { type, shape, anchorRow, anchorCol } or null
    this.suppressNextClick = false;

    this._bindCanvasEvents();
    this._bindControls();
  }

  init() {
    this._updateButtonHighlight();
    this._updateTurnIndicator();
    this._updateScoreBoard();
    this._updatePassButton();
    this.refresh();
  }

  currentShape() {
    if (this.selectedType === "gesture") return null;
    let cells = SHAPES_BASE[this.selectedType];
    if (this.flipped) cells = Shape.reflect(cells);
    for (let i = 0; i < this.rotationStep; i++) cells = Shape.rotate(cells);
    return cells;
  }

  getActivePlacement() {
    if (this.pendingGesture) {
      return [[this.pendingGesture.anchorRow, this.pendingGesture.anchorCol], this.pendingGesture.shape];
    }
    if (this.selectedType === "gesture") return [null, null];
    if (!this.hoverCell) return [null, null];
    return [this.hoverCell, this.currentShape()];
  }

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
    this.canvas.addEventListener("mousedown", (e) => this._onMouseDown(e));
    document.addEventListener("mouseup", () => this._onMouseUp());
    this.canvas.addEventListener("mousemove", (e) => this._onMouseMove(e));
    this.canvas.addEventListener("mouseleave", () => this._onMouseLeave());
    this.canvas.addEventListener("click", (e) => this._onClick(e));
    this.canvas.addEventListener("contextmenu", (e) => this._onContextMenu(e));
    this.canvas.addEventListener("wheel", (e) => this._onWheel(e));
  }

  _bindControls() {
    document.querySelectorAll("#pieceButtons button").forEach((btn) => {
      btn.addEventListener("click", () => this.selectType(btn.dataset.type));
    });
    document.getElementById("passBtn").addEventListener("click", () => this._onPassClick());
    document.addEventListener("keydown", (event) => {
      const type = KEY_TO_TYPE[event.key];
      if (!type) return;
      this.selectType(type);
    });
  }

  _onMouseDown(event) {
    if (event.button !== 0) return;
    if (this.selectedType !== "gesture") return;
    if (this.pendingGesture) return;

    const [row, col] = this._cellFromEvent(event);
    this.isDrawingGesture = true;
    this.gesturePath = [[row, col]];
    this.gestureSeen = new Set(this.gesturePath.map(([r, c]) => Board.key(r, c)));
    this.refresh();
  }

  _onMouseUp() {
    if (!this.isDrawingGesture) return;
    this.isDrawingGesture = false;
    this.pendingGesture = GestureRecognizer.recognize(this.gesturePath);
    this.gesturePath = [];
    this.gestureSeen = new Set();
    this.suppressNextClick = true;
    this.refresh();
  }

  _onMouseMove(event) {
    this.hoverCell = this._cellFromEvent(event);
    if (this.isDrawingGesture) {
      const key = Board.key(...this.hoverCell);
      if (!this.gestureSeen.has(key)) {
        this.gestureSeen.add(key);
        this.gesturePath.push(this.hoverCell);
      }
    }
    this.refresh();
  }

  _onMouseLeave() {
    this.hoverCell = null;
    this.refresh();
  }

  _onClick(event) {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }

    if (this.selectedType === "gesture") {
      if (!this.pendingGesture) return;
      const { type, shape, anchorRow, anchorCol } = this.pendingGesture;
      this.game.attemptPlacement(type, shape, anchorRow, anchorCol);
      this.pendingGesture = null;
      this._afterMove();
      return;
    }

    const [row, col] = this._cellFromEvent(event);
    this.game.attemptPlacement(this.selectedType, this.currentShape(), row, col);
    this._afterMove();
  }

  _onContextMenu(event) {
    event.preventDefault();

    if (this.selectedType === "gesture") {
      this.isDrawingGesture = false;
      this.pendingGesture = null;
      this.gesturePath = [];
      this.gestureSeen = new Set();
      this.refresh();
      return;
    }

    this.flipped = !this.flipped;
    this.refresh();
  }

  _onWheel(event) {
    event.preventDefault();
    const dir = event.deltaY > 0 ? 1 : -1;
    this.rotationStep = (this.rotationStep + dir + 4) % 4;
    this.refresh();
  }

  selectType(type) {
    this.selectedType = type;
    this.rotationStep = 0;
    this.flipped = false;
    this.pendingGesture = null;
    this.isDrawingGesture = false;
    this.gesturePath = [];
    this.gestureSeen = new Set();
    this.suppressNextClick = false;
    this._updateButtonHighlight();
    this.refresh();
  }

  _onPassClick() {
    if (!this.game.pass()) return;
    this._afterMove();
  }

  _afterMove() {
    this._updateScoreBoard();
    this._updateTurnIndicator();
    this._updatePassButton();
    if (this.game.gameOver) this._showGameOver();
    this.refresh();
  }

  _updateButtonHighlight() {
    document.querySelectorAll("#pieceButtons button").forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.type === this.selectedType);
    });
  }

  _updateScoreBoard() {
    document.getElementById("score1").textContent = this.game.players[0].score;
    document.getElementById("score2").textContent = this.game.players[1].score;
  }

  _updateTurnIndicator() {
    document.getElementById("turnIndicator").textContent = `Player ${this.game.currentPlayerIndex + 1}'s move`;
  }

  _updatePassButton() {
    const canMove = this.game.canCurrentPlayerMove();
    document.getElementById("passBtn").disabled = canMove || this.game.gameOver;
  }

  _showGameOver() {
    const banner = document.getElementById("gameOverBanner");
    banner.style.display = "block";
    const winner = this.game.winnerIndex;
    banner.textContent = winner === null ? "Draw!" : `Game over. Player ${winner + 1} wins!`;
  }

  refresh() {
    const [activeCell, activeShape] = this.getActivePlacement();
    const activeType = this.pendingGesture ? this.pendingGesture.type : this.selectedType;

    this.renderer.render(
      this.game.board,
      this.game.zones,
      this.game.currentPlayer,
      activeType,
      activeShape,
      activeCell,
      this.gesturePath,
    );
  }
}
