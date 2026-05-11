/**
 * client-demo/simulate.js
 *
 * Simulates 4 players connecting, joining a game, and playing moves.
 * Runs AFTER the server is started: node src/server.js
 * Then in a second terminal:       node client-demo/simulate.js
 *
 * WHAT THIS DEMONSTRATES
 * ──────────────────────
 * 1. All 4 players connect and receive session tokens
 * 2. Matchmaking fills the room → GAME_START fires
 * 3. Each player sends MOVE and ATTACK actions
 * 4. Players acknowledge STATE_UPDATE messages (ACK protocol)
 * 5. One player simulates a disconnect + reconnect
 * 6. The server sends the reconnect snapshot and missed events
 * 7. Terminal output shows the full message flow
 *
 * OPTIMISTIC UPDATE SIMULATION
 * ─────────────────────────────
 * Each client maintains a local state copy. On sending an action it applies
 * it optimistically. On receiving STATE_UPDATE it merges the delta (and rolls
 * back if correction=true). This is exactly what a real browser client does.
 */

'use strict';

const WebSocket  = require('ws');
const { applyDelta } = require('../src/reconciliation');

const SERVER_URL = process.env.SERVER_URL ?? 'ws://localhost:8080';
const COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m'];
const RESET  = '\x1b[0m';

// ── Client factory ────────────────────────────────────────────────────────────

function createPlayer(name, color, delayMs) {
  return new Promise(resolve => {
    setTimeout(() => {
      const client = {
        name,
        color,
        playerId:     null,
        sessionToken: null,
        roomId:       null,
        localState:   null,   // client-side optimistic state
        lastAckSeq:   0,
        ws:           null,
      };

      const ws = new WebSocket(SERVER_URL);
      client.ws = ws;

      ws.on('open', () => {
        log(client, 'Connected to server — sending JOIN');
        send(ws, { type: 'JOIN', payload: { gameMode: 'standard' } });
      });

      ws.on('message', raw => {
        const msg = JSON.parse(raw);
        handleMessage(client, msg, resolve);
      });

      ws.on('error', err => log(client, `Error: ${err.message}`));
      ws.on('close', ()  => log(client, 'Connection closed'));
    }, delayMs);
  });
}

// ── Message handler ───────────────────────────────────────────────────────────

function handleMessage(client, msg, resolve) {
  switch (msg.type) {
    case 'CONNECTED': {
      client.playerId     = msg.playerId;
      client.sessionToken = msg.sessionToken;
      log(client, `Got identity — playerId=${msg.playerId.slice(0, 8)}…`);
      break;
    }

    case 'WAITING_FOR_PLAYERS': {
      log(client, `Waiting for players… ${msg.count}/${msg.needed}`);
      break;
    }

    case 'GAME_START': {
      client.roomId     = msg.roomId;
      client.localState = msg.gameState;
      log(client, `GAME STARTED — roomId=${msg.roomId.slice(0, 8)}…`);
      logState(client);

      // Signal that this client is ready to play
      resolve(client);

      // Start playing after a short delay so all clients are ready
      setTimeout(() => startPlaying(client), 200);
      break;
    }

    case 'STATE_UPDATE': {
      const prevPos = client.localState?.units?.[client.playerId]?.position;

      // Merge delta onto local state
      client.localState = applyDelta(client.localState, msg.delta);

      if (msg.correction) {
        log(client, `↩ CORRECTION at seq=${msg.seq} — rolled back optimistic update`);
      }

      // Acknowledge receipt
      send(client.ws, { type: 'ACK', payload: { seq: msg.seq } });
      client.lastAckSeq = msg.seq;

      // Log meaningful events
      if (msg.delta.events?.length) {
        for (const ev of msg.delta.events) {
          if (ev.result?.type === 'MOVED') {
            log(client, `Tick ${msg.tick}: ${ev.playerId.slice(0,6)} moved ${ev.result.from}→${ev.result.to}`);
          }
          if (ev.result?.type === 'ATTACKED') {
            log(client, `Tick ${msg.tick}: ${ev.result.attackerId.slice(0,6)} attacked ${ev.result.targetId.slice(0,6)} → hp ${ev.result.newHp}`);
          }
        }
      }
      break;
    }

    case 'ACTION_REJECTED': {
      log(client, `✗ Action rejected: ${msg.reason}`);
      break;
    }

    case 'RECONNECT_ACK': {
      client.localState = msg.snapshot;
      log(client, `Reconnected — ${msg.missedEvents.length} missed events replayed`);
      logState(client);
      break;
    }

    case 'PLAYER_RECONNECTED': {
      log(client, `Player ${msg.playerId.slice(0,6)}… reconnected`);
      break;
    }

    case 'PLAYER_FORFEITED': {
      log(client, `Player ${msg.playerId.slice(0,6)}… forfeited (${msg.reason})`);
      break;
    }

    case 'GAME_OVER': {
      const winner = msg.winner === client.playerId ? '🏆 YOU WIN' : `Winner: ${msg.winner.slice(0,8)}`;
      log(client, `GAME OVER — ${winner}`);
      client.ws.close();
      break;
    }

    case 'ERROR': {
      log(client, `SERVER ERROR: ${msg.message}`);
      break;
    }
  }
}

// ── Play strategy ─────────────────────────────────────────────────────────────

function startPlaying(client) {
  if (!client.localState) return;

  const myUnit = client.localState.units[client.playerId];
  if (!myUnit || myUnit.health <= 0) return;

  // Find an enemy unit
  const enemy = Object.entries(client.localState.units).find(
    ([pid, u]) => pid !== client.playerId && u.health > 0
  );

  if (enemy) {
    const [enemyId, enemyUnit] = enemy;
    const [mx, my] = myUnit.position;
    const [ex, ey] = enemyUnit.position;
    const dist = Math.max(Math.abs(ex - mx), Math.abs(ey - my));

    if (dist <= 1 && myUnit.ap >= 2) {
      // Adjacent — attack!
      log(client, `Sending ATTACK on ${enemyId.slice(0,6)}…`);

      // Optimistic update: apply locally before server confirms
      const optimisticState = applyDelta(client.localState, {
        units: { [enemyId]: { health: Math.max(0, enemyUnit.health - 25) } },
      });
      client.localState = optimisticState;

      send(client.ws, {
        type:    'ACTION',
        payload: { type: 'ATTACK', payload: { targetPlayerId: enemyId }, clientTimestamp: Date.now() },
      });
    } else if (myUnit.ap >= 1) {
      // Move closer — step 1 square toward enemy
      const dx = Math.sign(ex - mx);
      const dy = Math.sign(ey - my);
      const target = [mx + dx, my + dy];

      log(client, `Sending MOVE to [${target}]`);

      // Optimistic update
      const optimisticState = applyDelta(client.localState, {
        units: { [client.playerId]: { position: target, ap: myUnit.ap - 1 } },
      });
      client.localState = optimisticState;

      send(client.ws, {
        type:    'ACTION',
        payload: { type: 'MOVE', payload: { to: target }, clientTimestamp: Date.now() },
      });
    } else {
      // No AP — PASS
      send(client.ws, { type: 'ACTION', payload: { type: 'PASS', clientTimestamp: Date.now() } });
    }
  }

  // Continue playing every 300 ms
  setTimeout(() => startPlaying(client), 300);
}

// ── Reconnect simulation ───────────────────────────────────────────────────────

function simulateReconnect(client, delayMs) {
  setTimeout(() => {
    if (!client.playerId || !client.sessionToken) return;
    log(client, '--- Simulating disconnect (closing socket) ---');
    client.ws.close();

    setTimeout(() => {
      log(client, '--- Reconnecting with session token ---');
      const ws = new WebSocket(SERVER_URL);
      client.ws = ws;

      ws.on('open', () => {
        send(ws, {
          type:    'RECONNECT',
          payload: { playerId: client.playerId, sessionToken: client.sessionToken },
        });
      });

      ws.on('message', raw => {
        const msg = JSON.parse(raw);
        handleMessage(client, msg, () => {});
      });

      ws.on('error', err => log(client, `Reconnect error: ${err.message}`));
    }, 2000); // Wait 2 s then reconnect
  }, delayMs);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function log(client, msg) {
  const prefix = `${client.color}[${client.name}]${RESET}`;
  console.log(`${prefix} ${msg}`);
}

function logState(client) {
  const u = client.localState?.units?.[client.playerId];
  if (u) log(client, `  → position=${JSON.stringify(u.position)} hp=${u.health} ap=${u.ap}`);
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n\x1b[1mMultiplayer Backend Demo — connecting 4 players...\x1b[0m\n');

  const names = ['Alice', 'Bob', 'Carol', 'Dave'];

  // Stagger connections by 100 ms so server logs are readable
  const playerPromises = names.map((name, i) =>
    createPlayer(name, COLORS[i], i * 100)
  );

  const players = await Promise.all(playerPromises);

  console.log('\n\x1b[1mAll players in game. Simulating disconnect/reconnect for Alice in 3s...\x1b[0m\n');

  // Simulate Alice disconnecting and reconnecting after 3 seconds
  simulateReconnect(players[0], 3000);
}

main().catch(console.error);
