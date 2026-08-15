// Three-parameter skill rating: mu (skill mean), sigma (certainty of that
// estimate — shrinks with games played), tau (consistency / performance
// variance — a stable per-player trait, estimated from score margin).
//
// Win probability: P(A beats B) = Phi( (muA-muB) / sqrt(sigmaA^2+tauA^2+sigmaB^2+tauB^2) )
//
// mu/sigma update: exact TrueSkill-style moment-matching (Herbrich, Minka,
// Graepel 2007) for a probit-linked win/loss/draw observation. Margin is
// deliberately NOT part of this core update — it only (a) applies a small
// capped cosmetic modifier to the resulting mu delta, and (b) feeds tau's
// EWMA. See conversation history / design notes for the full reasoning.

// --- Rating scale ---------------------------------------------------
//
// RATING_SCALE is a single knob for rescaling resolution later without
// hunting down every constant individually. If you ever want the whole
// system to feel like it spans a wider or narrower numeric range:
//   - INITIAL_MU does NOT scale with it — it's a pure anchor/offset
//     (like moving where "0" sits), independent of resolution.
//   - sigma/tau/margin-scale constants scale LINEARLY with it (they're
//     expressed directly in rating-point units).
//   - SIGMA_REGROWTH_PER_DAY_SQ scales with its SQUARE (it's a variance,
//     i.e. already rating-points-squared).
//   - TAU_ALPHA, MARGIN_BETA, MARGIN_MODIFIER_CAP, DRAW_EPSILON are all
//     scale-invariant (they operate on normalized quantities already) —
//     never multiply these by RATING_SCALE.
export const RATING_SCALE = 1;

// INITIAL_MU: pure anchor, chosen with headroom so a real beginner losing
// repeatedly to an established player can fall meaningfully without their
// displayed rating going negative (see displayRating()'s floor as the
// hard backstop regardless).
export const INITIAL_MU = 1500;

export const INITIAL_SIGMA = 350 * RATING_SCALE;
// Calibrated from a friend-group anchor, not a guess: a real but modest
// skill edge (the kind that comes from knowing a few strategies an
// opponent doesn't) should land around ~73% win probability at a 400-
// point gap once both players are fully converged — noticeably less
// deterministic than chess's classic ~90%-at-400, matching that this
// game's board-generation randomness matters more the higher you climb.
// That implies a combined floor spread (sigma_min^2+tau_min^2, summed
// for both players) of ~650 rating-points. tau carries almost all of
// it — sigma is epistemic (can shrink toward true certainty with enough
// consistent games) while tau is the game's real, irreducible randomness,
// which never goes away no matter how many games someone's played.
export const INITIAL_TAU = 580 * RATING_SCALE;

const SIGMA_MIN = 20 * RATING_SCALE; // near-vestigial on purpose — see above
const TAU_MIN = 460 * RATING_SCALE;
const TAU_MAX = 800 * RATING_SCALE;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Variance (sigma^2) added back per day of inactivity. Chosen so a player
// at SIGMA_MIN who stops playing entirely regrows to INITIAL_SIGMA (full
// "never played" uncertainty) over roughly a year — (350^2-20^2)/365.
// Tune this directly if a year feels too slow/fast once you're watching
// real accounts go stale.
const SIGMA_REGROWTH_PER_DAY_SQ = 335 * RATING_SCALE * RATING_SCALE;

const TAU_ALPHA = 0.03; // EWMA learning rate for tau
const MARGIN_BETA = 3; // squash rate for the margin -> modifier curve
const MARGIN_MODIFIER_CAP = 0.15; // visible-rating modifier stays in [0.85, 1.15]
// Maps margin in [-1,1] to rating-point units for tau's residual check.
// Matches the same ~650 floor-spread anchor above, not picked separately
// — a mismatch here is what caused tau to inflate without bound on a
// sustained one-sided matchup (see the "expectedMargin" fix below).
const MARGIN_C_SCALE = 650 * RATING_SCALE;
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
export function computeBinaryUpdate({ muA, sigmaA, tauA, muB, sigmaB, tauB, scoreA }) {
  const c2 = sigmaA * sigmaA + tauA * tauA + sigmaB * sigmaB + tauB * tauB;
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
// reflects their current skill. tau is NOT regrown here: it's a stable
// consistency trait, not an epistemic estimate, so time away from the
// game doesn't make it stale the way sigma does.
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

// Only meaningful for a natural "no-moves" finish — resign/timeout/abort
// scores don't reflect a real margin. Returns modifier=1 (no-op) otherwise.
export function computeMarginModifier(score0, score1, endReason) {
  if (endReason !== "no-moves") return { modifier: 1, marginApplied: false, margin: null };
  const total = score0 + score1;
  if (!(total > 0)) return { modifier: 1, marginApplied: false, margin: null };

  const margin = (score0 - score1) / total; // player0's perspective, in [-1, 1]
  const squashed = Math.tanh(MARGIN_BETA * Math.abs(margin));
  const modifier = 1 + MARGIN_MODIFIER_CAP * (2 * squashed - 1); // in [0.85, 1.15]
  return { modifier, marginApplied: true, margin };
}

// --- tau (consistency) EWMA ---------------------------------------------

// Uses the raw, unclamped margin — no cosmetic cap here, this is where
// margin should do its real work. Call only when marginApplied is true.
//
// expectedMargin is tanh-bounded (not a raw linear delta/C_SCALE) because
// margin itself can never exceed +/-1 — a plain linear map lets the
// "expected" margin overshoot past what's physically achievable once the
// mu gap grows large, which reads a stable, perfectly consistent blowout
// as endless surprise and drives tau up without bound. Bounding it means
// a persistent, exactly-repeated result correctly reads as low variance.
export function updateTau({ tauA, tauB, muA, muB, sigmaA, sigmaB, margin }) {
  const delta = muA - muB;
  const expectedMargin = Math.tanh(delta / MARGIN_C_SCALE);
  const e = margin - expectedMargin;
  const rho2 = (sigmaA * sigmaA + tauA * tauA + sigmaB * sigmaB + tauB * tauB) / (MARGIN_C_SCALE * MARGIN_C_SCALE);
  const surpriseRatio = (e * e) / Math.max(rho2, 1e-9);

  const shareA = (tauA * tauA) / (tauA * tauA + tauB * tauB);
  const tauA2 = clamp(
    tauA * tauA * (1 + TAU_ALPHA * shareA * (surpriseRatio - 1)),
    TAU_MIN * TAU_MIN,
    TAU_MAX * TAU_MAX,
  );
  const tauB2 = clamp(
    tauB * tauB * (1 + TAU_ALPHA * (1 - shareA) * (surpriseRatio - 1)),
    TAU_MIN * TAU_MIN,
    TAU_MAX * TAU_MAX,
  );

  return { tauAfterA: Math.sqrt(tauA2), tauAfterB: Math.sqrt(tauB2) };
}

// --- Win probability (for future matchmaking use) -----------------------

export function winProbability({ muA, sigmaA, tauA, muB, sigmaB, tauB }) {
  const c = Math.sqrt(sigmaA * sigmaA + tauA * tauA + sigmaB * sigmaB + tauB * tauB);
  return normalCdf((muA - muB) / c);
}
