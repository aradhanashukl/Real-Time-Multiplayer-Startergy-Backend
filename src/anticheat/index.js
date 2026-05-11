/**
 * anticheat/index.js
 *
 * CORE PRINCIPLE
 * ──────────────
 * The client sends INTENT ("I want to move to [3,5]").
 * The server independently re-evaluates that intent against the
 * AUTHORITATIVE STATE before allowing any mutation.
 *
 * A modified client can send any message it likes. It cannot corrupt the
 * authoritative state because:
 *   1. The server holds the only real state.
 *   2. Every action is re-checked against that state.
 *   3. The client's local state is always provisional — never authoritative.
 *
 * WHY CLIENT-SIDE VALIDATION IS NOT ENOUGH
 * Client validation is UX (fast feedback for the honest player).
 * Server validation is security. You need both; only doing one is a bug.
 *
 * WHAT WE DO NOT DO HERE (add for production)
 * ─────────────────────────────────────────────
 * • Statistical anomaly detection — unit moving faster than physics allow
 * • Replay analysis — flag accounts with suspiciously perfect aim
 * • HMAC action signatures — action signed with server-issued nonce prevents replay attacks
 * • Temporal validation — clientTimestamp vs serverTimestamp gap > threshold → suspicious
 */

const MAX_MOVE_RANGE = 3;   // Chebyshev distance
const MOVE_AP_COST   = 1;
const ATTACK_AP_COST = 2;

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Returns { valid: boolean, reason: string | null }
 *
 * WHY A RESULT OBJECT INSTEAD OF THROWING
 * Throwing on validation failure treats a common, expected outcome as an
 * exception — wrong semantically and expensive (stack unwinding).
 * A result object makes the failure path a normal branch.
 */
function validateAction(action, room, playerId) {
  // 1. Player must be active in this room
  const playerEntry = room.players.find(
    p => p.id === playerId && p.status === 'CONNECTED'
  );
  if (!playerEntry) return fail('Player not active in this room');

  // 2. Action type must be recognised
  const allowed = ['MOVE', 'ATTACK', 'PASS', 'FORFEIT'];
  if (!allowed.includes(action.type)) return fail(`Unknown action type: ${action.type}`);

  const unit = room.gameState.units[playerId];

  // 3. Player must have a unit (except FORFEIT)
  if (!unit && action.type !== 'FORFEIT') return fail('No unit on board for this player');

  // 4. Unit must be alive
  if (unit && unit.health <= 0) return fail('Unit is dead');

  // 5. Action-specific rules
  switch (action.type) {
    case 'MOVE':    return validateMove(action, room.gameState, playerId, unit);
    case 'ATTACK':  return validateAttack(action, room.gameState, playerId, unit);
    case 'PASS':
    case 'FORFEIT': return ok();
    default:        return fail('Unhandled action type');
  }
}

// ── Move validation ───────────────────────────────────────────────────────────

function validateMove(action, gs, playerId, unit) {
  const { to } = action.payload ?? {};
  if (!Array.isArray(to) || to.length !== 2) return fail('MOVE requires payload.to = [x, y]');

  const [tx, ty] = to;
  const board = gs.board;

  if (ty < 0 || ty >= board.length || tx < 0 || tx >= board[0].length)
    return fail(`[${tx},${ty}] is out of bounds`);

  if (board[ty][tx] === 1)
    return fail(`[${tx},${ty}] is an obstacle`);

  // Another living unit already occupies the target cell
  const occupant = Object.entries(gs.units).find(
    ([pid, u]) => pid !== playerId && u.health > 0 &&
                  u.position[0] === tx && u.position[1] === ty
  );
  if (occupant) return fail(`[${tx},${ty}] is occupied by ${occupant[0]}`);

  // Chebyshev distance — treats diagonal move as distance 1 (like a chess king)
  //
  // WHY CHEBYSHEV OVER EUCLIDEAN OR MANHATTAN
  // Euclidean: diagonal = √2 ≈ 1.41 — awkward integer ranges.
  // Manhattan: no diagonals — overly restrictive for a strategy game.
  // Chebyshev: diagonal = 1 — clean grid semantics, easy to reason about.
  const [fx, fy] = unit.position;
  const dist = Math.max(Math.abs(tx - fx), Math.abs(ty - fy));
  if (dist > MAX_MOVE_RANGE) return fail(`Distance ${dist} exceeds max range ${MAX_MOVE_RANGE}`);

  if (unit.ap < MOVE_AP_COST) return fail(`Need ${MOVE_AP_COST} AP, have ${unit.ap}`);

  return ok();
}

// ── Attack validation ─────────────────────────────────────────────────────────

function validateAttack(action, gs, playerId, unit) {
  const { targetPlayerId } = action.payload ?? {};
  if (!targetPlayerId) return fail('ATTACK requires payload.targetPlayerId');
  if (targetPlayerId === playerId) return fail('Cannot attack yourself');

  const target = gs.units[targetPlayerId];
  if (!target || target.health <= 0) return fail(`Target ${targetPlayerId} has no living unit`);

  const [ax, ay] = unit.position;
  const [tx, ty] = target.position;
  const dist = Math.max(Math.abs(tx - ax), Math.abs(ty - ay));
  if (dist > 1) return fail(`Target is ${dist} squares away (attack range is 1)`);

  if (unit.ap < ATTACK_AP_COST) return fail(`Need ${ATTACK_AP_COST} AP, have ${unit.ap}`);

  return ok();
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
//
// WHY RATE-LIMIT AT THE VALIDATION LAYER NOT THE WS LAYER
// Dropping the WS connection on abuse is harsh and destroys game context.
// Validation-layer rejection refuses bad actions while keeping the player connected.

const actionTimestamps = new Map(); // key: `${roomId}:${playerId}` → number[]
const RATE_WINDOW_MS   = 1000;
const RATE_MAX_ACTIONS = 10;

function checkRateLimit(roomId, playerId) {
  const key  = `${roomId}:${playerId}`;
  const now  = Date.now();
  const prev = (actionTimestamps.get(key) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  if (prev.length >= RATE_MAX_ACTIONS)
    return fail(`Rate limit: ${prev.length} actions in last ${RATE_WINDOW_MS} ms`);
  prev.push(now);
  actionTimestamps.set(key, prev);
  return ok();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok()         { return { valid: true,  reason: null }; }
function fail(reason) { return { valid: false, reason }; }

module.exports = { validateAction, checkRateLimit };
