const { appendAction, close } = require('../src/actionLog');

(async () => {
  await appendAction('game1', {
    time: 5,
    nodeId: 'C',
    action: { type: 'MOVE', playerId: 'bob', dx: -1, dy: 0 },
  });
  await close();
  console.log('injected');
})();