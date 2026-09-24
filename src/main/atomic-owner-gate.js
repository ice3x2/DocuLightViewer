'use strict';

const fs = require('node:fs');

// Every lock acquisition (including a free lock) must pass through this gate.
// An abandoned gate is deliberately fail-closed: deleting it by age would
// recreate the same live-owner takeover race it is meant to prevent.
function acquireAtomicOwnerGate(lockPath, busy) {
  const gatePath = `${lockPath}.recovery`;
  try { fs.mkdirSync(gatePath); }
  catch (error) {
    if (error.code === 'EEXIST') throw busy();
    throw error;
  }
  return () => fs.rmdirSync(gatePath);
}

module.exports = { acquireAtomicOwnerGate };
