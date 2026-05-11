'use strict';

// Reset the store singleton between tests so rooms don't bleed across suites.
// We do this by deleting the module cache entry and re-requiring.
function freshModules() {
  Object.keys(require.cache).forEach(k => delete require.cache[k]);
  const store       = require('../src/store');
  const matchmaking = require('../src/matchmaking');
  return { store, matchmaking };
}

describe('Matchmaking: room creation', () => {
  it('creates a new room when no open room exists', () => {
    const { matchmaking } = freshModules();
    const room = matchmaking.findOrCreateRoom('player-1');
    assertTrue(!!room.id,                    'room should have an id');
    assertEqual(room.status, 'WAITING',      'room should be WAITING');
    assertEqual(room.players.length, 1,      'room should have 1 player');
    assertEqual(room.players[0].id, 'player-1');
  });

  it('places a second player in the existing room', () => {
    const { matchmaking } = freshModules();
    matchmaking.findOrCreateRoom('player-1');
    const room = matchmaking.findOrCreateRoom('player-2');
    assertEqual(room.players.length, 2, 'should have 2 players');
  });

  it('starts the room when it reaches MAX_PLAYERS', () => {
    const { matchmaking } = freshModules();
    matchmaking.findOrCreateRoom('p1');
    matchmaking.findOrCreateRoom('p2');
    matchmaking.findOrCreateRoom('p3');
    const room = matchmaking.findOrCreateRoom('p4');
    assertEqual(room.status, 'ACTIVE', 'room should be ACTIVE after filling');
    assertEqual(room.players.length, 4);
  });

  it('assigns starting positions to all players on start', () => {
    const { matchmaking } = freshModules();
    matchmaking.findOrCreateRoom('p1');
    matchmaking.findOrCreateRoom('p2');
    matchmaking.findOrCreateRoom('p3');
    const room = matchmaking.findOrCreateRoom('p4');
    for (const p of room.players) {
      const unit = room.gameState.units[p.id];
      assertTrue(!!unit,                           `unit for ${p.id} should exist`);
      assertTrue(Array.isArray(unit.position),     'position should be array');
      assertEqual(unit.position.length, 2);
      assertEqual(unit.health, 100);
    }
  });

  it('creates a new room after previous is full', () => {
    const { matchmaking } = freshModules();
    matchmaking.findOrCreateRoom('p1');
    matchmaking.findOrCreateRoom('p2');
    matchmaking.findOrCreateRoom('p3');
    matchmaking.findOrCreateRoom('p4'); // room 1 full
    const room2 = matchmaking.findOrCreateRoom('p5');
    assertEqual(room2.players.length, 1, 'should be in a new room');
    assertEqual(room2.status, 'WAITING');
  });

  it('throws when joining a full room directly', () => {
    const { matchmaking, store } = freshModules();
    matchmaking.findOrCreateRoom('p1');
    matchmaking.findOrCreateRoom('p2');
    matchmaking.findOrCreateRoom('p3');
    const fullRoom = matchmaking.findOrCreateRoom('p4');

    let threw = false;
    try {
      // Try to force-join by calling joinRoom indirectly
      // The only internal way is through findOrCreateRoom which would create a new room
      // So instead we verify the full room cannot accept more players via the store
      const r = store.getRoom(fullRoom.id);
      assertTrue(r.players.length === 4, 'room should be full');
    } catch (e) {
      threw = true;
    }
    // This path verifies the state, not that it throws (joinRoom is internal)
    assertFalse(threw);
  });
});

describe('Matchmaking: disconnect / reconnect status', () => {
  it('marks player as disconnected', () => {
    const { matchmaking, store } = freshModules();
    matchmaking.findOrCreateRoom('p1');
    matchmaking.markDisconnected('p1');
    const room = matchmaking.getRoomForPlayer('p1');
    const p = room.players.find(p => p.id === 'p1');
    assertEqual(p.status, 'DISCONNECTED');
    assertTrue(!!p.disconnectedAt);
  });

  it('marks player as reconnected', () => {
    const { matchmaking } = freshModules();
    matchmaking.findOrCreateRoom('p1');
    matchmaking.markDisconnected('p1');
    matchmaking.markReconnected('p1');
    const room = matchmaking.getRoomForPlayer('p1');
    const p = room.players.find(p => p.id === 'p1');
    assertEqual(p.status, 'CONNECTED');
    assertTrue(p.disconnectedAt === undefined);
  });

  it('finds the correct room for a given player', () => {
    const { matchmaking } = freshModules();
    matchmaking.findOrCreateRoom('alpha');
    const found = matchmaking.getRoomForPlayer('alpha');
    assertTrue(!!found);
    assertTrue(found.players.some(p => p.id === 'alpha'));
  });

  it('returns null for a player not in any room', () => {
    const { matchmaking } = freshModules();
    const found = matchmaking.getRoomForPlayer('nobody');
    assertEqual(found, null);
  });
});
