import { Game } from "../../shared/engine/game.js";
import { Renderer } from "./ui/renderer.js";
import { GameUI } from "./ui/gameUI.js";
import { initHintsPanel } from "./ui/hintsPanel.js";
import { Connection } from "./net/connection.js";
import { MatchClient } from "./net/matchClient.js";
import { Menu } from "./ui/menu.js";
import { showBanner, hideBanner } from "./ui/banner.js";
import { DISCONNECT_ABORT_MS } from "../../shared/config.js";
import { formatTimeControlLabel } from "../../shared/clock.js";
import { sound } from "./audio/soundManager.js";
import { applySettings } from "./settings.js";
import { initSettingsPanel } from "./ui/settingsPanel.js";
import { initRulesPanel } from "./ui/rulesPanel.js";

applySettings(); // sound volumes + require-confirm body class, before anything can play/render

// Unlock the shared AudioContext on the very first real interaction
// anywhere on the page — before that, browsers won't let it play. Doing
// this once, up front, means every match afterward (including ones started
// from an async MATCH_START/SYNC_STATE message rather than a click, and
// sounds triggered by an incoming multiplayer move) reuses this
// already-unlocked context instead of needing its own gesture.
document.addEventListener("pointerdown", () => sound.unlock(), { once: true });

const menuScreen = document.getElementById("menuScreen");
const waitingRoomScreen = document.getElementById("waitingRoomScreen");
const gameScreen = document.getElementById("gameScreen");

let ui = null;
let lastLocalParams = null; // set only for local hotseat games; drives rematch/same-board
let currentConnection = null; // so leaving (back to menu / cancel) can actually close the socket
let currentMatchClient = null; // so leaveCurrentMatch can send LEAVE_MATCH even before any GameUI exists (e.g. cancelling the waiting room)
let opponentDisconnectTimer = null; // drives the live countdown text in the opponent-disconnected banner
let bannerAutoHideTimer = null; // was a bare setTimeout in handleOpponentReconnected — could fire late and clobber a newer, more urgent banner it knows nothing about
let reconnectInProgress = false; // guards handleConnectionLost against running twice at once (e.g. a move attempted mid-reconnect can independently trigger onConnectionLost again)

function showScreen(screen) {
  [menuScreen, waitingRoomScreen, gameScreen].forEach((s) => (s.hidden = s !== screen));
}

function wsUrl() {
  return `wss://${location.host}/ws`;
}

// Shared teardown for "this match is done, one way or another" —
// used both when we deliberately leave (leaveCurrentMatch, below) and when
// the server/reconnect flow tells us the match is already gone and there's
// nothing left to notify.
function resetMatchState() {
  currentConnection = null;
  currentMatchClient = null;
  clearInterval(opponentDisconnectTimer);
  opponentDisconnectTimer = null;
  clearTimeout(bannerAutoHideTimer);
  hideBanner();
}

// Leaving on purpose (back to menu, cancel waiting room, giving up on a
// reconnect) — tells the server we're actually leaving (a mid-game leave
// counts as a resign — see Match.leave), then tears everything down and
// forgets the stored session so a later page load doesn't try to resurrect
// a match we deliberately walked away from.
function leaveCurrentMatch() {
  currentMatchClient?.leaveMatch();
  currentConnection?.close();
  resetMatchState();
  MatchClient.clearSession();
}

// A JOIN_MATCH the server rejected (bad code, or the match already
// filled up) — the only thing that currently sends MSG.ERROR. The socket
// never got attached to a match, so there's nothing to leave; just close
// it (intentional, so it doesn't also trigger onConnectionLost) and let
// the person retry from the menu.
function handleJoinError(message) {
  sound.formError();
  currentConnection?.close();
  resetMatchState();
  menu.clearJoinCode();
  showBanner(message || "Couldn't join that match.", {
    kind: "danger",
    actions: [{ label: "Dismiss", onClick: hideBanner }],
  });
}

function setupMatchClient(conn) {
  const matchClient = new MatchClient(conn);
  currentMatchClient = matchClient;
  matchClient.onMatchStart = (game) => {
    sound.matchStart();
    startGame(game, matchClient);
  };
  matchClient.onMoveApplied = () => ui?.refresh(); // ui set once startGame runs
  matchClient.onRejected = () => ui?.playReject();

  // disconnect / reconnect / end-of-match wiring
  matchClient.onOpponentDisconnected = (playerIndex, abortInMs) => handleOpponentDisconnected(abortInMs);
  matchClient.onOpponentReconnected = () => handleOpponentReconnected();
  matchClient.onMatchEnded = (info) => handleMatchEnded(info);
  matchClient.onOpponentLeft = () => handleOpponentLeft();
  matchClient.onConnectionLost = () => handleConnectionLost(matchClient);
  matchClient.onReconnectFailed = () => handleReconnectFailed();
  matchClient.onOpponentWantsRematch = () => {
    sound.rematchInvite();
    ui?.showOpponentWantsRematch();
  };
  matchClient.onRematchCancelled = () => {
    sound.rematchCancelled();
    ui?.resetRematchPrompt();
  };
  matchClient.onError = (message) => handleJoinError(message);
  // Shared by reconnect success AND hash-mismatch resync (see matchClient.js) —
  // either way, the correct move is just "rebuild the UI from what the
  // server says is true right now", same as a fresh match start.
  matchClient.onSynced = (game, syncMsg) => {
    reconnectInProgress = false;
    hideBanner();
    clearInterval(opponentDisconnectTimer);
    clearTimeout(bannerAutoHideTimer);
    routeSyncedState(matchClient, game, syncMsg);
  };

  return matchClient;
}

// Where a SYNC_STATE payload sends us, based on what the match is
// currently doing. "active" and "over" both just go through startGame() —
// GameUI already renders the live board vs the endcard purely from
// game.gameOver, so reconnecting into a finished match needs no special case
// for the natural "no-moves" ending: the actions log already ends on the
// exact move that set game.gameOver, so replaying it reproduces that
// correctly on its own.
function routeSyncedState(matchClient, game, syncMsg) {
  if (syncMsg.status === "waiting") {
    populateWaitingRoom(matchClient.params ?? {}, matchClient.inviteCode);
    showScreen(waitingRoomScreen);
    return;
  }
  startGame(game, matchClient);

  // A resign (or, defensively, an abort-forfeit) doesn't correspond
  // to any action in the replay log — there's no move to replay that would
  // ever set game.gameOver — so without this, reconnecting into a resigned
  // match silently never showed the endcard at all. Force the same override
  // a live resign already uses.
  if (syncMsg.endInfo && syncMsg.endInfo.reason !== "no-moves") {
    ui?.showForcedEnd(syncMsg.endInfo);
  }
}

// The other player's connection dropped. Just informational.
function handleOpponentDisconnected(abortInMs) {
  sound.opponentDisconnected();
  clearInterval(opponentDisconnectTimer);
  clearTimeout(bannerAutoHideTimer);
  const deadline = Date.now() + abortInMs;
  const gameAlreadyOver = ui?.game?.gameOver === true;

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const text = gameAlreadyOver
      ? `Opponent disconnected — may not return for a rematch (${remaining}s)`
      : `Opponent disconnected — waiting ${remaining}s…`;
    showBanner(text, { kind: "warning" });
    if (remaining <= 0) clearInterval(opponentDisconnectTimer);
  };
  tick();
  opponentDisconnectTimer = setInterval(tick, 500);
}

function handleOpponentReconnected() {
  sound.opponentReconnected();
  clearInterval(opponentDisconnectTimer);
  clearTimeout(bannerAutoHideTimer);
  showBanner("Opponent reconnected", { kind: "info" });
  bannerAutoHideTimer = setTimeout(hideBanner, 2000); // tracked so a later banner can cancel it instead of being clobbered
}

// Genuine forfeit-by-abandonment, mid-game. The endcard needs the
// forfeit winner from the server, not the score-based one GameUI normally reads.
function handleMatchEnded(info) {
  clearInterval(opponentDisconnectTimer);
  clearTimeout(bannerAutoHideTimer);
  hideBanner();
  ui?.showForcedEnd(info);
}

// Match had already ended normally; the opponent just isn't coming
// back. The result already stands — nothing to change, just let them know.
function handleOpponentLeft() {
  sound.opponentLeft();
  clearInterval(opponentDisconnectTimer);
  clearTimeout(bannerAutoHideTimer);
  showBanner("Opponent left the match.", { kind: "info" });
  ui?.resetRematchPrompt(); // in case we were the one waiting on a rematch they were never going to accept
}

// Our OWN connection dropped unexpectedly. Auto-retry opening a fresh
// socket (the old one is dead) for up to roughly the server's own abort
// window, minus a safety margin — once a fresh socket is up, a single
// RECONNECT_ATTEMPT is enough; the server answers with syncState or
// reconnectFailed almost immediately, so there's no need to loop past that
// point. An "Abandon" option is available from the very first message, not
// just after everything fails — no reason to make someone wait on a spinner
// they already want to leave.
async function handleConnectionLost(matchClient) {
  if (reconnectInProgress) return; // don't start a second overlapping retry loop
  reconnectInProgress = true;
  sound.connectionLost();

  const deadline = Date.now() + Math.max(DISCONNECT_ABORT_MS - 1500, 2000);

  const abandon = () => {
    reconnectInProgress = false;
    leaveCurrentMatch();
    ui?.destroy();
    ui = null;
    menu.clearJoinCode();
    showScreen(menuScreen);
  };

  const attempt = async () => {
    if (Date.now() >= deadline) {
      reconnectInProgress = false;
      resetMatchState(); // don't leave currentMatchClient dangling
      showBanner("Couldn't reconnect — the match may be gone.", {
        kind: "danger",
        actions: [
          {
            label: "Back to menu",
            style: "primary",
            onClick: () => {
              hideBanner();
              ui?.destroy();
              ui = null;
              menu.clearJoinCode();
              showScreen(menuScreen);
            },
          },
        ],
      });
      return;
    }

    const remainingS = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    showBanner(`Connection lost — reconnecting… (up to ${remainingS}s)`, {
      kind: "danger",
      actions: [{ label: "Abandon", onClick: abandon }],
    });

    try {
      const conn = new Connection(wsUrl());
      currentConnection = conn;
      await conn.connect();
      matchClient.rebindConnection(conn);
      matchClient.attemptReconnect();
      // Outcome arrives via onSynced / onReconnectFailed (set once in
      // setupMatchClient, which also clears reconnectInProgress) — nothing
      // further to do from this loop.
    } catch {
      setTimeout(attempt, 1200);
    }
  };

  attempt();
}

// Shared terminal outcome for a reconnect attempt that the server
// explicitly rejected (session invalid, or the match is genuinely gone).
function handleReconnectFailed() {
  sound.reconnectFailed();
  reconnectInProgress = false;
  resetMatchState();
  showBanner("Couldn't reconnect — that match is gone.", {
    kind: "danger",
    actions: [
      {
        label: "Back to menu",
        style: "primary",
        onClick: () => {
          hideBanner();
          ui?.destroy();
          ui = null;
          menu.clearJoinCode();
          menuScreen.hidden = false;
          showScreen(menuScreen);
        },
      },
    ],
  });
}

function startGame(game, matchClient = null) {
  showScreen(gameScreen);

  ui?.destroy(); // tear down the previous match's listeners before reusing the same DOM

  const canvas = document.getElementById("board-canvas");
  const staticCanvas = document.getElementById("board-canvas-static");
  const renderer = new Renderer(canvas, staticCanvas, game.board, game.zoneRadius);

  ui = new GameUI(game, renderer, canvas, matchClient);
  ui.init();
}

// params here are always already resolved/clamped (see js/params.js) —
// Menu never hands raw form input to these callbacks.
function populateWaitingRoom(params, inviteCode) {
  document.getElementById("inviteCodeDisplay").textContent = inviteCode;
  document.getElementById("waitModeValue").textContent = params.mode === "classic" ? "Classic" : "Custom";
  document.getElementById("waitBoardValue").textContent = `${params.boardSize} x ${params.boardSize}`;
  document.getElementById("waitZoneRadiusValue").textContent = params.zoneRadius;
  document.getElementById("waitDominoValue").textContent = params.startingDominoes;
  document.getElementById("waitTimeValue").textContent = formatTimeControlLabel(params.timeControl);
}

// Page-load reconnect. Checked once, before Menu even shows the
// default screen — a stored session means this tab was mid-match when it
// went away (refresh, or the tab was closed and reopened within the same
// session). Skips the menu entirely, "Abandon" is right there if they'd rather not.
function attemptPageLoadReconnect(storedSession) {
  menuScreen.hidden = true;

  const conn = new Connection(wsUrl());
  currentConnection = conn;

  const abandon = () => {
    leaveCurrentMatch();
    menu.clearJoinCode();
    menuScreen.hidden = false;
  };

  showBanner("Reconnecting to your match…", {
    kind: "warning",
    actions: [{ label: "Abandon", onClick: abandon }],
  });

  conn
    .connect()
    .then(() => {
      const matchClient = setupMatchClient(conn); // sets the general-purpose matchClient.onReconnectFailed = handleReconnectFailed
      matchClient.restoreSession(storedSession);
      // Restore the general handler immediately so
      // this override only ever applies to this one attempt.
      matchClient.onReconnectFailed = () => {
        matchClient.onReconnectFailed = () => handleReconnectFailed();
        resetMatchState();
        menu.clearJoinCode();
        menuScreen.hidden = false;
      };

      if (!matchClient.attemptReconnect()) {
        matchClient.onReconnectFailed = () => handleReconnectFailed();
        resetMatchState();
        menu.clearJoinCode();
        menuScreen.hidden = false;
      }
    })
    .catch(() => abandon());
}

const menu = new Menu({
  onStartLocal: (params) => {
    sound.matchStart();
    lastLocalParams = params;
    startGame(new Game(params));
  },

  onCreateMatch: async (nickname, params) => {
    const conn = new Connection(wsUrl());
    currentConnection = conn;
    try {
      await conn.connect();
    } catch {
      currentConnection = null;
      showBanner("Couldn't reach the server. Check your connection and try again.", {
        kind: "danger",
        actions: [{ label: "Dismiss", onClick: hideBanner }],
      });
      return;
    }

    const matchClient = setupMatchClient(conn);
    matchClient.onCreated = (inviteCode) => {
      populateWaitingRoom(params, inviteCode);
      showScreen(waitingRoomScreen);
    };
    matchClient.createMatch(nickname, params);
  },

  onJoinMatch: async (nickname, code) => {
    const conn = new Connection(wsUrl());
    currentConnection = conn;
    try {
      await conn.connect();
    } catch {
      currentConnection = null;
      showBanner("Couldn't reach the server. Check your connection and try again.", {
        kind: "danger",
        actions: [{ label: "Dismiss", onClick: hideBanner }],
      });
      return;
    }

    const matchClient = setupMatchClient(conn);
    matchClient.joinMatch(code, nickname);
  },
});

// Run the reconnect check once, at startup, before anything else.
{
  const stored = MatchClient.loadSession();
  if (stored) attemptPageLoadReconnect(stored);
}

document.getElementById("btnCopyCode").addEventListener("click", (event) => {
  sound.uiConfirm();
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
  sound.uiBack();
  leaveCurrentMatch();
  menu.clearJoinCode();
  showScreen(menuScreen);
});

document.getElementById("btnRematch").addEventListener("click", () => {
  if (!lastLocalParams) return; // hidden for online matches, but guard anyway
  sound.matchStart();
  startGame(new Game({ ...lastLocalParams, seed: undefined })); // fresh board
});

document.getElementById("btnSameBoard").addEventListener("click", () => {
  if (!lastLocalParams || !ui) return;
  sound.matchStart();
  startGame(new Game({ ...lastLocalParams, seed: ui.game.seed })); // same cave, roles reset
});

// Shared by both the endcard's "Back to menu" and the mid-game local
// "Back to menu" — leaves any live match (harmless no-op for local hotseat,
// which has no matchClient/connection to close) and tears down the current
// GameUI so its clock intervals/timers don't keep running invisibly behind
// the menu screen.
function goToMenu() {
  sound.uiBack();
  leaveCurrentMatch();
  ui?.destroy();
  ui = null;
  menu.clearJoinCode();
  showScreen(menuScreen);
}

document.getElementById("btnBackToMenu").addEventListener("click", () => {
  goToMenu();
});

document.getElementById("btnLocalBackToMenu").addEventListener("click", () => {
  goToMenu();
});

// Run once to avoid stacking listeners on new games
initHintsPanel();
initSettingsPanel();
initRulesPanel();
