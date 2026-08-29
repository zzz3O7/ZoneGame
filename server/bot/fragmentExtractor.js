import { Board } from "../../shared/engine/board.js";

// Given a mask with NO tromino/tetromino moves left (a leaf of
// ZoneSolver's classical search), decomposes it into the straight-line
// fragment LENGTHS dominoSolver.js expects. Relies on the geometric
// argument from the original design notes: once every tromino/tetromino
// placement is exhausted, each remaining connected blob MUST be a
// straight line — anything with an L-shaped bend would still admit a
// tromino, contradicting "no moves left". This does not re-derive that
// argument; it trusts it and self-checks it (see below) rather than
// silently producing wrong fragment lengths if it's ever violated.
//
// zoneSolver: a ZoneSolver instance (reused for its cell/component
// machinery — this file adds no new adjacency logic of its own).
// mask: the leaf position to decompose.
//
// Returns an array of fragment lengths, one per connected component.
// Throws if any component is NOT a straight line - this is treated as a
// bug signal (a violated invariant) rather than something to silently
// paper over, since a wrong fragment length would silently corrupt
// every downstream domino calculation.
export function fragmentLengthsOf(zoneSolver, mask) {
  const components = zoneSolver._components(mask);
  const lengths = [];

  for (const compMask of components) {
    const cells = zoneSolver.cellsOfMask(compMask);
    if (cells.length <= 1) {
      lengths.push(cells.length);
      continue;
    }

    const rows = new Set(cells.map(([r]) => r));
    const cols = new Set(cells.map(([, c]) => c));
    const isHorizontal = rows.size === 1;
    const isVertical = cols.size === 1;

    if (!isHorizontal && !isVertical) {
      throw new Error(
        `fragmentLengthsOf: component is not a straight line (rows=${rows.size}, cols=${cols.size}) - ` +
          `this violates the "no bends once tromino/tetromino moves are exhausted" invariant. ` +
          `cells=${JSON.stringify(cells)}`,
      );
    }

    // Straight-line AND connected (guaranteed by _components using the
    // same orthogonal adjacency as everywhere else) together imply
    // contiguous - no gaps - so cell count alone is the fragment length.
    // Still worth a cheap direct check rather than assuming it through:
    if (isHorizontal) {
      const row = cells[0][0];
      const colValues = cells.map(([, c]) => c).sort((a, b) => a - b);
      for (let i = 1; i < colValues.length; i++) {
        if (colValues[i] !== colValues[i - 1] + 1) {
          throw new Error(`fragmentLengthsOf: horizontal component has a gap at row ${row}, cols=${JSON.stringify(colValues)}`);
        }
      }
    } else {
      const col = cells[0][1];
      const rowValues = cells.map(([r]) => r).sort((a, b) => a - b);
      for (let i = 1; i < rowValues.length; i++) {
        if (rowValues[i] !== rowValues[i - 1] + 1) {
          throw new Error(`fragmentLengthsOf: vertical component has a gap at col ${col}, rows=${JSON.stringify(rowValues)}`);
        }
      }
    }

    lengths.push(cells.length);
  }

  return lengths;
}
