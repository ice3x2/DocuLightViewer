'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// @req FR-DOC-019 AC-6,AC-10 IR-APP-013 AC-15
const extra = fs.readFileSync(path.join(__dirname, 'r3/scenarios/s23d-extra.cjs'), 'utf8');
const summary = fs.readFileSync(path.join(__dirname, 'r3/scenarios/s23d.cjs'), 'utf8');
assert(extra.includes('attemptedRoute') && extra.includes('error.s23dRoute'),
  'failed cold route carries its attempted name and completed outcomes');
assert(summary.includes('attemptedRoute:') && summary.includes('attemptedOutcome:'),
  'failure artifact names the attempted route and outcome');
console.log('test-s23d-failure-evidence-contract: all assertions passed');
