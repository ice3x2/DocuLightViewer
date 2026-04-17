'use strict';
const assert = require('assert');
const path = require('path');
const { buildSidebarTree, collectLinkedPaths, markLinkedNodes } = require(path.join(__dirname, '..', 'src', 'main', 'link-parser'));

console.log('=== buildSidebarTree tests ===');

const fixtureDir = path.resolve(__dirname, 'fixtures', 'link-tree');

// Helper: find node by basename in tree
function findNode(node, basename) {
  if (path.basename(node.path) === basename) return node;
  for (const c of (node.children || [])) {
    const found = findNode(c, basename);
    if (found) return found;
  }
  return null;
}

(async () => {
  // Test: File with links -> merged tree
  {
    const tree = await buildSidebarTree(path.join(fixtureDir, 'root.md'));
    assert.ok(tree, 'Should return tree');
    assert.strictEqual(tree.treeType, 'merged', `Expected treeType 'merged', got '${tree.treeType}'`);
    console.log('PASS: Merged tree for file with links');
  }

  // Test: Merged tree has linked attribute on linked files
  {
    const tree = await buildSidebarTree(path.join(fixtureDir, 'root.md'));
    assert.strictEqual(tree.treeType, 'merged');

    const aNode = findNode(tree, 'a.md');
    assert.ok(aNode, 'a.md should exist in merged tree');
    assert.strictEqual(aNode.linked, true, 'a.md should be marked linked');

    // isolated.md는 linked 아님
    const isoNode = findNode(tree, 'isolated.md');
    assert.ok(isoNode, 'isolated.md should exist');
    assert.ok(!isoNode.linked, 'isolated.md should not be linked');

    console.log('PASS: Linked attribute marking in merged tree');
  }

  // Test: File without links -> directory tree fallback
  {
    const tree = await buildSidebarTree(path.join(fixtureDir, 'isolated.md'));
    assert.ok(tree, 'Should return tree');
    assert.strictEqual(tree.treeType, 'directory', `Expected treeType 'directory', got '${tree.treeType}'`);
    console.log('PASS: Directory fallback for isolated file');
  }

  // Test: Self-reference only -> directory fallback (totalFiles == 1)
  {
    const tree = await buildSidebarTree(path.join(fixtureDir, 'self-ref.md'));
    assert.ok(tree, 'Should return tree');
    assert.strictEqual(tree.treeType, 'directory', `Expected directory fallback for self-ref, got '${tree.treeType}'`);
    console.log('PASS: Directory fallback for self-referencing file');
  }

  // Test: External-only links -> directory fallback
  {
    const tree = await buildSidebarTree(path.join(fixtureDir, 'external-only.md'));
    assert.ok(tree, 'Should return tree');
    assert.strictEqual(tree.treeType, 'directory', `Expected directory fallback for external-only, got '${tree.treeType}'`);
    console.log('PASS: Directory fallback for external-only links');
  }

  // Test: Code-only links -> directory fallback
  {
    const tree = await buildSidebarTree(path.join(fixtureDir, 'code-links.md'));
    assert.ok(tree, 'Should return tree');
    assert.strictEqual(tree.treeType, 'directory', `Expected directory fallback for code-links, got '${tree.treeType}'`);
    console.log('PASS: Directory fallback for code-block-only links');
  }

  // Test: External links in virtual directory
  {
    const tree = await buildSidebarTree(path.join(fixtureDir, 'has-external.md'));
    assert.ok(tree, 'Should return tree');
    assert.strictEqual(tree.treeType, 'merged', `Expected 'merged' for has-external, got '${tree.treeType}'`);
    // 외부 링크가 __external_links__ 가상 디렉토리에 있어야 함
    const extDir = tree.children.find(c => c.isVirtual);
    assert.ok(extDir, 'External links section should exist');
    assert.ok(extDir.children.length > 0, 'Should have external links');
    assert.strictEqual(extDir.title, '__external_links__');
    console.log('PASS: External links in virtual directory');
  }

  // Test: collectLinkedPaths helper
  {
    const mockTree = {
      path: '/a/b.md', children: [
        { path: '/a/c.md', children: [] },
        { path: '/a/d.md', children: [] }
      ]
    };
    const paths = collectLinkedPaths(mockTree);
    assert.strictEqual(paths.size, 3);
    console.log('PASS: collectLinkedPaths collects all paths');
  }

  // Test: markLinkedNodes helper
  {
    const dirNode = {
      path: '/a/b.md', children: [
        { path: '/a/c.md', children: [] }
      ]
    };
    const linked = new Set([path.normalize('/a/c.md').toLowerCase()]);
    markLinkedNodes(dirNode, linked);
    assert.strictEqual(dirNode.children[0].linked, true, 'c.md should be marked linked');
    assert.strictEqual(linked.size, 0, 'matched path should be removed from set');
    console.log('PASS: markLinkedNodes marks and removes matched paths');
  }

  console.log('=== All buildSidebarTree tests passed ===');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
