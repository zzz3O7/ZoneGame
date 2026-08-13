// Deliberately the simplest possible Elo: fixed K-factor, no
// provisional-rating ramp-up, no rating-difference-based K adjustment.
// This is a placeholder — Artem is building the real rating algorithm
// himself; this exists only so a rated match has *something* wired
// end-to-end to compute against.
const K = 32;

// scoreA: 1 = A won, 0 = A lost, 0.5 = draw.
// Returns [newRatingA, newRatingB], both rounded to whole numbers.
export function computeElo(ratingA, ratingB, scoreA) {
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  const scoreB = 1 - scoreA;
  const expectedB = 1 - expectedA;
  return [Math.round(ratingA + K * (scoreA - expectedA)), Math.round(ratingB + K * (scoreB - expectedB))];
}
