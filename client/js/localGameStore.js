import { Game } from "../../shared/engine/game.js";

// Same "zonegame.<thing>" key convention as matchClient.js's session
// storage and menu.js's nickname storage — localStorage (not
// sessionStorage), since unlike a match session there's no server
// backing this up at all: losing it loses the whole game. Single slot —
// there's only ever one local hotseat game in progress at a time.
const LOCAL_GAME_KEY = "zonegame.localGame";

// Minimal replay-input shape only — mirrors Match.js's own `actions` log
// (kind/pieceType/shape/anchorRow/anchorCol, or kind: "pass"), not
// game.history's full entries, which also carry derived fields
// (zoneEvent, completions, penalty) that get recomputed identically by
// replay anyway and shouldn't be trusted from storage.
function toReplayAction(entry) {
  if (entry.type === "pass") return { kind: "pass" };
  return { kind: "placement", pieceType: entry.pieceType, shape: entry.shape, anchorRow: entry.anchorRow, anchorCol: entry.anchorCol };
}

// clock: a Clock instance (hotseat's authoritative one) or null/undefined
// for an untimed game. Called after every successful hotseat move — see
// GameUI._submitPlacement/_submitPass.
export function save(game, clock) {
  if (game.gameOver) {
    clear();
    return;
  }
  try {
    const params = {
      mode: game.mode,
      boardSize: game.boardSize,
      zoneRadius: game.zoneRadius,
      startingDominoes: game.startingDominoes,
      seed: game.seed,
      timeControl: game.timeControl,
    };
    const payload = {
      params,
      actions: game.history.all().map(toReplayAction),
      clock: clock ? clock.snapshot(Date.now()) : null,
      hash: game.getStateHash(),
    };
    localStorage.setItem(LOCAL_GAME_KEY, JSON.stringify(payload));
  } catch {
    // storage unavailable (private browsing, quota, etc.) — the game
    // just isn't resumable this time, not fatal to actually playing it
  }
}

export function clear() {
  try {
    localStorage.removeItem(LOCAL_GAME_KEY);
  } catch {
    // ignore — same as above
  }
}

export function hasSaved() {
  try {
    return localStorage.getItem(LOCAL_GAME_KEY) != null;
  } catch {
    return false;
  }
}

// Raw parsed payload, or null if there's nothing there (or it's
// corrupt) — doesn't replay anything yet. See reconstruct() for that.
export function load() {
  try {
    const raw = localStorage.getItem(LOCAL_GAME_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Rebuilds by doing exactly what a live game already does — new
// Game(params), then replay each action through the same
// attemptPlacement/pass calls (see matchClient.js's _handleSyncState,
// which this mirrors deliberately). Returns { game, clockSnapshot } on a
// clean replay, or null if the replay doesn't reproduce the stored hash
// — safer to treat that as corrupt/stale data and fall back to a fresh
// menu than to silently show a possibly-wrong board, since (unlike
// online) there's no server to fall back on as a source of truth.
export function reconstruct(saved) {
  if (!saved?.params || !Array.isArray(saved.actions)) return null;

  const game = new Game(saved.params);
  for (const action of saved.actions) {
    if (action.kind === "pass") game.pass();
    else game.attemptPlacement(action.pieceType, action.shape, action.anchorRow, action.anchorCol);
  }

  if (saved.hash != null && game.getStateHash() !== saved.hash) {
    console.error("ZoneGame: local game replay hash mismatch — discarding the saved game");
    return null;
  }

  return { game, clockSnapshot: saved.clock ?? null };
}
