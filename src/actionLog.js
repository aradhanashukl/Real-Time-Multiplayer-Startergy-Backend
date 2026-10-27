const Redis = require('ioredis');

const redis = new Redis(); // connects to localhost:6379

async function appendAction(roomId, action) {
  await redis.xadd(`room:${roomId}:actions`, '*', 'data', JSON.stringify(action));
}

async function readActions(roomId) {
  const entries = await redis.xrange(`room:${roomId}:actions`, '-', '+');
  return entries.map(([id, fields]) => JSON.parse(fields[1]));
}

async function readEntriesAfter(roomId, lastId) {
  const start = lastId === '0-0' ? '-' : `(${lastId}`;
  const entries = await redis.xrange(`room:${roomId}:actions`, start, '+');
  return entries.map(([id, fields]) => ({ id, event: JSON.parse(fields[1]) }));
}

async function close() {
  await redis.quit();
}

module.exports = { appendAction, readActions, readEntriesAfter, close };