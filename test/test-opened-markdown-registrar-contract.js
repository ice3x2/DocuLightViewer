'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SearchEngine } = require('../src/main/search-engine');
const { createOpenedMarkdownRegistrar } = require('../src/main/opened-markdown-registrar');

function createStore(values) {
  return {
    get(key, defaultValue) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : defaultValue;
    }
  };
}

async function removeTreeWithRetry(targetPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err && err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

function queuedJobs(searchEngine) {
  return searchEngine.getSourceLedger().getRecoverableIndexJobs({ statuses: ['queued', 'indexing'] });
}

function openedDestinationFor(sourceRoot, filePath) {
  const canonicalPath = fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
  const dirHash = stableHash(normalizeInternalPath(path.dirname(canonicalPath))).slice(0, 16);
  return path.join(sourceRoot, '.opened', dirHash, path.basename(canonicalPath));
}

function normalizeInternalPath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-opened-registrar-'));
  const storeRoot = path.join(root, 'store');
  const aliasedStoreRoot = path.join(root, 'store-alias');
  const externalRoot = path.join(root, 'external');
  const externalRoot2 = path.join(root, 'external2');
  const indexRoot = path.join(root, 'userData', 'index');
  const aliasedIndexRoot = path.join(root, 'alias-userData', 'index');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.mkdirSync(externalRoot, { recursive: true });
  fs.mkdirSync(externalRoot2, { recursive: true });
  fs.symlinkSync(storeRoot, aliasedStoreRoot, process.platform === 'win32' ? 'junction' : 'dir');

  let searchEngine = null;
  let aliasedSearchEngine = null;
  let success = false;
  try {
    searchEngine = new SearchEngine(createStore({
      mcpAutoSave: true,
      mcpAutoSavePath: storeRoot,
      registerOpenedMarkdown: true
    }), {
      indexBackend: 'sqlite',
      indexDataDir: indexRoot,
      disableIndexingWorkerController: true,
      smartIndexDelayMs: 60 * 60 * 1000
    });

    const registrar = createOpenedMarkdownRegistrar({
      store: createStore({
        mcpAutoSavePath: storeRoot,
        registerOpenedMarkdown: true
      }),
      searchEngine
    });

    const disabledRegistrar = createOpenedMarkdownRegistrar({
      store: createStore({
        mcpAutoSavePath: storeRoot,
        registerOpenedMarkdown: false
      }),
      searchEngine
    });

    aliasedSearchEngine = new SearchEngine(createStore({
      mcpAutoSave: true,
      mcpAutoSavePath: aliasedStoreRoot,
      registerOpenedMarkdown: true
    }), {
      indexBackend: 'sqlite',
      indexDataDir: aliasedIndexRoot,
      disableIndexingWorkerController: true,
      smartIndexDelayMs: 60 * 60 * 1000
    });
    const aliasedRegistrar = createOpenedMarkdownRegistrar({
      store: createStore({
        mcpAutoSavePath: aliasedStoreRoot,
        registerOpenedMarkdown: true
      }),
      searchEngine: aliasedSearchEngine
    });
    const aliasedInsidePath = path.join(aliasedStoreRoot, 'AliasedInside.md');
    fs.writeFileSync(aliasedInsidePath, '# Aliased Inside\n', 'utf-8');
    const aliasedInside = await aliasedRegistrar.register(aliasedInsidePath);
    assert.strictEqual(aliasedInside.status, 'queued', 'aliased knowledge-store path queues indexing');
    assert.strictEqual(path.resolve(aliasedInside.indexedPath), path.resolve(aliasedInsidePath), 'aliased knowledge-store path remains an inside-store path');
    assert.strictEqual(fs.existsSync(path.join(aliasedStoreRoot, '.opened')), false, 'aliased knowledge-store path is not copied into the opened namespace');
    assert(aliasedInside.document && aliasedInside.document.documentId, 'aliased knowledge-store registration returns document identity');
    assert.strictEqual(aliasedInside.document.sourceRelativePath, 'AliasedInside.md', 'aliased knowledge-store registration keeps the configured-root-relative path');
    assert.strictEqual(aliasedInside.document.pathKey, 'aliasedinside.md', 'aliased knowledge-store registration keeps the normalized configured-root path key');
    const aliasedJobsAfterFirst = queuedJobs(aliasedSearchEngine);
    const aliasedJob = aliasedJobsAfterFirst.find((job) => job.documentId === aliasedInside.document.documentId);
    assert(aliasedJob, 'aliased knowledge-store registration queues its document job');
    assert.strictEqual(path.resolve(aliasedJob.currentPathInternal), path.resolve(aliasedInsidePath), 'aliased queue job keeps the configured-root path');
    const canonicalAgain = await aliasedRegistrar.register(path.join(storeRoot, 'AliasedInside.md'));
    assert.strictEqual(canonicalAgain.status, 'existing', 'canonical reopen of an aliased knowledge-store document is a no-op');
    assert.strictEqual(canonicalAgain.document.documentId, aliasedInside.document.documentId, 'alias and canonical reopen converge on one document identity');
    assert.strictEqual(queuedJobs(aliasedSearchEngine).length, aliasedJobsAfterFirst.length, 'canonical reopen does not queue a duplicate indexing job');
    aliasedSearchEngine.close();
    aliasedSearchEngine = null;

    const nestedEscapeRoot = path.join(storeRoot, 'outside-link');
    fs.symlinkSync(externalRoot, nestedEscapeRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const escapedPhysicalPath = path.join(externalRoot, 'Escaped.md');
    const escapedStorePath = path.join(nestedEscapeRoot, 'Escaped.md');
    fs.writeFileSync(escapedPhysicalPath, '# Escaped\n', 'utf-8');
    const escapeJobsBefore = queuedJobs(searchEngine).length;
    const escaped = await registrar.register(escapedStorePath);
    assert.strictEqual(escaped.status, 'skipped', 'inside-looking path that resolves outside the knowledge store is skipped');
    assert.strictEqual(escaped.reason, 'path-containment-failed', 'junction escape reports a stable containment reason');
    assert.strictEqual(escaped.diagnosticCode, 'realpath_outside_source_root', 'junction escape reports a stable realpath diagnostic');
    assert(escaped.pathToken && !escaped.pathToken.includes(escapedStorePath), 'junction escape exposes only a redacted path token');
    assert.strictEqual(queuedJobs(searchEngine).length, escapeJobsBefore, 'junction escape does not queue an indexing job');
    assert.strictEqual(searchEngine.getSourceLedger().findDocumentByCanonicalPath({ canonicalPathInternal: escapedPhysicalPath }), null, 'junction escape does not create a document row');
    assert.strictEqual(searchEngine.getSourceLedger().findDocumentSourceAliasByCanonicalPath({ canonicalPathInternal: escapedPhysicalPath }), null, 'junction escape does not create a source alias');
    assert.strictEqual(fs.existsSync(path.join(storeRoot, '.opened')), false, 'junction escape does not create an opened-document copy');

    const disabledPath = path.join(externalRoot, 'Disabled.md');
    fs.writeFileSync(disabledPath, '# Disabled\n', 'utf-8');
    const disabled = await disabledRegistrar.register(disabledPath);
    assert.strictEqual(disabled.status, 'skipped', 'default-off registration is skipped');
    assert.strictEqual(disabled.reason, 'disabled', 'default-off result reports disabled reason');
    assert.strictEqual(fs.existsSync(path.join(storeRoot, '.opened')), false, 'default-off registration does not create opened namespace');

    const insidePath = path.join(storeRoot, 'Inside.md');
    fs.writeFileSync(insidePath, '# Inside\n', 'utf-8');
    const insideFirst = await registrar.register(insidePath);
    assert.strictEqual(insideFirst.status, 'queued', 'inside-store opened Markdown queues indexing');
    assert.strictEqual(path.resolve(insideFirst.indexedPath), path.resolve(insidePath), 'inside-store registration indexes the original contained path');
    const insideJobsAfterFirst = queuedJobs(searchEngine).length;
    const insideSecond = await registrar.register(insidePath);
    assert.strictEqual(insideSecond.status, 'existing', 'unchanged inside-store opened Markdown is a no-op');
    assert.strictEqual(queuedJobs(searchEngine).length, insideJobsAfterFirst, 'unchanged inside-store file does not add another index job');

    const otherInsidePath = path.join(storeRoot, 'Other.md');
    fs.writeFileSync(otherInsidePath, '# Other\n\nShared target content.\n', 'utf-8');
    const otherInside = await registrar.register(otherInsidePath);
    assert.strictEqual(otherInside.status, 'queued', 'another inside-store document queues indexing');
    fs.writeFileSync(insidePath, '# Other\n\nShared target content.\n', 'utf-8');
    const insideChanged = await registrar.register(insidePath);
    assert.strictEqual(insideChanged.status, 'queued', 'changed same inside-store path updates instead of becoming duplicate_candidate');

    const markdownPath = path.join(storeRoot, 'MarkdownExtension.markdown');
    fs.writeFileSync(markdownPath, '# Markdown Extension\n', 'utf-8');
    const markdownResult = await registrar.register(markdownPath);
    assert.strictEqual(markdownResult.status, 'queued', '.markdown files are eligible for opened registration');

    const collisionPath = path.join(externalRoot, 'Collision.md');
    fs.writeFileSync(collisionPath, '# Collision\n\nNew external file.\n', 'utf-8');
    const collisionDestination = openedDestinationFor(storeRoot, collisionPath);
    fs.mkdirSync(path.dirname(collisionDestination), { recursive: true });
    fs.writeFileSync(collisionDestination, '# Existing destination without source identity\n', 'utf-8');
    const collision = await registrar.register(collisionPath);
    assert.strictEqual(collision.status, 'skipped', 'external destination collision is skipped');
    assert.strictEqual(collision.diagnosticCode, 'destination_collision', 'destination collision has a stable diagnostic code');
    assert.strictEqual(fs.readFileSync(collisionDestination, 'utf-8'), '# Existing destination without source identity\n', 'collision destination is not overwritten');

    const externalPath = path.join(externalRoot, 'External.md');
    fs.writeFileSync(externalPath, '# External\n\nCopied into store.\n', 'utf-8');
    const external = await registrar.register(externalPath);
    assert.strictEqual(external.status, 'queued', 'external opened Markdown queues indexing after copy');
    assert(external.destinationPath, 'external registration returns a destination path');
    assert(path.resolve(external.destinationPath).startsWith(path.resolve(storeRoot)), 'external destination is inside the knowledge store');
    assert.notStrictEqual(path.resolve(external.indexedPath), path.resolve(externalPath), 'external original path is not indexed directly');
    assert.strictEqual(fs.readFileSync(external.destinationPath, 'utf-8'), fs.readFileSync(externalPath, 'utf-8'), 'external content is copied to the knowledge store');
    const externalJob = queuedJobs(searchEngine).find((job) => path.resolve(job.currentPathInternal) === path.resolve(external.destinationPath));
    assert(externalJob, 'external registration queues the contained destination path');

    const externalAgain = await registrar.register(externalPath);
    assert.strictEqual(externalAgain.status, 'existing', 'unchanged external canonical path is a no-op');

    const duplicatePath = path.join(externalRoot2, 'Duplicate.md');
    fs.writeFileSync(duplicatePath, '# External\n\nCopied into store.\n', 'utf-8');
    const duplicate = await registrar.register(duplicatePath);
    assert.strictEqual(duplicate.status, 'duplicate_candidate', 'same content at a different active path is a duplicate candidate');
    assert.strictEqual(duplicate.diagnosticCode, 'duplicate_content_active_path', 'duplicate candidate has a stable diagnostic code');

    console.log('test-opened-markdown-registrar-contract: all assertions passed');
    success = true;
  } finally {
    if (aliasedSearchEngine) aliasedSearchEngine.close();
    if (searchEngine) searchEngine.close();
    await removeTreeWithRetry(root);
  }
  if (success) process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
