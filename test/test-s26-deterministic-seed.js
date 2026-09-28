'use strict';
const assert = require('node:assert/strict');
const { fixtureMarkers } = require('./r3/scenarios/s26.cjs');

// @req FR-DOC-033 AC-11 FR-DOC-019 AC-7 DR-DOC-014 AC-9
assert.equal(typeof fixtureMarkers, 'function', 'S26 exposes a deterministic fixture selector');
const seed = '2600010000000001';
assert.deepEqual(fixtureMarkers(seed), {
  marker: `s26${seed}`,
  oldMarker: `zzzxq${seed}`,
  newMarker: `qqqjz${seed}`
}, 'explicit S26 seed fixes every search marker before a cold run');
assert.throws(() => fixtureMarkers('../unsafe'), /invalid S26 seed/,
  'series seed rejects path-like input');
const randomA = fixtureMarkers();
const randomB = fixtureMarkers();
assert.notEqual(randomA.marker, randomB.marker,
  'ordinary S26 runs retain independent random markers');
console.log('test-s26-deterministic-seed: all assertions passed');
