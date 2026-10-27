const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  const move = { type: 'MOVE', playerId: 'bob', dx: -1, dy: 0 };
  ws.send(JSON.stringify({ seq: 2, action: move }));  // arrives early, must wait
  ws.send(JSON.stringify({ seq: 1, action: move }));  // releases seq 1 and 2
  ws.send(JSON.stringify({ seq: 1, action: move }));  // duplicate, must be dropped
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('tick', msg.state.tick, '| bob x =', msg.state.players.bob.x);
});

setTimeout(() => process.exit(), 500);