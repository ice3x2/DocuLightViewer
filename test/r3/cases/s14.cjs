'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveDocumentToStore } = require('../../../src/main/mcp-save');
const { publishSave, readPendingSave } = require('../../../src/main/index-ingress-store');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');

// @req FR-DOC-028 IR-MCP-018 FR-DOC-019 REL-DOC-009 SEC-DOC-003
module.exports = { async run(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s14-'));
  const storeRoot = path.join(root, 'documents');
  const ingressRoot = path.join(root, 'private');
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(ingressRoot);
  const store = { get(key, fallback) { return ({ mcpAutoSave: true, mcpAutoSavePath: storeRoot,
    mcpSaveSubDir: 'notes', userDataPath: root })[key] ?? fallback; } };
  const calls = [];
  const ownerController = { config: { sourceRoot: storeRoot, ingressRoot },
    async acceptPublishedSave(input) { calls.push(input); return { accepted: true,
      documentId: 'doc_owner_fixture', desiredRevision: 1, indexingState: 'queued',
      indexing: { state: 'queued', jobId: 'job_fixture' }, warnings: [] }; } };
  try {
    const response = await saveDocumentToStore(store, { content: '# Durable S14 marker\n',
      title: 'Durable title', project: 'work', category: 'manual', documentTags: ['one'] },
    { ownerController, getIndexDataDir: () => root,
      queueDocumentIndex() { throw new Error('old queue called'); } });
    const body = JSON.parse(response.content[0].text);
    context.assert(response.isError !== true && body.saved === true && body.indexing.state === 'queued'
      && body.indexing.jobId === 'job_fixture' && body.documentId === 'doc_owner_fixture',
    'queued and jobId follow owner commit ACK');
    context.assert(calls.length === 1 && /^[a-f0-9]{64}$/.test(calls[0].intentId),
      'adapter calls owner with durable intent identity');
    const intent = readPendingSave({ storeRoot, ingressRoot, intentId: calls[0].intentId });
    context.assert(intent?.published === true && intent.operation === 'save_document'
      && fs.readFileSync(path.join(storeRoot, intent.sourceRelativeLocator), 'utf8').includes('Durable S14 marker'),
    'owner sees an atomic published file and body-free durable intent');
    context.assert(Object.keys(intent.provenance.metadata).length === 0,
      'private intent omits title and metadata recoverable from final frontmatter');
    const replayedPublication = await publishSave({ storeRoot, ingressRoot,
      intentId: intent.intentId, requireVacant: true, sourceRelativeLocator: intent.sourceRelativeLocator,
      operation: intent.operation, sourceId: intent.sourceId, rootFingerprint: intent.rootFingerprint,
      contentBytes: fs.readFileSync(path.join(storeRoot, intent.sourceRelativeLocator)),
      contentHash: intent.contentHash, provenance: intent.provenance });
    context.assert(replayedPublication.intentId === intent.intentId,
      'explicit same-intent replay reuses a published final despite new-save vacancy guard');
    const RealDate = Date;
    const fixed = new RealDate('2026-09-25T09:00:00.000Z');
    let sameA;
    let sameB;
    try {
      global.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [fixed])); }
        static now() { return fixed.getTime(); }
      };
      sameA = JSON.parse((await saveDocumentToStore(store, { content: '# Same\n', title: 'Same' },
        { saveDocumentIngressRoot: ingressRoot })).content[0].text);
      sameB = JSON.parse((await saveDocumentToStore(store, { content: '# Same\n', title: 'Same' },
        { saveDocumentIngressRoot: ingressRoot })).content[0].text);
    } finally { global.Date = RealDate; }
    context.assert(sameA.saved === true && sameB.saved === true
      && sameA.sourceRelativePath !== sameB.sourceRelativePath
      && sameA.documentId !== sameB.documentId,
    'two new saves with identical body and timestamp allocate distinct contained identities');
    const failed = await saveDocumentToStore(store, { content: '# Owner unavailable marker\n',
      title: 'Retry', category: 'research' }, { saveDocumentIngressRoot: ingressRoot });
    const failedBody = JSON.parse(failed.content[0].text);
    context.assert(failedBody.saved === true && failedBody.indexing.state === 'enqueue_failed'
      && !failedBody.indexing.jobId && failedBody.warnings[0]?.code === 'index_enqueue_failed',
    'owner unavailability preserves save and returns retryable warning without jobId');
    const pendingName = fs.readdirSync(ingressRoot).find(name => name.endsWith('.intent.json')
      && fs.readFileSync(path.join(ingressRoot, name), 'utf8').includes('Owner unavailable'));
    context.assert(!pendingName, 'private intent contains no Markdown body');
    const pendingFiles = fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json'));
    const failedIntent = pendingFiles.find(name => JSON.parse(fs.readFileSync(path.join(ingressRoot, name), 'utf8'))
      .sourceRelativeLocator === failedBody.sourceRelativePath);
    context.assert(Boolean(failedIntent) && fs.existsSync(path.join(storeRoot, failedBody.sourceRelativePath)),
      'failed acceptance retains published Markdown and an intent for replay');
    const afterPublish = await saveDocumentToStore(store, { content: '# Fault after publish\n',
      title: 'After publish' }, { saveDocumentIngressRoot: ingressRoot, r3SaveFaultAt: 'post_publish' });
    const afterBody = JSON.parse(afterPublish.content[0].text);
    context.assert(afterBody.saved === true && afterBody.indexing.state === 'enqueue_failed'
      && !afterBody.indexing.jobId && fs.existsSync(path.join(storeRoot, afterBody.sourceRelativePath)),
    'post-publish failure keeps final bytes and reports enqueue_failed without jobId');
    const beforePublish = await saveDocumentToStore(store, { content: '# Fault before publish\n',
      title: 'Before publish' }, { saveDocumentIngressRoot: ingressRoot, r3SaveFaultAt: 'document_rename' });
    context.assert(beforePublish.isError === true && JSON.parse(beforePublish.content[0].text).saved === false,
      'pre-publish failure does not claim a saved file');
    const cancelled = await saveDocumentToStore(store, { content: '# Cancelled acceptance\n',
      title: 'Cancelled' }, { ownerController: { config: { ingressRoot },
        async acceptPublishedSave() { return { accepted: false, indexingState: 'enqueue_failed',
          indexing: { state: 'enqueue_failed', jobId: 'uncommitted-job' } }; } } });
    const cancelledBody = JSON.parse(cancelled.content[0].text);
    context.assert(cancelledBody.saved === true && cancelledBody.indexing.state === 'enqueue_failed'
      && !cancelledBody.indexing.jobId
      && fs.existsSync(path.join(storeRoot, cancelledBody.sourceRelativePath)),
    'rejected or cancelled acceptance preserves bytes and withholds uncommitted jobId');
    const realOwner = new OwnerWorkerController({ ledgerPath: path.join(root, 'ledger.sqlite'),
      keywordPath: path.join(root, 'keyword.sqlite'), sourceRoot: storeRoot,
      ingressRoot, keywordTokenizerProvider: 'basic', deriveDocuments: true });
    try {
      await realOwner.start();
      let realReply;
      const committed = await saveDocumentToStore(store, { content: '# Real owner marker\n',
        title: 'Committed' }, { ownerController: { config: realOwner.config,
          async acceptPublishedSave(input) { realReply = await realOwner.acceptPublishedSave(input); return realReply; } } });
      const committedBody = JSON.parse(committed.content[0].text);
      context.assert(committedBody.saved === true && committedBody.indexing.state === 'queued'
        && Boolean(committedBody.indexing.jobId) && Boolean(committedBody.documentId),
      `real save_document adapter reaches owner transaction before public queued ACK: ${JSON.stringify(committedBody)} ${JSON.stringify(realReply)}`);
      let lostAck;
      let lostIntentId;
      const lostResponse = await saveDocumentToStore(store, { content: '# Lost ACK marker\n',
        title: 'Lost ACK' }, { ownerController: { config: realOwner.config,
          async acceptPublishedSave(input) {
            lostIntentId = input.intentId;
            lostAck = await realOwner.acceptPublishedSave(input);
            throw new Error('ACK transport lost');
          } } });
      const lostBody = JSON.parse(lostResponse.content[0].text);
      context.assert(lostAck.accepted === true && lostBody.saved === true
        && lostBody.indexing.state === 'enqueue_failed' && !lostBody.indexing.jobId,
      'lost post-commit ACK never claims a public jobId');
      const receipt = await realOwner.acceptPublishedSave({ storeRoot, ingressRoot, intentId: lostIntentId });
      context.assert(receipt.documentId === lostAck.documentId
        && receipt.desiredRevision === lostAck.desiredRevision
        && receipt.indexing.jobId === lostAck.indexing.jobId,
      'post-commit ACK replay returns the one committed identity and revision');
      const retried = await realOwner.acceptPublishedSave({ storeRoot, ingressRoot,
        intentId: failedIntent.slice(0, 64) });
      context.assert(retried.accepted === true && retried.indexingState === 'queued'
        && Number.isSafeInteger(retried.desiredRevision) && Boolean(retried.indexing.jobId),
      'real owner commits replayed metadata and job before queued ACK');
      context.assert(failedBody.documentId === retried.documentId,
        'enqueue failure returns the same document identity that retry commits');
      const replay = await realOwner.acceptPublishedSave({ storeRoot, ingressRoot,
        intentId: failedIntent.slice(0, 64) });
      context.assert(replay.accepted === true && replay.documentId === retried.documentId
        && replay.desiredRevision === retried.desiredRevision && replay.indexing.jobId === retried.indexing.jobId,
      'post-commit replay converges on one document, revision, and job');
    } finally { await realOwner.shutdown(); }
    const aliasStore = path.join(root, 'alias-store');
    const canonicalStore = path.join(root, 'canonical-store');
    const aliasIngress = path.join(root, 'alias-private');
    const aliasLedgerPath = path.join(root, 'alias-ledger.sqlite');
    fs.mkdirSync(canonicalStore);
    fs.mkdirSync(aliasIngress);
    fs.symlinkSync(canonicalStore, aliasStore, process.platform === 'win32' ? 'junction' : 'dir');
    const seeded = new SourceLedgerStore({ dbPath: aliasLedgerPath });
    try {
      seeded.initialize();
      seeded.recordSource({ rootPathInternal: aliasStore, rootFingerprint:
        require('node:crypto').createHash('sha256').update(path.resolve(aliasStore)).digest('hex') });
    } finally { seeded.close(); }
    const aliasOwner = new OwnerWorkerController({ ledgerPath: aliasLedgerPath,
      keywordPath: path.join(root, 'alias-keyword.sqlite'), sourceRoot: aliasStore,
      publicationRoot: canonicalStore, ingressRoot: aliasIngress,
      keywordTokenizerProvider: 'basic', deriveDocuments: true });
    try {
      await aliasOwner.start();
      const aliasResponse = await saveDocumentToStore({ get(key, fallback) { return ({
        mcpAutoSave: true, mcpAutoSavePath: aliasStore, mcpSaveSubDir: '' })[key] ?? fallback; } },
      { content: '# Alias root marker\n', title: 'Alias' }, { ownerController: aliasOwner });
      const aliasBody = JSON.parse(aliasResponse.content[0].text);
      context.assert(aliasBody.saved === true && aliasBody.indexing.state === 'queued'
        && fs.existsSync(path.join(canonicalStore, aliasBody.sourceRelativePath))
        && !aliasResponse.content[0].text.includes(aliasStore)
        && !aliasResponse.content[0].text.includes(canonicalStore),
      'junction-configured store publishes canonically and commits through owner');
      const aliasLedger = new SourceLedgerStore({ dbPath: aliasLedgerPath });
      try {
        const db = aliasLedger.open();
        context.assert(db.prepare('SELECT COUNT(*) AS n FROM sources').get().n === 1
          && db.prepare('SELECT source_id FROM documents WHERE document_id = ?').get(aliasBody.documentId)?.source_id
            === db.prepare('SELECT source_id FROM sources').get().source_id,
        'junction save retains the existing lexical source and document identity');
      } finally { aliasLedger.close(); }
    } finally { await aliasOwner.shutdown(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} };
