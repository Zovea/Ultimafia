// Game restrictions are derived from live membership and phase, never stored
// as moderation bans. DMs additionally reopen on death and in Postgame.
const GAME_PERMISSIONS = Object.freeze([
  "createThread", "postReply", "editPost", "publicChat", "privateChat",
]);
const PUBLIC_PERMISSIONS = Object.freeze(GAME_PERMISSIONS.slice(0, 4));
const NO_PERMISSIONS = Object.freeze([]);

const DM_LOCKED_MESSAGE =
  "Direct messages are locked while you're alive in a ranked or competitive game that's in progress.";

function gameLockedPermissions({ userId, game, deadIds }) {
  if (!userId || !game) return NO_PERMISSIONS;
  const settings = game.settings || {};
  if (!settings.ranked && !settings.competitive) return NO_PERMISSIONS;
  if (game.status !== "In Progress") return NO_PERMISSIONS;
  if (!(game.players || []).includes(userId)) return NO_PERMISSIONS;
  // Public chat and forums retain their existing restriction after death
  // and throughout Postgame until the player leaves.
  if (game.gameState === "Postgame" || (deadIds || []).includes(userId))
    return PUBLIC_PERMISSIONS;
  return GAME_PERMISSIONS;
}

function dmLockedByGame(info) {
  return gameLockedPermissions(info).includes("privateChat");
}

async function getGameCommunicationAccess(userId) {
  if (!userId) return { permissions: NO_PERMISSIONS };
  // Resolve lazily: redis.getUserPermissions uses this same rule.
  const redis = require("./redis");
  let gameId;
  try {
    gameId = await redis.inGame(userId);
    if (!gameId) return { permissions: NO_PERMISSIONS };
    const game = await redis.getGameInfo(gameId, true);
    // A membership pointing at unavailable state is not evidence of a lobby.
    if (!game || !["Open", "In Progress"].includes(game.status) ||
        !game.settings || typeof game.settings.ranked !== "boolean" ||
        typeof game.settings.competitive !== "boolean" ||
        !Array.isArray(game.players) || !game.players.includes(userId))
      throw new Error("Game communication state unavailable");
    const deadIds = await redis.getDeadPlayers(gameId);
    return { permissions: gameLockedPermissions({ userId, game, deadIds }), gameId };
  } catch (error) {
    return { permissions: GAME_PERMISSIONS, gameId, unavailable: true };
  }
}

async function getDmAccess(userId) {
  const access = await getGameCommunicationAccess(userId);
  if (!access.permissions.includes("privateChat")) return { locked: false };
  return {
    locked: true,
    gameId: access.gameId,
    message: access.unavailable
      ? "Direct messages are temporarily unavailable. Please try again."
      : DM_LOCKED_MESSAGE,
    ...(access.unavailable ? { unavailable: true } : {}),
  };
}

// getUserPermissions already combines moderation permissions and the live
// game restriction. Never grant a permission removed by a real ban.
async function hasPrivateChat(userId, permInfo) {
  return !!(permInfo && permInfo.perms && permInfo.perms.privateChat);
}

module.exports = {
  DM_LOCKED_MESSAGE,
  gameLockedPermissions,
  getGameCommunicationAccess,
  dmLockedByGame,
  getDmAccess,
  hasPrivateChat,
};
