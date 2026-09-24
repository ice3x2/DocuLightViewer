'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLinkedImporter } = require('../../../src/main/linked-import');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');

async function scenario(context, files, options, verify) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s18-'));
  const sourceRoot = path.join(root, 'source');
  const storeRoot = path.join(root, 'store');
  const ingressRoot = path.join(root, 'private');
  for (const dir of [sourceRoot, storeRoot, ingressRoot]) fs.mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(sourceRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  const ledgerPath = path.join(root, 'ledger.sqlite');
  const owner = new OwnerWorkerController({ ledgerPath, keywordPath: path.join(root, 'keyword.sqlite'),
    sourceRoot: storeRoot, ingressRoot, keywordTokenizerProvider: 'basic', deriveDocuments: false });
  const ledger = new SourceLedgerStore({ dbPath: ledgerPath });
  try {
    await owner.start();
    if (options.beforeImport) await options.beforeImport({ sourceRoot, storeRoot, ingressRoot, owner });
    const limits = { ...options };
    delete limits.beforeImport;
    const importer = createLinkedImporter({ sourceRoot, knowledgeStoreRoot: storeRoot,
      ingressRoot, ledger, ownerController: owner, ...limits });
    const result = await importer.importMarkdownGraph(path.join(sourceRoot, 'A.md'));
    await verify({ context, result, importer, ledger, sourceRoot, storeRoot, ingressRoot, owner });
  } finally {
    await owner.shutdown();
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function rowCount(ledger, table) {
  return ledger.open().prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
}

// @req FR-DOC-033 DR-DOC-013 CON-DOC-006 SEC-DOC-003 REL-DOC-009
module.exports = { async run(context) {
  const A = '# A\n[B](./B.md)\n';
  const B = '# B\n[C](./C.md)\n';
  const C = '# C\n';
  await scenario(context, { 'A.md': A, 'B.md': B, 'C.md': C }, { maxDepth: 1 },
    ({ result, ledger, storeRoot }) => {
      context.assert(result.counts.imported === 2 && result.counts.skipped === 1
        && result.diagnostics.some(item => item.status === 'skipped' && item.diagnosticCode === 'skipped_depth')
        && rowCount(ledger, 'documents') === 2 && !fs.existsSync(path.join(storeRoot, 'C.md')),
      'depth one commits root and B, then diagnoses C without copy or row');
    });
  await scenario(context, { 'A.md': A, 'B.md': B }, { maxDepth: 0 },
    ({ result, ledger }) => context.assert(result.counts.imported === 1
      && result.diagnosticCounts.skipped_depth === 1 && rowCount(ledger, 'documents') === 1,
    'depth zero includes root only and counts one skipped child reason'));
  await scenario(context, { 'A.md': A, 'B.md': B, 'C.md': C }, { maxDepth: 2 },
    ({ result, ledger }) => context.assert(result.counts.imported === 3 && rowCount(ledger, 'documents') === 3,
      'depth exact boundary includes C'));
  await scenario(context, { 'A.md': A, 'B.md': B, 'C.md': C }, { maxFiles: 2 },
    ({ result, ledger, storeRoot }) => context.assert(result.counts.imported === 2
      && result.diagnostics.some(item => item.diagnosticCode === 'skipped_file_count')
      && rowCount(ledger, 'documents') === 2 && rowCount(ledger, 'index_jobs') === 2
      && !fs.existsSync(path.join(storeRoot, 'C.md')),
    'file limit counts committed root and B, not discovered C'));
  await scenario(context, { 'A.md': A, 'B.md': B, 'C.md': C }, { maxFiles: 3 },
    ({ result }) => context.assert(result.counts.imported === 3, 'file limit exact boundary includes C'));
  await scenario(context, { 'A.md': A, 'B.md': B, 'C.md': C },
    { maxTotalBytes: Buffer.byteLength(A) + Buffer.byteLength(B) },
    ({ result, ledger, storeRoot }) => context.assert(result.counts.imported === 2
      && result.diagnostics.some(item => item.diagnosticCode === 'skipped_total_bytes')
      && rowCount(ledger, 'documents') === 2 && !fs.existsSync(path.join(storeRoot, 'C.md')),
    'total bytes exact A+B boundary skips C'));
  await scenario(context, { 'A.md': A, 'B.md': B, 'C.md': C },
    { maxTotalBytes: Buffer.byteLength(A) + Buffer.byteLength(B) + Buffer.byteLength(C) },
    ({ result }) => context.assert(result.counts.imported === 3
      && !result.diagnosticCounts.skipped_total_bytes,
    'total bytes exact A+B+C boundary includes C'));
  await scenario(context, { 'A.md': A }, { maxTotalBytes: Buffer.byteLength(A) - 1 },
    ({ result, ledger, storeRoot }) => context.assert(result.counts.imported === 0
      && result.diagnostics.some(item => item.diagnosticCode === 'skipped_total_bytes')
      && rowCount(ledger, 'documents') === 0 && !fs.existsSync(path.join(storeRoot, 'A.md')),
    'oversized root creates no copy, document, or owner job'));
  const rejected = '# A\n[Rejected](./B.md)\n[Accepted](./C.md)\n';
  await scenario(context, { 'A.md': rejected, 'B.md': B, 'C.md': C },
    { maxFiles: 2, maxTotalBytes: Buffer.byteLength(rejected) + Math.max(Buffer.byteLength(B), Buffer.byteLength(C)),
      beforeImport: ({ storeRoot }) => fs.writeFileSync(path.join(storeRoot, 'B.md'), 'collision') },
    ({ result, ledger, storeRoot }) => context.assert(result.counts.imported === 2
      && result.counts.ambiguous === 1 && result.counts.skipped === 0
      && result.imported.map(item => item.sourceRelativePath).join(',') === 'A.md,C.md'
      && rowCount(ledger, 'documents') === 2 && rowCount(ledger, 'index_jobs') === 2
      && fs.readFileSync(path.join(storeRoot, 'B.md'), 'utf8') === 'collision',
    'rejected destination consumes neither committed file slot nor byte budget'));
  await scenario(context, { 'A.md': '# A\n[B](./B.md)\n[Self](./A.md)\n',
    'B.md': '# B\n[A](./A.md)\n' }, {}, ({ result, ledger }) => {
      context.assert(result.counts.imported === 2 && result.counts.skipped >= 1
        && result.diagnostics.some(item => item.diagnosticCode === 'skipped_cycle')
        && rowCount(ledger, 'documents') === 2,
      'cycle and self link terminate at two committed canonical documents');
    });
  await scenario(context, { 'A.md': '# A\n[Missing](./missing.md)\n[Remote](https://example.test/a.md?token=secret)\n'
    + '[Binary](./file.pdf)\n[Traversal](./../outside.md)\n[Encoded](./%2e%2e%2foutside.md)\n'
    + '[[Guide]]\n', 'one/Guide.md': '# One\n', 'two/Guide.md': '# Two\n' }, {},
  ({ result, ledger, sourceRoot, storeRoot }) => {
    const statuses = new Set(result.diagnostics.map(item => item.status));
    context.assert(result.counts.imported === 1 && result.counts.missing === 1
      && result.counts.external === 1 && result.counts.skipped === 1
      && result.counts.path_policy_violation === 2 && result.counts.ambiguous === 1
      && JSON.stringify(result.diagnostics.map(item => item.status)) === JSON.stringify([
        'missing', 'external', 'skipped', 'path_policy_violation', 'path_policy_violation', 'ambiguous'])
      && result.diagnosticCounts.non_markdown_target === 1
      && result.diagnosticCounts.target_missing === 1
      && [...statuses].every(status => ['resolved', 'missing', 'external', 'path_policy_violation',
        'skipped', 'ambiguous', 'stale'].includes(status))
      && rowCount(ledger, 'documents') === 1,
    'mixed broken links retain canonical statuses without candidate rows');
    context.assert(!JSON.stringify(result).includes('secret')
      && !JSON.stringify(result).includes(sourceRoot)
      && !JSON.stringify(result).includes(storeRoot),
    'public diagnostics redact raw href and absolute paths');
  });
  await scenario(context, { 'A.md': '# A\n' + Array.from({ length: 180 }, (_, i) =>
    `[Missing${i}](./missing${i}.md)`).join('\n') }, {}, ({ result, ledger }) => {
      context.assert(result.counts.missing === 180 && result.diagnostics.length <= 100
        && result.diagnosticCounts.target_missing === 180 && rowCount(ledger, 'documents') === 1,
      'diagnostics remain bounded while full status counts remain exact');
    });
  const cancelledBefore = new AbortController();
  cancelledBefore.abort();
  await scenario(context, { 'A.md': A, 'B.md': B }, { signal: cancelledBefore.signal },
    ({ result, ledger, storeRoot }) => context.assert(result.counts.imported === 0
      && result.diagnosticCounts.cancelled === 1 && rowCount(ledger, 'documents') === 0
      && rowCount(ledger, 'index_jobs') === 0 && !fs.existsSync(path.join(storeRoot, 'A.md')),
    'pre-cancel does not publish root or create owner rows'));
  const cancelledAfterB = new AbortController();
  await scenario(context, { 'A.md': A, 'B.md': B, 'C.md': C },
    { signal: cancelledAfterB.signal, beforeImport: ({ owner }) => {
      const accept = owner.acceptPublishedSave.bind(owner);
      owner.acceptPublishedSave = async input => {
        const reply = await accept(input);
        if (input.sourceRelativeLocator === 'B.md') cancelledAfterB.abort();
        return reply;
      };
    } },
    ({ result, ledger, storeRoot }) => context.assert(result.counts.imported === 2
      && result.diagnosticCounts.cancelled === 1 && rowCount(ledger, 'documents') === 2
      && rowCount(ledger, 'index_jobs') === 2 && !fs.existsSync(path.join(storeRoot, 'C.md')),
    'cancel after B owner ACK preserves A and B, leaving C untouched'));
  let lostAckCalls = 0;
  await scenario(context, { 'A.md': A, 'B.md': B, 'C.md': C },
    { beforeImport: ({ owner }) => {
      const accept = owner.acceptPublishedSave.bind(owner);
      owner.acceptPublishedSave = async input => {
        const reply = await accept(input);
        if (input.sourceRelativeLocator === 'C.md' && ++lostAckCalls === 1) throw new Error('ACK lost');
        return reply;
      };
    } },
    ({ result, ledger, ingressRoot }) => context.assert(lostAckCalls === 2
      && result.counts.imported === 3 && result.unconfirmedCount === 0
      && rowCount(ledger, 'documents') === 3 && rowCount(ledger, 'index_jobs') === 3
      && rowCount(ledger, 'save_intent_acceptances') === 3
      && fs.readdirSync(ingressRoot).filter(name => name.endsWith('.intent.json')).length === 0,
    'one lost ACK recovers exact owner receipt and counts C once without duplicate revision/job'));
  let persistentAckLossCalls = 0;
  await scenario(context, { 'A.md': A, 'B.md': B, 'C.md': C },
    { beforeImport: ({ owner }) => {
      const accept = owner.acceptPublishedSave.bind(owner);
      owner.acceptPublishedSave = async input => {
        const reply = await accept(input);
        if (input.sourceRelativeLocator === 'C.md') {
          persistentAckLossCalls += 1;
          throw new Error('ACK persistently lost');
        }
        return reply;
      };
    } },
    ({ result, ledger }) => context.assert(persistentAckLossCalls === 2
      && result.counts.imported === 2 && result.counts.stale === 0
      && result.unconfirmedCount === 1 && result.unconfirmed[0]?.diagnosticCode === 'ack_unknown'
      && result.unconfirmed[0]?.sourceRelativePath === 'C.md'
      && rowCount(ledger, 'documents') === 3 && rowCount(ledger, 'index_jobs') === 3
      && rowCount(ledger, 'save_intent_acceptances') === 3
      && ledger.open().prepare("SELECT desired_revision FROM documents WHERE path_key = 'c.md'").get().desired_revision === 1,
    'persistent lost ACK reports C as unconfirmed while retaining its single private receipt and revision'));
  let sourceEscapeAvailable = false;
  await scenario(context, { 'A.md': '# A\n[Escape](./Escape/outside.md)\n' },
    { beforeImport: ({ sourceRoot }) => {
      const outside = path.join(path.dirname(sourceRoot), 'outside-dir');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'outside.md'), '# Outside\n');
      try { fs.symlinkSync(outside, path.join(sourceRoot, 'Escape'), 'junction'); sourceEscapeAvailable = true; }
      catch (error) { if (error.code !== 'EPERM') throw error; }
    } },
    ({ result, ledger, storeRoot }) => {
      if (sourceEscapeAvailable) context.assert(result.counts.path_policy_violation >= 1
        && result.counts.imported === 1 && rowCount(ledger, 'documents') === 1
        && !fs.existsSync(path.join(storeRoot, 'Escape', 'outside.md')),
      'source symlink escape creates only a canonical path diagnostic');
    });
  let destinationEscapeAvailable = false;
  await scenario(context, { 'A.md': '# A\n[B](./dir/B.md)\n', 'dir/B.md': B },
    { beforeImport: ({ storeRoot }) => {
      const outside = path.join(path.dirname(storeRoot), 'outside-copy-dir');
      fs.mkdirSync(outside);
      try { fs.symlinkSync(outside, path.join(storeRoot, 'dir'), 'junction'); destinationEscapeAvailable = true; }
      catch (error) { if (error.code !== 'EPERM') throw error; }
    } },
    ({ result, ledger }) => {
      if (destinationEscapeAvailable) context.assert(result.counts.ambiguous === 1
        && result.diagnosticCounts.destination_realpath_outside_store === 1
        && rowCount(ledger, 'documents') === 1 && rowCount(ledger, 'index_jobs') === 1,
      'destination symlink escape is diagnosed before copy or owner commit');
    });
} };
