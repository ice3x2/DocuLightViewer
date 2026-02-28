// test/test-tokenizer.js — Unit tests for tokenizer.js and search-engine.js
'use strict';

const { tokenize } = require('../src/main/tokenizer');
const { SearchEngine } = require('../src/main/search-engine');
const { parseFrontmatter } = require('../src/main/frontmatter');
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.error(`  \u2717 ${message}`);
  }
}

function assertEq(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.error(`  \u2717 ${message}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

// ============================================================
console.log('\n=== tokenize: basic ===');

(() => {
  const tokens = tokenize('Hello World');
  assert(tokens.includes('hello'), 'lowercases English');
  assert(tokens.includes('world'), 'splits on space');
  assert(tokens.includes('he'), 'has bi-gram "he"');
  assert(tokens.includes('lo'), 'has bi-gram "lo"');
})();

(() => {
  assertEq(tokenize('').length, 0, 'empty string returns empty array');
  assertEq(tokenize(null).length, 0, 'null returns empty array');
  assertEq(tokenize(undefined).length, 0, 'undefined returns empty array');
  assertEq(tokenize(123).length, 0, 'number returns empty array');
})();

// ============================================================
console.log('\n=== tokenize: Korean ===');

(() => {
  const tokens = tokenize('전자문서 관리 시스템');
  assert(tokens.includes('전자문서'), 'includes full word "전자문서"');
  assert(tokens.includes('관리'), 'includes "관리"');
  assert(tokens.includes('시스템'), 'includes "시스템"');
  assert(tokens.includes('전자'), 'has bi-gram "전자"');
  assert(tokens.includes('문서'), 'has bi-gram "문서"');
})();

(() => {
  const tokens = tokenize('시스템을 구축합니다');
  assert(tokens.includes('시스템'), 'suffix stripping: 시스템을 → 시스템');
  assert(tokens.includes('구축'), 'suffix stripping: 구축합니다 → 구축');
})();

(() => {
  const tokens = tokenize('문서에서 검색하는 기능');
  assert(tokens.includes('문서'), 'strips 에서: 문서에서 → 문서');
})();

// ============================================================
console.log('\n=== tokenize: mixed ===');

(() => {
  const tokens = tokenize('REST API 설계 문서');
  assert(tokens.includes('rest'), 'English lowered');
  assert(tokens.includes('api'), 'English word');
  assert(tokens.includes('설계'), 'Korean word');
})();

// ============================================================
console.log('\n=== tokenize: bi-gram cross-word matching ===');

(() => {
  // "전자문서" should share bi-grams with "전자 문서"
  const t1 = tokenize('전자문서');
  const t2 = tokenize('전자 문서');
  // Both should contain bi-gram "전자"
  assert(t1.includes('전자'), 'compound has bi-gram "전자"');
  assert(t2.includes('전자'), 'split has bi-gram "전자"');
  // Both should contain bi-gram "문서"
  assert(t1.includes('문서'), 'compound has bi-gram "문서"');
  assert(t2.includes('문서'), 'split has bi-gram "문서"');
})();

// ============================================================
console.log('\n=== parseFrontmatter ===');

(() => {
  const { data, body } = parseFrontmatter('---\nproject: P1\ndocName: Doc\n---\n# Title\n\nBody');
  assertEq(data.project, 'P1', 'parses project');
  assertEq(data.docName, 'Doc', 'parses docName');
  assertEq(body, '# Title\n\nBody', 'extracts body');
})();

(() => {
  const { data, body } = parseFrontmatter('# No frontmatter');
  assertEq(Object.keys(data).length, 0, 'no frontmatter returns empty data');
  assertEq(body, '# No frontmatter', 'body is whole content');
})();

// ============================================================
console.log('\n=== SearchEngine: basic lifecycle ===');

(async () => {
  // Create temp directory with test documents
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-test-'));
  const dateDir = path.join(tmpDir, '2026-02-27');
  fs.mkdirSync(dateDir, { recursive: true });

  // Create test documents with frontmatter
  const docs = [
    { name: 'doc1.md', content: '---\nproject: ProjectA\ndocName: API Reference\ndescription: REST API documentation\n---\n# API Reference\n\nThis document describes the REST API endpoints.' },
    { name: 'doc2.md', content: '---\nproject: ProjectA\ndocName: User Guide\ndescription: Installation and setup guide\n---\n# User Guide\n\n전자문서 관리 시스템 설치 가이드입니다.' },
    { name: 'doc3.md', content: '---\nproject: ProjectB\ndocName: Release Notes\ndescription: Version history\n---\n# Release Notes\n\nDocuLight v0.10.5 릴리스 노트' },
    { name: 'doc4.md', content: '# Plain Document\n\nNo frontmatter, just a simple markdown file about testing.' },
  ];

  for (const doc of docs) {
    fs.writeFileSync(path.join(dateDir, doc.name), doc.content, 'utf-8');
  }

  // Create mock store
  const mockStore = {
    _data: { mcpAutoSave: true, mcpAutoSavePath: tmpDir },
    get(key, defaultVal) { return this._data[key] !== undefined ? this._data[key] : defaultVal; }
  };

  const se = new SearchEngine(mockStore);

  // Test rebuild
  const buildResult = await se.rebuild();
  assertEq(buildResult.indexed, 4, 'indexes all 4 documents');
  assertEq(se.docMeta.size, 4, 'docMeta has 4 entries');

  // Test search_documents
  console.log('\n=== SearchEngine: search_documents ===');

  const r1 = se.search('API');
  assert(r1.length > 0, 'finds results for "API"');
  assertEq(r1[0].title, 'API Reference', 'top result is API Reference');

  const r2 = se.search('전자문서');
  assert(r2.length > 0, 'finds results for Korean "전자문서"');

  const r3 = se.search('DocuLight');
  assert(r3.length > 0, 'finds results for "DocuLight"');

  // Test project filter
  const r4 = se.search('document', { project: 'ProjectA' });
  for (const item of r4) {
    assertEq(item.project, 'ProjectA', `filtered result project is ProjectA: ${item.title}`);
  }

  // Test search_projects
  console.log('\n=== SearchEngine: search_projects ===');

  const p1 = se.searchProjects();
  assert(p1.length >= 2, 'at least 2 projects');
  const projA = p1.find(p => p.project === 'ProjectA');
  assert(projA !== undefined, 'ProjectA found');
  assertEq(projA.documentCount, 2, 'ProjectA has 2 docs');

  const p2 = se.searchProjects('ProjectB');
  assert(p2.length > 0, 'finds ProjectB by name');
  assertEq(p2[0].project, 'ProjectB', 'correct project returned');

  // Test index save/load
  console.log('\n=== SearchEngine: index persistence ===');

  const indexPath = path.join(tmpDir, '.doculight-search-index.json');
  assert(fs.existsSync(indexPath), 'index file created after rebuild');

  const se2 = new SearchEngine(mockStore);
  await se2.initialize();
  assertEq(se2.docMeta.size, 4, 'loaded index has 4 entries');

  const r5 = se2.search('API');
  assert(r5.length > 0, 'search works after index load');

  // Test markDirty + ensureFresh
  console.log('\n=== SearchEngine: dirty/fresh ===');

  se2.markDirty();
  assertEq(se2.dirty, true, 'markDirty sets dirty flag');
  await se2.ensureFresh();
  assertEq(se2.dirty, false, 'ensureFresh clears dirty flag');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Final report
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  process.exit(failed > 0 ? 1 : 0);
})();
