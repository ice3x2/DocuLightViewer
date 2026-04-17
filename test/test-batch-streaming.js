// test/test-batch-streaming.js — step28 Phase 1: onBatch + AbortSignal 검증
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { buildDirectoryTree, buildSidebarTree } = require('../src/main/link-parser');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-batch-'));
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function createMdFiles(dir, count) {
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, `file-${String(i).padStart(4, '0')}.md`), `# File ${i}\n\nhello\n`);
  }
}

(async () => {
  // ---------------------------------------------------------------------
  // Test 1: 150 files → 3 batches of 50 (BATCH_SIZE=50)
  // ---------------------------------------------------------------------
  {
    const dir = createTempDir();
    try {
      createMdFiles(dir, 150);
      const chunks = [];
      const tree = await buildDirectoryTree(dir, 0, { count: 0 }, {
        onBatch: (nodes) => chunks.push(nodes)
      });
      assert.strictEqual(chunks.length, 3, `expected 3 batches, got ${chunks.length}`);
      assert.strictEqual(chunks[0].length, 50);
      assert.strictEqual(chunks[1].length, 50);
      assert.strictEqual(chunks[2].length, 50);
      assert.strictEqual(tree.children.length, 150);
      console.log('PASS: 150 files → 3 batches × 50');
    } finally { rmDir(dir); }
  }

  // ---------------------------------------------------------------------
  // Test 2: 10 files → 1 partial batch
  // ---------------------------------------------------------------------
  {
    const dir = createTempDir();
    try {
      createMdFiles(dir, 10);
      const chunks = [];
      const tree = await buildDirectoryTree(dir, 0, { count: 0 }, {
        onBatch: (nodes) => chunks.push(nodes)
      });
      assert.strictEqual(chunks.length, 1);
      assert.strictEqual(chunks[0].length, 10);
      assert.strictEqual(tree.children.length, 10);
      console.log('PASS: 10 files → 1 batch × 10');
    } finally { rmDir(dir); }
  }

  // ---------------------------------------------------------------------
  // Test 3: onBatch omitted → 100% identical behavior (regression)
  // ---------------------------------------------------------------------
  {
    const dir = createTempDir();
    try {
      createMdFiles(dir, 25);
      const tree1 = await buildDirectoryTree(dir);                          // legacy signature
      const tree2 = await buildDirectoryTree(dir, 0, { count: 0 }, {});     // new signature, no onBatch
      assert.strictEqual(tree1.children.length, tree2.children.length, 'length differ');
      for (let i = 0; i < tree1.children.length; i++) {
        assert.strictEqual(tree1.children[i].path, tree2.children[i].path);
      }
      console.log('PASS: onBatch omitted → identical output');
    } finally { rmDir(dir); }
  }

  // ---------------------------------------------------------------------
  // Test 4: AbortSignal → AbortError throw
  // ---------------------------------------------------------------------
  {
    const dir = createTempDir();
    try {
      createMdFiles(dir, 500);
      const controller = new AbortController();
      // abort before any batch completes
      controller.abort();
      let caught = null;
      try {
        await buildDirectoryTree(dir, 0, { count: 0 }, { signal: controller.signal });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'expected AbortError throw');
      assert.strictEqual(caught.name, 'AbortError', `expected name=AbortError, got ${caught && caught.name}`);
      console.log('PASS: AbortSignal → AbortError');
    } finally { rmDir(dir); }
  }

  // ---------------------------------------------------------------------
  // Test 5: AbortSignal after first batch → AbortError mid-scan
  // ---------------------------------------------------------------------
  {
    const dir = createTempDir();
    try {
      createMdFiles(dir, 150);
      const controller = new AbortController();
      const chunks = [];
      let caught = null;
      try {
        await buildDirectoryTree(dir, 0, { count: 0 }, {
          signal: controller.signal,
          onBatch: (nodes) => {
            chunks.push(nodes);
            if (chunks.length === 1) controller.abort();  // abort after first batch
          }
        });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'expected abort mid-scan');
      assert.strictEqual(caught.name, 'AbortError');
      assert.strictEqual(chunks.length, 1, 'first batch should have been delivered');
      assert.strictEqual(chunks[0].length, 50);
      console.log('PASS: Mid-scan abort → 1 batch delivered, then AbortError');
    } finally { rmDir(dir); }
  }

  // ---------------------------------------------------------------------
  // Test 6: onBatch callback error → warned but scan continues
  // ---------------------------------------------------------------------
  {
    const dir = createTempDir();
    try {
      createMdFiles(dir, 120);
      const originalWarn = console.warn;
      let warnCount = 0;
      console.warn = () => { warnCount++; };
      try {
        const tree = await buildDirectoryTree(dir, 0, { count: 0 }, {
          onBatch: () => { throw new Error('boom'); }
        });
        assert.strictEqual(tree.children.length, 120, 'scan should have completed');
        assert.ok(warnCount >= 1, 'warn should have been emitted');
      } finally { console.warn = originalWarn; }
      console.log('PASS: onBatch exception isolated (scan continues)');
    } finally { rmDir(dir); }
  }

  // ---------------------------------------------------------------------
  // Test 7: buildSidebarTree options propagation
  // ---------------------------------------------------------------------
  {
    const dir = createTempDir();
    try {
      createMdFiles(dir, 80);
      const rootMd = path.join(dir, 'file-0000.md');
      const chunks = [];
      const tree = await buildSidebarTree(rootMd, {
        onBatch: (nodes) => chunks.push(nodes)
      });
      assert.ok(tree, 'tree returned');
      assert.ok(chunks.length >= 1, 'onBatch invoked at least once');
      console.log('PASS: buildSidebarTree propagates options');
    } finally { rmDir(dir); }
  }

  // ---------------------------------------------------------------------
  // Test 8: Pre-aborted signal on buildSidebarTree throws immediately
  // ---------------------------------------------------------------------
  {
    const dir = createTempDir();
    try {
      createMdFiles(dir, 10);
      const rootMd = path.join(dir, 'file-0000.md');
      const controller = new AbortController();
      controller.abort();
      let caught = null;
      try {
        await buildSidebarTree(rootMd, { signal: controller.signal });
      } catch (err) { caught = err; }
      assert.ok(caught);
      assert.strictEqual(caught.name, 'AbortError');
      console.log('PASS: buildSidebarTree pre-aborted → AbortError');
    } finally { rmDir(dir); }
  }

  console.log('\n=== All Phase 1 batch streaming tests passed ===');
})().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
