'use strict';
// Product-only, pre-start SQLite constructor/write audit. No paths or SQL are persisted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { isMainThread, threadId, workerData } = require('node:worker_threads');

const tracePath = process.env.DOCULIGHT_S23D_TRACE;
const sourceHash = process.env.DOCULIGHT_S23D_SOURCE_HASH;
if (tracePath && sourceHash) {
  const role = isMainThread ? 'main' : workerData?.documentCancelBuffer ? 'owner'
    : workerData?.jobId && workerData?.kind ? 'short'
      : workerData?.ledgerPath && workerData?.keywordPath ? 'checker' : 'other-worker';
  const originalLoad = Module._load;
  const wrapped = new WeakMap();
  function caller() {
    return String(new Error().stack || '').split(/\r?\n/).slice(2)
      .map(line => /(?:\(|\s)([^()\s]+\.[cm]?js:\d+:\d+)\)?$/.exec(line)?.[1] || '')
      .filter(Boolean).map(line => path.basename(line)).filter(line => !line.startsWith('sqlite-audit-preload.cjs'))
      .slice(0, 4);
  }
  function record(event) {
    fs.appendFileSync(tracePath, `${JSON.stringify({ sourceHash, pid: process.pid, threadId, role,
      ...event })}\n`);
  }
  Module._load = function auditLoad(request, parent, isMain) {
    const Database = originalLoad.call(this, request, parent, isMain);
    if (request !== 'better-sqlite3'
      && !/[\\/]node_modules[\\/]better-sqlite3(?:[\\/]|$)/.test(request)) return Database;
    if (typeof Database !== 'function') return Database;
    if (wrapped.has(Database)) return wrapped.get(Database);
    class AuditedDatabase extends Database {
      constructor(file, options = {}) {
        const basename = path.basename(String(file));
        const tracked = basename === 'smart-search.sqlite3'
          || basename === 'search-index.sqlite3'
          || /^search-index\.sqlite3\.backup-clear-[a-f0-9-]+\.sqlite3$/.test(basename);
        const readOnly = options.readonly === true;
        const openedBy = caller();
        const verbose = tracked ? sql => {
          const normalized = String(sql).trim();
          const pragma = /^PRAGMA\s+([^;=]+?)\s*=/i.exec(normalized)?.[1].trim().toLowerCase();
          const operation = /^(?:WITH\b|INSERT\b|UPDATE\b|DELETE\b|REPLACE\b|CREATE\b|DROP\b|ALTER\b|VACUUM\b|REINDEX\b|ANALYZE\b|BEGIN\b|COMMIT\b|ROLLBACK\b|SAVEPOINT\b|RELEASE\b)/i.exec(normalized)?.[0].toUpperCase();
          if (operation || pragma) record({ type: pragma ? 'pragma_assignment' : 'write',
            dbBasename: basename, readOnly, operation: operation || 'PRAGMA',
            pragmaName: pragma || undefined,
            sqlSha256: crypto.createHash('sha256').update(normalized).digest('hex'), caller: openedBy });
          if (typeof options.verbose === 'function') options.verbose(sql);
        } : options.verbose;
        if (tracked) record({ type: 'open_attempt', dbBasename: basename, readOnly, caller: openedBy });
        try {
          super(file, tracked ? { ...options, verbose } : options);
        } catch (error) {
          if (tracked) record({ type: 'open_failed', dbBasename: basename, readOnly,
            code: typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
              ? error.code : 'SQLITE_OPEN_FAILED', caller: openedBy });
          throw error;
        }
        if (tracked) record({ type: 'open', dbBasename: basename, readOnly, caller: openedBy });
      }
    }
    wrapped.set(Database, AuditedDatabase);
    return AuditedDatabase;
  };
}
