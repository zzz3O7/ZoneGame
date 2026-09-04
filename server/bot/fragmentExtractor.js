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
// Same decomposition as fragmentLengthsOf, but returns each fragment's
// actual cells IN LINE ORDER instead of just a count. Solving only ever
// needed the length; mapping a domino solver's abstract "cut" index back
// to real board cells (see jointMoveGenerator.js) needs the ordered
// cells themselves, so this is the one place that derivation happens -
// fragmentLengthsOf below is now a thin wrapper over it rather than a
// second, potentially-drifting copy of the same validation.
//
// Returns an array of { length, cells }, one per connected component,
// cells ordered along the line (ascending column for a horizontal
// fragment, ascending row for a vertical one; a length-1 fragment's
// single cell trivially satisfies both). Throws under the same
// "violates the no-bends invariant" condition as fragmentLengthsOf.
export function fragmentsOf(zoneSolver, mask) {
  const components = zoneSolver._components(mask);
  const fragments = [];

  for (const compMask of components) {
    const cells = zoneSolver.cellsOfMask(compMask);
    if (cells.length <= 1) {
      fragments.push({ length: cells.length, cells });
      continue;
    }

    const rows = new Set(cells.map(([r]) => r));
    const cols = new Set(cells.map(([, c]) => c));
    const isHorizontal = rows.size === 1;
    const isVertical = cols.size === 1;

    if (!isHorizontal && !isVertical) {
      throw new Error(
        `fragmentsOf: component is not a straight line (rows=${rows.size}, cols=${cols.size}) - ` +
          `this violates the "no bends once tromino/tetromino moves are exhausted" invariant. ` +
          `cells=${JSON.stringify(cells)}`,
      );
    }

    // Straight-line AND connected (guaranteed by _components using the
    // same orthogonal adjacency as everywhere else) together imply
    // contiguous - no gaps - so sorting along the line's axis both
    // orders the cells for the caller AND lets a cheap adjacent-diff
    // check confirm there's no gap, instead of assuming it through.
    let ordered;
    if (isHorizontal) {
      ordered = cells.slice().sort((a, b) => a[1] - b[1]);
      const row = ordered[0][0];
      for (let i = 1; i < ordered.length; i++) {
        if (ordered[i][1] !== ordered[i - 1][1] + 1) {
          throw new Error(`fragmentsOf: horizontal component has a gap at row ${row}, cols=${JSON.stringify(ordered.map((c) => c[1]))}`);
        }
      }
    } else {
      ordered = cells.slice().sort((a, b) => a[0] - b[0]);
      const col = ordered[0][1];
      for (let i = 1; i < ordered.length; i++) {
        if (ordered[i][0] !== ordered[i - 1][0] + 1) {
          throw new Error(`fragmentsOf: vertical component has a gap at col ${col}, rows=${JSON.stringify(ordered.map((c) => c[0]))}`);
        }
      }
    }

    fragments.push({ length: ordered.length, cells: ordered });
  }

  return fragments;
}

// Returns an array of fragment lengths, one per connected component.
// Throws if any component is NOT a straight line - this is treated as a
// bug signal (a violated invariant) rather than something to silently
// paper over, since a wrong fragment length would silently corrupt
// every downstream domino calculation.
export function fragmentLengthsOf(zoneSolver, mask) {
  return fragmentsOf(zoneSolver, mask).map((f) => f.length);
}
