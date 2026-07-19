const SHAPES_BASE = {
  domino: [
    [0, 0],
    [1, 0],
  ],
  tromino: [
    [0, 0],
    [0, 1],
    [1, 0],
  ],
  tetromino: [
    [0, 0],
    [0, 1],
    [2, 0],
    [1, 0],
  ],
};

function rotateShape(shape) {
  return shape.map(([r, c]) => [c, -r]);
}

function reflectShape(shape) {
  return shape.map(([r, c]) => [r, -c]);
}

function shapeKey(shape) {
  return JSON.stringify([...shape].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
}

function getTransforms(shape) {
  const variants = [];
  const seenKeys = new Set();

  function addVariant(s) {
    const key = shapeKey(s);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      variants.push(s);
    }
  }

  let current = shape;
  for (let i = 0; i < 4; i++) {
    addVariant(current);
    current = rotateShape(current);
  }
  let reflected = reflectShape(shape);
  for (let i = 0; i < 4; i++) {
    addVariant(reflected);
    reflected = rotateShape(reflected);
  }
  return variants;
}

const SHAPE_VARIANTS = {
  domino: getTransforms(SHAPES_BASE.domino),
  tromino: getTransforms(SHAPES_BASE.tromino),
  tetromino: getTransforms(SHAPES_BASE.tetromino),
};

function getShapeCells(shape, anchorRow, anchorCol) {
  return shape.map(([dr, dc]) => [anchorRow + dr, anchorCol + dc]);
}

function isValidPlacement(grid, occupied, shape, anchorRow, anchorCol) {
  const rows = grid.length,
    cols = grid[0].length;
  return getShapeCells(shape, anchorRow, anchorCol).every(([r, c]) => {
    if (r < 0 || c < 0 || r >= rows || c >= cols) return false;
    if (grid[r][c] !== 1) return false;
    if (occupied.has(`${r},${c}`)) return false;
    return true;
  });
}

// gesture

function normalizeToMin(shape) {
  const minR = Math.min(...shape.map(([r]) => r));
  const minC = Math.min(...shape.map(([, c]) => c));
  return shape.map(([r, c]) => [r - minR, c - minC]);
}

function shapeMatchKey(shape) {
  return JSON.stringify(normalizeToMin(shape).sort((a, b) => a[0] - b[0] || a[1] - b[1]));
}

const CELL_COUNT_TO_TYPE = { 2: "domino", 3: "tromino", 4: "tetromino" };

function recognizeGesture(path) {
  const type = CELL_COUNT_TO_TYPE[path.length];
  if (!type) return null;

  if (type === "domino") {
    const [r0, c0] = path[0].split(",").map(Number);
    const [r1, c1] = path[1].split(",").map(Number);
    const dr = r1 - r0,
      dc = c1 - c0;
    const isAdjacent = (Math.abs(dr) === 1 && dc === 0) || (dr === 0 && Math.abs(dc) === 1);
    if (!isAdjacent) return null;
    return {
      type,
      shape: [
        [0, 0],
        [dr, dc],
      ],
      anchorRow: r0,
      anchorCol: c0,
    };
  }

  const drawnCells = path.map((key) => key.split(",").map(Number));
  const drawnKey = shapeMatchKey(drawnCells);
  const matched = SHAPE_VARIANTS[type].find((variant) => shapeMatchKey(variant) === drawnKey);
  if (!matched) return null;

  const drawnMinR = Math.min(...drawnCells.map(([r]) => r));
  const drawnMinC = Math.min(...drawnCells.map(([, c]) => c));
  const variantMinR = Math.min(...matched.map(([r]) => r));
  const variantMinC = Math.min(...matched.map(([, c]) => c));

  return {
    type,
    shape: matched,
    anchorRow: drawnMinR - variantMinR,
    anchorCol: drawnMinC - variantMinC,
  };
}
