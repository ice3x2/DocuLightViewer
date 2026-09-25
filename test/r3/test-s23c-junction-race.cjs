'use strict';

// @req FR-DOC-019 AC-10 FR-DOC-035 AC-8 AC-13
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OwnerWorkerController } = require('../../src/main/search-owner-controller');
const { createSourceLedgerStore } = require('../../src/main/source-ledger-store');

async function waitForPhase(gate, phase) {
  const deadline = Date.now() + 5000;
  while (Atomics.load(gate, 0) < phase && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(Atomics.load(gate, 0), phase, `race hook reached phase ${phase}`);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-s23c-race-'));
  const store = path.join(root, 'store');
  const inside = path.join(store, 'inside');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside);
  const insidePath = path.join(inside, 'file.md');
  const outsidePath = path.join(outside, 'file.md');
  fs.writeFileSync(insidePath, '# Inside\n');
  fs.writeFileSync(outsidePath, '# Outside\n');
  const alias = path.join(store, 'race');
  const link = target => fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  link(inside);
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const ledgerPath = path.join(root, 'index', 'smart-search.sqlite3');
  fs.mkdirSync(path.dirname(ledgerPath));
  const owner = new OwnerWorkerController({ ledgerPath,
    keywordPath: path.join(root, 'index', 'search-index.sqlite3'), sourceRoot: store,
    ingressRoot: path.join(root, 'ingress'), deriveDocuments: false,
    keywordTokenizerProvider: 'basic', r3AdoptRaceBuffer: gate.buffer,
    r3AdoptRaceLocator: 'race/file.md' });
  try {
    await owner.start();
    const pending = owner.command('adopt_contained', { sourceRelativeLocator: 'race/file.md' });
    await waitForPhase(gate, 1);
    fs.unlinkSync(alias);
    link(outside);
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    await waitForPhase(gate, 2);
    fs.unlinkSync(alias);
    link(inside);
    Atomics.store(gate, 1, 2);
    Atomics.notify(gate, 1);
    await assert.rejects(pending, error => error.code === 'owner_adopt_contained_failed',
      'opened handle from outside target must be rejected despite restored lexical realpath');
    const ledger = createSourceLedgerStore({ dbPath: ledgerPath, readOnly: true });
    try {
      assert.equal(ledger.open().prepare('SELECT count(*) AS count FROM documents').get().count, 0);
      assert.equal(ledger.open().prepare('SELECT count(*) AS count FROM index_jobs').get().count, 0);
    } finally { ledger.close(); }
    assert.equal(fs.readFileSync(insidePath, 'utf8'), '# Inside\n');
    assert.equal(fs.readFileSync(outsidePath, 'utf8'), '# Outside\n');
  } finally {
    Atomics.store(gate, 1, 3);
    Atomics.notify(gate, 1);
    await owner.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
