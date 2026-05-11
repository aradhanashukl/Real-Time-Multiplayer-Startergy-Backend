/**
 * matchmaking/index.js
 *
 * WHAT MATCHMAKING SOLVES
 * ───────────────────────
 * When a player says "I want to play," we must find or create a room.
 * Without matchmaking, players would have to manually share room codes —
 * fine for a demo, terrible for a product.
 *
 * OUR APPROACH: simple FIFO queue.
 * Find any waiting room with the right game-mode that is not yet full.
 * If none exists, create one. When a room hits MAX_PLAYERS, start the game.
 *
 * PRODUCTION ADDITIONS (not here, but know them for interviews)
 * ─────────────────────────────────────────────────────────────
 * • Elo / MMR brackets — new players should not face veterans
 * • Ping-based geographic routing — Tokyo player on London server = 250 ms
 * • Party matching — friends joining as a pre-formed group
 * • Ranked vs casual queues — separate MMR pools
 * • Fill timeout — if queue sits empty for 30 s, lower the skill requirement
 *
 * WHY NOT PEER-TO-PEER (WebRTC DataChannel)
 * Any peer can lie. The authoritative-server model requires ALL game state
 * to flow through a trusted node. P2P removes that guarantee, making
 * anti-cheat essentially impossible.
 */

const { randomUUID: uuidv4 } = require('crypto');
const store = require('../store');

const MAX_PLAYERS = 4;

const STATUS = {
  WAITING:  'WAITING',   // lobby — filling up
  ACTIVE:   'ACTIVE',    // game in progress
  FINISHED: 'FINISHED',  // game over
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Main entry point called when a connected player requests a match.
 * Returns the room object they were placed in.
 */
function findOrCreateRoom(playerId, prefs = {}) {
  const mode = prefs.gameMode ?? 'standard';
  const open  = findOpenRoom(mode);
  return open ? joinRoom(open.id, playerId) : createRoom(playerId, mode);
}

function findOpenRoom(mode) {
  return store.getAllRooms().find(
    r => r.status === STATUS.WAITING && r.gameMode === mode && r.players.length < MAX_PLAYERS
  ) ?? null;
}

function createRoom(creatorId, mode) {
  const roomId = uuidv4();
  const room = {
    id:         roomId,
    gameMode:   mode,
    status:     STATUS.WAITING,
    players:    [],                    // { id, joinedAt, status, lastAckSeq }
    maxPlayers: MAX_PLAYERS,
    createdAt:  Date.now(),
    startedAt:  null,
    gameState:  buildInitialState(),
  };
  store.setRoom(roomId, room);
  console.log(`[Matchmaking] Created room ${roomId} (mode=${mode})`);
  return joinRoom(roomId, creatorId);
}

function joinRoom(roomId, playerId) {
  const room = store.getRoom(roomId);
  if (!room)                           throw new Error(`Room ${roomId} not found`);
  if (room.players.length >= MAX_PLAYERS) throw new Error(`Room ${roomId} is full`);

  room.players.push({
    id:         playerId,
    joinedAt:   Date.now(),
    status:     'CONNECTED',
    lastAckSeq: 0,
  });
  store.setRoom(roomId, room);
  console.log(`[Matchmaking] Player ${playerId} → room ${roomId} (${room.players.length}/${MAX_PLAYERS})`);

  return room.players.length === MAX_PLAYERS ? startRoom(roomId) : room;
}

function startRoom(roomId) {
  const room = store.getRoom(roomId);
  room.status    = STATUS.ACTIVE;
  room.startedAt = Date.now();

  // Server assigns starting positions — never trust the client to do this.
  // If two clients each claimed position [0,0] you would have a collision.
  const starts = [[0,0],[9,9],[0,9],[9,0]];
  room.players.forEach((p, i) => {
    room.gameState.units[p.id] = {
      position: starts[i],
      health:   100,
      maxHp:    100,
      ap:       3,    // action points — reset each turn
    };
  });

  store.setRoom(roomId, room);
  console.log(`[Matchmaking] Room ${roomId} started with ${room.players.length} players`);
  return room;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildInitialState() {
  return {
    tick:   0,
    turn:   1,
    board:  buildBoard(10, 10),
    units:  {},      // playerId → { position, health, maxHp, ap }
    events: [],      // flushed each tick
    winner: null,
  };
}

/**
 * WHY A 2-D ARRAY INSTEAD OF A GRAPH
 * Graph traversal (Dijkstra, A*) is flexible but heavy.
 * Array index [row][col] is O(1) lookup, trivial to JSON-serialize, and easy
 * to diff for state deltas. For a 10×10 grid this is more than sufficient.
 */
function buildBoard(w, h) {
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) =>
      // Deterministic obstacle scatter — same board every game
      (x + y) % 7 === 0 && x !== 0 && y !== 0 ? 1 : 0
    )
  );
}

function getRoomForPlayer(playerId) {
  return store.getAllRooms().find(r => r.players.some(p => p.id === playerId)) ?? null;
}

function markDisconnected(playerId) {
  const room = getRoomForPlayer(playerId);
  if (!room) return;
  const p = room.players.find(p => p.id === playerId);
  if (p) { p.status = 'DISCONNECTED'; p.disconnectedAt = Date.now(); }
  store.setRoom(room.id, room);
}

function markReconnected(playerId) {
  const room = getRoomForPlayer(playerId);
  if (!room) return;
  const p = room.players.find(p => p.id === playerId);
  if (p) { p.status = 'CONNECTED'; delete p.disconnectedAt; }
  store.setRoom(room.id, room);
}

module.exports = {
  findOrCreateRoom,
  getRoomForPlayer,
  markDisconnected,
  markReconnected,
  ROOM_STATUS: STATUS,
  MAX_PLAYERS,
};
