import { Game } from "./game.js";
import { Renderer } from "./renderer.js";
import { GameUI } from "./gameUI.js";
import { initHintsPanel } from "./hintsPanel.js";
import { Connection } from "./net/connection.js";
import { MatchClient } from "./net/matchClient.js";

const menuScreen = document.getElementById("menuScreen");
const waitingRoomScreen = document.getElementById("waitingRoomScreen");
const gameScreen = document.getElementById("gameScreen");

let ui = null;

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

  const canvas = document.getElementById("board-canvas");
  const renderer = new Renderer(canvas, game.board);
  document.getElementById("seedValue").textContent = game.seed; // TODO it's a gameUi responsibility (init)

  ui = new GameUI(game, renderer, canvas, matchClient);
  ui.init();
  initHintsPanel();
}

document.getElementById("btnLocalGame").addEventListener("click", () => {
  startGame(new Game(20, 20));
});

document.getElementById("btnCreateMatch").addEventListener("click", async () => {
  const nickname = document.getElementById("nicknameInput").value || "Player";
  const conn = new Connection("ws://localhost:8080");
  await conn.connect();

  const matchClient = setupMatchClient(conn);
  matchClient.onCreated = (inviteCode) => {
    document.getElementById("inviteCodeDisplay").textContent = inviteCode;
    showScreen(waitingRoomScreen);
  };
  matchClient.createMatch(nickname);
});

document.getElementById("btnJoinMatch").addEventListener("click", async () => {
  const nickname = document.getElementById("nicknameInput").value || "Player";
  const code = document.getElementById("joinCodeInput").value.trim().toUpperCase();
  const conn = new Connection("ws://localhost:8080");
  await conn.connect();

  const matchClient = setupMatchClient(conn);
  matchClient.joinMatch(code, nickname);
});

document.getElementById("btnCancelWait").addEventListener("click", () => {
  // TODO: needs a proper leave/cancel message to server later; for MVP, just
  // reload or reset connection — leaving a stale "waiting" match on server
  // is a cleanup problem for a future piece (match timeout/expiry).
  showScreen(menuScreen);
});
