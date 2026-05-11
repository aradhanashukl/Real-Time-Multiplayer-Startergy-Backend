'use strict';

const { validateAction, checkRateLimit } = require('../src/anticheat');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRoom(overrides = {}) {
  return {
    id: 'room-1',
    players: [
      { id: 'p1', status: 'CONNECTED' },
      { id: 'p2', status: 'CONNECTED' },
    ],
    gameState: {
      board: [
        [0, 0, 0, 0, 0],
        [0, 1, 0, 0, 0],  // row 1 col 1 is obstacle
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
      ],
      units: {
        p1: { position: [0, 0], health: 100, ap: 3 },
        p2: { position: [4, 4], health: 100, ap: 3 },
      },
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Anti-cheat: MOVE validation', () => {
  it('allows a valid move within range', () => {
    const result = validateAction(
      { type: 'MOVE', payload: { to: [2, 0] } },
      makeRoom(), 'p1'
    );
    assertTrue(result.valid, result.reason);
  });

  it('rejects move to an obstacle cell', () => {
    const result = validateAction(
      { type: 'MOVE', payload: { to: [1, 1] } },
      makeRoom(), 'p1'
    );
    assertFalse(result.valid);
    assertTrue(result.reason.includes('obstacle'));
  });

  it('rejects move beyond max range (>3 Chebyshev)', () => {
    // p1 is at [0,0]; target [4,0] is distance 4 — beyond max range 3
    // p2 is at [4,4] so [4,0] is unoccupied
    const result = validateAction(
      { type: 'MOVE', payload: { to: [4, 0] } },
      makeRoom(), 'p1'
    );
    assertFalse(result.valid);
    assertTrue(result.reason.includes('range'));
  });

  it('rejects move to out-of-bounds position', () => {
    const result = validateAction(
      { type: 'MOVE', payload: { to: [99, 99] } },
      makeRoom(), 'p1'
    );
    assertFalse(result.valid);
    assertTrue(result.reason.includes('bounds'));
  });

  it('rejects move to occupied cell', () => {
    const room = makeRoom();
    room.gameState.units.p2.position = [2, 0]; // p2 stands on target
    const result = validateAction(
      { type: 'MOVE', payload: { to: [2, 0] } },
      room, 'p1'
    );
    assertFalse(result.valid);
    assertTrue(result.reason.includes('occupied'));
  });

  it('rejects move when player has 0 AP', () => {
    const room = makeRoom();
    room.gameState.units.p1.ap = 0;
    const result = validateAction(
      { type: 'MOVE', payload: { to: [1, 0] } },
      room, 'p1'
    );
    assertFalse(result.valid);
    assertTrue(result.reason.includes('AP'));
  });
});

describe('Anti-cheat: ATTACK validation', () => {
  it('allows attack on adjacent enemy', () => {
    const room = makeRoom();
    room.gameState.units.p2.position = [1, 0]; // adjacent to p1 at [0,0]
    const result = validateAction(
      { type: 'ATTACK', payload: { targetPlayerId: 'p2' } },
      room, 'p1'
    );
    assertTrue(result.valid, result.reason);
  });

  it('rejects attack on non-adjacent enemy', () => {
    const result = validateAction(
      { type: 'ATTACK', payload: { targetPlayerId: 'p2' } },
      makeRoom(), 'p1'
    );
    assertFalse(result.valid);
    assertTrue(result.reason.includes('away'));
  });

  it('rejects self-attack', () => {
    const result = validateAction(
      { type: 'ATTACK', payload: { targetPlayerId: 'p1' } },
      makeRoom(), 'p1'
    );
    assertFalse(result.valid);
    assertTrue(result.reason.includes('yourself'));
  });

  it('rejects attack on dead unit', () => {
    const room = makeRoom();
    room.gameState.units.p2.health   = 0;
    room.gameState.units.p2.position = [1, 0];
    const result = validateAction(
      { type: 'ATTACK', payload: { targetPlayerId: 'p2' } },
      room, 'p1'
    );
    assertFalse(result.valid);
    assertTrue(result.reason.includes('living unit'));
  });
});

describe('Anti-cheat: general rules', () => {
  it('rejects action from disconnected player', () => {
    const room = makeRoom();
    room.players[0].status = 'DISCONNECTED';
    const result = validateAction(
      { type: 'PASS' },
      room, 'p1'
    );
    assertFalse(result.valid);
    assertTrue(result.reason.includes('not active'));
  });

  it('rejects unknown action type', () => {
    const result = validateAction(
      { type: 'TELEPORT' },
      makeRoom(), 'p1'
    );
    assertFalse(result.valid);
    assertTrue(result.reason.includes('Unknown'));
  });

  it('allows PASS with 0 AP', () => {
    const room = makeRoom();
    room.gameState.units.p1.ap = 0;
    const result = validateAction({ type: 'PASS' }, room, 'p1');
    assertTrue(result.valid, result.reason);
  });
});

describe('Anti-cheat: rate limiting', () => {
  it('allows actions within the rate limit', () => {
    const roomId = 'rl-room-1';
    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit(roomId, 'rl-player-1');
      assertTrue(result.valid, `Action ${i + 1} should be allowed`);
    }
  });

  it('blocks when rate limit is exceeded', () => {
    const roomId = 'rl-room-2';
    // Exhaust limit (10 actions/sec)
    for (let i = 0; i < 10; i++) checkRateLimit(roomId, 'rl-player-2');
    const result = checkRateLimit(roomId, 'rl-player-2');
    assertFalse(result.valid);
    assertTrue(result.reason.includes('Rate limit'));
  });
});
