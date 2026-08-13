import Database from "better-sqlite3";
import path from "path";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(serverDir, "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "zonegame.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    nickname TEXT UNIQUE,
    rating INTEGER NOT NULL DEFAULT 1000,
    games_played INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- Case-insensitive uniqueness: "Artem" and "artem" shouldn't both be
  -- claimable. The column itself keeps the nickname as-typed for display.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_players_nickname_ci
    ON players (nickname COLLATE NOCASE);

  -- Schema for step 4 (rating integration) — created now so there's a
  -- single source of truth for the schema, not touched by anything yet.
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player0_id INTEGER REFERENCES players(id),
    player1_id INTEGER REFERENCES players(id),
    winner INTEGER, -- 0, 1, or NULL for draw
    rating_before_0 INTEGER,
    rating_before_1 INTEGER,
    rating_after_0 INTEGER,
    rating_after_1 INTEGER,
    params_json TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
`);
