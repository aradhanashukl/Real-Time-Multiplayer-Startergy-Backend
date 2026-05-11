'use strict';

const { computeDelta } = require('../src/reconciliation');
const { applyAction }  = require('../src/room');

// ── Helper builders ───────────────────────────────────────────────────────────

function makeGameState() {
  return {
    tick:   0,
    turn:   1,
    winner: null,
    events: [],
    board: Array.from({ length: 10 }, () => Array(10).fill(0)),
    units: {
      p1: { position: [0, 0], health: 100, ap: 3 },
      p2: { position: [9, 9], health: 100, ap: 3 },
    },
  };
}

// ── applyAction (room module) ─────────────────────────────────────────────────

describe('Room: applyAction MOVE', () => {
  it('moves unit to target position', () => {
    const gs = makeGameState();
    applyAction(gs, { type: 'MOVE', payload: { to: [2, 0] } }, 'p1');
    assertEqual(gs.units.p1.position, [2, 0]);
  });

  it('decrements AP by 1 on MOVE', () => {
    const gs = makeGameState();
    applyAction(gs, { type: 'MOVE', payload: { to: [1, 0] } }, 'p1');
    assertEqual(gs.units.p1.ap, 2);
  });

  it('returns a MOVED event descriptor', () => {
    const gs    = makeGameState();
    const event = applyAction(gs, { type: 'MOVE', payload: { to: [3, 0] } }, 'p1');
    assertEqual(event.type, 'MOVED');
    assertEqual(event.playerId, 'p1');
    assertEqual(event.from, [0, 0]);
    assertEqual(event.to, [3, 0]);
  });
});

describe('Room: applyAction ATTACK', () => {
  function adjacentRoom() {
    const gs = makeGameState();
    gs.units.p2.position = [1, 0]; // adjacent to p1
    return gs;
  }

  it('reduces target health by ATTACK_DAMAGE (25)', () => {
    const gs = adjacentRoom();
    applyAction(gs, { type: 'ATTACK', payload: { targetPlayerId: 'p2' } }, 'p1');
    assertEqual(gs.units.p2.health, 75);
  });

  it('decrements attacker AP by 2', () => {
    const gs = adjacentRoom();
    applyAction(gs, { type: 'ATTACK', payload: { targetPlayerId: 'p2' } }, 'p1');
    assertEqual(gs.units.p1.ap, 1);
  });

  it('does not reduce health below 0', () => {
    const gs = adjacentRoom();
    gs.units.p2.health = 10;
    applyAction(gs, { type: 'ATTACK', payload: { targetPlayerId: 'p2' } }, 'p1');
    assertEqual(gs.units.p2.health, 0);
  });

  it('sets killed flag when target dies', () => {
    const gs = adjacentRoom();
    gs.units.p2.health = 10;
    const event = applyAction(gs, { type: 'ATTACK', payload: { targetPlayerId: 'p2' } }, 'p1');
    assertTrue(event.killed);
  });

  it('returns an ATTACKED event descriptor', () => {
    const gs    = adjacentRoom();
    const event = applyAction(gs, { type: 'ATTACK', payload: { targetPlayerId: 'p2' } }, 'p1');
    assertEqual(event.type, 'ATTACKED');
    assertEqual(event.attackerId, 'p1');
    assertEqual(event.targetId, 'p2');
  });
});

describe('Room: applyAction FORFEIT', () => {
  it('sets forfeited player health to 0', () => {
    const gs = makeGameState();
    applyAction(gs, { type: 'FORFEIT' }, 'p1');
    assertEqual(gs.units.p1.health, 0);
  });

  it('returns FORFEITED event', () => {
    const gs    = makeGameState();
    const event = applyAction(gs, { type: 'FORFEIT' }, 'p1');
    assertEqual(event.type, 'FORFEITED');
  });
});

// ── Tick-ordering simulation ──────────────────────────────────────────────────

describe('GameLoop: deterministic action ordering', () => {
  /**
   * This test simulates the sort the game loop applies to a tick's action queue.
   * Two actions arrive "simultaneously" (same receivedAt). The one whose
   * playerId comes first alphabetically wins the tiebreak.
   *
   * WHAT WE'RE VERIFYING:
   * Given the same inputs, the sort always produces the same order.
   * This is the foundation of determinism — replays produce identical state.
   */
  it('sorts simultaneous actions by playerId tiebreaker', () => {
    const t = Date.now();
    const queue = [
      { action: { type: 'MOVE', payload: { to: [1,0] } }, playerId: 'zara', receivedAt: t },
      { action: { type: 'MOVE', payload: { to: [1,0] } }, playerId: 'alice', receivedAt: t },
      { action: { type: 'MOVE', payload: { to: [1,0] } }, playerId: 'mike', receivedAt: t },
    ];

    queue.sort((a, b) =>
      a.receivedAt !== b.receivedAt
        ? a.receivedAt - b.receivedAt
        : a.playerId.localeCompare(b.playerId)
    );

    assertEqual(queue[0].playerId, 'alice');
    assertEqual(queue[1].playerId, 'mike');
    assertEqual(queue[2].playerId, 'zara');
  });

  it('sorts by receivedAt when timestamps differ', () => {
    const queue = [
      { playerId: 'p1', receivedAt: 1000 },
      { playerId: 'p2', receivedAt: 500  },
      { playerId: 'p3', receivedAt: 750  },
    ];
    queue.sort((a, b) => a.receivedAt - b.receivedAt);
    assertEqual(queue[0].playerId, 'p2');
    assertEqual(queue[1].playerId, 'p3');
    assertEqual(queue[2].playerId, 'p1');
  });
});

describe('GameLoop: state delta pipeline', () => {
  it('produces correct delta after MOVE', () => {
    const prev = makeGameState();
    const next  = JSON.parse(JSON.stringify(prev)); // deep clone
    next.tick = 1;
    applyAction(next, { type: 'MOVE', payload: { to: [2, 1] } }, 'p1');

    const delta = computeDelta(prev, next);
    assertEqual(delta.tick, 1);
    assertEqual(delta.units?.p1?.position, [2, 1]);
    assertTrue(delta.units?.p2 === undefined, 'p2 should not appear in delta');
  });

  it('produces correct delta after ATTACK', () => {
    const prev = makeGameState();
    prev.units.p2.position = [1, 0];
    const next = JSON.parse(JSON.stringify(prev));
    next.tick = 1;
    applyAction(next, { type: 'ATTACK', payload: { targetPlayerId: 'p2' } }, 'p1');

    const delta = computeDelta(prev, next);
    assertEqual(delta.units?.p2?.health, 75);
    assertEqual(delta.units?.p1?.ap,     1);
  });
});
