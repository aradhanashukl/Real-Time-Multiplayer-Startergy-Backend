'use strict';

const { computeDelta, applyDelta, needsCorrection } = require('../src/reconciliation');

function baseState() {
  return {
    tick:   1,
    turn:   1,
    winner: null,
    events: [],
    board:  [],
    units: {
      p1: { position: [0, 0], health: 100, ap: 3 },
      p2: { position: [9, 9], health: 100, ap: 3 },
    },
  };
}

describe('Reconciliation: computeDelta', () => {
  it('returns empty delta when nothing changed', () => {
    const s = baseState();
    const delta = computeDelta(s, { ...s }); // same state
    // Only events would appear (empty array is falsy — excluded)
    assertTrue(
      !delta.units && !delta.tick && !delta.winner,
      'Delta should be empty for identical states'
    );
  });

  it('detects tick change', () => {
    const prev = baseState();
    const next  = { ...baseState(), tick: 2 };
    const delta = computeDelta(prev, next);
    assertEqual(delta.tick, 2);
  });

  it('detects unit position change', () => {
    const prev = baseState();
    const next  = baseState();
    next.units.p1.position = [2, 3];
    const delta = computeDelta(prev, next);
    assertEqual(delta.units?.p1?.position, [2, 3]);
  });

  it('does NOT include unchanged unit fields', () => {
    const prev = baseState();
    const next  = baseState();
    next.units.p1.position = [1, 0]; // only position changed
    const delta = computeDelta(prev, next);
    assertTrue(delta.units?.p1?.health === undefined, 'health should not appear in delta');
    assertTrue(delta.units?.p1?.ap     === undefined, 'ap should not appear in delta');
  });

  it('detects unit health change', () => {
    const prev = baseState();
    const next  = baseState();
    next.units.p2.health = 75;
    const delta = computeDelta(prev, next);
    assertEqual(delta.units?.p2?.health, 75);
  });

  it('detects new unit appearance', () => {
    const prev = baseState();
    const next  = baseState();
    next.units.p3 = { position: [5, 5], health: 100, ap: 3 };
    const delta = computeDelta(prev, next);
    assertTrue(delta.units?.p3 !== undefined, 'New unit should appear in delta');
  });

  it('detects unit removal', () => {
    const prev = baseState();
    const next  = baseState();
    delete next.units.p2;
    const delta = computeDelta(prev, next);
    assertEqual(delta.units?.p2, null);
  });

  it('detects winner change', () => {
    const prev = baseState();
    const next  = { ...baseState(), winner: 'p1' };
    const delta = computeDelta(prev, next);
    assertEqual(delta.winner, 'p1');
  });

  it('includes events when present', () => {
    const prev = baseState();
    const next  = { ...baseState(), events: [{ type: 'MOVED', playerId: 'p1' }] };
    const delta = computeDelta(prev, next);
    assertEqual(delta.events?.length, 1);
  });
});

describe('Reconciliation: applyDelta', () => {
  it('applies position delta correctly', () => {
    const state = baseState();
    const delta = { units: { p1: { position: [3, 4] } } };
    const next  = applyDelta(state, delta);
    assertEqual(next.units.p1.position, [3, 4]);
  });

  it('preserves unchanged fields after merge', () => {
    const state = baseState();
    const delta = { units: { p1: { ap: 2 } } };
    const next  = applyDelta(state, delta);
    assertEqual(next.units.p1.health, 100, 'health should be preserved');
    assertEqual(next.units.p1.ap,     2,   'ap should be updated');
  });

  it('removes unit when delta entry is null', () => {
    const state = baseState();
    const delta = { units: { p2: null } };
    const next  = applyDelta(state, delta);
    assertTrue(next.units.p2 === undefined, 'p2 should be removed');
  });

  it('adds new unit from delta', () => {
    const state = baseState();
    const delta = { units: { p3: { position: [5,5], health: 100, ap: 3 } } };
    const next  = applyDelta(state, delta);
    assertEqual(next.units.p3.position, [5, 5]);
  });

  it('applies tick and winner from delta', () => {
    const state = baseState();
    const next  = applyDelta(state, { tick: 42, winner: 'p1' });
    assertEqual(next.tick,   42);
    assertEqual(next.winner, 'p1');
  });

  it('does not mutate the original state', () => {
    const state = baseState();
    applyDelta(state, { units: { p1: { position: [9, 9] } } });
    assertEqual(state.units.p1.position, [0, 0], 'original should be untouched');
  });
});

describe('Reconciliation: needsCorrection', () => {
  it('returns false when player is up to date', () => {
    const player = { lastAckSeq: 9 };
    assertFalse(needsCorrection(player, 10));
  });

  it('returns true when player is behind by more than 1', () => {
    const player = { lastAckSeq: 5 };
    assertTrue(needsCorrection(player, 10));
  });

  it('returns false when player acked the previous tick', () => {
    const player = { lastAckSeq: 9 };
    assertFalse(needsCorrection(player, 10)); // behind by 1 — not a correction
  });
});
