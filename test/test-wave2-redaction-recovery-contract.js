'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSourceLedgerStore } = require('../src/main/source-ledger-store');
const { createRedactor } = require('../src/main/redaction');

function wave2Assert(condition, message) {
  assert(condition, `Wave 2 redaction/recovery contract: ${message}`);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-wave2-recovery-'));
  let ledger = null;
  try {
    const userDataDir = path.join(root, 'userData');
    const indexDir = path.join(userDataDir, 'index');
    const dbPath = path.join(indexDir, 'smart-search.sqlite3');
    const hnswPath = path.join(indexDir, 'semantic.hnsw');
    const gitContextPath = path.join(root, 'worktree', 'project-secret');
    const credentialUrl = 'https://user:rawsecret@example.test/v1?api_key=rawsecret&token=rawsecret';
    fs.mkdirSync(indexDir, { recursive: true });
    fs.mkdirSync(gitContextPath, { recursive: true });
    fs.writeFileSync(hnswPath, 'not a valid hnsw file', 'utf-8');

    ledger = createSourceLedgerStore({ dbPath, userDataDir });
    ledger.initialize();
    const model = ledger.upsertEmbeddingModel({
      provider: 'openai-compatible',
      modelName: 'fixture',
      modelFingerprint: 'fixture-fingerprint',
      dimensions: 3
    });
    const ann = ledger.recordAnnIndex({
      modelId: model.modelId,
      indexPathInternal: hnswPath,
      checksum: 'sha256:not-the-file-hash',
      status: 'committed',
      params: { m: 16, efConstruction: 200 }
    });

    const manifest = ledger.createBackupManifest({
      reason: 'migration-before',
      hnswManifest: {
        indexPathInternal: hnswPath,
        checksum: 'sha256:not-the-file-hash',
        providerUrl: credentialUrl
      },
      gitContextPath
    });
    const manifestText = JSON.stringify(manifest);
    wave2Assert(manifest.backupPathToken && manifest.dbPathToken, 'backup manifest contains redacted DB and backup tokens');
    wave2Assert(!Object.prototype.hasOwnProperty.call(manifest, 'backupPathInternal'), 'public backup manifest does not carry raw backupPathInternal');
    wave2Assert(typeof manifest.walPresent === 'boolean' && typeof manifest.shmPresent === 'boolean', 'backup manifest records WAL/SHM state');
    wave2Assert(manifest.schemaVersion, 'backup manifest records schema version');
    wave2Assert(!manifestText.includes(dbPath) && !manifestText.includes(userDataDir) && !manifestText.includes(hnswPath), 'backup manifest redacts raw DB/userData/HNSW paths');
    wave2Assert(!manifestText.includes('rawsecret') && !manifestText.includes(gitContextPath), 'backup manifest redacts credentials and gitContextPath');

    const hnswDiagnostic = ledger.verifyAnnIndexChecksum({ annIndexId: ann.ann_index_id });
    wave2Assert(hnswDiagnostic.status === 'degraded', 'checksum mismatch degrades HNSW instead of trusting it as source of truth');
    wave2Assert(hnswDiagnostic.rebuildRecommended === true, 'checksum mismatch recommends settings-side rebuild');
    wave2Assert(!JSON.stringify(hnswDiagnostic).includes(hnswPath), 'HNSW checksum diagnostic redacts raw path');

    const rawBackupPath = ledger.createBackup('restore-fixture');
    const migrationDiagnostic = ledger.getMigrationFailureDiagnostics({
      migrationId: '20260702-failed-fixture',
      sourceSchemaVersion: 1,
      targetSchemaVersion: 2,
      dbPathInternal: dbPath,
      backupPathInternal: rawBackupPath,
      gitContextPath,
      providerUrl: credentialUrl
    });
    const migrationText = JSON.stringify(migrationDiagnostic);
    wave2Assert(migrationDiagnostic.rollbackAvailable === true, 'migration failure diagnostic exposes rollback/restore path availability');
    wave2Assert(!migrationText.includes(dbPath) && !migrationText.includes(userDataDir), 'migration diagnostics redact raw DB/userData paths');
    wave2Assert(!migrationText.includes('rawsecret') && !migrationText.includes(gitContextPath), 'migration diagnostics redact credentials and gitContextPath');

    const restoreResult = ledger.restoreBackup(rawBackupPath);
    wave2Assert(restoreResult.restored === true, 'backup restore success is available');
    const failedRestore = ledger.restoreBackup(path.join(root, 'missing-backup.sqlite3'));
    wave2Assert(failedRestore.restored === false && failedRestore.diagnosticCode === 'backup_restore_failed', 'backup restore failure is diagnostic and non-throwing');
    wave2Assert(!JSON.stringify(failedRestore).includes(root), 'backup restore failure redacts raw paths');
    ledger.close();

    const corruptDbPath = path.join(indexDir, 'corrupt.sqlite3');
    fs.writeFileSync(corruptDbPath, 'corrupt sqlite fixture', 'utf-8');
    const corruptLedger = createSourceLedgerStore({ dbPath: corruptDbPath, userDataDir });
    const startup = corruptLedger.initializeWithRecovery();
    wave2Assert(startup.ok === false && startup.writeSuspended === true, 'corrupt SQLite startup suspends writes and reports degraded recovery');
    wave2Assert(!JSON.stringify(startup).includes(corruptDbPath) && !JSON.stringify(startup).includes(userDataDir), 'corrupt SQLite diagnostics redact raw paths');
    let suspendedWriteRejected = false;
    try {
      corruptLedger.recordSource({
        rootPathInternal: path.join(root, 'blocked-source'),
        displayName: 'Blocked',
        rootFingerprint: 'blocked'
      });
    } catch (err) {
      suspendedWriteRejected = err && err.code === 'SOURCE_LEDGER_WRITE_SUSPENDED';
    }
    wave2Assert(suspendedWriteRejected, 'write-suspended recovery state rejects later ledger writes');

    const redactor = createRedactor({ sourceRoots: [gitContextPath], userDataDir, dbPath });
    const fixturePayload = {
      saveDocumentSuccess: { documentId: 'doc_fixture', sourceRelativePath: 'docs/A.md', projectPathInternal: gitContextPath },
      saveDocumentError: { diagnosticCode: 'write_failed', writePathInternal: dbPath, message: `failed ${credentialUrl}` },
      smartSearch: { includeDiagnostics: { rawPathInternal: hnswPath, providerUrl: credentialUrl } },
      indexingStatus: { currentPathInternal: hnswPath, gitContextPath },
      traceSnapshot: { projectPath: gitContextPath, url: credentialUrl },
      log: `path=${dbPath} git=${gitContextPath} token=rawsecret`,
      sqliteExport: { exportPathInternal: dbPath },
      backupManifest: manifest,
      packageSmokeArtifact: { indexPathInternal: dbPath, hnswPathInternal: hnswPath }
    };
    fixturePayload.unconfiguredPaths = {
      windowsAbsolute: 'D:\\Sensitive Folder\\raw file.md',
      uncAbsolute: '\\\\server\\share\\Sensitive Folder\\raw file.md',
      posixAbsolute: '/unconfigured/sensitive/raw-file.md'
    };
    const redactedFixture = redactor.redactValue(fixturePayload);
    const fixtureText = JSON.stringify(redactedFixture);
    wave2Assert(!fixtureText.includes(root), 'shared redaction fixture removes local absolute paths from all save/search/recovery surfaces');
    wave2Assert(!fixtureText.includes('rawsecret'), 'shared redaction fixture removes credential-like values from all save/search/recovery surfaces');
    wave2Assert(fixtureText.includes('doc_fixture') && fixtureText.includes('docs/A.md'), 'shared redaction fixture preserves allowed documentId and source-relative path');
  } finally {
    if (ledger) ledger.close();
    await removeTreeWithRetry(root);
  }

  console.log('test-wave2-redaction-recovery-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
