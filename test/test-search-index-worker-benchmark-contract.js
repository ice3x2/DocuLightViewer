'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const { createKeywordTokenizer } = require('../src/main/search-tokenizer');

const MAX_ANALYSIS_CHARS = 1200;
const LARGE_SINGLE_FILE_BYTES = 160 * 1024 * 1024;
const LATENCY_THRESHOLDS_MS = Object.freeze({
  statusCancelP95: 1000,
  statusCancelP99: 3000,
  statusCancelMax: 5000,
  mainHeartbeatMaxGap: 2000
});
const REQUIRED_FAILURE_SIGNATURES = Object.freeze([
  'backup manifest',
  'worker native load',
  'large corpus benchmark metrics'
]);
const REQUIRED_METRIC_PATHS = Object.freeze([
  'metrics.corpusBytes',
  'metrics.corpusFileCount',
  'metrics.maxFileBytes',
  'metrics.largeSingleFileFixtureBytes',
  'metrics.phaseWallTimeMs',
  'metrics.peakRssBytes',
  'metrics.dbBytes',
  'metrics.walBytes',
  'metrics.shmBytes',
  'metrics.eventLoopLatencyMs.p95',
  'metrics.eventLoopLatencyMs.p99',
  'metrics.eventLoopLatencyMs.max',
  'metrics.statusLatencyMs.p95',
  'metrics.statusLatencyMs.p99',
  'metrics.statusLatencyMs.max',
  'metrics.cancelLatencyMs.p95',
  'metrics.cancelLatencyMs.p99',
  'metrics.cancelLatencyMs.max',
  'metrics.statusSampleCount',
  'metrics.indexedCount',
  'metrics.workerNative.betterSqlite3.state',
  'metrics.workerNative.hnswlibNode.state',
  'safety.sourceRootIndexFilesCreated'
]);
const REQUIRED_BOOLEAN_PATHS = Object.freeze([
  'metrics.workerRebuildStarted',
  'metrics.workerRebuildScheduled',
  'metrics.workerRebuildCompleted',
  'metrics.activeCancelStarted',
  'metrics.activeCancelRequested'
]);

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

function pushFailure(failures, signature, message) {
  failures.push(`${signature}: ${message}`);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(Object(object), key);
}

function getPath(object, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => {
    if (current && hasOwn(current, key)) return current[key];
    return undefined;
  }, object);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function runBenchmarkWithGeneratedCorpus(outPath) {
  return spawnSync(process.execPath, [
    path.join(root, 'scripts/bench-search-index-worker.js'),
    '--generated-temp-corpus',
    '--out',
    outPath,
    '--cleanup-temp',
    '--json'
  ], {
    cwd: root,
    encoding: 'utf-8'
  });
}

async function collectBoundedTokenizerFailures({ tokenizerSource, sqliteStoreSource, searchEngineSource }) {
  const failures = [];
  const analyzedInputs = [];
  const tokenizer = createKeywordTokenizer({
    provider: 'garu',
    loadGaru: async () => ({
      analyze(text) {
        analyzedInputs.push(String(text));
        return { tokens: [], score: 1, elapsed: 0 };
      },
      modelInfo() {
        return { version: 'contract-garu', size: 1, accuracy: 1 };
      }
    })
  });

  await tokenizer.initialize();
  const longMarkdown = [
    '---',
    `description: ${'metadata '.repeat(180)}`,
    '---',
    '# 전자문서 검색 인덱스 작업자',
    ...Array.from({ length: 24 }, (_, index) => `## Section ${index + 1} 전자문서`),
    'body '.repeat(3000),
    'lateboundarytoken'
  ].join('\n');
  const longTokens = tokenizer.tokenize(longMarkdown);
  const longSearchText = tokenizer.buildSearchText(longMarkdown);

  const status = tokenizer.getStatus();
  if (!isFiniteNumber(status.maxAnalysisChars) || Number(status.maxAnalysisChars) > MAX_ANALYSIS_CHARS) {
    pushFailure(
      failures,
      'bounded tokenizer analysis',
      'default maxAnalysisChars must be finite and <= 1200 for garu-ko/basic enrichment'
    );
  }
  const maxAnalyzedChars = Math.max(...analyzedInputs.map((text) => text.length), 0);
  if (maxAnalyzedChars > Math.min(Number(status.maxAnalysisChars) || Infinity, MAX_ANALYSIS_CHARS)) {
    pushFailure(
      failures,
      'bounded tokenizer analysis',
      `garu-ko received ${maxAnalyzedChars} analysis chars; the worker contract requires analysis input <= maxAnalysisChars and <= 1200`
    );
  }
  if (longTokens.includes('lateboundarytoken') || longSearchText.includes('lateboundarytoken')) {
    pushFailure(
      failures,
      'bounded tokenizer analysis',
      'basic tokenizer/search_text received a token beyond the bounded analysis window'
    );
  }
  if (
    /basicTokenize\(text\)/m.test(tokenizerSource) ||
    /_buildAnalysisText\(text\)[\s\S]*raw\.match(?:All)?\(/m.test(tokenizerSource) ||
    /getBoundedBodySearchText\(item\)[\s\S]*body\.match(?:All)?\(/m.test(sqliteStoreSource) ||
    /body\.replace\(\s*\/\\s\+\/g/m.test(searchEngineSource) ||
    /buildSearchText\(raw\)[\s\S]*return\s+`\$\{text\}\s+\$\{tokens\.join\(' '\)\}`/m.test(tokenizerSource) ||
    /item\.body[\s\S]*buildSearchText\(raw\)/m.test(sqliteStoreSource)
  ) {
    pushFailure(
      failures,
      'bounded tokenizer analysis',
      '160 MiB single-file guard must prevent main-process full-body tokenization/search_text construction for large Markdown bodies'
    );
  }

  return failures;
}

function getFocus() {
  const focusArg = process.argv.find((arg) => arg.startsWith('--focus='));
  return focusArg ? focusArg.slice('--focus='.length) : null;
}

(async () => {
  const failures = [];
  const focus = getFocus();
  const tokenizerSource = readProjectFile('src/main/search-tokenizer.js');
  const sqliteStoreSource = readProjectFile('src/main/search-sqlite-store.js');
  const searchEngineSource = readProjectFile('src/main/search-engine.js');
  const boundedFailures = await collectBoundedTokenizerFailures({
    tokenizerSource,
    sqliteStoreSource,
    searchEngineSource
  });
  failures.push(...boundedFailures);

  if (focus === 'bounded-tokenizer') {
    if (failures.length > 0) {
      const error = new Error([
        'REL-DOC-007 bounded tokenizer focus failure.',
        ...failures.map((failure) => `- ${failure}`)
      ].join('\n'));
      error.code = 'REL_DOC_007_BOUNDED_TOKENIZER_FOCUS';
      throw error;
    }
    console.log('test-search-index-worker-benchmark-contract: bounded-tokenizer focus assertions passed');
    return;
  }
  if (focus) {
    const error = new Error(`Unsupported focus: ${focus}`);
    error.code = 'REL_DOC_007_BENCHMARK_UNSUPPORTED_FOCUS';
    throw error;
  }

  const packageJson = JSON.parse(readProjectFile('package.json'));
  const packageSmokeSource = readProjectFile('test/package-smoke.js');
  const benchmarkScriptPath = path.join(root, 'scripts/bench-search-index-worker.js');

  const searchIndexBackupContract =
    /create(?:SearchIndex)?BackupManifest|backupManifest|backupSkipped|backup-skip/i.test(sqliteStoreSource) &&
    /walPresent|walPath|WAL/i.test(sqliteStoreSource) &&
    /shmPresent|shmPath|SHM/i.test(sqliteStoreSource);
  const mainDbOnlyBackup = /copyFile\(indexPath,\s*backupPath\)/m.test(searchEngineSource);
  if (!searchIndexBackupContract || mainDbOnlyBackup) {
    pushFailure(
      failures,
      'backup manifest',
      'search index clear/compact/rebuild must use SQLite backup API or WAL checkpoint plus DB/WAL/SHM capture, or a redacted explicit backup-skip manifest; raw main DB file backup is not sufficient'
    );
  }

  const workerNativeSmokeContract =
    /workerNative|worker native|search-index-worker|IndexingWorkerController/i.test(packageSmokeSource) &&
    /better-sqlite3/i.test(packageSmokeSource) &&
    /hnswlib-node|native_unavailable/i.test(packageSmokeSource) &&
    /Electron ABI|electronAbi|process\.versions\.modules/i.test(packageSmokeSource);
  if (!workerNativeSmokeContract) {
    pushFailure(
      failures,
      'worker native load',
      'package smoke must verify better-sqlite3 loads inside the worker/child runtime and optional hnswlib-node either loads or reports native_unavailable with ABI diagnostics'
    );
  }

  if (!fs.existsSync(benchmarkScriptPath)) {
    pushFailure(failures, 'large corpus benchmark metrics', 'scripts/bench-search-index-worker.js must exist');
  }
  if (
    !packageJson.scripts ||
    !packageJson.scripts['bench:search-index-worker'] ||
    !packageJson.scripts['bench:search-index-worker'].includes('scripts/bench-search-index-worker.js')
  ) {
    pushFailure(
      failures,
      'large corpus benchmark metrics',
      'package.json must expose a focused bench:search-index-worker script'
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-index-worker-benchmark-contract-'));
  const artifactPath = path.join(tmp, 'benchmark-report.json');
  try {
    const result = runBenchmarkWithGeneratedCorpus(artifactPath);
    if (result.error || result.status === 2 || !fs.existsSync(artifactPath)) {
      pushFailure(
        failures,
        'large corpus benchmark metrics',
        `benchmark script must run with a generated temp corpus and write a report artifact; status=${result.status} stderr=${result.stderr || ''}`
      );
    } else {
      const report = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
      const mode = report.source && report.source.mode;
      if (!['configured-corpus', 'generated-temp-corpus'].includes(mode) || !report.safety || report.safety.benchmarkSkipped !== false) {
        pushFailure(
          failures,
          'large corpus benchmark metrics',
          'benchmark evidence must use a configured corpus path or generated temp corpus and must not be marked skipped'
        );
      }
      if (!report.tempIndexDataDir || !String(report.tempIndexDataDir).startsWith(os.tmpdir())) {
        pushFailure(
          failures,
          'large corpus benchmark metrics',
          'benchmark must write temp index data under the OS temp directory, not the app userData index or source corpus root'
        );
      }
      for (const dottedPath of REQUIRED_METRIC_PATHS) {
        const value = getPath(report, dottedPath);
        if (dottedPath === 'safety.sourceRootIndexFilesCreated') {
          if (value !== false) {
            pushFailure(
              failures,
              'large corpus benchmark metrics',
              'benchmark must prove source-root index files were not created'
            );
          }
        } else if (dottedPath.endsWith('.state')) {
          if (!['loaded', 'native_unavailable'].includes(value)) {
            pushFailure(
              failures,
              'worker native load',
              `${dottedPath} must be loaded or native_unavailable`
            );
          }
        } else if (!isFiniteNumber(value)) {
          pushFailure(
            failures,
            'large corpus benchmark metrics',
            `${dottedPath} must be recorded as a finite metric`
          );
        }
      }
      for (const dottedPath of REQUIRED_BOOLEAN_PATHS) {
        if (getPath(report, dottedPath) !== true) {
          pushFailure(
            failures,
            'large corpus benchmark metrics',
            `${dottedPath} must be true to prove worker rebuild/cancel behavior`
          );
        }
      }
      const thresholdChecks = [
        ['metrics.statusLatencyMs.p95', LATENCY_THRESHOLDS_MS.statusCancelP95],
        ['metrics.statusLatencyMs.p99', LATENCY_THRESHOLDS_MS.statusCancelP99],
        ['metrics.statusLatencyMs.max', LATENCY_THRESHOLDS_MS.statusCancelMax],
        ['metrics.cancelLatencyMs.p95', LATENCY_THRESHOLDS_MS.statusCancelP95],
        ['metrics.cancelLatencyMs.p99', LATENCY_THRESHOLDS_MS.statusCancelP99],
        ['metrics.cancelLatencyMs.max', LATENCY_THRESHOLDS_MS.statusCancelMax],
        ['metrics.eventLoopLatencyMs.max', LATENCY_THRESHOLDS_MS.mainHeartbeatMaxGap]
      ];
      for (const [dottedPath, threshold] of thresholdChecks) {
        const value = Number(getPath(report, dottedPath));
        if (!Number.isFinite(value) || value > threshold) {
          pushFailure(
            failures,
            'status/cancel latency threshold',
            `${dottedPath} must be <= ${threshold}ms for REL-DOC-007 AC-2; got ${value}`
          );
        }
      }
      if (Array.isArray(report.contractFailures) && report.contractFailures.length > 0) {
        pushFailure(
          failures,
          'status/cancel latency threshold',
          `benchmark contractFailures must be empty; got ${report.contractFailures.join('; ')}`
        );
      }
      if (Number(getPath(report, 'metrics.largeSingleFileFixtureBytes')) < LARGE_SINGLE_FILE_BYTES) {
        pushFailure(
          failures,
          'bounded tokenizer analysis',
          'benchmark must record a 160 MiB single-file fixture or equivalent sparse fixture'
        );
      }
      if (Number(getPath(report, 'metrics.maxFileBytes')) < LARGE_SINGLE_FILE_BYTES) {
        pushFailure(
          failures,
          'bounded tokenizer analysis',
          'generated/configured benchmark corpus must contain an actual or sparse >=160 MiB Markdown fixture'
        );
      }
      if (!['actual-file', 'sparse-file'].includes(getPath(report, 'metrics.largeSingleFileFixtureMode'))) {
        pushFailure(
          failures,
          'bounded tokenizer analysis',
          'benchmark must identify the 160 MiB fixture mode as actual-file or sparse-file'
        );
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    const error = new Error([
      'REL-DOC-007 search index worker benchmark contract failure.',
      ...failures.map((failure) => `- ${failure}`)
    ].join('\n'));
    error.code = 'REL_DOC_007_BENCHMARK_CONTRACT';
    throw error;
  }

  console.log('test-search-index-worker-benchmark-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
