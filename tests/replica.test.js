const { createReplica } = require('../src/replica');

const start = {
  tick: 0,
  players: {
    alice: { x: 1, y: 1, hp: 100 },
    bob:   { x: 2, y: 1, hp: 100 },
  },
};

const A = createReplica('A', start);
const B = createReplica('B', start);

// Two things happen at the same moment, one on each instance
const eA = A.local({ type: 'ATTACK', attackerId: 'alice', targetId: 'bob' });
const eB = B.local({ type: 'MOVE', playerId: 'bob', dx: 1, dy: 0 });

// Each instance hears about the other's event
A.remote(eB);
B.remote(eA);

console.log(A.state().players.bob.hp, A.state().players.bob.x);   // expect 90 3
console.log(B.state().players.bob.hp, B.state().players.bob.x);   // expect 90 3
console.log(JSON.stringify(A.state()) === JSON.stringify(B.state()));  // expect true

A.remote(eB);                  // the same event delivered twice
console.log(A.log().length);   // expect 2