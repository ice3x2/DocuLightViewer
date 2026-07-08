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
  const externalRoot = path.join(root, 'external');
  const externalRoot2 = path.join(root, 'external2');
  const indexRoot = path.join(root, 'userData', 'index');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.mkdirSync(externalRoot, { recursive: true });
  fs.mkdirSync(externalRoot2, { recursive: true });

  let searchEngine = null;
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
    if (searchEngine) searchEngine.close();
    await removeTreeWithRetry(root);
  }
  if (success) process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
