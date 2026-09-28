'use strict';
// @req DR-DOC-014 FR-DOC-019 FR-DOC-036 OPS-ARCH-009
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'legacy-release');
const manifestPath = path.join(__dirname, 'fixtures', 'legacy-release-manifest.json');
const tags = ['v1.0.0', 'v1.0.2', 'v1.0.3', 'v1.0.4', 'v1.0.5'];
const inputPaths = ['src/main/source-ledger-store.js', 'src/main/redaction.js', 'src/main/search-sqlite-store.js', 'src/main/search-tokenizer.js', 'src/main/tokenizer.js'];
const outputNames = ['source-ledger.sqlite', 'search-index.sqlite3', 'release.md'];
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function verifyProvenance(manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')), fixtureDir = path.join(__dirname, 'fixtures')) {
  assert.equal(manifest.formatVersion, 1, 'fixture provenance assertion: format version');
  assert.deepEqual(manifest.releases.map((release) => release.tag), tags, 'fixture provenance assertion: tag set');
  for (const release of manifest.releases) {
    const peeled = execFileSync('git', ['rev-parse', `refs/tags/${release.tag}^{commit}`], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(release.commitSha, peeled, `fixture provenance assertion: tag SHA ${release.tag}`);
    assert.equal(release.schemaVersion, 1, `fixture provenance assertion: schema ${release.tag}`);
    assert.match(release.syntheticInputSha256, /^[a-f0-9]{64}$/, `fixture provenance assertion: input checksum ${release.tag}`);
    assert.equal(release.generator, 'node scripts/build-legacy-release-fixtures.js', `fixture provenance assertion: generator ${release.tag}`);
    assert.equal(release.generatorVersion, 1, `fixture provenance assertion: generator version ${release.tag}`);
    assert.equal(release.sanitization, 'synthetic fixed paths and content; no private input', `fixture provenance assertion: sanitization ${release.tag}`);
    assert.deepEqual(release.inputs.map((input) => input.path), inputPaths, `fixture provenance assertion: input set ${release.tag}`);
    assert.deepEqual(release.outputs.map((output) => output.path), outputNames.map((name) => `legacy-release/${release.tag}/${name}`), `fixture provenance assertion: output set ${release.tag}`);
    for (const input of release.inputs) {
      assert.match(input.path, /^src\/main\/[a-z-]+\.js$/, `fixture provenance assertion: input path ${release.tag}`);
      assert.match(input.sha256, /^[a-f0-9]{64}$/, `fixture provenance assertion: source checksum ${release.tag}`);
      const source = execFileSync('git', ['show', `${peeled}:${input.path}`], { cwd: root, windowsHide: true });
      assert.equal(input.sha256, digest(source), `fixture provenance assertion: source drift ${release.tag}`);
    }
    for (const output of release.outputs) {
      assert.match(output.path, /^legacy-release\/v1\.0\.[0-5]\/[-a-z0-9.]+$/, `fixture provenance assertion: output path ${release.tag}`);
      assert.match(output.sha256, /^[a-f0-9]{64}$/, `fixture provenance assertion: missing checksum ${release.tag}`);
      assert.ok(Number.isSafeInteger(output.size) && output.size > 0, `fixture provenance assertion: size ${release.tag}`);
      const bytes = fs.readFileSync(path.join(fixtureDir, output.path));
      assert.equal(bytes.length, output.size, `fixture provenance assertion: output size drift ${release.tag}`);
      assert.equal(digest(bytes), output.sha256, `fixture provenance assertion: output checksum drift ${release.tag}`);
      assert.doesNotMatch(bytes.toString('utf8'), /C:\\Users\\|\/home\/[^/]+\/|\/Users\/[^/]+\/|gh[pousr]_[A-Za-z0-9]+|https?:\/\/[^\s]*@/, `fixture provenance assertion: private input ${release.tag}`);
      if (output.path.endsWith('/release.md')) assert.equal(release.syntheticInputSha256, digest(bytes), `fixture provenance assertion: synthetic input drift ${release.tag}`);
    }
  }
  return manifest;
}

function verifyMutations(manifest) {
  const altered = (change) => {
    const copy = structuredClone(manifest);
    change(copy.releases[0]);
    return copy;
  };
  assert.throws(() => verifyProvenance(altered((release) => { release.commitSha = '0'.repeat(40); })), /fixture provenance assertion: tag SHA/);
  assert.throws(() => verifyProvenance(altered((release) => { delete release.outputs[0].sha256; })), /fixture provenance assertion: missing checksum/);
  assert.throws(() => verifyProvenance(altered((release) => { delete release.sanitization; })), /fixture provenance assertion: sanitization/);
  assert.throws(() => verifyProvenance(altered((release) => { release.inputs.pop(); })), /fixture provenance assertion: input set/, 'T-PH008-07 removed source input must fail');
  assert.throws(() => verifyProvenance(altered((release) => { release.outputs.pop(); })), /fixture provenance assertion: output set/, 'T-PH008-07 removed fixture output must fail');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-provenance-mutation-'));
  try {
    const tag = manifest.releases[0].tag;
    const relative = `legacy-release/${tag}/release.md`;
    const target = path.join(temp, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', relative), target);
    const originalBytes = fs.readFileSync(target);
    const changedBytes = Buffer.from(originalBytes);
    changedBytes[0] ^= 1;
    fs.writeFileSync(target, changedBytes);
    // Keep all tag metadata valid while directing only this output to the changed temp copy.
    const release = manifest.releases[0];
    const modified = structuredClone(manifest);
    modified.releases[0].outputs = release.outputs.map((output) => ({ ...output }));
    for (const other of release.outputs) if (other.path !== relative) {
      const otherTarget = path.join(temp, other.path);
      fs.copyFileSync(path.join(__dirname, 'fixtures', other.path), otherTarget);
    }
    for (const later of manifest.releases.slice(1)) {
      for (const output of later.outputs) {
        const laterTarget = path.join(temp, output.path);
        fs.mkdirSync(path.dirname(laterTarget), { recursive: true });
        fs.copyFileSync(path.join(__dirname, 'fixtures', output.path), laterTarget);
      }
    }
    assert.throws(() => verifyProvenance(modified, temp), /fixture provenance assertion: output checksum drift/);
    const bytes = Buffer.concat([originalBytes, Buffer.from('C:\\Users\\private\\token')]);
    fs.writeFileSync(target, bytes);
    const markdownOutput = modified.releases[0].outputs.find((output) => output.path === relative);
    markdownOutput.sha256 = digest(bytes);
    markdownOutput.size = bytes.length;
    modified.releases[0].syntheticInputSha256 = digest(bytes);
    assert.throws(() => verifyProvenance(modified, temp), /fixture provenance assertion: private input/);
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(temp).startsWith('doculight-provenance-mutation-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function verifyForwardOpen(manifest) {
  const Database = require(require.resolve('better-sqlite3', { paths: [process.env.DOCULIGHT_FIXTURE_NODE_ROOT || root] }));
  const { SourceLedgerStore } = require('../src/main/source-ledger-store');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-forward-open-'));
  const snapshot = (db) => ({
    documents: db.prepare('SELECT document_id, content_hash, category, document_tags_json, path_history_json, first_seen_at FROM documents ORDER BY document_id').all(),
    aliases: db.prepare('SELECT alias_id, document_id, canonical_path_hash, content_hash FROM document_source_aliases ORDER BY alias_id').all(),
    jobs: db.prepare('SELECT job_id, document_id, status, content_hash FROM index_jobs ORDER BY job_id').all(),
    edges: db.prepare('SELECT edge_id, from_document_id, status, diagnostic_code FROM links ORDER BY edge_id').all()
  });
  try {
    for (const release of manifest.releases) {
      const dbPath = path.join(temp, `${release.tag}.sqlite`);
      fs.copyFileSync(path.join(fixtureRoot, release.tag, 'source-ledger.sqlite'), dbPath);
      const beforeDb = new Database(dbPath, { readonly: true });
      const before = snapshot(beforeDb);
      const originBefore = release.tag === 'v1.0.5' ? beforeDb.prepare('SELECT canonical_path_hash, origin_lexical_path_internal, origin_path_internal FROM document_source_aliases ORDER BY alias_id').all() : null;
      beforeDb.close();
      const expectedAliasHashes = ['alternate.md', 'release.md'].map((name) => digest(path.win32.join('C:\\DocuLightFixture', release.tag, 'origin', name).toLowerCase())).sort();
      assert.deepEqual(before.aliases.map((alias) => alias.canonical_path_hash).sort(), expectedAliasHashes, `T-PH008-07 ${release.tag} distinct canonical alias hashes`);
      if (originBefore) {
        assert.equal(originBefore.length, 2, 'T-PH008-07 v1.0.5 origin alias count');
        assert.ok(originBefore.every((alias) => alias.origin_lexical_path_internal && alias.origin_path_internal), 'T-PH008-07 v1.0.5 tagged origin paths required');
        const expectedOrigins = ['alternate.md', 'release.md'].map((name) => path.win32.join('C:\\DocuLightFixture', release.tag, 'origin', name));
        assert.deepEqual(originBefore.map((alias) => alias.origin_lexical_path_internal).sort(), expectedOrigins.sort(), 'T-PH008-07 v1.0.5 fixed synthetic origins');
        assert.ok(originBefore.every((alias) => alias.origin_path_internal === alias.origin_lexical_path_internal && alias.canonical_path_hash === digest(alias.origin_path_internal.toLowerCase())), 'T-PH008-07 v1.0.5 canonical origin hashes');
      }
      assert.equal(before.aliases.length, 2, `T-PH008-07 alias relationship ${release.tag}`);
      assert.deepEqual(before.jobs.map((job) => job.status).sort(), ['completed', 'queued'], `T-PH008-07 job history ${release.tag}`);
      const ledger = new SourceLedgerStore({ dbPath, loadDatabase: () => Database });
      ledger.initialize();
      ledger.close();
      const afterDb = new Database(dbPath, { readonly: true });
      const after = snapshot(afterDb);
      if (originBefore) assert.deepEqual(afterDb.prepare('SELECT canonical_path_hash, origin_lexical_path_internal, origin_path_internal FROM document_source_aliases ORDER BY alias_id').all(), originBefore, 'T-PH008-07 v1.0.5 origin preservation');
      afterDb.close();
      assert.deepEqual(after, before, `T-PH008-07 forward-open preservation ${release.tag}`);
    }
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(temp).startsWith('doculight-forward-open-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function verifyOpenSelection() {
  const Database = require(require.resolve('better-sqlite3', { paths: [process.env.DOCULIGHT_FIXTURE_NODE_ROOT || root] }));
  const { SourceLedgerStore } = require('../src/main/source-ledger-store');
  const { resolveIndexedMarkdownOpen } = require('../src/main/indexed-origin-resolver');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-release-open-'));
  try {
    for (const tag of ['v1.0.0', 'v1.0.5']) {
      const caseRoot = path.join(temp, tag);
      const storeRoot = path.join(caseRoot, 'store');
      const originRoot = path.join(caseRoot, 'origin');
      fs.mkdirSync(storeRoot, { recursive: true });
      fs.mkdirSync(originRoot, { recursive: true });
      const content = fs.readFileSync(path.join(fixtureRoot, tag, 'release.md'));
      fs.writeFileSync(path.join(storeRoot, 'release.md'), content);
      const validOrigin = path.join(originRoot, 'release.md');
      if (tag === 'v1.0.5') fs.writeFileSync(validOrigin, content);
      const dbPath = path.join(caseRoot, 'source-ledger.sqlite');
      fs.copyFileSync(path.join(fixtureRoot, tag, 'source-ledger.sqlite'), dbPath);
      const ledger = new SourceLedgerStore({ dbPath, loadDatabase: () => Database });
      try {
        const db = ledger.open();
        // Rebase only the copied fixture's synthetic locations onto real temp files.
        db.prepare('UPDATE sources SET root_path_internal = ?').run(storeRoot);
        if (tag === 'v1.0.5') {
          const aliases = db.prepare('SELECT alias_id FROM document_source_aliases ORDER BY alias_id').all();
          for (const [index, alias] of aliases.entries()) {
            const candidate = index === 0 ? path.join(originRoot, 'missing.md') : validOrigin;
            db.prepare('UPDATE document_source_aliases SET origin_lexical_path_internal = ?, origin_path_internal = ?, canonical_path_hash = ? WHERE alias_id = ?')
              .run(candidate, candidate, digest(candidate.toLowerCase()), alias.alias_id);
          }
        }
        const result = await resolveIndexedMarkdownOpen({ documentId: `doc_${tag.replaceAll('.', '_')}`, searchEngine: { getSourceLedger: () => ledger } });
        assert.equal(result.documentId, `doc_${tag.replaceAll('.', '_')}`, `T-PH008-07 ${tag} stable document identity`);
        assert.equal(result.sourceUsed, tag === 'v1.0.5' ? 'origin' : 'indexed_copy', `T-PH008-07 ${tag} forward-open source selection`);
        assert.equal(result.originStatus, tag === 'v1.0.5' ? 'readable' : 'not_recorded', `T-PH008-07 ${tag} forward-open origin status`);
        assert.equal(result.content, content.toString('utf8'), `T-PH008-07 ${tag} forward-open content`);
      } finally { ledger.close(); }
    }
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(temp).startsWith('doculight-release-open-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  (async () => {
    const manifest = verifyProvenance();
    verifyMutations(manifest);
    verifyForwardOpen(manifest);
    await verifyOpenSelection();
    console.log('legacy release fixture provenance and forward-open preservation passed');
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { verifyProvenance, verifyMutations, verifyForwardOpen, verifyOpenSelection };
