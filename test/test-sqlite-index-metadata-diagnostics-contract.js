'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SearchEngine } = require('../src/main/search-engine');

function createStore(docsDir) {
  return {
    get(key, defaultValue) {
      if (key === 'mcpAutoSave') return true;
      if (key === 'mcpAutoSavePath') return docsDir;
      return defaultValue;
    }
  };
}

function createMetadataOnlyDatabase({ metadata = { schema_version: '1' }, documentCount = 0 } = {}) {
  return class MetadataOnlyDatabase {
    pragma() {}
    exec() {}
    close() {}
    prepare(sql) {
      const query = String(sql || '');
      if (query.includes('PRAGMA table_info')) {
        return { all: () => [{ name: 'category' }, { name: 'document_tags_json' }] };
      }
      if (query.includes('INSERT INTO keyword_index_meta')) {
        return { run: () => ({ changes: 1 }) };
      }
      if (query.includes('SELECT value FROM keyword_index_meta WHERE key = ?')) {
        return {
          get: (key) => Object.prototype.hasOwnProperty.call(metadata, key)
            ? { value: metadata[key] }
            : null
        };
      }
      if (query.includes('SELECT key, value FROM keyword_index_meta')) {
        return {
          all: () => Object.entries(metadata).map(([key, value]) => ({ key, value }))
        };
      }
      if (query.includes('COUNT(*)') && query.includes('FROM keyword_documents')) {
        return { get: () => ({ count: documentCount }) };
      }
      if (query.includes('SELECT file_path')) {
        return { all: () => [] };
      }
      return {
        all: () => [],
        get: () => null,
        run: () => ({ changes: 0 })
      };
    }
  };
}

function removeTempTree(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-sqlite-diagnostics-'));
  const docsDir = path.join(root, 'docs');
  const indexDataDir = path.join(root, 'userData', 'index');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(indexDataDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'fresh.md'), '# Fresh\n\nempty sqlite metadata fixture', 'utf-8');
  fs.closeSync(fs.openSync(path.join(indexDataDir, 'search-index.sqlite3'), 'w'));

  const engine = new SearchEngine(createStore(docsDir), {
    indexBackend: 'sqlite',
    indexDataDir,
    sqliteLoadDatabase: () => createMetadataOnlyDatabase()
  });
  const incompleteWarnings = [];
  const originalWarn = console.warn;

  try {
    console.warn = (...args) => incompleteWarnings.push(args.join(' '));
    await engine.initialize();
    const status = engine.getStatus();
    assert.strictEqual(status.state, 'stale', 'metadata-only SQLite DB marks cache stale without startup rebuild');
    assert.strictEqual(status.dirty, true, 'metadata-only SQLite DB requires explicit Settings rebuild');
    assert(status.errorSummary.includes('Search index is incomplete'), 'metadata-only SQLite DB reports incomplete index guidance');
    assert(!status.errorSummary.includes('source root mismatch'), 'metadata-only SQLite DB is not misclassified as source-root mismatch');
    assert(!status.errorSummary.includes(docsDir), 'metadata diagnostic does not expose raw source root');
    assert.strictEqual(status.indexedCount, 0, 'metadata-only SQLite DB does not expose documents before rebuild');
    assert.strictEqual(incompleteWarnings.length, 0, 'metadata-only SQLite DB does not print a startup warning');
  } finally {
    console.warn = originalWarn;
    engine.close();
    removeTempTree(root);
  }

  const mismatchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-sqlite-mismatch-'));
  const mismatchDocsDir = path.join(mismatchRoot, 'docs');
  const mismatchIndexDataDir = path.join(mismatchRoot, 'userData', 'index');
  const previousRoot = path.join(mismatchRoot, 'previous-docs');
  fs.mkdirSync(mismatchDocsDir, { recursive: true });
  fs.mkdirSync(mismatchIndexDataDir, { recursive: true });
  fs.closeSync(fs.openSync(path.join(mismatchIndexDataDir, 'search-index.sqlite3'), 'w'));

  const mismatchEngine = new SearchEngine(createStore(mismatchDocsDir), {
    indexBackend: 'sqlite',
    indexDataDir: mismatchIndexDataDir,
    sqliteLoadDatabase: () => createMetadataOnlyDatabase({
      metadata: {
        schema_version: '1',
        source_root: previousRoot,
        committed_generation: 'generation-previous'
      },
      documentCount: 1
    })
  });
  const mismatchWarnings = [];

  try {
    console.warn = (...args) => mismatchWarnings.push(args.join(' '));
    await mismatchEngine.initialize();
    const status = mismatchEngine.getStatus();
    assert.strictEqual(status.state, 'stale', 'source-root mismatch marks cache stale without startup rebuild');
    assert(status.errorSummary.includes('source root mismatch'), 'source-root mismatch diagnostic is preserved');
    assert(!status.errorSummary.includes(mismatchDocsDir), 'source-root mismatch diagnostic does not expose configured root');
    assert(!status.errorSummary.includes(previousRoot), 'source-root mismatch diagnostic does not expose previous root');
    assert(mismatchWarnings.some((line) => line.includes('source root mismatch')), 'source-root mismatch still logs a redacted warning');
    assert(!mismatchWarnings.join('\n').includes(mismatchDocsDir), 'source-root mismatch warning does not expose configured root');
    assert(!mismatchWarnings.join('\n').includes(previousRoot), 'source-root mismatch warning does not expose previous root');
  } finally {
    console.warn = originalWarn;
    mismatchEngine.close();
    removeTempTree(mismatchRoot);
  }

  console.log('test-sqlite-index-metadata-diagnostics-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
