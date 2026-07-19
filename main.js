let grid = generateGrid(ROWS, COLS);
const bonusMarkers = placeBonusMarkers(grid, 10);
const occupied = new Set();
const cellZone = grid.map((row) => row.map(() => null));
const zones = [];

let currentPlayer = 0;
let dominoLeft = [STARTING_DOMINOS, STARTING_DOMINOS];
let scores = [0, 0];

let selectedType = "gesture";
let rotationStep = 0;
let flipped = false;
let hoverCell = null;

let isDrawingGesture = false;
let gesturePath = [];
let gestureSeen = new Set();
let pendingGesture = null; // {shape, anchorRow, anchorCol} — awaiting confirm click
let suppressNextClick = false;

let consecutivePasses = 0;
let gameOver = false;

const clamp = (num, min, max) => Math.min(Math.max(num, min), max);

function updateBoard() {
  const [activeCell, activeShape] = getActivePlacement();
  const activeType = pendingGesture ? pendingGesture.type : selectedType;
  render(
    grid,
    cellZone,
    zones,
    occupied,
    bonusMarkers,
    activeCell,
    activeShape,
    activeType,
    dominoLeft,
    currentPlayer,
    gesturePath,
  );
}

function updateTurnIndicator() {
  document.getElementById("turnIndicator").textContent = `Player ${currentPlayer + 1}'s move`;
}

function updateButtonHighlight() {
  document.querySelectorAll("#pieceButtons button").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.type === selectedType);
  });
}

function updateScoreBoard() {
  document.getElementById("score1").textContent = scores[0];
  document.getElementById("score2").textContent = scores[1];
}

function updatePassButton() {
  const canMove = canPlayerMove(
    grid,
    cellZone,
    occupied,
    zones,
    dominoLeft,
    currentPlayer,
    getAvailableTypes(currentPlayer),
  );
  document.getElementById("passBtn").disabled = canMove || gameOver;
}

function endGame() {
  gameOver = true;
  const banner = document.getElementById("gameOverBanner");
  banner.style.display = "block";
  if (scores[0] === scores[1]) {
    banner.textContent = "Draw!";
  } else {
    const winner = scores[0] > scores[1] ? 1 : 2;
    banner.textContent = `Game over. Player ${winner} wins!`;
  }
}

function currentShape() {
  if (selectedType === "gesture") return null;
  let shape = SHAPES_BASE[selectedType];
  if (flipped) shape = reflectShape(shape);
  for (let i = 0; i < rotationStep; i++) shape = rotateShape(shape);
  return shape;
}

function getCellFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const mouseX = (event.clientX - rect.left - canvas.clientLeft) * scaleX;
  const mouseY = (event.clientY - rect.top - canvas.clientTop) * scaleY;
  const col = clamp(Math.floor(mouseX / LAYOUT.cellSize), 0, COLS - 1);
  const row = clamp(Math.floor(mouseY / LAYOUT.cellSize), 0, ROWS - 1);
  return [row, col];
}

function getActivePlacement() {
  if (pendingGesture) return [[pendingGesture.anchorRow, pendingGesture.anchorCol], pendingGesture.shape];
  if (selectedType === "gesture") return [null, null]; // nothing drawn/confirmed yet
  if (!hoverCell) return [null, null];
  return [hoverCell, currentShape()];
}

function getAvailableTypes(player) {
  const types = ["tromino", "tetromino"];
  if (dominoLeft[player] > 0) types.push("domino");
  return types;
}

function checkZoneCompletions() {
  for (const zone of zones) {
    if (!zone.active) continue;
    const types = getAvailableTypes(zone.localTurn);
    if (!zoneHasMove(grid, cellZone, occupied, zones, zone, dominoLeft, zone.localTurn, types)) {
      zone.active = false;
      const winner = 1 - zone.localTurn; // last mover in this zone
      scores[winner] += zone.cost;
    }
  }
}

canvas.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  if (selectedType !== "gesture") return;
  if (pendingGesture) return;
  const [row, col] = getCellFromEvent(event);
  isDrawingGesture = true;
  gesturePath = [`${row},${col}`];
  gestureSeen = new Set(gesturePath);
  updateBoard();
});

document.addEventListener("mouseup", () => {
  if (!isDrawingGesture) return;
  isDrawingGesture = false;
  pendingGesture = recognizeGesture(gesturePath);
  gesturePath = [];
  gestureSeen = new Set();
  suppressNextClick = true;
  updateBoard();
});

canvas.addEventListener("mousemove", (event) => {
  hoverCell = getCellFromEvent(event);
  if (isDrawingGesture) {
    const key = `${hoverCell[0]},${hoverCell[1]}`;
    if (!gestureSeen.has(key)) {
      gestureSeen.add(key);
      gesturePath.push(key);
    }
  }
  updateBoard();
});

canvas.addEventListener("mouseleave", () => {
  hoverCell = null;
  updateBoard();
});

function attemptPlacement(pieceType, shape, anchorRow, anchorCol) {
  if (!canPlaceHere(grid, cellZone, occupied, zones, pieceType, dominoLeft, currentPlayer, shape, anchorRow, anchorCol))
    return false;

  if (pieceType === "domino") dominoLeft[currentPlayer]--;
  for (const [r, c] of getShapeCells(shape, anchorRow, anchorCol)) occupied.add(`${r},${c}`);

  const zoneId = cellZone[anchorRow][anchorCol];
  if (zoneId === null) {
    createZone(grid, cellZone, zones, bonusMarkers, anchorRow, anchorCol, currentPlayer, ZONE_RADIUS);
  } else {
    zones[zoneId].localTurn = 1 - currentPlayer;
  }

  checkZoneCompletions();
  updateScoreBoard();
  consecutivePasses = 0;
  currentPlayer = 1 - currentPlayer;
  updateTurnIndicator();
  updatePassButton();
  return true;
}

canvas.addEventListener("click", (event) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }

  if (selectedType === "gesture") {
    if (!pendingGesture) return;
    const { shape, anchorRow, anchorCol } = pendingGesture;
    attemptPlacement(pendingGesture.type, shape, anchorRow, anchorCol);
    pendingGesture = null;
    updateBoard();
    return;
  }

  const [row, col] = getCellFromEvent(event);
  const shape = currentShape();
  attemptPlacement(selectedType, shape, row, col);
  updateBoard();
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();

  if (selectedType === "gesture") {
    isDrawingGesture = false;
    pendingGesture = null;
    gesturePath = [];
    gestureSeen = new Set();
    updateBoard();
    return;
  }

  flipped = !flipped;
  updateBoard();
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const dir = event.deltaY > 0 ? 1 : -1;
  rotationStep = (rotationStep + dir + 4) % 4;
  updateBoard();
});

function selectType(type) {
  selectedType = type;
  rotationStep = 0;
  flipped = false;
  pendingGesture = null;
  isDrawingGesture = false;
  gesturePath = [];
  gestureSeen = new Set();
  suppressNextClick = false;
  updateButtonHighlight();
  updateBoard();
}

document.querySelectorAll("#pieceButtons button").forEach((btn) => {
  btn.addEventListener("click", () => selectType(btn.dataset.type));
});

const KEY_TO_TYPE = { 1: "gesture", 2: "domino", 3: "tromino", 4: "tetromino" };

document.addEventListener("keydown", (event) => {
  const type = KEY_TO_TYPE[event.key];
  if (!type) return;
  selectType(type);
});

document.getElementById("passBtn").addEventListener("click", () => {
  if (gameOver) return;
  if (canPlayerMove(grid, cellZone, occupied, zones, dominoLeft, currentPlayer, getAvailableTypes(currentPlayer)))
    return;

  scores[currentPlayer] = Math.floor(scores[currentPlayer] * PASS_PENALTY);
  consecutivePasses++;
  updateScoreBoard();

  if (consecutivePasses >= 2) {
    endGame();
    return;
  }

  currentPlayer = 1 - currentPlayer;
  updateTurnIndicator();
  updateBoard();
  updatePassButton();
});

updateBoard();
updateButtonHighlight();
updateTurnIndicator();
updateScoreBoard();
updatePassButton();
