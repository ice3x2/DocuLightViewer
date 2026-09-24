'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SourceLedgerStore } = require('../../../src/main/source-ledger-store');
const { IndexedDocumentOpenError, resolveIndexedMarkdownOpen } = require('../../../src/main/indexed-origin-resolver');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileInventory(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full);
      if (entry.isSymbolicLink()) entries.push([relative, 'link', fs.readlinkSync(full)]);
      else if (entry.isDirectory()) visit(full);
      else entries.push([relative, hash(fs.readFileSync(full))]);
    }
  }
  visit(root);
  return JSON.stringify(entries.sort((left, right) => left[0].localeCompare(right[0])));
}

module.exports = {
  name: 's05',
  async run(context) {
    const root = context.fixture.root;
    const storeRoot = path.join(root, 'store');
    const originalRoot = path.join(root, 'original');
    const alternateRoot = path.join(root, 'alternate');
    fs.mkdirSync(storeRoot);
    fs.mkdirSync(originalRoot);
    fs.mkdirSync(alternateRoot);
    const original = path.join(originalRoot, 'source.md');
    const alternate = path.join(alternateRoot, 'source.md');
    const copy = path.join(storeRoot, 'copy.md');
    const content = '# original\n';
    fs.writeFileSync(original, content);
    fs.writeFileSync(alternate, '# replaced\n');
    fs.writeFileSync(copy, '# indexed copy\n');
    const aliases = ['alias-a', 'alias-b'].map(name => {
      const directory = path.join(root, name);
      fs.symlinkSync(originalRoot, directory, process.platform === 'win32' ? 'junction' : 'dir');
      return path.join(directory, 'source.md');
    });
    const ledger = new SourceLedgerStore({ dbPath: path.join(root, 'ledger.sqlite'), userDataDir: root });
    try {
      ledger.initialize();
      const source = ledger.recordSource({ rootPathInternal: storeRoot, rootFingerprint: 's05-root' });
      const document = ledger.upsertDocument({ sourceId: source.sourceId, sourceRelativePath: 'copy.md', canonicalPathInternal: copy,
        contentHash: `sha256:${hash(content)}` });
      const canonical = fs.realpathSync.native(original);
      const fingerprint = { contentHash: `sha256:${hash(content)}`, contentByteLength: Buffer.byteLength(content), contentTextLength: content.length };
      for (const lexical of aliases) {
        ledger.upsertDocumentSourceAlias({ documentId: document.documentId, aliasKind: 'opened_path', originLexicalPathInternal: lexical,
          originPathInternal: canonical, ...fingerprint });
      }
      const rows = ledger.open().prepare('SELECT * FROM document_source_aliases WHERE document_id = ?').all(document.documentId);
      context.assert(rows.length === 2, 'fixture has two lexical aliases for one document');
      const current = ledger.getIndexedDocumentOpenTargetInternal({ documentId: document.documentId });
      const first = current.originCandidates[0].originLexicalPathInternal;
      const badDirectory = path.dirname(first);
      fs.unlinkSync(badDirectory);
      fs.symlinkSync(alternateRoot, badDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      const ledgerRows = () => JSON.stringify({
        documents: ledger.open().prepare('SELECT * FROM documents ORDER BY document_id').all(),
        aliases: ledger.open().prepare('SELECT * FROM document_source_aliases ORDER BY alias_id').all(),
        jobs: ledger.open().prepare('SELECT * FROM index_jobs ORDER BY job_id').all()
      });
      async function readOnlyOpen(input) {
        const dbRowsBefore = ledgerRows();
        const filesBefore = fileInventory(root);
        let result;
        try { result = await resolveIndexedMarkdownOpen({ ...input, searchEngine: { getSourceLedger: () => ledger } }); }
        catch (error) { result = error; }
        context.assert(fileInventory(root) === filesBefore, 'lookup and open leave database bytes and filesystem files unchanged');
        context.assert(ledgerRows() === dbRowsBefore, 'lookup and open leave document, alias, and job rows unchanged');
        return result;
      }
      const result = await readOnlyOpen({ documentId: document.documentId });
      context.assert(result.sourceUsed === 'origin' && result.originStatus === 'readable' && result.content === content,
        'a valid second lexical alias wins after the first alias retargets');
      context.assert(!JSON.stringify({ sourceUsed: result.sourceUsed, originStatus: result.originStatus, documentId: result.documentId }).includes(root),
        'public resolver fields contain no raw original path');
      fs.writeFileSync(original, '# changed\n');
      const changed = await readOnlyOpen({ filePath: copy });
      context.assert(changed.sourceUsed === 'origin' && changed.originStatus === 'readable_changed' && changed.content === '# changed\n',
        'indexed path uses the valid alias and reports changed content without updating the copy');
      fs.unlinkSync(badDirectory);
      fs.symlinkSync(originalRoot, badDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      fs.writeFileSync(original, Buffer.alloc(10 * 1024 * 1024 + 1, 65));
      const oversized = await readOnlyOpen({ documentId: document.documentId });
      context.assert(oversized.sourceUsed === 'indexed_copy' && oversized.originStatus === 'read_failed' && oversized.content === '# indexed copy\n',
        'oversized original is bounded and falls back to the indexed copy');
      fs.writeFileSync(original, content);
      const deniedFs = {
        ...fs.promises,
        async open(candidate, ...args) {
          if (path.resolve(candidate) === path.resolve(canonical)) {
            const error = new Error('private original path');
            error.code = 'EACCES';
            throw error;
          }
          return fs.promises.open(candidate, ...args);
        }
      };
      const denied = await readOnlyOpen({ documentId: document.documentId, fsPromises: deniedFs });
      context.assert(denied.sourceUsed === 'indexed_copy' && denied.originStatus === 'unreadable',
        'permission-denied aliases fall back without exposing raw filesystem errors');
      fs.rmSync(original);
      const missing = await readOnlyOpen({ documentId: document.documentId });
      context.assert(missing.sourceUsed === 'indexed_copy' && missing.originStatus === 'missing',
        'missing original uses the indexed copy with a stable status');
      fs.rmSync(copy);
      const unavailable = await readOnlyOpen({ documentId: document.documentId });
      context.assert(unavailable instanceof IndexedDocumentOpenError && unavailable.code === 'indexed_document_unavailable' && !unavailable.message.includes(root),
        'invalid aliases and missing copy return only the stable redacted error');
      const legacyCopy = path.join(storeRoot, 'legacy.md');
      fs.writeFileSync(legacyCopy, '# legacy\n');
      const legacyDocument = ledger.upsertDocument({ sourceId: source.sourceId, sourceRelativePath: 'legacy.md', contentHash: 'legacy-hash' });
      ledger.upsertDocumentSourceAlias({ documentId: legacyDocument.documentId, aliasKind: 'opened_path', canonicalPathHash: hash('legacy-only') });
      const legacy = await readOnlyOpen({ documentId: legacyDocument.documentId });
      context.assert(legacy.sourceUsed === 'indexed_copy' && legacy.originStatus === 'not_recorded' && legacy.content === '# legacy\n',
        'hash-only legacy alias never invents an original path');
    } finally {
      ledger.close();
      for (const lexical of aliases) fs.unlinkSync(path.dirname(lexical));
    }
  }
};
