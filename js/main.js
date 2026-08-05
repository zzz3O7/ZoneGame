import { Game } from "./game.js";
import { Renderer } from "./renderer.js";
import { GameUI } from "./gameUI.js";
import { initHintsPanel } from "./hintsPanel.js";
import { Connection } from "./net/connection.js";
import { MatchClient } from "./net/matchClient.js";
import { Menu } from "./menu.js";

const menuScreen = document.getElementById("menuScreen");
const waitingRoomScreen = document.getElementById("waitingRoomScreen");
const gameScreen = document.getElementById("gameScreen");

let ui = null;
let lastLocalParams = null; // set only for local hotseat games; drives rematch/same-board

function showScreen(screen) {
  [menuScreen, waitingRoomScreen, gameScreen].forEach((s) => (s.hidden = s !== screen));
}

function setupMatchClient(conn) {
  const matchClient = new MatchClient(conn);
  matchClient.onMatchStart = (game) => startGame(game, matchClient);
  matchClient.onMoveApplied = () => ui?.refresh(); // ui set once startGame runs
  return matchClient;
}

function startGame(game, matchClient = null) {
  showScreen(gameScreen);

  ui?.destroy(); // tear down the previous match's listeners before reusing the same DOM

  const canvas = document.getElementById("board-canvas");
  const renderer = new Renderer(canvas, game.board, game.zoneRadius);

  ui = new GameUI(game, renderer, canvas, matchClient);
  ui.init();
  initHintsPanel();
}

// params here are always already resolved/clamped (see js/params.js) —
// Menu never hands raw form input to these callbacks.
function populateWaitingRoom(params, inviteCode) {
  document.getElementById("inviteCodeDisplay").textContent = inviteCode;
  document.getElementById("waitModeValue").textContent = params.mode === "classic" ? "Classic" : "Custom";
  document.getElementById("waitBoardValue").textContent = `${params.boardSize} x ${params.boardSize}`;
  document.getElementById("waitZoneRadiusValue").textContent = params.zoneRadius;
  document.getElementById("waitDominoValue").textContent = params.startingDominoes;
}

new Menu({
  onStartLocal: (params) => {
    lastLocalParams = params;
    startGame(new Game(params));
  },

  onCreateMatch: async (nickname, params) => {
    const conn = new Connection(`wss://${location.host}/ws`);
    await conn.connect();

    const matchClient = setupMatchClient(conn);
    matchClient.onCreated = (inviteCode) => {
      populateWaitingRoom(params, inviteCode);
      showScreen(waitingRoomScreen);
    };
    matchClient.createMatch(nickname, params);
  },

  onJoinMatch: async (nickname, code) => {
    const conn = new Connection(`wss://${location.host}/ws`);
    await conn.connect();

    const matchClient = setupMatchClient(conn);
    matchClient.joinMatch(code, nickname);
  },
});

document.getElementById("btnCopyCode").addEventListener("click", (event) => {
  const code = document.getElementById("inviteCodeDisplay").textContent;
  navigator.clipboard?.writeText(code);

  const btn = event.currentTarget;
  btn.textContent = "Copied";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = "Copy";
    btn.classList.remove("copied");
  }, 1200);
});

document.getElementById("btnCancelWait").addEventListener("click", () => {
  // TODO: needs a proper leave/cancel message to server later.
  showScreen(menuScreen);
});

document.getElementById("btnRematch").addEventListener("click", () => {
  if (!lastLocalParams) return; // hidden for online matches, but guard anyway
  startGame(new Game({ ...lastLocalParams, seed: undefined })); // fresh board
});

document.getElementById("btnSameBoard").addEventListener("click", () => {
  if (!lastLocalParams || !ui) return;
  startGame(new Game({ ...lastLocalParams, seed: ui.game.seed })); // same cave, roles reset
});

document.getElementById("btnBackToMenu").addEventListener("click", () => {
  // TODO: online matches need a proper leave message too, once that exists.
  showScreen(menuScreen);
});
