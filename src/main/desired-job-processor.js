'use strict';

const path = require('node:path');
const { readValidatedMarkdownCandidate } = require('./indexed-origin-resolver');
const { withPublicationGate } = require('./index-ingress-store');

// @req FR-DOC-019 REL-DOC-009
async function runClaimedDesiredJob({ ledger, claim, storeRoot, ingressRoot, onValidated, onFinalValidated, afterFinalRead }) {
  const target = ledger.open().prepare(`SELECT d.relative_path AS relativePath,
    d.metadata_json AS metadataJson, s.root_path_internal AS sourceRoot,
    s.source_kind AS sourceKind
    FROM documents d JOIN sources s ON s.source_id = d.source_id WHERE d.document_id = ?`)
    .get(claim.documentId);
  const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (!target || (canonical(target.sourceRoot) !== canonical(storeRoot)
    && target.sourceKind !== 'local_import_source')) {
    ledger.failClaimedJob({ claim });
    return { completed: false, retryable: true };
  }
  const file = path.join(storeRoot, target.relativePath);
  const read = () => readValidatedMarkdownCandidate({ lexicalPathInternal: file,
    containmentRootInternal: storeRoot });
  const cancellationRequested = () => Boolean(ledger.open().prepare(
    'SELECT cancel_requested FROM index_jobs WHERE job_id = ?').get(claim.jobId)?.cancel_requested);
  try {
    if (cancellationRequested()) {
      ledger.failClaimedJob({ claim, cancelled: true });
      return { completed: false, cancelled: true };
    }
    const first = await read();
    if (!first.ok) {
      ledger.failClaimedJob({ claim });
      return { completed: false, retryable: true };
    }
    if (first.contentHash !== claim.desiredContentHash) {
      const observed = ledger.observeClaimedFileMismatch({ claim, actualFileHash: first.contentHash,
        contentByteLength: first.contentByteLength, contentTextLength: first.contentTextLength });
      return { completed: false, stale: true, desiredRevision: observed?.desiredRevision };
    }
    const validated = { documentId: claim.documentId, revision: claim.requestedRevision,
      content: first.content, hash: first.contentHash, metadata: JSON.parse(target.metadataJson || '{}') };
    const downstream = await onValidated(validated);
    if (downstream?.cancelled) {
      ledger.failClaimedJob({ claim, cancelled: true });
      return { completed: false, cancelled: true };
    }
    return await withPublicationGate(ingressRoot, async () => {
      const latest = await read();
      if (!latest.ok) {
        ledger.failClaimedJob({ claim });
        return { completed: false, retryable: true };
      }
      if (latest.contentHash !== claim.desiredContentHash) {
        const observed = ledger.observeClaimedFileMismatch({ claim, actualFileHash: latest.contentHash,
          contentByteLength: latest.contentByteLength, contentTextLength: latest.contentTextLength });
        return { completed: false, stale: true, desiredRevision: observed?.desiredRevision };
      }
      if (cancellationRequested()) {
        ledger.failClaimedJob({ claim, cancelled: true });
        return { completed: false, cancelled: true };
      }
      if (afterFinalRead) await afterFinalRead();
      if (onFinalValidated) await onFinalValidated({ ...validated, content: latest.content,
        hash: latest.contentHash });
      return { completed: ledger.completeClaimedJob({ claim, actualFileHash: latest.contentHash }) };
    });
  } catch {
    ledger.failClaimedJob({ claim });
    return { completed: false, retryable: true };
  }
}

module.exports = { runClaimedDesiredJob };
