'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');

function hashPath(value) {
  const normalized = process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = {
  name: 's04',
  async run(context) {
    const { root } = context.fixture;
    const dbPath = path.join(root, 'ledger.sqlite');
    const storeRoot = path.join(root, 'store');
    const originalDir = path.join(root, 'original');
    fs.mkdirSync(storeRoot);
    fs.mkdirSync(originalDir);
    const original = path.join(originalDir, 'original.md');
    fs.writeFileSync(original, '# Original\n');
    const lexical = ['alias-one', 'alias-two'].map(name => {
      const directory = path.join(root, name);
      fs.symlinkSync(originalDir, directory, process.platform === 'win32' ? 'junction' : 'dir');
      return path.join(directory, 'original.md');
    });
    const canonical = fs.realpathSync(original);
    const canonicalPathHash = hashPath(canonical);
    const createLedger = () => new SourceLedgerStore({ dbPath, userDataDir: root });
    let ledger = createLedger();
    try {
    ledger.initialize();
    const source = ledger.recordSource({ rootPathInternal: storeRoot, rootFingerprint: 'root-1' });
    const document = ledger.upsertDocument({ sourceId: source.sourceId, sourceRelativePath: 'copy.md', contentHash: 'content-1', category: 'notes', documentTags: ['kept'] });
    const db = ledger.open();
    const stamp = '2026-09-24T00:00:00.000Z';
    db.prepare('INSERT INTO chunks(chunk_id, document_id, ordinal, text_hash, text, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
      .run('chunk-1', document.documentId, 'text-1', '# Original', stamp, stamp);
    db.prepare('INSERT INTO embedding_models(model_id, provider, model_name, model_fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('model-1', 'fixture', 'fixture', 'fingerprint-1', stamp, stamp);
    db.prepare('INSERT INTO chunk_embeddings(chunk_id, model_id, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('chunk-1', 'model-1', Buffer.from([1, 2, 3]), stamp, stamp);
    db.prepare('INSERT INTO ann_indexes(ann_index_id, model_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('ann-1', 'model-1', 'committed', stamp, stamp);
    db.prepare('INSERT INTO ann_memberships(ann_index_id, chunk_id, model_id, ann_label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('ann-1', 'chunk-1', 'model-1', 1, stamp);
    db.prepare('INSERT INTO index_jobs(job_id, source_id, document_id, job_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('job-1', source.sourceId, document.documentId, 'index_document', 'queued', stamp, stamp);
    ledger.close();

    // An actual pre-origin SQLite layout with a hash-only alias and existing dependent data.
    const Database = require('better-sqlite3');
    const old = new Database(dbPath);
    old.exec(`DROP TABLE document_source_aliases;
      CREATE TABLE document_source_aliases (
        alias_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        alias_kind TEXT NOT NULL,
        canonical_path_hash TEXT NOT NULL UNIQUE,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`);
    old.prepare('INSERT INTO document_source_aliases VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-alias', document.documentId, 'opened_path', 'legacy-hash', stamp, stamp, stamp, stamp);
    old.close();

    ledger = createLedger();
    ledger.initialize();
    let rows = ledger.open().prepare('SELECT * FROM document_source_aliases ORDER BY alias_id').all();
    context.assert(rows.length === 1 && rows[0].origin_lexical_path_internal === null && rows[0].origin_path_internal === null,
      'legacy hash-only alias retains null origin paths after migration');
    const first = ledger.upsertDocumentSourceAlias({ documentId: document.documentId, aliasKind: 'opened_path', originLexicalPathInternal: lexical[0], originPathInternal: canonical, canonicalPathHash });
    const second = ledger.upsertDocumentSourceAlias({ documentId: document.documentId, aliasKind: 'opened_path', originLexicalPathInternal: lexical[1], originPathInternal: canonical, canonicalPathHash });
    rows = ledger.open().prepare('SELECT * FROM document_source_aliases WHERE canonical_path_hash = ? ORDER BY alias_id').all(canonicalPathHash);
    context.assert(rows.length === 2, 'two lexical aliases to one canonical original retain separate rows');
    context.assert(rows.every(row => row.document_id === document.documentId && row.origin_path_internal === canonical), 'both aliases retain stable document and canonical original');
    context.assert(new Set(rows.map(row => row.origin_lexical_path_internal)).size === 2, 'lexical original paths remain distinct');
    context.assert(first.aliasId !== second.aliasId, 'alias identities are distinct');
    const repeated = ledger.upsertDocumentSourceAlias({ documentId: document.documentId, aliasKind: 'opened_path', originLexicalPathInternal: lexical[0], originPathInternal: canonical, canonicalPathHash });
    context.assert(repeated.aliasId === first.aliasId && ledger.open().prepare('SELECT COUNT(*) AS n FROM document_source_aliases WHERE canonical_path_hash = ?').get(canonicalPathHash).n === 2,
      'same lexical and canonical original is idempotent');
    const otherDocument = ledger.upsertDocument({ sourceId: source.sourceId, sourceRelativePath: 'other.md', contentHash: 'content-2' });
    let conflictingOwnerRejected = false;
    try {
      ledger.upsertDocumentSourceAlias({ documentId: otherDocument.documentId, aliasKind: 'opened_path', originLexicalPathInternal: lexical[0], originPathInternal: canonical, canonicalPathHash });
    } catch {
      conflictingOwnerRejected = true;
    }
    context.assert(conflictingOwnerRejected && ledger.open().prepare('SELECT COUNT(DISTINCT document_id) AS n FROM document_source_aliases WHERE canonical_path_hash = ?').get(canonicalPathHash).n === 1,
      'canonical original cannot silently change document owner');
    const otherOriginal = path.join(originalDir, 'other.md');
    fs.writeFileSync(otherOriginal, '# Other\n');
    let aliasIdCollisionRejected = false;
    try {
      ledger.upsertDocumentSourceAlias({ aliasId: first.aliasId, documentId: otherDocument.documentId, aliasKind: 'opened_path', originLexicalPathInternal: otherOriginal, originPathInternal: otherOriginal });
    } catch {
      aliasIdCollisionRejected = true;
    }
    context.assert(aliasIdCollisionRejected && ledger.open().prepare('SELECT document_id, canonical_path_hash FROM document_source_aliases WHERE alias_id = ?').get(first.aliasId).document_id === document.documentId,
      'caller alias ID cannot silently reuse an existing alias identity');
    context.assert(!JSON.stringify([first, second, repeated, ledger.findDocumentSourceAliasByCanonicalPath({ canonicalPathHash })]).includes(root),
      'public alias mapping contains no raw paths');
    ledger.close();

    ledger = createLedger();
    ledger.initialize();
    const reopened = ledger.open();
    const legacy = reopened.prepare('SELECT * FROM document_source_aliases WHERE alias_id = ?').get('legacy-alias');
    context.assert(legacy.first_seen_at === stamp && legacy.origin_lexical_path_internal === null && legacy.origin_path_internal === null,
      'reopened legacy alias retains first_seen_at and null origins');
    context.assert(reopened.prepare('SELECT COUNT(*) AS n FROM document_source_aliases').get().n === 3,
      'migration and reopen preserve all aliases without duplicates');
    context.assert(reopened.prepare('SELECT relative_path, category, document_tags_json FROM documents WHERE document_id = ?').get(document.documentId).relative_path === 'copy.md',
      'store copy locator remains separate from original paths');
    for (const table of ['sources', 'chunks', 'embedding_models', 'chunk_embeddings', 'ann_indexes', 'ann_memberships', 'index_jobs']) {
      context.assert(reopened.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n === 1, `${table} row survives repeat migration`);
    }
    context.assert(reopened.prepare('SELECT COUNT(*) AS n FROM documents').get().n === 2, 'both document identities survive repeat migration');
    context.assert(reopened.prepare('SELECT hex(embedding) AS bytes FROM chunk_embeddings').get().bytes === '010203',
      'existing embedding bytes survive migration');
    context.assert(reopened.prepare('SELECT status FROM index_jobs WHERE job_id = ?').get('job-1').status === 'queued',
      'existing job status survives migration');
    const savedDocument = reopened.prepare('SELECT category, document_tags_json, content_hash FROM documents WHERE document_id = ?').get(document.documentId);
    context.assert(savedDocument.category === 'notes' && savedDocument.document_tags_json === '["kept"]' && savedDocument.content_hash === 'content-1',
      'existing document metadata survives migration');
    context.assert(reopened.prepare('PRAGMA foreign_key_check').all().length === 0, 'migrated ledger retains foreign key integrity');
    ledger.close();
    } finally {
      if (ledger) ledger.close();
      for (const name of ['alias-one', 'alias-two']) fs.unlinkSync(path.join(root, name));
    }
  }
};
