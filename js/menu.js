import { CUSTOM_DEFAULTS } from "./config.js";
import { resolveParams } from "./params.js";

// Owns the menu screen only: mode selection, custom params, local/create/join
// tabs. Emits fully-resolved params objects via callbacks — never hands raw
// input values to the caller.
export class Menu {
  constructor({ onStartLocal, onCreateMatch, onJoinMatch }) {
    this.onStartLocal = onStartLocal;
    this.onCreateMatch = onCreateMatch;
    this.onJoinMatch = onJoinMatch;

    this.mode = "classic";

    this._cacheDom();
    this._populateDefaults();
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
  }

  _initSlider(input, valueEl, defaultValue) {
    input.value = defaultValue;
    valueEl.textContent = defaultValue;
    input.addEventListener("input", () => {
      valueEl.textContent = input.value;
    });
  }

  _selectMode(mode) {
    this.mode = mode;
    this.els.modeClassic.classList.toggle("selected", mode === "classic");
    this.els.modeCustom.classList.toggle("selected", mode === "custom");
    this.els.paramsPanel.classList.toggle("collapsed", mode !== "custom");
  }

  _selectTab(tabId) {
    this.els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabId));
    this.els.panels.forEach((panel) => panel.classList.toggle("active", panel.id === tabId));
  }

  _readCustomInputs() {
    return {
      boardSize: this.els.boardSize.value,
      zoneRadius: this.els.zoneRadius.value,
      startingDominoes: this.els.startingDominoes.value,
      seed: this.els.seed.value.trim(),
    };
  }

  _buildParams() {
    return resolveParams(this.mode, this._readCustomInputs());
  }

  _bindEvents() {
    this.els.modeClassic.addEventListener("click", () => this._selectMode("classic"));
    this.els.modeCustom.addEventListener("click", () => this._selectMode("custom"));

    this.els.tabs.forEach((tab) => {
      tab.addEventListener("click", () => this._selectTab(tab.dataset.tab));
    });

    this.els.btnLocal.addEventListener("click", () => {
      this.onStartLocal(this._buildParams());
    });

    this.els.btnCreate.addEventListener("click", () => {
      const nickname = this.els.nicknameCreate.value.trim() || "Player";
      this.onCreateMatch(nickname, this._buildParams());
    });

    this.els.btnJoin.addEventListener("click", () => {
      const nickname = this.els.nicknameJoin.value.trim() || "Player";
      const code = this.els.joinCode.value.trim().toUpperCase();
      if (!code) return;
      this.onJoinMatch(nickname, code);
    });
  }
}
