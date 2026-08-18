import { db } from "./db.js";

const insertGame = db.prepare(`
  INSERT INTO games (
    player0_id, player1_id, winner,
    score_0, score_1, end_reason, margin, remaining_possible_points, total_board_points,
    mu_before_0, sigma_before_0,
    mu_after_0, sigma_after_0,
    mu_before_1, sigma_before_1,
    mu_after_1, sigma_after_1,
    params_json, started_at, ended_at
  ) VALUES (
    @player0_id, @player1_id, @winner,
    @score_0, @score_1, @end_reason, @margin, @remaining_possible_points, @total_board_points,
    @mu_before_0, @sigma_before_0,
    @mu_after_0, @sigma_after_0,
    @mu_before_1, @sigma_before_1,
    @mu_after_1, @sigma_after_1,
    @params_json, @started_at, @ended_at
  )
`);

const bumpRating = db.prepare(`
  UPDATE players
  SET rating_mu = ?, rating_sigma = ?, games_played = games_played + 1, last_rated_game_at = ?
  WHERE id = ?
`);

// One transaction so a crash between inserting the history row and
// updating ratings can't leave the two out of sync with each other.
export const recordRatedGame = db.transaction((row) => {
  insertGame.run(row);
  bumpRating.run(row.mu_after_0, row.sigma_after_0, row.ended_at, row.player0_id);
  bumpRating.run(row.mu_after_1, row.sigma_after_1, row.ended_at, row.player1_id);
});

const getRecentGames = db.prepare(`
  SELECT * FROM games
  WHERE player0_id = ? OR player1_id = ?
  ORDER BY ended_at DESC
  LIMIT ?
`);

// Not currently used by any rating math (this fed the per-player tau
// estimator, which was removed — see rating.js's TAU_GLOBAL comment) but
// kept as-is since it's generic enough to be useful for a game-history
// feature later: a player's own last `limit` games, normalized to "self"
// vs "opponent" regardless of which side (player0/player1) they were on
// in each row.
export function getRecentGamesForPlayer(playerId, limit) {
  const rows = getRecentGames.all(playerId, playerId, limit);
  return rows.map((row) => {
    const isP0 = row.player0_id === playerId;
    return {
      margin: isP0 ? row.margin : -row.margin, // margin is always stored from player0's perspective
      muSelf: isP0 ? row.mu_before_0 : row.mu_before_1,
      muOpp: isP0 ? row.mu_before_1 : row.mu_before_0,
      sigmaSelf: isP0 ? row.sigma_before_0 : row.sigma_before_1,
      sigmaOpp: isP0 ? row.sigma_before_1 : row.sigma_before_0,
      remainingPossiblePoints: row.remaining_possible_points,
      totalBoardPoints: row.total_board_points,
    };
  });
}
