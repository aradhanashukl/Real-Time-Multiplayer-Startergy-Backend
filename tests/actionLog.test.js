const { appendAction, readActions, close } = require('../src/actionLog');
const { replay } = require('../src/game');

async function main() {
  const roomId = 'test-' + Date.now();

  await appendAction(roomId, { type: 'MOVE', playerId: 'bob', dx: -1, dy: 0 });
  await appendAction(roomId, { type: 'MOVE', playerId: 'bob', dx: -1, dy: 0 });

  const actions = await readActions(roomId);
  console.log(actions.length);                 // expect 2
  console.log(actions[0].dx === -1);           // expect true (a number, not text)

  const start = { tick: 0, players: { bob: { x: 9, y: 0, hp: 100 } } };
  console.log(replay(start, actions).players.bob.x);   // expect 7

  await close();
}

main();