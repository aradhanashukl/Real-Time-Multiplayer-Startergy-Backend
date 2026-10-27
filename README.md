# Real-Time Multiplayer Backend

A Node.js game backend where two server instances share one game through Redis and stay consistent. Built with WebSockets, Redis Streams and Redis pub/sub.

## What it does

- **Pure game rules.** Move and attack are pure functions that return a new state, so the same actions always give the same result.
- **Event log and replay.** Every action is saved to a Redis Stream before it is applied. After a crash, the server rebuilds the game by replaying the log.
- **Sequence numbers.** Each player stamps actions with a counter. Early actions wait, duplicates and old numbers are dropped.
- **Lamport clocks.** Events from different instances are ordered by `(time, nodeId)`, so every instance replays the same sequence and ends in the same state.
- **Two instances, one game.** Instances exchange events over Redis pub/sub and also poll the Stream, so a missed message is caught up.
- **Server-side identity.** A player must `JOIN` or `RESUME` with a token. The server decides whose action it is, so a client cannot act for someone else. Tokens and sequence counters live in Redis, so a player can resume on either instance.
- **Rooms and snapshots.** Many independent rooms, and snapshots keep state rebuilds fast.

## Project layout

```
src/
  game.js        pure rules: movePlayer, attackPlayer, applyAction, replay
  ordering.js    per-player sequence ordering
  lamport.js     Lamport clock and event comparison
  replica.js     sorted event log, snapshots, state rebuild
  sessions.js    join / resume / identity, backed by Redis
  actionLog.js   Redis Stream read and write
  server.js      WebSocket server, rooms, pub/sub, polling
tests/           unit tests and one integration test
client-demo/     small scripts for trying the server by hand
DECISIONS.md     what I chose, the alternatives, and why
```

## Run it

You need Node.js and Docker.

```
docker run -d --name redis -p 6379:6379 redis
npm install
node src/server.js 8080 A
node src/server.js 8081 B
```

The two arguments are the port and the instance name. Start the instances in separate terminals.

## Messages

Join a room (the server replies with a token):

```json
{ "type": "JOIN", "roomId": "room1", "playerId": "bob" }
```

Come back after a disconnect, on either instance:

```json
{ "type": "RESUME", "roomId": "room1", "token": "<token>" }
```

Send an action:

```json
{ "seq": 1, "action": { "type": "MOVE", "dx": -1, "dy": 0 } }
{ "seq": 2, "action": { "type": "ATTACK", "targetId": "alice" } }
```

The player id inside an action is ignored and replaced by the authenticated one.

## Test it

```
npm test                   # pure-logic tests, no Redis needed
npm run test:integration   # starts two real instances, needs Redis running
```

The integration test checks: actions before joining are rejected, a spoofed player id has no effect, a taken slot cannot be joined twice, resume keeps the sequence counter, rooms are isolated, a second instance recovers a room from Redis, a missed event arrives by polling, bad room ids are refused, and resume works on the other instance.

## Known limits

- Delivery is at-least-once. A crash between saving an action and saving its sequence number can let a retry apply twice.
- Slots and tokens never expire.
- A late event from another instance can change earlier history, so a client may see a state correction.
- Redis is a single point of failure.
- Two fixed players per room, no matchmaking.
- Polling reads one stream per loaded room every second.
- The unit tests print values for a human to compare; only the integration test asserts automatically.