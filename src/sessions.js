const crypto = require('crypto');
const { createOrderer } = require('./ordering');

function bindIdentity(playerId, action) {
  if (action.type === 'MOVE') {
    return { ...action, playerId };
  }
  if (action.type === 'ATTACK') {
    return { ...action, attackerId: playerId };
  }
  return null;
}

function createSessions(redis, roomId, allowedPlayers) {
  const orderers = new Map(); // playerId -> Promise of orderer
  const slotKey = (p) => `room:${roomId}:slot:${p}`;
  const tokenKey = (t) => `room:${roomId}:token:${t}`;
  const seqKey = (p) => `room:${roomId}:seq:${p}`;

  return {
    async join(playerId) {
      if (!allowedPlayers.includes(playerId)) return null;
      const token = crypto.randomUUID();
      await redis.set(tokenKey(token), playerId);
      const won = await redis.set(slotKey(playerId), token, 'NX');
      if (!won) {
        await redis.del(tokenKey(token));
        return null;
      }
      return token;
    },
    async resume(token) {
      if (typeof token !== 'string' || token.length > 64) return null;
      return (await redis.get(tokenKey(token))) ?? null;
    },
    orderer(playerId) {
      if (!orderers.has(playerId)) {
        const p = redis
          .get(seqKey(playerId))
          .then((last) => createOrderer(Number(last || 0) + 1))
          .catch((err) => {
            orderers.delete(playerId);
            throw err;
          });
        orderers.set(playerId, p);
      }
      return orderers.get(playerId);
    },
    async saveSeq(playerId, seq) {
      await redis.set(seqKey(playerId), seq);
    },
  };
}

module.exports = { createSessions, bindIdentity };