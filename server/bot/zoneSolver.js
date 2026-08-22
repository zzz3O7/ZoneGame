import { Shape, SHAPE_VARIANTS } from "../../shared/engine/shape.js";
import { Board } from "../../shared/engine/board.js";
import { ORTHOGONAL_OFFSETS } from "../../shared/engine/directions.js";

// Dominoes are deliberately excluded from this model entirely — not
// just deprioritized, genuinely absent from the move set. A zone here
// is solved as if only trominoes/tetrominoes exist. This matches the
// coordinator-level rule (see docs/BOTS.md tier 3): dominoes are only
// even considered once every non-domino move anywhere is exhausted, so
// a solver that can't "see" dominoes at all is solving the actual
// decision the bot needs, not an approximation of a fuller game.
//
// The real payoff: with the domino's shared, match-wide budget out of
// the picture, this is a plain impartial combinatorial game with ZERO
// cross-region coupling. That means Sprague-Grundy decomposition
// applies exactly, with no caveats — a connected component's Grundy
// number can be solved fully independently of every other component,
// and the whole position's outcome is just the XOR of its components'
// numbers. (An earlier version of this solver tried to keep dominoes
// in the model and hand-roll decomposition around their shared budget;
// that coupling is a genuine, non-trivial extension of Grundy theory,
// not a mechanical add-on, and was dropped in favor of this exact,
// verifiable approach instead.)
const PIECE_TYPES = ["tromino", "tetromino"];

function mex(values) {
  let m = 0;
  while (values.has(m)) m++;
  return m;
}

export class ZoneSolver {
  // openCellKeys: iterable of "row,col" keys — the zone's CURRENTLY
  // UNOCCUPIED cells only. Pure coordinate-set combinatorics, no
  // Board/Zone/Game/Player dependency — callers compute this set from
  // live state (zone.cellSet minus board.occupied).
  //
  // maxBlobSize: once decomposition can no longer break a connected
  // region down any further (it's genuinely one contiguous open
  // blob), a region larger than this is reported as undetermined
  // rather than fully searched — see solveFull()'s null case. Tuned
  // starting point: 12 (see docs/BOTS.md) — real zones fragment fast
  // as they fill, so most positions this actually gets called on in a
  // real game are well under this regardless of the zone's original
  // size.
  //
  // maxTotalCells: a purely defensive ceiling against pathological
  // input (e.g. a custom zone radius producing tens of thousands of
  // cells) blowing up the one-time setup below — it is NOT what
  // decides whether a position is solvable. A zone can have far more
  // open cells than this and still solve instantly once it's
  // fragmented: decomposition happens first, and maxBlobSize is
  // checked per-component, after fragmentation — so a big zone that's
  // mostly filled in (lots of small leftover fragments) is handled
  // correctly regardless of its total open-cell count. Set high enough
  // that it should never fire on any real zone, however generous the
  // custom radius — see docs/BOTS.md for the case this fixed (a large,
  // heavily-fragmented zone was previously reported "uncertain" purely
  // because of raw cell count, before decomposition ever got a chance
  // to run).
  constructor(openCellKeys, { maxBlobSize = 12, maxTotalCells = 10000 } = {}) {
    this.cells = [...openCellKeys].map((key) => Board.parse(key));
    this.cellCount = this.cells.length;
    this.maxBlobSize = maxBlobSize;

    this.tooLarge = this.cellCount > maxTotalCells;
    if (this.tooLarge) {
      // Nothing below this point is worth building — solveFull() and
      // findWinningMove() both short-circuit before touching it.
      return;
    }

    this.indexOf = new Map();
    this.cells.forEach(([r, c], i) => this.indexOf.set(Board.key(r, c), i));
    this.fullMask = this.cellCount === 0 ? 0n : (1n << BigInt(this.cellCount)) - 1n;

    // Geometric adjacency, fixed for the lifetime of this solver —
    // used to split a mask into connected components. Same orthogonal
    // adjacency Zone.floodFill itself uses, so "component" here means
    // the same thing it does everywhere else in the engine.
    this.neighbors = this.cells.map(([r, c]) =>
      ORTHOGONAL_OFFSETS.map(([dr, dc]) => this.indexOf.get(Board.key(r + dr, c + dc))).filter(
        (idx) => idx !== undefined,
      ),
    );

    // Every legal (pieceType -> bitmask) placement, precomputed once —
    // identical at every node of the recursive search, so this must
    // happen exactly once, not per grundyOf() call.
    this.placements = [];
    for (const type of PIECE_TYPES) {
      for (const shape of SHAPE_VARIANTS[type]) {
        for (const [anchorRow, anchorCol] of this.cells) {
          const placedCells = Shape.cellsAt(shape, anchorRow, anchorCol);
          let mask = 0n;
          let fits = true;
          for (const [r, c] of placedCells) {
            const idx = this.indexOf.get(Board.key(r, c));
            if (idx === undefined) {
              fits = false;
              break;
            }
            mask |= 1n << BigInt(idx);
          }
          if (fits) this.placements.push(mask);
        }
      }
    }
    // Dedupe identical resulting cell-sets (a tromino and a differently
    // anchored/rotated tromino can land on the same three cells).
    this.placements = [...new Set(this.placements)];

    this.grundyMemo = new Map();
  }

  _popcount(mask) {
    let count = 0;
    for (let m = mask; m > 0n; m >>= 1n) count += Number(m & 1n);
    return count;
  }

  // Splits `mask` into its connected components (orthogonal adjacency
  // among currently-open cells), returned as an array of submasks.
  _components(mask) {
    const visited = new Set();
    const components = [];
    for (let i = 0; i < this.cellCount; i++) {
      if (((mask >> BigInt(i)) & 1n) === 0n) continue;
      if (visited.has(i)) continue;
      let compMask = 0n;
      const queue = [i];
      visited.add(i);
      while (queue.length) {
        const cur = queue.shift();
        compMask |= 1n << BigInt(cur);
        for (const nb of this.neighbors[cur]) {
          if (((mask >> BigInt(nb)) & 1n) === 0n) continue;
          if (visited.has(nb)) continue;
          visited.add(nb);
          queue.push(nb);
        }
      }
      components.push(compMask);
    }
    return components;
  }

  _movesAt(mask) {
    const moves = [];
    for (const placement of this.placements) {
      if ((placement & mask) === placement) moves.push(placement);
    }
    return moves;
  }

  // Grundy number of `mask`, tromino/tetromino moves only. Returns
  // `null` if some connected fragment of `mask` is too large to
  // search directly (see maxBlobSize) — this propagates through any
  // XOR combination it's part of, since an unknown component makes the
  // combined value unknown too, not just that component.
  //
  // Decomposition is checked at EVERY node, not just the top-level
  // call — a component can (and in real play very often does) further
  // fragment mid-recursion as pieces get placed inside it, and that's
  // exactly where most of the performance win comes from.
  grundyOf(mask) {
    if (mask === 0n) return 0;
    const cached = this.grundyMemo.get(mask);
    if (cached !== undefined) return cached;

    const components = this._components(mask);
    let result;

    if (components.length > 1) {
      let xorAcc = 0;
      let unknown = false;
      for (const comp of components) {
        const g = this.grundyOf(comp);
        if (g === null) {
          unknown = true;
          break;
        }
        xorAcc ^= g;
      }
      result = unknown ? null : xorAcc;
    } else if (this._popcount(mask) > this.maxBlobSize) {
      result = null;
    } else {
      const moves = this._movesAt(mask);
      if (moves.length === 0) {
        result = 0;
      } else {
        const seen = new Set();
        let unknown = false;
        for (const m of moves) {
          const g = this.grundyOf(mask & ~m);
          if (g === null) {
            unknown = true;
            break;
          }
          seen.add(g);
        }
        result = unknown ? null : mex(seen);
      }
    }

    this.grundyMemo.set(mask, result);
    return result;
  }

  // true  -> mover has a forced win using only tromino/tetromino moves
  // false -> mover cannot win that way (may still be salvageable with
  //          a domino — deliberately not modeled here, see header)
  // null  -> undetermined (some fragment exceeded maxBlobSize, or the
  //          zone itself exceeded maxTotalCells — see constructor)
  solveFull() {
    if (this.tooLarge) return null;
    const g = this.grundyOf(this.fullMask);
    return g === null ? null : g !== 0;
  }

  // Returns a move (as a cell-mask) that leaves the opponent facing a
  // lost position (grundy 0), or null if `mask` isn't currently a
  // determined win (not winnable, or undetermined). Any move satisfying
  // this is equally "winning" under this model — there's no cost
  // distinction left once dominoes are out of the picture — so the
  // caller is free to pick among the returned candidates however it
  // likes; this returns the first one found rather than all of them,
  // since exhaustively collecting every winning move is never actually
  // needed (see tier 3 coordinator, which picks randomly at the
  // zone-selection level, not the move level).
  //
  // Correctness note: if `mask` itself is determined (non-null), every
  // move's resulting state is guaranteed to also be determined, never
  // null — placing a piece only ever shrinks/further-fragments a
  // component, never merges components or grows one, so nothing a move
  // touches can newly exceed maxBlobSize if the starting position
  // didn't already exceed it somewhere.
  findWinningMove(mask = this.fullMask) {
    if (this.tooLarge) return null;
    const g = this.grundyOf(mask);
    if (g === null || g === 0) return null;
    for (const m of this._movesAt(mask)) {
      if (this.grundyOf(mask & ~m) === 0) return m;
    }
    return null; // unreachable if g !== 0, per the correctness note above
  }

  // Inverse of the index mapping — turns a mask back into the actual
  // [row, col] cells it covers, so a caller can recover a real
  // (pieceType, shape, anchorRow, anchorCol) placement from a mask
  // returned by findWinningMove(). Deliberately the only place this
  // solver exposes real board coordinates outside its own internals —
  // everything else stays pure bitmask combinatorics.
  cellsOfMask(mask) {
    const cells = [];
    for (let i = 0; i < this.cellCount; i++) {
      if ((mask >> BigInt(i)) & 1n) cells.push(this.cells[i]);
    }
    return cells;
  }
}
