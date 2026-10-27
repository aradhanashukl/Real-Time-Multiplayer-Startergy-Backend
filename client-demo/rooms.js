const WebSocket = require('ws');

function connect(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (ws, type) => ws.msgs.find((m) => m.type === type);
const lastState = (ws) =>
  [...ws.msgs].reverse().find((m) => m.type === 'STATE').state;

async function join(port, roomId, playerId) {
  const ws = await connect(port);
  ws.send(JSON.stringify({ type: 'JOIN', roomId, playerId }));
  await wait(400);
  if (!find(ws, 'JOINED')) throw new Error(`join failed: ${roomId}/${playerId}`);
  return ws;
}

async function main() {
  const id = Date.now();
  const r1 = `r1-${id}`;
  const r2 = `r2-${id}`;

  // The same player name, in two different rooms
  const a = await join(8080, r1, 'bob');
  const b = await join(8080, r2, 'bob');

  a.send(JSON.stringify({ seq: 1, action: { type: 'MOVE', playerId: 'bob', dx: -1, dy: 0 } }));
  await wait(400);
  console.log('room 1 bob x =', lastState(a).players.bob.x, '(expect 8)');
  console.log('room 2 bob x =', lastState(b).players.bob.x, '(expect 9)');

  // A different instance loads room 1 from Redis
  const c = await join(8081, r1, 'alice');
  console.log('instance B, room 1 bob x =', lastState(c).players.bob.x, '(expect 8)');

  // A room id that is not allowed
  const d = await connect(8080);
  d.send(JSON.stringify({ type: 'JOIN', roomId: 'bad:room', playerId: 'bob' }));
  await wait(200);
  console.log('bad room id:', find(d, 'ERROR') ? 'refused' : 'ACCEPTED (bad)');

  process.exit();
}

main();