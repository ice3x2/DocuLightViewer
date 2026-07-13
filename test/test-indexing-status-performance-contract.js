'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { SourceLedgerStore } = require('../src/main/source-ledger-store');
const { SearchEngine } = require('../src/main/search-engine');

const HISTORY_JOB_COUNT = 100000;
const ACTIVE_JOB_COUNT = 8;
const QUERY_BUDGET_MS = 250;
const COLD_INDEX_BUDGET_MS = 5000;
const RSS_GROWTH_BUDGET_BYTES = 32 * 1024 * 1024;
const INDEX_NAME = 'idx_index_jobs_type_status_updated';

function insertJob(db, job) {
  db.prepare(`
    INSERT INTO index_jobs(
      job_id, job_type, status, priority, requested_by, phase,
      progress_current, progress_total, cancel_requested,
      created_at, heartbeat_at, updated_at
    ) VALUES (
      @jobId, @jobType, @status, 0, 'test.status.performance', @phase,
      @progressCurrent, @progressTotal, 0,
      @createdAt, @updatedAt, @updatedAt
    )
  `).run(job);
}

function createSearchEngine(ledger) {
  const engine = new SearchEngine({ get(_key, defaultValue) { return defaultValue; } });
  engine._getAvailableSourceLedger = () => ledger;
  return engine;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-status-performance-'));
  const dbPath = path.join(tmp, 'smart-search.sqlite3');
  const ledger = new SourceLedgerStore({ dbPath, userDataDir: tmp });

  try {
    ledger.initialize();
    const db = ledger.open();
    const insert = db.transaction(() => {
      const statement = db.prepare(`
        INSERT INTO index_jobs(
          job_id, job_type, status, priority, requested_by, phase,
          progress_current, progress_total, cancel_requested,
          created_at, finished_at, heartbeat_at, updated_at
        ) VALUES (
          @jobId, @jobType, @status, 0, 'test.status.history', @phase,
          @progressCurrent, @progressTotal, 0,
          @createdAt, @createdAt, @createdAt, @createdAt
        )
      `);
      for (let index = 0; index < HISTORY_JOB_COUNT; index += 1) {
        statement.run({
          jobId: `history-${index}`,
          jobType: index % 3 === 0 ? 'keyword_rebuild' : 'index_document',
          status: index % 2 === 0 ? 'completed' : 'failed',
          phase: 'terminal-history',
          progressCurrent: 999,
          progressTotal: 999,
          createdAt: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`
        });
      }
    });
    insert();

    const activeJobs = [
      { jobId: 'queued-1', jobType: 'index_document', status: 'queued', phase: 'queued-old', progressCurrent: 0, progressTotal: 0, createdAt: '2026-07-13T01:00:00.000Z', updatedAt: '2026-07-13T01:00:00.000Z' },
      { jobId: 'queued-2', jobType: 'index_document', status: 'queued', phase: 'queued-latest', progressCurrent: 0, progressTotal: 0, createdAt: '2026-07-13T01:00:01.000Z', updatedAt: '2026-07-13T01:00:10.000Z' },
      { jobId: 'queued-3', jobType: 'index_document', status: 'queued', phase: null, progressCurrent: 0, progressTotal: 0, createdAt: '2026-07-13T01:00:02.000Z', updatedAt: '2026-07-13T01:00:02.000Z' },
      { jobId: 'queued-4', jobType: 'index_document', status: 'queued', phase: null, progressCurrent: 0, progressTotal: 0, createdAt: '2026-07-13T01:00:03.000Z', updatedAt: '2026-07-13T01:00:03.000Z' },
      { jobId: 'queued-5', jobType: 'index_document', status: 'queued', phase: null, progressCurrent: 0, progressTotal: 0, createdAt: '2026-07-13T01:00:04.000Z', updatedAt: '2026-07-13T01:00:04.000Z' },
      { jobId: 'indexing-1', jobType: 'index_document', status: 'indexing', phase: 'tokenize', progressCurrent: 1, progressTotal: 4, createdAt: '2026-07-13T01:00:05.000Z', updatedAt: '2026-07-13T01:00:05.000Z' },
      { jobId: 'indexing-2', jobType: 'index_document', status: 'indexing', phase: 'embedding', progressCurrent: 2, progressTotal: 4, createdAt: '2026-07-13T01:00:06.000Z', updatedAt: '2026-07-13T01:00:06.000Z' },
      { jobId: 'indexing-3', jobType: 'index_document', status: 'indexing', phase: 'hnsw-latest', progressCurrent: 3, progressTotal: 4, createdAt: '2026-07-13T01:00:07.000Z', updatedAt: '2026-07-13T01:00:20.000Z' },
      { jobId: 'unrelated-active', jobType: 'keyword_rebuild', status: 'indexing', phase: 'must-not-count', progressCurrent: 800, progressTotal: 900, createdAt: '2026-07-13T01:00:08.000Z', updatedAt: '2026-07-13T01:00:30.000Z' }
    ];
    db.transaction(() => activeJobs.forEach((job) => insertJob(db, job)))();

    assert.strictEqual(
      typeof ledger.getSemanticIndexingProgress,
      'function',
      'SourceLedgerStore exposes a bounded semantic indexing progress aggregate'
    );

    const methodSource = String(ledger.getSemanticIndexingProgress);
    assert(!/SELECT\s+\*/i.test(methodSource), 'aggregate method never selects full job rows');
    assert(!/\.all\s*\(/.test(methodSource), 'aggregate method never materializes an array of job rows');

    const indexRow = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX_NAME);
    assert(indexRow, 'source ledger schema creates the active semantic job predicate/order index');
    const queryPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(*)
      FROM index_jobs
      WHERE job_type = 'index_document' AND status IN ('queued', 'indexing')
    `).all();
    assert(
      queryPlan.some((row) => String(row.detail || '').includes(INDEX_NAME)),
      `aggregate predicate uses ${INDEX_NAME}: ${JSON.stringify(queryPlan)}`
    );

    const queryStarted = performance.now();
    const aggregate = ledger.getSemanticIndexingProgress();
    const queryElapsedMs = performance.now() - queryStarted;
    assert.deepStrictEqual(aggregate, {
      state: 'indexing',
      phase: 'hnsw-latest',
      progressCurrent: 6,
      progressTotal: 17,
      pendingCount: ACTIVE_JOB_COUNT
    });
    assert(queryElapsedMs <= QUERY_BUDGET_MS, `aggregate query ${queryElapsedMs.toFixed(2)}ms exceeds ${QUERY_BUDGET_MS}ms`);
    assert(Buffer.byteLength(JSON.stringify(aggregate), 'utf8') < 512, 'aggregate result stays bounded and contains no job/path/diagnostic array');

    const engine = createSearchEngine(ledger);
    ledger.getIndexJobs = () => { throw new Error('legacy whole-row job API must not be called'); };
    assert.deepStrictEqual(engine.getSemanticIndexingProgress(), {
      state: 'indexing',
      phase: 'hnsw-latest',
      progress_current: 6,
      progress_total: 17,
      pendingCount: ACTIVE_JOB_COUNT
    });

    const originalAggregate = ledger.getSemanticIndexingProgress.bind(ledger);
    ledger.getSemanticIndexingProgress = () => { throw new Error('synthetic aggregate failure'); };
    assert.strictEqual(engine.getSemanticIndexingProgress(), null, 'aggregate SQL failure degrades to null status');
    ledger.getSemanticIndexingProgress = originalAggregate;

    const rssBefore = process.memoryUsage().rss;
    let maxQueryMs = 0;
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      const started = performance.now();
      ledger.getSemanticIndexingProgress();
      maxQueryMs = Math.max(maxQueryMs, performance.now() - started);
    }
    const rssGrowth = Math.max(0, process.memoryUsage().rss - rssBefore);
    assert(maxQueryMs <= QUERY_BUDGET_MS, `warm aggregate max ${maxQueryMs.toFixed(2)}ms exceeds ${QUERY_BUDGET_MS}ms`);
    assert(rssGrowth <= RSS_GROWTH_BUDGET_BYTES, `1000 bounded queries grew RSS by ${(rssGrowth / 1024 / 1024).toFixed(2)}MiB`);

    db.prepare("DELETE FROM index_jobs WHERE status IN ('queued', 'indexing')").run();
    assert.strictEqual(ledger.getSemanticIndexingProgress(), null, 'zero active semantic jobs returns null');

    db.prepare(`
      INSERT INTO index_jobs(
        job_id, job_type, status, priority, requested_by, phase,
        progress_current, progress_total, cancel_requested,
        created_at, heartbeat_at, updated_at
      ) VALUES (
        'queued-only', 'index_document', 'queued', 0, 'test.status.queued', 'queued-phase',
        0, 0, 0,
        '2026-07-13T02:00:00.000Z', '2026-07-13T02:00:00.000Z', '2026-07-13T02:00:00.000Z'
      )
    `).run();
    assert.deepStrictEqual(ledger.getSemanticIndexingProgress(), {
      state: 'queued',
      phase: 'queued-phase',
      progressCurrent: 0,
      progressTotal: 1,
      pendingCount: 1
    });

    db.prepare(`DROP INDEX ${INDEX_NAME}`).run();
    ledger.close();
    const coldStarted = performance.now();
    ledger.open();
    const coldIndexElapsedMs = performance.now() - coldStarted;
    assert(coldIndexElapsedMs <= COLD_INDEX_BUDGET_MS, `cold additive index creation ${coldIndexElapsedMs.toFixed(2)}ms exceeds ${COLD_INDEX_BUDGET_MS}ms`);

    console.log(JSON.stringify({
      test: 'test-indexing-status-performance-contract',
      historyJobs: HISTORY_JOB_COUNT,
      activeJobs: ACTIVE_JOB_COUNT,
      queryElapsedMs: Number(queryElapsedMs.toFixed(2)),
      maxWarmQueryMs: Number(maxQueryMs.toFixed(2)),
      rssGrowthMiB: Number((rssGrowth / 1024 / 1024).toFixed(2)),
      coldIndexElapsedMs: Number(coldIndexElapsedMs.toFixed(2))
    }));
  } finally {
    ledger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
