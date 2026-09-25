'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { removeLegacyEmbeddingSettings } = require('../../../src/main/embedding-settings');
const { SearchEngine } = require('../../../src/main/search-engine');
const { SQLiteKeywordIndex } = require('../../../src/main/search-sqlite-store');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { recordProductIpcChannels } = require('../ipc-probe.cjs');

// @req FR-APP-013 IR-MCP-018 CON-MCP-007
module.exports = { async run({ fixture, assert }) {
  const read = name => fs.readFileSync(path.join(__dirname, '../../..', name), 'utf8');
  const html = read('src/renderer/settings.html');
  const renderer = read('src/renderer/settings.js');
  const css = read('src/renderer/settings.css');
  const preload = read('src/main/preload.js');
  const main = read('src/main/index.js');
  assert(!/embedding-(?:section|registration-view|register-btn|clear-btn|url-input|key-input|model-input|model-status)/.test(html),
    'Settings has no embedding registration, status, or removal controls');
  assert(!/EmbeddingModel|embeddingValidation|embeddingRegistration|embeddingStatusRequest/.test(renderer),
    'Settings renderer has no embedding registration or polling code');
  assert(!/\.embedding-|#embedding-/.test(css), 'Settings has no embedding registration styles');
  assert(!/EmbeddingModel|embedding:/.test(preload), 'preload has no embedding bridge');
  assert(!/ipcMain\.handle\('embedding:/.test(main), 'main registers no embedding IPC');
  const channels = recordProductIpcChannels(main);
  let crlfChannels = null;
  try { crlfChannels = recordProductIpcChannels(main.replace(/\r?\n/g, '\r\n')); }
  catch { /* The assertion below reports the parser contract failure. */ }
  assert(crlfChannels?.handled.includes('indexing:get-status'),
    'product IPC probe recognizes CRLF source without changing registered channels');
  assert(channels.handled.includes('get-settings') && channels.handled.includes('indexing:get-status'),
    'actual product registration retains Settings and indexing IPC');
  assert(![...channels.handled, ...channels.events].some(channel => channel.startsWith('embedding:')),
    'actual product handler table registers no embedding IPC');
  assert(!/embeddingProvider:\s*createOpenAICompatibleEmbeddingProvider/.test(main),
    'product SearchEngine has no provider wiring');
  const locales = ['ko', 'en', 'ja', 'es'].map(lang => JSON.parse(read(`src/locales/${lang}.json`)));
  const keys = Object.keys(locales[0]).sort().join('\n');
  for (const locale of locales) {
    assert(Object.keys(locale).sort().join('\n') === keys, 'locale key sets match');
    assert(!Object.keys(locale).some(key => key.startsWith('settings.embedding')), 'embedding UI keys removed');
  }
  const seed = { theme: 'dark', mcpAutoSavePath: 'C:\\notes', semanticSearch: {
    enabled: true, apiKey: 'nested-secret', baseURL: 'https://provider.example/v1',
    activationRecord: { provider: 'openai-compatible', model: 'old' }
  }, embeddingApiKeyCiphertext: 'ciphertext', embeddingApiKey: 'root-secret', apiKey: 'root-api-secret' };
  const entries = new Map(Object.entries(seed));
  let writes = 0;
  const store = { get: (key, fallback) => entries.has(key) ? entries.get(key) : fallback,
    set: (key, value) => { writes++; entries.set(key, value); },
    delete: key => { writes++; entries.delete(key); } };
  removeLegacyEmbeddingSettings(store);
  assert(entries.get('theme') === 'dark' && entries.get('mcpAutoSavePath') === 'C:\\notes',
    'unrelated settings survive cleanup');
  for (const key of ['semanticSearch', 'embeddingApiKeyCiphertext', 'embeddingApiKey', 'apiKey']) {
    assert(!entries.has(key), `${key} removed`);
  }
  const firstWrites = writes;
  removeLegacyEmbeddingSettings(store);
  assert(writes === firstWrites, 'legacy cleanup is idempotent');
  const empty = { get: (_, fallback) => fallback, set: () => { throw Error('unexpected write'); },
    delete: () => { throw Error('unexpected delete'); } };
  removeLegacyEmbeddingSettings(empty);
  const storeRoot = path.join(fixture.root, 's24-store');
  const indexDataDir = path.join(fixture.root, 's24-index');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.mkdirSync(indexDataDir, { recursive: true });
  const markdownPath = path.join(storeRoot, 'retained.md');
  const markdown = '# S24 retained document\n\ns24keywordneedle';
  fs.writeFileSync(markdownPath, markdown);
  const ledger = new SourceLedgerStore({ dbPath: path.join(indexDataDir, 'smart-search.sqlite3') });
  ledger.initialize();
  const source = ledger.recordSource({ rootPathInternal: storeRoot, rootFingerprint: 's24-root' });
  const document = ledger.upsertDocument({ sourceId: source.sourceId, sourceRelativePath: 'retained.md', contentHash: 'sha256:s24' });
  const db = ledger.open();
  const stamp = '2026-09-25T00:00:00.000Z';
  db.prepare('INSERT INTO chunks(chunk_id, document_id, ordinal, text_hash, text, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
    .run('s24-chunk', document.documentId, 's24-text', markdown, stamp, stamp);
  db.prepare('INSERT INTO embedding_models(model_id, provider, model_name, model_fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s24-model', 'fixture', 'legacy-model', 'legacy-fingerprint', stamp, stamp);
  db.prepare('INSERT INTO chunk_embeddings(chunk_id, model_id, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('s24-chunk', 's24-model', Buffer.from([1, 2, 3]), stamp, stamp);
  db.prepare('INSERT INTO ann_indexes(ann_index_id, model_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('s24-ann', 's24-model', 'committed', stamp, stamp);
  ledger.close();
  const keyword = new SQLiteKeywordIndex({ dbPath: path.join(indexDataDir, 'search-index.sqlite3'), sourceRoot: storeRoot });
  keyword.replaceDocument({ filePath: markdownPath, contentHash: 'sha256:s24', revision: 1,
    meta: { title: 'Retained', project: '', docName: 'retained', docType: 'markdown', category: '',
      documentTags: [], description: '', date: '', gitBranch: '', gitLastCommit: '', snippet: 's24keywordneedle' },
    segments: [{ ordinal: 0, searchText: 's24keywordneedle', textHash: 's24' }] });
  keyword.close();
  const engine = new SearchEngine({ get: (key, fallback) => key === 'mcpAutoSavePath' ? storeRoot : fallback }, {
    indexBackend: 'sqlite', indexDataDir, ownerManaged: true, keywordTokenizerProvider: 'basic',
    semanticSearch: { enabled: true, model: 'legacy-model', modelFingerprint: 'legacy-fingerprint' }
  });
  try {
    await engine.initialize();
    const semantic = await engine.getSmartSearchSemanticCandidates('s24keywordneedle');
    assert(semantic.degradationReason === 'embedding_disabled', 'provider-free semantic search uses embedding_disabled');
    const result = await engine.smartSearch({ query: 's24keywordneedle' });
    assert(JSON.stringify(result).includes('s24keywordneedle'), 'keyword result survives provider removal');
    assert(JSON.stringify(result).includes('embedding_disabled'), 'smart_search keeps existing degraded reason');
    assert(fs.readFileSync(markdownPath, 'utf8') === markdown, 'legacy cleanup does not touch Markdown');
    const reopened = new SourceLedgerStore({ dbPath: path.join(indexDataDir, 'smart-search.sqlite3'), readOnly: true });
    try {
      const retained = reopened.open();
      assert(retained.prepare('SELECT hex(embedding) AS bytes FROM chunk_embeddings').get().bytes === '010203',
        'legacy chunk embedding bytes survive');
      assert(retained.prepare('SELECT status FROM ann_indexes WHERE ann_index_id = ?').get('s24-ann').status === 'committed',
        'legacy committed ANN state survives');
    } finally { reopened.close(); }
  } finally {
    engine.close();
  }
} };
