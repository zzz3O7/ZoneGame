// Persists canonicalGrundyCache / canonicalTreeNodeCache (canonicalShape.js)
// across process restarts. Deliberately a SEPARATE SQLite file from the
// live player-facing zonegame.db (see server/db.js) - this is solver/
// self-play infrastructure with its own lifecycle (wiped, rebuilt,
// blown away and started over during development) that has no business
// sharing a file, a schema, or an uptime story with real player data.
//
// Opt-in by design: nothing calls save/load automatically. A caller
// (self-play harness, server startup, a one-off script) decides when.
//
// Built as a factory (createCanonicalCacheStore) rather than a bare
// singleton so tests can point an isolated instance at a temp file
// with its own tracking state, instead of exercising (and leaving
// residue in) the real solverCache.db. Production code just uses the
// default export below and never needs to know the factory exists.
import Database from "better-sqlite3";
import path from "path";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { canonicalGrundyCache, canonicalTreeNodeCache } from "./canonicalShape.js";
import { canonicalize } from "./reducedTreeDominoAware.js";

export function createCanonicalCacheStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS grundy_cache (
      canonical_key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );

    -- One shared table of distinct node shapes, not one row per
    -- tree_cache entry - a node reachable from many different top-level
    -- shapes (EMPTY_NODE above all, but plenty of small residual shapes
    -- too) gets exactly one row, referenced by id, rather than being
    -- duplicated into every entry that happens to reach it. This mirrors
    -- reducedTreeDominoAware.js's own in-memory hash-consing: two
    -- structurally-identical nodes are ALWAYS the same JS object there
    -- (see canonicalize()), so deduping by object identity during save
    -- already IS deduping by content - no separate content-lookup needed.
    --
    -- children is a JSON array of arrays of ids (one inner array per
    -- classical move, since a move can leave more than one live piece
    -- behind) - null for leaf nodes. fragments is a JSON array of
    -- fragment lengths - null for non-leaf nodes.
    CREATE TABLE IF NOT EXISTS tree_nodes (
      id INTEGER PRIMARY KEY,
      leaf INTEGER NOT NULL,
      fragments TEXT,
      children TEXT
    );

    CREATE TABLE IF NOT EXISTS tree_cache (
      canonical_key TEXT PRIMARY KEY,
      required_moves INTEGER NOT NULL,
      root_node_id INTEGER NOT NULL REFERENCES tree_nodes(id)
    );
  `);

  // Incremental save tracking: Map preserves insertion order, and a
  // key's value is never rewritten once cached (see zoneSolver.js /
  // reducedTreeDominoAware.js's own "only a fully-computed result is
  // safe to share" comments) - the occasional harmless re-set of an
  // EXISTING key on a cache hit doesn't move it in iteration order
  // either (per the Map spec: re-setting an existing key updates the
  // value in place, only a genuinely NEW key gets appended). So "how
  // many entries existed after the last save" is a sufficient, correct
  // bookmark for "everything after this point is new" - no separate
  // dirty-tracking Set needed. Per-instance, not module-level, so a
  // test's isolated store doesn't share bookkeeping with production.
  let savedGrundyCount = 0;
  let savedTreeCount = 0;

  // Deliberately NOT deduped against tree_nodes rows already on disk
  // from a previous save (this process's or another's) - only within
  // ONE save call, via object-identity, exactly as described above. A
  // shape some earlier process already persisted gets stored again here
  // if this process (re)computes it. That's a real but bounded cost
  // (some redundant rows, no wasted CPU - see the object-identity point
  // above, this never redoes canonicalize()'s own work) - correctness is
  // unaffected either way, and closing it would mean a per-node content
  // lookup against the DB on every save, real complexity for a cost
  // that's just disk space.
  function saveCanonicalCaches() {
    const insertGrundy = db.prepare(
      "INSERT OR IGNORE INTO grundy_cache (canonical_key, value) VALUES (?, ?)",
    );
    const insertNode = db.prepare(
      "INSERT INTO tree_nodes (leaf, fragments, children) VALUES (?, ?, ?)",
    );
    const insertTreeCache = db.prepare(
      "INSERT OR IGNORE INTO tree_cache (canonical_key, required_moves, root_node_id) VALUES (?, ?, ?)",
    );

    const grundyEntries = [...canonicalGrundyCache.entries()].slice(savedGrundyCount);
    const treeEntries = [...canonicalTreeNodeCache.entries()].slice(savedTreeCount);

    const idOfSavedNode = new Map(); // this call only - see comment above
    function persistNode(node) {
      const existing = idOfSavedNode.get(node);
      if (existing !== undefined) return existing;
      let id;
      if (node.leaf) {
        id = insertNode.run(1, JSON.stringify(node.fragments), null).lastInsertRowid;
      } else {
        const childIds = node.children.map((parts) => parts.map(persistNode));
        id = insertNode.run(0, null, JSON.stringify(childIds)).lastInsertRowid;
      }
      idOfSavedNode.set(node, id);
      return id;
    }

    const runAll = db.transaction(() => {
      for (const [key, value] of grundyEntries) insertGrundy.run(key, value);
      for (const [key, { node, requiredMoves }] of treeEntries) {
        const rootId = persistNode(node);
        insertTreeCache.run(key, requiredMoves, rootId);
      }
    });
    runAll();

    savedGrundyCount = canonicalGrundyCache.size;
    savedTreeCount = canonicalTreeNodeCache.size;

    return { grundySaved: grundyEntries.length, treeSaved: treeEntries.length };
  }

  function loadCanonicalCaches() {
    let grundyLoaded = 0;
    for (const { canonical_key, value } of db.prepare("SELECT canonical_key, value FROM grundy_cache").all()) {
      if (!canonicalGrundyCache.has(canonical_key)) {
        canonicalGrundyCache.set(canonical_key, value);
        grundyLoaded++;
      }
    }

    const nodeRows = new Map(
      db.prepare("SELECT id, leaf, fragments, children FROM tree_nodes").all().map((r) => [r.id, r]),
    );
    const materialized = new Map(); // db id -> in-memory node object, this call only
    function materialize(id) {
      const existing = materialized.get(id);
      if (existing !== undefined) return existing;
      const row = nodeRows.get(id);
      // canonicalize() merges this against whatever's already in memory -
      // anything built fresh earlier this session, or an identical shape
      // loaded from a different tree_cache entry a moment ago - the same
      // dedup every freshly-BUILT node already goes through, so loaded
      // and freshly-computed nodes end up fully interchangeable, not two
      // parallel populations that happen to look alike.
      const node = row.leaf
        ? canonicalize({ leaf: true, fragments: JSON.parse(row.fragments) })
        : canonicalize({ leaf: false, children: JSON.parse(row.children).map((parts) => parts.map(materialize)) });
      materialized.set(id, node);
      return node;
    }

    let treeLoaded = 0;
    for (const { canonical_key, required_moves, root_node_id } of db
      .prepare("SELECT canonical_key, required_moves, root_node_id FROM tree_cache")
      .all()) {
      if (!canonicalTreeNodeCache.has(canonical_key)) {
        canonicalTreeNodeCache.set(canonical_key, { node: materialize(root_node_id), requiredMoves: required_moves });
        treeLoaded++;
      }
    }

    savedGrundyCount = canonicalGrundyCache.size;
    savedTreeCount = canonicalTreeNodeCache.size;

    return { grundyLoaded, treeLoaded };
  }

  // Test-only: mirrors canonicalShape.js's _clearCanonicalCaches -
  // resets this instance's own incremental-save bookmarks to match a
  // cleared (or externally-populated) cache, so tests get a clean
  // slate rather than inheriting position counters from whatever ran
  // before them.
  function _resetPersistenceTracking() {
    savedGrundyCount = canonicalGrundyCache.size;
    savedTreeCount = canonicalTreeNodeCache.size;
  }

  return { db, saveCanonicalCaches, loadCanonicalCaches, _resetPersistenceTracking };
}

const botDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(botDir, "..", "data");
mkdirSync(dataDir, { recursive: true });

const defaultStore = createCanonicalCacheStore(path.join(dataDir, "solverCache.db"));
export const solverCacheDb = defaultStore.db;
export const saveCanonicalCaches = defaultStore.saveCanonicalCaches;
export const loadCanonicalCaches = defaultStore.loadCanonicalCaches;
export const _resetPersistenceTracking = defaultStore._resetPersistenceTracking;
