const { createReplica } = require('../src/replica');
const { replay } = require('../src/game');

const start = {
  tick: 0,
  players: {
    alice: { x: 5, y: 5, hp: 10000 },
    bob:   { x: 6, y: 5, hp: 10000 },
  },
};

const r = createReplica('A', start);
const actions = [];
for (let i = 0; i < 300; i++) {
  const a = { type: 'ATTACK', attackerId: 'alice', targetId: 'bob' };
  actions.push(a);
  r.local(a);
  if (i % 50 === 0) r.state();   // read now and then, so snapshots get taken
}

console.log(r.state().players.bob.hp);   // expect 7000
console.log(JSON.stringify(r.state()) === JSON.stringify(replay(start, actions)));  // expect true

// A late event from another instance, sorted near the very start of history
r.remote({ time: 1, nodeId: 'B', action: { type: 'MOVE', playerId: 'bob', dx: 1, dy: 0 } });
console.log(r.state().players.bob.hp);   // expect 9990
console.log(r.state().players.bob.x);    // expect 7