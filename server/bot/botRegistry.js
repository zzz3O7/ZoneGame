import { randomBotMove } from "./randomBot.js";
import { noWasteBotMove } from "./noWasteBot.js";
import { tier3BotMove } from "./tier3Bot.js";

// One entry per strength tier. Keyed by the same botKey used in
// seedBots.js / findOrCreateBotPlayer (see botRepository.js) — that key
// is what's encoded into the player row's google_sub as `bot:${botKey}`,
// so a bot row and its move logic are matched up by that key, not by
// nickname (which is free to change) or id (which is DB-assigned).
const CHOOSE_MOVE_BY_KEY = {
  "random-01": randomBotMove,
  "no-waste-01": noWasteBotMove,
  "solver-greedy-01": tier3BotMove,
};

// Unknown/missing key (e.g. a bot row seeded before its tier's code
// existed) falls back to the weakest tier rather than throwing — a bot
// should always be able to move, never crash a match.
export function chooseMoveForBotKey(botKey) {
  return CHOOSE_MOVE_BY_KEY[botKey] ?? randomBotMove;
}
