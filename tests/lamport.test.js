const { createClock, compare } = require('../src/lamport');

const A = createClock('A');
const B = createClock('B');

const e1 = A.tick();            // A does something: time 1
const e2 = A.tick();            // A does something else: time 2
B.receive(e2.time);             // B hears about e2: its clock jumps to max(0,2)+1 = 3
const e3 = B.tick();            // B acts afterwards: time 4

console.log(e1.time, e2.time, e3.time);   // expect 1 2 4
console.log(compare(e2, e3) < 0);         // expect true (e2 happened before e3)

const C = createClock('C');
const D = createClock('D');
const c1 = C.tick();
const d1 = D.tick();                      // never talked to each other
console.log(c1.time === d1.time);         // expect true (same time)
console.log(compare(c1, d1) < 0);         // expect true (tie broken by nodeId)