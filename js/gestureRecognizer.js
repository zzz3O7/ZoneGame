import { Shape, SHAPE_VARIANTS } from "./shape.js";

const CELL_COUNT_TO_TYPE = { 2: "domino", 3: "tromino", 4: "tetromino" };

// [[row, col], ...] -> { type, shape, anchorRow, anchorCol } or null
export class GestureRecognizer {
  static recognize(path) {
    const type = CELL_COUNT_TO_TYPE[path.length];
    if (!type) return null;
    if (type === "domino") return GestureRecognizer._recognizeDomino(path);

    const drawnCells = path;
    const drawnKey = Shape.matchKey(drawnCells);
    const matched = SHAPE_VARIANTS[type].find((variant) => Shape.matchKey(variant) === drawnKey);
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

  static _recognizeDomino(path) {
    const [r0, c0] = path[0];
    const [r1, c1] = path[1];
    const dr = r1 - r0;
    const dc = c1 - c0;
    const isAdjacent = (Math.abs(dr) === 1 && dc === 0) || (dr === 0 && Math.abs(dc) === 1);
    if (!isAdjacent) return null;

    return {
      type: "domino",
      shape: [
        [0, 0],
        [dr, dc],
      ],
      anchorRow: r0,
      anchorCol: c0,
    };
  }
}
