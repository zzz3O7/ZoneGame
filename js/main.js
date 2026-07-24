import { Game } from "./game.js";
import { Renderer } from "./renderer.js";
import { GameUI } from "./gameUI.js";

const canvas = document.getElementById("board");
const game = new Game(20, 20);
const renderer = new Renderer(canvas, game.board);

document.documentElement.style.setProperty("--board-size", `${canvas.width}px`);

const ui = new GameUI(game, renderer, canvas);

ui.init();
