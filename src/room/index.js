/**
 * room/index.js
 *
 * SINGLE RESPONSIBILITY: mutate authoritative game state.
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE GAME LOOP
 * ──────────────────────────────────────────────────
 * The game loop orchestrates WHEN actions run (tick ordering, queuing, broadcasting).
 * This module knows HOW each action changes state (domain logic).
 * Separating them means you can unit-test state mutations without spinning up
 * a tick loop, and you can swap the game loop (e.g. deterministic lockstep for
 * replays) without touching the mutation logic.
 *
 * PURE FUNCTIONS ONLY
 * ───────────────────
 * Every exported function takes gameState + inputs and returns a result object.
 * No external I/O, no store calls, no WS sends.
 * This makes the module trivially testable and deterministic.
 *
 * WHAT applyAction DOES NOT DO
 * ─────────────────────────────
 * It does not validate (that is anticheat's job).
 * It does not broadcast (that is broadcast's job).
 * It does not sequence (that is the game loop's job).
 * It only mutates and returns a description of what changed.
 */

const ATTACK_DAMAGE = 25; // HP removed per attack
const AP_PER_TURN   = 3;  // Action points restored at turn start

/**
 * Apply a pre-validated action to the game state in-place.
 * Returns an event descriptor that is pushed into gameState.events[].
 *
 * WHY IN-PLACE MUTATION INSTEAD OF RETURNING A NEW STATE
 * Immutable updates (return newState) are elegant and make time-travel
 * debugging trivial (React / Redux style). However, they require cloning
 * the full state object on every action, which at 20 ticks/sec with 10
 * concurrent rooms costs real CPU. We deep-clone once per tick (in the
 * game loop) to compute deltas; within a tick we mutate directly.
 */
function applyAction(gameState, action, playerId) {
  switch (action.type) {
    case 'MOVE':    return applyMove(gameState, action, playerId);
    case 'ATTACK':  return applyAttack(gameState, action, playerId);
    case 'PASS':    return applyPass(gameState, playerId);
    case 'FORFEIT': return applyForfeit(gameState, playerId);
    default:        return { type: 'NOOP', playerId };
  }
}

function applyMove(gameState, action, playerId) {
  const unit = gameState.units[playerId];
  const prev = [...unit.position];
  unit.position = action.payload.to;
  unit.ap -= 1;

  return {
    type:     'MOVED',
    playerId,
    from:     prev,
    to:       action.payload.to,
    apLeft:   unit.ap,
  };
}

function applyAttack(gameState, action, playerId) {
  const attacker = gameState.units[playerId];
  const target   = gameState.units[action.payload.targetPlayerId];
  const prevHp   = target.health;

  target.health = Math.max(0, target.health - ATTACK_DAMAGE);
  attacker.ap  -= 2;

  return {
    type:       'ATTACKED',
    attackerId: playerId,
    targetId:   action.payload.targetPlayerId,
    damage:     ATTACK_DAMAGE,
    prevHp,
    newHp:      target.health,
    killed:     target.health === 0,
    apLeft:     attacker.ap,
  };
}

function applyPass(gameState, playerId) {
  // Passing ends this player's sub-turn; AP resets next turn.
  return { type: 'PASSED', playerId };
}

function applyForfeit(gameState, playerId) {
  const unit = gameState.units[playerId];
  if (unit) unit.health = 0; // Remove from board
  return { type: 'FORFEITED', playerId };
}

/**
 * Called by the game loop at the start of each turn (when applicable).
 * Restores every living unit's AP to the per-turn maximum.
 *
 * WHY AP RESETS HAPPEN HERE, NOT IN THE GAME LOOP
 * AP reset is domain logic — it could change (e.g., a buff that gives +1 AP).
 * The game loop has no business knowing what AP is. It just calls this.
 */
function resetTurnAP(gameState) {
  for (const unit of Object.values(gameState.units)) {
    if (unit.health > 0) unit.ap = AP_PER_TURN;
  }
  gameState.turn++;
}

/**
 * Returns an array of playerIds whose units are still alive.
 */
function getLivingPlayers(gameState) {
  return Object.entries(gameState.units)
    .filter(([, u]) => u.health > 0)
    .map(([id]) => id);
}

module.exports = { applyAction, resetTurnAP, getLivingPlayers };
