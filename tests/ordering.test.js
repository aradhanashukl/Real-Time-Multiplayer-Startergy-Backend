const { createOrderer } = require('../src/ordering');

const o = createOrderer();
console.log(o.accept(2, 'B'));     // expect []  (held, waiting for 1)
console.log(o.accept(3, 'C'));     // expect []  (held)
console.log(o.accept(1, 'A'));     // expect [ 'A', 'B', 'C' ]
console.log(o.accept(2, 'B'));     // expect []  (duplicate)
console.log(o.accept(4, 'D'));     // expect [ 'D' ]
console.log(o.accept(500, 'X'));   // expect []  (too far ahead)