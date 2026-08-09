import {
  MODES,
  CUSTOM_DEFAULTS,
  CUSTOM_LIMITS,
  TIME_PRESETS,
  TIME_CUSTOM_DEFAULTS,
  TIME_CUSTOM_LIMITS,
} from "./config.js";

function clampInt(value, [min, max], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Time control is orthogonal to board mode (classic/custom board params can
// be paired with any time control) — resolved separately and merged into
// whichever params object resolveParams() below returns. Untrusted
// timeMode/timeInitialMs/timeIncrementMs never reach a Clock unclamped, same
// principle as the board params.
function resolveTimeControl(custom) {
  const timeMode = custom.timeMode;
  if (!timeMode || timeMode === "none") return null;

  if (timeMode === "custom") {
    return {
      initialMs: clampInt(custom.timeInitialMs, TIME_CUSTOM_LIMITS.initialMs, TIME_CUSTOM_DEFAULTS.initialMs),
      incrementMs: clampInt(custom.timeIncrementMs, TIME_CUSTOM_LIMITS.incrementMs, TIME_CUSTOM_DEFAULTS.incrementMs),
    };
  }

  const preset = TIME_PRESETS[timeMode];
  if (!preset) return null; // unrecognized timeMode (e.g. tampered client) — treat as no clock, not a crash
  return { initialMs: preset.initialMs, incrementMs: preset.incrementMs };
}

// Turns (mode, rawCustomValues) into a trustworthy params object:
// { mode, boardSize, zoneRadius, startingDominoes, seed?, timeControl }
//
// Called client-side when building params from menu input, and again
// server-side on whatever the client sent — untrusted input never reaches
// Game/Clock construction unclamped.
export function resolveParams(mode, custom = {}) {
  const timeControl = resolveTimeControl(custom);

  if (mode === "classic") {
    const { label, ...preset } = MODES.classic;
    return { mode: "classic", ...preset, timeControl };
  }

  return {
    mode: "custom",
    boardSize: clampInt(custom.boardSize, CUSTOM_LIMITS.boardSize, CUSTOM_DEFAULTS.boardSize),
    zoneRadius: clampInt(custom.zoneRadius, CUSTOM_LIMITS.zoneRadius, CUSTOM_DEFAULTS.zoneRadius),
    startingDominoes: clampInt(
      custom.startingDominoes,
      CUSTOM_LIMITS.startingDominoes,
      CUSTOM_DEFAULTS.startingDominoes,
    ),
    seed: custom.seed || undefined,
    timeControl,
  };
}
