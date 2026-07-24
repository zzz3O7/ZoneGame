import { Game } from "./game.js";
import { Renderer } from "./renderer.js";
import { GameUI } from "./gameUI.js";

const canvas = document.getElementById("board");
const game = new Game();
const renderer = new Renderer(canvas);
const ui = new GameUI(game, renderer, canvas);

ui.init();
