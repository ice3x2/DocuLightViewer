'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SearchEngine } = require('../src/main/search-engine');
const { createBasicKeywordTokenizer, createKeywordTokenizer } = require('../src/main/search-tokenizer');

function createStore(docsDir) {
  return {
    _data: {
      mcpAutoSave: true,
      mcpAutoSavePath: docsDir
    },
    get(key, defaultValue) {
      return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : defaultValue;
    }
  };
}

function writeDoc(dir, name, frontmatter, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${frontmatter}\n${body}`, 'utf-8');
  return filePath;
}

async function withTempDirs(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-sqlite-keyword-'));
  const docsDir = path.join(root, 'docs');
  const indexDataDir = path.join(root, 'userData', 'index');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(indexDataDir, { recursive: true });
  try {
    await fn({ root, docsDir, indexDataDir });
  } finally {
    removeTempTree(root);
  }
}

function removeTempTree(root) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 4) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

function createFakeGaru() {
  return {
    analyze(text) {
      const tokens = [];
      for (const word of String(text).split(/\s+/)) {
        const cleaned = word.replace(/[^\w가-힣]/g, '');
        if (cleaned === '먹었다' || cleaned === '먹다') {
          tokens.push({ text: '먹', pos: 'NNG' });
        }
      }
      return { tokens };
    },
    modelInfo() {
      return { version: 'fake-garu', size: 1, accuracy: 1 };
    }
  };
}

function createFailingAnalyzeGaru() {
  return {
    analyze() {
      throw new Error('forced garu analyze failure');
    },
    modelInfo() {
      return { version: 'fake-garu', size: 1, accuracy: 1 };
    }
  };
}

(async () => {
  await withTempDirs(async ({ docsDir, indexDataDir }) => {
    writeDoc(docsDir, 'guide.md', '---\nproject: Alpha\ndocType: guide\n---', '# Alpha Guide\n\nneedle shared guide');
    writeDoc(docsDir, 'spec.md', '---\nproject: Alpha\ndocType: spec\n---', '# Alpha Spec\n\nneedle shared sqlite target 한국어검색품질');
    writeDoc(docsDir, 'notes.md', '---\nproject: Beta\ndocType: note\n---', '# Beta Note\n\nneedle shared unrelated');
    writeDoc(docsDir, 'rank-strong.md', '---\nproject: Rank\ndocType: note\n---', '# Strong Rank\n\nrankterm rankterm rankterm rankterm');
    writeDoc(docsDir, 'rank-mid.md', '---\nproject: Rank\ndocType: note\n---', '# Mid Rank\n\nrankterm rankterm');
    writeDoc(docsDir, 'rank-weak.md', '---\nproject: Rank\ndocType: note\n---', '# Weak Rank\n\nrankterm');

    const engine = new SearchEngine(createStore(docsDir), {
      indexBackend: 'sqlite',
      indexDataDir
    });

    await engine.rebuild();

    const status = engine.getStatus();
    const sqlitePath = path.join(indexDataDir, 'search-index.sqlite3');
    const legacyJsonPath = path.join(docsDir, '.doculight-search-index.json');

    assert.strictEqual(status.state, 'ready', 'SQLite rebuild leaves index ready');
    assert.strictEqual(status.indexBackend, 'sqlite-fts5', 'status reports SQLite FTS5 backend');
    assert(/^\[REDACTED_PATH:/.test(status.indexPath), 'public SQLite index path is redacted in status payloads');
    assert(/^\[REDACTED_PATH:/.test(status.dataDir), 'public SQLite index data dir is redacted in status payloads');
    const internalStatus = engine.getStatus({ publicPaths: false });
    assert.strictEqual(internalStatus.indexPath, sqlitePath, 'internal SQLite index path is under index data dir');
    assert.strictEqual(internalStatus.dataDir, indexDataDir, 'internal index data dir is separate from document root');
    assert(fs.existsSync(sqlitePath), 'SQLite index DB is created in userData index dir');
    assert(!fs.existsSync(legacyJsonPath), 'SQLite backend does not write monolithic JSON under document root');

    const Database = require('better-sqlite3');
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      const journalMode = db.pragma('journal_mode', { simple: true });
      const foreignKeys = db.pragma('foreign_keys', { simple: true });
      const synchronous = db.pragma('synchronous', { simple: true });
      const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all().map((row) => row.name);

      assert.strictEqual(String(journalMode).toLowerCase(), 'wal', 'SQLite DB uses WAL journal mode');
      assert.strictEqual(foreignKeys, 1, 'SQLite DB enables foreign_keys');
      assert.strictEqual(synchronous, 1, 'SQLite DB uses synchronous NORMAL');
      for (const tableName of ['keyword_index_meta', 'keyword_documents', 'keyword_segments', 'keyword_fts']) {
        assert(tableNames.includes(tableName), `SQLite schema includes ${tableName}`);
      }
    } finally {
      db.close();
    }

    let reloaded = null;
    try {
      const results = engine.search('needle sqlite', { project: 'Alpha', docType: 'spec', limit: 5 });
      assert.strictEqual(results.length, 1, 'SQLite FTS search keeps project and docType filters');
      assert.strictEqual(results[0].docType, 'spec');
      assert(results[0].score > 0, 'SQLite BM25 score is normalized to higher-is-better positive score');
      assert(results[0].score <= 1, 'SQLite BM25 score is normalized into the 0..1 range');

      const rankLimitTwo = engine.search('rankterm', { project: 'Rank', docType: 'note', limit: 2 });
      const rankLimitThree = engine.search('rankterm', { project: 'Rank', docType: 'note', limit: 3 });
      assert.strictEqual(rankLimitTwo.length, 2, 'SQLite BM25 ranking fixture returns a limited candidate window');
      assert.strictEqual(rankLimitThree.length, 3, 'SQLite BM25 ranking fixture can expand the candidate window');
      assert(rankLimitThree.every((item) => item.score >= 0 && item.score <= 1), 'SQLite BM25 normalized scores stay within 0..1');
      assert.strictEqual(
        rankLimitTwo[1].score,
        rankLimitThree.find((item) => item.filePath === rankLimitTwo[1].filePath).score,
        'SQLite BM25 normalized score is based on bm25() rank, not candidate-window ordinal position'
      );

      const koreanResults = engine.search('검색품질', { project: 'Alpha', docType: 'spec', limit: 5 });
      assert.strictEqual(koreanResults.length, 1, 'SQLite FTS search keeps Korean tokenizer preprocessing');
      assert.strictEqual(koreanResults[0].filePath, results[0].filePath);

      reloaded = new SearchEngine(createStore(docsDir), {
        indexBackend: 'sqlite',
        indexDataDir
      });
      await reloaded.initialize();

      assert.strictEqual(reloaded.getStatus().state, 'ready', 'compatible SQLite cache initializes to ready');
      const loadedResults = reloaded.search('needle sqlite', { project: 'Alpha', docType: 'spec', limit: 5 });
      assert.strictEqual(loadedResults.length, 1, 'SQLite cache loads without JSON rebuild');
      assert.strictEqual(loadedResults[0].filePath, results[0].filePath);
    } finally {
      engine.close();
      if (reloaded) reloaded.close();
    }
  });

  await withTempDirs(async ({ docsDir, indexDataDir }) => {
    writeDoc(docsDir, 'a.md', '---\nproject: Alpha\n---', '# Alpha\n\nnative failure fallback');

    const seedEngine = new SearchEngine(createStore(docsDir), {
      indexBackend: 'sqlite',
      indexDataDir
    });
    await seedEngine.rebuild();
    seedEngine.close();

    const engine = new SearchEngine(createStore(docsDir), {
      indexBackend: 'sqlite',
      indexDataDir,
      sqliteLoadDatabase: () => {
        throw new Error('forced sqlite native load failure');
      }
    });

    try {
      await engine.initialize();
      const status = engine.getStatus();
      assert.strictEqual(status.state, 'degraded', 'SQLite native load failure degrades instead of failing app initialization');
      assert.strictEqual(status.indexBackend, 'sqlite-fts5-unavailable', 'status reports unavailable SQLite backend');
      assert(status.errorSummary.includes('forced sqlite native load failure'), 'status exposes native load diagnostic');
    } finally {
      engine.close();
    }
  });

  await withTempDirs(async ({ docsDir, indexDataDir }) => {
    writeDoc(docsDir, 'fresh.md', '---\nproject: Fresh\n---', '# Fresh\n\nempty sqlite metadata fixture');
    const sqlitePath = path.join(indexDataDir, 'search-index.sqlite3');
    fs.closeSync(fs.openSync(sqlitePath, 'w'));

    const engine = new SearchEngine(createStore(docsDir), {
      indexBackend: 'sqlite',
      indexDataDir
    });
    try {
      await engine.initialize();
      const status = engine.getStatus();
      assert.strictEqual(status.state, 'stale', 'empty SQLite DB marks cache stale without startup rebuild');
      assert.strictEqual(status.dirty, true, 'empty SQLite DB requires explicit settings rebuild');
      assert(status.errorSummary.includes('Search index is incomplete'), 'empty SQLite DB reports incomplete index guidance');
      assert(!status.errorSummary.includes('source root mismatch'), 'empty SQLite DB is not misclassified as a root mismatch');
      assert(!status.errorSummary.includes(docsDir), 'empty SQLite DB diagnostic does not expose raw source root');
      assert.strictEqual(status.indexedCount, 0, 'empty SQLite DB does not expose documents before rebuild');
    } finally {
      engine.close();
    }
  });

  await withTempDirs(async ({ root, docsDir, indexDataDir }) => {
    const otherDocsDir = path.join(root, 'other-docs');
    fs.mkdirSync(otherDocsDir, { recursive: true });
    writeDoc(docsDir, 'alpha.md', '---\nproject: Alpha\n---', '# Alpha\n\nzzzzzz');
    writeDoc(otherDocsDir, 'beta.md', '---\nproject: Beta\n---', '# Beta\n\nqqqqqq');

    const firstEngine = new SearchEngine(createStore(docsDir), {
      indexBackend: 'sqlite',
      indexDataDir
    });
    await firstEngine.rebuild();
    firstEngine.close();

    const secondEngine = new SearchEngine(createStore(otherDocsDir), {
      indexBackend: 'sqlite',
      indexDataDir
    });
    try {
      await secondEngine.initialize();
      const status = secondEngine.getStatus();
      assert.strictEqual(status.state, 'stale', 'root mismatch marks SQLite cache stale without startup rebuild');
      assert.strictEqual(status.dirty, true, 'root mismatch requires an explicit settings rebuild');
      assert(status.errorSummary.includes('source root mismatch'), 'root mismatch diagnostic is preserved for settings UI');
      assert.strictEqual(status.indexedCount, 0, 'root mismatch does not expose previous-root metadata');
      assert.strictEqual(secondEngine.search('qqqqqq', { limit: 5 }).length, 0, 'current root document is not indexed until explicit rebuild');
      assert.strictEqual(secondEngine.search('zzzzzz', { limit: 5 }).length, 0, 'previous root document is not returned after root change');

      await secondEngine.rebuild();
      assert.strictEqual(secondEngine.getStatus().indexedCount, 1, 'explicit rebuild indexes the current source root');
      assert.strictEqual(secondEngine.search('qqqqqq', { limit: 5 }).length, 1, 'current root document is searchable after explicit rebuild');
    } finally {
      secondEngine.close();
    }
  });

  await withTempDirs(async ({ docsDir, indexDataDir }) => {
    writeDoc(docsDir, 'lunch.md', '---\nproject: Alpha\n---', '# 점심\n\n학교에서 점심을 먹었다');

    const basicEngine = new SearchEngine(createStore(docsDir), {
      indexBackend: 'sqlite',
      indexDataDir,
      keywordTokenizer: createBasicKeywordTokenizer()
    });
    await basicEngine.rebuild();
    basicEngine.close();

    const garuTokenizer = createKeywordTokenizer({
      provider: 'garu',
      loadGaru: async () => createFakeGaru()
    });
    const garuEngine = new SearchEngine(createStore(docsDir), {
      indexBackend: 'sqlite',
      indexDataDir,
      keywordTokenizer: garuTokenizer
    });

    try {
      await garuEngine.initialize();
      const status = garuEngine.getStatus();

      assert.strictEqual(status.state, 'stale', 'tokenizer mismatch marks index stale without startup rebuild');
      assert.strictEqual(status.dirty, true, 'tokenizer mismatch requires an explicit settings rebuild');
      assert(status.errorSummary.includes('tokenizer mismatch'), 'tokenizer mismatch diagnostic is preserved for settings UI');
      assert.strictEqual(status.indexedCount, 0, 'tokenizer mismatch does not expose incompatible metadata');

      await garuEngine.rebuild();
      const rebuiltStatus = garuEngine.getStatus();
      const results = garuEngine.search('먹다', { limit: 5 });
      assert.strictEqual(rebuiltStatus.state, 'ready', 'explicit tokenizer rebuild leaves index ready');
      assert.strictEqual(rebuiltStatus.indexedCount, 1, 'explicit tokenizer rebuild keeps current document count');
      assert.strictEqual(results.length, 1, 'tokenizer mismatch rebuilds search_text with current garu semantics');
      assert.strictEqual(results[0].filePath, path.join(docsDir, 'lunch.md'));
    } finally {
      garuEngine.close();
    }
  });

  await withTempDirs(async ({ docsDir, indexDataDir }) => {
    writeDoc(docsDir, 'lunch.md', '---\nproject: Alpha\n---', '# 점심\n\n학교에서 점심을 먹었다');

    const degradedTokenizer = createKeywordTokenizer({
      provider: 'garu',
      loadGaru: async () => createFailingAnalyzeGaru()
    });
    const degradedEngine = new SearchEngine(createStore(docsDir), {
      indexBackend: 'sqlite',
      indexDataDir,
      keywordTokenizer: degradedTokenizer
    });
    await degradedEngine.rebuild();
    degradedEngine.close();

    const healthyTokenizer = createKeywordTokenizer({
      provider: 'garu',
      loadGaru: async () => createFakeGaru()
    });
    const healthyEngine = new SearchEngine(createStore(docsDir), {
      indexBackend: 'sqlite',
      indexDataDir,
      keywordTokenizer: healthyTokenizer
    });

    try {
      await healthyEngine.initialize();
      const status = healthyEngine.getStatus();

      assert.strictEqual(status.state, 'stale', 'tokenizer degraded metadata mismatch marks index stale without startup rebuild');
      assert.strictEqual(status.dirty, true, 'tokenizer degraded metadata mismatch requires an explicit settings rebuild');
      assert(status.errorSummary.includes('tokenizer mismatch'), 'tokenizer degraded mismatch diagnostic is preserved');

      await healthyEngine.rebuild();
      const results = healthyEngine.search('먹다', { limit: 5 });
      assert.strictEqual(healthyEngine.getStatus().state, 'ready', 'explicit tokenizer degraded metadata rebuild leaves index ready');
      assert.strictEqual(results.length, 1, 'tokenizer degraded metadata mismatch rebuilds search_text with healthy garu semantics');
      assert.strictEqual(results[0].filePath, path.join(docsDir, 'lunch.md'));
    } finally {
      healthyEngine.close();
    }
  });

  console.log('test-sqlite-keyword-index-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
