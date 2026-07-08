'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRedactor, redactValue, redactToken } = require('./redaction');

const SOURCE_LEDGER_SCHEMA_VERSION = 1;
const CANONICAL_LINK_STATUSES = Object.freeze([
  'resolved',
  'missing',
  'external',
  'path_policy_violation',
  'skipped',
  'ambiguous',
  'stale'
]);
const PATH_STATUSES = Object.freeze(['active', 'deleted', 'moved', 'missing']);
const INDEX_STATUSES = Object.freeze(['building', 'committed', 'failed', 'stale']);
const JOB_STATUSES = Object.freeze(['queued', 'indexing', 'failed', 'cancelled', 'completed']);

// @req DR-DOC-006
// @req DR-DOC-013
class SourceLedgerStore {
  constructor({ dbPath, userDataDir, loadDatabase, now } = {}) {
    if (!dbPath) throw new Error('Source ledger requires dbPath');
    this.dbPath = dbPath;
    this.userDataDir = userDataDir || null;
    this.indexDir = path.dirname(dbPath);
    this._loadDatabase = loadDatabase || (() => require('better-sqlite3'));
    this._now = typeof now === 'function' ? now : () => new Date().toISOString();
    this.db = null;
    this.writeSuspended = false;
    this.redactor = createRedactor({
      dbPath: this.dbPath,
      userDataDir: this.userDataDir,
      indexDir: this.indexDir
    });
  }

  // @req DR-DOC-006
  initialize() {
    this.open();
    this.verifyIntegrity();
    return this.getSchemaInfo();
  }

  // @req REL-DOC-004
  initializeWithRecovery() {
    try {
      const schemaInfo = this.initialize();
      return {
        ok: true,
        writeSuspended: false,
        status: 'ready',
        schemaInfo
      };
    } catch (err) {
      this.writeSuspended = true;
      this.close();
      return {
        ok: false,
        writeSuspended: true,
        status: 'degraded',
        degradationReason: 'sqlite_recovery_required',
        diagnostic: this.getRecoveryDiagnostics(err)
      };
    }
  }

  // @req DR-DOC-006
  open() {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const Database = this._loadDatabase();
    this.db = new Database(this.dbPath, { timeout: 5000 });
    try {
      this.applyPragmas();
      this.ensureSchema();
    } catch (err) {
      try {
        closeDatabaseHandle(this.db);
      } finally {
        this.db = null;
      }
      throw err;
    }
    return this.db;
  }

  // @req DR-DOC-006
  applyPragmas() {
    const db = this.db;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
  }

  // @req DR-DOC-006
  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const existingVersion = this.db
      .prepare("SELECT value FROM source_ledger_meta WHERE key = 'schema_version'")
      .get();
    if (existingVersion && existingVersion.value !== String(SOURCE_LEDGER_SCHEMA_VERSION)) {
      const backupPath = this.createBackup('incompatible-schema');
      const err = new Error(`Unsupported source ledger schema version: ${existingVersion.value}`);
      err.code = 'SOURCE_LEDGER_SCHEMA_VERSION_UNSUPPORTED';
      err.diagnostic = this.redactor.redactValue({
        diagnosticCode: err.code,
        dbPathInternal: this.dbPath,
        backupPathInternal: backupPath,
        foundVersion: existingVersion.value,
        expectedVersion: SOURCE_LEDGER_SCHEMA_VERSION
      });
      throw err;
    }

    const statusList = sqlStringList(CANONICAL_LINK_STATUSES);
    const pathStatusList = sqlStringList(PATH_STATUSES);
    const indexStatusList = sqlStringList(INDEX_STATUSES);
    const jobStatusList = sqlStringList(JOB_STATUSES);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sources (
        source_id TEXT PRIMARY KEY,
        root_path_internal TEXT NOT NULL UNIQUE,
        source_kind TEXT NOT NULL DEFAULT 'document_source',
        display_name TEXT,
        root_fingerprint TEXT NOT NULL,
        include_globs_json TEXT NOT NULL DEFAULT '[]',
        exclude_globs_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        document_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        canonical_path_hash TEXT,
        path_status TEXT NOT NULL DEFAULT 'active' CHECK(path_status IN (${pathStatusList})),
        path_history_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT,
        content_byte_length INTEGER,
        content_text_length INTEGER,
        normalized_text_hash TEXT,
        project TEXT,
        doc_type TEXT,
        category TEXT,
        document_tags_json TEXT NOT NULL DEFAULT '[]',
        classification_json TEXT NOT NULL DEFAULT '{}',
        metadata_parse_status TEXT NOT NULL DEFAULT 'ok',
        metadata_diagnostic_json TEXT,
        source_mtime_or_revision TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_import_job_id TEXT,
        import_state TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_id, path_key)
      );

      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'markdown',
        heading_path_json TEXT NOT NULL DEFAULT '[]',
        heading_level INTEGER,
        line_start INTEGER,
        line_end INTEGER,
        offset_start INTEGER,
        offset_end INTEGER,
        token_count INTEGER,
        text_hash TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(document_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS chunk_search_content (
        chunk_id TEXT PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        search_text TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        search_text,
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        content='chunk_search_content',
        content_rowid='rowid',
        tokenize='unicode61'
      );

      CREATE TABLE IF NOT EXISTS links (
        edge_id TEXT PRIMARY KEY,
        from_document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        from_chunk_id TEXT REFERENCES chunks(chunk_id) ON DELETE SET NULL,
        to_document_id TEXT REFERENCES documents(document_id) ON DELETE SET NULL,
        original_href_internal TEXT,
        normalized_href_internal TEXT,
        redacted_href TEXT,
        link_text TEXT,
        target_anchor TEXT,
        source_line INTEGER,
        ordinal INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN (${statusList})),
        diagnostic_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(status = 'resolved' OR to_document_id IS NULL)
      );

      CREATE INDEX IF NOT EXISTS idx_links_from_document ON links(from_document_id);
      CREATE INDEX IF NOT EXISTS idx_links_to_document ON links(to_document_id) WHERE to_document_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_links_status ON links(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_canonical_path_hash
        ON documents(canonical_path_hash)
        WHERE canonical_path_hash IS NOT NULL;

      CREATE TABLE IF NOT EXISTS document_source_aliases (
        alias_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
        alias_kind TEXT NOT NULL,
        canonical_path_hash TEXT NOT NULL UNIQUE,
        content_hash TEXT,
        content_byte_length INTEGER,
        content_text_length INTEGER,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_document_source_aliases_document_id
        ON document_source_aliases(document_id);

      CREATE TABLE IF NOT EXISTS embedding_models (
        model_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        model_fingerprint TEXT NOT NULL UNIQUE,
        dimensions INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS chunk_search_content_ai
      AFTER INSERT ON chunk_search_content BEGIN
        INSERT INTO chunk_fts(rowid, search_text, chunk_id, document_id)
        VALUES (new.rowid, new.search_text, new.chunk_id, new.document_id);
      END;

      CREATE TRIGGER IF NOT EXISTS chunk_search_content_ad
      AFTER DELETE ON chunk_search_content BEGIN
        INSERT INTO chunk_fts(chunk_fts, rowid, search_text, chunk_id, document_id)
        VALUES ('delete', old.rowid, old.search_text, old.chunk_id, old.document_id);
      END;

      CREATE TRIGGER IF NOT EXISTS chunk_search_content_au
      AFTER UPDATE ON chunk_search_content BEGIN
        INSERT INTO chunk_fts(chunk_fts, rowid, search_text, chunk_id, document_id)
        VALUES ('delete', old.rowid, old.search_text, old.chunk_id, old.document_id);
        INSERT INTO chunk_fts(rowid, search_text, chunk_id, document_id)
        VALUES (new.rowid, new.search_text, new.chunk_id, new.document_id);
      END;

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
        model_id TEXT NOT NULL REFERENCES embedding_models(model_id) ON DELETE CASCADE,
        embedding BLOB,
        vector_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(chunk_id, model_id)
      );

      CREATE TABLE IF NOT EXISTS ann_indexes (
        ann_index_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES embedding_models(model_id) ON DELETE CASCADE,
        index_path_internal TEXT,
        index_path_token TEXT,
        params_json TEXT NOT NULL DEFAULT '{}',
        checksum TEXT,
        status TEXT NOT NULL CHECK(status IN (${indexStatusList})),
        created_at TEXT NOT NULL,
        committed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ann_memberships (
        ann_index_id TEXT NOT NULL REFERENCES ann_indexes(ann_index_id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
        model_id TEXT NOT NULL REFERENCES embedding_models(model_id) ON DELETE CASCADE,
        ann_label INTEGER NOT NULL,
        tombstoned INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(ann_index_id, chunk_id),
        UNIQUE(ann_index_id, ann_label)
      );

      CREATE TABLE IF NOT EXISTS index_jobs (
        job_id TEXT PRIMARY KEY,
        source_id TEXT REFERENCES sources(source_id) ON DELETE SET NULL,
        document_id TEXT REFERENCES documents(document_id) ON DELETE SET NULL,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (${jobStatusList})),
        priority INTEGER NOT NULL DEFAULT 0,
        requested_by TEXT,
        phase TEXT,
        progress_current INTEGER NOT NULL DEFAULT 0,
        progress_total INTEGER NOT NULL DEFAULT 0,
        current_path_internal TEXT,
        content_hash TEXT,
        content_byte_length INTEGER,
        content_text_length INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        diagnostic_code TEXT,
        diagnostic_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        heartbeat_at TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureColumn('sources', 'source_kind', "TEXT NOT NULL DEFAULT 'document_source'");
    this.ensureColumn('documents', 'project', 'TEXT');
    this.ensureColumn('documents', 'content_byte_length', 'INTEGER');
    this.ensureColumn('documents', 'content_text_length', 'INTEGER');
    this.ensureColumn('documents', 'normalized_text_hash', 'TEXT');
    this.ensureColumn('documents', 'category', 'TEXT');
    this.ensureColumn('documents', 'document_tags_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('documents', 'classification_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('documents', 'metadata_parse_status', "TEXT NOT NULL DEFAULT 'ok'");
    this.ensureColumn('documents', 'metadata_diagnostic_json', 'TEXT');
    this.ensureColumn('document_source_aliases', 'content_hash', 'TEXT');
    this.ensureColumn('document_source_aliases', 'content_byte_length', 'INTEGER');
    this.ensureColumn('document_source_aliases', 'content_text_length', 'INTEGER');
    this.ensureColumn('ann_indexes', 'params_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('ann_memberships', 'deleted_at', 'TEXT');
    this.ensureColumn('chunks', 'kind', "TEXT NOT NULL DEFAULT 'markdown'");
    this.ensureColumn('chunks', 'heading_level', 'INTEGER');
    this.ensureColumn('chunks', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('chunks', 'text', 'TEXT');
    this.ensureColumn('index_jobs', 'requested_by', 'TEXT');
    this.ensureColumn('index_jobs', 'phase', 'TEXT');
    this.ensureColumn('index_jobs', 'progress_current', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('index_jobs', 'progress_total', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('index_jobs', 'current_path_internal', 'TEXT');
    this.ensureColumn('index_jobs', 'content_hash', 'TEXT');
    this.ensureColumn('index_jobs', 'content_byte_length', 'INTEGER');
    this.ensureColumn('index_jobs', 'content_text_length', 'INTEGER');
    this.ensureColumn('index_jobs', 'cancel_requested', 'INTEGER NOT NULL DEFAULT 0');

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_content_fingerprint
        ON documents(content_hash, content_byte_length, content_text_length)
        WHERE content_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_document_source_aliases_fingerprint
        ON document_source_aliases(content_hash, content_byte_length, content_text_length)
        WHERE content_hash IS NOT NULL;
    `);

    this.db.prepare(`
      INSERT INTO source_ledger_meta(key, value)
      VALUES ('schema_version', @version)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ version: String(SOURCE_LEDGER_SCHEMA_VERSION) });
    this.db.prepare("INSERT INTO chunk_fts(chunk_fts) VALUES ('rebuild')").run();
  }

  // @req DR-DOC-006
  ensureColumn(tableName, columnName, definition) {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (rows.some((row) => row.name === columnName)) return;
    this.db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
  }

  // @req REL-DOC-004
  verifyIntegrity() {
    const row = this.open().prepare('PRAGMA integrity_check').get();
    const result = row && Object.values(row)[0];
    if (result !== 'ok') {
      const err = new Error('SQLite source ledger integrity check failed');
      err.code = 'SOURCE_LEDGER_INTEGRITY_CHECK_FAILED';
      err.diagnostic = redactValue({
        diagnosticCode: err.code,
        dbPathInternal: this.dbPath,
        userDataDir: this.userDataDir,
        integrityCheck: result
      }, this.redactionOptions());
      throw err;
    }
    return true;
  }

  // @req DR-DOC-006
  getSchemaInfo() {
    const rows = this.open().prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'view')
      ORDER BY name
    `).all();
    const meta = this.open().prepare('SELECT key, value FROM source_ledger_meta ORDER BY key').all();
    return {
      schemaVersion: SOURCE_LEDGER_SCHEMA_VERSION,
      tables: rows.map((row) => row.name),
      meta: Object.fromEntries(meta.map((row) => [row.key, row.value])),
      pragmas: {
        journalMode: this.db.pragma('journal_mode', { simple: true }),
        foreignKeys: this.db.pragma('foreign_keys', { simple: true }),
        busyTimeout: this.db.pragma('busy_timeout', { simple: true }),
        synchronous: this.db.pragma('synchronous', { simple: true })
      }
    };
  }

  // @req DR-DOC-009
  recordSource(input = {}) {
    this.assertWritable();
    const rootPathInternal = normalizeInternalPath(requiredString(input.rootPathInternal, 'rootPathInternal'));
    const rootFingerprint = requiredString(input.rootFingerprint || stableHash(rootPathInternal), 'rootFingerprint');
    const now = this._now();
    const sourceId = input.sourceId || stableId('src', rootPathInternal, rootFingerprint);
    const record = {
      sourceId,
      rootPathInternal,
      sourceKind: normalizeSourceKind(input.sourceKind || input.source_kind || 'document_source'),
      displayName: input.displayName || path.basename(rootPathInternal) || 'Source',
      rootFingerprint,
      includeGlobsJson: JSON.stringify(input.includeGlobs || []),
      excludeGlobsJson: JSON.stringify(input.excludeGlobs || []),
      enabled: input.enabled === false ? 0 : 1,
      now
    };

    this.open().prepare(`
      INSERT INTO sources(
        source_id, root_path_internal, source_kind, display_name, root_fingerprint,
        include_globs_json, exclude_globs_json, enabled, created_at, updated_at
      )
      VALUES (
        @sourceId, @rootPathInternal, @sourceKind, @displayName, @rootFingerprint,
        @includeGlobsJson, @excludeGlobsJson, @enabled, @now, @now
      )
      ON CONFLICT(root_path_internal) DO UPDATE SET
        source_kind = excluded.source_kind,
        display_name = excluded.display_name,
        root_fingerprint = excluded.root_fingerprint,
        include_globs_json = excluded.include_globs_json,
        exclude_globs_json = excluded.exclude_globs_json,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(record);

    const row = this.open().prepare('SELECT * FROM sources WHERE root_path_internal = ?').get(rootPathInternal);
    return sourceRowToPublic(row);
  }

  // @req DR-DOC-013
  upsertDocument(input = {}) {
    this.assertWritable();
    const sourceId = requiredString(input.sourceId, 'sourceId');
    const relativePath = normalizeRelativePath(input.sourceRelativePath || input.relativePath || input.pathKey);
    const pathKey = normalizePathKey(input.pathKey || relativePath);
    const now = this._now();
    const existingByPath = this.open().prepare(`
      SELECT *
      FROM documents
      WHERE source_id = ? AND path_key = ?
    `).get(sourceId, pathKey);
    const existingByDocument = input.documentId
      ? this.open().prepare('SELECT * FROM documents WHERE document_id = ?').get(String(input.documentId))
      : null;
    const existing = existingByPath || existingByDocument || null;
    const documentId = input.documentId || (existingByPath && existingByPath.document_id) || stableId('doc', sourceId, pathKey);
    const firstSeenAt = existing && existing.first_seen_at ? existing.first_seen_at : now;
    const pathStatus = input.pathStatus || 'active';
    if (!PATH_STATUSES.includes(pathStatus)) {
      throw new Error(`Unsupported document path status: ${pathStatus}`);
    }
    const pathHistory = Array.isArray(input.pathHistory)
      ? input.pathHistory.slice()
      : (existing ? safeJsonArray(existing.path_history_json) : []);
    if (existingByDocument && existingByDocument.relative_path && existingByDocument.relative_path !== relativePath) {
      pathHistory.push({
        relativePath: existingByDocument.relative_path,
        pathKey: existingByDocument.path_key,
        pathStatus: existingByDocument.path_status,
        movedAt: now
      });
    }

    const record = {
      documentId,
      sourceId,
      relativePath,
      pathKey,
      canonicalPathHash: input.canonicalPathInternal ? stableHash(normalizeInternalPath(realpathOrPath(input.canonicalPathInternal))) : input.canonicalPathHash || null,
      pathStatus,
      pathHistoryJson: JSON.stringify(pathHistory),
      contentHash: input.contentHash || null,
      contentByteLength: Number.isInteger(input.contentByteLength) ? input.contentByteLength : null,
      contentTextLength: Number.isInteger(input.contentTextLength) ? input.contentTextLength : null,
      normalizedTextHash: input.normalizedTextHash || null,
      project: input.project || null,
      docType: input.docType || null,
      category: input.category || null,
      documentTagsJson: JSON.stringify(input.documentTags || []),
      classificationJson: JSON.stringify(input.classification || {}),
      metadataParseStatus: input.parseStatus || 'ok',
      metadataDiagnosticJson: serializeDiagnosticJson(this.redactor, input.metadataDiagnostic || input.diagnostic, input.metadataDiagnosticJson),
      sourceMtimeOrRevision: input.sourceMtimeOrRevision || null,
      firstSeenAt,
      lastSeenAt: now,
      lastImportJobId: input.lastImportJobId || null,
      importState: input.importState || 'active',
      now
    };

    this.open().prepare(`
      INSERT INTO documents(
        document_id, source_id, relative_path, path_key, canonical_path_hash,
        path_status, path_history_json, content_hash, content_byte_length,
        content_text_length, normalized_text_hash, project, doc_type, category,
        document_tags_json, classification_json, metadata_parse_status, metadata_diagnostic_json,
        source_mtime_or_revision, first_seen_at, last_seen_at, last_import_job_id,
        import_state, created_at, updated_at
      )
      VALUES (
        @documentId, @sourceId, @relativePath, @pathKey, @canonicalPathHash,
        @pathStatus, @pathHistoryJson, @contentHash, @contentByteLength,
        @contentTextLength, @normalizedTextHash, @project, @docType, @category,
        @documentTagsJson, @classificationJson, @metadataParseStatus, @metadataDiagnosticJson,
        @sourceMtimeOrRevision, @firstSeenAt, @lastSeenAt, @lastImportJobId,
        @importState, @now, @now
      )
      ON CONFLICT(document_id) DO UPDATE SET
        source_id = excluded.source_id,
        relative_path = excluded.relative_path,
        path_key = excluded.path_key,
        canonical_path_hash = excluded.canonical_path_hash,
        path_status = excluded.path_status,
        path_history_json = excluded.path_history_json,
        content_hash = excluded.content_hash,
        content_byte_length = excluded.content_byte_length,
        content_text_length = excluded.content_text_length,
        normalized_text_hash = excluded.normalized_text_hash,
        project = excluded.project,
        doc_type = excluded.doc_type,
        category = excluded.category,
        document_tags_json = excluded.document_tags_json,
        classification_json = excluded.classification_json,
        metadata_parse_status = excluded.metadata_parse_status,
        metadata_diagnostic_json = excluded.metadata_diagnostic_json,
        source_mtime_or_revision = excluded.source_mtime_or_revision,
        last_seen_at = excluded.last_seen_at,
        last_import_job_id = excluded.last_import_job_id,
        import_state = excluded.import_state,
        updated_at = excluded.updated_at
    `).run(record);
    this.setAnnMembershipTombstonesForDocument({
      documentId,
      tombstoned: pathStatus !== 'active',
      deletedAt: pathStatus !== 'active' ? now : null
    });

    const row = this.open().prepare('SELECT * FROM documents WHERE document_id = ?').get(documentId);
    return documentRowToPublic(row);
  }

  // @req DR-DOC-006
  upsertChunk(input = {}) {
    this.assertWritable();
    const documentId = requiredString(input.documentId, 'documentId');
    const ordinal = Number.isInteger(input.ordinal) ? input.ordinal : 0;
    const chunkId = input.chunkId || stableId('chk', documentId, String(ordinal));
    const now = this._now();
    const record = {
      chunkId,
      documentId,
      ordinal,
      kind: input.kind || 'markdown',
      headingPathJson: JSON.stringify(input.headingPath || []),
      headingLevel: nullableInteger(input.headingLevel),
      lineStart: nullableInteger(input.lineStart),
      lineEnd: nullableInteger(input.lineEnd),
      offsetStart: nullableInteger(input.offsetStart),
      offsetEnd: nullableInteger(input.offsetEnd),
      tokenCount: nullableInteger(input.tokenCount),
      textHash: input.textHash || null,
      metadataJson: JSON.stringify(input.metadata || {}),
      text: typeof input.text === 'string' ? input.text : null,
      searchText: input.searchText,
      now
    };
    const db = this.open();
    const applyChunk = db.transaction((chunk) => {
      const existingOrdinal = db.prepare(`
        SELECT chunk_id
        FROM chunks
        WHERE document_id = ? AND ordinal = ?
      `).get(chunk.documentId, chunk.ordinal);
      if (existingOrdinal && existingOrdinal.chunk_id !== chunk.chunkId) {
        db.prepare('DELETE FROM chunks WHERE chunk_id = ?').run(existingOrdinal.chunk_id);
      }

      db.prepare(`
        INSERT INTO chunks(
          chunk_id, document_id, ordinal, kind, heading_path_json, heading_level,
          line_start, line_end, offset_start, offset_end, token_count, text_hash,
          metadata_json, text, created_at, updated_at
        )
        VALUES (
          @chunkId, @documentId, @ordinal, @kind, @headingPathJson, @headingLevel,
          @lineStart, @lineEnd, @offsetStart, @offsetEnd, @tokenCount, @textHash,
          @metadataJson, @text, @now, @now
        )
        ON CONFLICT(document_id, ordinal) DO UPDATE SET
          kind = excluded.kind,
          heading_path_json = excluded.heading_path_json,
          heading_level = excluded.heading_level,
          line_start = excluded.line_start,
          line_end = excluded.line_end,
          offset_start = excluded.offset_start,
          offset_end = excluded.offset_end,
          token_count = excluded.token_count,
          text_hash = excluded.text_hash,
          metadata_json = excluded.metadata_json,
          text = excluded.text,
          updated_at = excluded.updated_at
      `).run(chunk);

      if (typeof chunk.searchText === 'string') {
        db.prepare(`
        INSERT INTO chunk_search_content(chunk_id, document_id, search_text, updated_at)
        VALUES (@chunkId, @documentId, @searchText, @now)
        ON CONFLICT(chunk_id) DO UPDATE SET
          document_id = excluded.document_id,
          search_text = excluded.search_text,
          updated_at = excluded.updated_at
        `).run(chunk);
      }
    });
    applyChunk(record);

    return this.open().prepare('SELECT * FROM chunks WHERE chunk_id = ?').get(chunkId);
  }

  // @req FR-DOC-019
  enqueueIndexJob(input = {}) {
    this.assertWritable();
    const now = this._now();
    const jobType = input.jobType || 'index_document';
    const contentHash = input.contentHash || null;
    const jobId = input.jobId || stableId(
      'job',
      input.sourceId || '',
      input.documentId || '',
      input.currentPathInternal || '',
      contentHash || '',
      jobType
    );
    const record = {
      jobId,
      sourceId: input.sourceId || null,
      documentId: input.documentId || null,
      jobType,
      status: input.status || 'queued',
      priority: Number.isInteger(input.priority) ? input.priority : 0,
      requestedBy: input.requestedBy || null,
      phase: input.phase || null,
      progressCurrent: Number.isInteger(input.progressCurrent) ? input.progressCurrent : 0,
      progressTotal: Number.isInteger(input.progressTotal) ? input.progressTotal : 0,
      currentPathInternal: input.currentPathInternal || null,
      contentHash,
      contentByteLength: Number.isInteger(input.contentByteLength) ? input.contentByteLength : null,
      contentTextLength: Number.isInteger(input.contentTextLength) ? input.contentTextLength : null,
      cancelRequested: input.cancelRequested ? 1 : 0,
      diagnosticCode: input.diagnosticCode || null,
      diagnosticJson: serializeDiagnosticJson(this.redactor, input.diagnostic, input.diagnosticJson),
      now
    };
    if (!JOB_STATUSES.includes(record.status)) {
      throw new Error(`Unsupported index job status: ${record.status}`);
    }

    this.open().prepare(`
      INSERT INTO index_jobs(
        job_id, source_id, document_id, job_type, status, priority, requested_by,
        phase, progress_current, progress_total, current_path_internal,
        content_hash, content_byte_length, content_text_length,
        cancel_requested, diagnostic_code, diagnostic_json,
        created_at, heartbeat_at, updated_at
      )
      VALUES (
        @jobId, @sourceId, @documentId, @jobType, @status, @priority, @requestedBy,
        @phase, @progressCurrent, @progressTotal, @currentPathInternal,
        @contentHash, @contentByteLength, @contentTextLength,
        @cancelRequested, @diagnosticCode, @diagnosticJson,
        @now, @now, @now
      )
      ON CONFLICT(job_id) DO UPDATE SET
        source_id = COALESCE(excluded.source_id, index_jobs.source_id),
        document_id = COALESCE(excluded.document_id, index_jobs.document_id),
        status = excluded.status,
        priority = excluded.priority,
        requested_by = excluded.requested_by,
        phase = excluded.phase,
        progress_current = excluded.progress_current,
        progress_total = excluded.progress_total,
        current_path_internal = excluded.current_path_internal,
        content_hash = excluded.content_hash,
        content_byte_length = excluded.content_byte_length,
        content_text_length = excluded.content_text_length,
        cancel_requested = excluded.cancel_requested,
        diagnostic_code = excluded.diagnostic_code,
        diagnostic_json = excluded.diagnostic_json,
        started_at = NULL,
        finished_at = NULL,
        heartbeat_at = excluded.heartbeat_at,
        updated_at = excluded.updated_at
    `).run(record);
    return this.getIndexJob(jobId);
  }

  // @req FR-DOC-019
  updateIndexJob(jobId, patch = {}) {
    this.assertWritable();
    const existing = this.open().prepare('SELECT * FROM index_jobs WHERE job_id = ?').get(requiredString(jobId, 'jobId'));
    if (!existing) return null;
    const status = patch.status || existing.status;
    if (!JOB_STATUSES.includes(status)) {
      throw new Error(`Unsupported index job status: ${status}`);
    }
    const now = this._now();
    const record = {
      jobId,
      documentId: Object.prototype.hasOwnProperty.call(patch, 'documentId') ? patch.documentId : existing.document_id,
      status,
      phase: Object.prototype.hasOwnProperty.call(patch, 'phase') ? patch.phase : existing.phase,
      progressCurrent: Number.isInteger(patch.progressCurrent) ? patch.progressCurrent : existing.progress_current,
      progressTotal: Number.isInteger(patch.progressTotal) ? patch.progressTotal : existing.progress_total,
      currentPathInternal: Object.prototype.hasOwnProperty.call(patch, 'currentPathInternal') ? patch.currentPathInternal : existing.current_path_internal,
      contentHash: Object.prototype.hasOwnProperty.call(patch, 'contentHash') ? patch.contentHash : existing.content_hash,
      contentByteLength: Object.prototype.hasOwnProperty.call(patch, 'contentByteLength')
        ? (Number.isInteger(patch.contentByteLength) ? patch.contentByteLength : null)
        : existing.content_byte_length,
      contentTextLength: Object.prototype.hasOwnProperty.call(patch, 'contentTextLength')
        ? (Number.isInteger(patch.contentTextLength) ? patch.contentTextLength : null)
        : existing.content_text_length,
      cancelRequested: Object.prototype.hasOwnProperty.call(patch, 'cancelRequested') ? (patch.cancelRequested ? 1 : 0) : existing.cancel_requested,
      diagnosticCode: Object.prototype.hasOwnProperty.call(patch, 'diagnosticCode') ? patch.diagnosticCode : existing.diagnostic_code,
      diagnosticJson: Object.prototype.hasOwnProperty.call(patch, 'diagnostic')
        ? serializeDiagnosticJson(this.redactor, patch.diagnostic, null)
        : (
          Object.prototype.hasOwnProperty.call(patch, 'diagnosticJson')
            ? serializeDiagnosticJson(this.redactor, null, patch.diagnosticJson)
            : existing.diagnostic_json
        ),
      startedAt: patch.startedAt === true ? now : (Object.prototype.hasOwnProperty.call(patch, 'startedAt') ? patch.startedAt : existing.started_at),
      finishedAt: patch.finishedAt === true ? now : (Object.prototype.hasOwnProperty.call(patch, 'finishedAt') ? patch.finishedAt : existing.finished_at),
      now
    };
    this.open().prepare(`
      UPDATE index_jobs
      SET document_id = @documentId,
          status = @status,
          phase = @phase,
          progress_current = @progressCurrent,
          progress_total = @progressTotal,
          current_path_internal = @currentPathInternal,
          content_hash = @contentHash,
          content_byte_length = @contentByteLength,
          content_text_length = @contentTextLength,
          cancel_requested = @cancelRequested,
          diagnostic_code = @diagnosticCode,
          diagnostic_json = @diagnosticJson,
          started_at = @startedAt,
          finished_at = @finishedAt,
          heartbeat_at = @now,
          updated_at = @now
      WHERE job_id = @jobId
    `).run(record);
    return this.getIndexJob(jobId);
  }

  // @req FR-DOC-019
  getIndexJob(jobId) {
    const row = this.open().prepare('SELECT * FROM index_jobs WHERE job_id = ?').get(requiredString(jobId, 'jobId'));
    return this.redactor.redactValue(indexJobRowToPublic(row));
  }

  // @req FR-DOC-019
  getIndexJobs({ documentId, status } = {}) {
    const where = [];
    const params = {};
    if (documentId) {
      where.push('document_id = @documentId');
      params.documentId = documentId;
    }
    if (status) {
      if (!JOB_STATUSES.includes(status)) throw new Error(`Unsupported index job status: ${status}`);
      where.push('status = @status');
      params.status = status;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.open().prepare(`
      SELECT *
      FROM index_jobs
      ${whereSql}
      ORDER BY created_at DESC, job_id
    `).all(params).map((row) => this.redactor.redactValue(indexJobRowToPublic(row)));
  }

  // @req FR-DOC-019
  getRecoverableIndexJobs({ statuses = ['queued', 'indexing'] } = {}) {
    const requested = Array.isArray(statuses) ? statuses : [];
    const valid = requested.filter((status) => JOB_STATUSES.includes(status));
    if (valid.length === 0) return [];
    const placeholders = valid.map((_, index) => `@status${index}`).join(', ');
    const params = Object.fromEntries(valid.map((status, index) => [`status${index}`, status]));
    return this.open().prepare(`
      SELECT *
      FROM index_jobs
      WHERE status IN (${placeholders})
      ORDER BY created_at ASC, job_id
    `).all(params).map(indexJobRowToInternal);
  }

  // @req DR-DOC-013
  findDocumentBySourcePath({ sourceId, pathKey, sourceRelativePath } = {}) {
    const normalizedKey = normalizePathKey(pathKey || sourceRelativePath);
    const row = this.open().prepare(`
      SELECT *
      FROM documents
      WHERE source_id = ? AND path_key = ?
    `).get(requiredString(sourceId, 'sourceId'), normalizedKey);
    return documentRowToPublic(row);
  }

  // @req FR-DOC-022
  findMoveCandidateByContentHash({ sourceId, contentHash, excludePathKey } = {}) {
    if (!contentHash) return null;
    const row = this.open().prepare(`
      SELECT *
      FROM documents
      WHERE source_id = @sourceId
        AND content_hash = @contentHash
        AND path_status IN ('missing', 'deleted', 'moved')
        AND (@excludePathKey IS NULL OR path_key != @excludePathKey)
      ORDER BY updated_at DESC, document_id
      LIMIT 1
    `).get({
      sourceId: requiredString(sourceId, 'sourceId'),
      contentHash: String(contentHash),
      excludePathKey: excludePathKey ? normalizePathKey(excludePathKey) : null
    });
    return documentRowToPublic(row);
  }

  // @req FR-DOC-035
  findActiveDocumentByContentFingerprint({ contentHash, contentByteLength, contentTextLength, excludeDocumentId } = {}) {
    if (!contentHash || !Number.isInteger(contentByteLength) || !Number.isInteger(contentTextLength)) return null;
    const row = this.open().prepare(`
      SELECT *
      FROM documents
      WHERE content_hash = @contentHash
        AND content_byte_length = @contentByteLength
        AND content_text_length = @contentTextLength
        AND path_status = 'active'
        AND (@excludeDocumentId IS NULL OR document_id != @excludeDocumentId)
      ORDER BY updated_at DESC, document_id
      LIMIT 1
    `).get({
      contentHash: String(contentHash),
      contentByteLength,
      contentTextLength,
      excludeDocumentId: excludeDocumentId || null
    });
    return documentRowToPublic(row);
  }

  // @req FR-DOC-035
  findDocumentSourceAliasByCanonicalPath({ canonicalPathInternal, canonicalPathHash } = {}) {
    const pathHash = canonicalPathHash || stableHash(normalizeInternalPath(realpathOrPath(requiredString(canonicalPathInternal, 'canonicalPathInternal'))));
    const row = this.open().prepare(`
      SELECT
        a.*,
        d.document_id AS linked_document_id,
        d.source_id AS linked_source_id,
        d.relative_path AS linked_relative_path,
        d.path_key AS linked_path_key,
        d.content_hash AS linked_content_hash
      FROM document_source_aliases a
      LEFT JOIN documents d ON d.document_id = a.document_id
      WHERE a.canonical_path_hash = ?
      LIMIT 1
    `).get(pathHash);
    return documentSourceAliasRowToPublic(row);
  }

  // @req FR-DOC-035
  upsertDocumentSourceAlias(input = {}) {
    this.assertWritable();
    const documentId = requiredString(input.documentId, 'documentId');
    const canonicalPathHash = input.canonicalPathHash || stableHash(normalizeInternalPath(realpathOrPath(requiredString(input.canonicalPathInternal, 'canonicalPathInternal'))));
    const aliasKind = normalizeSourceKind(input.aliasKind || 'opened_path');
    const now = this._now();
    const existing = this.open().prepare(`
      SELECT *
      FROM document_source_aliases
      WHERE canonical_path_hash = ?
    `).get(canonicalPathHash);
    const record = {
      aliasId: input.aliasId || (existing && existing.alias_id) || stableId('alias', aliasKind, canonicalPathHash),
      documentId,
      aliasKind,
      canonicalPathHash,
      contentHash: input.contentHash || null,
      contentByteLength: Number.isInteger(input.contentByteLength) ? input.contentByteLength : null,
      contentTextLength: Number.isInteger(input.contentTextLength) ? input.contentTextLength : null,
      firstSeenAt: existing && existing.first_seen_at ? existing.first_seen_at : now,
      lastSeenAt: now,
      now
    };
    this.open().prepare(`
      INSERT INTO document_source_aliases(
        alias_id, document_id, alias_kind, canonical_path_hash,
        content_hash, content_byte_length, content_text_length,
        first_seen_at, last_seen_at, created_at, updated_at
      )
      VALUES (
        @aliasId, @documentId, @aliasKind, @canonicalPathHash,
        @contentHash, @contentByteLength, @contentTextLength,
        @firstSeenAt, @lastSeenAt, @now, @now
      )
      ON CONFLICT(canonical_path_hash) DO UPDATE SET
        document_id = excluded.document_id,
        alias_kind = excluded.alias_kind,
        content_hash = excluded.content_hash,
        content_byte_length = excluded.content_byte_length,
        content_text_length = excluded.content_text_length,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `).run(record);
    return this.findDocumentSourceAliasByCanonicalPath({ canonicalPathHash });
  }

  // @req DR-DOC-013
  getDocument(documentId) {
    const row = this.open().prepare(`
      SELECT *
      FROM documents
      WHERE document_id = ?
    `).get(requiredString(documentId, 'documentId'));
    return documentRowToPublic(row);
  }

  // @req DR-DOC-013
  findDocumentByCanonicalPath({ canonicalPathInternal, canonicalPathHash } = {}) {
    const pathHash = canonicalPathHash || stableHash(normalizeInternalPath(realpathOrPath(requiredString(canonicalPathInternal, 'canonicalPathInternal'))));
    const row = this.open().prepare(`
      SELECT *
      FROM documents
      WHERE canonical_path_hash = ?
      ORDER BY path_status = 'active' DESC, updated_at DESC, document_id
      LIMIT 1
    `).get(pathHash);
    return documentRowToPublic(row);
  }

  // @req CON-DOC-006
  // @req FR-TREE-009
  recordLinkEdge(input = {}) {
    this.assertWritable();
    const fromDocumentId = requiredString(input.fromDocumentId, 'fromDocumentId');
    const status = canonicalLinkStatus(input.status);
    const toDocumentId = status === 'resolved' ? input.toDocumentId || null : null;
    const originalHref = input.originalHref == null ? null : String(input.originalHref);
    const normalizedHref = input.normalizedHref == null ? originalHref : String(input.normalizedHref);
    const ordinal = Number.isInteger(input.ordinal) ? input.ordinal : nextLinkOrdinal(this.open(), fromDocumentId);
    const edgeId = input.edgeId || stableId('edge', fromDocumentId, String(ordinal), originalHref || '', normalizedHref || '');
    const now = this._now();

    if (status === 'resolved' && !toDocumentId) {
      throw new Error('Resolved link edges require toDocumentId');
    }
    if (status !== 'resolved' && !input.diagnosticCode) {
      throw new Error(`Non-resolved link edge requires diagnosticCode for status: ${status}`);
    }

    this.open().prepare(`
      INSERT INTO links(
        edge_id, from_document_id, from_chunk_id, to_document_id,
        original_href_internal, normalized_href_internal, redacted_href,
        link_text, target_anchor, source_line, ordinal, status, diagnostic_code,
        created_at, updated_at
      )
      VALUES (
        @edgeId, @fromDocumentId, @fromChunkId, @toDocumentId,
        @originalHrefInternal, @normalizedHrefInternal, @redactedHref,
        @linkText, @targetAnchor, @sourceLine, @ordinal, @status, @diagnosticCode,
        @now, @now
      )
      ON CONFLICT(edge_id) DO UPDATE SET
        from_chunk_id = excluded.from_chunk_id,
        to_document_id = excluded.to_document_id,
        original_href_internal = excluded.original_href_internal,
        normalized_href_internal = excluded.normalized_href_internal,
        redacted_href = excluded.redacted_href,
        link_text = excluded.link_text,
        target_anchor = excluded.target_anchor,
        source_line = excluded.source_line,
        ordinal = excluded.ordinal,
        status = excluded.status,
        diagnostic_code = excluded.diagnostic_code,
        updated_at = excluded.updated_at
    `).run({
      edgeId,
      fromDocumentId,
      fromChunkId: input.fromChunkId || null,
      toDocumentId,
      originalHrefInternal: originalHref,
      normalizedHrefInternal: normalizedHref,
      redactedHref: originalHref == null ? null : redactToken('HREF', originalHref),
      linkText: input.linkText || null,
      targetAnchor: input.targetAnchor || null,
      sourceLine: nullableInteger(input.sourceLine),
      ordinal,
      status,
      diagnosticCode: input.diagnosticCode || null,
      now
    });

    const row = this.open().prepare('SELECT * FROM links WHERE edge_id = ?').get(edgeId);
    return linkRowToPublic(row);
  }

  // @req CON-DOC-006
  // @req SEC-DOC-003
  getLinkDiagnostics({ documentId } = {}) {
    const params = {};
    const where = [];
    if (documentId) {
      params.documentId = documentId;
      where.push('l.from_document_id = @documentId');
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.open().prepare(`
      SELECT l.*, d.relative_path AS from_relative_path, s.root_path_internal AS source_root_internal
      FROM links l
      JOIN documents d ON d.document_id = l.from_document_id
      JOIN sources s ON s.source_id = d.source_id
      ${whereSql}
      ORDER BY l.from_document_id, l.ordinal, l.edge_id
    `).all(params);

    const counts = Object.fromEntries(CANONICAL_LINK_STATUSES.map((status) => [status, 0]));
    for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;

    return this.redactor.redactValue({
      documentId: documentId || null,
      counts,
      edges: rows.map(linkDiagnosticRowToPublic)
    });
  }

  // @req CON-DOC-006
  getLinkStatusCounts() {
    const rows = this.open().prepare(`
      SELECT status, COUNT(*) AS count
      FROM links
      GROUP BY status
    `).all();
    const counts = Object.fromEntries(CANONICAL_LINK_STATUSES.map((status) => [status, 0]));
    for (const row of rows) {
      if (Object.prototype.hasOwnProperty.call(counts, row.status)) {
        counts[row.status] = row.count;
      }
    }
    return counts;
  }

  // @req CON-DOC-006
  getResolvedLinkFilterDocumentIds({ linkedTo, linkedFrom } = {}) {
    const sets = [];
    if (linkedTo) {
      const rows = this.open().prepare(`
        SELECT DISTINCT from_document_id AS document_id
        FROM links
        WHERE status = 'resolved' AND to_document_id = ?
      `).all(String(linkedTo));
      sets.push(new Set(rows.map((row) => row.document_id)));
    }
    if (linkedFrom) {
      const rows = this.open().prepare(`
        SELECT DISTINCT to_document_id AS document_id
        FROM links
        WHERE status = 'resolved' AND from_document_id = ? AND to_document_id IS NOT NULL
      `).all(String(linkedFrom));
      sets.push(new Set(rows.map((row) => row.document_id)));
    }
    if (sets.length === 0) return null;
    let current = sets[0];
    for (let i = 1; i < sets.length; i += 1) {
      current = new Set(Array.from(current).filter((documentId) => sets[i].has(documentId)));
    }
    return Array.from(current).sort();
  }

  // @req CON-DOC-006
  getResolvedLinkFilterDocuments({ linkedTo, linkedFrom } = {}) {
    const documentIds = this.getResolvedLinkFilterDocumentIds({ linkedTo, linkedFrom });
    if (!Array.isArray(documentIds) || documentIds.length === 0) return [];
    const placeholders = documentIds.map((_, index) => `@id${index}`).join(', ');
    const params = Object.fromEntries(documentIds.map((documentId, index) => [`id${index}`, documentId]));
    const rows = this.open().prepare(`
      SELECT d.document_id, d.source_id, d.relative_path, d.path_key, d.path_status, s.root_path_internal
      FROM documents d
      JOIN sources s ON s.source_id = d.source_id
      WHERE d.document_id IN (${placeholders})
      ORDER BY d.path_status = 'active' DESC, d.relative_path, d.document_id
    `).all(params);
    return rows.map((row) => ({
      documentId: row.document_id,
      sourceId: row.source_id,
      sourceRelativePath: row.relative_path,
      pathKey: row.path_key,
      pathStatus: row.path_status,
      filePathInternal: path.join(row.root_path_internal, row.relative_path)
    }));
  }

  // @req FR-DOC-024
  listActiveDocuments({ sourceId } = {}) {
    const where = ["d.path_status = 'active'", "d.import_state = 'active'"];
    const params = {};
    if (sourceId) {
      where.push('d.source_id = @sourceId');
      params.sourceId = String(sourceId);
    }
    const rows = this.open().prepare(`
      SELECT d.*, s.root_path_internal
      FROM documents d
      JOIN sources s ON s.source_id = d.source_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.relative_path, d.document_id
    `).all(params);
    return rows.map((row) => ({
      ...documentRowToPublic(row),
      filePathInternal: path.join(row.root_path_internal, row.relative_path)
    }));
  }

  // @req FR-DOC-020
  // @req FR-DOC-024
  upsertEmbeddingModel(input = {}) {
    this.assertWritable();
    const provider = input.provider || 'openai-compatible';
    const modelName = requiredString(input.modelName || input.model, 'modelName');
    const modelFingerprint = requiredString(input.modelFingerprint, 'modelFingerprint');
    const modelId = input.modelId || stableId('emb-model', provider, modelName, modelFingerprint);
    const now = this._now();
    const record = {
      modelId,
      provider,
      modelName,
      modelFingerprint,
      dimensions: nullableInteger(input.dimensions),
      status: input.status || 'active',
      now
    };
    this.open().prepare(`
      INSERT INTO embedding_models(
        model_id, provider, model_name, model_fingerprint, dimensions, status, created_at, updated_at
      )
      VALUES (
        @modelId, @provider, @modelName, @modelFingerprint, @dimensions, @status, @now, @now
      )
      ON CONFLICT(model_id) DO UPDATE SET
        provider = excluded.provider,
        model_name = excluded.model_name,
        model_fingerprint = excluded.model_fingerprint,
        dimensions = excluded.dimensions,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(record);
    const row = this.open().prepare('SELECT * FROM embedding_models WHERE model_id = ?').get(modelId);
    return embeddingModelRowToPublic(row);
  }

  // @req FR-DOC-020
  // @req FR-DOC-024
  upsertChunkEmbedding(input = {}) {
    this.assertWritable();
    const chunkId = requiredString(input.chunkId, 'chunkId');
    const modelId = requiredString(input.modelId, 'modelId');
    const vector = normalizeEmbeddingVector(input.embedding || input.vector);
    const now = this._now();
    const record = {
      chunkId,
      modelId,
      embedding: encodeEmbeddingVector(vector),
      vectorHash: input.vectorHash || `sha256:${stableHash(vector.join(','))}`,
      status: input.status || 'active',
      now
    };
    this.open().prepare(`
      INSERT INTO chunk_embeddings(
        chunk_id, model_id, embedding, vector_hash, status, created_at, updated_at
      )
      VALUES (
        @chunkId, @modelId, @embedding, @vectorHash, @status, @now, @now
      )
      ON CONFLICT(chunk_id, model_id) DO UPDATE SET
        embedding = excluded.embedding,
        vector_hash = excluded.vector_hash,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(record);
    const row = this.open().prepare(`
      SELECT ce.*, em.model_fingerprint
      FROM chunk_embeddings ce
      JOIN embedding_models em ON em.model_id = ce.model_id
      WHERE ce.chunk_id = ? AND ce.model_id = ?
    `).get(chunkId, modelId);
    return chunkEmbeddingRowToPublic(row);
  }

  // @req FR-DOC-020
  // @req FR-DOC-025
  listChunkEmbeddingVectors({ modelFingerprint, modelId, limit = 10000 } = {}) {
    if (!modelFingerprint && !modelId) return [];
    const requestedLimit = Math.max(1, Math.min(Number(limit) || 10000, 50000));
    const where = ['ce.status = @embeddingStatus', 'em.status = @modelStatus'];
    const params = {
      embeddingStatus: 'active',
      modelStatus: 'active',
      limit: requestedLimit
    };
    if (modelFingerprint) {
      where.push('em.model_fingerprint = @modelFingerprint');
      params.modelFingerprint = String(modelFingerprint);
    }
    if (modelId) {
      where.push('em.model_id = @modelId');
      params.modelId = String(modelId);
    }
    return this.open().prepare(`
      SELECT
        ce.chunk_id,
        ce.embedding,
        ce.vector_hash,
        em.model_id,
        em.model_fingerprint,
        em.dimensions,
        c.document_id,
        c.ordinal,
        c.heading_path_json,
        c.text,
        c.text_hash,
        d.relative_path,
        d.project,
        d.doc_type,
        d.category,
        d.document_tags_json,
        d.path_status,
        s.root_path_internal
      FROM chunk_embeddings ce
      JOIN embedding_models em ON em.model_id = ce.model_id
      JOIN chunks c ON c.chunk_id = ce.chunk_id
      JOIN documents d ON d.document_id = c.document_id
      JOIN sources s ON s.source_id = d.source_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.relative_path, c.ordinal, ce.chunk_id
      LIMIT @limit
    `).all(params).map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      sourceRelativePath: row.relative_path,
      filePath: path.join(row.root_path_internal, row.relative_path),
      title: extractChunkTitle(row),
      snippet: buildChunkSnippet(row.text),
      vector: decodeEmbeddingVector(row.embedding),
      modelId: row.model_id,
      modelFingerprint: row.model_fingerprint,
      project: row.project || null,
      docType: row.doc_type || null,
      category: row.category || null,
      documentTags: safeJsonArray(row.document_tags_json),
      pathStatus: row.path_status || null
    }));
  }

  // @req FR-DOC-020
  // @req FR-DOC-025
  searchChunkEmbeddings({ modelFingerprint, modelId, queryVector, limit = 20 } = {}) {
    const vector = normalizeEmbeddingVector(queryVector);
    const requestedLimit = Math.max(1, Math.min(Number(limit) || 20, 500));
    const rows = this.listChunkEmbeddingVectors({ modelFingerprint, modelId });

    return rows
      .map((row) => {
        const candidateVector = row.vector;
        if (candidateVector.length !== vector.length) return null;
        const similarity = cosineSimilarity(vector, candidateVector);
        const score = clamp01((similarity + 1) / 2);
        return {
          chunkId: row.chunkId,
          documentId: row.documentId,
          sourceRelativePath: row.sourceRelativePath,
          filePath: row.filePath,
          title: row.title,
          snippet: row.snippet,
          score,
          semanticScore: score,
          distance: 1 - score,
          modelId: row.modelId,
          modelFingerprint: row.modelFingerprint,
          project: row.project || null,
          docType: row.docType || null,
          category: row.category || null,
          documentTags: row.documentTags || [],
          pathStatus: row.pathStatus || null
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.score - a.score) || String(a.documentId).localeCompare(String(b.documentId)) || (a.chunkId || '').localeCompare(b.chunkId || ''))
      .slice(0, requestedLimit);
  }

  // @req FR-DOC-020
  // @req FR-DOC-022
  recordAnnIndex(input = {}) {
    this.assertWritable();
    const modelId = requiredString(input.modelId, 'modelId');
    const indexPathInternal = input.indexPathInternal ? normalizeInternalPath(input.indexPathInternal) : null;
    if (indexPathInternal && !isPathWithinRoot(indexPathInternal, this.indexDir)) {
      const err = new Error('ANN index path must stay inside the index data directory');
      err.code = 'ANN_INDEX_PATH_OUTSIDE_INDEX_DIR';
      throw err;
    }
    const status = input.status || 'committed';
    if (!INDEX_STATUSES.includes(status)) {
      throw new Error(`Unsupported ANN index status: ${status}`);
    }
    const annIndexId = input.annIndexId || stableId('ann', modelId, indexPathInternal || '', input.checksum || '', status);
    const now = this._now();
    const record = {
      annIndexId,
      modelId,
      indexPathInternal,
      indexPathToken: indexPathInternal ? redactToken('PATH', indexPathInternal) : null,
      paramsJson: JSON.stringify(input.params || {}),
      checksum: input.checksum || null,
      status,
      committedAt: status === 'committed' ? now : null,
      now
    };
    this.open().prepare(`
      INSERT INTO ann_indexes(
        ann_index_id, model_id, index_path_internal, index_path_token,
        params_json, checksum, status, created_at, committed_at, updated_at
      )
      VALUES (
        @annIndexId, @modelId, @indexPathInternal, @indexPathToken,
        @paramsJson, @checksum, @status, @now, @committedAt, @now
      )
      ON CONFLICT(ann_index_id) DO UPDATE SET
        index_path_internal = excluded.index_path_internal,
        index_path_token = excluded.index_path_token,
        params_json = excluded.params_json,
        checksum = excluded.checksum,
        status = excluded.status,
        committed_at = excluded.committed_at,
        updated_at = excluded.updated_at
    `).run(record);
    return this.open().prepare('SELECT * FROM ann_indexes WHERE ann_index_id = ?').get(annIndexId);
  }

  // @req FR-DOC-020
  // @req FR-DOC-022
  replaceAnnMemberships({ annIndexId, modelId, memberships } = {}) {
    this.assertWritable();
    const id = requiredString(annIndexId, 'annIndexId');
    const model = requiredString(modelId, 'modelId');
    const rows = Array.isArray(memberships) ? memberships : [];
    const now = this._now();
    const db = this.open();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM ann_memberships WHERE ann_index_id = ?').run(id);
      const insert = db.prepare(`
        INSERT INTO ann_memberships(
          ann_index_id, chunk_id, model_id, ann_label, tombstoned, deleted_at, created_at
        )
        VALUES (
          @annIndexId, @chunkId, @modelId, @annLabel, @tombstoned, @deletedAt, @now
        )
      `);
      for (const item of rows) {
        insert.run({
          annIndexId: id,
          chunkId: requiredString(item.chunkId, 'chunkId'),
          modelId: model,
          annLabel: Number.isInteger(item.annLabel) ? item.annLabel : Number(item.annLabel),
          tombstoned: item.tombstoned ? 1 : 0,
          deletedAt: item.tombstoned ? (item.deletedAt || now) : null,
          now
        });
      }
    });
    tx();
    return {
      annIndexId: id,
      count: rows.length
    };
  }

  // @req FR-DOC-020
  // @req FR-DOC-022
  getCommittedAnnIndex({ modelFingerprint, modelId } = {}) {
    if (!modelFingerprint && !modelId) return null;
    const where = ["ai.status = 'committed'"];
    const params = {};
    if (modelFingerprint) {
      where.push('em.model_fingerprint = @modelFingerprint');
      params.modelFingerprint = String(modelFingerprint);
    }
    if (modelId) {
      where.push('em.model_id = @modelId');
      params.modelId = String(modelId);
    }
    const row = this.open().prepare(`
      SELECT ai.*, em.model_fingerprint, em.dimensions
      FROM ann_indexes ai
      JOIN embedding_models em ON em.model_id = ai.model_id
      WHERE ${where.join(' AND ')}
      ORDER BY ai.committed_at DESC, ai.updated_at DESC, ai.ann_index_id DESC
      LIMIT 1
    `).get(params);
    if (!row) return null;
    return {
      annIndexId: row.ann_index_id,
      modelId: row.model_id,
      modelFingerprint: row.model_fingerprint,
      dimensions: row.dimensions,
      params: safeJsonObject(row.params_json),
      indexPathInternal: row.index_path_internal,
      indexPathToken: row.index_path_token,
      checksum: row.checksum,
      status: row.status,
      committedAt: row.committed_at
    };
  }

  // @req FR-DOC-020
  // @req FR-DOC-022
  getAnnMembershipCandidates({ annIndexId } = {}) {
    const id = requiredString(annIndexId, 'annIndexId');
    return this.open().prepare(`
      SELECT
        am.ann_label,
        am.tombstoned,
        am.deleted_at,
        am.chunk_id,
        am.model_id,
        c.document_id,
        c.heading_path_json,
        c.text,
        d.relative_path,
        d.project,
        d.doc_type,
        d.category,
        d.document_tags_json,
        d.path_status,
        s.root_path_internal
      FROM ann_memberships am
      JOIN chunks c ON c.chunk_id = am.chunk_id
      JOIN documents d ON d.document_id = c.document_id
      JOIN sources s ON s.source_id = d.source_id
      WHERE am.ann_index_id = ?
      ORDER BY am.ann_label
    `).all(id).map((row) => ({
      annLabel: row.ann_label,
      tombstoned: Boolean(row.tombstoned),
      deletedAt: row.deleted_at || null,
      chunkId: row.chunk_id,
      modelId: row.model_id,
      documentId: row.document_id,
      sourceRelativePath: row.relative_path,
      filePath: path.join(row.root_path_internal, row.relative_path),
      title: extractChunkTitle(row),
      snippet: buildChunkSnippet(row.text),
      project: row.project || null,
      docType: row.doc_type || null,
      category: row.category || null,
      documentTags: safeJsonArray(row.document_tags_json),
      pathStatus: row.path_status || null
    }));
  }

  // @req FR-DOC-022
  setAnnMembershipTombstonesForDocument({ documentId, tombstoned = true, deletedAt } = {}) {
    this.assertWritable();
    const id = requiredString(documentId, 'documentId');
    const now = this._now();
    const result = this.open().prepare(`
      UPDATE ann_memberships
      SET tombstoned = @tombstoned,
          deleted_at = @deletedAt
      WHERE chunk_id IN (
        SELECT chunk_id
        FROM chunks
        WHERE document_id = @documentId
      )
    `).run({
      documentId: id,
      tombstoned: tombstoned ? 1 : 0,
      deletedAt: tombstoned ? (deletedAt || now) : null
    });
    return { documentId: id, tombstoned: Boolean(tombstoned), count: result.changes || 0 };
  }

  // @req FR-DOC-022
  getAnnCompactionStatus({ annIndexId, threshold = 0.20 } = {}) {
    const id = requiredString(annIndexId, 'annIndexId');
    const row = this.open().prepare(`
      SELECT
        COUNT(*) AS membership_count,
        SUM(CASE WHEN am.tombstoned = 1 OR d.path_status != 'active' THEN 1 ELSE 0 END) AS stale_count
      FROM ann_memberships am
      JOIN chunks c ON c.chunk_id = am.chunk_id
      JOIN documents d ON d.document_id = c.document_id
      WHERE am.ann_index_id = ?
    `).get(id);
    const membershipCount = Number(row && row.membership_count) || 0;
    const staleCount = Number(row && row.stale_count) || 0;
    const ratio = membershipCount > 0 ? staleCount / membershipCount : 0;
    const requestedThreshold = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.20;
    return {
      annIndexId: id,
      membershipCount,
      staleCount,
      tombstoneRatio: ratio,
      compactionThreshold: requestedThreshold,
      compactionRecommended: ratio >= requestedThreshold
    };
  }

  // @req FR-DOC-024
  clearSemanticDerivedState({ modelFingerprint, modelId } = {}) {
    this.assertWritable();
    if (!modelFingerprint && !modelId) return { cleared: false, reason: 'model-identity-required' };
    const db = this.open();
    const where = [];
    const params = {};
    if (modelFingerprint) {
      where.push('model_fingerprint = @modelFingerprint');
      params.modelFingerprint = String(modelFingerprint);
    }
    if (modelId) {
      where.push('model_id = @modelId');
      params.modelId = String(modelId);
    }
    const modelRows = db.prepare(`
      SELECT model_id
      FROM embedding_models
      WHERE ${where.join(' AND ')}
    `).all(params);
    const ids = modelRows.map((row) => row.model_id);
    if (ids.length === 0) return { cleared: false, modelCount: 0, embeddingCount: 0, annIndexCount: 0 };
    const placeholders = ids.map((_, index) => `@id${index}`).join(', ');
    const deleteParams = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
    const tx = db.transaction(() => {
      const embeddingCount = db.prepare(`DELETE FROM chunk_embeddings WHERE model_id IN (${placeholders})`).run(deleteParams).changes;
      const annIndexCount = db.prepare(`DELETE FROM ann_indexes WHERE model_id IN (${placeholders})`).run(deleteParams).changes;
      db.prepare(`UPDATE embedding_models SET status = 'stale', updated_at = @now WHERE model_id IN (${placeholders})`).run({ ...deleteParams, now: this._now() });
      return { embeddingCount, annIndexCount };
    });
    const result = tx();
    return { cleared: true, modelCount: ids.length, ...result };
  }

  // @req REL-DOC-007
  clearSearchDerivedState({ reason = 'settings-rebuild-full-reset' } = {}) {
    this.assertWritable();
    const db = this.open();
    const annRows = db.prepare(`
      SELECT index_path_internal
      FROM ann_indexes
      WHERE index_path_internal IS NOT NULL
    `).all();
    const tx = db.transaction(() => {
      const linkCount = db.prepare('DELETE FROM links').run().changes;
      const annMembershipCount = db.prepare('DELETE FROM ann_memberships').run().changes;
      const annIndexCount = db.prepare('DELETE FROM ann_indexes').run().changes;
      const embeddingCount = db.prepare('DELETE FROM chunk_embeddings').run().changes;
      const chunkSearchContentCount = db.prepare('DELETE FROM chunk_search_content').run().changes;
      const chunkCount = db.prepare('DELETE FROM chunks').run().changes;
      const indexJobCount = db.prepare('DELETE FROM index_jobs').run().changes;
      db.prepare("INSERT INTO chunk_fts(chunk_fts) VALUES ('rebuild')").run();
      return {
        linkCount,
        annMembershipCount,
        annIndexCount,
        embeddingCount,
        chunkSearchContentCount,
        chunkCount,
        indexJobCount
      };
    });
    const result = tx();
    const hnswFiles = deleteContainedAnnFiles({
      rows: annRows,
      indexDir: this.indexDir,
      userDataDir: this.userDataDir
    });
    return {
      cleared: true,
      reason,
      ...result,
      hnswFiles
    };
  }

  // @req REL-DOC-004
  getRecoveryDiagnostics(error) {
    return this.redactor.redactValue({
      diagnosticCode: error && error.code ? error.code : 'source_ledger_diagnostic',
      message: error && error.message ? error.message : null,
      dbPathInternal: this.dbPath,
      userDataDir: this.userDataDir,
      indexDir: this.indexDir
    });
  }

  // @req REL-DOC-004
  createBackupManifest({
    reason = 'manual',
    hnswManifest = null,
    skipBackup = false,
    gitContextPath = null
  } = {}) {
    const backupPath = skipBackup ? null : this.createBackup(reason);
    const manifest = this.redactor.redactValue({
      reason,
      schemaVersion: SOURCE_LEDGER_SCHEMA_VERSION,
      dbPathToken: redactToken('PATH', this.dbPath),
      backupPathToken: backupPath ? redactToken('PATH', backupPath) : null,
      backupSkipped: Boolean(skipBackup),
      walPresent: fs.existsSync(`${this.dbPath}-wal`),
      shmPresent: fs.existsSync(`${this.dbPath}-shm`),
      hnswManifest: hnswManifest || null,
      gitContextPath
    });
    return manifest;
  }

  // @req REL-DOC-004
  verifyAnnIndexChecksum({ annIndexId } = {}) {
    const id = requiredString(annIndexId, 'annIndexId');
    const row = this.open().prepare('SELECT * FROM ann_indexes WHERE ann_index_id = ?').get(id);
    if (!row) {
      return {
        status: 'degraded',
        degradationReason: 'hnsw_index_missing',
        rebuildRecommended: true,
        diagnosticCode: 'hnsw_index_missing'
      };
    }
    const indexPathInternal = row.index_path_internal || null;
    if (!indexPathInternal || !fs.existsSync(indexPathInternal)) {
      return this.redactor.redactValue({
        status: 'degraded',
        degradationReason: 'hnsw_file_missing',
        rebuildRecommended: true,
        diagnosticCode: 'hnsw_file_missing',
        indexPathInternal
      });
    }
    const actual = `sha256:${fileSha256(indexPathInternal)}`;
    const expected = normalizeChecksum(row.checksum);
    if (expected && expected !== actual) {
      return this.redactor.redactValue({
        status: 'degraded',
        degradationReason: 'hnsw_checksum_mismatch',
        rebuildRecommended: true,
        diagnosticCode: 'hnsw_checksum_mismatch',
        expectedChecksum: row.checksum,
        actualChecksum: actual,
        indexPathInternal
      });
    }
    return this.redactor.redactValue({
      status: 'ready',
      rebuildRecommended: false,
      diagnosticCode: null,
      indexPathInternal
    });
  }

  // @req REL-DOC-004
  getMigrationFailureDiagnostics(input = {}) {
    const backupPath = input.backupPathInternal || null;
    return this.redactor.redactValue({
      diagnosticCode: 'migration_failed',
      migrationId: input.migrationId || null,
      sourceSchemaVersion: input.sourceSchemaVersion || null,
      targetSchemaVersion: input.targetSchemaVersion || null,
      rollbackAvailable: Boolean(backupPath && fs.existsSync(backupPath)),
      dbPathInternal: input.dbPathInternal || this.dbPath,
      backupPathInternal: backupPath,
      gitContextPath: input.gitContextPath || null,
      providerUrl: input.providerUrl || null,
      message: input.message || null
    });
  }

  // @req REL-DOC-004
  restoreBackup(backupPathInternal) {
    try {
      const backupPath = requiredString(backupPathInternal, 'backupPathInternal');
      if (!fs.existsSync(backupPath)) {
        throw Object.assign(new Error('Backup file not found'), { code: 'BACKUP_FILE_NOT_FOUND' });
      }
      this.close();
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      fs.copyFileSync(backupPath, this.dbPath);
      this.writeSuspended = false;
      return this.redactor.redactValue({
        restored: true,
        diagnosticCode: null,
        backupPathInternal: backupPath,
        dbPathInternal: this.dbPath
      });
    } catch (err) {
      return this.redactor.redactValue({
        restored: false,
        diagnosticCode: 'backup_restore_failed',
        message: err && err.message ? err.message : String(err),
        backupPathInternal,
        dbPathInternal: this.dbPath
      });
    }
  }

  // @req REL-DOC-004
  createBackup(reason = 'manual') {
    this.open();
    const stamp = this._now().replace(/[:.]/g, '-');
    const backupPath = `${this.dbPath}.bak-${reason}-${stamp}`;
    fs.copyFileSync(this.dbPath, backupPath);
    return backupPath;
  }

  // @req DR-DOC-006
  close() {
    if (!this.db) return;
    closeDatabaseHandle(this.db);
    this.db = null;
  }

  // @req SEC-DOC-003
  redactionOptions() {
    return {
      dbPath: this.dbPath,
      userDataDir: this.userDataDir,
      indexDir: this.indexDir
    };
  }

  assertWritable() {
    if (this.writeSuspended) {
      const err = new Error('SQLite source ledger writes are suspended until recovery completes');
      err.code = 'SOURCE_LEDGER_WRITE_SUSPENDED';
      err.diagnostic = this.getRecoveryDiagnostics(err);
      throw err;
    }
  }

  runWriteTransaction(callback) {
    this.assertWritable();
    const tx = this.open().transaction(callback);
    return typeof tx.immediate === 'function' ? tx.immediate() : tx();
  }
}

// @req DR-DOC-006
function createSourceLedgerStore(options = {}) {
  return new SourceLedgerStore(options);
}

function closeDatabaseHandle(db) {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Closing must still release the handle if checkpointing is unavailable or the DB is mid-failure.
  }
  try {
    db.pragma('journal_mode = DELETE');
  } catch {
    // WAL may be unavailable during schema failure handling; close remains the important operation.
  }
  db.close();
}

// @req DR-DOC-006
function stableId(prefix, ...parts) {
  return `${prefix}_${stableHash(parts.join('\0')).slice(0, 24)}`;
}

// @req DR-DOC-013
function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// @req DR-DOC-009
function normalizeInternalPath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathWithinRoot(filePath, rootPath) {
  if (!filePath || !rootPath) return false;
  const normalizedFile = normalizeInternalPath(filePath);
  const normalizedRoot = normalizeInternalPath(rootPath);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}${path.sep}`);
}

function realpathOrPath(value) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch {
    return path.resolve(String(value));
  }
}

function deleteContainedAnnFiles({ rows = [], indexDir } = {}) {
  const roots = [indexDir].filter(Boolean).map((root) => normalizeInternalPath(root));
  const files = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const filePath = row && row.index_path_internal ? path.resolve(row.index_path_internal) : null;
    if (!filePath) continue;
    const normalized = normalizeInternalPath(filePath);
    const contained = roots.some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`));
    if (!contained) {
      files.push({ deleted: false, skipped: true, reason: 'outside-index-root', pathToken: redactToken('PATH', filePath) });
      continue;
    }
    try {
      if (!fs.existsSync(filePath)) {
        files.push({ deleted: false, skipped: true, reason: 'missing', pathToken: redactToken('PATH', filePath) });
        continue;
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        files.push({ deleted: false, skipped: true, reason: 'not-file', pathToken: redactToken('PATH', filePath) });
        continue;
      }
      fs.unlinkSync(filePath);
      files.push({ deleted: true, skipped: false, pathToken: redactToken('PATH', filePath) });
    } catch (err) {
      files.push({
        deleted: false,
        skipped: false,
        reason: err && err.message ? err.message : 'delete-failed',
        pathToken: redactToken('PATH', filePath)
      });
    }
  }
  return files;
}

function normalizeSourceKind(value) {
  return String(value || 'document_source')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'document_source';
}

// @req DR-DOC-013
function normalizeRelativePath(value) {
  const raw = requiredString(value, 'sourceRelativePath').replace(/\\/g, '/');
  return raw.replace(/^\/+/, '').split('/').filter(Boolean).join('/');
}

// @req DR-DOC-013
function normalizePathKey(value) {
  return normalizeRelativePath(value).normalize('NFC').toLowerCase();
}

// @req CON-DOC-006
function canonicalLinkStatus(status) {
  if (!CANONICAL_LINK_STATUSES.includes(status)) {
    throw new Error(`Unsupported canonical link status: ${status}`);
  }
  return status;
}

// @req DR-DOC-006
function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

// @req DR-DOC-006
function nullableInteger(value) {
  return Number.isInteger(value) ? value : null;
}

// @req DR-DOC-006
function sqlStringList(values) {
  return values.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(', ');
}

// @req CON-DOC-006
function nextLinkOrdinal(db, fromDocumentId) {
  const row = db.prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal FROM links WHERE from_document_id = ?').get(fromDocumentId);
  return row.next_ordinal;
}

// @req DR-DOC-009
function sourceRowToPublic(row) {
  if (!row) return null;
  return {
    sourceId: row.source_id,
    sourceKind: row.source_kind || 'document_source',
    displayName: row.display_name,
    rootFingerprint: row.root_fingerprint,
    rootPathToken: redactToken('PATH', row.root_path_internal),
    includeGlobs: safeJsonArray(row.include_globs_json),
    excludeGlobs: safeJsonArray(row.exclude_globs_json),
    enabled: Boolean(row.enabled)
  };
}

// @req DR-DOC-013
function documentRowToPublic(row) {
  if (!row) return null;
  return {
    documentId: row.document_id,
    sourceId: row.source_id,
    sourceRelativePath: row.relative_path,
    pathKey: row.path_key,
    pathStatus: row.path_status,
    pathHistory: safeJsonArray(row.path_history_json),
    contentHash: row.content_hash,
    contentByteLength: Number.isInteger(row.content_byte_length) ? row.content_byte_length : null,
    contentTextLength: Number.isInteger(row.content_text_length) ? row.content_text_length : null,
    normalizedTextHash: row.normalized_text_hash || null,
    project: row.project || null,
    docType: row.doc_type,
    category: row.category,
    documentTags: safeJsonArray(row.document_tags_json),
    classification: safeJsonObject(row.classification_json),
    parseStatus: row.metadata_parse_status || 'ok',
    metadataDiagnostic: safeJsonObject(row.metadata_diagnostic_json),
    importState: row.import_state
  };
}

// @req FR-DOC-035
function documentSourceAliasRowToPublic(row) {
  if (!row) return null;
  return {
    aliasId: row.alias_id,
    documentId: row.linked_document_id || row.document_id,
    aliasKind: row.alias_kind,
    canonicalPathHash: row.canonical_path_hash,
    contentHash: row.content_hash || null,
    contentByteLength: Number.isInteger(row.content_byte_length) ? row.content_byte_length : null,
    contentTextLength: Number.isInteger(row.content_text_length) ? row.content_text_length : null,
    linkedSourceId: row.linked_source_id || null,
    linkedSourceRelativePath: row.linked_relative_path || null,
    linkedPathKey: row.linked_path_key || null,
    linkedContentHash: row.linked_content_hash || null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  };
}

// @req CON-DOC-006
function linkRowToPublic(row) {
  if (!row) return null;
  return {
    edgeId: row.edge_id,
    fromDocumentId: row.from_document_id,
    fromChunkId: row.from_chunk_id || null,
    toDocumentId: row.status === 'resolved' ? row.to_document_id : null,
    redactedHref: row.redacted_href,
    linkText: row.link_text || null,
    targetAnchor: row.target_anchor || null,
    sourceLine: row.source_line,
    ordinal: row.ordinal,
    status: row.status,
    diagnosticCode: row.diagnostic_code || null
  };
}

// @req CON-DOC-006
// @req SEC-DOC-003
function linkDiagnosticRowToPublic(row) {
  return {
    edgeId: row.edge_id,
    fromDocumentId: row.from_document_id,
    fromSourceRelativePath: row.from_relative_path,
    sourceRootInternal: row.source_root_internal,
    toDocumentId: row.status === 'resolved' ? row.to_document_id : null,
    redactedHref: row.redacted_href,
    status: row.status,
    diagnosticCode: row.diagnostic_code || null
  };
}

// @req FR-DOC-019
function indexJobRowToPublic(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    sourceId: row.source_id || null,
    documentId: row.document_id || null,
    jobType: row.job_type,
    status: row.status,
    priority: row.priority,
    requestedBy: row.requested_by || null,
    phase: row.phase || null,
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    currentPathToken: row.current_path_internal ? redactToken('PATH', row.current_path_internal) : null,
    contentHash: row.content_hash || null,
    contentByteLength: Number.isInteger(row.content_byte_length) ? row.content_byte_length : null,
    contentTextLength: Number.isInteger(row.content_text_length) ? row.content_text_length : null,
    cancelRequested: Boolean(row.cancel_requested),
    diagnosticCode: row.diagnostic_code || null,
    diagnostic: safeJsonObject(row.diagnostic_json),
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    heartbeatAt: row.heartbeat_at || null,
    updatedAt: row.updated_at
  };
}

function indexJobRowToInternal(row) {
  if (!row) return null;
  return {
    ...indexJobRowToPublic(row),
    currentPathInternal: row.current_path_internal || null
  };
}

// @req FR-DOC-020
function embeddingModelRowToPublic(row) {
  if (!row) return null;
  return {
    modelId: row.model_id,
    provider: row.provider,
    modelName: row.model_name,
    modelFingerprint: row.model_fingerprint,
    dimensions: row.dimensions,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// @req FR-DOC-020
function chunkEmbeddingRowToPublic(row) {
  if (!row) return null;
  return {
    chunkId: row.chunk_id,
    modelId: row.model_id,
    modelFingerprint: row.model_fingerprint || null,
    vectorHash: row.vector_hash || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// @req FR-DOC-020
function normalizeEmbeddingVector(value) {
  if (Buffer.isBuffer(value)) return decodeEmbeddingVector(value);
  const vector = ArrayBuffer.isView(value) ? Array.from(value) : value;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Embedding vector must be a non-empty numeric array');
  }
  const normalized = vector.map((item) => Number(item));
  if (normalized.some((item) => !Number.isFinite(item))) {
    throw new Error('Embedding vector contains a non-finite value');
  }
  return normalized;
}

// @req FR-DOC-020
function encodeEmbeddingVector(vector) {
  const normalized = normalizeEmbeddingVector(vector);
  const floats = new Float32Array(normalized.length);
  for (let i = 0; i < normalized.length; i += 1) floats[i] = normalized[i];
  return Buffer.from(floats.buffer);
}

// @req FR-DOC-020
function decodeEmbeddingVector(value) {
  if (!value) return [];
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (buffer.length % Float32Array.BYTES_PER_ELEMENT !== 0) return [];
  const view = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / Float32Array.BYTES_PER_ELEMENT);
  return Array.from(view);
}

// @req FR-DOC-020
function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm <= 0 || rightNorm <= 0) return -1;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeChecksum(value) {
  if (!value) return null;
  const text = String(value);
  return text.startsWith('sha256:') ? text : `sha256:${text}`;
}

function extractChunkTitle(row = {}) {
  const headingPath = safeJsonArray(row.heading_path_json);
  const headingTitle = headingPath.length ? headingPath[headingPath.length - 1] : '';
  if (headingTitle) return String(headingTitle);
  const firstLine = String(row.text || '').split(/\r?\n/).find((line) => line.trim());
  return firstLine ? firstLine.replace(/^#+\s*/, '').trim().slice(0, 120) : 'Untitled';
}

function buildChunkSnippet(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

function serializeDiagnosticJson(redactor, diagnostic, diagnosticJson) {
  if (diagnostic != null) {
    const value = redactor && typeof redactor.redactValue === 'function'
      ? redactor.redactValue(diagnostic)
      : redactValue(diagnostic);
    return JSON.stringify(value);
  }
  if (diagnosticJson == null) return null;
  try {
    const parsed = JSON.parse(String(diagnosticJson));
    const value = redactor && typeof redactor.redactValue === 'function'
      ? redactor.redactValue(parsed)
      : redactValue(parsed);
    return JSON.stringify(value);
  } catch {
    const text = redactor && typeof redactor.redactString === 'function'
      ? redactor.redactString(String(diagnosticJson))
      : String(redactValue(String(diagnosticJson)));
    return JSON.stringify({ message: text });
  }
}

// @req DR-DOC-006
function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// @req DR-DOC-006
function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = {
  SourceLedgerStore,
  createSourceLedgerStore,
  createWave2LedgerStore: createSourceLedgerStore,
  SOURCE_LEDGER_SCHEMA_VERSION,
  CANONICAL_LINK_STATUSES
};
