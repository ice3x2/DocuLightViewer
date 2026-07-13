'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { SearchEngine } = require('../src/main/search-engine');
const { createOpenedMarkdownRegistrar } = require('../src/main/opened-markdown-registrar');
const { NavigationHistory, WindowManager } = require('../src/main/window-manager');
const {
  IndexedDocumentOpenError,
  VALIDATED_MARKDOWN_CONTENT,
  readValidatedMarkdownCandidate,
  resolveIndexedMarkdownOpen
} = require('../src/main/indexed-origin-resolver');

function createStore(values) {
  return {
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
    }
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function canonicalPathHash(filePath) {
  const resolved = path.resolve(filePath);
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return sha256(normalized);
}

async function removeTreeWithRetry(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err && err.code) || attempt === 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

function queryAliasRow(ledger, documentId) {
  return ledger.open().prepare(`
    SELECT *
    FROM document_source_aliases
    WHERE document_id = ?
    ORDER BY updated_at DESC, alias_id
    LIMIT 1
  `).get(documentId);
}

function listMarkdownFiles(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...listMarkdownFiles(fullPath));
    else if (entry.isFile() && ['.md', '.markdown'].includes(path.extname(entry.name).toLowerCase())) found.push(fullPath);
  }
  return found;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-origin-open-'));
  const storeRoot = path.join(root, 'store');
  const externalRoot = path.join(root, 'external');
  const indexRoot = path.join(root, 'userData', 'index');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.mkdirSync(externalRoot, { recursive: true });

  const store = createStore({
    mcpAutoSave: true,
    mcpAutoSavePath: storeRoot,
    registerOpenedMarkdown: true
  });
  const searchEngine = new SearchEngine(store, {
    indexBackend: 'sqlite',
    indexDataDir: indexRoot,
    disableIndexingWorkerController: true,
    smartIndexDelayMs: 60 * 60 * 1000
  });

  let success = false;
  try {
    const unsupportedPath = path.join(externalRoot, 'NotMarkdown.txt');
    fs.writeFileSync(unsupportedPath, 'not markdown', 'utf8');
    const unsupported = await readValidatedMarkdownCandidate({ lexicalPathInternal: unsupportedPath });
    assert.deepStrictEqual(unsupported, { ok: false, status: 'unsupported_extension' }, 'non-Markdown candidates are rejected before opening');

    const invalidUtf8Path = path.join(externalRoot, 'InvalidUtf8.md');
    fs.writeFileSync(invalidUtf8Path, Buffer.from([0xc3, 0x28]));
    const invalidUtf8 = await readValidatedMarkdownCandidate({ lexicalPathInternal: invalidUtf8Path });
    assert.deepStrictEqual(invalidUtf8, { ok: false, status: 'read_failed' }, 'invalid UTF-8 is rejected without exposing decoder details');

    const virtualDirectoryPath = path.join(externalRoot, 'VirtualDirectory.md');
    const notFile = await readValidatedMarkdownCandidate({
      lexicalPathInternal: virtualDirectoryPath,
      fsPromises: {
        async realpath(candidate) { return candidate; },
        async open() {
          return {
            async stat() { return { isFile: () => false }; },
            async close() {}
          };
        }
      }
    });
    assert.deepStrictEqual(notFile, { ok: false, status: 'not_file' }, 'non-regular handles are rejected before content reads');

    let oversizedReadAttempted = false;
    const oversized = await readValidatedMarkdownCandidate({
      lexicalPathInternal: path.join(externalRoot, 'Oversized.md'),
      maxBytes: 4,
      fsPromises: {
        async realpath(candidate) { return candidate; },
        async open() {
          return {
            async stat() { return { isFile: () => true, size: 5 }; },
            async read() { oversizedReadAttempted = true; return { bytesRead: 0 }; },
            async close() {}
          };
        }
      }
    });
    assert.deepStrictEqual(oversized, { ok: false, status: 'read_failed' }, 'oversized candidates fail before allocating content buffers');
    assert.strictEqual(oversizedReadAttempted, false, 'oversized preflight never starts a file read');

    const stableStat = {
      isFile: () => true,
      size: 4,
      dev: 1,
      ino: 2,
      mtimeMs: 3,
      ctimeMs: 4,
      birthtimeMs: 5
    };
    const grewDuringRead = await readValidatedMarkdownCandidate({
      lexicalPathInternal: path.join(externalRoot, 'Growing.md'),
      maxBytes: 4,
      fsPromises: {
        async realpath(candidate) { return candidate; },
        async stat() { return stableStat; },
        async open() {
          return {
            async stat() { return stableStat; },
            async read(buffer) {
              buffer.write('12345');
              return { bytesRead: 5 };
            },
            async close() {}
          };
        }
      }
    });
    assert.deepStrictEqual(grewDuringRead, { ok: false, status: 'read_failed' }, 'a candidate that grows past the bounded read limit fails closed');

    const changedStat = { ...stableStat, mtimeMs: 30, ctimeMs: 40 };
    let handleStatCalls = 0;
    let boundedReadCalls = 0;
    const changedDuringRead = await readValidatedMarkdownCandidate({
      lexicalPathInternal: path.join(externalRoot, 'ChangedInPlace.md'),
      maxBytes: 4,
      fsPromises: {
        async realpath(candidate) { return candidate; },
        async stat() { return handleStatCalls > 1 ? changedStat : stableStat; },
        async open() {
          return {
            async stat() {
              handleStatCalls += 1;
              return handleStatCalls === 1 ? stableStat : changedStat;
            },
            async read(buffer) {
              boundedReadCalls += 1;
              if (boundedReadCalls > 1) return { bytesRead: 0 };
              buffer.write('1234');
              return { bytesRead: 4 };
            },
            async close() {}
          };
        }
      }
    });
    assert.deepStrictEqual(changedDuringRead, { ok: false, status: 'path_mismatch' }, 'same-inode in-place mutation during a bounded read fails closed on metadata change');

    const registrar = createOpenedMarkdownRegistrar({ store, searchEngine });
    const originalPath = path.join(externalRoot, 'Original.md');
    const originalContent = '# Original\n\nInitial origin body.\n';
    fs.writeFileSync(originalPath, originalContent, 'utf8');

    const registered = await registrar.register(originalPath);
    assert.strictEqual(registered.status, 'queued', 'external origin registration queues its contained indexed copy');
    assert(registered.document && registered.document.documentId, 'external registration returns stable document identity');
    const documentId = registered.document.documentId;
    const ledger = searchEngine.getSourceLedger();
    const alias = queryAliasRow(ledger, documentId);
    const canonicalOriginal = fs.realpathSync(originalPath);

    assert(alias, 'external registration persists an alias row');
    assert.strictEqual(path.resolve(alias.origin_path_internal), path.resolve(canonicalOriginal), 'alias stores the canonical origin path internally');
    assert.strictEqual(alias.canonical_path_hash, canonicalPathHash(canonicalOriginal), 'stored origin path and canonical hash remain bound');
    const publicAlias = ledger.findDocumentSourceAliasByCanonicalPath({ canonicalPathInternal: originalPath });
    assert(!JSON.stringify(publicAlias).includes(canonicalOriginal), 'public alias mapper never exposes the raw origin path');

    const origin = await resolveIndexedMarkdownOpen({ documentId, searchEngine });
    assert.strictEqual(origin.sourceUsed, 'origin', 'readable indexed origin is preferred');
    assert.strictEqual(origin.originStatus, 'readable', 'unchanged readable origin reports readable');
    assert.strictEqual(origin.content, originalContent, 'resolver returns content read from the origin');
    assert.strictEqual(path.resolve(origin.filePathInternal), path.resolve(canonicalOriginal), 'internal resolver target is the origin');

    const createdWindows = [];
    const fakeWindowManager = {
      async createWindow(opts) {
        createdWindows.push(opts);
        return { windowId: `origin-window-${createdWindows.length}`, title: 'Original', upserted: false };
      },
      getWindowEntry() {
        return {
          meta: { project: null, docType: null, savedFilePath: null },
          win: {
            isDestroyed: () => false,
            setAlwaysOnTop() {},
            webContents: { send() {} }
          }
        };
      }
    };
    const httpModuleUrl = `${pathToFileURL(path.join(__dirname, '../src/main/mcp-http.mjs')).href}?origin-contract=${Date.now()}`;
    const { createToolHandlers } = await import(httpModuleUrl);
    const handlers = createToolHandlers(fakeWindowManager, store, searchEngine);
    const ambiguous = await handlers.open_markdown({ documentId, content: '# Ambiguous\n' });
    assert.strictEqual(ambiguous.isError, true, 'HTTP open_markdown rejects documentId combined with content');
    assert(ambiguous.content[0].text.includes('errorCode: indexed_document_ambiguous_input'), 'ambiguous resolver input exposes only the stable error code');
    const emptyIdentityAmbiguous = await handlers.open_markdown({ documentId: '', content: '# Ambiguous empty identity\n' });
    assert.strictEqual(emptyIdentityAmbiguous.content[0].text, 'errorCode: indexed_document_ambiguous_input', 'documentId property presence rejects ambiguous input even when its value is empty');
    const storeFileCountBeforeOpen = listMarkdownFiles(storeRoot).length;
    const opened = await handlers.open_markdown({ documentId, noSave: false });
    assert.strictEqual(opened.isError, undefined, 'HTTP open_markdown accepts indexed documentId');
    assert(opened.content[0].text.includes('sourceUsed: origin'), 'HTTP response reports origin selection');
    assert(opened.content[0].text.includes('originStatus: readable'), 'HTTP response reports origin readability');
    assert(!opened.content[0].text.includes(originalPath), 'HTTP response does not expose the raw origin path');
    assert.strictEqual(path.resolve(createdWindows[0].filePath), path.resolve(canonicalOriginal), 'HTTP viewer receives the internally resolved origin target');
    assert.strictEqual(createdWindows[0].content, originalContent, 'HTTP viewer receives the content read from the validated file handle');
    assert.strictEqual(listMarkdownFiles(storeRoot).length, storeFileCountBeforeOpen, 'opening an indexed result does not auto-save a duplicate copy');

    const indexedPathWithContent = await handlers.open_markdown({
      filePath: registered.indexedPath,
      content: '# This must not bypass indexed identity resolution\n'
    });
    assert(indexedPathWithContent.content[0].text.includes('sourceUsed: origin'), 'indexed filePath resolves identity even when legacy content is also supplied');
    assert.strictEqual(createdWindows[1].content, originalContent, 'indexed filePath keeps existing filePath precedence while using verified origin content');

    const unknownDocument = await handlers.open_markdown({ documentId: 'document-does-not-exist' });
    assert.strictEqual(unknownDocument.isError, true, 'HTTP open_markdown rejects unknown indexed documentId');
    assert.strictEqual(unknownDocument.content[0].text, 'errorCode: indexed_document_not_found', 'unknown indexed identity exposes only the stable error code');

    const unindexedContainedPath = path.join(storeRoot, 'UnindexedDirect.md');
    fs.writeFileSync(unindexedContainedPath, '# Existing direct-open compatibility\n', 'utf8');
    const containedPassthrough = await resolveIndexedMarkdownOpen({ filePath: unindexedContainedPath, searchEngine });
    assert.strictEqual(containedPassthrough, null, 'configured-store filePath without indexed identity preserves direct-open compatibility');

    const alternateOriginDir = path.join(root, 'alternate-origin-link');
    fs.symlinkSync(externalRoot, alternateOriginDir, process.platform === 'win32' ? 'junction' : 'dir');
    const alternateLexicalPath = path.join(alternateOriginDir, 'Original.md');
    const alternateReopen = await registrar.register(alternateLexicalPath);
    assert.strictEqual(alternateReopen.status, 'existing', 'alternate lexical path to the same canonical origin reuses the existing alias');
    const preservedAlias = queryAliasRow(ledger, documentId);
    assert.strictEqual(path.resolve(preservedAlias.origin_lexical_path_internal), path.resolve(originalPath), 'non-null lexical origin is immutable across alternate-path reopen');
    assert.strictEqual(path.resolve(preservedAlias.origin_path_internal), path.resolve(canonicalOriginal), 'non-null canonical origin is immutable across alternate-path reopen');
    fs.rmSync(alternateOriginDir, { force: true });

    const namedPath = path.join(externalRoot, 'NamedSensitive.markdown');
    fs.writeFileSync(namedPath, '# Unvalidated disk replacement\n', 'utf8');
    const namedWindowManager = new WindowManager();
    const namedMessages = [];
    let namedDisplayTitle = '';
    const namedWindowId = 'existing-named-window';
    namedWindowManager.windows.set(namedWindowId, {
      win: {
        isDestroyed: () => false,
        isMinimized: () => false,
        show() {},
        focus() {},
        setTitle(value) { namedDisplayTitle = value; },
        setProgressBar() {},
        isFocused: () => true,
        flashFrame() {},
        webContents: { send(channel, payload) { namedMessages.push({ channel, payload }); } }
      },
      meta: {
        windowId: namedWindowId,
        filePath: null,
        title: 'Old',
        savedFilePath: null,
        windowName: 'sensitive-upsert',
        history: new NavigationHistory(),
        tags: [],
        project: null,
        docName: null,
        description: null,
        docType: null,
        lastRenderedContent: '# Old\n',
        validatedIndexedOpen: false
      }
    });
    namedWindowManager.nameToId.set('sensitive-upsert', namedWindowId);
    const validatedNamedContent = '# Validated same-handle content\n';
    const namedResult = await namedWindowManager.createWindow({
      windowName: 'sensitive-upsert',
      filePath: namedPath,
      content: validatedNamedContent,
      [VALIDATED_MARKDOWN_CONTENT]: true
    });
    assert.strictEqual(namedResult.upserted, true, 'actual WindowManager reuses an existing named viewer');
    const namedUpdate = namedMessages.find((message) => message.channel === 'update-markdown');
    assert(namedUpdate, 'named viewer receives an update payload');
    assert.strictEqual(namedUpdate.payload.markdown, validatedNamedContent, 'named upsert never re-reads the path after same-handle validation');
    assert.strictEqual(namedWindowManager.windows.get(namedWindowId).meta.validatedIndexedOpen, true, 'named viewer retains validated-origin state');
    assert.strictEqual(namedWindowManager.fileWatchers.size, 0, 'validated indexed origin does not start an unbounded automatic file watcher');
    assert.deepStrictEqual(namedWindowManager.windows.get(namedWindowId).meta.history.snapshot().stack, [], 'validated origin path is never stored in ordinary back/forward history');
    assert.strictEqual(namedWindowManager.windows.get(namedWindowId).meta.rootFilePath, null, 'validated origin path is never used as a sidebar root');
    assert(!namedDisplayTitle.includes(path.dirname(namedPath)), 'validated indexed origin directory is omitted from the user-visible window title');

    const failingHandlers = createToolHandlers({
      async createWindow() { throw new Error(`sensitive failure at ${originalPath}`); }
    }, store, searchEngine);
    const redactedWindowFailure = await failingHandlers.open_markdown({ documentId });
    assert.strictEqual(redactedWindowFailure.isError, true, 'post-resolver viewer failure remains an MCP error');
    assert.strictEqual(redactedWindowFailure.content[0].text, 'errorCode: indexed_document_unavailable', 'post-resolver viewer failure is normalized to a stable error code');
    assert(!redactedWindowFailure.content[0].text.includes(originalPath), 'post-resolver viewer failure cannot expose the internal origin path');

    const linkTargetA = path.join(root, 'link-target-a');
    const linkTargetB = path.join(root, 'link-target-b');
    const linkDir = path.join(root, 'origin-link');
    fs.mkdirSync(linkTargetA, { recursive: true });
    fs.mkdirSync(linkTargetB, { recursive: true });
    fs.writeFileSync(path.join(linkTargetA, 'Linked.md'), '# Linked A\n', 'utf8');
    fs.writeFileSync(path.join(linkTargetB, 'Linked.md'), '# Linked B\n', 'utf8');
    fs.symlinkSync(linkTargetA, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedLexicalPath = path.join(linkDir, 'Linked.md');
    const linkedRegistered = await registrar.register(linkedLexicalPath);
    assert.strictEqual(linkedRegistered.status, 'queued', 'external symlink/junction origin registers through its initial canonical target');
    const linkedAlias = queryAliasRow(ledger, linkedRegistered.document.documentId);
    assert.strictEqual(path.resolve(linkedAlias.origin_lexical_path_internal), path.resolve(linkedLexicalPath), 'alias preserves the lexical origin path internally');
    assert.strictEqual(path.resolve(linkedAlias.origin_path_internal), path.resolve(fs.realpathSync(linkedLexicalPath)), 'alias separately preserves the canonical target path');
    fs.rmSync(linkDir, { force: true });
    fs.symlinkSync(linkTargetB, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    const retargeted = await resolveIndexedMarkdownOpen({
      documentId: linkedRegistered.document.documentId,
      searchEngine
    });
    assert.strictEqual(retargeted.sourceUsed, 'indexed_copy', 'retargeted symlink/junction cannot select the new target');
    assert.strictEqual(retargeted.originStatus, 'path_mismatch', 'retargeted symlink/junction reports path_mismatch');

    const changedContent = '# Original\n\nChanged after indexing.\n';
    fs.writeFileSync(originalPath, changedContent, 'utf8');
    const changed = await resolveIndexedMarkdownOpen({ filePath: registered.indexedPath, searchEngine });
    assert.strictEqual(changed.sourceUsed, 'origin', 'changed but readable origin remains the display source');
    assert.strictEqual(changed.originStatus, 'readable_changed', 'changed origin reports stale search content without hiding the origin');
    assert.strictEqual(changed.content, changedContent, 'changed origin displays its current content');

    fs.rmSync(originalPath);
    const missing = await resolveIndexedMarkdownOpen({ documentId, searchEngine });
    assert.strictEqual(missing.sourceUsed, 'indexed_copy', 'missing origin falls back to the indexed copy');
    assert.strictEqual(missing.originStatus, 'missing', 'missing origin reports stable status');
    assert.strictEqual(missing.content, originalContent, 'fallback content is the retained indexed copy');
    assert.strictEqual(path.resolve(missing.filePathInternal), path.resolve(registered.indexedPath), 'fallback target stays inside the knowledge store');

    fs.writeFileSync(originalPath, changedContent, 'utf8');
    const deniedFs = {
      ...fs.promises,
      async open(candidate, ...args) {
        if (path.resolve(candidate) === path.resolve(originalPath)) {
          const err = new Error('permission denied for secret path');
          err.code = 'EACCES';
          throw err;
        }
        return fs.promises.open(candidate, ...args);
      }
    };
    const unreadable = await resolveIndexedMarkdownOpen({ documentId, searchEngine, fsPromises: deniedFs });
    assert.strictEqual(unreadable.sourceUsed, 'indexed_copy', 'unreadable origin falls back to the indexed copy');
    assert.strictEqual(unreadable.originStatus, 'unreadable', 'permission denial is normalized without raw error text');
    assert(!JSON.stringify({ sourceUsed: unreadable.sourceUsed, originStatus: unreadable.originStatus }).includes(originalPath), 'public selection fields contain no raw path');

    const tamperedPath = path.join(externalRoot, 'Tampered.md');
    fs.writeFileSync(tamperedPath, '# Tampered\n', 'utf8');
    ledger.open().prepare(`
      UPDATE document_source_aliases
      SET origin_path_internal = ?
      WHERE document_id = ?
    `).run(tamperedPath, documentId);
    const mismatched = await resolveIndexedMarkdownOpen({ documentId, searchEngine });
    assert.strictEqual(mismatched.sourceUsed, 'indexed_copy', 'origin/hash mismatch cannot select the stored origin');
    assert.strictEqual(mismatched.originStatus, 'path_mismatch', 'tampered origin path reports stable mismatch status');

    ledger.open().prepare(`
      UPDATE document_source_aliases
      SET origin_lexical_path_internal = NULL,
          origin_path_internal = NULL
      WHERE document_id = ?
    `).run(documentId);
    const legacy = await resolveIndexedMarkdownOpen({ documentId, searchEngine });
    assert.strictEqual(legacy.sourceUsed, 'indexed_copy', 'legacy hash-only alias safely uses the indexed copy');
    assert.strictEqual(legacy.originStatus, 'not_recorded', 'legacy hash-only alias does not guess an origin path');
    fs.writeFileSync(originalPath, originalContent, 'utf8');
    const reopened = await registrar.register(originalPath);
    assert.strictEqual(reopened.status, 'existing', 'reopening a legacy hash-only origin remains a no-op registration');
    assert.strictEqual(reopened.documentId, documentId, 'legacy origin reopen preserves document identity');
    const backfilled = queryAliasRow(ledger, documentId);
    assert.strictEqual(path.resolve(backfilled.origin_path_internal), path.resolve(fs.realpathSync(originalPath)), 'same-origin reopen backfills the missing internal path');

    fs.rmSync(originalPath);
    fs.rmSync(registered.indexedPath);
    let unavailableError = null;
    try {
      await resolveIndexedMarkdownOpen({ documentId, searchEngine });
    } catch (err) {
      unavailableError = err;
    }
    assert(unavailableError instanceof IndexedDocumentOpenError, 'missing origin and copy reject with the stable resolver error type');
    assert.strictEqual(unavailableError.code, 'indexed_document_unavailable', 'both missing candidates use a stable error code');
    assert(!unavailableError.message.includes(root), 'resolver error message redacts all raw local paths');

    const unknownPath = path.join(externalRoot, 'Direct.md');
    fs.writeFileSync(unknownPath, '# Direct\n', 'utf8');
    const passthrough = await resolveIndexedMarkdownOpen({ filePath: unknownPath, searchEngine });
    assert.strictEqual(passthrough, null, 'non-indexed filePath preserves the existing direct-open path');

    const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
    const windowManagerSource = fs.readFileSync(path.join(__dirname, '../src/main/window-manager.js'), 'utf8');
    const httpSource = fs.readFileSync(path.join(__dirname, '../src/main/mcp-http.mjs'), 'utf8');
    const stdioSource = fs.readFileSync(path.join(__dirname, '../src/main/mcp-server.mjs'), 'utf8');
    const bundleSource = fs.readFileSync(path.join(__dirname, '../src/main/mcp-server.bundle.mjs'), 'utf8');
    for (const [label, source] of [['HTTP', httpSource], ['stdio', stdioSource], ['bundle', bundleSource]]) {
      assert(source.includes('documentId'), `${label} open_markdown contract exposes documentId`);
      assert(source.includes('sourceUsed'), `${label} open_markdown response exposes sourceUsed`);
      assert(source.includes('originStatus'), `${label} open_markdown response exposes originStatus`);
    }
    assert(mainSource.includes('resolveIndexedMarkdownOpen'), 'main-process stdio IPC uses the shared indexed-origin resolver');
    assert(httpSource.includes('resolveIndexedMarkdownOpen'), 'HTTP handler uses the shared indexed-origin resolver');
    assert(windowManagerSource.includes("filePath && !hasValidatedFileContent && typeof this.onRecentFile"), 'validated indexed origin is never persisted as a raw recent-file path');
    assert(!/search_documents[\s\S]{0,800}resolveIndexedMarkdownOpen/.test(httpSource), 'HTTP search_documents remains free of viewer/open side effects');
    assert(!/case 'search_documents':[\s\S]{0,500}resolveIndexedMarkdownOpen/.test(mainSource), 'stdio search_documents remains free of viewer/open side effects');

    console.log('test-indexed-origin-open-contract: all assertions passed');
    success = true;
  } finally {
    searchEngine.close();
    await removeTreeWithRetry(root);
  }

  if (!success) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
