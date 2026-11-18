// Controlled dependencies around the real permission and start implementations.
// These checks do not replace real Mongo/Redis/socket/browser acceptance.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(file, dependencies, expose = "") {
  const module = { exports: {} };
  const filename = path.join(__dirname, "..", file);
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + expose, {
    module, exports: module.exports, process: { env: process.env, on() { return this; } }, console, setTimeout, clearTimeout,
    require: (id) => dependencies[id] || {},
  }, { filename });
  return module.exports;
}
const permissions = ["createThread", "postReply", "editPost", "publicChat", "privateChat"];
function fixture() {
  const values = new Map();
  const sets = new Map();
  const bans = [];
  let failKey;
  const client = {
    on() {}, select() {}, expire() {},
    async existsAsync(k) { return values.has(k); },
    async getAsync(k) { if (k === failKey) throw Error("read outage"); return values.get(k) ?? null; },
    set(k, v) { values.set(k, v); },
    async setAsync(k, v) { values.set(k, v); },
    async delAsync(k) { values.delete(k); },
    async saddAsync(k, v) { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(v); },
    async sremAsync(k, v) { sets.get(k)?.delete(v); },
    async sismemberAsync(k, v) { return sets.get(k)?.has(v) || false; },
    async smembersAsync(k) { if (k === failKey) throw Error("read outage"); return [...(sets.get(k) || [])]; },
  };
  const user = { rank: 2, permissions: [], _id: "u", toJSON() { return this; } };
  const models = {
    User: { findOne: () => ({ select: async () => user }) },
    InGroup: { find: () => ({ populate: async () => [] }) },
    Ban: { find: (query) => ({ select: async () => bans.filter(b => b.type !== query.type.$ne) }),
      deleteMany: () => ({ exec: async () => {} }) },
  };
  const gate = load("modules/dmGate.js", { "./redis": {} });
  const redisDeps = { "bluebird": { promisifyAll: x => x }, "redis": { createClient: () => client },
    "../db/models": models, "../data/constants": { defaultPerms: [...permissions, "other"] }, "./dmGate": gate };
  const redis = load("modules/redis.js", redisDeps);
  // The gate's lazy require resolves the same production Redis exports.
  const actualGate = load("modules/dmGate.js", { "./redis": redis });
  Object.assign(gate, actualGate);
  function seat(status = "Open", ranked = true, competitive = false) {
    values.set("user:alice:game", "g");
    sets.set("games", new Set(["g"])); sets.set("game:g:players", new Set(["alice"]));
    values.set("game:g:status", status); values.set("game:g:gameState", "Pregame");
    values.set("game:g:settings", JSON.stringify({ ranked, competitive }));
  }
  return { redis, gate, client, values, sets, bans, seat, fail: k => { failKey = k; } };
}

for (const competitive of [false, true]) {
  test(`cold and warm caches follow start, death, revival, postgame, leave (${competitive ? "competitive" : "ranked"})`, async () => {
    const f = fixture(); f.seat("Open", !competitive, competitive);
    for (let i = 0; i < 2; i++) {
      const info = await f.redis.getUserPermissions("alice");
      for (const p of permissions) assert.equal(info.perms[p], true);
    }
    await f.redis.setGameStatus("g", "In Progress");
    for (let i = 0; i < 2; i++) {
      const info = await f.redis.getUserPermissions("alice");
      for (const p of permissions) assert.equal(info.perms[p], undefined);
      assert.equal(info.perms.other, true); assert.equal(info.rank, 2);
    }
    await f.redis.setPlayerDead("g", "alice", true);
    let info = await f.redis.getUserPermissions("alice");
    assert.equal(info.perms.privateChat, true); assert.equal(info.perms.publicChat, undefined);
    for (const p of permissions.slice(0, 3)) assert.equal(info.perms[p], undefined);
    await f.redis.setPlayerDead("g", "alice", false);
    assert.equal((await f.gate.getDmAccess("alice")).locked, true);
    f.values.set("game:g:gameState", "Postgame");
    assert.equal((await f.gate.getDmAccess("alice")).locked, false);
    assert.equal((await f.redis.getUserPermissions("alice")).perms.publicChat, undefined);
    await f.redis.leaveGame("alice");
    for (const p of permissions) assert.equal((await f.redis.getUserPermissions("alice")).perms[p], true);
  });
}

test("cold active cache never stores the overlay", async () => {
  const f = fixture(); f.seat("In Progress");
  assert.equal((await f.redis.getUserPermissions("alice")).perms.publicChat, undefined);
  assert.equal(JSON.parse(f.values.get("user:alice:basePerms")).publicChat, true);
  await f.redis.setGameStatus("g", "Open");
  assert.equal((await f.redis.getUserPermissions("alice")).perms.publicChat, true);
});

test("real bans beat pregame and dead-player access; legacy automatic bans do not", async () => {
  const f = fixture(); f.seat();
  f.bans.push({ type: "gameAuto", permissions }, { type: "moderation", permissions: ["privateChat", "postReply"] });
  f.values.set("user:alice:perms", "{}"); f.values.set("user:alice:rank", 2);
  const info = await f.redis.getUserPermissions("alice");
  assert.equal(info.perms.publicChat, true); assert.equal(info.perms.privateChat, undefined);
  assert.equal(info.perms.postReply, undefined); assert.equal(await f.gate.hasPrivateChat("alice", info), false);
  f.values.set("game:g:status", "In Progress"); await f.redis.setPlayerDead("g", "alice", true);
  assert.equal((await f.redis.getUserPermissions("alice")).perms.privateChat, undefined);
});

for (const key of ["user:alice:game", "game:g:settings", "game:g:status", "game:g:dead"]) {
  test(`fails closed on ${key} read errors`, async () => {
    const f = fixture(); f.seat(); f.fail(key);
    const access = await f.gate.getDmAccess("alice"); assert.equal(access.locked, true); assert.equal(access.unavailable, true);
    const info = await f.redis.getUserPermissions("alice");
    for (const p of permissions) assert.equal(info.perms[p], undefined);
  });
}

test("missing game or invalid settings fails closed", async () => {
  const f = fixture(); f.seat(); f.sets.delete("games");
  assert.equal((await f.gate.getDmAccess("alice")).unavailable, true);
  f.sets.set("games", new Set(["g"])); f.values.set("game:g:settings", "invalid");
  assert.equal((await f.gate.getDmAccess("alice")).unavailable, true);
});

test("unranked and nonseated users remain unrestricted", async () => {
  const f = fixture(); f.seat("In Progress", false);
  assert.equal((await f.gate.getDmAccess("alice")).locked, false);
  f.seat("In Progress"); f.sets.set("game:g:players", new Set(["bob"]));
  f.values.delete("user:alice:game");
  for (const p of permissions) assert.equal((await f.redis.getUserPermissions("alice")).perms[p], true);
});

test("joining writes membership without constructing any ban", async () => {
  const f = fixture();
  // Ban is deliberately not constructible; the former join implementation fails.
  await f.redis.joinGame("alice", "g", true, true);
  assert.equal(await f.redis.inGame("alice"), "g");
  assert.deepEqual(await f.client.smembersAsync("game:g:players"), ["alice"]);
});

function startFixture(write) {
  const games = {};
  const alerts = [], errors = [], roles = [];
  const Game = load("Games/core/Game.js", {
    "../games": { games }, "../../modules/redis": { setGameStatus: write },
    "../../modules/logging": () => ({ error: e => errors.push(e), warn() {} }),
    "./devControls": { withDevSeed: (_g, fn) => fn() }, "../../modules/gameEventLog": { server() {} },
  });
  const game = Object.create(Game.prototype);
  Object.assign(game, { id: "g", players: [], spectators: [], setup: { total: 0 }, devControls: {}, events: { emit() {} },
    removePregameSpectators() {}, clearTimer() {}, assignRoles() { roles.push(true); },
    captureStartingFactions() {}, broadcast() {}, broadcastOptions() {}, calculateStateOffset() {}, gotoNextState() {},
    refundHeartsChargedAtStart: async () => {}, sendReadyCheckCancel() {}, sendAlert: m => alerts.push(m),
  });
  games.g = game;
  return { game, games, alerts, errors, roles };
}

test("start waits for the In Progress write before revealing roles", async () => {
  let resolve; const write = new Promise(r => { resolve = r; });
  const f = startFixture(() => write); const pending = f.game.start();
  await Promise.resolve(); assert.equal(f.roles.length, 0);
  resolve(); await pending; assert.equal(f.roles.length, 1);
});

test("a rejected start write reveals no roles and resets starting with visible feedback", async () => {
  const f = startFixture(async (_id, status) => { if (status === "In Progress") throw Error("write outage"); });
  await f.game.start(); assert.equal(f.roles.length, 0); assert.equal(f.game.starting, false);
  assert.ok(f.alerts.some(m => m.includes("could not start"))); assert.equal(f.errors.length, 1);
});

test("start and abort write failures remain closed and are reported", async () => {
  const f = startFixture(async () => { throw Error("write outage"); });
  await f.game.start(); assert.equal(f.roles.length, 0); assert.equal(f.game.starting, false);
  assert.equal(f.errors.length, 2); assert.ok(f.alerts.length);
});

test("cancelled game is not started after delayed status acknowledgement", async () => {
  let resolve; const f = startFixture(() => new Promise(r => { resolve = r; }));
  const pending = f.game.start(); delete f.games.g; resolve(); await pending;
  assert.equal(f.roles.length, 0); assert.equal(f.game.starting, false);
});

test("abort does not recreate a game cancelled during refund", async () => {
  const writes = []; const f = startFixture(async (...args) => writes.push(args));
  f.game.refundHeartsChargedAtStart = async () => { delete f.games.g; };
  await f.game.abortStart(); assert.equal(writes.length, 0);
});

function chatFixture(access, moderators = async () => []) {
  return load("modules/chat.js", {
    dotenv: { config() {} }, "../lib/sockets": { SocketServer: class {} },
    "./logging": () => ({ error() {} }), "../db/db": { promise: new Promise(() => {}) },
    "./dmGate": { getDmAccess: access }, "../routes/utils": { getModIds: moderators },
  }, "\nmodule.exports = { broadcastMessage, refuseIfDmLocked, users, channelMembers };");
}

test("live delivery and date previews fail closed when access throws", async () => {
  const chat = chatFixture(async () => { throw Error("outage"); });
  const sent = []; const socket = { send: (...args) => sent.push(args) };
  chat.users.alice = socket; chat.channelMembers.c = { alice: socket };
  await chat.broadcastMessage({ channel: "c", sender: { id: "bob" }, content: "private", date: 1 },
    { id: "c", memberIds: ["alice", "bob"], members: [{ id: "alice" }] });
  assert.equal(sent.some(([event]) => event === "message"), false);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], "dateUpdate");
  assert.equal(sent[0][1].lastMessage, undefined);
});

test("moderator lookup failure cannot cause live delivery", async () => {
  const chat = chatFixture(async () => ({ locked: true }), async () => { throw Error("mods unavailable"); });
  const sent = []; chat.channelMembers.c = { alice: { send: (...a) => sent.push(a) } };
  await chat.broadcastMessage({ channel: "c", sender: { id: "mod" } }, { id: "c", memberIds: ["alice", "mod"] });
  assert.equal(sent.length, 0);
});

test("moderator DM exception survives a known lock but not unavailable state", async () => {
  let unavailable = false;
  const chat = chatFixture(async () => ({ locked: true, unavailable }), async () => ["mod"]);
  const sent = []; const socket = { send: (...args) => sent.push(args) };
  assert.equal(await chat.refuseIfDmLocked(socket, "alice", ["alice", "mod"]), false);
  unavailable = true;
  assert.equal(await chat.refuseIfDmLocked(socket, "alice", ["alice", "mod"]), true);
  assert.equal(sent[0][0], "dmLocked");
});

for (const missing of ["game:g:settings", "game:g:status", "game:g:players"]) {
  test(`membership with missing ${missing} fails closed`, async () => {
    const f = fixture(); f.seat(); f.values.delete(missing); f.sets.delete(missing);
    assert.equal((await f.gate.getDmAccess("alice")).unavailable, true);
    for (const p of permissions) assert.equal((await f.redis.getUserPermissions("alice")).perms[p], undefined);
  });
}

test("a stale membership pointing at somebody else's roster fails closed", async () => {
  const f = fixture(); f.seat(); f.sets.set("game:g:players", new Set(["bob"]));
  assert.equal((await f.gate.getDmAccess("alice")).unavailable, true);
});

test("failed Open write still clears ready state and restores pregame spectators without claiming access restored", async () => {
  const f = startFixture(async () => { throw Error("write outage"); });
  const actions = [];
  f.game.isReadyCheckActive = true; f.game.readyPlayers = { alice: true };
  f.game.spectators = [{ id: "spectator", sendMeetings: () => actions.push("meetings") }];
  f.game.pregame = { members: {}, join: () => actions.push("join") };
  f.game.clearTimer = name => actions.push(name);
  f.game.sendReadyCheckCancel = () => actions.push("cancel");
  assert.equal(await f.game.abortStart(), false);
  assert.equal(f.game.isReadyCheckActive, false); assert.equal(Object.keys(f.game.readyPlayers).length, 0);
  assert.deepEqual(actions, ["pregameCountdown", "cancel", "join", "meetings"]);
  assert.ok(f.alerts[0].includes("could not be restored"));
});

async function sendingFixture() {
  const sent = [], errors = []; let access = { locked: false }, limited = false, blocked = false, writes = 0;
  const chain = value => {
    const q = { then: resolve => Promise.resolve(value).then(resolve) };
    for (const name of ["select", "populate", "sort", "limit"]) q[name] = () => q;
    return q;
  };
  const channel = { id: "c", public: false, memberIds: ["alice", "mod"], members: [{ id: "alice" }, { id: "mod" }] };
  class ChatMessage { constructor() { writes++; } }
  ChatMessage.find = () => chain([]);
  const deps = {
    dotenv: { config() {} }, "../lib/sockets": { SocketServer: class { on(name, fn) { this[name] = fn; } } },
    "./logging": () => ({ error: e => errors.push(e), log: e => errors.push(e) }), "../db/db": { promise: Promise.resolve() },
    "./dmGate": { getDmAccess: async () => access, hasPrivateChat: async () => false },
    "../routes/utils": { getModIds: async () => ["mod"], rateLimit: async () => !limited },
    "./blocks": { dmBlockMessage: () => blocked ? "Blocked" : null },
    "./socketGroup": { addSocket: (map, id, socket) => { map[id] = socket; }, removeSocket() {} },
    "./redis": { authenticateToken: async () => "alice", getBasicUserInfo: async () => ({ id: "alice" }),
      getUserPermissions: async () => ({ rank: 0, perms: {} }), getOnlineUsersInfo: async () => [], getBlockedUsers: async () => [] },
    "../data/constants": { maxChatMessageLength: 1000 },
    "../db/models": { ChatChannel: { findOne: () => chain(channel), find: () => chain([]) }, ChatMessage,
      ChannelOpen: { find: () => chain([]) }, Notification: { find: () => chain([]) } },
  };
  const chat = load("modules/chat.js", deps, "\nmodule.exports = { server };");
  await new Promise(setImmediate);
  const handlers = {};
  const socket = { send: (...args) => sent.push(args), on: (name, fn) => { handlers[name] = fn; } };
  await chat.server.connection(socket); await handlers.auth("token"); await handlers.getChannel("c");
  sent.length = 0;
  return { sent, errors, send: () => handlers.sendMessage("hello"), writes: () => writes,
    lock: a => { access = a; }, limit: () => { limited = true; }, block: () => { blocked = true; } };
}

test("existing moderator channel cannot send through an unavailable game-state lookup", async () => {
  const f = await sendingFixture(); f.lock({ locked: true, unavailable: true }); await f.send();
  assert.equal(f.writes(), 0); assert.ok(f.sent.some(([name]) => name === "dmLocked"));
  assert.equal(f.errors.length, 0);
});

test("moderator exception does not bypass rate limits", async () => {
  const f = await sendingFixture(); f.lock({ locked: true }); f.limit(); await f.send();
  assert.equal(f.writes(), 0); assert.ok(f.sent.some(([, text]) => text === "You are chatting too quickly."));
  assert.equal(f.errors.length, 0);
});

test("moderator exception does not bypass user blocks", async () => {
  const f = await sendingFixture(); f.lock({ locked: true }); f.block(); await f.send();
  assert.equal(f.writes(), 0); assert.ok(f.sent.some(([, text]) => text === "Blocked"));
  assert.equal(f.errors.length, 0);
});

// Documents the pre-existing refund failure boundary, not successful recovery.
// Refund ownership/idempotency requires its own monetary-state fix.
test("refund failure remains an explicit abort-recovery limitation", async () => {
  const writes = []; const f = startFixture(async (...args) => writes.push(args));
  f.game.isReadyCheckActive = true;
  f.game.refundHeartsChargedAtStart = async () => { throw Error("refund outage"); };
  await assert.rejects(f.game.abortStart(), /refund outage/);
  assert.equal(writes.length, 0); assert.equal(f.roles.length, 0);
  assert.equal(f.game.isReadyCheckActive, true);
});
