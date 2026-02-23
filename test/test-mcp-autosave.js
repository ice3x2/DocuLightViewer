// test/test-mcp-autosave.js — Unit tests for MCP auto-save helper functions
// Run with: node test/test-mcp-autosave.js

'use strict';

// === 테스트 대상 함수 (index.js / mcp-http.mjs 와 동일한 로직) ===

function sanitizeFilenameWithUrlEncode(str) {
  const ENCODE_MAP = {
    '<': '%3C', '>': '%3E', ':': '%3A', '"': '%22',
    '/': '%2F', '\\': '%5C', '|': '%7C', '?': '%3F', '*': '%2A'
  };
  return str.replace(/[<>:"/\\|?*\x00-\x1f]/g, c => ENCODE_MAP[c] || encodeURIComponent(c));
}

function extractTitleFromContent(content) {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+)/);
    if (m) return m[1].trim();
  }
  for (const line of lines) {
    const t = line.trim();
    if (t) return t.slice(0, 50);
  }
  return null;
}

// === 테스트 유틸리티 ===

let passed = 0;
let failed = 0;

function assert(description, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// === sanitizeFilenameWithUrlEncode 테스트 ===

console.log('\n[sanitizeFilenameWithUrlEncode]');

assert(
  '공백은 그대로 보존',
  sanitizeFilenameWithUrlEncode('Hello World'),
  'Hello World'
);

assert(
  '한글은 그대로 보존',
  sanitizeFilenameWithUrlEncode('한글 파일'),
  '한글 파일'
);

assert(
  ': 는 URL 인코딩',
  sanitizeFilenameWithUrlEncode('파일:이름'),
  '파일%3A이름'
);

assert(
  '< > : " / \\ | ? * 모두 인코딩',
  sanitizeFilenameWithUrlEncode('a<b>c"d/e\\f|g?h*i'),
  'a%3Cb%3Ec%22d%2Fe%5Cf%7Cg%3Fh%2Ai'
);

assert(
  '제어문자 인코딩',
  sanitizeFilenameWithUrlEncode('test\x00null'),
  'test%00null'
);

assert(
  '정상 문자 혼합',
  sanitizeFilenameWithUrlEncode('Report: Q1 2024'),
  'Report%3A Q1 2024'
);

// === extractTitleFromContent 테스트 ===

console.log('\n[extractTitleFromContent]');

assert(
  '# 제목 추출',
  extractTitleFromContent('# 제목\n내용'),
  '제목'
);

assert(
  '## 제목도 인식 (첫 번째 heading)',
  extractTitleFromContent('## h2\n# h1'),
  'h2'
);

assert(
  '### 레벨 3 heading',
  extractTitleFromContent('### 세 번째\n내용'),
  '세 번째'
);

assert(
  '일반 텍스트 → 첫 줄',
  extractTitleFromContent('일반 텍스트'),
  '일반 텍스트'
);

assert(
  '빈 문자열 → null',
  extractTitleFromContent(''),
  null
);

assert(
  'null → null',
  extractTitleFromContent(null),
  null
);

assert(
  '빈 줄 스킵 후 텍스트',
  extractTitleFromContent('   \n\n텍스트'),
  '텍스트'
);

assert(
  '공백만 있는 내용 → null',
  extractTitleFromContent('   \n  \n  '),
  null
);

// 50자 초과 테스트
const longLine = 'A'.repeat(60);
assert(
  '50자 초과 첫 줄은 50자로 자름',
  extractTitleFromContent(longLine),
  'A'.repeat(50)
);

assert(
  'heading 텍스트 앞뒤 공백 trim',
  extractTitleFromContent('#   공백 있는 제목   '),
  '공백 있는 제목'
);

assert(
  'heading 없을 때 첫 번째 비어있지 않은 줄',
  extractTitleFromContent('\n\n첫 번째 줄\n두 번째 줄'),
  '첫 번째 줄'
);

// === 결과 출력 ===

console.log(`\n결과: ${passed} 통과, ${failed} 실패`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('모든 테스트 통과!');
}
