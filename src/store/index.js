/**
 * store/index.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Live game state must live in memory, not on disk.
 * PostgreSQL writes take 1–10 ms each. At 20 ticks/sec × 10 rooms that is
 * 200 writes/sec — a database killer. Redis-style in-memory stores handle
 * millions of ops/sec at < 1 ms latency.
 *
 * This module wraps a plain Map to behave exactly like Redis would.
 * Swapping to real Redis means replacing every get/set/delete here with
 * redis.get / redis.set / redis.del. Nothing else in the codebase changes.
 * That is the entire point of the abstraction.
 *
 * WHY NOT GLOBAL VARIABLES
 * ────────────────────────
 * Global vars create invisible coupling and make unit testing impossible
 * (you cannot reset them between tests). A module-level singleton is still
 * one instance in Node's module cache, but it is explicit and mockable.
 */

class InMemoryStore {
  constructor() {
    this.rooms       = new Map(); // roomId  → room state object
    this.sessions    = new Map(); // token   → player metadata + ws ref
    this.eventLogs   = new Map(); // roomId  → ordered snapshot array
    this.seqCounters = new Map(); // roomId  → monotonic integer
  }

  // ── Rooms ────────────────────────────────────────────────────────────────

  setRoom(roomId, state)  { this.rooms.set(roomId, state); }
  getRoom(roomId)         { return this.rooms.get(roomId) ?? null; }
  deleteRoom(roomId)      {
    this.rooms.delete(roomId);
    this.eventLogs.delete(roomId);
    this.seqCounters.delete(roomId);
  }
  getAllRooms()            { return [...this.rooms.values()]; }

  // ── Sessions ─────────────────────────────────────────────────────────────

  setSession(token, data) { this.sessions.set(token, data); }
  getSession(token)       { return this.sessions.get(token) ?? null; }
  deleteSession(token)    { this.sessions.delete(token); }
  getAllSessions()        { return [...this.sessions.values()]; }

  // ── Event log (reconnect replay) ─────────────────────────────────────────
  //
  // WHY FULL SNAPSHOTS INSTEAD OF DIFFS ONLY
  // Diffs are smaller but require replaying from tick 0 to reconstruct any
  // arbitrary state. Full snapshots every N ticks let a reconnecting client
  // binary-search to the nearest snapshot and fast-forward from there.
  // Here we snapshot every tick for simplicity; production: every 10th tick.

  appendEventLog(roomId, entry) {
    if (!this.eventLogs.has(roomId)) this.eventLogs.set(roomId, []);
    const log = this.eventLogs.get(roomId);
    log.push(entry);
    // Cap at 1 000 entries to prevent unbounded memory growth
    if (log.length > 1000) log.splice(0, log.length - 1000);
  }

  // Returns every entry whose seq is strictly greater than sinceSeq.
  // Called on reconnect: "give me everything since seq 47."
  getEventsSince(roomId, sinceSeq) {
    return (this.eventLogs.get(roomId) ?? []).filter(e => e.seq > sinceSeq);
  }

  getLatestSnapshot(roomId) {
    const log = this.eventLogs.get(roomId) ?? [];
    return log.length ? log[log.length - 1] : null;
  }

  // ── Sequence numbers ──────────────────────────────────────────────────────
  //
  // WHY LOGICAL SEQUENCE NUMBERS INSTEAD OF WALL-CLOCK TIMESTAMPS
  // Clocks drift between machines. Player A's laptop might be 340 ms ahead
  // of Player B's. Sorting by timestamp would make B's actions always appear
  // "earlier" even if B pressed the button first.
  //
  // A server-controlled monotonic counter is the canonical ordering mechanism.
  // This is Lamport's logical clock simplified for a single-server topology.
  // In a multi-server topology each server would maintain its own counter and
  // use vector clocks to merge orderings.

  nextSeq(roomId) {
    const n = (this.seqCounters.get(roomId) ?? 0) + 1;
    this.seqCounters.set(roomId, n);
    return n;
  }
  getSeq(roomId) { return this.seqCounters.get(roomId) ?? 0; }
}

module.exports = new InMemoryStore(); // singleton — same instance across all requires
