const WebSocket = require('ws');
const ws = new WebSocket(`ws://localhost:${process.argv[2] || 8080}`);
let last = null;
ws.on('message', (d) => { last = JSON.parse(d).state.players.bob.x; });
setTimeout(() => { console.log('bob x =', last); process.exit(); }, 2000);