const { WebSocketServer } = require('ws');
const Redis = require('ioredis');
const { createReplica } = require('./replica');
const { createSessions, bindIdentity } = require('./sessions');
const { appendAction, readEntriesAfter } = require('./actionLog');

const PORT = Number(process.argv[2]) || 8080;
const NODE_ID = process.argv[3] || 'A';
const VALID_ROOM = /^[a-zA-Z0-9_-]{1,32}$/;

function newGameState() {
  return {
    tick: 0,
    players: {
      alice: { x: 1, y: 1, hp: 100 },
      bob:   { x: 9, y: 1, hp: 100 },
    },
  };
}

const channelFor = (roomId) => `room:${roomId}:events`;

async function main() {
  const pub = new Redis();
  const sub = new Redis();
  const rooms = new Map();
  const loaded = new Map();

  sub.on('message', (channel, message) => {
    const roomId = channel.slice('room:'.length, -':events'.length);
    const room = loaded.get(roomId);
    if (!room) return;
    let event;
    try {
      event = JSON.parse(message);
    } catch {
      return;
    }
    if (event.nodeId === NODE_ID) return;
    room.replica.remote(event);
    room.dirty = true;
  });

  async function loadRoom(roomId) {
    const initial = newGameState();
    const room = {
      id: roomId,
      replica: createReplica(NODE_ID, initial),
      sessions: createSessions(pub, roomId, Object.keys(initial.players)),
      lastId: '0-0',
      dirty: true,
    };
    loaded.set(roomId, room);
    await sub.subscribe(channelFor(roomId));

    const saved = await readEntriesAfter(roomId, room.lastId);
    for (const { id, event } of saved) {
      room.replica.remote(event);
      room.lastId = id;
    }
    console.log(`[${NODE_ID}] room ${roomId}: recovered ${saved.length} events`);
    return room;
  }

  function getRoom(roomId) {
    if (!rooms.has(roomId)) {
      const p = loadRoom(roomId).catch((err) => {
        rooms.delete(roomId);
        loaded.delete(roomId);
        throw err;
      });
      rooms.set(roomId, p);
    }
    return rooms.get(roomId);
  }

  const wss = new WebSocketServer({ port: PORT });

  function send(ws, obj) {
    ws.send(JSON.stringify(obj));
  }

  wss.on('connection', (ws) => {
    ws.room = null;
    ws.playerId = null;

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;

      if (msg.type === 'JOIN' || msg.type === 'RESUME') {
        if (ws.room) return;
        if (typeof msg.roomId !== 'string' || !VALID_ROOM.test(msg.roomId)) {
          send(ws, { type: 'ERROR', reason: 'bad room id' });
          return;
        }
        try {
          const room = await getRoom(msg.roomId);
          let playerId;
          let token;
          if (msg.type === 'JOIN') {
            token = await room.sessions.join(msg.playerId);
            playerId = token ? msg.playerId : null;
          } else {
            playerId = await room.sessions.resume(msg.token);
            token = msg.token;
          }
          if (!playerId || ws.room) {
            send(ws, { type: 'ERROR', reason: 'join refused' });
            return;
          }
          ws.room = room;
          ws.playerId = playerId;
          send(ws, { type: 'JOINED', roomId: room.id, playerId, token });
          send(ws, { type: 'STATE', node: NODE_ID, state: room.replica.state() });
        } catch (err) {
          console.error(`[${NODE_ID}]`, err.message);
          send(ws, { type: 'ERROR', reason: 'room unavailable' });
        }
        return;
      }

      if (!ws.room) {
        send(ws, { type: 'ERROR', reason: 'not joined' });
        return;
      }
      if (typeof msg.action !== 'object' || msg.action === null) return;

      const room = ws.room;
      try {
        const orderer = await room.sessions.orderer(ws.playerId);
        const ready = orderer.accept(msg.seq, msg.action);
        for (const raw of ready) {
          const action = bindIdentity(ws.playerId, raw);
          if (action === null) continue;
          const event = room.replica.local(action);
          room.dirty = true;
          await appendAction(room.id, event);
          await pub.publish(channelFor(room.id), JSON.stringify(event));
        }
        if (ready.length > 0) {
          await room.sessions.saveSeq(ws.playerId, orderer.next() - 1);
        }
      } catch (err) {
        console.error(`[${NODE_ID}]`, err.message);
      }
    });
  });

  let polling = false;
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      for (const room of loaded.values()) {
        const entries = await readEntriesAfter(room.id, room.lastId);
        for (const { id, event } of entries) {
          room.replica.remote(event);
          room.lastId = id;
        }
        if (entries.length > 0) room.dirty = true;
      }
    } catch (err) {
      console.error(`[${NODE_ID}] catch-up failed:`, err.message);
    } finally {
      polling = false;
    }
  }, 1000);

  setInterval(() => {
    for (const room of loaded.values()) {
      if (!room.dirty) continue;
      room.dirty = false;
      const msg = JSON.stringify({ type: 'STATE', node: NODE_ID, state: room.replica.state() });
      for (const client of wss.clients) {
        if (client.readyState === 1 && client.room === room) client.send(msg);
      }
    }
  }, 50);

  console.log(`[${NODE_ID}] running on ws://localhost:${PORT}`);
}

main();