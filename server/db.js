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
    -- Three-parameter rating state (see server/rating.js for the math):
    -- mu = skill mean, sigma = certainty of that estimate (shrinks with
    -- games played), tau = consistency/performance-variance (stable trait,
    -- estimated from margin data). Defaults mirror rating.js's INITIAL_*.
    -- Displayed rating is always round(rating_mu) — see displayRating().
    rating_mu REAL NOT NULL DEFAULT 1500,
    rating_sigma REAL NOT NULL DEFAULT 350,
    rating_tau REAL NOT NULL DEFAULT 580,
    games_played INTEGER NOT NULL DEFAULT 0,
    -- Set on every rated game; reserved for future sigma-regrowth-on-
    -- inactivity behavior (not implemented yet — see docs/TODO).
    last_rated_game_at INTEGER,
    created_at INTEGER NOT NULL
  );

  -- Case-insensitive uniqueness: "Artem" and "artem" shouldn't both be
  -- claimable. The column itself keeps the nickname as-typed for display.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_players_nickname_ci
    ON players (nickname COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player0_id INTEGER REFERENCES players(id),
    player1_id INTEGER REFERENCES players(id),
    winner INTEGER, -- 0, 1, or NULL for draw
    score_0 INTEGER,
    score_1 INTEGER,
    end_reason TEXT, -- "no-moves" | "resign" | "timeout" | "abort"
    -- margin: the actual [-1,1] value fed into computeMarginModifier/updateTau
    -- (already includes resign's remaining-points-to-winner award, if any) —
    -- stored directly rather than recomputed later, so a future per-player
    -- estimator reading this game as historical input can't drift from what
    -- was actually used at the time. remaining/total let it also reconstruct
    -- how much this specific game's evidence should be discounted.
    margin REAL,
    remaining_possible_points INTEGER,
    total_board_points INTEGER,
    -- Full before/after snapshot of the three-parameter rating state, so
    -- history is self-explaining without recomputation.
    mu_before_0 REAL, sigma_before_0 REAL, tau_before_0 REAL,
    mu_after_0 REAL, sigma_after_0 REAL, tau_after_0 REAL,
    mu_before_1 REAL, sigma_before_1 REAL, tau_before_1 REAL,
    mu_after_1 REAL, sigma_after_1 REAL, tau_after_1 REAL,
    params_json TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
`);
