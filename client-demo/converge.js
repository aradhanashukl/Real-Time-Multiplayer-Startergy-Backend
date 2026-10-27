const WebSocket = require('ws');

const a = new WebSocket('ws://localhost:8080');
const b = new WebSocket('ws://localhost:8081');

let lastA = null;
let lastB = null;
a.on('message', (d) => { lastA = JSON.parse(d).state.players.bob.x; });
b.on('message', (d) => { lastB = JSON.parse(d).state.players.bob.x; });

let open = 0;
function onOpen() {
  open++;
  if (open < 2) return;
  // both sockets are open: send at the same moment
  a.send(JSON.stringify({ seq: 1, action: { type: 'MOVE', playerId: 'bob', dx: 1, dy: 0 } }));
  b.send(JSON.stringify({ seq: 1, action: { type: 'MOVE', playerId: 'bob', dx: -1, dy: 0 } }));
}
a.on('open', onOpen);
b.on('open', onOpen);

setTimeout(() => {
  console.log('A says bob x =', lastA);
  console.log('B says bob x =', lastB);
  console.log(lastA === lastB ? 'AGREE' : 'DISAGREE');
  process.exit();
}, 1000);