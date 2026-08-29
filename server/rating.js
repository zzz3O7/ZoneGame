// Two-parameter skill rating: mu (skill mean), sigma (certainty of that
// estimate — shrinks with games played). Performance variance (formerly
// a per-player "tau") is now a single fixed constant shared by everyone
// — see TAU_GLOBAL below for why.
//
// Win probability: P(A beats B) = Phi( (muA-muB) / sqrt(sigmaA^2+sigmaB^2+2*TAU_GLOBAL^2) )
//
// mu/sigma update: exact TrueSkill-style moment-matching (Herbrich, Minka,
// Graepel 2007) for a probit-linked win/loss/draw observation. Margin is
// deliberately NOT part of this core update — it only applies a small
// capped cosmetic modifier to the resulting mu delta. See conversation
// history / design notes for the full reasoning.

// --- Rating scale ---------------------------------------------------
//
// RATING_SCALE is a single knob for rescaling resolution later without
// hunting down every constant individually. If you ever want the whole
// system to feel like it spans a wider or narrower numeric range:
//   - INITIAL_MU does NOT scale with it — it's a pure anchor/offset
//     (like moving where "0" sits), independent of resolution.
//   - sigma/tau-scale constants scale LINEARLY with it (they're
//     expressed directly in rating-point units).
//   - SIGMA_REGROWTH_PER_DAY_SQ scales with its SQUARE (it's a variance,
//     i.e. already rating-points-squared).
//   - MARGIN_BETA, MARGIN_MODIFIER_CAP, DRAW_EPSILON are all
//     scale-invariant (they operate on normalized quantities already) —
//     never multiply these by RATING_SCALE.
export const RATING_SCALE = 1;

// INITIAL_MU: pure anchor, chosen with headroom so a real beginner losing
// repeatedly to an established player can fall meaningfully without their
// displayed rating going negative (see displayRating()'s floor as the
// hard backstop regardless).
export const INITIAL_MU = 1500;

export const INITIAL_SIGMA = 350 * RATING_SCALE;

const SIGMA_MIN = 20 * RATING_SCALE; // near-vestigial on purpose — see TAU_GLOBAL below

// Performance variance used to be a per-player estimate ("tau"), learned
// from score margin. It was abandoned after extensive testing showed the
// achievable signal is fundamentally too weak: individual margin
// observations carry very little information about consistency
// specifically, real players get on the order of 20-30 rated games a
// year (nowhere near what per-player estimation needs to be reliable),
// and even a maximally rigorous windowed MLE+prior estimator produced
// estimates that spent over half their time pinned at the allowed
// range's hard boundaries rather than tracking anything real. Meanwhile
// the actual payoff — the full range only ever shifted win probability
// by 5-10 percentage points at realistic mu gaps — didn't justify that
// amount of fragility. TrueSkill (a proven, widely-deployed system)
// makes the same simplifying call: a single global performance-variance
// constant, not a per-player one.
//
// Value carried over unchanged from the old per-player TAU_MIN, which
// was itself derived from a real calibration anchor (see INITIAL_SIGMA's
// old comments in version history): a modest but real skill edge should
// read as ~73% win probability at a 400-point gap once both players are
// fully converged — noticeably less deterministic than chess's ~90%-at-
// 400, matching that this game's board-generation randomness matters
// more the higher you climb. Most established players were already
// converging toward this value anyway before the estimator was removed,
// so fixing everyone at it preserves that calibration rather than
// resetting it.
export const TAU_GLOBAL = 460 * RATING_SCALE;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Variance (sigma^2) added back per day of inactivity. Chosen so a player
// at SIGMA_MIN who stops playing entirely regrows to INITIAL_SIGMA (full
// "never played" uncertainty) over roughly a year — (350^2-20^2)/365.
// Tune this directly if a year feels too slow/fast once you're watching
// real accounts go stale.
const SIGMA_REGROWTH_PER_DAY_SQ = 335 * RATING_SCALE * RATING_SCALE;

const MARGIN_BETA = 3; // squash rate for the margin -> modifier curve
// Visible-rating modifier stays in [0.80, 1.20]. Raised from an earlier
// 0.15 now that margin only ever feeds this one cosmetic mechanism —
// previously it also fed per-player tau estimation, so letting the one
// remaining consumer weigh margin a bit more keeps decisive wins from
// feeling invisible. Raising it is a symmetric trade-off worth knowing:
// narrow wins get discounted somewhat more too, not just blowouts
// rewarded more (see the very first "harsh to players" design pass).
const MARGIN_MODIFIER_CAP = 0.2;
const DRAW_EPSILON = 0.1; // small draw margin, in standardized (t) units, scale-invariant

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

// --- Normal distribution helpers -------------------------------------

function erf(x) {
  // Abramowitz & Stegun 7.1.26 approximation, ~1e-7 max error — plenty
  // of precision for a rating system.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// --- Core mu/sigma update (margin-blind) ------------------------------

// scoreA: 1 = A won, 0 = A lost, 0.5 = draw.
// Returns the raw (pre-margin-modifier) mu deltas and the new sigmas —
// sigma is never touched by margin, so these sigma values are final.
// No tau parameters anymore — both players always contribute the same
// TAU_GLOBAL, so it's just a constant folded into c2 below.
export function computeBinaryUpdate({ muA, sigmaA, muB, sigmaB, scoreA }) {
  const c2 = sigmaA * sigmaA + sigmaB * sigmaB + 2 * TAU_GLOBAL * TAU_GLOBAL;
  const c = Math.sqrt(c2);
  const t = (muA - muB) / c;

  let v, w;
  if (scoreA === 0.5) {
    // Draw case, using a small draw margin epsilon (Herbrich et al. section 4).
    const eps = DRAW_EPSILON;
    const denom = Math.max(normalCdf(eps - t) - normalCdf(-eps - t), 1e-9);
    v = (normalPdf(-eps - t) - normalPdf(eps - t)) / denom;
    w = v * v + ((eps - t) * normalPdf(eps - t) - (-eps - t) * normalPdf(-eps - t)) / denom;
  } else if (scoreA === 1) {
    const denom = Math.max(normalCdf(t), 1e-9);
    v = normalPdf(t) / denom;
    w = v * (v + t);
  } else {
    // A lost: evaluate from B's (winning) perspective, then fold the
    // result back into A's frame so the shared update code below works
    // the same way regardless of who won.
    const tFlip = -t;
    const denom = Math.max(normalCdf(tFlip), 1e-9);
    const vFlip = normalPdf(tFlip) / denom;
    v = -vFlip;
    w = vFlip * (vFlip + tFlip);
  }

  const muDeltaA = ((sigmaA * sigmaA) / c) * v;
  const muDeltaB = -((sigmaB * sigmaB) / c) * v;

  const sigmaAfterA = Math.sqrt(Math.max(sigmaA * sigmaA * (1 - ((sigmaA * sigmaA) / c2) * w), SIGMA_MIN * SIGMA_MIN));
  const sigmaAfterB = Math.sqrt(Math.max(sigmaB * sigmaB * (1 - ((sigmaB * sigmaB) / c2) * w), SIGMA_MIN * SIGMA_MIN));

  return { muDeltaA, muDeltaB, sigmaAfterA, sigmaAfterB };
}

// --- sigma regrowth on inactivity ---------------------------------------

// Widens sigma based on elapsed time since a player's last rated game —
// the longer they've been away, the less confidently their old mu still
// reflects their current skill.
//
// lastRatedGameAt: epoch ms, or null for a player who's never played a
// rated game yet (their sigma is already at INITIAL_SIGMA — nothing to do).
export function applyInactivityRegrowth(sigma, lastRatedGameAt, now = Date.now()) {
  if (lastRatedGameAt == null) return sigma;
  const daysSince = Math.max(0, (now - lastRatedGameAt) / MS_PER_DAY);
  const grown2 = sigma * sigma + SIGMA_REGROWTH_PER_DAY_SQ * daysSince;
  return Math.min(Math.sqrt(grown2), INITIAL_SIGMA);
}

// --- Visible-rating cosmetic modifier ----------------------------------

// Every ending produces a margin — no endReason gating. Normalized by the
// board's total point capacity (not score0+score1): that way the margin
// reflects how much of the WHOLE board was actually settled, not just
// the ratio within whatever small slice got contested, so a truncated
// game with little decided correctly reads as a small, honest margin
// instead of an artificially confident one from a tiny denominator.
// resign's score0/score1 are expected to already have the winner's
// remaining-points award folded in by the caller — this function just
// normalizes and squashes whatever it's given. This is now margin's ONLY
// consumer (it used to also feed per-player tau estimation — see
// TAU_GLOBAL's comment for why that was removed).
export function computeMarginModifier(score0, score1, totalBoardPoints) {
  const margin = clamp((score0 - score1) / totalBoardPoints, -1, 1); // player0's perspective
  const squashed = Math.tanh(MARGIN_BETA * Math.abs(margin));
  const modifier = 1 + MARGIN_MODIFIER_CAP * (2 * squashed - 1); // in [0.80, 1.20]
  return { modifier, margin };
}

// --- Win probability (for future matchmaking use) -----------------------

export function winProbability({ muA, sigmaA, muB, sigmaB }) {
  const c = Math.sqrt(sigmaA * sigmaA + sigmaB * sigmaB + 2 * TAU_GLOBAL * TAU_GLOBAL);
  return normalCdf((muA - muB) / c);
}

// --- Rating weight by match_type ----------------------------------------

// eve (bot self-play, see docs/BOTS.md Phase 3) moves ratings less than a
// normal pvp/pve game: it's cheap, high-volume, and bot-vs-bot skill
// isn't quite the same population as bot-vs-human, so a single self-play
// result should count for less evidence than a real game against a
// human. 0.4 is a starting guess, not calibrated — revisit once
// self-play has actually run long enough to compare bot ladder stability
// against the pve/pvp-only baseline.
const EVE_RATING_WEIGHT = 0.4;

const RATING_WEIGHT_BY_MATCH_TYPE = { eve: EVE_RATING_WEIGHT };

// finalizeRatedGame's one hook into "how much should this game move
// ratings" — anything not listed here (pvp, pve) gets the normal full
// weight. A weight of 1 must be a true no-op vs. the old unweighted
// math (see finalizeRatedGame's blend), which is what makes adding a
// new entry here safe without touching the update math itself.
export function ratingWeightForMatchType(matchType) {
  return RATING_WEIGHT_BY_MATCH_TYPE[matchType] ?? 1;
}
