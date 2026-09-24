'use strict';

const assert = require('node:assert/strict');

async function run(cases, name, { write = line => console.error(line), setup = async () => {}, cleanup = async () => {} } = {}) {
  const names = cases.map(item => item.name);
  const usage = `Usage: --case NAME | --scenario NAME; available: ${names.join(', ')}`;
  if (new Set(names).size !== names.length) {
    write(`SETUP_ERROR duplicate registration; ${usage}`);
    return { exitCode: 2, assertions: 0 };
  }
  const selected = cases.find(item => item.name === name);
  if (!selected) {
    write(`SETUP_ERROR missing or unknown name; ${usage}`);
    return { exitCode: 2, assertions: 0 };
  }
  let assertions = 0;
  let setupComplete = false;
  let failure = null;
  try {
    const extra = await setup();
    setupComplete = true;
    await selected.run({
      ...(extra || {}),
      assert(value, message) {
        assert.ok(value, message);
        assertions += 1;
      }
    });
    assert.ok(assertions > 0, 'case did not execute an assertion');
  } catch (error) {
    failure = { error, marker: setupComplete && error instanceof assert.AssertionError ? 'ASSERTION_FAIL' : 'SETUP_ERROR' };
  } finally {
    try { await cleanup(); } catch (error) { failure = { error, marker: 'SETUP_ERROR cleanup' }; }
  }
  if (failure) {
    write(`${failure.marker} case=${name} assertions=${assertions} ${failure.error.message}`);
    return { exitCode: failure.marker === 'ASSERTION_FAIL' ? 1 : 2, assertions };
  }
  write(`PASS case=${name} assertions=${assertions}`);
  return { exitCode: 0, assertions };
}

module.exports = { run };
