'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { threadId, Worker } = require('node:worker_threads');
const { OwnerWorkerController } = require('../../../src/main/search-index-worker-controller');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { SQLiteKeywordIndex } = require('../../../src/main/search-sqlite-store');
const { createKeywordTokenizer } = require('../../../src/main/search-tokenizer');
const Module = require('node:module');

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = {
  name: 's06',
  async run(context) {
    context.assert(typeof OwnerWorkerController === 'function', 'FR-DOC-019 owner controller exists');
    const root = context.fixture.root;
    const sourceRoot = path.join(root, 'store');
    fs.mkdirSync(sourceRoot);
    const saved = path.join(sourceRoot, 'saved.md');
    const imported = path.join(sourceRoot, 'imported.md');
    fs.writeFileSync(saved, '# saved\n');
    fs.writeFileSync(imported, '# imported\n');
    const config = { ledgerPath: path.join(root, 'smart-search.sqlite3'), keywordPath: path.join(root, 'search-index.sqlite3'), sourceRoot };
    const fixtureLedger = new SourceLedgerStore({ dbPath: config.ledgerPath, userDataDir: root });
    fixtureLedger.initialize();
    const source = fixtureLedger.recordSource({ rootPathInternal: sourceRoot, rootFingerprint: 's06-root' });
    const importRow = fixtureLedger.upsertDocument({ sourceId: source.sourceId, sourceRelativePath: 'imported.md',
      canonicalPathInternal: imported, contentHash: 'sha256:fixture' });
    fixtureLedger.close();
    let mainSqliteLoadCount = 0;
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === 'better-sqlite3') mainSqliteLoadCount += 1;
      return originalLoad.call(this, request, parent, isMain);
    };
    const owner = new OwnerWorkerController(config);
    let oldWorkerToTerminate = null;
    try {
      const ready = await owner.start();
      context.assert(ready.threadId > 0 && ready.threadId !== threadId, 'both databases open in worker thread');
      context.assert(ready.audit.ledgerOpenThreadId === ready.threadId && ready.audit.keywordOpenThreadId === ready.threadId,
        'REL-DOC-007 one owner opens both databases');
      context.assert(ready.audit.openCount === 2 && mainSqliteLoadCount === 0, 'owner route opens both DBs only in worker');
      const status = owner.getStatus();
      context.assert(status.state === 'stale' && status.diagnostic?.code === 'keyword_index_missing' && status.sequence > 0,
        'FR-DOC-019 fresh keyword cache is stale without automatic rebuild');
      context.assert(!JSON.stringify(status).includes(root), 'cached status omits raw database and source paths');
      const [query, origin] = await Promise.all([
        owner.query('query_keyword', { query: 'saved' }, 'query-1'),
        owner.query('resolve_origin', { documentId: 'missing' }, 'origin-1')
      ]);
      context.assert(Array.isArray(query) && origin === null, 'registered read queries return bounded results');
      const queriedStatus = await owner.query('get_status', {}, 'status-1');
      context.assert(queriedStatus.state === status.state && queriedStatus.diagnostic?.code === status.diagnostic.code,
        'get_status returns canonical worker snapshot');
      const unknown = await owner.command('unknown', {}, 'unknown-1').catch(error => error);
      context.assert(unknown.code === 'owner_unknown_type', 'unknown type returns stable protocol error');
      const first = owner.query('get_status', {}, 'duplicate-1');
      const duplicate = await owner.query('get_status', {}, 'duplicate-1').catch(error => error);
      await first;
      context.assert(duplicate.code === 'owner_duplicate_id', 'duplicate id is rejected');
      const malformedId = await Promise.race([
        owner.query('get_status', {}, { invalid: true }).catch(error => error),
        new Promise(resolve => setTimeout(() => resolve('timed-out'), 100))
      ]);
      context.assert(malformedId.code === 'owner_invalid_id', 'object request id settles with stable validation error');
      const cancel = await owner.cancel('missing-job', 'cancel-1');
      context.assert(cancel.cancelled === false, 'cancel of absent job is bounded');
      const oldWorker = owner.worker;
      oldWorkerToTerminate = oldWorker;
      oldWorker.emit('error', new Error('simulated worker crash before exit'));
      const replacement = owner.start();
      context.assert(owner.worker === oldWorker, 'restart waits for errored worker exit before replacement');
      await oldWorker.terminate();
      oldWorkerToTerminate = null;
      await replacement;
      context.assert(owner.getStatus().state === 'stale', 'late old-worker exit cannot fail replacement');
      const beforeCrashSequence = owner.getStatus().sequence;
      await owner.worker.terminate();
      context.assert(owner.getStatus().state === 'failed', 'worker crash marks cached status failed');
      const restarted = await owner.start();
      context.assert(restarted.threadId > 0 && restarted.audit.ledgerOpenThreadId === restarted.threadId, 'restart opens owner databases');
      context.assert(owner.getStatus().state === 'stale' && owner.getStatus().sequence > beforeCrashSequence,
        'restart publishes fresh cached status with monotonic sequence');
      const restartedStatus = await owner.query('get_status', {}, 'restart-status');
      context.assert(restartedStatus.sequence === owner.getStatus().sequence && restartedStatus.state === owner.getStatus().state,
        'get_status sequence matches cached STATUS after worker restart');
      const recovered = await owner.query('resolve_origin', { documentId: importRow.documentId }, 'recovered-import');
      context.assert(recovered && recovered.documentId === importRow.documentId, 'restart retains completed import ledger identity');
      const recoveredByPath = await owner.query('resolve_origin', { filePath: imported }, 'recovered-import-path');
      context.assert(recoveredByPath && recoveredByPath.documentId === recovered.documentId,
        'private indexed filePath resolves same document identity');
      context.assert(normalizedPath(recoveredByPath.indexedPathInternal) === normalizedPath(imported),
        'private indexed filePath resolves contained fixture path');
      context.assert(normalizedPath(recoveredByPath.indexedPathInternal) === normalizedPath(recovered.indexedPathInternal),
        'private indexed filePath resolves same indexed copy path');
      context.assert(normalizedPath(recoveredByPath.sourceRootInternal) === normalizedPath(sourceRoot)
        && recoveredByPath.sourceRelativePath === 'imported.md',
        'private indexed filePath resolves same source root and relative locator');
      context.assert(fs.readFileSync(saved, 'utf8') === '# saved\n' && fs.readFileSync(imported, 'utf8') === '# imported\n',
        'restart preserves saved file and completed import');
      let shutdownWire = null;
      const activeWorker = owner.worker;
      const originalPostMessage = activeWorker.postMessage;
      activeWorker.postMessage = function(message, ...args) {
        if (message.type === 'shutdown') shutdownWire = message;
        return originalPostMessage.call(this, message, ...args);
      };
      const shutdownResult = await owner.command('shutdown', {}, 'shutdown-command');
      context.assert(shutdownWire && shutdownWire.tag === 'COMMAND' && shutdownWire.id === 'shutdown-command'
        && shutdownResult.shutdown === true, 'COMMAND shutdown keeps caller id and RESULT');
      context.assert(owner.getStatus().state === 'shutdown', 'registry shutdown leaves cached status terminal');
      const late = await owner.command('get_status', {}, 'late-1').catch(error => error);
      context.assert(late.code === 'owner_shutdown', 'shutdown race rejects new commands');
      const oldRoot = path.join(root, 'old-root');
      fs.mkdirSync(oldRoot);
      const oldIndexPath = path.join(root, 'old-keyword.sqlite3');
      const oldIndex = new SQLiteKeywordIndex({ dbPath: oldIndexPath, sourceRoot: oldRoot });
      oldIndex.rebuild([{ filePath: path.join(oldRoot, 'old.md'), meta: { title: 'oldrootneedle' }, body: 'oldrootneedle' }],
        { skipBackup: true });
      context.assert(oldIndex.search('oldrootneedle').length === 1, 'mismatched-root fixture has committed searchable hit');
      oldIndex.close();
      const mismatched = new OwnerWorkerController({ ...config, keywordPath: oldIndexPath });
      try {
        await mismatched.start();
        const oldHits = await mismatched.query('query_keyword', { query: 'oldrootneedle' }, 'old-root-query');
        context.assert(mismatched.getStatus().state === 'stale' && oldHits.length === 0,
          'mismatched source root is stale before query and does not expose old-root hits');
      } finally {
        await mismatched.shutdown();
      }
      const noRoot = new OwnerWorkerController({ ...config, sourceRoot: '', keywordPath: oldIndexPath });
      try {
        await noRoot.start();
        const oldHits = await noRoot.query('query_keyword', { query: 'oldrootneedle' }, 'unset-root-query');
        context.assert(noRoot.getStatus().state === 'stale' && noRoot.getStatus().diagnostic?.code === 'keyword_source_not_configured'
          && oldHits.length === 0, 'unset source root never exposes committed old-root hits');
      } finally {
        await noRoot.shutdown();
      }
      const garu = createKeywordTokenizer({ provider: 'garu' });
      await garu.initialize();
      context.assert(garu.getStatus().provider === 'garu-ko', 'real garu tokenizer is available in runtime');
      const garuPath = path.join(root, 'garu-keyword.sqlite3');
      const garuIndex = new SQLiteKeywordIndex({ dbPath: garuPath, sourceRoot, tokenizer: garu });
      garuIndex.rebuild([{ filePath: saved, meta: { title: 'garumatch' }, body: 'garumatch' }], { skipBackup: true });
      garuIndex.close();
      const garuOwner = new OwnerWorkerController({ ...config, keywordPath: garuPath, keywordTokenizerProvider: 'garu' });
      try {
        await garuOwner.start();
        const hits = await garuOwner.query('query_keyword', { query: 'garumatch' }, 'garu-query');
        context.assert(garuOwner.getStatus().state === 'ready' && hits.length === 1,
          'matching real garu committed cache remains queryable');
      } finally {
        await garuOwner.shutdown();
      }
      const wrongTokenizer = new OwnerWorkerController({ ...config, keywordPath: garuPath, keywordTokenizerProvider: 'basic' });
      try {
        await wrongTokenizer.start();
        const hits = await wrongTokenizer.query('query_keyword', { query: 'garumatch' }, 'wrong-tokenizer-query');
        context.assert(wrongTokenizer.getStatus().diagnostic?.code === 'keyword_tokenizer_mismatch' && hits.length === 0,
          'true tokenizer mismatch remains stale');
      } finally {
        await wrongTokenizer.shutdown();
      }
      const racing = new OwnerWorkerController(config);
      await racing.start();
      const racingWorker = racing.worker;
      const inFlight = racing.query('get_status', {}, 'race-query');
      const closing = racing.shutdown();
      const settled = await Promise.allSettled([inFlight, closing]);
      context.assert(settled.every(item => item.status === 'fulfilled' || item.reason?.code === 'owner_shutdown')
        && racing.worker === null && racingWorker !== racing.worker,
        'in-flight query and shutdown settle without spawning a second owner');
      const afterClose = await racing.query('get_status', {}, 'race-late').catch(error => error);
      context.assert(afterClose.code === 'owner_shutdown', 'controller rejects query after shutdown begins');
      const raw = new Worker(path.join(__dirname, '../../../src/main/search-owner-worker.js'));
      const rawMessages = [];
      let rawError = null;
      raw.on('message', message => rawMessages.push(message));
      raw.on('error', error => { rawError = error; });
      try {
        await new Promise(resolve => setTimeout(resolve, 30));
        context.assert(rawError === null && rawMessages.length === 0, 'owner waits for START(ownerConfig) envelope');
        raw.postMessage({ tag: 'START', ownerConfig: config });
        const readyByEnvelope = await Promise.race([
          new Promise(resolve => raw.on('message', message => {
            if (message.tag === 'START') resolve(message);
          })),
          new Promise(resolve => setTimeout(() => resolve(null), 1000))
        ]);
        context.assert(readyByEnvelope && readyByEnvelope.state === 'ready', 'START handshake migrates and publishes READY');
        raw.postMessage({ tag: 'COMMAND', id: 'raw-unknown', type: 'unknown', payload: {} });
        const unknownByEnvelope = await Promise.race([
          new Promise(resolve => raw.on('message', message => {
            if (message.tag === 'RESULT' && message.id === 'raw-unknown') resolve(message);
          })), new Promise(resolve => setTimeout(() => resolve(null), 1000))
        ]);
        context.assert(unknownByEnvelope?.error?.code === 'owner_unknown_type', 'raw unknown command gets stable RESULT');
        raw.postMessage({ tag: 'QUERY', id: 'raw-duplicate', type: 'get_status', payload: {} });
        raw.postMessage({ tag: 'QUERY', id: 'raw-duplicate', type: 'get_status', payload: {} });
        const duplicateResults = await Promise.race([
          new Promise(resolve => {
            const results = [];
            raw.on('message', message => {
              if (message.tag === 'RESULT' && message.id === 'raw-duplicate') {
                results.push(message);
                if (results.length === 2) resolve(results);
              }
            });
          }), new Promise(resolve => setTimeout(() => resolve([]), 1000))
        ]);
        context.assert(duplicateResults.length === 2 && duplicateResults[1].error?.code === 'owner_duplicate_id',
          'raw duplicate in-flight id gets correlated stable RESULT');
        raw.postMessage({ tag: 'CANCEL', id: 'raw-cancel', target: 'missing-job' });
        const cancelledByEnvelope = await Promise.race([
          new Promise(resolve => raw.on('message', message => {
            if (message.tag === 'RESULT' && message.id === 'raw-cancel') resolve(message);
          })),
          new Promise(resolve => setTimeout(() => resolve(null), 1000))
        ]);
        context.assert(cancelledByEnvelope && cancelledByEnvelope.value?.cancelled === false,
          'CANCEL uses top-level target and returns correlated RESULT');
        const shutdownResult = new Promise(resolve => raw.on('message', message => {
          if (message.tag === 'RESULT' && message.id === 'raw-shutdown') resolve(message);
        }));
        raw.postMessage({ tag: 'SHUTDOWN', id: 'raw-shutdown' });
        const terminal = await Promise.race([shutdownResult, new Promise(resolve => setTimeout(() => resolve(null), 1000))]);
        context.assert(terminal?.value?.shutdown === true, 'raw SHUTDOWN returns correlated terminal RESULT');
      } finally {
        await raw.terminate();
      }
      const brokenWorkerPath = path.join(root, 'broken-owner.cjs');
      fs.writeFileSync(brokenWorkerPath, 'process.exit(17);\n');
      const broken = new OwnerWorkerController({ ...config, workerPath: brokenWorkerPath });
      const startup = await Promise.race([
        broken.start().then(() => 'unexpected-ready', error => error.code),
        new Promise(resolve => setTimeout(() => resolve('timed-out'), 1000))
      ]);
      await broken.shutdown();
      context.assert(startup === 'owner_worker_failed', 'startup worker exit rejects without hanging');
    } finally {
      if (oldWorkerToTerminate) await oldWorkerToTerminate.terminate();
      await owner.shutdown();
      Module._load = originalLoad;
    }
  }
};
