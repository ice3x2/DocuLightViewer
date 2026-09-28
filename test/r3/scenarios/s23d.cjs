'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const s26 = require('./s26.cjs');
const { runExtra } = require('./s23d-extra.cjs');

// @req FR-DOC-019 AC-6,AC-10 IR-APP-013 AC-13,AC-15
module.exports = { name: 's23d', async run(context) {
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s23d-'));
  const tracePath = path.join(traceDir, 'sqlite-opens.jsonl');
  const routePath = path.join(traceDir, 's26-routes.json');
  process.env.DOCULIGHT_S23D_PRODUCT_TRACE = tracePath;
  process.env.DOCULIGHT_S23D_ROUTE_EVIDENCE = routePath;
  let fixture;
  let extra;
  let runError;
  try {
    fixture = await s26.run(context);
    extra = await runExtra({ context, fixture, tracePath });
  } catch (error) {
    runError = error;
  } finally {
    delete process.env.DOCULIGHT_S23D_PRODUCT_TRACE;
    delete process.env.DOCULIGHT_S23D_ROUTE_EVIDENCE;
  }
  const lines = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
  const events = lines.map(line => JSON.parse(line));
  const s26Evidence = fs.existsSync(routePath)
    ? JSON.parse(fs.readFileSync(routePath, 'utf8')) : null;
  const attempted = extra || runError?.s23dRoute;
  const productPids = new Set([...(s26Evidence?.runs || []), ...(attempted?.runs || [])]
    .map(run => run.pid).concat(s26Evidence?.secondaryPids || []));
  const artifactDir = path.resolve(__dirname, '../../../docs/analysis');
  const artifactStem = `2026-09-29-s23d-${context.sourceHash.slice(0, 12)}-${Date.now()}`;
  const rawPath = path.join(artifactDir, `${artifactStem}.jsonl`);
  const summaryPath = path.join(artifactDir, `${artifactStem}.json`);
  const routesPath = path.join(artifactDir, `${artifactStem}-routes.json`);
  if (fs.existsSync(tracePath)) fs.copyFileSync(tracePath, rawPath, fs.constants.COPYFILE_EXCL);
  if (s26Evidence) fs.copyFileSync(routePath, routesPath, fs.constants.COPYFILE_EXCL);
  const counts = Object.fromEntries([...new Set(events.map(event =>
    `${event.role}:${event.type}:${event.readOnly ? 'ro' : 'rw'}`))].sort()
    .map(key => [key, events.filter(event =>
      `${event.role}:${event.type}:${event.readOnly ? 'ro' : 'rw'}` === key).length]));
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: artifactDir,
    encoding: 'utf8' }).trim();
  let checkRoute = 'trace-binding';
  let failedCheckRoute;
  if (!runError) {
    try {
      context.assert(s26Evidence.sourceHash === context.sourceHash
        && events.length > 0 && events.every(event => event.sourceHash === context.sourceHash
          && productPids.has(event.pid) && Number.isInteger(event.threadId)
          && (['smart-search.sqlite3', 'search-index.sqlite3'].includes(event.dbBasename)
            || /^search-index\.sqlite3\.backup-clear-[a-f0-9-]+\.sqlite3$/.test(event.dbBasename))
          && Array.isArray(event.caller) && event.caller.every(frame => !/[\\/]/.test(frame))),
      'S23d trace is bound to one source hash, inspected product PIDs, and redacted DB/callers');
      checkRoute = 'main-constructor';
      context.assert(events.some(event => event.type === 'open' && event.role === 'main'),
        'S23d cold Electron main SQLite constructor trace exists before first route');
      checkRoute = 'owner-constructor';
      context.assert(events.some(event => event.type === 'open' && event.role === 'owner' && !event.readOnly),
        'S23d long owner has a positive writable SQLite constructor trace');
      checkRoute = 'writer-boundary';
      const connectionPragmas = new Set(['foreign_keys', 'busy_timeout', 'synchronous',
        'query_only', 'journal_mode']);
      context.assert(events.some(event => event.type === 'write' && event.role === 'owner')
        && events.every(event => event.role === 'owner'
          || (event.readOnly && event.type !== 'write'
            && (event.type !== 'pragma_assignment' || connectionPragmas.has(event.pragmaName)))),
      'S23d only long owner writes source or keyword SQLite across all product routes');
      checkRoute = 'writer-pids';
      const writerThreads = new Set(events.filter(event => event.type === 'open' && !event.readOnly)
        .map(event => `${event.pid}:${event.threadId}`));
      const expectedWriterPids = new Set([...s26Evidence.runs.map(run => run.pid),
        ...extra.writerExpectedPids]);
      context.assert(writerThreads.size === expectedWriterPids.size
        && [...expectedWriterPids].every(pid => [...writerThreads].some(writer => writer.startsWith(`${pid}:`)))
        && [...productPids].filter(pid => !expectedWriterPids.has(pid))
          .every(pid => ![...writerThreads].some(writer => writer.startsWith(`${pid}:`))),
      'S23d each healthy product lifetime has one writable owner and corrupt lifetimes have none');
    } catch (error) {
      runError = error;
      failedCheckRoute = checkRoute;
    }
  }
  fs.writeFileSync(summaryPath, `${JSON.stringify({ sourceHash: context.sourceHash,
    headSha, status: runError ? 'scenario_failed' : 'routes_completed',
    attemptedRoute: failedCheckRoute || attempted?.attemptedRoute || (s26Evidence ? 's23d-extra-setup' : 's26'),
    attemptedOutcome: runError ? 'failed' : 'passed',
    productPids: [...productPids], counts,
    readOnlyPragmaAssignments: events.filter(event => event.readOnly
      && event.type === 'pragma_assignment').map(event => ({
      role: event.role, dbBasename: event.dbBasename, pragmaName: event.pragmaName
    })),
    publicToolsCalled: s26Evidence?.publicToolsCalled || 0,
    routeEvidence: s26Evidence ? path.basename(routesPath) : null,
    extraRoutes: attempted?.outcomes || null,
    extraRuns: attempted?.runs || null,
    rawJsonl: fs.existsSync(rawPath) ? path.basename(rawPath) : null,
    rawSha256: fs.existsSync(rawPath)
      ? crypto.createHash('sha256').update(fs.readFileSync(rawPath)).digest('hex') : null
  }, null, 2)}\n`, { flag: 'wx' });
  console.error(`S23D_EVIDENCE ${summaryPath}`);
  if (runError) throw runError;
} };
