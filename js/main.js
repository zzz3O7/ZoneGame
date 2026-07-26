import { Game } from "./game.js";
import { Renderer } from "./renderer.js";
import { GameUI } from "./gameUI.js";

const canvas = document.getElementById("board-canvas");
const game = new Game(20, 20);
const renderer = new Renderer(canvas, game.board);

document.getElementById("seedValue").textContent = game.seed;

const ui = new GameUI(game, renderer, canvas);

ui.init();
