/**
 * gameloop/index.js
 *
 * THE AUTHORITATIVE GAME LOOP — the most important file in this project.
 *
 * ON EVERY TICK (every 50 ms):
 *   1. Drain the action queue for each active room
 *   2. Sort by server-assigned logical timestamp (deterministic ordering)
 *   3. Rate-limit check → anti-cheat validation → apply to authoritative state
 *   4. Compute state delta
 *   5. Stamp with sequence number
 *   6. Log snapshot for reconnect replay
 *   7. Broadcast delta to all connected players
 *   8. Check win condition
 *
 * WHY FIXED TICK RATE INSTEAD OF PROCESS-ON-RECEIPT
 * ───────────────────────────────────────────────────
 * Process-on-receipt (reactive): action arrives → apply immediately.
 * Problem: two players send at the same millisecond. Server processes
 * whichever packet arrived first (network jitter, not action intent).
 * Result: non-deterministic, unfair ordering.
 *
 * Fixed tick: all actions arriving between tick N and tick N+1 are batched.
 * Within the batch we apply a deterministic sort. Every server — and every
 * replay — produces identical state given the same inputs.
 *
 * WHY 50 ms (20 ticks/sec)
 * ─────────────────────────
 * Players perceive confirmation within 25–75 ms on average — fine for
 * turn-based strategy and real-time strategy. First-person shooters use
 * 128 ticks (7.8 ms) at significantly higher CPU/bandwidth cost.
 * Tick rate is a product decision; TICK_RATE_MS is the only knob.
 *
 * WHY THE QUEUE LIVES IN THIS MODULE, NOT IN THE ROOM/STORE
 * The queue is high-frequency, volatile, in-process data. Putting it in the
 * store would require serialising and deserialising on every enqueue. In a
 * Redis-backed store that would be catastrophically slow. The queue stays
 * in-process; only the committed state goes to the store.
 */

const store                        = require('../store');
const { validateAction, checkRateLimit } = require('../anticheat');
const { applyAction, getLivingPlayers }  = require('../room');
const { computeDelta }             = require('../reconciliation');
const broadcast                    = require('../broadcast');
const { ROOM_STATUS }              = require('../matchmaking');

const TICK_RATE_MS = 50; // 20 ticks / sec

// roomId → Array<{ action, playerId, receivedAt }>
// Populated by enqueueAction(); drained on every tick.
const actionQueues = new Map();

let intervalHandle = null;
let running        = false;

// ── Public API ────────────────────────────────────────────────────────────────

function start() {
  if (running) return;
  running = true;
  intervalHandle = setInterval(tick, TICK_RATE_MS);
  console.log(`[GameLoop] Running at ${1000 / TICK_RATE_MS} ticks/sec`);
}

function stop() {
  clearInterval(intervalHandle);
  running = false;
  console.log('[GameLoop] Stopped');
}

/**
 * Called by the WS message handler — the ONLY external input to the game loop.
 *
 * WHY WE RECORD receivedAt HERE (server wall-clock)
 * The client also sends a clientTimestamp but that clock is untrustworthy
 * (a cheating client could backdate it to claim priority). receivedAt is
 * assigned by the server at the instant the message arrives — tamper-proof.
 * We use it as the primary sort key inside a tick.
 */
function enqueueAction(roomId, playerId, action) {
  if (!actionQueues.has(roomId)) actionQueues.set(roomId, []);
  actionQueues.get(roomId).push({ action, playerId, receivedAt: Date.now() });
}

// ── Core tick ─────────────────────────────────────────────────────────────────

function tick() {
  for (const room of store.getAllRooms()) {
    if (room.status === ROOM_STATUS.ACTIVE) tickRoom(room);
  }
}

function tickRoom(room) {
  const roomId = room.id;
  const queue  = drainQueue(roomId);

  // Advance tick counter
  room.gameState.tick++;

  // Clear ephemeral per-tick events
  room.gameState.events = [];

  // Deep-clone BEFORE mutations so computeDelta can compare
  //
  // WHY deepClone ONCE HERE INSTEAD OF IMMUTABLE UPDATES
  // Immutable style (return new state) requires cloning the full state on
  // every single action application — O(actions × stateSize) per tick.
  // Cloning once before the batch, then mutating in-place, is O(stateSize)
  // regardless of how many actions are in the queue.
  const prevState = deepClone(room.gameState);

  // Sort queue: primary = server receivedAt, secondary = playerId (alpha tiebreaker)
  // Both sort keys are server-assigned or deterministic — clients cannot influence them.
  queue.sort((a, b) =>
    a.receivedAt !== b.receivedAt
      ? a.receivedAt - b.receivedAt
      : a.playerId.localeCompare(b.playerId)
  );

  // Validate and apply
  for (const item of queue) {
    processAction(room, item);
  }

  // Persist mutated state
  store.setRoom(roomId, room);

  // Compute minimal delta
  const delta = computeDelta(prevState, room.gameState);

  // Assign sequence number (monotonic, server-controlled)
  const seq = store.nextSeq(roomId);

  // Log for reconnect replay
  store.appendEventLog(roomId, {
    seq,
    tick:      room.gameState.tick,
    delta,
    fullState: deepClone(room.gameState),
    timestamp: Date.now(),
  });

  // Broadcast
  broadcast.broadcastToRoom(roomId, {
    type:  'STATE_UPDATE',
    seq,
    tick:  room.gameState.tick,
    delta,
    // `correction` flag is added per-player inside broadcastToRoom
  });

  // Win condition
  checkWinCondition(room, seq);
}

// ── Action processing ─────────────────────────────────────────────────────────

function processAction(room, { action, playerId }) {
  // 1. Rate limit (cheap O(1) check first)
  const rl = checkRateLimit(room.id, playerId);
  if (!rl.valid) {
    rejectAsync(room.id, playerId, action, rl.reason);
    return;
  }

  // 2. Anti-cheat (validates against authoritative state)
  const av = validateAction(action, room, playerId);
  if (!av.valid) {
    console.warn(`[GameLoop] Reject ${action.type} from ${playerId}: ${av.reason}`);
    rejectAsync(room.id, playerId, action, av.reason);
    return;
  }

  // 3. Apply mutation
  const event = applyAction(room.gameState, action, playerId);
  room.gameState.events.push({ playerId, action, result: event, ts: Date.now() });
  console.log(`[GameLoop] Tick ${room.gameState.tick}: ${action.type} from ${playerId}`);
}

/**
 * Schedule a rejection message AFTER the current tick completes.
 *
 * WHY setImmediate
 * We are inside the synchronous tick loop. Sending a WS frame right now is
 * fine (Node's WS send is async under the hood) but conceptually the tick
 * is still "in flight." Using setImmediate defers until after the tick's
 * state is fully committed, keeping cause-before-effect ordering visible.
 */
function rejectAsync(roomId, playerId, action, reason) {
  setImmediate(() => {
    broadcast.broadcastToPlayer(roomId, playerId, {
      type:   'ACTION_REJECTED',
      action,
      reason,
      // Client rolls back the corresponding optimistic update on receipt
    });
  });
}

// ── Win condition ─────────────────────────────────────────────────────────────

function checkWinCondition(room, seq) {
  if (room.status !== ROOM_STATUS.ACTIVE) return;

  const living = getLivingPlayers(room.gameState);

  if (living.length <= 1) {
    const winner = living[0] ?? 'DRAW';
    room.gameState.winner = winner;
    room.status = ROOM_STATUS.FINISHED;
    store.setRoom(room.id, room);

    broadcast.broadcastToRoom(room.id, { type: 'GAME_OVER', seq, winner });
    console.log(`[GameLoop] Room ${room.id} finished. Winner: ${winner}`);
  }
}

// ── Queue drain ───────────────────────────────────────────────────────────────

/**
 * Atomically remove and return all queued actions for a room.
 *
 * WHY DRAIN (swap with empty array) INSTEAD OF ITERATING IN-PLACE
 * If we iterated the existing array, WS handlers could push new actions
 * mid-iteration — those actions would be included in the current tick
 * (non-deterministic). Swapping guarantees we process only what was queued
 * at the START of this tick. New arrivals go into the fresh empty array and
 * appear in the NEXT tick.
 */
function drainQueue(roomId) {
  const q = actionQueues.get(roomId) ?? [];
  actionQueues.set(roomId, []);
  return q;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * WHY NOT JSON.parse(JSON.stringify()) IN PRODUCTION
 * It is fast for plain JSON-serialisable objects (which game state is).
 * But it drops undefined values and Date objects. For our state shape it is
 * safe. Node 17+ has structuredClone() which is faster and handles Date/Map/Set.
 * We use JSON clone to keep the Node ≥ 18 requirement free of surprises.
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = { start, stop, enqueueAction, TICK_RATE_MS };
