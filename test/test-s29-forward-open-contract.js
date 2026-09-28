'use strict';
// @req DR-DOC-014 AC-3 AC-8 AC-9 FR-DOC-019 AC-2 AC-7 FR-DOC-036 AC-12 OPS-ARCH-009
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { OwnerWorkerController } = require('../src/main/search-owner-controller');
const { SourceLedgerStore } = require('../src/main/source-ledger-store');
const { resolveIndexedMarkdownOpen } = require('../src/main/indexed-origin-resolver');
const { verifyProvenance } = require('./test-legacy-release-forward-open-contract');

const fixtureRoot = path.join(__dirname, 'fixtures', 'legacy-release');
const Database = require('better-sqlite3');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readLedger(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = table => db.prepare(`SELECT * FROM ${table} ORDER BY ${{
      sources: 'source_id', documents: 'document_id', document_source_aliases: 'alias_id',
      index_jobs: 'job_id', links: 'edge_id', document_path_history: 'document_id, first_seen_at'
    }[table]}`).all();
    const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    const historyTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_path_history'").get();
    return {
      schemaVersion: db.prepare("SELECT value FROM source_ledger_meta WHERE key='schema_version'").get()?.value,
      sources: rows('sources'), documents: rows('documents'), aliases: rows('document_source_aliases'),
      jobs: rows('index_jobs'), edges: rows('links'), pathHistory: historyTable ? rows('document_path_history') : [],
      chunks: db.prepare('SELECT * FROM chunks ORDER BY chunk_id').all(),
      embeddings: db.prepare('SELECT * FROM chunk_embeddings ORDER BY chunk_id, model_id').all(),
      models: db.prepare('SELECT * FROM embedding_models ORDER BY model_id').all(),
      annIndexes: db.prepare('SELECT * FROM ann_indexes ORDER BY ann_index_id').all(),
      annMemberships: db.prepare('SELECT * FROM ann_memberships ORDER BY ann_index_id, chunk_id').all(),
      aliasColumns: columns('document_source_aliases')
    };
  } finally { db.close(); }
}

async function waitFor(owner, predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const status = owner.getStatus();
    if (predicate(status)) return status;
    await sleep(30);
  }
  assert.fail(`${label}: owner did not converge: ${JSON.stringify(owner.getStatus())}`);
}

function sourceFacts(snapshot) {
  return {
    sources: snapshot.sources,
    documents: snapshot.documents.map(({ document_id, source_id, relative_path, content_hash,
      project, doc_type, category, document_tags_json, classification_json, metadata_parse_status,
      metadata_json, metadata_diagnostic_json, source_mtime_or_revision, path_key, path_status,
      canonical_path_hash, last_import_job_id, import_state, content_byte_length, content_text_length,
      path_history_json, first_seen_at }) => ({ document_id, source_id, relative_path, content_hash,
        project, doc_type, category, document_tags_json, classification_json, metadata_parse_status,
        metadata_json: metadata_json ?? '{}', metadata_diagnostic_json, source_mtime_or_revision,
        path_key, path_status, canonical_path_hash, last_import_job_id, import_state,
        content_byte_length, content_text_length,
        path_history_json, first_seen_at })),
    aliases: snapshot.aliases.map(({ alias_id, document_id, alias_kind, canonical_path_hash,
      origin_lexical_path_internal, origin_path_internal, content_hash, content_byte_length,
      content_text_length, first_seen_at, last_seen_at, created_at, updated_at }) => ({
      alias_id, document_id, alias_kind, canonical_path_hash, origin_lexical_path_internal: origin_lexical_path_internal ?? null,
      origin_path_internal: origin_path_internal ?? null, content_hash, content_byte_length,
      content_text_length, first_seen_at, last_seen_at, created_at, updated_at })),
    edges: snapshot.edges,
    pathHistory: snapshot.pathHistory
  };
}

function derivedFacts(snapshot) {
  return { chunks: snapshot.chunks, embeddings: snapshot.embeddings, models: snapshot.models,
    annIndexes: snapshot.annIndexes, annMemberships: snapshot.annMemberships };
}

function pinnedStore(tag, caseRoot, dbPath, now = '2026-01-02T00:00:00.000Z') {
  const runtimeDir = path.join(caseRoot, 'pinned-runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  for (const name of ['source-ledger-store.js', 'redaction.js']) {
    const source = execFileSync('git', ['show', `${tag}:src/main/${name}`],
      { cwd: path.join(__dirname, '..'), windowsHide: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname,
      'fixtures/legacy-release-manifest.json'), 'utf8'));
    const expected = manifest.releases.find(release => release.tag === tag)?.inputs
      .find(input => input.path === `src/main/${name}`)?.sha256;
    assert.equal(hash(source), expected, `DR-DOC-014 ${tag} pinned ${name} source provenance`);
    fs.writeFileSync(path.join(runtimeDir, name), source);
  }
  const { SourceLedgerStore: TaggedStore } = require(path.join(runtimeDir, 'source-ledger-store.js'));
  return new TaggedStore({ dbPath, loadDatabase: () => Database, now: () => now });
}

function augmentTaggedCopy(tag, caseRoot, dbPath) {
  const tagged = pinnedStore(tag, caseRoot, dbPath);
  const documentId = `doc_${tag.replaceAll('.', '_')}`;
  const chunkId = `chunk_${tag.replaceAll('.', '_')}_prior`;
  const modelId = `model_${tag.replaceAll('.', '_')}`;
  const indexId = `ann_${tag.replaceAll('.', '_')}`;
  try {
    const previous = tagged.open().prepare('SELECT * FROM documents WHERE document_id = ?').get(documentId);
    tagged.upsertDocument({ documentId, sourceId: previous.source_id,
      relativePath: previous.relative_path, pathKey: previous.path_key,
      pathHistory: [{ relativePath: 'archive/release-old.md', pathKey: 'archive/release-old.md',
        pathStatus: 'moved', movedAt: '2025-12-01T00:00:00.000Z' }],
      contentHash: previous.content_hash, contentByteLength: previous.content_byte_length,
      contentTextLength: previous.content_text_length, project: previous.project,
      docType: previous.doc_type, category: previous.category,
      documentTags: JSON.parse(previous.document_tags_json),
      classification: JSON.parse(previous.classification_json),
      parseStatus: previous.metadata_parse_status });
    tagged.upsertChunk({ documentId, chunkId, ordinal: 0, text: 'prior chunk',
      searchText: 'prior chunk', textHash: `sha256:${hash('prior chunk')}` });
    tagged.upsertEmbeddingModel({ modelId, provider: 'fixture', modelName: 'fixture-model',
      modelFingerprint: hash(modelId), dimensions: 2 });
    tagged.upsertChunkEmbedding({ chunkId, modelId, vector: [0.6, 0.8] });
    tagged.recordAnnIndex({ annIndexId: indexId, modelId, status: 'stale' });
    tagged.replaceAnnMemberships({ annIndexId: indexId, modelId,
      memberships: [{ chunkId, annLabel: 1 }] });
  } finally { tagged.close(); }
}

async function verifyChangedFullReset(temp) {
  const caseRoot = path.join(temp, 'changed-full-reset');
  const sourceRoot = path.join(caseRoot, 'store');
  const ingressRoot = path.join(caseRoot, 'ingress');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(ingressRoot);
  const ledgerPath = path.join(caseRoot, 'source-ledger.sqlite');
  const keywordPath = path.join(caseRoot, 'search-index.sqlite3');
  fs.copyFileSync(path.join(fixtureRoot, 'v1.0.5', 'source-ledger.sqlite'), ledgerPath);
  fs.copyFileSync(path.join(fixtureRoot, 'v1.0.5', 'search-index.sqlite3'), keywordPath);
  const changed = '# Changed release\n\n[Changed](./changed.md)\n';
  fs.writeFileSync(path.join(sourceRoot, 'release.md'), changed);
  const migratedSetup = new SourceLedgerStore({ dbPath: ledgerPath, loadDatabase: () => Database });
  migratedSetup.initialize();
  migratedSetup.close();
  const setup = new Database(ledgerPath);
  try {
    setup.prepare('UPDATE sources SET root_path_internal=?, root_fingerprint=?')
      .run(sourceRoot, hash(sourceRoot));
    setup.prepare(`UPDATE documents SET content_hash=?, desired_content_hash=?, content_byte_length=?,
      content_text_length=?, desired_revision=1, active_requested_revision=1, completed_revision=1,
      dirty=0, keyword_dirty=0, metadata_json=?`)
      .run(`sha256:${hash(changed)}`, `sha256:${hash(changed)}`, Buffer.byteLength(changed),
        changed.length, JSON.stringify({ title: 'Retained user title' }));
  } finally { setup.close(); }
  const before = readLedger(ledgerPath);
  const owner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot, ingressRoot,
    keywordTokenizerProvider: 'basic', deriveDocuments: true });
  try {
    await owner.start();
    await waitFor(owner, s => s.migrationComplete && s.recoveryComplete && !s.active,
      'FR-DOC-019 changed full-reset startup');
    const rebuild = await owner.command('manage_index', { operation: 'rebuild' });
    assert.equal(rebuild.started, true, 'FR-DOC-019 changed full-reset starts');
    await waitFor(owner, () => readLedger(ledgerPath).jobs.some(job =>
      job.job_id === rebuild.jobId && job.status === 'completed'),
    'FR-DOC-019 changed full-reset maintenance');
    await waitFor(owner, () => readLedger(ledgerPath).jobs.some(job =>
      job.requested_by === 'settings.rebuild.full-reset' && job.status === 'completed'),
    'FR-DOC-019 changed full-reset derivation');
  } finally { await owner.shutdown(); }
  const after = readLedger(ledgerPath);
  assert.equal(after.documents[0].document_id, before.documents[0].document_id,
    'DR-DOC-014 changed full-reset stable documentId');
  assert.deepEqual(after.aliases, before.aliases, 'DR-DOC-014 changed full-reset aliases retained');
  assert.equal(after.documents[0].metadata_json, before.documents[0].metadata_json,
    'DR-DOC-014 changed full-reset user metadata retained');
  assert.equal(after.documents[0].category, 'general',
    'FR-DOC-019 changed full-reset refreshes classification for changed content');
  assert.equal(after.edges.length, 1, 'FR-DOC-019 changed full-reset replaces prior edge');
  assert.equal(after.edges[0].normalized_href_internal, 'changed.md',
    'FR-DOC-019 changed full-reset refreshes link graph for changed content');
  return { documentId: after.documents[0].document_id, metadataRetained: true,
    categoryBefore: before.documents[0].category, categoryAfter: after.documents[0].category,
    edgeBefore: before.edges[0].normalized_href_internal,
    edgeAfter: after.edges[0].normalized_href_internal };
}

async function verifyTwoPendingWinner(temp) {
  const caseRoot = path.join(temp, 'two-pending');
  const sourceRoot = path.join(caseRoot, 'store');
  const ingressRoot = path.join(caseRoot, 'ingress');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(ingressRoot);
  const ledgerPath = path.join(caseRoot, 'source-ledger.sqlite');
  const keywordPath = path.join(caseRoot, 'search-index.sqlite3');
  fs.copyFileSync(path.join(fixtureRoot, 'v1.0.5', 'source-ledger.sqlite'), ledgerPath);
  fs.copyFileSync(path.join(fixtureRoot, 'v1.0.5', 'search-index.sqlite3'), keywordPath);
  const latest = '# Latest pending\n\nNewest revision wins.\n';
  fs.writeFileSync(path.join(sourceRoot, 'release.md'), latest);
  const setup = new Database(ledgerPath);
  const sourceId = 'src_v1_0_5';
  const documentId = 'doc_v1_0_5';
  try {
    setup.prepare('UPDATE sources SET root_path_internal=?, root_fingerprint=?')
      .run(sourceRoot, hash(sourceRoot));
    setup.prepare('UPDATE documents SET content_hash=?, content_byte_length=?, content_text_length=?')
      .run(`sha256:${hash(latest)}`, Buffer.byteLength(latest), latest.length);
    setup.prepare("UPDATE index_jobs SET current_path_internal=? WHERE status='queued'")
      .run(path.join(sourceRoot, 'release.md'));
  } finally { setup.close(); }
  const tagged = pinnedStore('v1.0.5', caseRoot, ledgerPath);
  try {
    tagged.enqueueIndexJob({ jobId: 'job_v1_0_5_latest', sourceId, documentId,
      jobType: 'index_document', status: 'queued',
      currentPathInternal: path.join(sourceRoot, 'release.md'),
      contentHash: `sha256:${hash(latest)}` });
  } finally { tagged.close(); }
  const owner = new OwnerWorkerController({ ledgerPath, keywordPath, sourceRoot, ingressRoot,
    keywordTokenizerProvider: 'basic', deriveDocuments: false });
  try {
    await owner.start();
    await waitFor(owner, s => s.migrationComplete && s.recoveryComplete,
      'FR-DOC-019 latest pending migration');
  } finally { await owner.shutdown(); }
  const after = readLedger(ledgerPath);
  assert.equal(after.documents.length, 1, 'FR-DOC-019 two pending jobs preserve one document');
  assert.equal(after.documents[0].desired_content_hash, `sha256:${hash(latest)}`,
    'FR-DOC-019 latest pending content hash wins');
  assert.equal(after.documents[0].desired_revision, 1,
    'FR-DOC-019 latest pending allocated one desired revision');
  const latestJob = after.jobs.find(job => job.job_id === 'job_v1_0_5_latest');
  const priorJob = after.jobs.find(job => job.job_id === 'job_v1_0_5_queued');
  assert.equal(latestJob.status, 'cancelled', 'FR-DOC-019 latest legacy pending migrated once');
  assert.equal(latestJob.diagnostic_code, 'legacy_migrated', 'FR-DOC-019 latest migration receipt');
  assert.equal(priorJob.status, 'cancelled', 'FR-DOC-019 older pending superseded');
  assert.equal(priorJob.diagnostic_code, 'legacy_superseded', 'FR-DOC-019 older pending cannot win');
  assert.equal(after.jobs.find(job => job.job_id === after.documents[0].current_job_id)?.content_hash,
    `sha256:${hash(latest)}`, 'FR-DOC-019 current job matches latest pending');
  return { documentId, desiredRevision: after.documents[0].desired_revision,
    priorStatus: priorJob.status, priorDiagnostic: priorJob.diagnostic_code,
    latestStatus: latestJob.status, latestDiagnostic: latestJob.diagnostic_code,
    desiredContentHash: after.documents[0].desired_content_hash };
}

function verifyAmbiguousNestedRoots(temp) {
  const caseRoot = path.join(temp, 'nested-root-ambiguity');
  const sourceRoot = path.join(caseRoot, 'store');
  const nestedRoot = path.join(sourceRoot, 'nested');
  fs.mkdirSync(nestedRoot, { recursive: true });
  const filePath = path.join(nestedRoot, 'release.md');
  fs.copyFileSync(path.join(fixtureRoot, 'v1.0.0', 'release.md'), filePath);
  const ledgerPath = path.join(caseRoot, 'source-ledger.sqlite');
  fs.copyFileSync(path.join(fixtureRoot, 'v1.0.0', 'source-ledger.sqlite'), ledgerPath);
  const ledger = new SourceLedgerStore({ dbPath: ledgerPath, loadDatabase: () => Database });
  try {
    const db = ledger.open();
    db.prepare('UPDATE sources SET root_path_internal=?, root_fingerprint=?')
      .run(sourceRoot, hash(sourceRoot));
    db.prepare("UPDATE documents SET relative_path='nested/release.md', path_key='nested/release.md'")
      .run();
    ledger.recordSource({ sourceId: 'nested-source', rootPathInternal: nestedRoot });
    ledger.upsertDocument({ documentId: 'nested-document', sourceId: 'nested-source',
      relativePath: 'release.md' });
    assert.equal(ledger.getIndexedDocumentOpenTargetInternal({ filePath }), null,
      'FR-DOC-036 ambiguous nested source roots fail closed for legacy null hashes');
  } finally { ledger.close(); }
  return { legacyNullHashNestedRootsFailClosed: true };
}

async function run() {
  const manifest = verifyProvenance();
  const { createToolHandlers } = await import(pathToFileURL(path.join(__dirname, '..',
    'src/main/mcp-http.mjs')).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s29-forward-open-'));
  const inputHashes = Object.fromEntries([
    'src/main/source-ledger-store.js', 'src/main/derived-document-indexer.js',
    'test/test-s29-forward-open-contract.js'
  ].map(name => [name, hash(fs.readFileSync(path.join(__dirname, '..', name)))]));
  const redArtifact = 'docs/analysis/2026-09-29-s29-pinned-augmentation-red.txt';
  const redBytes = fs.readFileSync(path.join(__dirname, '..', redArtifact));
  const redText = redBytes.toString('utf16le');
  assert.match(redText, /DR-DOC-014 v1\.0\.0 pinned vector matches model dimensions/,
    'OPS-ARCH-009 captured harness RED assertion exists');
  assert.match(redText, /4 !== 8/, 'OPS-ARCH-009 captured harness RED observed vector length');
  const replayArtifact = 'docs/analysis/2026-09-29-s29-semantic-red-replay.json';
  const replayBytes = fs.readFileSync(path.join(__dirname, '..', replayArtifact));
  const replay = JSON.parse(replayBytes.toString('utf8'));
  assert.equal(replay.exitCode, 1, 'OPS-ARCH-009 pre-fix replay exits RED');
  assert.match(replay.stderr, /DR-DOC-014 v1\.0\.0 authoritative source\/alias\/edge\/metadata\/path history after open 1/,
    'OPS-ARCH-009 pre-fix replay names a production behavior assertion');
  const evidence = { head: execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true }).trim(),
  finalCommit: 'PENDING_UNCOMMITTED',
  runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch,
    sourceHash: require('./r3/runtime.cjs').sourceHash(),
    changedFileSetHash: hash(JSON.stringify(inputHashes)), inputHashes },
  harnessRedRun: { command: 'node test/test-s29-forward-open-contract.js', exitCode: 1,
    assertion: 'DR-DOC-014 v1.0.0 pinned vector matches model dimensions',
    artifact: redArtifact, artifactSha256: hash(redBytes) },
  behaviorRedReplay: { kind: replay.kind, baseCommit: replay.baseCommit,
    sourceHash: replay.sourceHash, command: replay.command, exitCode: replay.exitCode,
    assertion: 'DR-DOC-014 v1.0.0 authoritative source/alias/edge/metadata/path history after open 1',
    artifact: replayArtifact, artifactSha256: hash(replayBytes) },
  releases: [] };
  try {
    for (const release of manifest.releases) {
      const caseRoot = path.join(temp, release.tag);
      const sourceRoot = path.join(caseRoot, 'store');
      const originRoot = path.join(caseRoot, 'origin');
      const ingressRoot = path.join(caseRoot, 'ingress');
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.mkdirSync(originRoot);
      fs.mkdirSync(ingressRoot);
      const bytes = fs.readFileSync(path.join(fixtureRoot, release.tag, 'release.md'));
      fs.writeFileSync(path.join(sourceRoot, 'release.md'), bytes);
      const ledgerPath = path.join(caseRoot, 'source-ledger.sqlite');
      const keywordPath = path.join(caseRoot, 'search-index.sqlite3');
      fs.copyFileSync(path.join(fixtureRoot, release.tag, 'source-ledger.sqlite'), ledgerPath);
      fs.copyFileSync(path.join(fixtureRoot, release.tag, 'search-index.sqlite3'), keywordPath);
      // The tagged fixtures contain fixed synthetic Windows locations. Relocate only these copies.
      const setup = new Database(ledgerPath);
      try {
        setup.prepare('UPDATE sources SET root_path_internal=?, root_fingerprint=?')
          .run(sourceRoot, hash(sourceRoot));
        setup.prepare("UPDATE index_jobs SET current_path_internal=? WHERE status='queued'")
          .run(path.join(sourceRoot, 'release.md'));
        if (release.tag === 'v1.0.5') {
          const aliases = setup.prepare('SELECT alias_id FROM document_source_aliases ORDER BY alias_id').all();
          for (const [i, alias] of aliases.entries()) {
            const original = path.join(originRoot, i ? 'release.md' : 'missing.md');
            setup.prepare(`UPDATE document_source_aliases SET origin_lexical_path_internal=?,
              origin_path_internal=?, canonical_path_hash=? WHERE alias_id=?`)
              .run(original, original, hash(original.toLowerCase()), alias.alias_id);
          }
          fs.writeFileSync(path.join(originRoot, 'release.md'), bytes);
        }
      } finally { setup.close(); }
      augmentTaggedCopy(release.tag, caseRoot, ledgerPath);
      const before = readLedger(ledgerPath);
      assert.ok(before.documents[0].first_seen_at && JSON.parse(before.documents[0].path_history_json).length,
        `DR-DOC-014 ${release.tag} nonempty historical path fields`);
      assert.equal(before.chunks.length, 1, `DR-DOC-014 ${release.tag} tagged copy chunk augmentation`);
      assert.equal(before.embeddings.length, 1, `DR-DOC-014 ${release.tag} tagged copy embedding augmentation`);
      assert.equal(before.annMemberships.length, 1, `DR-DOC-014 ${release.tag} tagged copy ANN augmentation`);
      assert.equal(before.embeddings[0].embedding.length,
        before.models[0].dimensions * Float32Array.BYTES_PER_ELEMENT,
      `DR-DOC-014 ${release.tag} pinned vector matches model dimensions`);
      assert.equal(before.annIndexes[0].status, 'stale',
        `DR-DOC-014 ${release.tag} pinned ANN fixture has no false committed artifact`);
      assert.equal(before.annIndexes[0].index_path_internal, null,
        `DR-DOC-014 ${release.tag} pinned ANN fixture has no absent path`);
      const id = `doc_${release.tag.replaceAll('.', '_')}`;
      const ownerConfig = { ledgerPath, keywordPath, sourceRoot, ingressRoot,
        keywordTokenizerProvider: 'basic', deriveDocuments: true };
      const migrationOwner = new OwnerWorkerController({ ...ownerConfig, deriveDocuments: false });
      try {
        await migrationOwner.start();
        await waitFor(migrationOwner, s => s.migrationComplete && s.recoveryComplete,
          `FR-DOC-019 ${release.tag} migration before derived drain`);
      } finally { await migrationOwner.shutdown(); }
      const migrated = readLedger(ledgerPath);
      assert.deepEqual(sourceFacts(migrated), sourceFacts(before),
        `DR-DOC-014 ${release.tag} authoritative snapshot across migration`);
      assert.deepEqual(derivedFacts(migrated), derivedFacts(before),
        `DR-DOC-014 ${release.tag} chunk/embedding/ANN snapshot across migration`);
      let afterFirst;
      let searchEvidence = [];
      const handlerResponses = [];
      for (let opening = 0; opening < 3; opening += 1) {
        const owner = new OwnerWorkerController(ownerConfig);
        try {
          await owner.start();
          assert.ok(Number.isSafeInteger(owner.lastStartAudit?.ledgerOpenThreadId)
            && owner.lastStartAudit.ledgerOpenThreadId > 0,
          `FR-DOC-019 ${release.tag} ledger opened in worker thread`);
          assert.ok(Number.isSafeInteger(owner.lastStartAudit?.keywordOpenThreadId)
            && owner.lastStartAudit.keywordOpenThreadId > 0,
          `FR-DOC-019 ${release.tag} keyword opened in worker thread`);
          assert.equal(owner.lastStartAudit.ledgerOpenThreadId, owner.lastStartAudit.keywordOpenThreadId,
            `FR-DOC-019 ${release.tag} one worker writer`);
          assert.equal(owner.lastStartAudit.openCount, 2,
            `FR-DOC-019 ${release.tag} exactly ledger and keyword DB opened by owner`);
          await waitFor(owner, s => s.migrationComplete === true && s.recoveryComplete === true,
            `FR-DOC-019 ${release.tag} startup migration`);
          await waitFor(owner, s => s.active !== true && ['ready', 'stale'].includes(s.state),
            `FR-DOC-019 ${release.tag} drain`);
          const resolved = await resolveIndexedMarkdownOpen({ documentId: id,
            searchEngine: { _openReadOnlySourceLedger: () => new SourceLedgerStore({
              dbPath: ledgerPath, readOnly: true, loadDatabase: () => Database }) } });
          assert.equal(resolved.documentId, id, `DR-DOC-014 ${release.tag} stable documentId`);
          assert.equal(resolved.sourceUsed, release.tag === 'v1.0.5' && opening === 0 ? 'origin' : 'indexed_copy',
            `FR-DOC-036 ${release.tag} origin-first or indexed-copy fallback`);
          assert.equal(resolved.content, bytes.toString('utf8'), `FR-DOC-036 ${release.tag} same-handle content`);
          assert.equal(resolved.originStatus, release.tag === 'v1.0.5'
            ? opening === 0 ? 'readable' : 'missing' : 'not_recorded',
            `FR-DOC-036 ${release.tag} stable redacted status`);
          const readOnlySearchEngine = { _openReadOnlySourceLedger: () => new SourceLedgerStore({
            dbPath: ledgerPath, readOnly: true, loadDatabase: () => Database }) };
          const handlers = createToolHandlers({
            async createWindow() { return { windowId: 'fixture-window', title: 'Fixture', upserted: false }; },
            getWindowEntry() { return { meta: { project: null, docType: null, savedFilePath: null },
              win: { isDestroyed: () => false, setAlwaysOnTop() {}, webContents: { send() {} } } }; }
          }, { get(_key, fallback) { return fallback; } }, readOnlySearchEngine);
          const publicOpen = await handlers.open_markdown({ documentId: id, noSave: true });
          assert.equal(publicOpen.isError, undefined, `FR-DOC-036 ${release.tag} handler legacy open`);
          assert.match(publicOpen.content[0].text, /sourceUsed: (origin|indexed_copy)/,
            `FR-DOC-036 ${release.tag} handler safe selection`);
          assert.ok(!publicOpen.content[0].text.includes(caseRoot)
            && !publicOpen.content[0].text.includes(originRoot),
          `FR-DOC-036 ${release.tag} handler legacy response redacts raw paths`);
          handlerResponses.push(publicOpen.content[0].text);
          if (opening === 2) {
            const result = await owner.command('manage_index', { operation: 'rebuild' });
            assert.equal(result.started, true, `DR-DOC-014 ${release.tag} explicit derivative rebuild starts`);
            await waitFor(owner, () => readLedger(ledgerPath).jobs.some(job =>
              job.job_id === result.jobId && job.status === 'completed'),
              `DR-DOC-014 ${release.tag} explicit derivative rebuild completes`);
          }
          if (opening === 2) {
            const search = await owner.query('query_keyword', { query: 'Synthetic origin' });
            searchEvidence = search.map(({ filePath: _internalPath, ...safeResult }) =>
              ({ ...safeResult, filePath: '[INDEXED_COPY]' }));
            assert.ok(search.some(hit => hit.filePath === path.join(sourceRoot, 'release.md')),
              `DR-DOC-014 ${release.tag} derivative search recovers indexed copy: ${JSON.stringify({ search, status: owner.getStatus() })}`);
            const searchTarget = await resolveIndexedMarkdownOpen({ filePath: search[0].filePath,
              searchEngine: { _openReadOnlySourceLedger: () => new SourceLedgerStore({
                dbPath: ledgerPath, readOnly: true, loadDatabase: () => Database }) } });
            assert.equal(searchTarget.documentId, id,
              `DR-DOC-014 ${release.tag} keyword candidate resolves stable documentId`);
          }
          await waitFor(owner, s => s.active !== true && !readLedger(ledgerPath).jobs.some(job =>
            job.job_type === 'index_document' && ['queued', 'indexing'].includes(job.status)),
            `FR-DOC-019 ${release.tag} pending drain`);
        } finally { await owner.shutdown(); }
        const snapshot = readLedger(ledgerPath);
        assert.deepEqual(sourceFacts(snapshot), sourceFacts(before),
          `DR-DOC-014 ${release.tag} authoritative source/alias/edge/metadata/path history after open ${opening + 1}`);
        assert.equal(snapshot.documents.length, 1, `DR-DOC-014 ${release.tag} no duplicate document`);
        assert.equal(snapshot.aliases.length, 2, `DR-DOC-014 ${release.tag} 1:N aliases preserved`);
        if (opening === 0) afterFirst = snapshot;
        else if (opening === 1) assert.deepEqual(snapshot.jobs, afterFirst.jobs,
          `FR-DOC-019 ${release.tag} repeated open is job-idempotent`);
        if (opening === 1) {
          assert.ok(fs.existsSync(keywordPath), `DR-DOC-014 ${release.tag} keyword cache exists before deletion`);
          fs.unlinkSync(keywordPath);
        }
        if (opening === 0 && release.tag === 'v1.0.5') fs.unlinkSync(path.join(originRoot, 'release.md'));
      }
      const after = readLedger(ledgerPath);
      for (const original of before.jobs) {
        const retained = after.jobs.find(job => job.job_id === original.job_id);
        assert.ok(retained, `FR-DOC-019 ${release.tag} original job history retained: ${original.job_id}`);
        if (original.status === 'completed') assert.deepEqual(retained, original,
          `FR-DOC-019 ${release.tag} completed history remains immutable`);
      }
      assert.equal(after.documents[0].desired_content_hash, after.documents[0].content_hash,
        `FR-DOC-019 ${release.tag} latest content is desired winner`);
      assert.notEqual(after.documents[0].current_job_id, `job_${release.tag.replaceAll('.', '_')}_completed`,
        `FR-DOC-019 ${release.tag} old completed history cannot win`);
      assert.equal(after.jobs.filter(job => job.requested_by === 'legacy_migration').length, 1,
        `FR-DOC-019 ${release.tag} exactly one migrated pending job`);
      evidence.releases.push({ tag: release.tag, commitSha: release.commitSha,
        taggedApiSourceSha256: release.inputs.find(input =>
          input.path === 'src/main/source-ledger-store.js').sha256,
        outputSha256: release.outputs.map(({ path: name, sha256 }) => ({ path: name, sha256 })),
        schemaBefore: before.schemaVersion, schemaAfter: after.schemaVersion,
        reopenCount: 3, keywordCacheDeletedAndRebuilt: true,
        authoritativeSnapshotBeforeSha256: hash(JSON.stringify(sourceFacts(before))),
        authoritativeSnapshotAfterSha256: hash(JSON.stringify(sourceFacts(after))),
        derivedBeforeMigrationSha256: hash(JSON.stringify(derivedFacts(before))),
        derivedAfterMigrationSha256: hash(JSON.stringify(derivedFacts(migrated))),
        documentId: id, aliasCount: after.aliases.length, jobStatuses: after.jobs.map(job => job.status),
        keywordDocumentId: id, sourceUsed: release.tag === 'v1.0.5'
          ? ['origin', 'indexed_copy'] : ['indexed_copy'],
        redactedSearchResults: searchEvidence,
        handlerOpenResponses: handlerResponses,
        diagnostics: after.jobs.map(job => job.diagnostic_code).filter(Boolean) });
    }
    evidence.changedFullReset = await verifyChangedFullReset(temp);
    evidence.twoPendingWinner = await verifyTwoPendingWinner(temp);
    evidence.nestedRoots = verifyAmbiguousNestedRoots(temp);
    if (process.env.DOCULIGHT_S29_EVIDENCE) {
      fs.writeFileSync(process.env.DOCULIGHT_S29_EVIDENCE, JSON.stringify(evidence, null, 2), { flag: 'wx' });
    }
    console.log('S29 five-release worker forward-open, reopen and rebuild passed');
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
