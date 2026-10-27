const { applyAction, replay } = require('../src/game');

const start = {
  tick: 0,
  players: {
    alice: { x: 1, y: 1, hp: 100 },
    bob:   { x: 3, y: 1, hp: 100 },
  },
};

const actions = [
  { type: 'MOVE',   playerId: 'bob',   dx: -1, dy: 0 },   // bob to (2,1), next to alice
  { type: 'ATTACK', attackerId: 'alice', targetId: 'bob' }, // bob 100 -> 90
  { type: 'ATTACK', attackerId: 'alice', targetId: 'bob' }, // bob 90 -> 80
  { type: 'MOVE',   playerId: 'alice', dx: 5, dy: 0 },      // illegal, ignored
];

const a = replay(start, actions);
const b = replay(start, actions);

console.log(a.players.bob.hp);                               // expect 80
console.log(a.players.bob.x);                                // expect 2
console.log(a.players.alice.x);                              // expect 1
console.log(JSON.stringify(a) === JSON.stringify(b));        // expect true (same input, same result)
console.log(start.players.bob.hp);                           // expect 100 (start never changed)