/**
 * reconciliation/index.js
 *
 * TWO JOBS
 * ────────
 * 1. computeDelta   — diff prev state vs next state → minimal patch
 * 2. needsCorrection — decide if a specific player's optimistic state has diverged
 *
 * WHY SEND DELTAS INSTEAD OF FULL STATE
 * ────────────────────────────────────────────────────────────────────────────
 * Full state at 20 ticks/sec × 4 players: each tick sends ~2 KB × 4 = 8 KB.
 * At 20 ticks/sec that is 160 KB/sec per room. With 100 rooms: 16 MB/sec.
 * A 50-byte delta (only what changed) reduces that by ~97 %.
 *
 * For a competitive game, bandwidth is a first-class constraint.
 * Clients reconstruct their local state by merging deltas onto a base snapshot.
 *
 * THE OPTIMISTIC UPDATE PROBLEM
 * ──────────────────────────────
 * When a player clicks "move," their client immediately shows the movement
 * (optimistic update) without waiting for server confirmation. This feels instant.
 *
 * Problem: while that move is in-flight, the server may have applied other
 * actions that make the optimistic state wrong. Example:
 *   t=0  Player moves unit to [3,5] (optimistic local state shows this)
 *   t=0  Another player attacks [3,5] (server processes this first)
 *   t=50 Server tick: attack kills unit → MOVE is now invalid
 *   t=55 Server sends STATE_UPDATE with seq=N
 *   t=55 Client sees correction flag → rolls back to server state
 *
 * Without reconciliation, the client and server permanently diverge.
 *
 * WHAT RECONCILIATION IS NOT
 * ───────────────────────────
 * It is not lag compensation (rewinding server state to what the player saw).
 * It is not prediction (extrapolating physics forward between ticks).
 * Those are rendering-layer concerns. This module only produces the patch.
 */

/**
 * Produce a minimal delta between two game states.
 *
 * Returns an object with ONLY the fields that changed.
 * Unchanged fields are omitted entirely.
 *
 * WHY NOT JSON PATCH (RFC 6902)
 * JSON Patch is thorough but verbose and requires a library.
 * Our state shape is known and finite; a hand-written differ is ~50 lines,
 * fast, and produces smaller output with domain-aware grouping.
 */
function computeDelta(prev, next) {
  const delta = {};

  // ── Tick / turn ───────────────────────────────────────────────────────────
  if (prev.tick !== next.tick) delta.tick = next.tick;
  if (prev.turn !== next.turn) delta.turn = next.turn;

  // ── Units — only the players whose unit state changed ────────────────────
  const unitDelta = {};
  const allPlayerIds = new Set([
    ...Object.keys(prev.units ?? {}),
    ...Object.keys(next.units ?? {}),
  ]);

  for (const pid of allPlayerIds) {
    const p = prev.units?.[pid];
    const n = next.units?.[pid];

    if (!p && n) { unitDelta[pid] = { ...n };  continue; } // unit appeared
    if (p && !n) { unitDelta[pid] = null;       continue; } // unit removed

    const diff = {};
    if (!arrEq(p.position, n.position)) diff.position = n.position;
    if (p.health !== n.health)           diff.health   = n.health;
    if (p.ap     !== n.ap)               diff.ap       = n.ap;
    if (Object.keys(diff).length)       unitDelta[pid] = diff;
  }

  if (Object.keys(unitDelta).length) delta.units = unitDelta;

  // ── Events — always include if non-empty (ephemeral per-tick data) ────────
  if (next.events?.length) delta.events = next.events;

  // ── Winner ────────────────────────────────────────────────────────────────
  if (prev.winner !== next.winner) delta.winner = next.winner;

  return delta;
}

/**
 * Merge an incoming delta onto a client-side state snapshot.
 * Clients call this function on every STATE_UPDATE to advance their local copy.
 *
 * WHY THIS LIVES ON THE SERVER MODULE
 * It also runs in the client-demo/simulate.js. Having one canonical merge
 * function guarantees the client and server interpret deltas identically.
 */
function applyDelta(state, delta) {
  if (!delta || typeof delta !== 'object') return state;

  const next = { ...state };

  if (delta.tick  !== undefined) next.tick  = delta.tick;
  if (delta.turn  !== undefined) next.turn  = delta.turn;
  if (delta.winner !== undefined) next.winner = delta.winner;

  if (delta.events) next.events = delta.events;

  if (delta.units) {
    next.units = { ...state.units };
    for (const [pid, unitDelta] of Object.entries(delta.units)) {
      if (unitDelta === null) {
        delete next.units[pid];
      } else if (!next.units[pid]) {
        next.units[pid] = { ...unitDelta };
      } else {
        next.units[pid] = { ...next.units[pid], ...unitDelta };
      }
    }
  }

  return next;
}

/**
 * Check whether a player's last acknowledged sequence number is behind the
 * current server sequence. If so, their optimistic state may have diverged
 * and we should set the correction flag in the broadcast.
 *
 * A correction flag tells the client: "discard your optimistic updates and
 * accept the server delta as the new ground truth."
 */
function needsCorrection(player, currentSeq) {
  // If the player has not acknowledged the previous tick's state, they are
  // behind. Their optimistic update may now conflict with server reality.
  return player.lastAckSeq < currentSeq - 1;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function arrEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

module.exports = { computeDelta, applyDelta, needsCorrection };
