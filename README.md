# Real-Time Multiplayer Strategy Backend

A production-architecture WebSocket backend demonstrating the hard engineering
problems in multiplayer game infrastructure.

---

## What this project covers

| Problem                    | Module               | Technique                                            |
| -------------------------- | -------------------- | ---------------------------------------------------- |
| Concurrent action ordering | `gameloop/`          | Fixed tick loop + server-assigned logical timestamps |
| Authoritative game state   | `gameloop/`, `room/` | Single mutable state, server-only writes             |
| Anti-cheat                 | `anticheat/`         | Server-side re-validation of every action            |
| State sync                 | `reconciliation/`    | Minimal delta computation + delta merging            |
| Optimistic updates         | `client-demo/`       | Apply locally → rollback on correction flag          |
| Reconnect                  | `reconnect/`         | Grace period + snapshot + event log replay           |
| Packet ordering            | `store/`             | Monotonic sequence numbers (Lamport clocks)          |
| Bandwidth efficiency       | `reconciliation/`    | Delta-only broadcasts, not full state                |

---

## Folder structure

```
src/
├── server.js          Entry point — WS server, message router
├── store/             In-memory state (→ swap for Redis in prod)
├── matchmaking/       Room registry, lobby queue, game start
├── room/              Pure state mutation functions (applyAction)
├── gameloop/          Fixed-tick authoritative loop (50 ms / 20 ticks/sec)
├── anticheat/         Validates every action against server state
├── reconciliation/    State diff + delta merge + correction detection
├── reconnect/         Grace period, session tokens, event log replay
└── broadcast/         WebSocket fan-out (room / player / all)

tests/
├── run-tests.js        Zero-dependency test runner
├── anticheat.test.js
├── gameloop.test.js
├── matchmaking.test.js
└── reconciliation.test.js

client-demo/
└── simulate.js         4 fake players with real WS connections
```

---

## Quick start

```bash
npm install

# Terminal 1 — start the server
npm start

# Terminal 2 — run the 4-player simulation
npm run demo

# Run all tests
npm test
```

---

## Message protocol

### Client → Server

```jsonc
{ "type": "JOIN",      "payload": { "gameMode": "standard" } }
{ "type": "RECONNECT", "payload": { "playerId": "...", "sessionToken": "..." } }
{ "type": "ACTION",    "payload": { "type": "MOVE", "payload": { "to": [2,1] }, "clientTimestamp": 1234 } }
{ "type": "ACTION",    "payload": { "type": "ATTACK", "payload": { "targetPlayerId": "..." } } }
{ "type": "ACTION",    "payload": { "type": "PASS" } }
{ "type": "ACK",       "payload": { "seq": 42 } }
{ "type": "PING" }
```

### Server → Client

```jsonc
{ "type": "CONNECTED",           "playerId": "...", "sessionToken": "..." }
{ "type": "WAITING_FOR_PLAYERS", "count": 2, "needed": 4 }
{ "type": "GAME_START",          "roomId": "...", "players": [...], "gameState": {...} }
{ "type": "STATE_UPDATE",        "seq": 5, "tick": 5, "delta": {...}, "correction": false }
{ "type": "ACTION_REJECTED",     "action": {...}, "reason": "Not enough AP" }
{ "type": "RECONNECT_ACK",       "snapshot": {...}, "missedEvents": [...], "currentSeq": 42 }
{ "type": "PLAYER_RECONNECTED",  "playerId": "..." }
{ "type": "PLAYER_FORFEITED",    "playerId": "...", "reason": "disconnection_timeout" }
{ "type": "GAME_OVER",           "winner": "...", "seq": 99 }
{ "type": "PONG" }
```

---

## Key design decisions and why

### Fixed tick rate (50 ms)

All actions queued between tick N and tick N+1 are sorted deterministically
(server `receivedAt` timestamp, then player ID as tiebreaker) and applied in
order. This guarantees identical state given the same inputs — the foundation
of deterministic replays.

Changing to 100 ms: lower CPU cost, higher latency. For turn-based games
acceptable. For FPS: 128 ticks/sec (7.8 ms).

### Server-assigned sequence numbers

Wall-clock timestamps drift between machines. Sequence numbers are server-
controlled monotonic integers. Reconnecting players request "events since seq N"
with guaranteed completeness.

### Chebyshev distance for movement

Allows diagonal movement at cost 1 (like a chess king). Euclidean (√2 per
diagonal) is awkward for integer ranges. Manhattan (no diagonals) is too
restrictive.

### Delta broadcast instead of full state

Full state at 20 ticks/sec × 4 players ≈ 160 KB/sec per room.
Delta broadcast reduces this by ~97 % — only changed fields are sent.
Clients reconstruct state with `applyDelta`.

### In-memory store (→ Redis)

All live game state in a Map. Swapping to Redis requires only changing the
get/set/delete calls in `src/store/index.js`. Nothing else changes.

### Grace period on disconnect

30 seconds. Player slot is preserved. Game continues with their unit frozen.
After expiry, FORFEIT is applied and the room is notified.

---

## Interview questions and answers

**Q: What happens when two players send actions simultaneously?**
Both are queued. On the next tick, both are sorted by server-assigned
`receivedAt` timestamp. The second may be rejected by anti-cheat if the
first invalidated the preconditions (e.g., the target was already killed).
Both players receive the authoritative outcome.

**Q: How do you scale to multiple servers?**
Pin each room to one server (consistent hashing on roomId). Use Redis pub/sub
for cross-server broadcasts. Replace `src/store/index.js` with a Redis adapter.
Matchmaking becomes a separate service querying the shared room registry.

**Q: What if a client modifies their local state?**
Irrelevant. The server never reads client state. Clients only send intent
(MOVE, ATTACK). The server re-validates against authoritative state. A client
that claims "I moved 10 squares" is rejected at anti-cheat.

**Q: What is the correction flag?**
If a client's `lastAckSeq` is more than 1 behind the current server seq,
`correction: true` is set on their STATE_UPDATE. The client discards its
optimistic updates and treats the incoming delta as ground truth.

**Q: Why not use Socket.IO?**
Socket.IO adds abstraction (rooms, namespaces, fallback transports) that
obscures what is happening. Raw `ws` makes the mechanism visible and
avoids the overhead of HTTP long-polling fallback, which is irrelevant
for a game that requires WebSockets.
