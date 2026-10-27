const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8080');

ws.once('message', (data) => {
  const msg = JSON.parse(data);
  console.log('bob x =', msg.state.players.bob.x);
  process.exit();
});