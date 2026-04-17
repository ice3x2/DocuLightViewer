// test/test-link-tree.js — Test buildDirectoryTree output for directory-based tree
'use strict';

const path = require('path');
const { buildDirectoryTree } = require('../src/main/link-parser');

const TARGET_DIR = 'C:/Work/git/_Snoworca/ProjectMaster/docs/plan/srs.step2';

function printTree(node, indent = 0) {
  const prefix = '  '.repeat(indent) + (indent > 0 ? '├─ ' : '');
  const childCount = node.children ? node.children.length : 0;
  const existsMark = node.exists ? '' : ' [NOT FOUND]';
  const typeIcon = node.isDirectory ? '[DIR]' : '[FILE]';
  console.log(`${prefix}${typeIcon} ${node.title} (children: ${childCount})${existsMark}`);
  if (node.children) {
    for (const child of node.children) {
      printTree(child, indent + 1);
    }
  }
}

(async () => {
  // Build the tree (비동기 전환됨 — step27 Phase 2)
  const tree = await buildDirectoryTree(path.resolve(TARGET_DIR));

  console.log('=== DIRECTORY TREE STRUCTURE ===\n');
  printTree(tree);

  // Count occurrences of each title
  console.log('\n=== DUPLICATE DETECTION ===\n');
  const titleCount = {};
  function countTitles(node) {
    const key = node.title;
    titleCount[key] = (titleCount[key] || 0) + 1;
    if (node.children) {
      for (const child of node.children) {
        countTitles(child);
      }
    }
  }
  countTitles(tree);

  const duplicates = Object.entries(titleCount).filter(([, count]) => count > 1);
  if (duplicates.length === 0) {
    console.log('No duplicates found.');
  } else {
    console.log('Duplicates:');
    for (const [title, count] of duplicates) {
      console.log(`  "${title}" appears ${count} times`);
    }
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
