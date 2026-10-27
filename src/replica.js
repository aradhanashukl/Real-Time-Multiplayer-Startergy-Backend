const { createClock, compare } = require('./lamport');
const { applyAction } = require('./game');

const SNAPSHOT_EVERY = 50;
const SAFETY_MARGIN = 20;

function createReplica(nodeId, initialState) {
  const clock = createClock(nodeId);
  const events = [];
  let snapshot = { count: 0, state: initialState };
  let cached = null;

  function insert(event) {
    let i = events.length;
    while (i > 0 && compare(events[i - 1], event) > 0) i--;
    if (i > 0 && compare(events[i - 1], event) === 0) return;

    events.splice(i, 0, event);
    if (i < snapshot.count) {
      snapshot = { count: 0, state: initialState };
    }
    cached = null;
  }

  return {
    local(action) {
      const event = { ...clock.tick(), action };
      insert(event);
      return event;
    },
    remote(event) {
      clock.receive(event.time);
      insert(event);
    },
    state() {
      if (cached) return cached;

      const target = events.length - SAFETY_MARGIN;
      let s = snapshot.state;
      let next = snapshot;
      for (let i = snapshot.count; i < events.length; i++) {
        if (i === target && target - snapshot.count >= SNAPSHOT_EVERY) {
          next = { count: i, state: s };
        }
        s = applyAction(s, events[i].action);
      }
      snapshot = next;
      cached = s;
      return s;
    },
    log() {
      return events;
    },
  };
}

module.exports = { createReplica };