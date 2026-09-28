'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { createDocumentClassifier } = require('./document-classifier');
const { createHeadingAwareChunker } = require('./chunker');
const { createLinkGraphIndexer } = require('./link-graph-indexer');

// @req FR-DOC-019 DR-DOC-007 DR-DOC-008 DR-DOC-014
async function deriveValidatedDocument({ ledger, keyword, claim, storeRoot, validated,
  deferKeyword = false, faults = {}, shouldCancel = () => false,
  beginCommit = () => true, onProgress = () => {} }) {
  if (!claim || !validated || validated.documentId !== claim.documentId
    || validated.revision !== claim.requestedRevision || validated.hash !== claim.desiredContentHash) return false;
  const db = ledger.open();
  const current = () => db.prepare('SELECT * FROM documents WHERE document_id = ?').get(claim.documentId);
  const isCurrent = row => {
    if (!row || row.current_job_id !== claim.jobId
      || row.desired_revision !== claim.requestedRevision
      || row.active_requested_revision !== claim.requestedRevision
      || row.desired_content_hash !== validated.hash) return false;
    const job = db.prepare('SELECT status, cancel_requested FROM index_jobs WHERE job_id = ?')
      .get(claim.jobId);
    return job?.status === 'indexing' && job.cancel_requested === 0;
  };
  const before = current();
  if (!isCurrent(before)) return false;
  const requestedBy = db.prepare('SELECT requested_by FROM index_jobs WHERE job_id = ?').get(claim.jobId)?.requested_by;
  const normalizedTextHash = `sha256:${crypto.createHash('sha256')
    .update(validated.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')).digest('hex')}`;
  const priorCompleted = db.prepare(`SELECT content_hash FROM index_jobs
    WHERE document_id = ? AND job_type = 'index_document' AND status = 'completed'
      AND job_id != ? ORDER BY finished_at DESC, updated_at DESC, job_id DESC LIMIT 1`)
    .get(claim.documentId, claim.jobId);
  const preserveLedgerFacts = requestedBy === 'legacy_migration'
    || (requestedBy === 'settings.rebuild.full-reset'
      && (before.normalized_text_hash === normalizedTextHash
        || (!before.normalized_text_hash && priorCompleted?.content_hash === validated.hash)));
  const filePath = path.join(storeRoot, before.relative_path);
  const metadata = JSON.parse(before.metadata_json || '{}');
  const classification = createDocumentClassifier().classify({ content: validated.content, filePath });
  const explicitCategory = typeof metadata.category === 'string' && metadata.category.trim()
    && !/^[\[{]/.test(metadata.category.trim()) ? metadata.category.trim() : null;
  const category = preserveLedgerFacts ? before.category : explicitCategory || classification.category;
  const documentTags = preserveLedgerFacts ? JSON.parse(before.document_tags_json || '[]')
    : Array.isArray(metadata.documentTags) && metadata.documentTags.length
      ? metadata.documentTags : classification.documentTags;
  const project = preserveLedgerFacts ? before.project : metadata.project || classification.project;
  const docType = preserveLedgerFacts ? before.doc_type : metadata.docType || classification.docType;
  const chunks = createHeadingAwareChunker().chunkMarkdown(validated.content, { documentId: claim.documentId });
  const preparedChunks = [];
  for (const chunk of chunks) {
    if (shouldCancel()) return { cancelled: true };
    const value = keyword.tokenizer.buildSearchText(chunk.text);
    const searchText = typeof value?.then === 'function' ? await value : value;
    preparedChunks.push({ ...chunk, searchText: `${searchText}\n${[project, docType, category, ...documentTags].filter(Boolean).join(' ')}`.trim() });
    if (preparedChunks.length % 16 === 0 || preparedChunks.length === chunks.length) {
      onProgress(preparedChunks.length, chunks.length + 2);
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  const sourceId = before.source_id;
  const links = createLinkGraphIndexer({ sourceRoot: storeRoot }).extractLinks(validated.content, {
    filePath, documentId: claim.documentId,
    resolveDocument: ({ pathKey, sourceRelativePath }) => {
      const target = ledger.findDocumentBySourcePath({ sourceId, pathKey, sourceRelativePath });
      return target?.pathStatus === 'active' ? target : null;
    }
  });
  if (shouldCancel() || !beginCommit()) return { cancelled: true };
  if (faults.beforeLedgerCommit) faults.beforeLedgerCommit();
  const committed = ledger.runWriteTransaction(() => {
    if (!isCurrent(current())) return false;
    if (!preserveLedgerFacts) db.prepare(`UPDATE documents SET project = ?, doc_type = ?, category = ?, document_tags_json = ?,
      classification_json = ?, metadata_parse_status = ?, metadata_diagnostic_json = ?,
      normalized_text_hash = ?, keyword_dirty = 1, updated_at = ? WHERE document_id = ?`)
      .run(project || null, docType || null, category, JSON.stringify(documentTags),
        JSON.stringify({ assignedBy: explicitCategory ? 'explicit' : classification.assignedBy,
          confidence: explicitCategory ? 1 : classification.confidence,
          reason: explicitCategory ? 'accepted.metadata.category' : classification.reason,
          evidence: classification.evidence || {} }), classification.parseStatus,
        JSON.stringify(classification.diagnostic || {}),
        normalizedTextHash,
        new Date().toISOString(), claim.documentId);
    else if (!before.normalized_text_hash) db.prepare(`UPDATE documents SET normalized_text_hash = ?
      WHERE document_id = ?`).run(normalizedTextHash, claim.documentId);
    if (!preserveLedgerFacts) db.prepare('DELETE FROM links WHERE from_document_id = ?').run(claim.documentId);
    for (const chunk of preparedChunks) ledger.upsertChunk({
      documentId: claim.documentId, chunkId: chunk.chunkId, ordinal: chunk.ordinal,
      kind: chunk.kind, headingPath: chunk.headingPath, headingLevel: chunk.headingLevel,
      lineStart: chunk.lineStart, lineEnd: chunk.lineEnd, offsetStart: chunk.offsetStart,
      offsetEnd: chunk.offsetEnd, tokenCount: chunk.tokenCount, textHash: chunk.textHash,
      metadata: chunk.metadata, text: chunk.text, searchText: chunk.searchText
    });
    const activeIds = preparedChunks.map(chunk => chunk.chunkId);
    for (const old of db.prepare('SELECT chunk_id FROM chunks WHERE document_id = ?').all(claim.documentId)) {
      if (!activeIds.includes(old.chunk_id)) db.prepare('DELETE FROM chunks WHERE chunk_id = ?').run(old.chunk_id);
    }
    if (!preserveLedgerFacts) for (const link of links) ledger.recordLinkEdge({ ...link,
      fromChunkId: preparedChunks.find(chunk => link.sourceLine >= chunk.lineStart && link.sourceLine <= chunk.lineEnd)?.chunkId || null });
    if (faults.beforeLedgerCommitEnd) faults.beforeLedgerCommitEnd();
    return true;
  });
  if (!committed || !isCurrent(current())) return false;
  onProgress(chunks.length + 1, chunks.length + 2);
  await new Promise(resolve => setImmediate(resolve));
  if (deferKeyword) {
    onProgress(chunks.length + 2, chunks.length + 2);
    return true;
  }
  const meta = { title: metadata.title || null, project, docName: metadata.docName || null,
    docType, category, documentTags, description: metadata.description || null,
    date: metadata.date || null, gitBranch: metadata.gitBranch || null,
    gitLastCommit: metadata.gitLastCommit || null,
    snippet: preparedChunks[0]?.text?.slice(0, 240) || null };
  const replaced = keyword.replaceDocument({ filePath, contentHash: validated.hash,
    revision: claim.requestedRevision,
    meta, segments: preparedChunks.map(chunk => ({ ordinal: chunk.ordinal,
      searchText: chunk.searchText, textHash: chunk.textHash })) }, { beforeCommit: faults.beforeKeywordCommit });
  if (replaced !== true) throw new Error('Keyword document replacement was not committed');
  ledger.runWriteTransaction(() => {
    if (isCurrent(current())) db.prepare('UPDATE documents SET keyword_dirty = 0 WHERE document_id = ?')
      .run(claim.documentId);
  });
  onProgress(chunks.length + 2, chunks.length + 2);
  await new Promise(resolve => setImmediate(resolve));
  return true;
}

module.exports = { deriveValidatedDocument };
