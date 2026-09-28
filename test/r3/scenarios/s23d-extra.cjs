'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { helpers } = require('./s26.cjs');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// @req FR-DOC-019 AC-6,AC-10 DR-DOC-014 REL-DOC-009 IR-APP-013 AC-15
async function runExtra({ context, fixture, tracePath }) {
  const { executable, root, sourceHash, assert } = context;
  const { userData, store, marker } = fixture;
  const bodyMarker = `${marker}seed`;
  const ledgerPath = path.join(userData, 'index', 'smart-search.sqlite3');
  const keywordPath = path.join(userData, 'index', 'search-index.sqlite3');
  const outcomes = {};
  const runs = [];
  const writerExpectedPids = [];
  let attemptedRoute = 'baseline';
  let child = null;
  let ipcPath = '';

  async function start(name, options = {}) {
    ipcPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\doculight-s23d-${crypto.randomBytes(8).toString('hex')}`
      : path.join(fixture.fixture, `${name}.sock`);
    const env = { ...process.env, DOCULIGHT_PROFILE: 'dev', DOCULIGHT_DEV_USER_DATA_DIR: userData,
      DOCULIGHT_DEV_IPC_PATH: ipcPath, DOCULIGHT_R3_TEST_LIFECYCLE: '1',
      DOCULIGHT_S23D_TRACE: tracePath, DOCULIGHT_S23D_SOURCE_HASH: sourceHash,
      DOCULIGHT_S23D_FAULT_PRECOMMIT: options.fault ? '1' : '0',
      DOCULIGHT_S23D_PAGE_DELAY_MS: String(options.pageDelayMs || 0),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${path.join(root, 'test/r3/sqlite-audit-preload.cjs')}`.trim() };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.DOCULIGHT_S23D_PRODUCT_TRACE;
    delete env.DOCULIGHT_S23D_ROUTE_EVIDENCE;
    child = spawn(executable, [root, '--profile=dev', '--r3-test-lifecycle'], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
    });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const port = await helpers.until(`${name} cold product`, 20000, async () => {
      if (child.exitCode !== null) throw new Error(`${name} exited ${child.exitCode}: ${output.slice(-500)}`);
      const portFile = path.join(userData, 'mcp-port');
      if (!fs.existsSync(portFile)) return null;
      const candidate = Number(fs.readFileSync(portFile, 'utf8'));
      if (!Number.isInteger(candidate)) return null;
      try { return (await helpers.rpc(candidate, 'ping')).result ? candidate : null; }
      catch { return null; }
    });
    const pid = child.pid;
    runs.push({ name, pid, port, expectedWriter: options.corrupt !== true });
    if (!options.corrupt) writerExpectedPids.push(pid);
    return port;
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const quit = await helpers.privateAction(ipcPath, 'r3_test_graceful_quit');
    assert(quit.result?.accepted === true && await helpers.waitForExit(child, 10000) === 0,
      'S23d cold product exits through its owned private lifecycle');
    child = null;
  }
  async function action(name) {
    return (await helpers.privateAction(ipcPath, name)).result;
  }
  async function jobStatus(jobId, desired, timeout = 20000) {
    return helpers.eventually(timeout, () => {
      const row = helpers.ledgerSnapshot(executable, root, ledgerPath).jobs.find(job => job.jobId === jobId);
      return row?.status === desired ? row : null;
    }, 100);
  }
  function keyword() { return helpers.keywordSnapshot(executable, root, keywordPath, store, bodyMarker); }
  function ledger() { return helpers.ledgerSnapshot(executable, root, ledgerPath); }
  const stable = snapshot => sha(JSON.stringify({ docs: snapshot.docs, aliases: snapshot.aliases }));
  try {
    const port = await start('baseline');
    const rebuilt = await helpers.eventually(60000, async () => {
      const response = await action('r3_test_settings_rebuild');
      return response.started === true ? response : null;
    }, 500);
    assert(rebuilt.started === true && rebuilt.scheduled === true && Boolean(rebuilt.jobId)
      && await jobStatus(rebuilt.jobId, 'completed'),
    'S23d real Settings rebuild commits a generation');
    const committed = keyword();
    const facts = ledger();
    const stableHash = stable(facts);
    assert(committed.hitCount > 0 && committed.generation && committed.logicalChecksum,
      'S23d committed generation has logical checksum and body-only hit');
    const noneCompact = await action('r3_test_settings_compact');
    assert(noneCompact.started === false && noneCompact.compacted === false
      && noneCompact.reason === 'compact-rebuild-required'
      && JSON.stringify(keyword()) === JSON.stringify(committed)
      && stable(ledger()) === stableHash,
    'S23d real NONE-mode compact preserves committed generation and source facts');
    outcomes.baseline = { generation: committed.generation, logicalChecksum: committed.logicalChecksum,
      bodyHit: committed.hitCount, compactReason: noneCompact.reason,
      sourceFactsSha256: stableHash, publicSearchHit: helpers.hasSearchHit(
        await helpers.tool(port, 'search_documents', { query: bodyMarker }), bodyMarker) };
    assert(outcomes.baseline.publicSearchHit, 'S23d public keyword search retains committed body-only hit');
    await stop();

    attemptedRoute = 'incremental-compact';
    const modeScript = `const D=require('better-sqlite3');const db=new D(process.env.S23D_KEYWORD);
      db.pragma('auto_vacuum = INCREMENTAL');db.exec('VACUUM');db.close();`;
    const changedMode = spawnSync(executable, ['-e', modeScript], { cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', S23D_KEYWORD: keywordPath },
      encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert(changedMode.status === 0, 'S23d isolated offline fixture enters incremental vacuum mode');
    await start('incremental-compact');
    const beforeDeferred = keyword();
    const deferred = await action('r3_test_settings_compact');
    assert(deferred.started === false && deferred.compacted === false
      && deferred.reason === 'compact-deferred'
      && beforeDeferred.logicalChecksum === keyword().logicalChecksum
      && stable(ledger()) === stableHash,
    'S23d real non-NONE compact is deferred without claiming reclamation or losing facts');
    outcomes.incrementalCompact = { reason: deferred.reason,
      logicalChecksum: beforeDeferred.logicalChecksum };
    await stop();

    attemptedRoute = 'precommit-fault';
    await start('precommit-fault', { fault: true });
    const beforeFault = keyword();
    const failed = await action('r3_test_settings_rebuild');
    assert(failed.started === true && failed.jobId && await jobStatus(failed.jobId, 'failed'),
      'S23d product Settings rebuild reaches injected precommit failure');
    const afterFault = keyword();
    assert(afterFault.generation === beforeFault.generation
      && afterFault.logicalChecksum === beforeFault.logicalChecksum
      && afterFault.hitCount > 0 && stable(ledger()) === stableHash,
    'S23d failed rebuild preserves prior generation, body hit, IDs, and aliases');
    outcomes.precommitFault = { jobStatus: 'failed', generation: afterFault.generation,
      logicalChecksum: afterFault.logicalChecksum, bodyHit: afterFault.hitCount };
    await stop();

    attemptedRoute = 'retry-success';
    const retryPort = await start('retry-success');
    const retried = await helpers.eventually(15000, async () => {
      const response = await action('r3_test_settings_retry');
      return response.started === true ? response : null;
    }, 100);
    assert(retried.started === true && retried.jobId && await jobStatus(retried.jobId, 'completed'),
      'S23d real Settings retry completes after precommit failure');
    const afterRetry = keyword();
    assert(afterRetry.generation !== beforeFault.generation && afterRetry.hitCount > 0
      && stable(ledger()) === stableHash
      && helpers.hasSearchHit(await helpers.tool(retryPort, 'search_documents', { query: bodyMarker }), bodyMarker),
    'S23d retry commits a new generation without losing identity or public body hit');
    outcomes.retry = { jobStatus: 'completed', generation: afterRetry.generation,
      logicalChecksum: afterRetry.logicalChecksum, bodyHit: afterRetry.hitCount };
    await stop();

    attemptedRoute = 'rebuild-cancel';
    for (let i = 0; i < 96; i += 1) fs.writeFileSync(path.join(store, `s23d-cancel-${i}.md`),
      `# Cancel ${i}\n\ns23dcancelcandidate${i}\n`);
    await start('rebuild-cancel', { pageDelayMs: 30 });
    const beforeCancel = keyword();
    const cancelling = await action('r3_test_settings_rebuild');
    assert(cancelling.started === true && cancelling.jobId,
      'S23d product Settings rebuild starts staged work for cancel');
    const active = await helpers.eventually(15000, async () => {
      const status = (await helpers.privateAction(ipcPath, 'r3_test_owner_snapshot')).result;
      return status?.kind === 'rebuild' && status.active && status.progress?.current >= 16 ? status : null;
    }, 20);
    assert(active, 'S23d product rebuild reaches a bounded staged page');
    const cancelled = await action('r3_test_settings_cancel');
    const cancelledJob = await jobStatus(cancelling.jobId, 'cancelled');
    console.error(`S23D_CANCEL_ROUTE ${JSON.stringify({ cancelled: cancelled.cancelled,
      reason: cancelled.reason || null, terminal: Boolean(cancelledJob) })}`);
    assert(cancelled.cancelled === true && cancelledJob,
      'S23d real Settings cancel terminates staged rebuild');
    const afterCancel = keyword();
    assert(afterCancel.generation === beforeCancel.generation
      && afterCancel.logicalChecksum === beforeCancel.logicalChecksum
      && afterCancel.hitCount > 0 && stable(ledger()) === stableHash,
    'S23d rebuild cancel keeps committed generation, source facts, and body hit');
    outcomes.rebuildCancel = { jobStatus: 'cancelled', generation: afterCancel.generation,
      logicalChecksum: afterCancel.logicalChecksum, bodyHit: afterCancel.hitCount };
    await stop();

    attemptedRoute = 'source-corrupt-check';
    const sourceBytes = fs.readFileSync(ledgerPath);
    fs.writeFileSync(ledgerPath, 'not a SQLite database');
    const corruptPort = await start('source-corrupt-check', { corrupt: true });
    const sourceState = await helpers.eventually(10000, async () => {
      const result = await action('r3_test_owner_snapshot');
      return result?.state === 'CORRUPT_DEGRADED' ? result : null;
    }, 50);
    assert(sourceState, 'S23d cold product detects corrupt source before writable open');
    const sourceCheck = await action('r3_test_settings_retry_check');
    assert(sourceCheck.started === true && sourceCheck.scheduled === true && !sourceCheck.jobId,
      'S23d corrupt source accepts ephemeral Settings read-only retry-check');
    const sourceChecked = await helpers.eventually(10000, async () => {
      const state = await action('r3_test_owner_snapshot');
      return state?.state === 'CORRUPT_DEGRADED' && state?.diagnostic?.code === 'source_ledger_corrupt'
        ? state : null;
    }, 50);
    assert(sourceChecked && sha(fs.readFileSync(ledgerPath)) === sha(Buffer.from('not a SQLite database')),
      'S23d failed source retry-check preserves corruption evidence without writes');
    outcomes.sourceRetryCheck = { started: true, terminalState: sourceChecked.state,
      diagnosticCode: sourceChecked.diagnostic.code };
    assert(sourceChecked.active === false, 'S23d source-corrupt owner exits before offline repair');
    attemptedRoute = 'keyword-corrupt-check';
    fs.writeFileSync(ledgerPath, sourceBytes);
    assert(stable(ledger()) === stableHash, 'S23d offline source restoration retains IDs and aliases');
    const keywordBytes = fs.readFileSync(keywordPath);
    const corruptKeywordBytes = Buffer.from('not a SQLite database');
    fs.writeFileSync(keywordPath, corruptKeywordBytes);
    const keywordCheck = await action('r3_test_settings_retry_check');
    assert(keywordCheck.started === true && keywordCheck.scheduled === true && !keywordCheck.jobId,
      'S23d restored source permits real Settings read-only keyword retry-check');
    const keywordChecked = await helpers.eventually(10000, async () => {
      const state = await action('r3_test_owner_snapshot');
      return state?.state === 'INTERRUPTED' && state?.diagnostic?.code === 'keyword_index_corrupt'
        ? state : null;
    }, 50);
    const corruptSearch = await helpers.tool(corruptPort, 'search_documents', { query: bodyMarker });
    assert(keywordChecked && stable(ledger()) === stableHash
      && sha(fs.readFileSync(ledgerPath)) === sha(sourceBytes)
      && sha(fs.readFileSync(keywordPath)) === sha(corruptKeywordBytes)
      && !helpers.hasSearchHit(corruptSearch, bodyMarker),
    'S23d failed keyword retry-check preserves source facts and corrupt bytes while search fails closed');
    outcomes.keywordRetryCheck = { started: true, terminalState: keywordChecked.state,
      diagnosticCode: keywordChecked.diagnostic.code,
      sourceFactsSha256: stableHash, sourceBytesSha256: sha(sourceBytes),
      keywordCorruptSha256: sha(corruptKeywordBytes), publicSearchHit: false };
    await stop();
    fs.writeFileSync(keywordPath, keywordBytes);
    return { runs, writerExpectedPids, outcomes, attemptedRoute: 'complete',
      attemptedOutcome: 'passed' };
  } catch (error) {
    error.s23dRoute = { runs, writerExpectedPids, outcomes, attemptedRoute,
      attemptedOutcome: 'failed' };
    throw error;
  } finally {
    if (child && child.exitCode === null) child.kill();
  }
}

module.exports = { runExtra };
