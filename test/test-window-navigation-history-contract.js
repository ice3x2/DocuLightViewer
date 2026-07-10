'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { NavigationHistory } = require('../src/main/window-manager');
const windowManagerSource = fs.readFileSync(path.join(__dirname, '../src/main/window-manager.js'), 'utf-8');

function normalizeParts(...parts) {
  return path.join(...parts);
}

function assertSnapshot(history, expected) {
  const snapshot = history.snapshot();
  assert.deepStrictEqual(
    snapshot.stack,
    expected.stack,
    `${expected.label}: stack preserves the expected document visit order`
  );
  assert.deepStrictEqual(
    snapshot.trail,
    expected.trail,
    `${expected.label}: breadcrumb trail exposes entries up to the current index`
  );
  assert.strictEqual(snapshot.index, expected.index, `${expected.label}: current index`);
  assert.strictEqual(snapshot.current, expected.current, `${expected.label}: current document`);
  assert.strictEqual(snapshot.canGoBack, expected.canGoBack, `${expected.label}: canGoBack`);
  assert.strictEqual(snapshot.canGoForward, expected.canGoForward, `${expected.label}: canGoForward`);

  snapshot.stack.push('mutated.md');
  assert.notDeepStrictEqual(
    history.snapshot().stack,
    snapshot.stack,
    `${expected.label}: snapshot returns defensive copies`
  );
}

const docsRoot = normalizeParts('C:', 'docs');
const docA = normalizeParts(docsRoot, 'A.md');
const docC = normalizeParts(docsRoot, 'C.md');
const docX = normalizeParts(docsRoot, 'X.md');
const docY = normalizeParts(docsRoot, 'Y.md');

assert.strictEqual(typeof NavigationHistory, 'function', 'NavigationHistory is exported for contract testing');
assert(windowManagerSource.includes('const MIN_VIEWER_WIDTH = 200;'), 'viewer windows define a 200px minimum width');
assert(windowManagerSource.includes('const MIN_VIEWER_HEIGHT = 300;'), 'viewer windows define a 300px minimum height');
assert((windowManagerSource.match(/minWidth:\s*MIN_VIEWER_WIDTH/g) || []).length >= 2, 'viewer BrowserWindow creation paths enforce minimum width');
assert((windowManagerSource.match(/minHeight:\s*MIN_VIEWER_HEIGHT/g) || []).length >= 2, 'viewer BrowserWindow creation paths enforce minimum height');
assert(windowManagerSource.includes('Math.max(Math.min(saved.width, workArea.width), MIN_VIEWER_WIDTH)'), 'saved viewer window width is clamped to the minimum');
assert(windowManagerSource.includes('Math.max(Math.min(saved.height, workArea.height), MIN_VIEWER_HEIGHT)'), 'saved viewer window height is clamped to the minimum');

const history = new NavigationHistory();
assert.strictEqual(typeof history.snapshot, 'function', 'NavigationHistory exposes snapshot()');
assert.strictEqual(typeof history.jumpTo, 'function', 'NavigationHistory exposes jumpTo()');

history.push(docA);
history.push(docC);
history.push(docX);
history.push(docA);

assertSnapshot(history, {
  label: 'repeated link traversal',
  stack: [docA, docC, docX, docA],
  trail: [docA, docC, docX, docA],
  index: 3,
  current: docA,
  canGoBack: true,
  canGoForward: false
});

assert.strictEqual(
  history.jumpTo(1, { truncateForward: true }),
  docC,
  'jumpTo returns the selected breadcrumb document'
);

assertSnapshot(history, {
  label: 'breadcrumb truncate to selected segment',
  stack: [docA, docC],
  trail: [docA, docC],
  index: 1,
  current: docC,
  canGoBack: true,
  canGoForward: false
});

history.push(docX);
assert.strictEqual(history.back(), docC, 'back returns the previous document');
assertSnapshot(history, {
  label: 'back preserves forward history',
  stack: [docA, docC, docX],
  trail: [docA, docC],
  index: 1,
  current: docC,
  canGoBack: true,
  canGoForward: true
});

history.push(docY);
assertSnapshot(history, {
  label: 'push after back discards forward history',
  stack: [docA, docC, docY],
  trail: [docA, docC, docY],
  index: 2,
  current: docY,
  canGoBack: true,
  canGoForward: false
});

const bounded = new NavigationHistory({ maxSize: 3 });
bounded.push(docA);
bounded.push(docC);
bounded.push(docX);
bounded.push(docY);
assertSnapshot(bounded, {
  label: 'bounded history trims oldest entries',
  stack: [docC, docX, docY],
  trail: [docC, docX, docY],
  index: 2,
  current: docY,
  canGoBack: true,
  canGoForward: false
});

assert.throws(
  () => history.jumpTo(99, { truncateForward: true }),
  /history index/i,
  'jumpTo rejects out-of-range breadcrumb indexes'
);

console.log('test-window-navigation-history-contract: all assertions passed');
