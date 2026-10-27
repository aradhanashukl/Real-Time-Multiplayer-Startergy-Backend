function createClock(nodeId) {
  let time = 0;

  return {
    tick() {
      time++;
      return { time, nodeId };
    },
    receive(remoteTime) {
      time = Math.max(time, remoteTime) + 1;
      return time;
    },
  };
}

function compare(a, b) {
  if (a.time !== b.time) return a.time - b.time;
  if (a.nodeId < b.nodeId) return -1;
  if (a.nodeId > b.nodeId) return 1;
  return 0;
}

module.exports = { createClock, compare };