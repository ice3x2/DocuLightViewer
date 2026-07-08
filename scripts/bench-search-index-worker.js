'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { monitorEventLoopDelay } = require('perf_hooks');
const { SearchEngine } = require('../src/main/search-engine');

const BENCHMARK_VERSION = 'search-index-worker-benchmark-contract.v1';
const LARGE_SINGLE_FILE_BYTES = 160 * 1024 * 1024;
const DEFAULT_GENERATED_FILE_COUNT = 8;
const STATUS_SAMPLE_INTERVAL_MS = 25;
const LATENCY_THRESHOLDS_MS = Object.freeze({
  statusCancelP95: 1000,
  statusCancelP99: 3000,
  statusCancelMax: 5000,
  mainHeartbeatMaxGap: 2000
});

// @req REL-DOC-007
function parseArgs(argv) {
  const args = {
    corpusPath: process.env.DOCULIGHT_INDEX_WORKER_BENCH_CORPUS || '',
    generatedTempCorpus: false,
    outPath: '',
    json: false,
    cleanupTemp: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--corpus') {
      args.corpusPath = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--corpus=')) {
      args.corpusPath = arg.slice('--corpus='.length);
    } else if (arg === '--generated-temp-corpus') {
      args.generatedTempCorpus = true;
    } else if (arg === '--out') {
      args.outPath = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--out=')) {
      args.outPath = arg.slice('--out='.length);
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--cleanup-temp') {
      args.cleanupTemp = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

// @req REL-DOC-007
function createGeneratedCorpus(rootDir) {
  const corpusPath = path.join(rootDir, 'generated-corpus');
  fs.mkdirSync(corpusPath, { recursive: true });

  for (let index = 0; index < DEFAULT_GENERATED_FILE_COUNT; index += 1) {
    const body = [
      `# Generated Worker Benchmark Document ${index + 1}`,
      '',
      'This generated fixture exists so the benchmark contract always uses a real corpus path.',
      'Korean tokenizer coverage: 전자문서 검색 인덱스 작업자 테스트.',
      `Document ordinal: ${index + 1}.`
    ].join('\n');
    fs.writeFileSync(path.join(corpusPath, `fixture-${index + 1}.md`), body, 'utf-8');
  }

  const largeFixturePath = path.join(corpusPath, 'large-single-file.md');
  const fd = fs.openSync(largeFixturePath, 'w');
  try {
    fs.writeSync(fd, '# Large worker tokenizer guard\n\n');
    fs.ftruncateSync(fd, LARGE_SINGLE_FILE_BYTES);
  } finally {
    fs.closeSync(fd);
  }

  return corpusPath;
}

// @req REL-DOC-007
function collectCorpusStats(corpusPath) {
  const stack = [corpusPath];
  let corpusBytes = 0;
  let corpusFileCount = 0;
  let maxFileBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      corpusFileCount += 1;
      corpusBytes += stat.size;
      maxFileBytes = Math.max(maxFileBytes, stat.size);
    }
  }

  return { corpusBytes, corpusFileCount, maxFileBytes };
}

// @req REL-DOC-007
function percentile(values, ratio) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const index = Math.min(finite.length - 1, Math.max(0, Math.ceil(finite.length * ratio) - 1));
  return finite[index];
}

// @req REL-DOC-007
function buildLatencyStats(values) {
  return {
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length > 0 ? Math.max(...values.filter((value) => Number.isFinite(value))) : 0
  };
}

// @req REL-DOC-007
function collectContractFailures(metrics = {}) {
  const failures = [];
  if (metrics.workerRebuildStarted !== true) {
    failures.push('worker rebuild did not start');
  }
  if (metrics.workerRebuildScheduled !== true) {
    failures.push('worker rebuild was not scheduled');
  }
  if (metrics.workerRebuildCompleted !== true) {
    failures.push(`worker rebuild did not complete; final state=${metrics.workerFinalState || '(unknown)'}`);
  }
  if (!Number.isInteger(metrics.indexedCount) || metrics.indexedCount <= 0) {
    failures.push(`worker rebuild produced no indexed documents; indexedCount=${metrics.indexedCount}`);
  }
  if (!Number.isInteger(metrics.statusSampleCount) || metrics.statusSampleCount <= 0) {
    failures.push(`worker rebuild status sampler produced no samples; statusSampleCount=${metrics.statusSampleCount}`);
  }
  if (metrics.activeCancelStarted !== true) {
    failures.push('active cancel probe did not start a worker job');
  }
  if (metrics.activeCancelRequested !== true) {
    failures.push('active cancel probe did not report cancellation requested');
  }
  const checks = [
    ['statusLatencyMs.p95', metrics.statusLatencyMs && metrics.statusLatencyMs.p95, LATENCY_THRESHOLDS_MS.statusCancelP95],
    ['statusLatencyMs.p99', metrics.statusLatencyMs && metrics.statusLatencyMs.p99, LATENCY_THRESHOLDS_MS.statusCancelP99],
    ['statusLatencyMs.max', metrics.statusLatencyMs && metrics.statusLatencyMs.max, LATENCY_THRESHOLDS_MS.statusCancelMax],
    ['cancelLatencyMs.p95', metrics.cancelLatencyMs && metrics.cancelLatencyMs.p95, LATENCY_THRESHOLDS_MS.statusCancelP95],
    ['cancelLatencyMs.p99', metrics.cancelLatencyMs && metrics.cancelLatencyMs.p99, LATENCY_THRESHOLDS_MS.statusCancelP99],
    ['cancelLatencyMs.max', metrics.cancelLatencyMs && metrics.cancelLatencyMs.max, LATENCY_THRESHOLDS_MS.statusCancelMax],
    ['eventLoopLatencyMs.max', metrics.eventLoopLatencyMs && metrics.eventLoopLatencyMs.max, LATENCY_THRESHOLDS_MS.mainHeartbeatMaxGap]
  ];
  for (const [name, rawValue, threshold] of checks) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value > threshold) {
      failures.push(`${name} exceeded ${threshold}ms threshold: ${value}`);
    }
  }
  return failures;
}

// @req REL-DOC-007
function fileSizeIfExists(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

// @req REL-DOC-007
function listIndexLikeFiles(corpusPath) {
  const names = new Set([
    '.doculight-search-index.json',
    'search-index.sqlite3',
    'search-index.sqlite3-wal',
    'search-index.sqlite3-shm'
  ]);
  const found = [];
  const stack = [corpusPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    } else if (stat.isFile() && names.has(path.basename(current))) {
      found.push(current);
    }
  }
  return found;
}

// @req REL-DOC-007
function probeWorkerNative() {
  return new Promise((resolve) => {
    const worker = new Worker(`
      const { parentPort } = require('worker_threads');
      function probeBetterSqlite3() {
        try {
          const Database = require('better-sqlite3');
          const db = new Database(':memory:');
          db.prepare('SELECT 1 AS ok').get();
          db.close();
          return { state: 'loaded', moduleVersion: process.versions.modules || null };
        } catch (err) {
          return {
            state: 'native_unavailable',
            code: err && err.code ? err.code : null,
            message: err && err.message ? String(err.message).slice(0, 160) : String(err),
            moduleVersion: process.versions.modules || null
          };
        }
      }
      function probeHnswlibNode() {
        try {
          require('hnswlib-node');
          return { state: 'loaded', moduleVersion: process.versions.modules || null };
        } catch (err) {
          return {
            state: 'native_unavailable',
            code: err && err.code ? err.code : null,
            message: err && err.message ? String(err.message).slice(0, 160) : String(err),
            moduleVersion: process.versions.modules || null
          };
        }
      }
      parentPort.postMessage({
        betterSqlite3: probeBetterSqlite3(),
        hnswlibNode: probeHnswlibNode(),
        electronAbi: null,
        nodeAbi: process.versions.modules || null
      });
    `, { eval: true });
    const timer = setTimeout(() => {
      try { worker.terminate(); } catch { /* ignore */ }
      resolve({
        betterSqlite3: { state: 'native_unavailable', message: 'worker native probe timeout' },
        hnswlibNode: { state: 'native_unavailable', message: 'worker native probe timeout' },
        electronAbi: null,
        nodeAbi: process.versions.modules || null
      });
    }, 10000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* ignore */ }
      resolve(message);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      resolve({
        betterSqlite3: { state: 'native_unavailable', message: err && err.message ? err.message : String(err) },
        hnswlibNode: { state: 'native_unavailable', message: err && err.message ? err.message : String(err) },
        electronAbi: null,
        nodeAbi: process.versions.modules || null
      });
    });
  });
}

// @req REL-DOC-007
function createBenchmarkStore(corpusPath) {
  return {
    get(key, defaultValue) {
      if (key === 'mcpAutoSave') return true;
      if (key === 'mcpAutoSavePath') return corpusPath;
      return defaultValue;
    }
  };
}

// @req REL-DOC-007
async function measureActiveCancel({ corpusPath, indexDataDir }) {
  fs.mkdirSync(indexDataDir, { recursive: true });
  const engine = new SearchEngine(createBenchmarkStore(corpusPath), {
    indexBackend: 'sqlite',
    indexDataDir,
    keywordTokenizerProvider: 'basic'
  });
  const cancelLatencies = [];
  let startResult = null;
  let cancelResult = null;
  try {
    startResult = engine.startRebuild();
    const statusBeforeCancel = engine.getStatus();
    const cancelStart = process.hrtime.bigint();
    cancelResult = engine.cancelRebuild();
    cancelLatencies.push(Number(process.hrtime.bigint() - cancelStart) / 1e6);
    if (engine._rebuildPromise) {
      await engine._rebuildPromise.catch(() => {});
    }
    return {
      activeCancelStarted: Boolean(startResult && (startResult.started === true || startResult.scheduled === true)),
      activeCancelRequested: Boolean(cancelResult && cancelResult.cancelled === true),
      activeCancelStateBefore: statusBeforeCancel && statusBeforeCancel.state ? statusBeforeCancel.state : null,
      cancelLatencyMs: buildLatencyStats(cancelLatencies)
    };
  } finally {
    engine.close();
  }
}

// @req REL-DOC-007
async function measureWorkerRebuild({ corpusPath, tempRoot, indexDataDir }) {
  const cancelProbe = await measureActiveCancel({
    corpusPath,
    indexDataDir: path.join(tempRoot, 'cancel-probe-index-data')
  });
  const engine = new SearchEngine(createBenchmarkStore(corpusPath), {
    indexBackend: 'sqlite',
    indexDataDir,
    keywordTokenizerProvider: 'basic'
  });
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const statusLatencies = [];
  const memorySamples = [process.memoryUsage().rss];
  const start = process.hrtime.bigint();
  let startResult = null;
  let finalStatus = null;
  let sampleTimer = null;
  try {
    startResult = engine.startRebuild();
    sampleTimer = setInterval(() => {
      const statusStart = process.hrtime.bigint();
      engine.getStatus();
      const statusElapsed = Number(process.hrtime.bigint() - statusStart) / 1e6;
      statusLatencies.push(statusElapsed);
      memorySamples.push(process.memoryUsage().rss);
    }, STATUS_SAMPLE_INTERVAL_MS);
    if (sampleTimer.unref) sampleTimer.unref();

    if (engine._rebuildPromise) {
      await engine._rebuildPromise;
    } else if (startResult && startResult.status) {
      engine.getStatus();
    }
    finalStatus = engine.getStatus();
  } finally {
    if (sampleTimer) clearInterval(sampleTimer);
    eventLoop.disable();
  }

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const indexPath = path.join(indexDataDir, 'search-index.sqlite3');
  const indexedCount = engine.docMeta && typeof engine.docMeta.size === 'number' ? engine.docMeta.size : 0;
  engine.close();
  return {
    phaseWallTimeMs: elapsedMs,
    peakRssBytes: Math.max(...memorySamples, process.memoryUsage().rss),
    dbBytes: fileSizeIfExists(indexPath),
    walBytes: fileSizeIfExists(`${indexPath}-wal`),
    shmBytes: fileSizeIfExists(`${indexPath}-shm`),
    eventLoopLatencyMs: {
      p95: eventLoop.percentile(95) / 1e6,
      p99: eventLoop.percentile(99) / 1e6,
      max: eventLoop.max / 1e6
    },
    statusLatencyMs: buildLatencyStats(statusLatencies),
    statusSampleCount: statusLatencies.length,
    workerRebuildStarted: Boolean(startResult && startResult.started === true),
    workerRebuildScheduled: Boolean(startResult && startResult.scheduled === true),
    workerRebuildCompleted: Boolean(finalStatus && finalStatus.state === 'ready' && indexedCount > 0),
    workerFinalState: finalStatus && finalStatus.state ? finalStatus.state : null,
    indexedCount,
    ...cancelProbe
  };
}

// @req REL-DOC-007
async function buildBenchmarkReport({ corpusPath, generated, tempRoot, outPath }) {
  const indexDataDir = path.join(tempRoot, 'temp-index-data');
  fs.mkdirSync(indexDataDir, { recursive: true });
  const stats = collectCorpusStats(corpusPath);
  const workerNative = await probeWorkerNative();
  const measured = await measureWorkerRebuild({ corpusPath, tempRoot, indexDataDir });
  const metrics = {
    corpusBytes: stats.corpusBytes,
    corpusFileCount: stats.corpusFileCount,
    maxFileBytes: stats.maxFileBytes,
    largeSingleFileFixtureBytes: stats.maxFileBytes,
    largeSingleFileFixtureMode: 'sparse-file',
    ...measured,
    workerNative
  };
  const contractFailures = collectContractFailures(metrics);

  return {
    version: BENCHMARK_VERSION,
    status: contractFailures.length > 0 ? 'failed' : 'completed',
    source: {
      mode: generated ? 'generated-temp-corpus' : 'configured-corpus',
      corpusPath,
      generated
    },
    tempIndexDataDir: indexDataDir,
    artifactPath: outPath,
    safety: {
      writesRealUserDataIndex: false,
      sourceRootIndexFilesCreated: false,
      benchmarkSkipped: false
    },
    metrics,
    contractFailures
  };
}

// @req REL-DOC-007
function printHelp() {
  console.log([
    'Usage: node scripts/bench-search-index-worker.js [--corpus PATH | --generated-temp-corpus] [--out PATH] [--json] [--cleanup-temp]',
    '',
    'Runs the REL-DOC-007 search index worker benchmark contract against a configured corpus or generated temp corpus.',
    'The benchmark writes a temp-index artifact and never writes the configured source corpus or app userData index.'
  ].join('\n'));
}

// @req REL-DOC-007
async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-index-worker-bench-'));
  const generated = args.generatedTempCorpus || !args.corpusPath;
  const corpusPath = generated ? createGeneratedCorpus(tempRoot) : path.resolve(args.corpusPath);
  if (!fs.existsSync(corpusPath) || !fs.statSync(corpusPath).isDirectory()) {
    throw new Error(`Configured benchmark corpus does not exist or is not a directory: ${corpusPath}`);
  }

  const outPath = args.outPath
    ? path.resolve(args.outPath)
    : path.join(tempRoot, 'search-index-worker-benchmark.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const report = await buildBenchmarkReport({ corpusPath, generated, tempRoot, outPath });
  report.safety.sourceRootIndexFilesCreated = listIndexLikeFiles(corpusPath).length > 0;
  if (report.safety.sourceRootIndexFilesCreated) {
    report.status = 'failed';
    report.contractFailures.push('sourceRootIndexFilesCreated must be false');
  }
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

  if (args.json) {
    console.log(JSON.stringify({ ok: report.status === 'completed', artifactPath: outPath, metrics: report.metrics, contractFailures: report.contractFailures }));
  } else {
    console.log(`REL-DOC-007 search index worker benchmark completed: ${outPath}`);
  }

  const resolvedOutPath = path.resolve(outPath);
  const resolvedTempRoot = path.resolve(tempRoot);
  if (args.cleanupTemp && !resolvedOutPath.startsWith(`${resolvedTempRoot}${path.sep}`)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (report.status !== 'completed') {
    throw new Error(`REL-DOC-007 benchmark contract failed: ${report.contractFailures.join('; ')}`);
  }
  return 0;
}

if (require.main === module) {
  (async () => {
    try {
      process.exit(await run());
    } catch (err) {
      console.error(err && err.stack ? err.stack : String(err));
      process.exit(2);
    }
  })();
} else {
  module.exports = {
    BENCHMARK_VERSION,
    LARGE_SINGLE_FILE_BYTES,
    parseArgs,
    createGeneratedCorpus,
    collectCorpusStats,
    buildBenchmarkReport,
    run
  };
}
