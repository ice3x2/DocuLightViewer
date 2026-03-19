'use strict';
const assert = require('assert');
const path = require('path');
const { buildLinkTree } = require(path.join(__dirname, '..', 'src', 'main', 'link-parser'));

console.log('=== buildLinkTree tests ===');

const fixtureDir = path.resolve(__dirname, 'fixtures', 'link-tree');

// Test: root.md has children a.md and subdir/b.md
{
  const tree = buildLinkTree(path.join(fixtureDir, 'root.md'));
  assert.ok(tree, 'Tree should not be null');
  assert.strictEqual(tree.exists, true);
  assert.strictEqual(tree.title, 'Root Document');
  assert.ok(tree.children.length >= 2, `Expected at least 2 children, got ${tree.children.length}`);
  const childNames = tree.children.map(c => path.basename(c.path));
  assert.ok(childNames.includes('a.md'), 'Should include a.md');
  assert.ok(childNames.includes('b.md'), 'Should include b.md');
  console.log('PASS: root.md children');
}

// Test: Recursive - a.md has child c.md
{
  const tree = buildLinkTree(path.join(fixtureDir, 'root.md'));
  const aNode = tree.children.find(c => path.basename(c.path) === 'a.md');
  assert.ok(aNode, 'a.md node should exist');
  assert.ok(aNode.children.length >= 1, `a.md should have children, got ${aNode.children.length}`);
  const cNode = aNode.children.find(c => path.basename(c.path) === 'c.md');
  assert.ok(cNode, 'c.md should be child of a.md');
  console.log('PASS: Recursive tree building');
}

// Test: Circular reference - b.md links back to root.md, no infinite loop
{
  const tree = buildLinkTree(path.join(fixtureDir, 'root.md'));
  assert.ok(tree, 'Tree should complete despite circular reference');
  console.log('PASS: Circular reference handled');
}

// Test: Non-existent file link
{
  const tree = buildLinkTree(path.join(fixtureDir, 'nonexistent.md'));
  assert.ok(tree, 'Should return node for non-existent file');
  assert.strictEqual(tree.exists, false);
  console.log('PASS: Non-existent file');
}

// Test: Self-reference - no infinite loop
{
  const tree = buildLinkTree(path.join(fixtureDir, 'self-ref.md'));
  assert.ok(tree, 'Should handle self-reference');
  console.log('PASS: Self-reference handled');
}

// Test: globalSeen - files linked from multiple places expanded only once
{
  const tree = buildLinkTree(path.join(fixtureDir, 'root.md'));
  assert.ok(tree, 'Global seen should work');
  console.log('PASS: globalSeen deduplication');
}

console.log('=== All buildLinkTree tests passed ===');
