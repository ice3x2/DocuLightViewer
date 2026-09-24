'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { processIdentity, processLiveness } = require('./process-owner-identity');
const { acquireAtomicOwnerGate } = require('./atomic-owner-gate');

function busy() {
  const error = new Error('owner_busy');
  error.code = 'owner_busy';
  return error;
}

// @req FR-DOC-019 REL-DOC-009
function acquireOwnerLock(ledgerPath) {
  const lock = `${path.resolve(ledgerPath)}.owner.lock`;
  const token = crypto.randomUUID();
  const owner = { pid: process.pid, identity: processIdentity(process.pid), token };
  const temp = `${lock}.${token}.tmp`;
  const releaseGate = acquireAtomicOwnerGate(lock, busy);
  try {
    fs.writeFileSync(temp, JSON.stringify(owner), { flag: 'wx' });
    try { fs.linkSync(temp, lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try {
        if (!fs.lstatSync(lock).isFile()) throw busy();
        previous = JSON.parse(fs.readFileSync(lock, 'utf8'));
      } catch { throw busy(); }
      if (processLiveness(previous) !== 'dead') throw busy();
      const abandoned = `${lock}.${token}.abandoned`;
      try {
        fs.renameSync(lock, abandoned);
        const moved = JSON.parse(fs.readFileSync(abandoned, 'utf8'));
        if (moved.token !== previous.token || moved.pid !== previous.pid) throw busy();
        fs.unlinkSync(abandoned);
        fs.linkSync(temp, lock);
      } catch { throw busy(); }
    }
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    releaseGate();
  }
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (current.token === token && current.pid === process.pid) fs.unlinkSync(lock);
    } catch { /* A removed or replaced lock is never deleted by this owner. */ }
  };
}

module.exports = { acquireOwnerLock };
