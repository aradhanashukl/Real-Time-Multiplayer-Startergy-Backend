const { movePlayerInState, attackPlayer } = require('../src/game');

// ---- move tests ----
const state = {
  tick: 0,
  players: {
    alice: { x: 0, y: 0, hp: 100 },
    bob:   { x: 9, y: 0, hp: 100 },
    carol: { x: 0, y: 9, hp: 100 },
    dave:  { x: 9, y: 9, hp: 100 },
  },
};

const s1 = movePlayerInState(state, "bob", -1, 0);
console.log(s1.players.bob.x);                                    // expect 8
console.log(state.players.bob.x);                                 // expect 9
console.log(s1.players.alice === state.players.alice);            // expect true
console.log(movePlayerInState(state, "ghost", 1, 0) === state);   // expect true
console.log(movePlayerInState(state, "alice", -1, 0) === state);  // expect true

// ---- attack tests ----
const near = {
  tick: 0,
  players: {
    alice: { x: 1, y: 1, hp: 100 },
    bob:   { x: 2, y: 1, hp: 100 },
    carol: { x: 9, y: 9, hp: 100 },
  },
};

console.log(attackPlayer(near, "alice", "bob").players.bob.hp);   // expect 90
console.log(near.players.bob.hp);                                 // expect 100
console.log(attackPlayer(near, "alice", "carol") === near);       // expect true
console.log(attackPlayer(near, "alice", "alice") === near);       // expect true
console.log(attackPlayer(near, "alice", "ghost") === near);       // expect true