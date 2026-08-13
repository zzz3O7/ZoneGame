import { db } from "./db.js";

const insertGame = db.prepare(`
  INSERT INTO games (
    player0_id, player1_id, winner,
    rating_before_0, rating_before_1, rating_after_0, rating_after_1,
    params_json, started_at, ended_at
  ) VALUES (
    @player0_id, @player1_id, @winner,
    @rating_before_0, @rating_before_1, @rating_after_0, @rating_after_1,
    @params_json, @started_at, @ended_at
  )
`);
const bumpRating = db.prepare(`UPDATE players SET rating = ?, games_played = games_played + 1 WHERE id = ?`);

// One transaction so a crash between inserting the history row and
// updating ratings can't leave the two out of sync with each other.
export const recordRatedGame = db.transaction((row) => {
  insertGame.run(row);
  bumpRating.run(row.rating_after_0, row.player0_id);
  bumpRating.run(row.rating_after_1, row.player1_id);
});
