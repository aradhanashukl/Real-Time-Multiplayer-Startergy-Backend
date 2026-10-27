const WebSocket = require('ws');

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:8080');
    ws.messages = [];
    ws.on('message', (d) => ws.messages.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (ws, type) => ws.messages.find((m) => m.type === type);
const lastState = (ws) =>
  [...ws.messages].reverse().find((m) => m.type === 'STATE').state;

async function main() {
  // 1. Join as bob, then try to move ALICE (spoof)
  const c1 = await connect();
  c1.send(JSON.stringify({ type: 'JOIN', playerId: 'bob' }));
  await wait(200);
  const token = find(c1, 'JOINED').token;

  c1.send(JSON.stringify({ seq: 1, action: { type: 'MOVE', playerId: 'alice', dx: -1, dy: 0 } }));
  await wait(300);
  const s = lastState(c1);
  console.log('alice x =', s.players.alice.x, '(expect 1)');
  console.log('bob x   =', s.players.bob.x, '(expect 8)');

  // 2. Someone else tries to take bob's slot
  const c2 = await connect();
  c2.send(JSON.stringify({ type: 'JOIN', playerId: 'bob' }));
  await wait(200);
  console.log('second JOIN:', find(c2, 'ERROR') ? 'refused' : 'ACCEPTED (bad)');

  // 3. bob reconnects with his token and continues at seq 2
  c1.close();
  const c3 = await connect();
  c3.send(JSON.stringify({ type: 'RESUME', token }));
  await wait(200);
  c3.send(JSON.stringify({ seq: 2, action: { type: 'MOVE', playerId: 'bob', dx: -1, dy: 0 } }));
  await wait(300);
  console.log('bob x after resume =', lastState(c3).players.bob.x, '(expect 7)');

  process.exit();
}

main();