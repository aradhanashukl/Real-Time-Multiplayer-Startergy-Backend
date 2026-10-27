const MAX_AHEAD = 100;

function createOrderer(startAt = 1) {
  let expected = startAt;
  const pending = new Map();

  function accept(seq, action) {
    if (!Number.isInteger(seq) || seq < expected || seq > expected + MAX_AHEAD) {
      return [];
    }
    pending.set(seq, action);

    const ready = [];
    while (pending.has(expected)) {
      ready.push(pending.get(expected));
      pending.delete(expected);
      expected++;
    }
    return ready;
  }

  return { accept, next: () => expected };
}

module.exports = { createOrderer };