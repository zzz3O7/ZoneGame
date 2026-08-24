import { CUSTOM_DEFAULTS, TIME_CUSTOM_DEFAULTS, TIME_PRESETS } from "../../../shared/config.js";
import { resolveParams } from "../../../shared/params.js";
import { sound } from "../audio/soundManager.js";
import { account, onAccountChange } from "../account.js";
import { signInWithGoogle } from "../net/authClient.js";
import { promptNickname } from "./accountWidget.js";

// Same "zonegame.<thing>" key convention as matchClient.js's session storage.
// localStorage (not sessionStorage): unlike match reconnect state.
const NICKNAME_KEY = "zonegame.nickname";

// Owns the menu screen only: mode selection, custom params, local/create/join
// tabs. Emits fully-resolved params objects via callbacks — never hands raw
// input values to the caller.
export class Menu {
  constructor({ onStartLocal, onCreateMatch, onJoinMatch, onJoinQueue, onLeaveQueue, onPlayBot, onRequestBotList }) {
    this.onStartLocal = onStartLocal;
    this.onCreateMatch = onCreateMatch;
    this.onJoinMatch = onJoinMatch;
    this.onJoinQueue = onJoinQueue;
    this.onLeaveQueue = onLeaveQueue;
    this.onPlayBot = onPlayBot;
    this.onRequestBotList = onRequestBotList;

    this.qpTimeMode = "blitz";
    this.rankedTimeMode = "blitz";
    this.selectedBotId = null;

    // Local, Create, and Bots each get their own independent mode/time-control
    // picker — same shape, same defaults, but a Custom board on one
    // shouldn't affect the others. See _makeBoardSection.
    this.localSection = this._makeBoardSection("local");
    this.createSection = this._makeBoardSection("create", () => this._renderCreateRatedToggle());
    this.botsSection = this._makeBoardSection("bots");

    this._cacheDom();
    this._restoreNickname();
    this._bindEvents();

    this._renderRankedTab();
    this._renderCreateRatedToggle();
    this._syncNicknameFields();
    onAccountChange(() => {
      this._renderRankedTab();
      this._renderCreateRatedToggle();
      this._syncNicknameFields();
    });
  }

  // Builds one self-contained Mode + Time-control section (Local and
  // Create each have one, with a shared `${prefix}` ID convention —
  // e.g. "localModeCardClassic" / "createModeCardClassic"). Returns
  // { buildParams() } — everything else is private to the closure.
  _makeBoardSection(prefix, onChange = () => {}) {
    const els = {
      modeClassic: document.getElementById(`${prefix}ModeCardClassic`),
      modeCustom: document.getElementById(`${prefix}ModeCardCustom`),
      paramsPanel: document.getElementById(`${prefix}ParamsPanel`),
      boardSize: document.getElementById(`${prefix}ParamBoardSize`),
      boardSizeValue: document.getElementById(`${prefix}ParamBoardSizeValue`),
      zoneRadius: document.getElementById(`${prefix}ParamZoneRadius`),
      zoneRadiusValue: document.getElementById(`${prefix}ParamZoneRadiusValue`),
      startingDominoes: document.getElementById(`${prefix}ParamStartingDominoes`),
      startingDominoesValue: document.getElementById(`${prefix}ParamStartingDominoesValue`),
      seed: document.getElementById(`${prefix}ParamSeed`),
      timeCards: [...document.querySelectorAll(`#${prefix}TimeGrid .mode-card`)],
      timeCustomPanel: document.getElementById(`${prefix}TimeCustomPanel`),
      timeInitial: document.getElementById(`${prefix}ParamTimeInitial`),
      timeInitialValue: document.getElementById(`${prefix}ParamTimeInitialValue`),
      timeIncrement: document.getElementById(`${prefix}ParamTimeIncrement`),
      timeIncrementValue: document.getElementById(`${prefix}ParamTimeIncrementValue`),
    };

    const state = { mode: "classic", timeMode: "none" };

    this._initSlider(els.boardSize, els.boardSizeValue, CUSTOM_DEFAULTS.boardSize);
    this._initSlider(els.zoneRadius, els.zoneRadiusValue, CUSTOM_DEFAULTS.zoneRadius);
    this._initSlider(els.startingDominoes, els.startingDominoesValue, CUSTOM_DEFAULTS.startingDominoes);
    this._initSlider(els.timeInitial, els.timeInitialValue, TIME_CUSTOM_DEFAULTS.initialMs / 60_000);
    this._initSlider(els.timeIncrement, els.timeIncrementValue, TIME_CUSTOM_DEFAULTS.incrementMs / 1000);

    els.modeClassic.addEventListener("click", () => {
      sound.uiClick();
      state.mode = "classic";
      els.modeClassic.classList.add("selected");
      els.modeCustom.classList.remove("selected");
      els.paramsPanel.classList.add("collapsed");
      onChange();
    });
    els.modeCustom.addEventListener("click", () => {
      sound.uiClick();
      state.mode = "custom";
      els.modeCustom.classList.add("selected");
      els.modeClassic.classList.remove("selected");
      els.paramsPanel.classList.remove("collapsed");
      onChange();
    });
    els.timeCards.forEach((card) => {
      card.addEventListener("click", () => {
        sound.uiClick();
        state.timeMode = card.dataset.timeMode;
        els.timeCards.forEach((c) => c.classList.toggle("selected", c === card));
        els.timeCustomPanel.classList.toggle("collapsed", card.dataset.timeMode !== "custom");
        onChange();
      });
    });

    return {
      buildParams: () =>
        resolveParams(state.mode, {
          boardSize: els.boardSize.value,
          zoneRadius: els.zoneRadius.value,
          startingDominoes: els.startingDominoes.value,
          seed: els.seed.value.trim(),
          // resolveParams() clamps/validates all of this against
          // TIME_PRESETS/TIME_CUSTOM_LIMITS, same as the board params
          // above; a tampered/stale DOM value here can't produce an
          // out-of-range clock.
          timeMode: state.timeMode,
          timeInitialMs: Number(els.timeInitial.value) * 60_000,
          timeIncrementMs: Number(els.timeIncrement.value) * 1000,
        }),
      // Rated play needs a recognized, actually-timed preset on both
      // axes — see server/index.js's CREATE_MATCH handler, which
      // enforces this same rule authoritatively (this is purely so the
      // UI can reflect it without a round trip). TIME_PRESETS.none is a
      // real, truthy entry (the no-clock sentinel) — has to be excluded
      // explicitly, a plain truthiness check would wrongly treat "no
      // clock" as a recognized preset.
      isRatable: () => state.mode === "classic" && state.timeMode !== "none" && Boolean(TIME_PRESETS[state.timeMode]),
    };
  }

  _cacheDom() {
    this.els = {
      tabs: [...document.querySelectorAll("#menuScreen .tab")],
      panels: [...document.querySelectorAll("#menuScreen .tab-panel")],

      btnLocal: document.getElementById("btnLocalGame"),
      btnCreate: document.getElementById("btnCreateMatch"),
      btnJoin: document.getElementById("btnJoinMatch"),

      nicknameCreate: document.getElementById("nicknameCreateInput"),
      nicknameJoin: document.getElementById("nicknameJoinInput"),
      joinCode: document.getElementById("joinCodeInput"),
      createRatedToggle: document.getElementById("createRatedToggle"),
      createRatedHint: document.getElementById("createRatedHint"),

      nicknameQuickPlay: document.getElementById("nicknameQuickPlayInput"),
      qpTimeCards: [...document.querySelectorAll("#qpTimeGrid .mode-card")],
      btnQuickPlay: document.getElementById("btnQuickPlay"),

      rankedTimeCards: [...document.querySelectorAll("#rankedTimeGrid .mode-card")],
      rankedStatus: document.getElementById("rankedStatus"),
      btnRanked: document.getElementById("btnRanked"),

      botsListGrid: document.getElementById("botsListGrid"),
      botsStatus: document.getElementById("botsStatus"),
      nicknameBots: document.getElementById("nicknameBotsInput"),
      btnPlayBot: document.getElementById("btnPlayBot"),
    };
  }

  _initSlider(input, valueEl, defaultValue) {
    input.value = defaultValue;
    valueEl.textContent = defaultValue;
    input.addEventListener("input", () => {
      valueEl.textContent = input.value;
    });
  }

  _selectQpTimeMode(timeMode) {
    sound.uiClick();
    this.qpTimeMode = timeMode;
    this.els.qpTimeCards.forEach((card) => card.classList.toggle("selected", card.dataset.timeMode === timeMode));
  }

  _selectRankedTimeMode(timeMode) {
    sound.uiClick();
    this.rankedTimeMode = timeMode;
    this.els.rankedTimeCards.forEach((card) => card.classList.toggle("selected", card.dataset.timeMode === timeMode));
  }

  // Reacts to login/nickname state — Ranked is the only tab whose
  // content depends on the account rather than just local UI state.
  _renderRankedTab() {
    if (!account.loggedIn) {
      this.els.rankedStatus.textContent = "Sign in to play ranked matches.";
      this.els.btnRanked.textContent = "Sign in with Google";
    } else if (!account.nickname) {
      this.els.rankedStatus.textContent = "Set a nickname to play ranked matches.";
      this.els.btnRanked.textContent = "Set nickname";
    } else {
      this.els.rankedStatus.textContent = `Playing as ${account.nickname} · Rating ${account.rating}`;
      this.els.btnRanked.textContent = "Find match";
    }
  }

  // A Create match can be marked rated same as ranked matchmaking — but
  // needs a real account on both sides (ratingService.finalizeRatedGame)
  // AND a recognized board/time preset (server enforces this
  // authoritatively; see CREATE_MATCH in index.js). Either gap disables
  // the switch and forces it off, with a hint explaining which one.
  _renderCreateRatedToggle() {
    const accountEligible = account.loggedIn && Boolean(account.nickname);
    const paramsEligible = this.createSection.isRatable();
    const eligible = accountEligible && paramsEligible;

    this.els.createRatedToggle.disabled = !eligible;
    if (!eligible) this.els.createRatedToggle.checked = false;

    if (!accountEligible) {
      this.els.createRatedHint.hidden = false;
      this.els.createRatedHint.textContent = "Sign in with a nickname to create a rated match.";
    } else if (!paramsEligible) {
      this.els.createRatedHint.hidden = false;
      this.els.createRatedHint.textContent = "Rated matches require the Classic board and a preset time control.";
    } else {
      this.els.createRatedHint.hidden = true;
    }
  }

  // Called from main.js's showScreen() whenever the menu becomes visible
  // again (e.g. leaving a finished/left match). If Bots happens to be
  // the already-active tab, no click ever fires _selectTab again, so
  // nothing would otherwise re-trigger a reconnect — leaving Play
  // pointing at a connection main.js already consumed the moment the
  // previous bot match started. See main.js's onRequestBotList guard
  // (botsListLoaded) for why this is safe to call unconditionally.
  refreshBotsTabIfActive() {
    const botsPanel = this.els.panels.find((p) => p.id === "tabBots");
    if (botsPanel?.classList.contains("active")) this.onRequestBotList?.();
  }

  _selectTab(tabId) {
    sound.uiClick();
    this.els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabId));
    this.els.panels.forEach((panel) => panel.classList.toggle("active", panel.id === tabId));
    this.clearJoinCode(); // stale code from a previous attempt shouldn't linger once you've navigated away
    if (tabId === "tabBots") this.onRequestBotList?.();
  }

  // Called once per bots-tab visit that actually gets a response (see
  // main.js's botsListLoaded guard — this itself is safe to call more
  // than once, it just re-renders the option list). Empty list is a
  // distinct state from "still loading" (see the initial "Loading
  // bots…" text in HTML). A dropdown rather than one mode-card per bot
  // since the roster (server/bot/botRegistry.js) is now big enough that
  // a card grid stopped being a usable picker.
  renderBotList(bots) {
    this.selectedBotId = null;
    this.els.btnPlayBot.disabled = true;
    this.els.botsListGrid.innerHTML = "";

    if (bots.length === 0) {
      this.els.botsListGrid.disabled = true;
      this.els.botsStatus.textContent = "No bots available yet — run server/scripts/seedBots.js.";
      return;
    }
    this.els.botsListGrid.disabled = false;
    this.els.botsStatus.textContent = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a bot…";
    placeholder.disabled = true;
    placeholder.selected = true;
    this.els.botsListGrid.appendChild(placeholder);

    for (const bot of bots) {
      const option = document.createElement("option");
      option.value = bot.id;
      option.textContent = `${bot.nickname} — Rating ${bot.rating}`;
      this.els.botsListGrid.appendChild(option);
    }
  }

  botsListError(message) {
    this.els.botsStatus.textContent = message || "Couldn't load bots.";
  }

  // A logged-in account's nickname is the identity used everywhere —
  // the Create/Join/Quick Play fields just mirror it and lock while
  // signed in, rather than letting a stale/different nickname get typed
  // in underneath the account that's actually attached to the match.
  // Logging out (or being logged in with no nickname yet) unlocks them
  // and falls back to whatever was last saved locally.
  _syncNicknameFields() {
    const fields = [this.els.nicknameCreate, this.els.nicknameJoin, this.els.nicknameQuickPlay, this.els.nicknameBots];
    const locked = account.loggedIn && Boolean(account.nickname);
    if (locked) {
      fields.forEach((input) => {
        input.value = account.nickname;
        input.readOnly = true;
      });
    } else {
      fields.forEach((input) => {
        input.readOnly = false;
      });
      this._restoreNickname();
    }
  }

  // Pre-fill nickname fields from whatever was last saved. Create, Join,
  // and Quick Play are really one identity, not three separate fields —
  // all get the same restored value. Only meaningful while unlocked
  // (see _syncNicknameFields) — a locked, account-driven value always wins.
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
      this.els.nicknameQuickPlay.value = saved;
      this.els.nicknameBots.value = saved;
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

  _bindEvents() {
    this.els.tabs.forEach((tab) => {
      tab.addEventListener("click", () => this._selectTab(tab.dataset.tab));
    });

    this.els.btnLocal.addEventListener("click", () => {
      sound.uiConfirm();
      this.onStartLocal(this.localSection.buildParams());
    });

    // Keep the Create/Join/Quick Play nickname fields in sync (one
    // identity, three tabs) and persist as the person types. No-op while
    // account-locked, since the fields are read-only in that state.
    this.els.nicknameCreate.addEventListener("input", () => {
      this.els.nicknameJoin.value = this.els.nicknameCreate.value;
      this.els.nicknameQuickPlay.value = this.els.nicknameCreate.value;
      this.els.nicknameBots.value = this.els.nicknameCreate.value;
      this._saveNickname(this.els.nicknameCreate.value.trim());
    });
    this.els.nicknameJoin.addEventListener("input", () => {
      this.els.nicknameCreate.value = this.els.nicknameJoin.value;
      this.els.nicknameQuickPlay.value = this.els.nicknameJoin.value;
      this.els.nicknameBots.value = this.els.nicknameJoin.value;
      this._saveNickname(this.els.nicknameJoin.value.trim());
    });
    this.els.nicknameQuickPlay.addEventListener("input", () => {
      this.els.nicknameCreate.value = this.els.nicknameQuickPlay.value;
      this.els.nicknameJoin.value = this.els.nicknameQuickPlay.value;
      this.els.nicknameBots.value = this.els.nicknameQuickPlay.value;
      this._saveNickname(this.els.nicknameQuickPlay.value.trim());
    });
    this.els.nicknameBots.addEventListener("input", () => {
      this.els.nicknameCreate.value = this.els.nicknameBots.value;
      this.els.nicknameJoin.value = this.els.nicknameBots.value;
      this.els.nicknameQuickPlay.value = this.els.nicknameBots.value;
      this._saveNickname(this.els.nicknameBots.value.trim());
    });

    this.els.btnCreate.addEventListener("click", () => {
      sound.uiConfirm();
      const nickname = this.els.nicknameCreate.value.trim() || "Player";
      this._saveNickname(nickname); // belt-and-suspenders alongside the input listener (e.g. an autofilled value that never fired "input")
      const rated = !this.els.createRatedToggle.disabled && this.els.createRatedToggle.checked;
      this.onCreateMatch(nickname, this.createSection.buildParams(), rated);
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

    this.els.qpTimeCards.forEach((card) => {
      card.addEventListener("click", () => this._selectQpTimeMode(card.dataset.timeMode));
    });
    this.els.rankedTimeCards.forEach((card) => {
      card.addEventListener("click", () => this._selectRankedTimeMode(card.dataset.timeMode));
    });

    this.els.btnQuickPlay.addEventListener("click", () => {
      const nickname = this.els.nicknameQuickPlay.value.trim() || "Player";
      this._saveNickname(nickname);
      sound.uiConfirm();
      this.onJoinQueue(false, this.qpTimeMode, nickname);
    });

    // Three different states share one button — see _renderRankedTab.
    this.els.btnRanked.addEventListener("click", () => {
      if (!account.loggedIn) {
        sound.uiClick();
        signInWithGoogle();
        return;
      }
      if (!account.nickname) {
        sound.uiClick();
        promptNickname();
        return;
      }
      sound.uiConfirm();
      this.onJoinQueue(true, this.rankedTimeMode, null);
    });

    this.els.botsListGrid.addEventListener("change", () => {
      sound.uiClick();
      // option.value is always a string; bot.id is numeric and the server
      // matches it with strict equality (server/index.js's PLAY_BOT_REQUEST
      // handler), so this has to be cast back or every match would fail.
      this.selectedBotId = this.els.botsListGrid.value ? Number(this.els.botsListGrid.value) : null;
      this.els.btnPlayBot.disabled = !this.selectedBotId;
    });

    this.els.btnPlayBot.addEventListener("click", () => {
      if (!this.selectedBotId) return;
      const nickname = this.els.nicknameBots.value.trim() || "Player";
      this._saveNickname(nickname);
      sound.uiConfirm();
      this.onPlayBot(this.selectedBotId, nickname, this.botsSection.buildParams());
    });
  }
}
