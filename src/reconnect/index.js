/**
 * reconnect/index.js
 *
 * THE PROBLEM
 * ───────────
 * A player drops (wifi blip, mobile switching networks, tab crash).
 * If we immediately remove them, they lose their game.
 * If we freeze the game waiting for them, all other players are held hostage.
 *
 * THE SOLUTION: grace period + stateful reconnect
 * ──────────────────────────────────────────────────────────────────────────
 * 1. On disconnect: mark the player DISCONNECTED but keep their slot for
 *    GRACE_PERIOD_MS. The game continues. AI or no-op fills their turns.
 *
 * 2. On reconnect within the grace period:
 *    a. Verify the session token (prevents session hijacking).
 *    b. Send a full state snapshot (so they do not have to replay everything).
 *    c. Send all events since their last acknowledged seq (fills the gap).
 *    d. Mark them CONNECTED again.
 *
 * 3. After the grace period expires: remove the player, forfeit their unit,
 *    and notify the room.
 *
 * WHY NOT JUST SEND THE FULL STATE ON RECONNECT
 * You could send the current full state and that would work. But if they were
 * gone for 100 ticks, they would see a jump cut — units teleport, HP changes
 * with no explanation. Replaying the event log lets the client animate the
 * transitions and show the player what they missed, which is better UX and
 * also important for games with a history pane (e.g., card games).
 *
 * WHY SESSION TOKENS
 * Without a token, any client that knows a playerId could impersonate a
 * disconnected player and take over their game position. The token (a UUID
 * issued at connection time) is a shared secret between this player and server.
 */

const store            = require('../store');
const broadcast        = require('../broadcast');
const { markDisconnected, markReconnected, getRoomForPlayer } = require('../matchmaking');
const { applyAction }  = require('../room');

const GRACE_PERIOD_MS  = 30_000; // 30 seconds before we remove the player

// Pending grace timers: playerId → TimeoutHandle
const graceTimers = new Map();

// ── Disconnect handling ───────────────────────────────────────────────────────

/**
 * Called by the WS close handler immediately when a connection drops.
 * Starts the grace period clock.
 */
function handleDisconnect(playerId) {
  markDisconnected(playerId);
  broadcast.unregister(playerId);

  console.log(`[Reconnect] Player ${playerId} disconnected — grace period ${GRACE_PERIOD_MS / 1000}s`);

  const timer = setTimeout(() => expireGrace(playerId), GRACE_PERIOD_MS);
  graceTimers.set(playerId, timer);
}

/**
 * Called when the grace period expires without the player reconnecting.
 * Removes the player from the room and notifies others.
 */
function expireGrace(playerId) {
  graceTimers.delete(playerId);
  const room = getRoomForPlayer(playerId);
  if (!room) return;

  console.log(`[Reconnect] Grace expired for ${playerId} — forfeiting`);

  // Apply a FORFEIT action so the game loop records it as an event
  applyAction(room.gameState, { type: 'FORFEIT' }, playerId);

  // Mark slot as gone
  const player = room.players.find(p => p.id === playerId);
  if (player) player.status = 'FORFEITED';
  store.setRoom(room.id, room);

  broadcast.broadcastToRoom(room.id, {
    type:     'PLAYER_FORFEITED',
    playerId,
    reason:   'disconnection_timeout',
  });
}

// ── Reconnect handling ────────────────────────────────────────────────────────

/**
 * Called when a player presents a session token on a new connection.
 *
 * Returns { success, error, room, missedEvents }
 *   success      — whether reconnect was accepted
 *   error        — human-readable reason if rejected
 *   room         — the room object if accepted (for broadcasting GAME_START etc.)
 *   missedEvents — array of events since lastAckSeq (client replays these)
 */
function handleReconnect(playerId, sessionToken, ws) {
  // Validate session
  const session = store.getSession(sessionToken);
  if (!session || session.playerId !== playerId) {
    return { success: false, error: 'Invalid session token' };
  }

  // Find the room this player belongs to
  const room = getRoomForPlayer(playerId);
  if (!room) {
    return { success: false, error: 'No active room for this player' };
  }

  // Find player entry
  const playerEntry = room.players.find(p => p.id === playerId);
  if (!playerEntry) {
    return { success: false, error: 'Player not found in room' };
  }

  if (playerEntry.status === 'FORFEITED') {
    return { success: false, error: 'Grace period expired — game already forfeited' };
  }

  // Cancel the grace period timer
  const timer = graceTimers.get(playerId);
  if (timer) { clearTimeout(timer); graceTimers.delete(playerId); }

  // Re-register the new socket
  broadcast.register(playerId, ws);
  markReconnected(playerId);

  // Gather missed events since the player's last acknowledged seq
  const lastAck      = playerEntry.lastAckSeq ?? 0;
  const missedEvents = store.getEventsSince(room.id, lastAck);
  const snapshot     = store.getLatestSnapshot(room.id);

  console.log(`[Reconnect] Player ${playerId} reconnected — ${missedEvents.length} missed events since seq ${lastAck}`);

  // Send the reconnect payload directly on the new socket
  // We use broadcastToPlayer so it goes through the normal send path
  broadcast.broadcastToPlayer(room.id, playerId, {
    type:         'RECONNECT_ACK',
    roomId:       room.id,
    currentSeq:   store.getSeq(room.id),
    snapshot:     snapshot?.fullState ?? room.gameState,  // full current state
    missedEvents,                                          // ordered gap fill
    players:      room.players,
  });

  broadcast.broadcastToRoom(room.id, {
    type:     'PLAYER_RECONNECTED',
    playerId,
  });

  return { success: true, room, missedEvents };
}

// ── Session management (lives here because it is reconnect-adjacent) ──────────

function createSession(playerId) {
  const { randomUUID: uuidv4 } = require('crypto');
  const token = uuidv4();
  store.setSession(token, { playerId, createdAt: Date.now() });
  return token;
}

function destroySession(token) {
  store.deleteSession(token);
}

module.exports = {
  handleDisconnect,
  handleReconnect,
  createSession,
  destroySession,
  GRACE_PERIOD_MS,
};
