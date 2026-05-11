/**
 * server.js — Entry point
 *
 * RESPONSIBILITIES
 * ─────────────────
 * 1. Create the WebSocket server
 * 2. Handle connection lifecycle (open, message, close, error)
 * 3. Route incoming messages to the correct module
 * 4. Start the game loop
 *
 * WHAT THIS FILE DOES NOT DO
 * ────────────────────────────
 * It does not contain game logic. It does not validate actions. It does not
 * manage state. It is a thin router — the equivalent of an HTTP framework's
 * app.js. All real work happens in the modules it delegates to.
 *
 * MESSAGE PROTOCOL (client → server)
 * ────────────────────────────────────
 * Every message is a JSON object with a `type` field:
 *
 *   { type: 'JOIN',      payload: { gameMode?, playerName? } }
 *   { type: 'RECONNECT', payload: { sessionToken } }
 *   { type: 'ACTION',    payload: { type, payload, clientTimestamp } }
 *   { type: 'ACK',       payload: { seq } }
 *   { type: 'PING' }
 *
 * MESSAGE PROTOCOL (server → client)
 * ────────────────────────────────────
 *   { type: 'CONNECTED',          sessionToken, playerId, roomId? }
 *   { type: 'WAITING_FOR_PLAYERS', roomId, players }
 *   { type: 'GAME_START',          roomId, players, gameState }
 *   { type: 'STATE_UPDATE',        seq, tick, delta, correction }
 *   { type: 'ACTION_REJECTED',     action, reason }
 *   { type: 'RECONNECT_ACK',       snapshot, missedEvents, currentSeq }
 *   { type: 'PLAYER_RECONNECTED',  playerId }
 *   { type: 'PLAYER_FORFEITED',    playerId, reason }
 *   { type: 'GAME_OVER',           winner, seq }
 *   { type: 'PONG' }
 *   { type: 'ERROR',               message }
 *
 * WHY JSON INSTEAD OF A BINARY PROTOCOL (e.g., MessagePack, Protobuf)
 * ──────────────────────────────────────────────────────────────────────
 * JSON is human-readable — invaluable during development and debugging.
 * For a strategy game with 20 ticks/sec the extra bytes are negligible.
 * Production games (FPS, racing) use binary protocols to cut bandwidth ~60 %.
 * The switch is mechanical: replace JSON.stringify/parse with a codec.
 *
 * WHY WE HANDLE ping/pong MANUALLY
 * ───────────────────────────────────
 * ws has built-in ping/pong frames (ws.ping()). We also handle a JSON
 * { type:'PING' } message because some browser environments strip raw
 * WebSocket control frames. The JSON ping acts as an application-level
 * heartbeat and doubles as a round-trip latency probe.
 */

'use strict';

const { WebSocketServer } = require('ws');
const { randomUUID: uuidv4 } = require('crypto');

const store       = require('./store');
const broadcast   = require('./broadcast');
const gameloop    = require('./gameloop');
const matchmaking = require('./matchmaking');
const reconnect   = require('./reconnect');

const PORT = process.env.PORT ?? 8080;

// ── Server setup ──────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });
console.log(`[Server] WebSocket server listening on ws://localhost:${PORT}`);

// Start the fixed-tick game loop
gameloop.start();

// ── Connection handler ────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  // Assign a temporary ID; replaced by the session playerId on JOIN/RECONNECT
  const tempId = `tmp-${uuidv4().slice(0, 8)}`;
  let playerId  = null;
  let sessionToken = null;

  console.log(`[Server] New connection (${tempId}) from ${req.socket.remoteAddress}`);

  // ── Heartbeat — detect dead connections ────────────────────────────────────
  // WHY WE NEED THIS
  // TCP connections can go silent without emitting a 'close' event (e.g., a
  // mobile device losing signal without sending a FIN packet). Without
  // heartbeating, dead sockets accumulate and consume memory indefinitely.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; }); // WS protocol pong

  // ── Message handler ────────────────────────────────────────────────────────

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(ws, { type: 'ERROR', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'JOIN':      handleJoin(ws, msg, tempId);       break;
      case 'RECONNECT': handleReconnect(ws, msg);           break;
      case 'ACTION':    handleAction(ws, msg, playerId);    break;
      case 'ACK':       handleAck(msg, playerId);           break;
      case 'PING':      send(ws, { type: 'PONG' });         break;
      default:
        send(ws, { type: 'ERROR', message: `Unknown message type: ${msg.type}` });
    }
  });

  // ── Close handler ──────────────────────────────────────────────────────────

  ws.on('close', (code, reason) => {
    console.log(`[Server] Connection closed: ${playerId ?? tempId} (${code})`);
    if (playerId) {
      reconnect.handleDisconnect(playerId);
      // Note: we do NOT destroy the session here — it is needed for reconnect auth.
      // Sessions are destroyed when grace period expires or game ends.
    }
  });

  ws.on('error', (err) => {
    console.error(`[Server] WS error for ${playerId ?? tempId}:`, err.message);
  });

  // ── JOIN ───────────────────────────────────────────────────────────────────

  function handleJoin(ws, msg, tempId) {
    if (playerId) {
      send(ws, { type: 'ERROR', message: 'Already joined' });
      return;
    }

    playerId     = uuidv4();
    sessionToken = reconnect.createSession(playerId);

    broadcast.register(playerId, ws);

    // Send session credentials to the client — they MUST save the token for reconnect
    send(ws, {
      type:         'CONNECTED',
      playerId,
      sessionToken,
    });

    try {
      const room = matchmaking.findOrCreateRoom(playerId, msg.payload ?? {});

      if (room.status === matchmaking.ROOM_STATUS.WAITING) {
        // Room not full yet — tell the player to wait
        broadcast.broadcastToRoom(room.id, {
          type:    'WAITING_FOR_PLAYERS',
          roomId:  room.id,
          count:   room.players.length,
          needed:  room.maxPlayers,
        });
      } else {
        // Room just became full and has started
        broadcast.broadcastToRoom(room.id, {
          type:      'GAME_START',
          roomId:    room.id,
          players:   room.players,
          gameState: room.gameState,
        });
      }
    } catch (err) {
      console.error(`[Server] Join failed for ${playerId}:`, err.message);
      send(ws, { type: 'ERROR', message: err.message });
    }
  }

  // ── RECONNECT ──────────────────────────────────────────────────────────────

  function handleReconnect(ws, msg) {
    const { sessionToken: token, playerId: pid } = msg.payload ?? {};
    if (!token || !pid) {
      send(ws, { type: 'ERROR', message: 'RECONNECT requires sessionToken and playerId' });
      return;
    }

    const result = reconnect.handleReconnect(pid, token, ws);
    if (!result.success) {
      send(ws, { type: 'ERROR', message: result.error });
      return;
    }

    // Adopt the restored identity on this connection
    playerId     = pid;
    sessionToken = token;
  }

  // ── ACTION ─────────────────────────────────────────────────────────────────

  function handleAction(ws, msg, pid) {
    if (!pid) {
      send(ws, { type: 'ERROR', message: 'Must JOIN before sending actions' });
      return;
    }

    const room = matchmaking.getRoomForPlayer(pid);
    if (!room) {
      send(ws, { type: 'ERROR', message: 'Not in a room' });
      return;
    }
    if (room.status !== matchmaking.ROOM_STATUS.ACTIVE) {
      send(ws, { type: 'ERROR', message: 'Game is not active' });
      return;
    }

    // Enqueue for the next game loop tick — do NOT process synchronously here.
    // Processing inline would block the event loop and delay other connections.
    gameloop.enqueueAction(room.id, pid, msg.payload);
  }

  // ── ACK ────────────────────────────────────────────────────────────────────

  /**
   * Client sends { type:'ACK', payload:{ seq } } after successfully applying
   * a STATE_UPDATE. The server uses lastAckSeq to:
   *   a) Set the correction flag on future broadcasts (reconciliation)
   *   b) Know the minimum seq to include in reconnect event logs
   */
  function handleAck(msg, pid) {
    if (!pid) return;
    const room = matchmaking.getRoomForPlayer(pid);
    if (!room) return;
    const player = room.players.find(p => p.id === pid);
    if (player && msg.payload?.seq > (player.lastAckSeq ?? 0)) {
      player.lastAckSeq = msg.payload.seq;
      store.setRoom(room.id, room);
    }
  }
});

// ── Global heartbeat interval ─────────────────────────────────────────────────
//
// Every 30 s, ping all connected sockets. Any socket that has not responded
// since the last ping is terminated. This prevents ghost connections from
// accumulating when mobile devices lose signal without closing the TCP connection.

const HEARTBEAT_INTERVAL = 30_000;

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      console.log('[Server] Terminating unresponsive connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(heartbeatTimer));

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  console.log('[Server] Shutting down gracefully...');
  gameloop.stop();
  broadcast.broadcastToAll({ type: 'SERVER_SHUTDOWN', message: 'Server is restarting' });
  wss.close(() => {
    console.log('[Server] All connections closed. Exiting.');
    process.exit(0);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

module.exports = { wss }; // exported for tests
