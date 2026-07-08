'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSourceLedgerStore } = require('../src/main/source-ledger-store');

function wave2Assert(condition, message) {
  assert(condition, `Wave 2 linked import contract: ${message}`);
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

function getFactory(moduleExports, factoryNames, classNames) {
  if (!moduleExports) return null;
  for (const name of factoryNames) {
    if (typeof moduleExports[name] === 'function') return moduleExports[name];
  }
  for (const name of classNames) {
    if (typeof moduleExports[name] === 'function') return (options) => new moduleExports[name](options);
  }
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
  const linkedImportModule = tryRequire('../src/main/linked-import');
  const legacyAdoptionModule = tryRequire('../src/main/legacy-adoption');
  const createLinkedImporter = getFactory(
    linkedImportModule,
    ['createLinkedImporter', 'createLinkedImportService'],
    ['LinkedImporter']
  );
  const createLegacyAdopter = getFactory(
    legacyAdoptionModule,
    ['createLegacyAdopter', 'createLegacyAdoptionService'],
    ['LegacyAdopter']
  );

  wave2Assert(typeof createLinkedImporter === 'function', 'linked-import module exports a linked import service factory');
  wave2Assert(typeof createLegacyAdopter === 'function', 'legacy-adoption module exports a legacy adoption service factory');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf-8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf-8');
  const settingsHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.html'), 'utf-8');
  const settingsJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.js'), 'utf-8');
  const mcpServerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'mcp-server.mjs'), 'utf-8');
  wave2Assert(mainSource.includes("ipcMain.handle('document-import:linked-markdown'"), 'Settings IPC exposes explicit linked Markdown import action');
  wave2Assert(preloadSource.includes('importLinkedMarkdown'), 'preload exposes linked import only to renderer Settings UI');
  wave2Assert(settingsHtml.includes('linked-import-btn') && settingsJs.includes('importLinkedMarkdown'), 'Settings UI has explicit linked import button and handler');
  wave2Assert(!mcpServerSource.includes('linked-import') && !mcpServerSource.includes('recursiveImport'), 'MCP server does not expose linked import or recursive import controls');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-wave2-import-'));
  let ledger = null;
  try {
    const sourceRoot = path.join(root, 'source');
    const storeRoot = path.join(root, 'store');
    const ledgerRoot = path.join(root, 'userData', 'index');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(storeRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'A.md'), '# A\n\n[B](./B.md)\n\n[missing](./Missing.md)\n\n[[Shared]]\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'B.md'), '# B\n\n[C](./C.md)\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'C.md'), '# C\n\n[A](./A.md)\n\n[bad](..%2Fescape.md)\n\n[double](%252e%252e%252fescape.md)\n', 'utf-8');
    fs.mkdirSync(path.join(sourceRoot, 'one'), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, 'two'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'one', 'Shared.md'), '# Shared One\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'two', 'Shared.md'), '# Shared Two\n', 'utf-8');
    const collisionPath = path.join(storeRoot, 'Collide.md');
    const originalCollisionContent = '# Existing collision\n\nDo not overwrite.';
    fs.writeFileSync(path.join(sourceRoot, 'Collide.md'), '# Collide\n\n[Child](./CollisionChild.md)\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'CollisionChild.md'), '# Collision Child\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'DeepA.md'), '# Deep A\n\n[Deep B](./deep/nested/DeepB.md)\n', 'utf-8');
    fs.mkdirSync(path.join(sourceRoot, 'deep', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'deep', 'nested', 'DeepB.md'), '# Deep B\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'AmbiguousShallow.md'), '# Ambiguous Shallow\n\n[[SharedDeep]]\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'SharedDeep.md'), '# Shared Deep Root\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'deep', 'nested', 'SharedDeep.md'), '# Shared Deep Nested\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, '한 글.md'), '# Korean Space\n\nLocal import Korean path fixture.\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'Concurrent.md'), '# Concurrent\n\nConcurrent duplicate import fixture.\n', 'utf-8');
    fs.writeFileSync(path.join(sourceRoot, 'SameContentLegacy.md'), '# Same Content Legacy\n', 'utf-8');
    fs.writeFileSync(collisionPath, originalCollisionContent, 'utf-8');
    fs.writeFileSync(path.join(storeRoot, 'Legacy.md'), '---\ndocumentId: trusted-legacy\n---\n# Legacy\n\n[[Missing Legacy]]\n', 'utf-8');
    fs.writeFileSync(path.join(storeRoot, 'LegacyDuplicate.md'), '---\ndocumentId: trusted-legacy\n---\n# Duplicate\n', 'utf-8');
    fs.writeFileSync(path.join(storeRoot, 'ExternalDuplicate.md'), '---\ndocumentId: external-duplicate\n---\n# External Duplicate\n', 'utf-8');
    fs.writeFileSync(path.join(storeRoot, 'SameRelative.md'), '---\ndocumentId: same-relative-duplicate\n---\n# Same Relative Duplicate\n', 'utf-8');
    fs.writeFileSync(path.join(storeRoot, 'SameContentLegacy.md'), '# Same Content Legacy\n', 'utf-8');
    fs.writeFileSync(path.join(storeRoot, 'UnsafeId.md'), '---\ndocumentId: "C:\\\\secret\\\\rawsecret.md"\n---\n# Unsafe Id\n', 'utf-8');

    let symlinkEntry = null;
    let aliasEntry = null;
    let sourceRootAlias = null;
    let destinationEscapeEntry = null;
    let destinationEscapeOutsideFile = null;
    try {
      const outsideRoot = path.join(root, 'outside');
      fs.mkdirSync(outsideRoot, { recursive: true });
      fs.writeFileSync(path.join(outsideRoot, 'Escape.md'), '# Escape\n\nOutside root', 'utf-8');
      fs.symlinkSync(outsideRoot, path.join(sourceRoot, 'linked-out'), 'junction');
      symlinkEntry = path.join(sourceRoot, 'linked-out', 'Escape.md');
      fs.symlinkSync(outsideRoot, path.join(storeRoot, 'legacy-linked-out'), 'junction');
    } catch {
      symlinkEntry = null;
    }
    try {
      sourceRootAlias = path.join(root, 'source-alias');
      fs.symlinkSync(sourceRoot, sourceRootAlias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      sourceRootAlias = null;
    }
    try {
      fs.symlinkSync(path.join(sourceRoot, 'A.md'), path.join(sourceRoot, 'AliasA.md'), 'file');
      aliasEntry = path.join(sourceRoot, 'AliasA.md');
    } catch {
      aliasEntry = null;
    }
    try {
      const outsideStoreTarget = path.join(root, 'outside-store-target');
      const escapeDir = path.join(sourceRoot, 'escape-dir');
      fs.mkdirSync(outsideStoreTarget, { recursive: true });
      fs.mkdirSync(escapeDir, { recursive: true });
      destinationEscapeOutsideFile = path.join(outsideStoreTarget, 'EscapeDest.md');
      destinationEscapeEntry = path.join(escapeDir, 'EscapeDest.md');
      fs.writeFileSync(destinationEscapeEntry, '# Destination Escape\n', 'utf-8');
      fs.symlinkSync(outsideStoreTarget, path.join(storeRoot, 'escape-dir'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      destinationEscapeEntry = null;
      destinationEscapeOutsideFile = null;
    }

    ledger = createSourceLedgerStore({
      dbPath: path.join(ledgerRoot, 'smart-search.sqlite3'),
      userDataDir: path.join(root, 'userData')
    });
    ledger.initialize();
    const externalSource = ledger.recordSource({
      rootPathInternal: path.join(root, 'external-ledger-source'),
      displayName: 'External Ledger Source',
      rootFingerprint: 'external-ledger-source'
    });
    ledger.upsertDocument({
      sourceId: externalSource.sourceId,
      documentId: 'external-duplicate',
      sourceRelativePath: 'Already.md',
      pathKey: 'already.md'
    });
    ledger.upsertDocument({
      sourceId: externalSource.sourceId,
      documentId: 'same-relative-duplicate',
      sourceRelativePath: 'SameRelative.md',
      pathKey: 'samerelative.md'
    });

    const importer = createLinkedImporter({
      sourceRoot,
      knowledgeStoreRoot: storeRoot,
      ledger,
      maxDepth: 4,
      maxFiles: 10,
      maxTotalBytes: 1024 * 1024
    });
    const adopter = createLegacyAdopter({
      knowledgeStoreRoot: storeRoot,
      ledger
    });

    wave2Assert(typeof importer.importMarkdownGraph === 'function', 'linked importer exposes importMarkdownGraph()');
    wave2Assert(typeof adopter.adoptKnowledgeStore === 'function', 'legacy adopter exposes adoptKnowledgeStore()');
    const nulDestination = importer.checkKnowledgeStoreDestination('bad\0name.md', '# Bad');
    wave2Assert(
      nulDestination && nulDestination.status === 'ambiguous' && nulDestination.diagnosticCode === 'destination_nul_or_empty_segment',
      'linked import rejects NUL-like destination segments before write'
    );
    const reservedDestination = importer.checkKnowledgeStoreDestination('NUL.md', '# Reserved');
    wave2Assert(
      reservedDestination && reservedDestination.status === 'ambiguous' && reservedDestination.diagnosticCode === 'destination_reserved_name',
      'linked import rejects reserved device-name destination segments before write'
    );
    const traversalDestination = importer.checkKnowledgeStoreDestination('../escape.md', '# Escape');
    wave2Assert(
      traversalDestination && traversalDestination.status === 'ambiguous' && traversalDestination.diagnosticCode === 'destination_path_policy_violation',
      'linked import rejects traversal destination segments before write'
    );

    const importResult = await importer.importMarkdownGraph(path.join(sourceRoot, 'A.md'));
    wave2Assert(importResult.source && importResult.source.sourceKind === 'local_import_source', 'linked import records a local import source identity');
    wave2Assert(importResult.counts.imported === 3, 'A -> B -> C -> A cycle imports each canonical source once');
    wave2Assert(importResult.counts.skipped >= 1, 'cycle/self duplicate outcomes are skipped, not infinite recursion');
    wave2Assert(importResult.counts.missing >= 1, 'missing link target is reported as canonical missing diagnostic');
    wave2Assert(importResult.counts.ambiguous >= 1, 'ambiguous basename or wikilink target is reported as canonical ambiguous diagnostic');
    wave2Assert(importResult.counts.path_policy_violation >= 2, 'encoded and double-encoded traversal report path_policy_violation');
    wave2Assert(importResult.diagnostics.every((item) => item.diagnosticCode), 'diagnostics carry diagnostic_code values');
    wave2Assert(
      importResult.diagnostics.some((item) => item.status === 'missing' && item.diagnosticCode),
      'missing links remain diagnostics-only with status=missing and diagnostic_code'
    );
    wave2Assert(
      importResult.diagnostics.some((item) => item.status === 'ambiguous' && item.diagnosticCode),
      'ambiguous links do not auto-select a winner and remain diagnostics-only'
    );
    wave2Assert(
      !importResult.diagnostics.some((item) => ['broken', 'unresolved', 'anchor_missing', 'skipped_cycle', 'skipped_depth'].includes(item.status)),
      'diagnostics use only canonical edge statuses, not stale broken/unresolved/skipped_* statuses'
    );
    wave2Assert(!JSON.stringify(importResult).includes(sourceRoot), 'import result redacts raw source root paths');
    const localImportJobsAfterFirstRun = ledger.getIndexJobs({}).filter((job) => job.requestedBy === 'local.linked_import');
    wave2Assert(localImportJobsAfterFirstRun.length === 3, 'linked import enqueues common post-save indexing once per newly imported document');
    const importedA = ledger.findDocumentBySourcePath({
      sourceId: importResult.source.sourceId,
      sourceRelativePath: 'A.md'
    });
    const importedB = ledger.findDocumentBySourcePath({
      sourceId: importResult.source.sourceId,
      sourceRelativePath: 'B.md'
    });
    wave2Assert(importedA && importedB, 'linked import persists source_id plus path_key document identities');
    const caseAliasLookup = ledger.findDocumentBySourcePath({
      sourceId: importResult.source.sourceId,
      sourceRelativePath: 'a.MD'
    });
    wave2Assert(caseAliasLookup && caseAliasLookup.documentId === importedA.documentId, 'source path lookup treats case-only aliases as the same path_key identity');
    const documentIndexes = ledger.open().prepare("PRAGMA index_list('documents')").all();
    wave2Assert(
      documentIndexes.some((item) => item.name === 'idx_documents_canonical_path_hash' && Number(item.unique) === 1),
      'ledger enforces canonical path hash uniqueness for alias duplicate protection'
    );
    let duplicateCanonicalRejected = false;
    try {
      ledger.upsertDocument({
        sourceId: importResult.source.sourceId,
        documentId: 'duplicate-canonical-fixture',
        sourceRelativePath: 'AliasA.md',
        pathKey: 'aliasa.md',
        canonicalPathInternal: path.join(sourceRoot, 'A.md'),
        contentHash: importedA.contentHash
      });
    } catch {
      duplicateCanonicalRejected = true;
    }
    wave2Assert(duplicateCanonicalRejected, 'duplicate canonical path alias cannot create a second ledger document');
    if (aliasEntry) {
      const aliasImport = await importer.importMarkdownGraph(aliasEntry);
      wave2Assert(aliasImport.counts.imported === 0 && aliasImport.counts.existing >= 1, 'in-root symlink alias reuses existing canonical source identity');
      const aliasRow = ledger.findDocumentBySourcePath({
        sourceId: importResult.source.sourceId,
        sourceRelativePath: 'AliasA.md'
      });
      wave2Assert(!aliasRow, 'in-root symlink alias does not create a second source_id/path_key document row');
    }
    if (sourceRootAlias) {
      const aliasRootImporter = createLinkedImporter({
        sourceRoot: sourceRootAlias,
        knowledgeStoreRoot: storeRoot,
        ledger,
        maxDepth: 4,
        maxFiles: 10,
        maxTotalBytes: 1024 * 1024
      });
      const aliasRootImport = await aliasRootImporter.importMarkdownGraph(path.join(sourceRootAlias, 'A.md'));
      wave2Assert(aliasRootImport.source.sourceId === importResult.source.sourceId, 'source root symlink alias resolves to the existing canonical source identity');
      wave2Assert(aliasRootImport.counts.imported === 0 && aliasRootImport.counts.existing >= 3, 'source root symlink alias does not create duplicate imported documents');
      wave2Assert(
        !aliasRootImport.diagnostics.some((item) => item.diagnosticCode === 'canonical_source_collision'),
        'source root symlink alias does not report a false canonical_source_collision'
      );
      const localSourceRows = ledger.open().prepare("SELECT COUNT(*) AS count FROM sources WHERE source_kind = 'local_import_source'").get();
      wave2Assert(localSourceRows.count === 1, 'source root symlink alias does not create a second local_import_source row');
    }
    const importLinkDiagnostics = ledger.getLinkDiagnostics({ documentId: importedA.documentId });
    wave2Assert(importLinkDiagnostics.counts.resolved >= 1, 'linked import records resolved graph edges in the ledger');
    wave2Assert(importLinkDiagnostics.counts.missing >= 1, 'linked import records missing graph diagnostics in the ledger');

    const repeatImport = await importer.importMarkdownGraph(path.join(sourceRoot, 'A.md'));
    wave2Assert(repeatImport.counts.imported === 0, 'repeated unchanged linked import does not save duplicate documents');
    wave2Assert(repeatImport.counts.existing >= 3, 'repeated unchanged linked import reports existing source identities');
    const localImportJobsAfterRepeat = ledger.getIndexJobs({}).filter((job) => job.requestedBy === 'local.linked_import');
    wave2Assert(localImportJobsAfterRepeat.length === localImportJobsAfterFirstRun.length, 'unchanged repeated linked import skips duplicate indexing jobs');

    fs.writeFileSync(path.join(sourceRoot, 'B.md'), '# B Updated\n\n[C](./C.md)\n', 'utf-8');
    const updateResult = await importer.importMarkdownGraph(path.join(sourceRoot, 'B.md'));
    const updatedB = ledger.findDocumentBySourcePath({
      sourceId: importResult.source.sourceId,
      sourceRelativePath: 'B.md'
    });
    wave2Assert(updateResult.counts.updated === 1, 'changed source identity is updated as a revision');
    wave2Assert(updatedB.documentId === importedB.documentId, 'changed source identity reuses the stable documentId');
    wave2Assert(updatedB.contentHash !== importedB.contentHash, 'changed source identity records the new content hash');

    const koreanImport = await importer.importMarkdownGraph(path.join(sourceRoot, '한 글.md'));
    wave2Assert(koreanImport.imported.some((item) => item.sourceRelativePath === '한 글.md') || koreanImport.counts.existing >= 1, 'linked import supports Korean and space filenames');
    const koreanUnicodeAliasLookup = ledger.findDocumentBySourcePath({
      sourceId: importResult.source.sourceId,
      sourceRelativePath: '한 글.md'.normalize('NFD')
    });
    wave2Assert(koreanUnicodeAliasLookup, 'source path lookup normalizes Unicode variants for Korean and space filenames');

    const [concurrentLeft, concurrentRight] = await Promise.all([
      importer.importMarkdownGraph(path.join(sourceRoot, 'Concurrent.md')),
      importer.importMarkdownGraph(path.join(sourceRoot, 'Concurrent.md'))
    ]);
    const concurrentRows = ledger.open().prepare(`
      SELECT COUNT(*) AS count
      FROM documents
      WHERE source_id = ? AND path_key = ?
    `).get(importResult.source.sourceId, 'concurrent.md');
    wave2Assert(concurrentRows.count === 1, 'concurrent duplicate imports converge to one source_id/path_key row');
    wave2Assert(
      (concurrentLeft.counts.imported + concurrentRight.counts.imported) <= 1 &&
        (concurrentLeft.counts.existing + concurrentRight.counts.existing + concurrentLeft.counts.skipped + concurrentRight.counts.skipped) >= 1,
      'concurrent duplicate import loser reports existing or skipped canonical outcome'
    );

    if (symlinkEntry) {
      const escapedImport = await importer.importMarkdownGraph(symlinkEntry);
      wave2Assert(escapedImport.counts.imported === 0, 'symlink or junction entry outside canonical source root is not imported');
      wave2Assert(escapedImport.counts.path_policy_violation >= 1, 'symlink or junction escape reports path_policy_violation');
    }
    if (destinationEscapeEntry) {
      const destinationEscapeImport = await importer.importMarkdownGraph(destinationEscapeEntry);
      wave2Assert(destinationEscapeImport.counts.imported === 0, 'linked import destination symlink escape is not reported as imported');
      wave2Assert(
        destinationEscapeImport.diagnostics.some((item) => item.status === 'ambiguous' && item.diagnosticCode === 'destination_realpath_outside_store'),
        'linked import destination symlink escape is blocked by realpath containment diagnostics'
      );
      wave2Assert(
        !destinationEscapeOutsideFile || !fs.existsSync(destinationEscapeOutsideFile),
        'linked import destination symlink escape does not write outside the knowledge store'
      );
      const escapedDestinationRow = ledger.findDocumentBySourcePath({
        sourceId: importResult.source.sourceId,
        sourceRelativePath: 'escape-dir/EscapeDest.md'
      });
      wave2Assert(!escapedDestinationRow, 'linked import destination symlink escape does not create a ledger document row');
    }

    const shallowImporter = createLinkedImporter({
      sourceRoot,
      knowledgeStoreRoot: storeRoot,
      maxDepth: 1,
      maxFiles: 10,
      maxTotalBytes: 1024 * 1024
    });
    const shallowResult = await shallowImporter.importMarkdownGraph(path.join(sourceRoot, 'DeepA.md'));
    wave2Assert(shallowResult.counts.imported === 2, 'graph depth 1 can import a linked child in a deeper directory');
    const shallowAmbiguousResult = await shallowImporter.importMarkdownGraph(path.join(sourceRoot, 'AmbiguousShallow.md'));
    wave2Assert(
      shallowAmbiguousResult.diagnostics.some((item) => item.status === 'ambiguous' && item.diagnosticCode === 'ambiguous_target'),
      'wikilink basename ambiguity is detected even when another candidate is outside source-index scan depth'
    );

    const collisionImport = await importer.importMarkdownGraph(path.join(sourceRoot, 'Collide.md'));
    wave2Assert(collisionImport.counts.imported === 0, 'destination-collided root is not reported as imported');
    wave2Assert(fs.readFileSync(collisionPath, 'utf-8') === originalCollisionContent, 'destination collision does not overwrite existing knowledge-store file');
    wave2Assert(!fs.existsSync(path.join(storeRoot, 'CollisionChild.md')), 'destination-collided root does not traverse and save linked children');
    wave2Assert(
      collisionImport.diagnostics.some((item) => item.status === 'ambiguous' && item.diagnosticCode === 'destination_collision'),
      'destination collision remains ambiguous diagnostics-only'
    );
    const sameContentLegacyImport = await importer.importMarkdownGraph(path.join(sourceRoot, 'SameContentLegacy.md'));
    wave2Assert(sameContentLegacyImport.counts.imported === 0, 'same-content legacy destination without source identity is not auto-adopted by linked import');
    wave2Assert(
      sameContentLegacyImport.diagnostics.some((item) => item.status === 'ambiguous' && item.diagnosticCode === 'legacy_destination_without_source_identity'),
      'same-content legacy destination without source identity remains ambiguous until explicit adoption evidence exists'
    );

    const adoptionResult = await adopter.adoptKnowledgeStore();
    wave2Assert(adoptionResult.adopted.some((item) => item.documentId === 'trusted-legacy'), 'legacy adoption reuses trusted documentId without rewrite');
    wave2Assert(adoptionResult.adopted.filter((item) => item.documentId === 'trusted-legacy').length === 1, 'duplicate trusted documentId is not adopted twice');
    wave2Assert(!adoptionResult.adopted.some((item) => item.documentId === 'external-duplicate'), 'pre-existing ledger documentId collision is not adopted');
    wave2Assert(!adoptionResult.adopted.some((item) => item.documentId === 'same-relative-duplicate'), 'pre-existing ledger documentId collision from another source is not adopted even with the same relative path');
    wave2Assert(!adoptionResult.adopted.some((item) => String(item.documentId).includes('rawsecret') || String(item.documentId).includes('C:\\')), 'unsafe legacy frontmatter documentId is not exposed or trusted');
    wave2Assert(
      adoptionResult.diagnostics.some((item) => item.status === 'skipped' && item.diagnosticCode === 'unsafe_document_id'),
      'unsafe legacy frontmatter documentId is reported as a redacted diagnostic'
    );
    wave2Assert(!JSON.stringify(adoptionResult).includes('rawsecret'), 'legacy adoption diagnostics redact unsafe documentId credential-like text');
    wave2Assert(
      adoptionResult.diagnostics.some((item) => item.status === 'ambiguous' && item.diagnosticCode === 'duplicate_document_id'),
      'duplicate trusted documentId is reported as ambiguous diagnostics-only'
    );
    if (symlinkEntry) {
      wave2Assert(
        adoptionResult.diagnostics.some((item) => item.status === 'path_policy_violation' && item.diagnosticCode === 'realpath_outside_source_root'),
        'legacy adoption reports symlink or junction escape diagnostics'
      );
    }
    const jobs = ledger.getIndexJobs({ documentId: 'trusted-legacy' });
    wave2Assert(jobs.some((job) => job.requestedBy === 'knowledge_store.legacy_adoption'), 'legacy adoption enqueues common post-save indexing job');
    const trustedJob = jobs.find((job) => job.requestedBy === 'knowledge_store.legacy_adoption');
    ledger.updateIndexJob(trustedJob.jobId, { status: 'completed', finishedAt: true });
    await adopter.adoptKnowledgeStore();
    const trustedJobsAfterRescan = ledger.getIndexJobs({ documentId: 'trusted-legacy' });
    wave2Assert(
      trustedJobsAfterRescan.some((job) => job.jobId === trustedJob.jobId && job.status === 'completed'),
      'unchanged legacy rescan refreshes freshness without resetting duplicate indexing jobs'
    );
    const linkDiagnostics = ledger.getLinkDiagnostics({ documentId: 'trusted-legacy' });
    wave2Assert(linkDiagnostics.counts.missing >= 1, 'legacy adoption records canonical missing link diagnostics in ledger');
    const missingLegacyPath = path.join(storeRoot, 'Missing Legacy.md');
    fs.writeFileSync(missingLegacyPath, '# Missing Legacy\n\nTarget added later.\n', 'utf-8');
    await adopter.adoptKnowledgeStore();
    const linkDiagnosticsAfterTargetAdded = ledger.getLinkDiagnostics({ documentId: 'trusted-legacy' });
    wave2Assert(
      linkDiagnosticsAfterTargetAdded.counts.resolved >= 1,
      'legacy adoption reconciliation transitions a later-added target to a resolved edge'
    );
    const legacyLinkRowsAfterResolve = ledger.open().prepare(`
      SELECT status, to_document_id
      FROM links
      WHERE from_document_id = ? AND original_href_internal LIKE ?
      ORDER BY updated_at DESC
    `).all('trusted-legacy', '%Missing Legacy%');
    wave2Assert(
      legacyLinkRowsAfterResolve.length === 1 && legacyLinkRowsAfterResolve[0].status === 'resolved' && legacyLinkRowsAfterResolve[0].to_document_id,
      'later-added legacy target updates the existing edge row instead of creating duplicate missing/resolved edges'
    );
    fs.unlinkSync(missingLegacyPath);
    await adopter.adoptKnowledgeStore();
    const linkDiagnosticsAfterTargetRemoved = ledger.getLinkDiagnostics({ documentId: 'trusted-legacy' });
    wave2Assert(
      linkDiagnosticsAfterTargetRemoved.counts.missing >= 1,
      'legacy adoption reconciliation transitions a removed target back to a missing edge without failing indexing'
    );
    const legacyLinkRowsAfterRemove = ledger.open().prepare(`
      SELECT status, to_document_id
      FROM links
      WHERE from_document_id = ? AND original_href_internal LIKE ?
      ORDER BY updated_at DESC
    `).all('trusted-legacy', '%Missing Legacy%');
    wave2Assert(
      legacyLinkRowsAfterRemove.length === 1 && legacyLinkRowsAfterRemove[0].status === 'missing' && !legacyLinkRowsAfterRemove[0].to_document_id,
      'removed legacy target updates the existing edge row to missing without preserving a stale resolved target'
    );
    wave2Assert(!adoptionResult.rewrittenPaths || adoptionResult.rewrittenPaths.length === 0, 'legacy adoption does not rewrite existing files');
  } finally {
    if (ledger) ledger.close();
    await removeTreeWithRetry(root);
  }

  console.log('test-wave2-import-adoption-contract: all assertions passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
