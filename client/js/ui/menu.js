import { CUSTOM_DEFAULTS, TIME_CUSTOM_DEFAULTS } from "../../../shared/config.js";
import { resolveParams } from "../../../shared/params.js";
import { sound } from "../audio/soundManager.js";

// Same "zonegame.<thing>" key convention as matchClient.js's session storage.
// localStorage (not sessionStorage): unlike match reconnect state.
const NICKNAME_KEY = "zonegame.nickname";

// Owns the menu screen only: mode selection, custom params, local/create/join
// tabs. Emits fully-resolved params objects via callbacks — never hands raw
// input values to the caller.
export class Menu {
  constructor({ onStartLocal, onCreateMatch, onJoinMatch }) {
    this.onStartLocal = onStartLocal;
    this.onCreateMatch = onCreateMatch;
    this.onJoinMatch = onJoinMatch;

    this.mode = "classic";
    this.timeMode = "none";

    this._cacheDom();
    this._populateDefaults();
    this._restoreNickname();
    this._bindEvents();
  }

  _cacheDom() {
    this.els = {
      modeClassic: document.getElementById("modeCardClassic"),
      modeCustom: document.getElementById("modeCardCustom"),
      paramsPanel: document.getElementById("paramsPanel"),

      boardSize: document.getElementById("paramBoardSize"),
      boardSizeValue: document.getElementById("paramBoardSizeValue"),
      zoneRadius: document.getElementById("paramZoneRadius"),
      zoneRadiusValue: document.getElementById("paramZoneRadiusValue"),
      startingDominoes: document.getElementById("paramStartingDominoes"),
      startingDominoesValue: document.getElementById("paramStartingDominoesValue"),
      seed: document.getElementById("paramSeed"),

      timeCards: [...document.querySelectorAll("#timeGrid .mode-card")],
      timeCustomPanel: document.getElementById("timeCustomPanel"),
      timeInitial: document.getElementById("paramTimeInitial"),
      timeInitialValue: document.getElementById("paramTimeInitialValue"),
      timeIncrement: document.getElementById("paramTimeIncrement"),
      timeIncrementValue: document.getElementById("paramTimeIncrementValue"),

      tabs: [...document.querySelectorAll("#menuScreen .tab")],
      panels: [...document.querySelectorAll("#menuScreen .tab-panel")],

      btnLocal: document.getElementById("btnLocalGame"),
      btnCreate: document.getElementById("btnCreateMatch"),
      btnJoin: document.getElementById("btnJoinMatch"),

      nicknameCreate: document.getElementById("nicknameCreateInput"),
      nicknameJoin: document.getElementById("nicknameJoinInput"),
      joinCode: document.getElementById("joinCodeInput"),
    };
  }

  _populateDefaults() {
    this._initSlider(this.els.boardSize, this.els.boardSizeValue, CUSTOM_DEFAULTS.boardSize);
    this._initSlider(this.els.zoneRadius, this.els.zoneRadiusValue, CUSTOM_DEFAULTS.zoneRadius);
    this._initSlider(this.els.startingDominoes, this.els.startingDominoesValue, CUSTOM_DEFAULTS.startingDominoes);

    this._initSlider(this.els.timeInitial, this.els.timeInitialValue, TIME_CUSTOM_DEFAULTS.initialMs / 60_000);
    this._initSlider(this.els.timeIncrement, this.els.timeIncrementValue, TIME_CUSTOM_DEFAULTS.incrementMs / 1000);
  }

  _initSlider(input, valueEl, defaultValue) {
    input.value = defaultValue;
    valueEl.textContent = defaultValue;
    input.addEventListener("input", () => {
      valueEl.textContent = input.value;
    });
  }

  _selectMode(mode) {
    sound.uiClick();
    this.mode = mode;
    this.els.modeClassic.classList.toggle("selected", mode === "classic");
    this.els.modeCustom.classList.toggle("selected", mode === "custom");
    this.els.paramsPanel.classList.toggle("collapsed", mode !== "custom");
  }

  _selectTimeMode(timeMode) {
    sound.uiClick();
    this.timeMode = timeMode;
    this.els.timeCards.forEach((card) => card.classList.toggle("selected", card.dataset.timeMode === timeMode));
    this.els.timeCustomPanel.classList.toggle("collapsed", timeMode !== "custom");
  }

  _selectTab(tabId) {
    sound.uiClick();
    this.els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabId));
    this.els.panels.forEach((panel) => panel.classList.toggle("active", panel.id === tabId));
    this.clearJoinCode(); // stale code from a previous attempt shouldn't linger once you've navigated away
  }

  // Pre-fill both nickname fields from whatever was last saved.
  // Create and Join are really one identity, not two separate fields, so
  // both get the same restored value.
  _restoreNickname() {
    let saved = "";
    try {
      saved = localStorage.getItem(NICKNAME_KEY) || "";
    } catch {
      // storage unavailable (private browsing, etc.) — inputs just start empty, not fatal
    }
    if (saved) {
      this.els.nicknameCreate.value = saved;
      this.els.nicknameJoin.value = saved;
    }
  }

  _saveNickname(value) {
    try {
      if (value) localStorage.setItem(NICKNAME_KEY, value);
    } catch {
      // storage unavailable — just won't persist this time, not fatal
    }
  }

  // Called on tab/mode navigation and whenever the caller returns to the
  // menu screen (e.g. leaving a match) — a stale invite code from a
  // previous attempt shouldn't survive either.
  clearJoinCode() {
    this.els.joinCode.value = "";
  }

  _readCustomInputs() {
    return {
      boardSize: this.els.boardSize.value,
      zoneRadius: this.els.zoneRadius.value,
      startingDominoes: this.els.startingDominoes.value,
      seed: this.els.seed.value.trim(),

      // resolveParams() clamps/validates all of this against
      // TIME_PRESETS/TIME_CUSTOM_LIMITS, same as the board params above;
      // a tampered/stale DOM value here can't produce an out-of-range clock.
      timeMode: this.timeMode,
      timeInitialMs: Number(this.els.timeInitial.value) * 60_000,
      timeIncrementMs: Number(this.els.timeIncrement.value) * 1000,
    };
  }

  _buildParams() {
    return resolveParams(this.mode, this._readCustomInputs());
  }

  _bindEvents() {
    this.els.modeClassic.addEventListener("click", () => this._selectMode("classic"));
    this.els.modeCustom.addEventListener("click", () => this._selectMode("custom"));

    this.els.timeCards.forEach((card) => {
      card.addEventListener("click", () => this._selectTimeMode(card.dataset.timeMode));
    });

    this.els.tabs.forEach((tab) => {
      tab.addEventListener("click", () => this._selectTab(tab.dataset.tab));
    });

    this.els.btnLocal.addEventListener("click", () => {
      this.onStartLocal(this._buildParams());
    });

    // Keep the Create/Join nickname fields in sync (one identity,
    // two tabs) and persist as the person types.
    this.els.nicknameCreate.addEventListener("input", () => {
      this.els.nicknameJoin.value = this.els.nicknameCreate.value;
      this._saveNickname(this.els.nicknameCreate.value.trim());
    });
    this.els.nicknameJoin.addEventListener("input", () => {
      this.els.nicknameCreate.value = this.els.nicknameJoin.value;
      this._saveNickname(this.els.nicknameJoin.value.trim());
    });

    this.els.btnCreate.addEventListener("click", () => {
      sound.uiConfirm();
      const nickname = this.els.nicknameCreate.value.trim() || "Player";
      this._saveNickname(nickname); // belt-and-suspenders alongside the input listener (e.g. an autofilled value that never fired "input")
      this.onCreateMatch(nickname, this._buildParams());
    });

    this.els.btnJoin.addEventListener("click", () => {
      const nickname = this.els.nicknameJoin.value.trim() || "Player";
      this._saveNickname(nickname);
      const code = this.els.joinCode.value.trim().toUpperCase();
      if (!code) return;
      sound.uiConfirm();
      this.onJoinMatch(nickname, code);
    });

    // Force uppercase live as the user types, preserving cursor position
    this.els.joinCode.addEventListener("input", () => {
      const input = this.els.joinCode;
      const { selectionStart, selectionEnd } = input;
      input.value = input.value.toUpperCase();
      input.setSelectionRange(selectionStart, selectionEnd);
    });
  }
}
