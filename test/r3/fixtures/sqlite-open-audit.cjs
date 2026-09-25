'use strict';

// @req FR-DOC-019 AC-6 AC-10
// Load with NODE_OPTIONS before Electron startup; each worker inherits the hook.
const fs = require('node:fs');
const Module = require('node:module');
const { threadId } = require('node:worker_threads');
const originalLoad = Module._load;
const instrumented = new WeakMap();

Module._load = function auditedLoad(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request !== 'better-sqlite3' || typeof loaded !== 'function') return loaded;
  const file = process.env.DOCULIGHT_SQLITE_AUDIT_FILE;
  if (!file) return loaded;
  if (instrumented.has(loaded)) return instrumented.get(loaded);
  class AuditedDatabase extends loaded {
    constructor(dbPath, options) {
      const stack = new Error().stack || '';
      const event = { pid: process.pid, threadId, processType: process.type || 'node',
        dbPath: String(dbPath), readOnly: options?.readonly === true,
        caller: stack.split(/\r?\n/).slice(2, 7).map(line => line.trim()) };
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
      super(dbPath, options);
    }
  }
  instrumented.set(loaded, AuditedDatabase);
  return AuditedDatabase;
};
