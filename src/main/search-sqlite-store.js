'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { redactToken } = require('./redaction');
const { createBasicKeywordTokenizer } = require('./search-tokenizer');

const SQLITE_INDEX_FILENAME = 'search-index.sqlite3';
const MAX_SEARCH_BODY_CHARS = 1200;

class SQLiteKeywordIndex {
  constructor({ dbPath, sourceRoot, loadDatabase, tokenizer } = {}) {
    if (!dbPath) throw new Error('SQLite keyword index requires dbPath');
    this.dbPath = dbPath;
    this.sourceRoot = normalizeSourceRoot(sourceRoot);
    this._loadDatabase = loadDatabase || (() => require('better-sqlite3'));
    this.tokenizer = tokenizer || createBasicKeywordTokenizer();
    this.db = null;
  }

  get available() {
    return Boolean(this.db);
  }

  open() {
    if (this.db) return this.db;

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const Database = this._loadDatabase();
    this.db = new Database(this.dbPath, {
      timeout: 5000
    });

    this._applyPragmas();
    this._ensureSchema();
    return this.db;
  }

  _applyPragmas() {
    const db = this.db;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
  }

  _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS keyword_index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS keyword_documents (
        file_path TEXT PRIMARY KEY,
        title TEXT,
        project TEXT,
        doc_name TEXT,
        doc_type TEXT,
        category TEXT,
        document_tags_json TEXT NOT NULL DEFAULT '[]',
        description TEXT,
        date TEXT,
        git_branch TEXT,
        git_last_commit TEXT,
        snippet TEXT,
        content_hash TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS keyword_segments (
        segment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL REFERENCES keyword_documents(file_path) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        search_text TEXT NOT NULL,
        text_hash TEXT,
        UNIQUE(file_path, ordinal)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS keyword_fts USING fts5(
        search_text,
        file_path UNINDEXED,
        segment_id UNINDEXED,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS keyword_rebuild_staging_meta (
        generation_id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL,
        staged_at TEXT NOT NULL,
        document_count INTEGER NOT NULL,
        source_root TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS keyword_rebuild_staging_documents (
        generation_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        title TEXT,
        project TEXT,
        doc_name TEXT,
        doc_type TEXT,
        category TEXT,
        document_tags_json TEXT NOT NULL DEFAULT '[]',
        description TEXT,
        date TEXT,
        git_branch TEXT,
        git_last_commit TEXT,
        snippet TEXT,
        content_hash TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (generation_id, file_path),
        FOREIGN KEY (generation_id)
          REFERENCES keyword_rebuild_staging_meta(generation_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS keyword_rebuild_staging_segments (
        generation_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        search_text TEXT NOT NULL,
        text_hash TEXT,
        PRIMARY KEY (generation_id, file_path, ordinal),
        FOREIGN KEY (generation_id, file_path)
          REFERENCES keyword_rebuild_staging_documents(generation_id, file_path)
          ON DELETE CASCADE
      );
    `);
    this._ensureColumn('keyword_documents', 'category', 'TEXT');
    this._ensureColumn('keyword_documents', 'document_tags_json', "TEXT NOT NULL DEFAULT '[]'");

    this.db.prepare(`
      INSERT INTO keyword_index_meta(key, value)
      VALUES ('schema_version', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
  }

  _ensureColumn(tableName, columnName, definition) {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (rows.some((row) => row.name === columnName)) return;
    this.db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
  }

  rebuild(documents, options = {}) {
    const backupManifest = options.backupManifest || this.createBackupManifest({
      reason: options.backupReason || 'rebuild-before-commit',
      skipBackup: options.skipBackup !== false
    });
    assertNotCancelled(options, 'tokenize', null);
    const stage = this.beginStagedRebuild(documents, options);
    assertNotCancelled(options, 'commit', this.dbPath);
    reportProgress(options, {
      phase: 'commit',
      current: stage.documentCount,
      total: stage.documentCount,
      currentPath: this.dbPath,
      generationId: stage.generationId,
      revisionId: stage.revisionId
    });
    const committed = this.commitStagedGeneration(stage, options);
    return { ...committed, backupManifest };
  }

  // @req REL-DOC-007
  beginStagedRebuild(documents = [], options = {}) {
    const db = this.open();
    const now = new Date().toISOString();
    const generationId = createGenerationId();
    const revisionId = createRevisionId();
    const insertDocument = db.prepare(`
      INSERT INTO keyword_rebuild_staging_documents(
        generation_id, file_path, title, project, doc_name, doc_type, category, document_tags_json, description, date,
        git_branch, git_last_commit, snippet, content_hash, updated_at
      )
      VALUES (
        @generationId, @filePath, @title, @project, @docName, @docType, @category, @documentTagsJson, @description, @date,
        @gitBranch, @gitLastCommit, @snippet, @contentHash, @updatedAt
      )
    `);
    const insertSegment = db.prepare(`
      INSERT INTO keyword_rebuild_staging_segments(generation_id, file_path, ordinal, search_text, text_hash)
      VALUES (@generationId, @filePath, @ordinal, @searchText, @textHash)
    `);

    const resetStage = db.transaction((items) => {
      db.exec(`
        DELETE FROM keyword_rebuild_staging_segments;
        DELETE FROM keyword_rebuild_staging_documents;
        DELETE FROM keyword_rebuild_staging_meta;
      `);
      db.prepare(`
        INSERT INTO keyword_rebuild_staging_meta(generation_id, revision_id, staged_at, document_count, source_root)
        VALUES (@generationId, @revisionId, @stagedAt, @documentCount, @sourceRoot)
      `).run({
        generationId,
        revisionId,
        stagedAt: now,
        documentCount: items.length,
        sourceRoot: this.sourceRoot || ''
      });
    });

    const insertBatch = db.transaction((items) => {
      for (const item of items) {
        assertNotCancelled(options, 'insert', item.filePath);
        insertDocument.run({
          generationId,
          filePath: item.filePath,
          title: item.meta.title || null,
          project: item.meta.project || null,
          docName: item.meta.docName || null,
          docType: item.meta.docType || null,
          category: item.meta.category || null,
          documentTagsJson: JSON.stringify(Array.isArray(item.meta.documentTags) ? item.meta.documentTags : []),
          description: item.meta.description || null,
          date: item.meta.date || null,
          gitBranch: item.meta.gitBranch || null,
          gitLastCommit: item.meta.gitLastCommit || null,
          snippet: item.meta.snippet || null,
          contentHash: item.contentHash || null,
          updatedAt: now
        });

        assertNotCancelled(options, 'tokenize', item.filePath);
        const searchText = buildSearchText(item, this.tokenizer);
        insertSegment.run({
          generationId,
          filePath: item.filePath,
          ordinal: 0,
          searchText,
          textHash: item.textHash || item.contentHash || null
        });
      }
    });

    const items = Array.isArray(documents) ? documents : [];
    resetStage(items);
    const batchSize = resolveRebuildBatchSize(items.length, options);
    for (let offset = 0; offset < items.length; offset += batchSize) {
      assertNotCancelled(options, 'insert', items[offset] && items[offset].filePath);
      const batch = items.slice(offset, offset + batchSize);
      insertBatch(batch);
      const stagedCount = Math.min(items.length, offset + batch.length);
      const lastItem = batch[batch.length - 1] || null;
      reportProgress(options, {
        phase: 'insert',
        current: stagedCount,
        total: items.length,
        currentPath: lastItem && lastItem.filePath ? lastItem.filePath : null,
        generationId,
        revisionId
      });
    }
    return {
      generationId,
      revisionId,
      stagedAt: now,
      documentCount: Array.isArray(documents) ? documents.length : 0
    };
  }

  // @req REL-DOC-007
  commitStagedGeneration(stage, options = {}) {
    const generationId = requiredString(stage && stage.generationId, 'generationId');
    const revisionId = requiredString(stage && stage.revisionId, 'revisionId');
    const db = this.open();
    const committedAt = new Date().toISOString();
    const tokenizerMeta = this.tokenizer && typeof this.tokenizer.getIndexMetadata === 'function'
      ? this.tokenizer.getIndexMetadata()
      : {};

    const commit = db.transaction(() => {
      assertNotCancelled(options, 'commit', this.dbPath);
      const stageMeta = db.prepare(`
        SELECT generation_id, revision_id, staged_at, document_count, source_root
        FROM keyword_rebuild_staging_meta
        WHERE generation_id = @generationId
      `).get({ generationId });
      if (!stageMeta) {
        const err = new Error(`Unknown staged generation: ${generationId}`);
        err.code = 'SQLITE_KEYWORD_INDEX_UNKNOWN_STAGED_GENERATION';
        throw err;
      }
      const documentCount = Number(stageMeta.document_count) || 0;

      db.exec(`
        DELETE FROM keyword_fts;
        DELETE FROM keyword_segments;
        DELETE FROM keyword_documents;
      `);
      db.prepare(`
        INSERT INTO keyword_documents(
          file_path, title, project, doc_name, doc_type, category, document_tags_json, description, date,
          git_branch, git_last_commit, snippet, content_hash, updated_at
        )
        SELECT file_path, title, project, doc_name, doc_type, category, document_tags_json, description, date,
               git_branch, git_last_commit, snippet, content_hash, updated_at
        FROM keyword_rebuild_staging_documents
        WHERE generation_id = @generationId
        ORDER BY file_path
      `).run({ generationId });
      db.prepare(`
        INSERT INTO keyword_segments(file_path, ordinal, search_text, text_hash)
        SELECT file_path, ordinal, search_text, text_hash
        FROM keyword_rebuild_staging_segments
        WHERE generation_id = @generationId
        ORDER BY file_path, ordinal
      `).run({ generationId });
      db.prepare(`
        INSERT INTO keyword_fts(rowid, search_text, file_path, segment_id)
        SELECT segment_id, search_text, file_path, segment_id
        FROM keyword_segments
        ORDER BY segment_id
      `).run();

      setMetaValue(db, 'last_rebuilt_at', committedAt);
      setMetaValue(db, 'source_root', this.sourceRoot || '');
      setMetaValue(db, 'committed_generation', generationId);
      setMetaValue(db, 'committed_revision', revisionId);
      setMetaValue(db, 'committed_document_count', String(documentCount));
      for (const [key, value] of Object.entries(tokenizerMeta)) {
        setMetaValue(db, key, String(value || ''));
      }

      db.prepare('DELETE FROM keyword_rebuild_staging_segments WHERE generation_id = @generationId').run({ generationId });
      db.prepare('DELETE FROM keyword_rebuild_staging_documents WHERE generation_id = @generationId').run({ generationId });
      db.prepare('DELETE FROM keyword_rebuild_staging_meta WHERE generation_id = @generationId').run({ generationId });

      return documentCount;
    });

    const documentCount = commit();
    return {
      generationId,
      revisionId,
      committedAt,
      documentCount
    };
  }

  // @req REL-DOC-007
  getCommittedGeneration() {
    const metadata = this.loadIndexMetadata();
    if (!metadata.committed_generation) return null;
    return {
      generationId: metadata.committed_generation,
      revisionId: metadata.committed_revision || null,
      committedAt: metadata.last_rebuilt_at || null,
      documentCount: Number(metadata.committed_document_count || 0),
      sourceRoot: metadata.source_root || ''
    };
  }

  loadMeta() {
    this.assertSourceRoot();
    const rows = this.open().prepare(`
      SELECT file_path, title, project, doc_name, doc_type, description, date,
             category, document_tags_json, git_branch, git_last_commit, snippet
      FROM keyword_documents
      ORDER BY file_path
    `).all();

    return new Map(rows.map((row) => [row.file_path, rowToMeta(row)]));
  }

  loadIndexMetadata() {
    const rows = this.open().prepare('SELECT key, value FROM keyword_index_meta ORDER BY key').all();
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  assertSourceRoot() {
    if (!this.sourceRoot) return;
    const row = this.open().prepare('SELECT value FROM keyword_index_meta WHERE key = ?').get('source_root');
    const actual = row ? normalizeSourceRoot(row.value) : '';
    if (!actual && this._isMetadataOnlyIndex()) {
      const err = new Error('Search index is incomplete; rebuild it from Settings > Search Index Management.');
      err.code = 'SQLITE_INDEX_INCOMPLETE';
      throw err;
    }
    if (actual !== this.sourceRoot) {
      const err = new Error('SQLite keyword index source root mismatch: configured document store differs from the index metadata. Rebuild it from Settings > Search Index Management.');
      err.code = 'SQLITE_INDEX_SOURCE_MISMATCH';
      err.expectedSourceRoot = this.sourceRoot;
      err.actualSourceRoot = actual;
      throw err;
    }
  }

  _isMetadataOnlyIndex() {
    try {
      const metadata = this.loadIndexMetadata();
      if (metadata.source_root || metadata.committed_generation) return false;
      const row = this.open().prepare('SELECT COUNT(*) AS count FROM keyword_documents').get();
      return Number(row && row.count ? row.count : 0) === 0;
    } catch {
      return false;
    }
  }

  search(query, { limit = 20, project, docType, category, documentTags, tagMode, pathPrefix, filePaths } = {}) {
    const matchQuery = buildMatchQuery(query, this.tokenizer);
    if (!matchQuery) return [];
    if (Array.isArray(filePaths) && filePaths.length === 0) return [];

    const db = this.open();
    const params = {
      matchQuery,
      limit: Math.max(1, Math.min(Number(limit) || 20, 200))
    };
    const where = ['keyword_fts MATCH @matchQuery'];

    if (project) {
      params.project = project;
      where.push('d.project = @project');
    }
    if (docType) {
      params.docType = docType;
      where.push('d.doc_type = @docType');
    }
    if (category) {
      params.category = category;
      where.push('d.category = @category');
    }
    if (hasDocumentTagFilter(documentTags)) {
      const tagPredicates = [];
      documentTags
        .map((tag) => String(tag || '').trim())
        .filter(Boolean)
        .forEach((tag, index) => {
          const key = `documentTag${index}`;
          params[key] = `%${escapeLikePattern(JSON.stringify(tag))}%`;
          tagPredicates.push(`d.document_tags_json LIKE @${key} ESCAPE '\\'`);
        });
      if (tagPredicates.length > 0) {
        where.push((tagMode || 'any') === 'all'
          ? tagPredicates.join(' AND ')
          : `(${tagPredicates.join(' OR ')})`);
      }
    }
    if (pathPrefix) {
      params.pathPrefix = normalizeFilePathPrefix(pathPrefix);
      if (process.platform === 'win32') {
        params.pathPrefix = params.pathPrefix.toLowerCase();
        where.push("LOWER(d.file_path) LIKE @pathPrefix ESCAPE '\\'");
      } else {
        where.push("d.file_path LIKE @pathPrefix ESCAPE '\\'");
      }
    }
    if (Array.isArray(filePaths)) {
      const placeholders = [];
      filePaths.forEach((filePath, index) => {
        const key = `filePath${index}`;
        const resolved = path.resolve(filePath);
        params[key] = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        placeholders.push(`@${key}`);
      });
      const pathExpression = process.platform === 'win32' ? 'LOWER(d.file_path)' : 'd.file_path';
      where.push(`${pathExpression} IN (${placeholders.join(', ')})`);
    }

    const rows = db.prepare(`
      SELECT d.file_path, d.title, d.project, d.doc_name, d.doc_type, d.category,
             d.document_tags_json, d.description,
             d.date, d.snippet, bm25(keyword_fts) AS rank
      FROM keyword_fts
      JOIN keyword_documents d ON d.file_path = keyword_fts.file_path
      WHERE ${where.join(' AND ')}
      ORDER BY rank ASC, d.file_path ASC
      LIMIT @limit
    `).all(params);

    return rows.map((row) => ({
      filePath: row.file_path,
      score: normalizeBm25Rank(row.rank),
      title: row.title || path.basename(row.file_path, '.md'),
      project: row.project || null,
      docName: row.doc_name || null,
      docType: row.doc_type || null,
      category: row.category || null,
      documentTags: parseJsonArray(row.document_tags_json),
      description: row.description || null,
      date: row.date || null,
      snippet: row.snippet || null
    }));
  }

  vacuum({ backup = true, reason = 'compact-before-vacuum', skipBackup = false } = {}) {
    const backupManifest = backup
      ? this.createBackupManifest({ reason, skipBackup })
      : null;
    this.open().exec('VACUUM');
    return { backupManifest };
  }

  // @req REL-DOC-007
  createBackupManifest({ reason = 'manual', skipBackup = false } = {}) {
    const dbPath = this.dbPath;
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    const walPresent = fs.existsSync(walPath);
    const shmPresent = fs.existsSync(shmPath);
    const createdAt = new Date().toISOString();
    const backupReason = normalizeBackupReason(reason);
    const manifest = {
      type: 'sqlite-search-index-backup',
      reason: backupReason,
      strategy: skipBackup ? 'backup-skip' : 'wal-checkpoint-db-wal-shm-capture',
      createdAt,
      schemaVersion: '1',
      dbPathToken: redactToken('PATH', dbPath),
      backupPathToken: null,
      manifestPathToken: null,
      backupSkipped: Boolean(skipBackup),
      walPresent,
      shmPresent,
      capturedFiles: []
    };

    if (skipBackup) {
      return manifest;
    }

    this.open();
    try {
      this.db.pragma('wal_checkpoint(FULL)');
      manifest.walCheckpoint = 'full';
    } catch (err) {
      manifest.walCheckpoint = 'failed';
      manifest.checkpointDiagnostic = err && err.message ? err.message : String(err);
    }

    const backupDir = `${dbPath}.backup-${backupReason}-${createdAt.replace(/[:.]/g, '-')}`;
    fs.mkdirSync(backupDir, { recursive: true });
    const baseName = path.basename(dbPath);
    for (const part of [
      { role: 'db', sourcePath: dbPath, targetName: baseName },
      { role: 'wal', sourcePath: walPath, targetName: `${baseName}-wal` },
      { role: 'shm', sourcePath: shmPath, targetName: `${baseName}-shm` }
    ]) {
      if (!fs.existsSync(part.sourcePath)) continue;
      const targetPath = path.join(backupDir, part.targetName);
      fs.copyFileSync(part.sourcePath, targetPath);
      manifest.capturedFiles.push({
        role: part.role,
        pathToken: redactToken('PATH', targetPath),
        sizeBytes: fs.statSync(targetPath).size
      });
    }

    manifest.backupPathToken = redactToken('PATH', backupDir);
    const manifestPath = path.join(backupDir, 'manifest.json');
    manifest.manifestPathToken = redactToken('PATH', manifestPath);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    return manifest;
  }

  close() {
    if (!this.db) return;
    closeDatabaseHandle(this.db);
    this.db = null;
  }

  deleteFiles({ throwOnFailure = true } = {}) {
    this.close();
    const files = [];
    for (const suffix of ['', '-wal', '-shm']) {
      const filePath = `${this.dbPath}${suffix}`;
      const existed = fs.existsSync(filePath);
      const record = {
        role: suffix === '' ? 'db' : suffix.slice(1),
        pathToken: redactToken('PATH', filePath),
        existed,
        deleted: !existed,
        error: null
      };
      try {
        if (existed) fs.unlinkSync(filePath);
      } catch (err) {
        record.error = err && err.message ? err.message : String(err);
      }
      record.deleted = !fs.existsSync(filePath);
      if (!record.deleted && !record.error) {
        record.error = 'file still exists after delete attempt';
      }
      files.push(record);
    }
    const failed = files.filter((file) => file.existed && !file.deleted);
    const result = {
      deleted: failed.length === 0,
      files,
      failedCount: failed.length
    };
    if (!result.deleted && throwOnFailure) {
      const err = new Error('SQLite keyword index delete verification failed');
      err.code = 'SQLITE_KEYWORD_INDEX_DELETE_FAILED';
      err.deleteResult = result;
      throw err;
    }
    return result;
  }
}

function normalizeFilePathPrefix(value) {
  const resolved = path.resolve(String(value || ''));
  return `${escapeLikePattern(resolved)}%`;
}

function hasDocumentTagFilter(documentTags) {
  return Array.isArray(documentTags) && documentTags.some((tag) => String(tag || '').trim());
}

function escapeLikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

function closeDatabaseHandle(db) {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Closing must continue even if the database is already in a degraded state.
  }
  try {
    db.pragma('journal_mode = DELETE');
  } catch {
    // WAL sidecars may already be unavailable during degraded shutdown.
  }
  db.close();
}

// @req REL-DOC-007
function setMetaValue(db, key, value) {
  db.prepare(`
    INSERT INTO keyword_index_meta(key, value)
    VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ key, value: String(value || '') });
}

// @req REL-DOC-007
function createGenerationId() {
  if (typeof crypto.randomUUID === 'function') {
    return `generation-${crypto.randomUUID()}`;
  }
  return `generation-${Date.now()}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
}

// @req REL-DOC-007
function createRevisionId() {
  return `revision-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

// @req REL-DOC-007
function normalizeBackupReason(reason) {
  const normalized = String(reason || 'manual')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'manual';
}

// @req REL-DOC-007
function requiredString(value, fieldName) {
  const text = String(value || '').trim();
  if (text) return text;
  const err = new Error(`${fieldName} is required`);
  err.code = 'SQLITE_KEYWORD_INDEX_INVALID_STAGE';
  throw err;
}

// @req REL-DOC-007
function assertNotCancelled(options, phase, currentPath) {
  if (!options || typeof options.shouldCancel !== 'function' || options.shouldCancel(phase, currentPath) !== true) {
    return;
  }
  const err = new Error('SQLite keyword index rebuild cancelled');
  err.code = 'INDEX_REBUILD_CANCELLED';
  err.phase = phase;
  err.currentPath = currentPath || null;
  throw err;
}

// @req REL-DOC-008
function resolveRebuildBatchSize(totalCount, options = {}) {
  const requested = Number(options.batchSize);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.max(1, Math.min(Math.floor(requested), 1000));
  }
  const total = Math.max(0, Math.floor(Number(totalCount) || 0));
  const onePercentBatch = total >= 100 ? Math.floor(total / 100) : 1;
  return Math.max(1, Math.min(onePercentBatch, 1000));
}

// @req REL-DOC-008
function reportProgress(options, event = {}) {
  if (!options || typeof options.onProgress !== 'function') return;
  options.onProgress({
    phase: event.phase || null,
    current: Number.isFinite(Number(event.current)) ? Number(event.current) : 0,
    total: Number.isFinite(Number(event.total)) ? Number(event.total) : 0,
    currentPath: event.currentPath || null,
    generationId: event.generationId || null,
    revisionId: event.revisionId || null
  });
}

function buildSearchText(item, tokenizer = createBasicKeywordTokenizer()) {
  const raw = [
    item.meta.title,
    item.meta.project,
    item.meta.docName,
    item.meta.docType,
    item.meta.category,
    ...(Array.isArray(item.meta.documentTags) ? item.meta.documentTags : []),
    item.meta.description,
    getBoundedBodySearchText(item)
  ].filter(Boolean).join(' ');
  if (tokenizer && typeof tokenizer.buildSearchText === 'function') {
    return tokenizer.buildSearchText(raw);
  }
  return `${raw} ${tokenizer.tokenize(raw).join(' ')}`.trim();
}

// @req REL-DOC-007
function getBoundedBodySearchText(item) {
  const body = String((item && item.body) || '');
  if (!body || body.length <= MAX_SEARCH_BODY_CHARS) return body;
  const prefix = body.slice(0, MAX_SEARCH_BODY_CHARS);
  const h1 = prefix.match(/^#{1,6}\s+(.+)$/m);
  const headings = Array.from(prefix.matchAll(/^#{1,4}\s+.+$/gm)).map((match) => match[0]).join('\n');
  const selected = [
    h1 ? h1[1] : '',
    headings,
    prefix
  ].filter(Boolean).join('\n');
  return selected.slice(0, MAX_SEARCH_BODY_CHARS);
}

function buildMatchQuery(query, tokenizer = createBasicKeywordTokenizer()) {
  const tokenizeQuery = tokenizer && typeof tokenizer.tokenizeQuery === 'function'
    ? tokenizer.tokenizeQuery.bind(tokenizer)
    : tokenizer.tokenize.bind(tokenizer);
  const tokens = Array.from(new Set(tokenizeQuery(String(query || ''))))
    .filter((token) => token && token.length <= 64)
    .slice(0, 32);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

function rowToMeta(row) {
  return {
    title: row.title || null,
    project: row.project || null,
    docName: row.doc_name || null,
    docType: row.doc_type || null,
    category: row.category || null,
    documentTags: parseJsonArray(row.document_tags_json),
    description: row.description || null,
    date: row.date || null,
    gitBranch: row.git_branch || null,
    gitLastCommit: row.git_last_commit || null,
    snippet: row.snippet || null
  };
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeBm25Rank(value) {
  const rank = Number(value);
  if (!Number.isFinite(rank)) return 0;
  if (rank < 0) {
    const scaled = Math.abs(rank) * 1000000;
    return roundScore(scaled / (1 + scaled));
  }
  return roundScore(1 / (1 + rank));
}

function roundScore(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function normalizeSourceRoot(sourceRoot) {
  if (!sourceRoot || typeof sourceRoot !== 'string') return '';
  const resolved = path.resolve(sourceRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = {
  SQLiteKeywordIndex,
  SQLITE_INDEX_FILENAME,
  buildMatchQuery
};
