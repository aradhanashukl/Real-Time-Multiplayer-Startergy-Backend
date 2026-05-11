/**
 * tests/run-tests.js — zero-dependency test runner
 *
 * WHY NOT JEST / MOCHA
 * External test runners are fine in production projects. Here we use a tiny
 * hand-rolled runner so you can see exactly how assertions work — no magic.
 * The runner collects every test file, runs them sequentially, and reports
 * pass/fail counts with coloured output.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Assertion helpers ─────────────────────────────────────────────────────────

let passed = 0, failed = 0, current = '';

function describe(name, fn) {
  current = name;
  console.log(`\n  ${name}`);
  fn();
}

function it(label, fn) {
  try {
    fn();
    console.log(`    \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } catch (err) {
    console.log(`    \x1b[31m✗\x1b[0m ${label}`);
    console.log(`      \x1b[31m${err.message}\x1b[0m`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n      Expected: ${e}\n      Got:      ${a}`);
}

function assertTrue(val, msg = 'Expected true') {
  if (!val) throw new Error(msg);
}

function assertFalse(val, msg = 'Expected false') {
  if (val) throw new Error(msg);
}

// Expose globally so test files can require without importing the runner
global.describe    = describe;
global.it          = it;
global.assertEqual = assertEqual;
global.assertTrue  = assertTrue;
global.assertFalse = assertFalse;

// ── Discover and run test files ───────────────────────────────────────────────

const testDir = __dirname;
const files   = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

console.log(`\n\x1b[1mRunning ${files.length} test file(s)...\x1b[0m`);

for (const file of files) {
  require(path.join(testDir, file));
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m`);
if (failed > 0) process.exit(1);
