'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { acquireOwnerLock } = require('../../../src/main/search-owner-lock');
const { publishSave, withPublicationGate } = require('../../../src/main/index-ingress-store');

// @req FR-DOC-019 REL-DOC-009 IR-APP-013 IR-APP-010
module.exports = { async run(context) {
  const root = context.fixture.root;
  const store = path.join(root, 'store');
  const ingress = path.join(root, 'ingress');
  fs.mkdirSync(store);
  fs.mkdirSync(ingress);
  const config = { ledgerPath: path.join(root, 'ledger.sqlite'),
    keywordPath: path.join(root, 'keyword.sqlite'), sourceRoot: store,
    ingressRoot: ingress, deriveDocuments: true };
  const first = new OwnerWorkerController(config);
  const second = new OwnerWorkerController(config);
  try {
    const ready = await first.start();
    context.assert(ready.state === 'ready', 'first owner starts');
    let rejected = false;
    try { await second.start(); } catch (error) { rejected = error.code === 'owner_busy'; }
    context.assert(rejected, 'second live controller cannot open the same ledger');
    context.assert(first.getStatus().state === 'ready' || first.getStatus().state === 'stale',
      'first owner remains available after duplicate rejection');
  } finally {
    await second.shutdown();
    await first.shutdown();
  }
  const third = new OwnerWorkerController(config);
  try {
    context.assert((await third.start()).state === 'ready', 'owner can restart after release');
  } finally { await third.shutdown(); }

  const child = fork(path.join(__dirname, '../fixtures/s20-owner-crash-child.cjs'),
    [JSON.stringify(config)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const childResult = await new Promise(resolve => {
    let ready = false;
    child.on('message', message => { if (message?.ready) ready = true; });
    child.on('exit', code => resolve({ ready, code }));
  });
  context.assert(childResult.ready && childResult.code === 0,
    'a separate owner process exits without graceful lock release');
  const afterCrash = new OwnerWorkerController(config);
  try {
    context.assert((await afterCrash.start()).state === 'ready',
      'dead owner process lock is recovered without altering saved files');
  } finally { await afterCrash.shutdown(); }

  const raceLedger = path.join(root, 'owner-race.sqlite');
  const raceLock = `${raceLedger}.owner.lock`;
  const stale = { pid: process.pid, identity: 'recycled-pid-old-start', token: 'old-race' };
  fs.writeFileSync(raceLock, JSON.stringify(stale));
  const rename = fs.renameSync;
  let injected = false;
  let aRelease = null;
  let aAcquired = false;
  fs.renameSync = function raceRename(from, to) {
    if (from === raceLock && !injected) {
      injected = true;
      fs.unlinkSync(raceLock);
      try {
        aRelease = acquireOwnerLock(raceLedger);
        aAcquired = true;
      } catch { fs.writeFileSync(raceLock, JSON.stringify(stale)); }
    }
    return rename.call(fs, from, to);
  };
  let bRelease = null;
  try { bRelease = acquireOwnerLock(raceLedger); }
  catch { /* A failed recovery must leave its live competitor protected. */ }
  finally { fs.renameSync = rename; }
  let cRejected = false;
  let cRelease = null;
  try { cRelease = acquireOwnerLock(raceLedger); }
  catch (error) { cRejected = error.code === 'owner_busy'; }
  if (cRelease) cRelease();
  if (bRelease) bRelease();
  if (aRelease) aRelease();
  context.assert(injected && !aAcquired && Boolean(bRelease) && cRejected,
    'serialized recovery rejects A between B stale-read and rename, then keeps C out');

  const publicationLock = path.join(ingress, '.publication.lock');
  fs.writeFileSync(publicationLock, JSON.stringify(stale));
  let publicationInjected = false;
  let aActionRelease = null;
  let bActionRelease = null;
  let aPublicationEntered = false;
  let bPublicationEntered = false;
  let cPublicationEntered = false;
  let aPublication;
  fs.renameSync = function publicationRaceRename(from, to) {
    if (from === publicationLock && !publicationInjected) {
      publicationInjected = true;
      fs.unlinkSync(publicationLock);
      aPublication = withPublicationGate(ingress, () => {
        aPublicationEntered = true;
        return new Promise(resolve => { aActionRelease = resolve; setTimeout(resolve, 100); });
      }).catch(error => ({ error }));
      if (!fs.existsSync(publicationLock)) fs.writeFileSync(publicationLock, JSON.stringify(stale));
    }
    return rename.call(fs, from, to);
  };
  let bPublication;
  try {
    bPublication = withPublicationGate(ingress, () => {
      bPublicationEntered = true;
      return new Promise(resolve => { bActionRelease = resolve; });
    }).catch(error => ({ error }));
  } finally { fs.renameSync = rename; }
  const cPublication = withPublicationGate(ingress, () => { cPublicationEntered = true; })
    .catch(error => ({ error }));
  await new Promise(resolve => setTimeout(resolve, 50));
  const publicationSafe = publicationInjected && !aPublicationEntered
    && bPublicationEntered && !cPublicationEntered;
  if (bActionRelease) bActionRelease();
  if (aActionRelease) aActionRelease();
  await Promise.allSettled([aPublication, bPublication, cPublication]);
  context.assert(publicationSafe,
    'publication recovery cannot move a new live lock or admit C while B holds it');

  const lock = `${config.ledgerPath}.owner.lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, identity: 'recycled-pid-old-start', token: 'old' }));
  const recovered = new OwnerWorkerController(config);
  try {
    context.assert((await recovered.start()).state === 'ready',
      'recycled PID with old process identity is safely recovered');
  } finally { await recovered.shutdown(); }

  const bytes = Buffer.from('# Recovered publication\n');
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(ingress, '.publication.lock'), JSON.stringify({
    pid: process.pid, identity: 'recycled-pid-old-start', token: 'old-publisher'
  }));
  let published = null;
  try {
    published = await publishSave({ storeRoot: store, ingressRoot: ingress,
      sourceRelativeLocator: 'recovered.md', operation: 'save_document', sourceId: 's20',
      rootFingerprint: digest(store), contentBytes: bytes, contentHash: digest(bytes),
      provenance: { aliases: [], metadata: {} } });
  } catch { /* Assertion below records an actual publication failure. */ }
  context.assert(Boolean(published?.intentId) && fs.existsSync(path.join(store, 'recovered.md'))
    && fs.readFileSync(path.join(store, 'recovered.md')).equals(bytes),
    'publication gate recovers recycled PID without losing Markdown');

  const barrier = new SharedArrayBuffer(4);
  const delayed = new OwnerWorkerController({ ...config, r3RecoveryBarrier: barrier });
  let readyBeforeRecovery = false;
  const starting = delayed.start().then(() => { readyBeforeRecovery = true; });
  await new Promise(resolve => setTimeout(resolve, 200));
  const observedReadyWhileBlocked = readyBeforeRecovery;
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0);
  try {
    await starting;
    context.assert(observedReadyWhileBlocked, 'owner publishes ready before first recovery page is unblocked');
  } finally { await delayed.shutdown(); }

  const db = new context.fixture.db.constructor(config.ledgerPath);
  const now = new Date().toISOString();
  const total = 3101;
  const insertSource = db.prepare('INSERT INTO sources(source_id,root_path_internal,root_fingerprint,created_at,updated_at) VALUES(?,?,?,?,?)');
  const insertDoc = db.prepare(`INSERT INTO documents(document_id,source_id,relative_path,path_key,
    content_hash,desired_revision,desired_content_hash,current_job_id,active_requested_revision,
    dirty,keyword_dirty,first_seen_at,last_seen_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertJob = db.prepare(`INSERT INTO index_jobs(job_id,source_id,document_id,job_type,status,
    content_hash,current_path_internal,created_at,heartbeat_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    insertSource.run('source-s20', store, digest(store), now, now);
    for (let i = 0; i < total; i += 1) {
      const id = `doc-${String(i).padStart(5, '0')}`;
      const job = `job-${String(i).padStart(5, '0')}`;
      const relative = `${id}.md`;
      const body = Buffer.from(`# ${id}\n`);
      fs.writeFileSync(path.join(store, relative), body);
      const contentHash = `sha256:${digest(body)}`;
      insertDoc.run(id, 'source-s20', relative, relative, contentHash, 1, contentHash,
        job, 1, 0, 1, now, now, now, now);
      insertJob.run(job, 'source-s20', id, 'index_document', 'indexing', contentHash,
        path.join(store, relative), now, now, now);
    }
  })();
  db.close();
  const backlogOwner = new OwnerWorkerController({ ...config, deriveDocuments: false });
  const startAt = Date.now();
  try {
    await backlogOwner.start();
    const readyMs = Date.now() - startAt;
    context.assert(readyMs < 3000, 'START-ready does not synchronously process 3101 pending jobs');
    const status = await backlogOwner.query('get_status');
    const cancel = await backlogOwner.cancel('nonexistent-s20-job');
    context.assert(status.state === 'stale' || status.state === 'ready',
      'cached status is available while backlog recovers');
    context.assert(cancel.cancelled === false, 'cancel is responsive during recovery');
    let recoveredCount = 0;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const reader = new context.fixture.db.constructor(config.ledgerPath, { readonly: true });
      recoveredCount = reader.prepare("SELECT count(*) AS n FROM index_jobs WHERE job_id LIKE 'job-%' AND status <> 'indexing'").get().n;
      reader.close();
      if (recoveredCount === total) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    context.assert(recoveredCount === total, 'all 3101 real SQLite pending jobs recover through bounded pages');
    console.error(`S20_STARTUP ready_ms=${readyMs} recovered=${recoveredCount} page_limit=32`);
  } finally { await backlogOwner.shutdown(); }

  const replayBytes = Buffer.from('# Pending replay\n');
  const replayPublished = await publishSave({ storeRoot: store, ingressRoot: ingress,
    sourceRelativeLocator: 'pending-replay.md', operation: 'save_document', sourceId: 's20',
    rootFingerprint: digest(store), contentBytes: replayBytes, contentHash: digest(replayBytes),
    provenance: { aliases: [], metadata: {} } });
  process.env.DOCULIGHT_S20_INGRESS_ROOT = ingress;
  const streamingOwner = new OwnerWorkerController({ ...config, deriveDocuments: false,
    workerPath: path.join(__dirname, '../fixtures/s20-owner-no-readdir.cjs') });
  try {
    await streamingOwner.start();
    let accepted = false;
    const replayDeadline = Date.now() + 2500;
    while (Date.now() < replayDeadline) {
      const reader = new context.fixture.db.constructor(config.ledgerPath, { readonly: true });
      accepted = Boolean(reader.prepare('SELECT 1 FROM save_intent_acceptances WHERE intent_id = ?')
        .get(replayPublished.intentId));
      reader.close();
      if (accepted) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    context.assert(accepted, 'private ingress replay accepts a saved intent without full directory materialization');
  } finally {
    await streamingOwner.shutdown();
    delete process.env.DOCULIGHT_S20_INGRESS_ROOT;
  }

  const legacyDb = new context.fixture.db.constructor(config.ledgerPath);
  const legacyInsertDoc = legacyDb.prepare(`INSERT INTO documents(document_id,source_id,relative_path,path_key,
    content_hash,desired_revision,desired_content_hash,current_job_id,active_requested_revision,
    dirty,keyword_dirty,first_seen_at,last_seen_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const legacyInsertJob = legacyDb.prepare(`INSERT INTO index_jobs(job_id,source_id,document_id,job_type,status,
    content_hash,current_path_internal,created_at,heartbeat_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  legacyDb.transaction(() => {
    for (let i = 0; i < total; i += 1) {
      const id = `legacy-doc-${String(i).padStart(5, '0')}`;
      const job = `legacy-job-${String(i).padStart(5, '0')}`;
      const relative = `${id}.md`;
      const body = Buffer.from(`# ${id}\n`);
      fs.writeFileSync(path.join(store, relative), body);
      const contentHash = `sha256:${digest(body)}`;
      legacyInsertDoc.run(id, 'source-s20', relative, relative, contentHash, 0, null,
        null, 0, 0, 0, now, now, now, now);
      legacyInsertJob.run(job, 'source-s20', id, 'index_document', 'queued', contentHash,
        path.join(store, relative), now, now, now);
    }
  })();
  legacyDb.close();
  const migrationBarrier = new SharedArrayBuffer(4);
  const pageAudit = new SharedArrayBuffer(8);
  const migrationOwner = new OwnerWorkerController({ ...config, deriveDocuments: false,
    r3MigrationBarrier: migrationBarrier, r3MigrationPageAudit: pageAudit });
  let migrationReady = false;
  const migrationStarting = migrationOwner.start().then(() => { migrationReady = true; });
  await new Promise(resolve => setTimeout(resolve, 200));
  const readyDuringMigrationBarrier = migrationReady;
  const deferredBytes = Buffer.from('# Saved during legacy migration\n');
  const deferredSave = await publishSave({ storeRoot: store, ingressRoot: ingress,
    sourceRelativeLocator: 'during-migration.md', operation: 'save_document', sourceId: 's20',
    rootFingerprint: digest(store), contentBytes: deferredBytes, contentHash: digest(deferredBytes),
    provenance: { aliases: [], metadata: {} } });
  Atomics.store(new Int32Array(migrationBarrier), 0, 1);
  Atomics.notify(new Int32Array(migrationBarrier), 0);
  try {
    await migrationStarting;
    context.assert(readyDuringMigrationBarrier,
      'owner START-ready precedes first real legacy migration page');
    const keywordDuringMigration = await migrationOwner.query('query_keyword', { query: 's20' });
    const cancelDuringMigration = await migrationOwner.cancel('nonexistent-legacy-job');
    const pagesBeforeReplies = Atomics.load(new Int32Array(pageAudit), 1);
    context.assert(Array.isArray(keywordDuringMigration) && cancelDuringMigration.cancelled === false
      && pagesBeforeReplies < Math.ceil(total / 32),
    'query and cancel return between legacy pages before full migration completes');
    const deferredReply = await migrationOwner.acceptPublishedSave({ intentId: deferredSave.intentId });
    context.assert(deferredReply.accepted === false && deferredReply.indexingState === 'enqueue_failed'
      && fs.readFileSync(path.join(store, 'during-migration.md')).equals(deferredBytes),
    'new write ACK remains closed while migration is incomplete and saved Markdown remains');
    const migrationDeadline = Date.now() + 30000;
    let migrated = 0;
    while (Date.now() < migrationDeadline) {
      const reader = new context.fixture.db.constructor(config.ledgerPath, { readonly: true });
      migrated = reader.prepare("SELECT count(*) AS n FROM legacy_index_migrations WHERE job_id LIKE 'legacy-job-%' AND result = 'migrated'").get().n;
      reader.close();
      if (migrated === total) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const audit = new Int32Array(pageAudit);
    context.assert(migrated === total && audit[0] <= 32 && audit[1] >= Math.ceil(total / 32),
      '3101 legacy jobs migrate through observed bounded pages');
    let replayed = false;
    const replayDeadline = Date.now() + 3000;
    while (Date.now() < replayDeadline) {
      const reader = new context.fixture.db.constructor(config.ledgerPath, { readonly: true });
      replayed = Boolean(reader.prepare('SELECT 1 FROM save_intent_acceptances WHERE intent_id = ?')
        .get(deferredSave.intentId));
      reader.close();
      if (replayed) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    context.assert(replayed, 'deferred save intent replays after legacy migration completes');
  } finally { await migrationOwner.shutdown(); }
} };
