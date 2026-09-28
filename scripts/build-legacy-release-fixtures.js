'use strict';
// @req DR-DOC-014 FR-DOC-019 FR-DOC-036 OPS-ARCH-009
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const fixtures = path.join(root, 'test', 'fixtures');
const manifestPath = path.join(fixtures, 'legacy-release-manifest.json');
const tags = ['v1.0.0', 'v1.0.2', 'v1.0.3', 'v1.0.4', 'v1.0.5'];
const fixedTime = '2026-01-01T00:00:00.000Z';
const markdown = '# Release fixture\n\nSynthetic origin text.\n';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const runtimeRoot = process.env.DOCULIGHT_FIXTURE_NODE_ROOT || root;
const Database = require(require.resolve('better-sqlite3', { paths: [runtimeRoot] }));

function createRelease(tag, tempRoot) {
  const commitSha = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  assert.match(commitSha, /^[a-f0-9]{40}$/, `missing public tag ${tag}`);
  const moduleDir = path.join(tempRoot, tag, 'modules');
  fs.mkdirSync(moduleDir, { recursive: true });
  const inputs = ['src/main/source-ledger-store.js', 'src/main/redaction.js', 'src/main/search-sqlite-store.js', 'src/main/search-tokenizer.js', 'src/main/tokenizer.js'].map((sourcePath) => {
    const bytes = execFileSync('git', ['show', `${commitSha}:${sourcePath}`], { cwd: root, windowsHide: true });
    fs.writeFileSync(path.join(moduleDir, path.basename(sourcePath)), bytes);
    return { path: sourcePath, sha256: sha256(bytes) };
  });
  const { SourceLedgerStore } = require(path.join(moduleDir, 'source-ledger-store.js'));
  const releaseDir = path.join(tempRoot, tag, 'output');
  fs.mkdirSync(releaseDir, { recursive: true });
  const sqlitePath = path.join(releaseDir, 'source-ledger.sqlite');
  const ledger = new SourceLedgerStore({ dbPath: sqlitePath, loadDatabase: () => Database, now: () => fixedTime });
  const contentHash = `sha256:${sha256(Buffer.from(markdown))}`;
  const originPath = path.win32.join('C:\\DocuLightFixture', tag, 'origin', 'release.md');
  const alternateOriginPath = path.win32.join('C:\\DocuLightFixture', tag, 'origin', 'alternate.md');
  const copyPath = path.win32.join('C:\\DocuLightFixture', tag, 'store', 'release.md');
  try {
    ledger.initialize();
    const source = ledger.recordSource({ sourceId: `src_${tag.replaceAll('.', '_')}`, rootPathInternal: path.win32.dirname(copyPath), displayName: 'Synthetic release store' });
    const document = ledger.upsertDocument({ documentId: `doc_${tag.replaceAll('.', '_')}`, sourceId: source.sourceId, sourceRelativePath: 'release.md', contentHash, contentByteLength: Buffer.byteLength(markdown), contentTextLength: markdown.length, project: 'release-fixture', category: 'reference', documentTags: ['synthetic'], classification: { assignedBy: 'explicit' } });
    const originFields = tag === 'v1.0.5' ? (origin) => ({ originLexicalPathInternal: origin, originPathInternal: origin }) : () => ({});
    ledger.upsertDocumentSourceAlias({ documentId: document.documentId, aliasKind: 'opened_path', canonicalPathHash: sha256(originPath.toLowerCase()), ...originFields(originPath), contentHash, contentByteLength: Buffer.byteLength(markdown), contentTextLength: markdown.length });
    ledger.upsertDocumentSourceAlias({ documentId: document.documentId, aliasKind: 'opened_path', canonicalPathHash: sha256(alternateOriginPath.toLowerCase()), ...originFields(alternateOriginPath), contentHash, contentByteLength: Buffer.byteLength(markdown), contentTextLength: markdown.length });
    ledger.enqueueIndexJob({ jobId: `job_${tag.replaceAll('.', '_')}_completed`, sourceId: source.sourceId, documentId: document.documentId, currentPathInternal: copyPath, contentHash, status: 'completed' });
    ledger.enqueueIndexJob({ jobId: `job_${tag.replaceAll('.', '_')}_queued`, sourceId: source.sourceId, documentId: document.documentId, currentPathInternal: copyPath, contentHash, status: 'queued' });
    ledger.recordLinkEdge({ fromDocumentId: document.documentId, status: 'missing', diagnosticCode: 'missing_target', originalHref: './missing.md', normalizedHref: 'missing.md', ordinal: 0 });
  } finally { ledger.close(); }
  const { SQLiteKeywordIndex } = require(path.join(moduleDir, 'search-sqlite-store.js'));
  const keyword = new SQLiteKeywordIndex({ dbPath: path.join(releaseDir, 'search-index.sqlite3'), sourceRoot: path.win32.dirname(copyPath), loadDatabase: () => Database });
  const OriginalDate = global.Date;
  const originalRandomUUID = crypto.randomUUID;
  const originalRandomBytes = crypto.randomBytes;
  try {
    global.Date = class FixedDate extends OriginalDate { constructor(...args) { super(...(args.length ? args : [fixedTime])); } static now() { return OriginalDate.parse(fixedTime); } };
    crypto.randomUUID = () => '00000000-0000-4000-8000-000000000000';
    crypto.randomBytes = (size) => Buffer.alloc(size, 0);
    keyword.rebuild([{ filePath: copyPath, meta: { title: 'Release fixture', project: 'release-fixture', category: 'reference', documentTags: ['synthetic'] }, body: markdown, contentHash }], { skipBackup: true });
  } finally {
    keyword.close();
    global.Date = OriginalDate;
    crypto.randomUUID = originalRandomUUID;
    crypto.randomBytes = originalRandomBytes;
  }
  fs.writeFileSync(path.join(releaseDir, 'release.md'), markdown);
  const outputs = ['source-ledger.sqlite', 'search-index.sqlite3', 'release.md'].map((name) => {
    const bytes = fs.readFileSync(path.join(releaseDir, name));
    return { path: `legacy-release/${tag}/${name}`, sha256: sha256(bytes), size: bytes.length };
  });
  return { tag, commitSha, inputs, syntheticInputSha256: sha256(Buffer.from(markdown)), generator: 'node scripts/build-legacy-release-fixtures.js', generatorVersion: 1, schemaVersion: 1, sanitization: 'synthetic fixed paths and content; no private input', supportedScope: ['documents', tag === 'v1.0.5' ? 'origin-path source aliases' : 'hash-only source aliases', 'index jobs', 'link edges', 'keyword derived cache'], outputs };
}

function build(tempRoot) {
  const releases = tags.map((tag) => createRelease(tag, tempRoot));
  const manifest = { formatVersion: 1, releases };
  return { manifest, bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
}

function main() {
  const verify = process.argv.includes('--verify-reproducible');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-release-fixtures-'));
  try {
    const built = build(tempRoot);
    if (verify) {
      assert.deepEqual(fs.readFileSync(manifestPath), built.bytes, 'fixture provenance assertion: manifest reproducibility');
      for (const release of built.manifest.releases) {
        for (const output of release.outputs) {
          assert.deepEqual(fs.readFileSync(path.join(fixtures, output.path)), fs.readFileSync(path.join(tempRoot, release.tag, 'output', path.basename(output.path))), `fixture provenance assertion: output reproducibility ${output.path}`);
        }
      }
      console.log('legacy release fixtures reproducible');
      return;
    }
    for (const release of built.manifest.releases) {
      for (const output of release.outputs) {
        const destination = path.join(fixtures, output.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(tempRoot, release.tag, 'output', path.basename(output.path)), destination);
      }
    }
    fs.writeFileSync(manifestPath, built.bytes);
    console.log('legacy release fixtures generated');
  } finally {
    const safeBase = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(tempRoot).startsWith(safeBase) && path.basename(tempRoot).startsWith('doculight-release-fixtures-'));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) main();
