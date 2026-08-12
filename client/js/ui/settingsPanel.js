import { settings, updateSetting } from "../settings.js";
import { sound } from "../audio/soundManager.js";

// Page-level: one panel, one gear button, reachable from both the menu and
// the game screen since it's fixed-position rather than scoped into either
// screen's markup.
export function initSettingsPanel() {
  const openBtn = document.getElementById("btnSettings");
  const overlay = document.getElementById("settingsOverlay");
  const closeBtn = document.getElementById("btnSettingsClose");
  const uiVolumeInput = document.getElementById("settingUiVolume");
  const uiVolumeValue = document.getElementById("settingUiVolumeValue");
  const gameVolumeInput = document.getElementById("settingGameVolume");
  const gameVolumeValue = document.getElementById("settingGameVolumeValue");
  const requireConfirmInput = document.getElementById("settingRequireConfirm");
  if (!openBtn || !overlay) return;

  function syncControls() {
    uiVolumeInput.value = Math.round(settings.uiVolume * 100);
    uiVolumeValue.textContent = `${Math.round(settings.uiVolume * 100)}%`;
    gameVolumeInput.value = Math.round(settings.gameVolume * 100);
    gameVolumeValue.textContent = `${Math.round(settings.gameVolume * 100)}%`;
    requireConfirmInput.checked = settings.requireConfirm;
  }

  function open() {
    syncControls();
    overlay.hidden = false;
  }

  function close() {
    overlay.hidden = true;
  }

  openBtn.addEventListener("click", () => {
    sound.uiClick();
    open();
  });
  closeBtn.addEventListener("click", () => {
    sound.uiClick();
    close();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close(); // scrim click — outside the panel itself
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) close();
  });

  uiVolumeInput.addEventListener("input", () => {
    const value = Number(uiVolumeInput.value) / 100;
    uiVolumeValue.textContent = `${uiVolumeInput.value}%`;
    updateSetting("uiVolume", value);
  });
  uiVolumeInput.addEventListener("change", () => sound.uiClick()); // preview once the drag settles, not on every tick

  gameVolumeInput.addEventListener("input", () => {
    const value = Number(gameVolumeInput.value) / 100;
    gameVolumeValue.textContent = `${gameVolumeInput.value}%`;
    updateSetting("gameVolume", value);
  });
  gameVolumeInput.addEventListener("change", () => sound.place());

  requireConfirmInput.addEventListener("change", () => {
    sound.uiClick();
    updateSetting("requireConfirm", requireConfirmInput.checked);
  });
}
