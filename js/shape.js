export const SHAPES_BASE = {
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

export class Shape {
  static rotate(cells) {
    return cells.map(([r, c]) => [c, -r]);
  }

  static reflect(cells) {
    return cells.map(([r, c]) => [r, -c]);
  }

  static key(cells) {
    return JSON.stringify([...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  }

  static variants(baseCells) {
    const variants = [];
    const seenKeys = new Set();

    const addVariant = (cells) => {
      const key = Shape.key(cells);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        variants.push(cells);
      }
    };

    let current = baseCells;
    for (let i = 0; i < 4; i++) {
      addVariant(current);
      current = Shape.rotate(current);
    }

    let reflected = Shape.reflect(baseCells);
    for (let i = 0; i < 4; i++) {
      addVariant(reflected);
      reflected = Shape.rotate(reflected);
    }

    return variants;
  }

  static cellsAt(cells, anchorRow, anchorCol) {
    return cells.map(([dr, dc]) => [anchorRow + dr, anchorCol + dc]);
  }

  static normalizeToMin(cells) {
    const minR = Math.min(...cells.map(([r]) => r));
    const minC = Math.min(...cells.map(([, c]) => c));
    return cells.map(([r, c]) => [r - minR, c - minC]);
  }

  static matchKey(cells) {
    return JSON.stringify(Shape.normalizeToMin(cells).sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  }
}

export const SHAPE_VARIANTS = {
  domino: Shape.variants(SHAPES_BASE.domino),
  tromino: Shape.variants(SHAPES_BASE.tromino),
  tetromino: Shape.variants(SHAPES_BASE.tetromino),
};
