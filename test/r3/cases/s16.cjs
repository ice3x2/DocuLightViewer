'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOpenedMarkdownRegistrar } = require('../../../src/main/opened-markdown-registrar');
const { registerRendererSaveHandlers } = require('../../../src/main/renderer-save-handlers');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { publishSave, readPendingSave } = require('../../../src/main/index-ingress-store');

// @req FR-DOC-035 DR-DOC-014 FR-DOC-036 FR-DOC-019 REL-DOC-009 SEC-DOC-003
module.exports = { async run(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s16-'));
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'intents');
  const externalRoot = path.join(root, 'external');
  const aliasRoot = path.join(root, 'alias');
  for (const dir of [storeRoot, ingressRoot, externalRoot]) fs.mkdirSync(dir);
  const ledgerPath = path.join(root, 'ledger.sqlite');
  const owner = new OwnerWorkerController({ ledgerPath,
    keywordPath: path.join(root, 'keyword.sqlite'), sourceRoot: storeRoot,
    ingressRoot, keywordTokenizerProvider: 'basic', deriveDocuments: false });
  const store = { get(key, fallback) { return ({ mcpAutoSavePath: storeRoot,
    registerOpenedMarkdown: true, lastSaveAsDirectory: externalRoot })[key] ?? fallback; }, set() {} };
  const reader = new SourceLedgerStore({ dbPath: ledgerPath, readOnly: true });
  const searchEngine = { ownerController: owner, getSourceLedger() { return reader; },
    markDirty() { throw new Error('legacy external markDirty'); } };
  const registrar = createOpenedMarkdownRegistrar({ store, searchEngine });
  const canonical = path.join(externalRoot, 'Origin.md');
  fs.writeFileSync(canonical, '# Origin\n');
  let symlinkAvailable = true;
  try { fs.symlinkSync(externalRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') symlinkAvailable = false;
    else throw error; }
  try {
    await owner.start();
    const first = await registrar.register(canonical);
    context.assert(first.status === 'queued' && first.documentId,
      'external open uses durable owner and receives stable document identity');
    const legacyOriginal = path.join(externalRoot, 'Legacy.markdown');
    const legacyBody = '# Legacy markdown\n';
    fs.writeFileSync(legacyOriginal, legacyBody);
    const legacyDirHash = crypto.createHash('sha256').update(process.platform === 'win32'
      ? path.resolve(externalRoot).toLowerCase() : path.resolve(externalRoot)).digest('hex').slice(0, 16);
    const legacyLocator = path.posix.join('.opened', legacyDirHash, 'Legacy.markdown');
    const legacyCopy = path.join(storeRoot, legacyLocator);
    fs.mkdirSync(path.dirname(legacyCopy), { recursive: true });
    fs.writeFileSync(legacyCopy, legacyBody);
    const seed = new SourceLedgerStore({ dbPath: ledgerPath });
    let legacyDocumentId;
    try {
      const sourceId = seed.open().prepare('SELECT source_id FROM documents WHERE document_id = ?')
        .get(first.documentId).source_id;
      const legacy = seed.upsertDocument({ sourceId, sourceRelativePath: legacyLocator,
        canonicalPathInternal: legacyCopy,
        contentHash: `sha256:${crypto.createHash('sha256').update(legacyBody).digest('hex')}`,
        contentByteLength: Buffer.byteLength(legacyBody), contentTextLength: legacyBody.length });
      legacyDocumentId = legacy.documentId;
      seed.upsertDocumentSourceAlias({ documentId: legacyDocumentId,
        originLexicalPathInternal: legacyOriginal,
        originPathInternal: fs.realpathSync.native(legacyOriginal), aliasKind: 'opened_path',
        contentHash: `sha256:${crypto.createHash('sha256').update(legacyBody).digest('hex')}` });
    } finally { seed.close(); }
    const legacyReopen = await registrar.register(legacyOriginal);
    context.assert(legacyReopen.status === 'existing' && legacyReopen.documentId === legacyDocumentId
      && legacyReopen.indexedPath === legacyCopy,
      'pre-S16 .markdown origin reopens its existing copy and stable document ID');
    fs.writeFileSync(legacyOriginal, '# Legacy changed\n');
    const legacyUpdate = await registrar.register(legacyOriginal);
    context.assert(legacyUpdate.status === 'queued' && legacyUpdate.documentId === legacyDocumentId
      && fs.readFileSync(legacyCopy, 'utf8') === '# Legacy changed\n',
      'pre-S16 .markdown update keeps original contained locator and owner identity');
    const markdownOriginal = path.join(externalRoot, 'Long.markdown');
    fs.writeFileSync(markdownOriginal, '# Long extension\n');
    let markdown;
    try { markdown = await registrar.register(markdownOriginal); }
    catch { markdown = null; }
    context.assert(markdown?.status === 'queued' && markdown.indexedPath.endsWith('.markdown')
      && fs.readFileSync(markdown.indexedPath, 'utf8') === '# Long extension\n',
      'external .markdown origin keeps its alias and original deterministic copy extension');
    const divergedOriginal = path.join(externalRoot, 'Diverged.md');
    fs.writeFileSync(divergedOriginal, '# Initial diverged\n');
    const diverged = await registrar.register(divergedOriginal);
    fs.writeFileSync(diverged.indexedPath, '# User edited indexed copy\n');
    fs.writeFileSync(divergedOriginal, '# Changed original\n');
    const collision = await registrar.register(divergedOriginal);
    context.assert(collision.status === 'skipped' && collision.diagnosticCode === 'opened_destination_content_mismatch'
      && fs.readFileSync(diverged.indexedPath, 'utf8') === '# User edited indexed copy\n',
      'changed original cannot overwrite a diverged contained copy');
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    const lexicalRoot = path.resolve(storeRoot);
    const rootKey = process.platform === 'win32' ? lexicalRoot.toLowerCase() : lexicalRoot;
    let raceError;
    try {
      await publishSave({ storeRoot, ingressRoot, contentBytes: Buffer.from('# Race update\n'),
        contentHash: digest('# Race update\n'), operation: 'update',
        sourceId: `src_${digest(`${rootKey}\0${digest(lexicalRoot)}`).slice(0, 24)}`,
        rootFingerprint: digest(lexicalRoot),
        sourceRelativeLocator: path.relative(storeRoot, diverged.indexedPath).replace(/\\/g, '/'),
        provenance: { aliases: [], metadata: {} },
        expectedExistingHash: digest('# Initial diverged\n') });
    } catch (error) { raceError = error; }
    context.assert(raceError?.code === 'published_file_mismatch'
      && fs.readFileSync(diverged.indexedPath, 'utf8') === '# User edited indexed copy\n',
      'atomic publisher also rejects copy divergence discovered after registrar precheck');
    const copied = first.indexedPath;
    context.assert(copied.startsWith(storeRoot + path.sep) && fs.readFileSync(copied, 'utf8') === '# Origin\n',
      'external open publishes a separate contained indexed copy');
    if (symlinkAvailable) {
      const lexical = path.join(aliasRoot, 'Origin.md');
      const second = await registrar.register(lexical);
      context.assert(second.documentId === first.documentId,
        'junction lexical alias reuses canonical document identity');
      const aliases = reader.open().prepare(`SELECT origin_lexical_path_internal, origin_path_internal,
        canonical_path_hash FROM document_source_aliases WHERE document_id = ?`).all(first.documentId);
      context.assert(aliases.length === 2 && aliases.some(row => row.origin_lexical_path_internal === lexical)
        && aliases.every(row => row.origin_path_internal === fs.realpathSync.native(canonical)),
      'owner retains both lexical aliases and actual canonical target');
      const before = reader.open().prepare('SELECT desired_revision FROM documents WHERE document_id = ?')
        .get(first.documentId).desired_revision;
      context.assert(second.status === 'existing' && reader.open().prepare(
        'SELECT desired_revision FROM documents WHERE document_id = ?').get(first.documentId).desired_revision === before,
      'same bytes with a new alias commits provenance without a duplicate indexing revision');
    }
    fs.writeFileSync(canonical, '# Changed\n');
    const changed = await registrar.register(canonical);
    context.assert(changed.documentId === first.documentId && fs.readFileSync(copied, 'utf8') === '# Changed\n',
      'changed original updates one contained copy and keeps document identity');
    const migration = new SourceLedgerStore({ dbPath: ledgerPath });
    try {
      migration.open().prepare(`UPDATE document_source_aliases
        SET origin_lexical_path_internal = NULL, origin_path_internal = NULL
        WHERE document_id = ? AND origin_lexical_path_internal = ?`).run(first.documentId, canonical);
    } finally { migration.close(); }
    const hashOnly = reader.open().prepare(`SELECT origin_lexical_path_internal, origin_path_internal
      FROM document_source_aliases WHERE document_id = ? AND origin_lexical_path_internal IS NULL`)
      .get(first.documentId);
    context.assert(hashOnly && hashOnly.origin_path_internal === null,
      'legacy hash-only alias remains pathless until a verified source-backed reopen');
    const backfilled = await registrar.register(canonical);
    const restored = reader.open().prepare(`SELECT origin_path_internal FROM document_source_aliases
      WHERE document_id = ? AND origin_lexical_path_internal = ?`).get(first.documentId, canonical);
    context.assert(backfilled.documentId === first.documentId
      && restored?.origin_path_internal === fs.realpathSync.native(canonical),
      'verified same-canonical reopen backfills legacy null origin without changing document ID');
    const handlers = new Map();
    const chosen = path.join(externalRoot, 'Chosen.md');
    registerRendererSaveHandlers({ ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
      dialog: { async showSaveDialog() { return { canceled: false, filePath: chosen }; } },
      BrowserWindow: { fromWebContents() { return {}; } }, store, searchEngine });
    const save = await handlers.get('save-as')({ sender: {} }, { content: '# Saved\n' });
    context.assert(save.success === true && save.filePath === chosen && fs.readFileSync(chosen, 'utf8') === '# Saved\n',
      'renderer save-as preserves chosen external file and response shape');
    const row = reader.open().prepare(`SELECT d.document_id, d.relative_path, d.desired_revision,
      a.origin_lexical_path_internal FROM document_source_aliases a JOIN documents d
      ON d.document_id = a.document_id WHERE a.origin_lexical_path_internal = ?`).get(chosen);
    context.assert(row && row.desired_revision >= 1
      && fs.readFileSync(path.join(storeRoot, row.relative_path), 'utf8') === '# Saved\n',
      'renderer external save-as publishes contained copy and owner job with alias');
    const firstSaveRevision = row.desired_revision;
    const quick = await handlers.get('quick-save')({}, { defaultFileName: 'Chosen.md', content: '# Quick\n' });
    const quickRow = reader.open().prepare('SELECT desired_revision FROM documents WHERE document_id = ?')
      .get(row.document_id);
    context.assert(quick.success === true && quick.filePath === chosen
      && fs.readFileSync(chosen, 'utf8') === '# Quick\n'
      && fs.readFileSync(path.join(storeRoot, row.relative_path), 'utf8') === '# Quick\n'
      && quickRow.desired_revision > firstSaveRevision,
    'renderer quick-save updates chosen file and same owner document revision');
    context.assert(!JSON.stringify(save).includes('sourcePath') && !JSON.stringify(save).includes(storeRoot),
      'renderer response adds no sourcePath or private indexed copy path');
    const blockedPath = path.join(externalRoot, 'Blocked.md');
    const dirHash = crypto.createHash('sha256').update(process.platform === 'win32'
      ? path.resolve(externalRoot).toLowerCase() : path.resolve(externalRoot)).digest('hex').slice(0, 16);
    fs.mkdirSync(path.join(storeRoot, '.opened', dirHash, 'Blocked.md'));
    const blockedHandlers = new Map();
    registerRendererSaveHandlers({ ipcMain: { handle(name, handler) { blockedHandlers.set(name, handler); } },
      dialog: { async showSaveDialog() { return { canceled: false, filePath: blockedPath }; } },
      BrowserWindow: { fromWebContents() { return {}; } }, store, searchEngine });
    const blocked = await blockedHandlers.get('save-as')({ sender: {} }, { content: '# Blocked copy\n' });
    const privateDiagnostics = fs.readdirSync(ingressRoot).filter(name => name.endsWith('.registration.json'));
    const diagnostic = privateDiagnostics.map(name => JSON.parse(fs.readFileSync(path.join(ingressRoot, name), 'utf8')))
      .find(item => item.originLexicalPathInternal === blockedPath);
    context.assert(blocked.success === true && blocked.filePath === blockedPath
      && fs.readFileSync(blockedPath, 'utf8') === '# Blocked copy\n'
      && diagnostic?.retryable === true && diagnostic.diagnosticCode === 'destination_not_file'
      && !JSON.stringify(blocked).includes('sourcePath'),
      'pre-publication copy failure preserves external save and a private retryable diagnostic');
    const failurePath = path.join(externalRoot, 'Retry.md');
    const beforeFailure = fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json')).length;
    const originalAccept = owner.acceptPublishedSave.bind(owner);
    owner.acceptPublishedSave = async () => { throw new Error('owner unavailable'); };
    try {
      const failureHandlers = new Map();
      registerRendererSaveHandlers({ ipcMain: { handle(name, handler) { failureHandlers.set(name, handler); } },
        dialog: { async showSaveDialog() { return { canceled: false, filePath: failurePath }; } },
        BrowserWindow: { fromWebContents() { return {}; } }, store, searchEngine });
      const failed = await failureHandlers.get('save-as')({ sender: {} }, { content: '# Retry\n' });
      context.assert(failed.success === true && failed.filePath === failurePath
        && fs.readFileSync(failurePath, 'utf8') === '# Retry\n',
      'owner failure after external save preserves chosen file and response');
      const pending = fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json'));
      context.assert(pending.length === beforeFailure + 1, 'failed owner ACK retains private retryable intent');
      const intentId = pending.at(-1).slice(0, 64);
      const intent = readPendingSave({ storeRoot, ingressRoot, intentId });
      context.assert(intent?.published === true && fs.readFileSync(path.join(storeRoot,
        intent.sourceRelativeLocator), 'utf8') === '# Retry\n',
      'failed owner ACK keeps completed indexed copy with matching bytes');
      const replay = await originalAccept({ storeRoot, ingressRoot, intentId,
        operation: intent.operation, sourceId: intent.sourceId,
        rootFingerprint: intent.rootFingerprint,
        sourceRelativeLocator: intent.sourceRelativeLocator, contentHash: intent.contentHash,
        provenance: intent.provenance });
      context.assert(replay.accepted === true && replay.documentId,
        'retry accepts retained intent without deleting external file or copy');
    } finally { owner.acceptPublishedSave = originalAccept; }
    await owner.shutdown();
    const restarted = new OwnerWorkerController({ ledgerPath,
      keywordPath: path.join(root, 'keyword.sqlite'), sourceRoot: storeRoot,
      ingressRoot, keywordTokenizerProvider: 'basic', deriveDocuments: false });
    try {
      await restarted.start();
      searchEngine.ownerController = restarted;
      const reopened = await registrar.register(canonical);
      context.assert(reopened.status === 'existing' && reopened.documentId === first.documentId
        && fs.readFileSync(copied, 'utf8') === '# Changed\n',
      `fresh owner restart keeps stable document identity, aliases, and copied bytes (${reopened.status}, ${reopened.documentId === first.documentId})`);
    } finally { await restarted.shutdown(); }
  } finally {
    reader.close();
    await owner.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
} };
