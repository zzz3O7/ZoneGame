import { sound } from "./audio/soundManager.js";

const SETTINGS_KEY = "zonegame_settings";

// boardTheme isn't wired to anything yet — it's a placeholder so the
// Settings panel can reserve the slot (and persist a future choice) ahead
// of actually building theme switching.
const DEFAULTS = { uiVolume: 1, gameVolume: 1, requireConfirm: false, boardTheme: "default" };

function load() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

// A single mutable object, not getters/setters — consumers (gameUI's
// click handler, in particular) just read settings.requireConfirm at the
// point of use instead of needing to be notified of changes.
export const settings = load();

function persist() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable (private browsing, quota) — setting still
    // works for the rest of this session, just won't survive a reload.
  }
}

// Pushes current settings into the subsystems that don't read the
// singleton directly. Call once at boot and again after every change.
export function applySettings() {
  sound.uiVolume = settings.uiVolume;
  sound.gameVolume = settings.gameVolume;
  document.body.classList.toggle("require-confirm", settings.requireConfirm);
}

export function updateSetting(key, value) {
  settings[key] = value;
  persist();
  applySettings();
}
