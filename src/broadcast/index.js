/**
 * broadcast/index.js
 *
 * WHAT THIS MODULE DOES
 * ─────────────────────
 * Maintains a registry of active WebSocket connections keyed by playerId.
 * Provides three send primitives:
 *   broadcastToRoom   — send to every connected player in a room
 *   broadcastToPlayer — send to exactly one player
 *   broadcastToAll    — send to every connected player globally (e.g., server shutdown notice)
 *
 * WHY A SEPARATE BROADCAST MODULE
 * ─────────────────────────────────
 * The game loop, reconnect handler, and matchmaking all need to send messages.
 * If each imported `ws` directly they would all need access to the raw socket map.
 * A dedicated broadcast module is the single place that knows about sockets.
 * Everything else speaks in terms of playerId / roomId — never raw sockets.
 *
 * WHY WE DO NOT USE Socket.IO ROOMS
 * Socket.IO rooms are convenient but they hide what is actually happening.
 * Understanding raw WebSocket fan-out is essential for debugging performance
 * at scale (10 000+ concurrent connections). We do it manually so the
 * mechanism is visible.
 *
 * SCALING NOTE
 * ────────────
 * In a multi-server deployment, players in the same room may be connected to
 * different server instances. broadcastToRoom would need to publish to a Redis
 * pub/sub channel; each server subscribes to channels for rooms it hosts.
 * The interface here (roomId, playerId, message) does not change — only the
 * transport inside changes.
 */

const { WebSocket } = require('ws');
const store = require('../store');
const { needsCorrection } = require('../reconciliation');

// playerId → WebSocket instance
// This map is the only place that holds live socket references.
const connections = new Map();

// ── Connection lifecycle ──────────────────────────────────────────────────────

function register(playerId, ws) {
  connections.set(playerId, ws);
}

function unregister(playerId) {
  connections.delete(playerId);
}

function isConnected(playerId) {
  const ws = connections.get(playerId);
  return ws?.readyState === WebSocket.OPEN;
}

// ── Send primitives ───────────────────────────────────────────────────────────

/**
 * Send to every CONNECTED player in a room.
 * If the room does not exist in the store, no-op.
 *
 * Attaches a `correction` flag for any player whose lastAckSeq is behind,
 * telling their client to roll back optimistic state.
 */
function broadcastToRoom(roomId, message) {
  const room = store.getRoom(roomId);
  if (!room) return;

  const currentSeq = store.getSeq(roomId);

  for (const player of room.players) {
    if (player.status !== 'CONNECTED') continue;

    const correction = needsCorrection(player, currentSeq);
    send(player.id, { ...message, correction });
  }
}

/**
 * Send to exactly one player.
 * Used for: action rejections, reconnect payloads, private game events.
 */
function broadcastToPlayer(roomId, playerId, message) {
  send(playerId, message);
}

/**
 * Send to every currently connected player regardless of room.
 * Used for: server-wide announcements, graceful shutdown notices.
 */
function broadcastToAll(message) {
  for (const [playerId] of connections) {
    send(playerId, message);
  }
}

// ── Internal send ─────────────────────────────────────────────────────────────

/**
 * Serialize and send. Silently drops if socket is not open.
 *
 * WHY WE CATCH AND SWALLOW WS ERRORS HERE
 * A BROKEN_PIPE or ECONNRESET on one socket must not crash the server or
 * prevent other players in the room from receiving their updates.
 * The error is logged; the reconnect handler will eventually clean up the
 * dead connection when the heartbeat fails.
 */
function send(playerId, message) {
  const ws = connections.get(playerId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    console.error(`[Broadcast] Failed to send to ${playerId}:`, err.message);
  }
}

// ── Stats (useful for monitoring / debugging) ─────────────────────────────────

function getConnectionCount() {
  return connections.size;
}

function getConnectedPlayerIds() {
  return [...connections.keys()];
}

module.exports = {
  register,
  unregister,
  isConnected,
  broadcastToRoom,
  broadcastToPlayer,
  broadcastToAll,
  getConnectionCount,
  getConnectedPlayerIds,
};
