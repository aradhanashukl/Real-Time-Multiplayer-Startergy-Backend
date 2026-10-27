const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const Redis = require('ioredis');
const { appendAction, close: closeLog } = require('../src/actionLog');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let total = 0;
function check(name, ok) {
  total++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

function startServer(port, nodeId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, String(port), nodeId]);
    const timer = setTimeout(
      () => reject(new Error(`server ${nodeId} did not start (is Redis running?)`)),
      5000
    );
    child.stdout.on('data', (d) => {
      if (d.toString().includes('running on')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[${nodeId}] ${d}`));
  });
}

function connect(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws));
  });
}

const find = (ws, type) => ws.msgs.find((m) => m.type === type);
const lastState = (ws) =>
  [...ws.msgs].reverse().find((m) => m.type === 'STATE').state;

async function join(port, roomId, playerId) {
  const ws = await connect(port);
  ws.send(JSON.stringify({ type: 'JOIN', roomId, playerId }));
  await wait(400);
  const joined = find(ws, 'JOINED');
  ws.token = joined ? joined.token : null;
  ws.joined = Boolean(joined);
  return ws;
}

const move = (seq, playerId, dx) =>
  JSON.stringify({ seq, action: { type: 'MOVE', playerId, dx, dy: 0 } });

async function main() {
  const id = Date.now();
  const R1 = `t1-${id}`;
  const R2 = `t2-${id}`;
  const R3 = `t3-${id}`;
  const servers = [];
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  try {
    servers.push(await startServer(8090, 'A'));
    servers.push(await startServer(8091, 'B'));

    // 1. Actions before joining are rejected
    const anon = await connect(8090);
    anon.send(move(1, 'bob', -1));
    await wait(200);
    check('action before joining is rejected', Boolean(find(anon, 'ERROR')));

    // 2. A spoofed player id moves the real player, not the victim
    const a = await join(8090, R1, 'bob');
    a.send(move(1, 'alice', -1));
    await wait(400);
    const s = lastState(a);
    check('spoofed action moves bob, not alice', s.players.bob.x === 8 && s.players.alice.x === 1);

    // 3. A second join for the same player is refused
    const thief = await join(8090, R1, 'bob');
    check('second join for a taken player is refused', !thief.joined);

    // 4. Resume with the token keeps the seq counter
    a.close();
    await wait(200);
    const back = await connect(8090);
    back.send(JSON.stringify({ type: 'RESUME', roomId: R1, token: a.token }));
    await wait(300);
    back.send(move(2, 'bob', -1));
    await wait(400);
    check('resumed player keeps seq counter (bob x = 7)', lastState(back).players.bob.x === 7);

    // 5. Rooms are isolated
    const other = await join(8090, R2, 'bob');
    check('rooms are isolated (room 2 bob x = 9)', lastState(other).players.bob.x === 9);

    // 6. A second instance recovers the room from Redis
    const c = await join(8091, R1, 'alice');
    check('instance B recovers the room (bob x = 7)', lastState(c).players.bob.x === 7);

    // 7. An event that never went through pub/sub arrives by Stream polling
    await appendAction(R1, {
      time: 1000,
      nodeId: 'Z',
      action: { type: 'MOVE', playerId: 'bob', dx: -1, dy: 0 },
    });
    await wait(1800);
    check('missed event arrives via Stream polling (bob x = 6)', lastState(c).players.bob.x === 6);

    // 8. A room id that could change a Redis key is refused
    const bad = await connect(8090);
    bad.send(JSON.stringify({ type: 'JOIN', roomId: 'bad:room', playerId: 'bob' }));
    await wait(200);
    check('bad room id is refused', Boolean(find(bad, 'ERROR')));

    // 9. Resume on the OTHER instance continues the seq counter
    const p = await join(8090, R3, 'alice');
    p.send(move(1, 'alice', 1));
    await wait(400);
    const q = await connect(8091);
    q.send(JSON.stringify({ type: 'RESUME', roomId: R3, token: p.token }));
    await wait(400);
    q.send(move(2, 'alice', 1));
    q.send(move(1, 'alice', 1));   // an old seq: must be dropped
    await wait(600);
    check('resume on instance B continues seq (alice x = 3)', lastState(q).players.alice.x === 3);
  } catch (err) {
    failures++;
    console.log('FAIL  test run crashed:', err.message);
  } finally {
    for (const child of servers) child.kill();
    for (const r of [R1, R2, R3]) {
      const keys = await redis.keys(`room:${r}:*`);
      if (keys.length) await redis.del(...keys);
    }
    await redis.quit();
    await closeLog();
    console.log(failures === 0 ? `\n${total}/${total} passed` : `\n${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
  }
}

main();