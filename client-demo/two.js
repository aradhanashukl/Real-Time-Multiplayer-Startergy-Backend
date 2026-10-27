const WebSocket = require('ws');
const a = new WebSocket('ws://localhost:8080');
const b = new WebSocket('ws://localhost:8081');

b.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('B sees bob x =', msg.state.players.bob.x);
});

a.on('open', () => {
  setTimeout(() => {
    a.send(JSON.stringify({ seq: 1, action: { type: 'MOVE', playerId: 'bob', dx: -1, dy: 0 } }));
  }, 300);
});

setTimeout(() => process.exit(), 1000);