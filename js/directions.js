// The four orthogonal neighbor directions (no diagonals) — used anywhere
// board logic needs to walk from a cell to its up/down/left/right neighbor.
export const ORTHOGONAL_OFFSETS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// Same four directions, each tagged with which edge of the cell it points
// across. Used when rendering cell borders (e.g. zone outlines): a border
// is drawn on an edge whenever the neighbor across it doesn't belong to
// the same zone.
export const ORTHOGONAL_EDGES = [
  [-1, 0, "top"],
  [1, 0, "bottom"],
  [0, -1, "left"],
  [0, 1, "right"],
];
