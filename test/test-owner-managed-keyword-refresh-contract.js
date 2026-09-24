'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SearchEngine } = require('../src/main/search-engine');
const { SQLiteKeywordIndex } = require('../src/main/search-sqlite-store');
const { createBasicKeywordTokenizer } = require('../src/main/search-tokenizer');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-owner-refresh-'));
const docs = path.join(root, 'store');
const indexDataDir = path.join(root, 'userData', 'index');
fs.mkdirSync(docs, { recursive: true });
fs.mkdirSync(indexDataDir, { recursive: true });
const dbPath = path.join(indexDataDir, 'search-index.sqlite3');
const source = path.join(docs, 'original.md');
const store = { get(key, fallback) {
  return key === 'mcpAutoSavePath' ? docs : key === 'mcpAutoSave' ? true : fallback;
} };
const reader = new SearchEngine(store, { indexBackend: 'sqlite', indexDataDir,
  ownerManaged: true, keywordTokenizer: createBasicKeywordTokenizer(),
  disableIndexingWorkerController: true });
const writer = new SQLiteKeywordIndex({ dbPath, sourceRoot: docs,
  tokenizer: createBasicKeywordTokenizer() });
function replace(text, revision) {
  writer.replaceDocument({ filePath: source, contentHash: `sha256:${String(revision).padStart(64, '0')}`,
    revision, meta: { title: 'Original', project: 'Refresh', docType: 'note', category: 'general',
      documentTags: [], snippet: text },
    segments: [{ ordinal: 0, searchText: text, textHash: `sha256:${String(revision).padStart(64, '0')}` }] });
}

(async () => {
  try {
    await reader.initialize();
    assert.equal(reader.getStatus().state, 'stale', 'cold missing cache remains rebuild-required');
    assert.equal(fs.existsSync(dbPath), false, 'read-only cold load never creates keyword database');
    replace('initialneedle', 1);
    await reader.ensureFresh();
    assert.equal(reader.getStatus().state, 'ready', 'owner commit makes compatible read-only cache visible');
    assert.equal(reader.search('initialneedle').length, 1, 'cold owner commit becomes publicly searchable');
    const version = reader._ownerKeywordDataVersion;
    await reader.ensureFresh();
    assert.equal(reader._ownerKeywordDataVersion, version, 'unchanged cache avoids repeated metadata reload');
    replace('revisedneedle', 2);
    await reader.ensureFresh();
    assert.equal(reader.search('revisedneedle').length, 1, 'external owner commit changes data_version and refreshes search');
    assert.equal(reader.search('initialneedle').length, 0, 'old revision is absent after read-only refresh');
    const otherDocs = path.join(root, 'other-store');
    fs.mkdirSync(otherDocs);
    const wrongRoot = new SearchEngine({ get(key, fallback) {
      return key === 'mcpAutoSavePath' ? otherDocs : key === 'mcpAutoSave' ? true : fallback;
    } }, { indexBackend: 'sqlite', indexDataDir, ownerManaged: true,
      keywordTokenizer: createBasicKeywordTokenizer(), disableIndexingWorkerController: true });
    try {
      await wrongRoot.initialize();
      await wrongRoot.ensureFresh();
      assert.equal(wrongRoot.getStatus().state, 'stale', 'source-root mismatch remains rebuild-required');
      assert.equal(wrongRoot.search('revisedneedle').length, 0, 'mismatched source root exposes no committed hit');
    } finally { wrongRoot.close(); }
    const wrongTokenizer = createBasicKeywordTokenizer();
    wrongTokenizer.getIndexMetadata = () => ({ tokenizer_provider: 'different',
      tokenizer_version: 'different', tokenizer_degraded_reason: '' });
    const mismatched = new SearchEngine(store, { indexBackend: 'sqlite', indexDataDir,
      ownerManaged: true, keywordTokenizer: wrongTokenizer, disableIndexingWorkerController: true });
    try {
      await mismatched.initialize();
      await mismatched.ensureFresh();
      assert.equal(mismatched.getStatus().state, 'stale', 'tokenizer mismatch remains rebuild-required');
      assert.equal(mismatched.search('revisedneedle').length, 0, 'mismatched tokenizer exposes no committed hit');
    } finally { mismatched.close(); }
    const committedGeneration = reader.sqliteIndex.getCommittedGeneration;
    reader.sqliteIndex.getCommittedGeneration = () => { throw new Error(`forced read fault ${docs}`); };
    await reader.ensureFresh();
    const failed = reader.getStatus();
    assert.equal(failed.state, 'degraded', 'read fault must not report ready');
    assert(!String(failed.errorSummary).includes(docs), 'read-fault diagnostic redacts internal source root');
    reader.sqliteIndex.getCommittedGeneration = committedGeneration;
    await reader.ensureFresh();
    assert.equal(reader.getStatus().state, 'ready', 'transient read fault clears after compatible retry');
    assert.equal(reader.search('revisedneedle').length, 1, 'prior committed result survives owner read-fault recovery');
    console.log('test-owner-managed-keyword-refresh-contract: all assertions passed');
  } finally {
    reader.close();
    writer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
