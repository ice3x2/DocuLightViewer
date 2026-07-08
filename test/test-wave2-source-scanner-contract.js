'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSourceLedgerStore } = require('../src/main/source-ledger-store');

function wave2Assert(condition, message) {
  assert(condition, `Wave 2 source scanner contract: ${message}`);
}

function tryRequire(relativePath) {
  try {
    return require(relativePath);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(relativePath.replace('../', ''))) {
      return null;
    }
    throw err;
  }
}

function getFactory(moduleExports) {
  if (!moduleExports) return null;
  if (typeof moduleExports.createDocumentScanner === 'function') return moduleExports.createDocumentScanner;
  if (typeof moduleExports.createSourceScanner === 'function') return moduleExports.createSourceScanner;
  if (typeof moduleExports.DocumentScanner === 'function') return (options) => new moduleExports.DocumentScanner(options);
  return null;
}

async function removeTreeWithRetry(targetPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err && err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

(async () => {
  const scannerModule = tryRequire('../src/main/document-scanner');
  const createDocumentScanner = getFactory(scannerModule);
  wave2Assert(typeof createDocumentScanner === 'function', 'document-scanner module exports a scanner factory');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-wave2-scanner-'));
  let ledger = null;
  try {
    const sourceRoot = path.join(root, 'source root');
    const indexDataDir = path.join(sourceRoot, '.doculight-index');
    const ledgerRoot = path.join(root, 'userData', 'index');
    const outsideRoot = path.join(root, 'outside');

    fs.mkdirSync(path.join(sourceRoot, 'docs', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, 'docs', 'excluded'), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, 'beta'), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, '.git'), { recursive: true });
    fs.mkdirSync(indexDataDir, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });

    fs.writeFileSync(path.join(sourceRoot, 'docs', 'A.md'), '# A\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'docs', 'nested', 'B.markdown'), '# B\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'docs', '한 글.md'), '# Korean Space\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'docs', 'excluded', 'Skip.md'), '# Skip\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'alpha', 'Dupe.md'), '# Dupe A\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'beta', 'dupe.md'), '# Dupe B\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'node_modules', 'pkg', 'Ignored.md'), '# Ignored\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, '.git', 'Ignored.md'), '# Ignored\n', 'utf-8');
    fs.writeFileSync(path.join(indexDataDir, 'Ignored.md'), '# Ignored\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, '.temp.md'), '# Hidden temp\n', 'utf-8');
    fs.writeFileSync(path.join(outsideRoot, 'Escape.md'), '# Escape\n', 'utf-8');

    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideRoot, path.join(sourceRoot, 'linked-out'), 'junction');
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }

    ledger = createSourceLedgerStore({
      dbPath: path.join(ledgerRoot, 'smart-search.sqlite3'),
      userDataDir: path.join(root, 'userData')
    });
    ledger.initialize();
    ledger.recordSource({
      rootPathInternal: sourceRoot,
      displayName: 'Old Source',
      rootFingerprint: 'old-fingerprint',
      includeGlobs: ['**/*.md'],
      excludeGlobs: []
    });

    const scanner = createDocumentScanner({
      sourceRoot,
      displayName: 'Scanner Fixture',
      includeGlobs: ['**/*.md', '**/*.markdown'],
      excludeGlobs: ['docs/excluded/**'],
      indexDataDir,
      ledger
    });
    const result = await scanner.scan();

    wave2Assert(result.source.sourceId, 'scanner records sourceId');
    wave2Assert(result.source.rootFingerprint && result.source.rootFingerprint !== 'old-fingerprint', 'scanner records current root fingerprint');
    wave2Assert(result.source.includeGlobs.includes('**/*.md'), 'scanner source record preserves include globs');
    wave2Assert(result.source.excludeGlobs.includes('docs/excluded/**'), 'scanner source record preserves exclude globs');
    wave2Assert(result.source.enabled === true, 'scanner source record preserves enabled flag');

    const relativePaths = result.documents.map((item) => item.sourceRelativePath);
    const sortedPaths = relativePaths.slice().sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    wave2Assert(JSON.stringify(relativePaths) === JSON.stringify(sortedPaths), 'scanner output is deterministic');
    wave2Assert(relativePaths.includes('docs/A.md'), 'scanner includes nested Markdown documents');
    wave2Assert(relativePaths.includes('docs/nested/B.markdown'), 'scanner includes .markdown documents');
    wave2Assert(relativePaths.includes('docs/한 글.md'), 'scanner includes Korean and space paths');
    wave2Assert(!relativePaths.includes('docs/excluded/Skip.md'), 'scanner applies explicit exclude globs');
    wave2Assert(!relativePaths.some((item) => item.includes('node_modules')), 'scanner excludes node_modules by default');
    wave2Assert(!relativePaths.some((item) => item.includes('.git')), 'scanner excludes .git by default');
    wave2Assert(!relativePaths.some((item) => item.includes('.doculight-index')), 'scanner excludes app index data directory by default');
    wave2Assert(!relativePaths.includes('.temp.md'), 'scanner excludes hidden temporary files by default');
    wave2Assert(result.diagnostics.some((item) => item.diagnosticCode === 'root_fingerprint_changed' && item.rebuildRecommended), 'scanner reports root fingerprint change with settings-side rebuild recommendation');
    wave2Assert(result.diagnostics.some((item) => item.diagnosticCode === 'duplicate_basename'), 'scanner records duplicate basename diagnostics');
    if (symlinkCreated) {
      wave2Assert(result.diagnostics.some((item) => item.status === 'path_policy_violation' && item.diagnosticCode === 'realpath_outside_source_root'), 'scanner records symlink/junction escape diagnostics');
    }
    wave2Assert(!JSON.stringify(result).includes(sourceRoot), 'scanner result redacts raw source root path');
    wave2Assert(!JSON.stringify(result).includes(ledgerRoot), 'scanner result redacts app index/userData path');
  } finally {
    if (ledger) ledger.close();
    await removeTreeWithRetry(root);
  }

  console.log('test-wave2-source-scanner-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
