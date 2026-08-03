import { MODES, CUSTOM_DEFAULTS, CUSTOM_LIMITS } from "./config.js";

function clampInt(value, [min, max], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Turns (mode, rawCustomValues) into a trustworthy params object:
// { mode, boardSize, zoneRadius, startingDominoes, seed? }
//
// Called client-side when building params from menu input, and again
// server-side on whatever the client sent — untrusted input never reaches
// Game construction unclamped.
export function resolveParams(mode, custom = {}) {
  if (mode === "classic") {
    const { label, ...preset } = MODES.classic;
    return { mode: "classic", ...preset };
  }

  return {
    mode: "custom",
    boardSize: clampInt(custom.boardSize, CUSTOM_LIMITS.boardSize, CUSTOM_DEFAULTS.boardSize),
    zoneRadius: clampInt(custom.zoneRadius, CUSTOM_LIMITS.zoneRadius, CUSTOM_DEFAULTS.zoneRadius),
    startingDominoes: clampInt(custom.startingDominoes, CUSTOM_LIMITS.startingDominoes, CUSTOM_DEFAULTS.startingDominoes),
    seed: custom.seed || undefined,
  };
}
