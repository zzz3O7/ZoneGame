import { db } from "./db.js";

const insertGame = db.prepare(`
  INSERT INTO games (
    player0_id, player1_id, winner,
    score_0, score_1, end_reason, margin_applied,
    mu_before_0, sigma_before_0, tau_before_0,
    mu_after_0, sigma_after_0, tau_after_0,
    mu_before_1, sigma_before_1, tau_before_1,
    mu_after_1, sigma_after_1, tau_after_1,
    params_json, started_at, ended_at
  ) VALUES (
    @player0_id, @player1_id, @winner,
    @score_0, @score_1, @end_reason, @margin_applied,
    @mu_before_0, @sigma_before_0, @tau_before_0,
    @mu_after_0, @sigma_after_0, @tau_after_0,
    @mu_before_1, @sigma_before_1, @tau_before_1,
    @mu_after_1, @sigma_after_1, @tau_after_1,
    @params_json, @started_at, @ended_at
  )
`);

const bumpRating = db.prepare(`
  UPDATE players
  SET rating_mu = ?, rating_sigma = ?, rating_tau = ?, games_played = games_played + 1, last_rated_game_at = ?
  WHERE id = ?
`);

// One transaction so a crash between inserting the history row and
// updating ratings can't leave the two out of sync with each other.
export const recordRatedGame = db.transaction((row) => {
  insertGame.run(row);
  bumpRating.run(row.mu_after_0, row.sigma_after_0, row.tau_after_0, row.ended_at, row.player0_id);
  bumpRating.run(row.mu_after_1, row.sigma_after_1, row.tau_after_1, row.ended_at, row.player1_id);
});
