'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLinkedImporter } = require('../../../src/main/linked-import');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');

async function verifyImportedGraph(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s17-graph-'));
  const sourceRoot = path.join(root, 'source');
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'private');
  for (const dir of [sourceRoot, storeRoot, ingressRoot]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(sourceRoot, 'A.md'), '# A\n[B](./B.md)\n[Missing](./Missing.md)\n');
  fs.writeFileSync(path.join(sourceRoot, 'B.md'), '# B\n');
  const ledgerPath = path.join(root, 'ledger.sqlite');
  const owner = new OwnerWorkerController({ ledgerPath,
    keywordPath: path.join(root, 'keyword.sqlite'), sourceRoot: storeRoot,
    ingressRoot, keywordTokenizerProvider: 'basic', deriveDocuments: true });
  const ledger = new SourceLedgerStore({ dbPath: ledgerPath });
  try {
    await owner.start();
    const importer = createLinkedImporter({ sourceRoot, knowledgeStoreRoot: storeRoot,
      ledger, ownerController: owner, ingressRoot });
    const imported = await importer.importMarkdownGraph(path.join(sourceRoot, 'A.md'));
    let graph;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      graph = ledger.getLinkDiagnostics({ documentId: imported.imported[0]?.documentId });
      if (graph.counts.resolved >= 1 && graph.counts.missing >= 1) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    context.assert(imported.counts.imported === 2 && graph?.counts.resolved >= 1
      && graph?.counts.missing >= 1,
    'owner drain derives resolved and missing edges from actual imported copies');
    const indexed = ledger.open().prepare(`SELECT j.current_path_internal, s.root_path_internal
      FROM index_jobs j JOIN sources s ON s.source_id = j.source_id
      WHERE j.document_id = ? LIMIT 1`).get(imported.imported[0].documentId);
    const samePath = (left, right) => process.platform === 'win32'
      ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
      : path.resolve(left) === path.resolve(right);
    context.assert(samePath(indexed.root_path_internal, sourceRoot)
      && samePath(indexed.current_path_internal, path.join(storeRoot, 'A.md')),
    'external source identity indexes only the contained store copy');
  } finally { await owner.shutdown(); ledger.close(); }
}

async function verifyCFault(context, faultAt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `doculight-s17-${faultAt}-`));
  const sourceRoot = path.join(root, 'source');
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'private');
  for (const dir of [sourceRoot, storeRoot, ingressRoot]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(sourceRoot, 'A.md'), '# A\n[B](./B.md)\n');
  fs.writeFileSync(path.join(sourceRoot, 'B.md'), '# B\n[C](./C.md)\n');
  fs.writeFileSync(path.join(sourceRoot, 'C.md'), '# C\n[A](./A.md)\n');
  const ledgerPath = path.join(root, 'ledger.sqlite');
  const owner = new OwnerWorkerController({ ledgerPath,
    keywordPath: path.join(root, 'keyword.sqlite'), sourceRoot: storeRoot,
    ingressRoot, keywordTokenizerProvider: 'basic', deriveDocuments: false });
  const ledger = new SourceLedgerStore({ dbPath: ledgerPath });
  const abort = new AbortController();
  const originalAccept = owner.acceptPublishedSave.bind(owner);
  try {
    await owner.start();
    const importer = createLinkedImporter({ sourceRoot, knowledgeStoreRoot: storeRoot,
      ledger, ownerController: owner, ingressRoot, signal: abort.signal });
    importer.r3PublishFaultAt = ({ sourceRelativePath }) => sourceRelativePath === 'C.md' ? faultAt : null;
    if (faultAt === 'cancel') owner.acceptPublishedSave = async input => {
      const accepted = await originalAccept(input);
      if (input.sourceRelativeLocator === 'B.md') abort.abort();
      return accepted;
    };
    if (faultAt === 'after_ack') owner.acceptPublishedSave = async input => {
      const accepted = await originalAccept(input);
      if (input.sourceRelativeLocator === 'C.md') throw new Error('ACK lost');
      return accepted;
    };
    const partial = await importer.importMarkdownGraph(path.join(sourceRoot, 'A.md'));
    const b = ledger.open().prepare("SELECT * FROM documents WHERE path_key = 'b.md'").get();
    const cBefore = ledger.open().prepare("SELECT * FROM documents WHERE path_key = 'c.md'").get();
    const intents = fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json'));
    context.assert(partial.counts.imported === 2
      && (faultAt === 'after_ack' ? partial.unconfirmedCount === 1 && partial.counts.stale === 0
        : partial.unconfirmedCount === 0)
      && b?.desired_revision === 1
      && fs.readFileSync(path.join(storeRoot, 'B.md'), 'utf8') === '# B\n[C](./C.md)\n'
      && (faultAt === 'after_ack' ? Boolean(cBefore) : !cBefore),
    `${faultAt}: C boundary retains B copy, document, and owner job with partial count`);
    context.assert(faultAt === 'cancel' || faultAt === 'after_ack' || faultAt === 'intent_rename'
      ? intents.length === 0
      : intents.length === 1,
    `${faultAt}: C leaves the appropriate private intent state`);
    importer.r3PublishFaultAt = null;
    owner.acceptPublishedSave = originalAccept;
    const retry = await createLinkedImporter({ sourceRoot, knowledgeStoreRoot: storeRoot,
      ledger, ownerController: owner, ingressRoot }).importMarkdownGraph(path.join(sourceRoot, 'A.md'));
    const bAfter = ledger.open().prepare("SELECT * FROM documents WHERE path_key = 'b.md'").get();
    const c = ledger.open().prepare("SELECT * FROM documents WHERE path_key = 'c.md'").get();
    context.assert(retry.counts.existing >= 2 && c?.desired_revision === 1
      && bAfter.document_id === b.document_id && bAfter.desired_revision === 1
      && fs.readFileSync(path.join(storeRoot, 'C.md'), 'utf8') === '# C\n[A](./A.md)\n'
      && ledger.open().prepare('SELECT count(*) AS count FROM save_intent_acceptances WHERE document_id = ?')
        .get(c.document_id).count === 1,
    `${faultAt}: retry converges C to one identity, copy, intent acceptance, and revision`);
  } finally { await owner.shutdown(); ledger.close(); }
}

// @req FR-DOC-033 DR-DOC-013 DR-DOC-014 FR-DOC-019 REL-DOC-009
module.exports = { async run(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s17-'));
  const sourceRoot = path.join(root, 'source');
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'private');
  for (const dir of [sourceRoot, storeRoot, ingressRoot]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(sourceRoot, 'A.md'), '# A\n\n[B](./B.md)\n[Missing](./Missing.md)\n');
  fs.writeFileSync(path.join(sourceRoot, 'B.md'), '# B\n\n[C](./C.md)\n');
  fs.writeFileSync(path.join(sourceRoot, 'C.md'), '# C\n\n[A](./A.md)\n[Self](./C.md)\n');
  const ledgerPath = path.join(root, 'ledger.sqlite');
  const owner = new OwnerWorkerController({ ledgerPath, keywordPath: path.join(root, 'keyword.sqlite'),
    sourceRoot: storeRoot, ingressRoot, keywordTokenizerProvider: 'basic', deriveDocuments: false });
  const ledger = new SourceLedgerStore({ dbPath: ledgerPath });
  const originalAccept = owner.acceptPublishedSave.bind(owner);
  let calls = 0;
  const ownerInputs = [];
  owner.acceptPublishedSave = async input => {
    calls += 1;
    ownerInputs.push(input);
    if (calls >= 3) throw new Error('C owner fault');
    return originalAccept(input);
  };
  try {
    await owner.start();
    const importer = createLinkedImporter({ sourceRoot, knowledgeStoreRoot: storeRoot,
      ledger, ownerController: owner, ingressRoot });
    const partial = await importer.importMarkdownGraph(path.join(sourceRoot, 'A.md'));
    const b = ledger.open().prepare("SELECT * FROM documents WHERE path_key = 'b.md'").get();
    context.assert(partial.counts.imported === 2 && partial.counts.updated === 0
      && partial.counts.stale === 0 && partial.unconfirmedCount === 1
      && fs.readFileSync(path.join(storeRoot, 'B.md'), 'utf8') === '# B\n\n[C](./C.md)\n'
      && b?.desired_revision === 1 && b?.current_job_id,
    'C owner failure returns partial counts and preserves B copy, identity, revision, and job');
    context.assert(calls === 4 && fs.readdirSync(ingressRoot).some(name => name.endsWith('.intent.json')),
      'import retries the exact C intent once, then retains its durable intent on unconfirmed owner acceptance');
    context.assert(ownerInputs.every(input => JSON.stringify(Object.keys(input).sort()) === JSON.stringify([
      'contentHash', 'intentId', 'operation', 'provenance', 'rootFingerprint',
      'sourceId', 'sourceRelativeLocator'])),
    'import owner calls contain exactly the seven durable identity and provenance fields');
    const pendingName = fs.readdirSync(ingressRoot).find(name => name.endsWith('.intent.json'));
    const pending = JSON.parse(fs.readFileSync(path.join(ingressRoot, pendingName), 'utf8'));
    context.assert(pending.operation === 'linked_import' && pending.sourceRelativeLocator === 'C.md'
      && !JSON.stringify(pending).includes('# C')
      && fs.readFileSync(path.join(storeRoot, 'C.md'), 'utf8').startsWith('# C'),
    'C published file and body-free intent survive owner fault');
    owner.acceptPublishedSave = originalAccept;
    const retry = await importer.importMarkdownGraph(path.join(sourceRoot, 'A.md'));
    const bAfter = ledger.open().prepare("SELECT * FROM documents WHERE path_key = 'b.md'").get();
    const c = ledger.open().prepare("SELECT * FROM documents WHERE path_key = 'c.md'").get();
    context.assert(retry.counts.existing >= 2 && retry.counts.imported === 1
      && bAfter.document_id === b.document_id && bAfter.desired_revision === 1
      && c?.desired_revision === 1,
    'retry converges B unchanged and accepts C once');
    const cJobs = ledger.open().prepare('SELECT count(*) AS count FROM index_jobs WHERE document_id = ?')
      .get(c.document_id).count;
    const cAliases = ledger.open().prepare('SELECT count(*) AS count FROM document_source_aliases WHERE document_id = ?')
      .get(c.document_id).count;
    context.assert(cJobs === 1 && cAliases === 1 && !fs.readdirSync(ingressRoot).some(name => name.endsWith('.intent.json')),
      'retry creates one C job and original alias, then owner clears its durable intent');
    fs.writeFileSync(path.join(sourceRoot, 'FaultUpdate.md'), '# Old\n');
    const firstUpdate = await importer.importMarkdownGraph(path.join(sourceRoot, 'FaultUpdate.md'));
    const originalId = firstUpdate.imported[0].documentId;
    fs.writeFileSync(path.join(sourceRoot, 'FaultUpdate.md'), '# New\n');
    owner.acceptPublishedSave = async input => input.sourceRelativeLocator === 'FaultUpdate.md'
      ? Promise.reject(new Error('owner rejected update after publication')) : originalAccept(input);
    const failedUpdate = await importer.importMarkdownGraph(path.join(sourceRoot, 'FaultUpdate.md'));
    const beforeReplay = ledger.open().prepare('SELECT desired_revision FROM documents WHERE document_id = ?')
      .get(originalId).desired_revision;
    context.assert(failedUpdate.unconfirmedCount === 1 && failedUpdate.counts.stale === 0 && beforeReplay === 1
      && fs.readFileSync(path.join(storeRoot, 'FaultUpdate.md'), 'utf8') === '# New\n',
    'changed-content owner fault preserves old owner revision and newly published copy');
    owner.acceptPublishedSave = originalAccept;
    fs.writeFileSync(path.join(sourceRoot, 'FaultUpdate.md'), '# Different\n');
    const differentUpdate = await importer.importMarkdownGraph(path.join(sourceRoot, 'FaultUpdate.md'));
    context.assert(differentUpdate.counts.stale === 1
      && ledger.open().prepare('SELECT desired_revision FROM documents WHERE document_id = ?')
        .get(originalId).desired_revision === 1
      && fs.readFileSync(path.join(storeRoot, 'FaultUpdate.md'), 'utf8') === '# New\n',
    'different intent cannot bypass prior-hash guard or overwrite pending published update');
    fs.writeFileSync(path.join(sourceRoot, 'FaultUpdate.md'), '# New\n');
    const replayUpdate = await importer.importMarkdownGraph(path.join(sourceRoot, 'FaultUpdate.md'));
    const afterReplay = ledger.open().prepare('SELECT desired_revision FROM documents WHERE document_id = ?')
      .get(originalId).desired_revision;
    context.assert(replayUpdate.counts.updated === 1 && afterReplay === 2
      && !fs.readdirSync(ingressRoot).some(name => name.endsWith('.intent.json')),
    'update retry accepts matching already-published intent at one stable owner revision');
    const acceptedBeforeUnchanged = ledger.open().prepare(
      'SELECT count(*) AS count FROM save_intent_acceptances WHERE document_id = ?').get(c.document_id).count;
    const unchanged = await importer.importMarkdownGraph(path.join(sourceRoot, 'A.md'));
    context.assert(unchanged.counts.existing === 3
      && ledger.open().prepare('SELECT count(*) AS count FROM save_intent_acceptances WHERE document_id = ?')
        .get(c.document_id).count === acceptedBeforeUnchanged,
    'unchanged rerun publishes no duplicate intent or owner revision');
    const aliasPath = process.platform === 'win32' ? path.join(sourceRoot, 'b.md') : path.join(sourceRoot, 'AliasB.md');
    let aliasAvailable = process.platform === 'win32';
    if (!aliasAvailable) {
      try { fs.symlinkSync(path.join(sourceRoot, 'B.md'), aliasPath, 'file'); aliasAvailable = true; }
      catch (error) { if (error.code !== 'EPERM') throw error; }
    }
    if (aliasAvailable) {
      const aliasRun = await importer.importMarkdownGraph(aliasPath);
      const aliases = ledger.open().prepare('SELECT origin_lexical_path_internal FROM document_source_aliases WHERE document_id = ?')
        .all(b.document_id);
      context.assert(aliasRun.counts.existing >= 1 && aliases.some(row => row.origin_lexical_path_internal === aliasPath)
        && ledger.open().prepare('SELECT count(*) AS count FROM index_jobs WHERE document_id = ?')
          .get(b.document_id).count === 1,
      'canonical alias import keeps stable B ID and adds lexical provenance without duplicate job');
    }
    fs.writeFileSync(path.join(sourceRoot, 'B.md'), '# B changed\n\n[C](./C.md)\n');
    const changed = await importer.importMarkdownGraph(path.join(sourceRoot, 'B.md'));
    const bChanged = ledger.open().prepare("SELECT * FROM documents WHERE path_key = 'b.md'").get();
    context.assert(changed.counts.updated === 1 && bChanged.document_id === b.document_id
      && bChanged.desired_revision === 2
      && fs.readFileSync(path.join(storeRoot, 'B.md'), 'utf8').startsWith('# B changed'),
    'changed original retains B identity and advances owner desired revision once');
    const abort = new AbortController();
    fs.writeFileSync(path.join(sourceRoot, 'D.md'), '# D\n\n[E](./E.md)\n');
    fs.writeFileSync(path.join(sourceRoot, 'E.md'), '# E\n');
    owner.acceptPublishedSave = async input => {
      const accepted = await originalAccept(input);
      if (input.sourceRelativeLocator === 'D.md') abort.abort();
      return accepted;
    };
    const cancelled = await createLinkedImporter({ sourceRoot, knowledgeStoreRoot: storeRoot,
      ledger, ownerController: owner, ingressRoot, signal: abort.signal })
      .importMarkdownGraph(path.join(sourceRoot, 'D.md'));
    context.assert(cancelled.counts.imported === 1 && !fs.existsSync(path.join(storeRoot, 'E.md'))
      && cancelled.diagnostics.some(item => item.diagnosticCode === 'cancelled')
      && ledger.open().prepare("SELECT document_id FROM documents WHERE path_key = 'd.md'").get(),
    'cancel is checked at the next document boundary and preserves acknowledged D');
    owner.acceptPublishedSave = originalAccept;
    fs.writeFileSync(path.join(sourceRoot, '한 글.markdown'), '# Korean and space\n');
    const markdown = await importer.importMarkdownGraph(path.join(sourceRoot, '한 글.markdown'));
    context.assert(markdown.counts.imported === 1
      && fs.readFileSync(path.join(storeRoot, '한 글.markdown'), 'utf8') === '# Korean and space\n'
      && ledger.open().prepare('SELECT document_id FROM documents WHERE path_key = ?')
        .get('한 글.markdown'),
    'Korean and space .markdown path publishes atomically and receives owner identity');
    const outside = path.join(root, 'Outside.md');
    fs.writeFileSync(outside, '# Outside\n');
    const rowsBeforeViolation = ledger.open().prepare('SELECT count(*) AS count FROM documents').get().count;
    const pathViolation = await importer.importMarkdownGraph(outside);
    context.assert(pathViolation.counts.path_policy_violation === 1
      && !fs.existsSync(path.join(storeRoot, 'Outside.md'))
      && ledger.open().prepare('SELECT count(*) AS count FROM documents').get().count === rowsBeforeViolation,
    'outside-root entry is rejected before copy or owner document row');
    for (const faultAt of ['intent_rename', 'document_rename', 'post_publish', 'after_ack', 'cancel']) {
      await verifyCFault(context, faultAt);
    }
    await verifyImportedGraph(context);
  } finally { await owner.shutdown(); ledger.close(); }
} };
