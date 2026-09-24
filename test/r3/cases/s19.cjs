'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { publishSave } = require('../../../src/main/index-ingress-store');

const hash = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const publicFixturePath = path.join(__dirname, '../fixtures/public-ledger-12d312c.sqlite');
const publicFixtureHash = 'e6739aa66353f85a601e56cf62af9b42c629b11b2bc36b6c08950eef74ed3bf0';

async function waitForStatus(owner, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = owner.getStatus();
    if (predicate(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return owner.getStatus();
}

function seed(Database, base, { mismatch = false, fresh = false, unknown = false, disabled = false } = {}) {
  const storeRoot = path.join(base, 'store');
  fs.mkdirSync(storeRoot);
  const ledgerPath = path.join(base, 'ledger.sqlite');
  const keywordPath = path.join(base, 'keyword.sqlite');
  const ingressRoot = path.join(base, 'private');
  fs.mkdirSync(ingressRoot);
  const fixtureHash = crypto.createHash('sha256').update(fs.readFileSync(publicFixturePath)).digest('hex');
  if (fixtureHash !== publicFixtureHash) throw new Error('Public baseline SQLite fixture checksum mismatch');
  fs.copyFileSync(publicFixturePath, ledgerPath);
  const db = new Database(ledgerPath);
  const now = new Date(Date.now() - 3600000).toISOString();
  const rootFingerprint = crypto.createHash('sha256').update(path.resolve(storeRoot)).digest('hex');
  const storedRoot = value => process.platform === 'win32'
    ? path.resolve(value).toLowerCase() : path.resolve(value);
  db.prepare('INSERT INTO sources(source_id,root_path_internal,root_fingerprint,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('source-1', mismatch ? storedRoot(path.join(base, 'wrong')) : storedRoot(storeRoot),
      mismatch ? 'wrong-fingerprint' : rootFingerprint, now, now);
  if (disabled) db.prepare("UPDATE sources SET enabled = 0 WHERE source_id = 'source-1'").run();
  for (const [id, status, body, cancel] of [
    ['queued', 'queued', '# Queued\n', 0], ['indexing', 'indexing', '# Indexing\n', 0],
    ['completed', 'completed', '# Completed\n', 0], ['cancelled', 'queued', '# Cancel\n', 1],
    ['changed', 'queued', '# Changed\n', 0], ['missing', 'queued', '# Missing\n', 0],
    ['corrupt', 'queued', '# Corrupt\n', 0]
  ]) {
    const locator = `${id}.md`;
    if (id !== 'missing') fs.writeFileSync(path.join(storeRoot, locator), body);
    const expected = id === 'changed' ? hash('# Old\n') : hash(body);
    db.prepare(`INSERT INTO documents(document_id,source_id,relative_path,path_key,content_hash,
      category,document_tags_json,first_seen_at,last_seen_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`doc-${id}`, 'source-1', locator, locator,
        expected, 'research', '["legacy"]', now, now, now, now);
    db.prepare(`INSERT INTO index_jobs(job_id,source_id,document_id,job_type,status,current_path_internal,
      content_hash,cancel_requested,created_at,heartbeat_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`old-${id}`, id === 'corrupt' ? null : 'source-1', `doc-${id}`,
        'index_document', status, path.join(storeRoot, locator), expected, cancel, now,
          fresh && id === 'indexing' ? new Date().toISOString() : now, now);
  }
  db.prepare(`INSERT INTO document_source_aliases(alias_id,document_id,alias_kind,canonical_path_hash,
    first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run('alias-1', 'doc-queued', 'opened_path', hash('origin'), now, now, now, now);
  if (unknown) db.prepare("UPDATE source_ledger_meta SET value = '999' WHERE key = 'schema_version'").run();
  db.close();
  return { storeRoot, ledgerPath, keywordPath, ingressRoot };
}

// @req REL-DOC-009 FR-DOC-019 DR-DOC-014 SEC-DOC-003
module.exports = { async run(context) {
  const publicDb = new context.fixture.db.constructor(publicFixturePath, { readonly: true });
  try {
    const jobsSql = publicDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'index_jobs'").get()?.sql || '';
    const aliasColumns = publicDb.pragma('table_info(document_source_aliases)');
    context.assert(jobsSql.includes('CHECK(status IN')
      && publicDb.pragma('foreign_key_list(index_jobs)').length === 2,
    'fixture retains the public job status CHECK and source/document foreign keys');
    context.assert(aliasColumns.some(column => column.name === 'origin_lexical_path_internal' && column.notnull === 0)
      && aliasColumns.some(column => column.name === 'origin_path_internal' && column.notnull === 0)
      && publicDb.pragma('index_list(document_source_aliases)').some(index => index.unique),
    'fixture retains the public nullable origin columns and unique alias shape');
  } finally { publicDb.close(); }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s19-'));
  try {
    const config = seed(context.fixture.db.constructor, base);
    const probe = new SourceLedgerStore({ dbPath: config.ledgerPath });
    try {
      context.assert(typeof probe.migrateLegacyIndexJobs === 'function',
        'public baseline jobs have an owner migration entrypoint');
    } finally { probe.close(); }
    const owner = new OwnerWorkerController({ ...config, sourceRoot: config.storeRoot,
      deriveDocuments: false, keywordTokenizerProvider: 'basic' });
    try {
      await owner.start();
      await waitForStatus(owner, status => status.recoveryComplete === true);
      const ledger = new SourceLedgerStore({ dbPath: config.ledgerPath });
      try {
      const db = ledger.open();
      const queued = db.prepare("SELECT * FROM documents WHERE document_id = 'doc-queued'").get();
      context.assert(queued.desired_revision === 1 && queued.dirty === 1
        && queued.desired_content_hash === hash('# Queued\n')
        && queued.current_job_id !== 'old-queued', 'legacy queued job becomes durable desired revision');
      context.assert(db.prepare("SELECT status FROM index_jobs WHERE job_id = 'old-completed'").get().status === 'completed'
        && db.prepare("SELECT desired_revision FROM documents WHERE document_id = 'doc-completed'").get().desired_revision === 0,
      'completed history never becomes pending winner');
      context.assert(db.prepare("SELECT COUNT(*) AS n FROM document_source_aliases WHERE document_id = 'doc-queued'").get().n === 1
        && queued.category === 'research' && queued.document_tags_json === '["legacy"]',
      'legacy identity, alias, and metadata survive');
      const alias = db.prepare("SELECT * FROM document_source_aliases WHERE alias_id = 'alias-1'").get();
      context.assert(alias.origin_lexical_path_internal === null && alias.origin_path_internal === null,
        'hash-only legacy alias never gains an invented origin');
      context.assert(db.prepare("SELECT COUNT(*) AS n FROM index_jobs WHERE job_id LIKE 'job_legacy_%'").get().n === 2,
        'only verified queued and indexing jobs receive new jobs');
      for (const id of ['cancelled', 'changed', 'missing', 'corrupt']) {
        context.assert(db.prepare('SELECT desired_revision FROM documents WHERE document_id = ?').get(`doc-${id}`).desired_revision === 0,
          `${id} is not executed`);
        context.assert(db.prepare('SELECT result FROM legacy_index_migrations WHERE job_id = ?')
          .get(`old-${id}`).result === 'blocked', `${id} retains a durable diagnostic`);
      }
      } finally { ledger.close(); }
    } finally { await owner.shutdown(); }
    const replay = new OwnerWorkerController({ ...config, sourceRoot: config.storeRoot,
      deriveDocuments: false, keywordTokenizerProvider: 'basic' });
    try {
      await replay.start();
      await waitForStatus(replay, status => status.recoveryComplete === true);
      context.assert(replay.getStatus().legacyMigration?.blocked === 4,
        'restart status retains the persisted blocked legacy diagnostic count');
    } finally { await replay.shutdown(); }
    const ledger = new SourceLedgerStore({ dbPath: config.ledgerPath });
    const count = ledger.open().prepare("SELECT COUNT(*) AS n FROM index_jobs WHERE job_id LIKE 'job_legacy_%'").get().n;
    ledger.close();
    context.assert(count === 2, 'restart converges without duplicate jobs');
    const upgradedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s19-'));
    try {
      const input = seed(context.fixture.db.constructor, upgradedRoot);
      const prior = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        prior.initialize();
        // A clean pre-S19 owner already added desired columns, but had no S19 marker.
        prior.open().prepare("DELETE FROM source_ledger_meta WHERE key = 'legacy_index_jobs_schema'").run();
      } finally { prior.close(); }
      const recovered = new OwnerWorkerController({ ...input, sourceRoot: input.storeRoot,
        deriveDocuments: false, keywordTokenizerProvider: 'basic' });
      try { await recovered.start(); await waitForStatus(recovered, status => status.recoveryComplete === true); }
      finally { await recovered.shutdown(); }
      const check = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        context.assert(check.open().prepare("SELECT desired_revision FROM documents WHERE document_id = 'doc-queued'")
          .get().desired_revision === 1,
        'already-upgraded public job rows are still detected and migrated');
      } finally { check.close(); }
    } finally { fs.rmSync(upgradedRoot, { recursive: true, force: true }); }
    const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s19-'));
    try {
      const input = seed(context.fixture.db.constructor, orphanRoot);
      const prior = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        prior.initialize();
        prior.open().prepare("DELETE FROM index_jobs WHERE job_id <> 'old-corrupt'").run();
        prior.open().prepare("UPDATE index_jobs SET document_id = NULL WHERE job_id = 'old-corrupt'").run();
        prior.open().prepare("DELETE FROM source_ledger_meta WHERE key = 'legacy_index_jobs_schema'").run();
      } finally { prior.close(); }
      const owner = new OwnerWorkerController({ ...input, sourceRoot: input.storeRoot,
        deriveDocuments: false, keywordTokenizerProvider: 'basic' });
      try { await owner.start(); await waitForStatus(owner, status => status.recoveryComplete === true); }
      finally { await owner.shutdown(); }
      const check = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        context.assert(check.open().prepare("SELECT result FROM legacy_index_migrations WHERE job_id = 'old-corrupt'")
          .get()?.result === 'blocked',
        'already-upgraded corrupt-only public job is detected and retained');
      } finally { check.close(); }
    } finally { fs.rmSync(orphanRoot, { recursive: true, force: true }); }
    const competingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s19-'));
    try {
      const input = seed(context.fixture.db.constructor, competingRoot);
      const raw = new context.fixture.db.constructor(input.ledgerPath);
      try {
        raw.prepare(`INSERT INTO index_jobs(job_id,source_id,document_id,job_type,status,
          current_path_internal,content_hash,cancel_requested,created_at,heartbeat_at,updated_at)
          SELECT 'old-queued-newer',source_id,document_id,job_type,status,
          current_path_internal,content_hash,cancel_requested,'2030-01-01T00:00:00.000Z',
          heartbeat_at,updated_at FROM index_jobs WHERE job_id = 'old-queued'`).run();
      } finally { raw.close(); }
      const winner = new OwnerWorkerController({ ...input, sourceRoot: input.storeRoot,
        deriveDocuments: false, keywordTokenizerProvider: 'basic' });
      try { await winner.start(); await waitForStatus(winner, status => status.recoveryComplete === true); }
      finally { await winner.shutdown(); }
      const check = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        const db = check.open();
        context.assert(db.prepare("SELECT result FROM legacy_index_migrations WHERE job_id = 'old-queued-newer'")
          .get().result === 'migrated', 'latest verified public job wins duplicate document history');
        context.assert(db.prepare("SELECT result FROM legacy_index_migrations WHERE job_id = 'old-queued'")
          .get().result === 'history', 'older same-content job remains history only');
      } finally { check.close(); }
    } finally { fs.rmSync(competingRoot, { recursive: true, force: true }); }
    const tiedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s19-'));
    try {
      const input = seed(context.fixture.db.constructor, tiedRoot);
      const raw = new context.fixture.db.constructor(input.ledgerPath);
      try {
        raw.prepare(`INSERT INTO index_jobs(job_id,source_id,document_id,job_type,status,
          current_path_internal,content_hash,cancel_requested,created_at,heartbeat_at,updated_at)
          SELECT 'old-queued-tied',source_id,document_id,job_type,status,
          current_path_internal,content_hash,cancel_requested,created_at,
          heartbeat_at,updated_at FROM index_jobs WHERE job_id = 'old-queued'`).run();
      } finally { raw.close(); }
      const owner = new OwnerWorkerController({ ...input, sourceRoot: input.storeRoot,
        deriveDocuments: false, keywordTokenizerProvider: 'basic' });
      try { await owner.start(); await waitForStatus(owner, status => status.recoveryComplete === true); }
      finally { await owner.shutdown(); }
      const check = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        const db = check.open();
        context.assert(db.prepare("SELECT desired_revision FROM documents WHERE document_id = 'doc-queued'").get().desired_revision === 0
          && db.prepare(`SELECT COUNT(*) AS n FROM legacy_index_migrations
            WHERE job_id IN ('old-queued','old-queued-tied')
              AND result = 'blocked' AND diagnostic_code = 'legacy_ambiguous_order'`).get().n === 2,
        'equal-time same-content legacy jobs remain blocked without invented order');
      } finally { check.close(); }
    } finally { fs.rmSync(tiedRoot, { recursive: true, force: true }); }
    const freshDuplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s19-'));
    try {
      const input = seed(context.fixture.db.constructor, freshDuplicateRoot);
      const raw = new context.fixture.db.constructor(input.ledgerPath);
      try {
        raw.prepare(`INSERT INTO index_jobs(job_id,source_id,document_id,job_type,status,
          current_path_internal,content_hash,cancel_requested,created_at,heartbeat_at,updated_at)
          SELECT 'old-fresh-duplicate',source_id,document_id,job_type,'indexing',
          current_path_internal,content_hash,cancel_requested,'2030-01-01T00:00:00.000Z',
          ?,updated_at FROM index_jobs WHERE job_id = 'old-queued'`).run(new Date().toISOString());
      } finally { raw.close(); }
      const owner = new OwnerWorkerController({ ...input, sourceRoot: input.storeRoot,
        deriveDocuments: false, keywordTokenizerProvider: 'basic' });
      try { await owner.start(); await waitForStatus(owner, status => status.recoveryComplete === true); }
      finally { await owner.shutdown(); }
      const check = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        const db = check.open();
        context.assert(db.prepare("SELECT status FROM index_jobs WHERE job_id = 'old-fresh-duplicate'")
          .get().status === 'indexing'
          && db.prepare("SELECT result FROM legacy_index_migrations WHERE job_id = 'old-fresh-duplicate'")
            .get().result === 'blocked',
        'modern interrupted-job scan does not settle a blocked legacy indexing row');
        context.assert(db.prepare("SELECT desired_revision FROM documents WHERE document_id = 'doc-queued'")
          .get().desired_revision === 0
          && db.prepare("SELECT COUNT(*) AS n FROM index_jobs WHERE document_id = 'doc-queued' AND job_id LIKE 'job_legacy_%'")
            .get().n === 0
          && db.prepare("SELECT result FROM legacy_index_migrations WHERE job_id = 'old-queued'")
            .get().result === 'blocked',
        'uncertain fresh claim blocks the entire legacy document before pending enqueue');
      } finally { check.close(); }
    } finally { fs.rmSync(freshDuplicateRoot, { recursive: true, force: true }); }
    const laterSaveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s19-'));
    try {
      const input = seed(context.fixture.db.constructor, laterSaveRoot, { fresh: true });
      const owner = new OwnerWorkerController({ ...input, sourceRoot: input.storeRoot,
        deriveDocuments: false, keywordTokenizerProvider: 'basic' });
      try {
        await owner.start();
        await waitForStatus(owner, status => status.recoveryComplete === true);
        const bytes = Buffer.from('# Later valid save\n');
        const published = await publishSave({ storeRoot: input.storeRoot,
          ingressRoot: input.ingressRoot, sourceRelativeLocator: 'indexing.md',
          operation: 'update', sourceId: 'source-1',
          rootFingerprint: crypto.createHash('sha256').update(path.resolve(input.storeRoot)).digest('hex'),
          contentBytes: bytes, contentHash: hash(bytes).slice(7),
          provenance: { aliases: [], metadata: {} } });
        const reply = await owner.acceptPublishedSave({ intentId: published.intentId });
        context.assert(reply.accepted === true && reply.desiredRevision === 1,
          'later valid save receives a durable new desired job');
        const ledger = new SourceLedgerStore({ dbPath: input.ledgerPath });
        try {
          const pending = ledger.getPendingDesiredPage();
          const desired = pending.find(item => item.documentId === 'doc-indexing');
          const claim = desired && ledger.claimDesiredJob(desired);
          context.assert(claim?.jobId === reply.indexing.jobId,
            'new desired save remains claimable despite blocked legacy indexing history');
          context.assert(ledger.completeClaimedJob({ claim, actualFileHash: hash(bytes) }) === true
            && ledger.open().prepare("SELECT completed_revision FROM documents WHERE document_id = 'doc-indexing'")
              .get().completed_revision === 1,
          'new desired revision completes without settling old blocked legacy claim');
          context.assert(ledger.open().prepare("SELECT status FROM index_jobs WHERE job_id = 'old-indexing'")
            .get().status === 'indexing'
            && ledger.open().prepare("SELECT result FROM legacy_index_migrations WHERE job_id = 'old-indexing'")
              .get().result === 'blocked',
          'later save preserves the blocked legacy row and diagnostic');
        } finally { ledger.close(); }
      } finally { await owner.shutdown(); }
    } finally { fs.rmSync(laterSaveRoot, { recursive: true, force: true }); }
    const faultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s19-'));
    try {
      const input = seed(context.fixture.db.constructor, faultRoot);
      const setup = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        setup.initialize();
        setup.open().exec(`CREATE TRIGGER s19_fail_marker BEFORE INSERT ON legacy_index_migrations
          BEGIN SELECT RAISE(ABORT, 's19 fault'); END`);
      } finally { setup.close(); }
      const failed = new OwnerWorkerController({ ...input, sourceRoot: input.storeRoot,
        deriveDocuments: false, keywordTokenizerProvider: 'basic' });
      await failed.start();
      const failedStatus = await waitForStatus(failed,
        status => status.diagnostic?.code === 'legacy_migration_failed');
      context.assert(failedStatus.diagnostic?.code === 'legacy_migration_failed',
        'migration transaction fault leaves owner ready but gates new writes');
      context.assert((await failed.acceptPublishedSave({ intentId: '0'.repeat(64) })).accepted === false,
        'new write ACK remains closed before migration transaction commits');
      await failed.shutdown();
      const afterFault = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        const db = afterFault.open();
        context.assert(db.prepare("SELECT desired_revision FROM documents WHERE document_id = 'doc-queued'").get().desired_revision === 0
          && db.prepare("SELECT status FROM index_jobs WHERE job_id = 'old-queued'").get().status === 'queued'
          && db.prepare("SELECT COUNT(*) AS n FROM index_jobs WHERE job_id LIKE 'job_legacy_%'").get().n === 0,
        'failed transaction keeps old rows and rolls back the pending job');
        db.exec('DROP TRIGGER s19_fail_marker');
      } finally { afterFault.close(); }
      const resumed = new OwnerWorkerController({ ...input, sourceRoot: input.storeRoot,
        deriveDocuments: false, keywordTokenizerProvider: 'basic' });
      try { await resumed.start(); await waitForStatus(resumed, status => status.recoveryComplete === true); }
      finally { await resumed.shutdown(); }
      const final = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        context.assert(final.open().prepare("SELECT COUNT(*) AS n FROM index_jobs WHERE job_id LIKE 'job_legacy_%'").get().n === 2,
          'post-fault restart commits each eligible desired job once');
      } finally { final.close(); }
    } finally { fs.rmSync(faultRoot, { recursive: true, force: true }); }
    const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s19-'));
    try {
      const input = seed(context.fixture.db.constructor, markerRoot);
      const setup = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        setup.initialize();
        setup.open().prepare("UPDATE source_ledger_meta SET value = 'unknown' WHERE key = 'legacy_index_jobs_schema'").run();
      } finally { setup.close(); }
      const gated = new OwnerWorkerController({ ...input, sourceRoot: input.storeRoot,
        deriveDocuments: false, keywordTokenizerProvider: 'basic' });
      let rejected = false;
      try { await gated.start(); } catch { rejected = true; }
      context.assert(rejected, 'unknown migration marker fails closed before owner START-ready');
      await gated.shutdown();
      const check = new SourceLedgerStore({ dbPath: input.ledgerPath });
      try {
        context.assert(check.open().prepare("SELECT status FROM index_jobs WHERE job_id = 'old-queued'").get().status === 'queued',
          'unknown migration marker leaves public job row untouched');
      } finally { check.close(); }
    } finally { fs.rmSync(markerRoot, { recursive: true, force: true }); }
    for (const variant of [{ mismatch: true }, { fresh: true }, { disabled: true }]) {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s19-'));
      try {
        const input = seed(context.fixture.db.constructor, other, variant);
        const gated = new OwnerWorkerController({ ...input, sourceRoot: input.storeRoot,
          deriveDocuments: false, keywordTokenizerProvider: 'basic' });
        try {
          await gated.start();
          await waitForStatus(gated, status => status.recoveryComplete === true);
          const check = new SourceLedgerStore({ dbPath: input.ledgerPath });
          try {
            const db = check.open();
            const target = variant.fresh ? 'old-indexing' : 'old-queued';
            context.assert(db.prepare('SELECT result FROM legacy_index_migrations WHERE job_id = ?')
              .get(target).result === 'blocked', `${target} remains blocked`);
            context.assert(db.prepare('SELECT status FROM index_jobs WHERE job_id = ?')
              .get(target).status === (variant.fresh ? 'indexing' : 'queued'),
            `${target} keeps original job row and status`);
            context.assert(db.prepare('SELECT desired_revision FROM documents WHERE document_id = ?')
              .get(variant.fresh ? 'doc-indexing' : 'doc-queued').desired_revision === 0,
            `${target} cannot become desired winner`);
          } finally { check.close(); }
        } finally { await gated.shutdown(); }
      } finally { fs.rmSync(other, { recursive: true, force: true }); }
    }
    const unknownRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s19-'));
    try {
      const input = seed(context.fixture.db.constructor, unknownRoot, { unknown: true });
      const gated = new OwnerWorkerController({ ...input, sourceRoot: input.storeRoot,
        deriveDocuments: false, keywordTokenizerProvider: 'basic' });
      let rejected = false;
      try { await gated.start(); } catch { rejected = true; }
      context.assert(rejected, 'unknown public schema prevents owner START-ready');
      const reply = await gated.acceptPublishedSave({ intentId: '0'.repeat(64) });
      context.assert(reply.accepted === false, 'new write gate stays closed after unknown schema');
      await gated.shutdown();
      const db = new context.fixture.db.constructor(input.ledgerPath, { readonly: true });
      try {
        context.assert(db.prepare("SELECT value FROM source_ledger_meta WHERE key = 'schema_version'").get().value === '999'
          && db.prepare("SELECT status FROM index_jobs WHERE job_id = 'old-queued'").get().status === 'queued',
        'unknown schema and original job survive failed migration');
      } finally { db.close(); }
    } finally { fs.rmSync(unknownRoot, { recursive: true, force: true }); }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
} };
