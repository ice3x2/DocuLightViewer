// test/test-frontmatter.js — Unit tests for frontmatter.js
'use strict';

const { injectFrontmatter, parseSimpleYaml, buildYamlBlock } = require('../src/main/frontmatter');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEq(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

// ============================================================
console.log('\n=== parseSimpleYaml ===');

(() => {
  const result = parseSimpleYaml('project: MyApp\ndocName: README');
  assertEq(result.project, 'MyApp', 'parses plain values');
  assertEq(result.docName, 'README', 'parses second field');
})();

(() => {
  const result = parseSimpleYaml('title: "Hello World"\nfoo: \'bar\'');
  assertEq(result.title, 'Hello World', 'strips double quotes');
  assertEq(result.foo, 'bar', 'strips single quotes');
})();

(() => {
  const result = parseSimpleYaml('');
  assertEq(Object.keys(result).length, 0, 'empty string returns empty object');
})();

(() => {
  const result = parseSimpleYaml('key:value');
  assertEq(result.key, 'value', 'colon without space still parses (\\s* allows zero spaces)');
})();

(() => {
  const result = parseSimpleYaml('key: value with spaces');
  assertEq(result.key, 'value with spaces', 'preserves spaces in value');
})();

// ============================================================
console.log('\n=== buildYamlBlock ===');

(() => {
  const block = buildYamlBlock({ project: 'Test', docName: 'Doc' });
  assert(block.startsWith('---\n'), 'starts with ---');
  assert(block.endsWith('---\n'), 'ends with ---');
  assert(block.includes('project: Test'), 'includes project field');
  assert(block.includes('docName: Doc'), 'includes docName field');
})();

(() => {
  const block = buildYamlBlock({ title: 'Hello: World' });
  assert(block.includes('"Hello: World"'), 'quotes value with colon');
})();

(() => {
  const block = buildYamlBlock({ empty: '', nullVal: null, undef: undefined });
  assert(!block.includes('empty'), 'skips empty string');
  assert(!block.includes('nullVal'), 'skips null');
  assert(!block.includes('undef'), 'skips undefined');
})();

// ============================================================
console.log('\n=== injectFrontmatter (no existing frontmatter) ===');

(() => {
  const content = '# Hello\n\nSome text.';
  const result = injectFrontmatter(content, { project: 'P1', docName: 'Doc1', description: 'A test doc' });

  assert(result.startsWith('---\n'), 'prepends frontmatter block');
  assert(result.includes('project: P1'), 'includes project');
  assert(result.includes('docName: Doc1'), 'includes docName');
  assert(result.includes('description: A test doc'), 'includes description');
  assert(result.includes('date: '), 'includes auto-generated date');
  assert(result.endsWith('# Hello\n\nSome text.'), 'original content preserved after frontmatter');
})();

(() => {
  const content = '# Hello';
  const result = injectFrontmatter(content, { project: 'P1' });
  assert(result.includes('project: P1'), 'works with single field');
  assert(!result.includes('docName'), 'omits unset fields');
  assert(!result.includes('description'), 'omits unset description');
})();

// ============================================================
console.log('\n=== injectFrontmatter (merge with existing) ===');

(() => {
  const content = '---\nproject: OldProject\nauthor: John\n---\n# Title';
  const result = injectFrontmatter(content, { project: 'NewProject', docName: 'Doc2' });

  assert(result.includes('project: NewProject'), 'new value overrides existing');
  assert(result.includes('author: John'), 'preserves existing fields');
  assert(result.includes('docName: Doc2'), 'adds new fields');
  assert(result.includes('# Title'), 'body preserved after merge');

  // Should NOT have duplicate frontmatter blocks
  const fmCount = (result.match(/^---$/gm) || []).length;
  assertEq(fmCount, 2, 'exactly one frontmatter block (2 delimiters)');
})();

(() => {
  const content = '---\ntitle: "Special: chars"\n---\nBody';
  const result = injectFrontmatter(content, { description: 'test' });
  assert(result.includes('title:'), 'preserves existing title with special chars');
  assert(result.includes('description: test'), 'adds description');
  assert(result.includes('Body'), 'body preserved');
})();

// ============================================================
console.log('\n=== injectFrontmatter (no metadata provided) ===');

(() => {
  const content = '# No meta';
  // All fields undefined/empty
  const result = injectFrontmatter(content, {});
  // Should still inject date
  assert(result.includes('date: '), 'date is always injected');
  assert(result.includes('# No meta'), 'content preserved');
})();

// ============================================================
console.log('\n=== Viewer-side parseFrontmatter simulation ===');
// Simulates the same logic that viewer.js uses

function parseFrontmatter(markdown) {
  const fmRegex = /^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/;
  const match = markdown.match(fmRegex);
  if (!match) return { meta: null, body: markdown };
  const yamlContent = match[1] || '';
  const meta = {};
  for (const line of yamlContent.split(/\r?\n/)) {
    const m = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (m) {
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      meta[m[1]] = value;
    }
  }
  return { meta, body: markdown.slice(match[0].length) };
}

(() => {
  const input = '---\nproject: P1\ndocName: Doc1\ndescription: Hello\ndate: 2026-02-27T10:00:00\n---\n# Title\n\nBody';
  const { meta, body } = parseFrontmatter(input);

  assertEq(meta.project, 'P1', 'viewer parses project');
  assertEq(meta.docName, 'Doc1', 'viewer parses docName');
  assertEq(meta.description, 'Hello', 'viewer parses description');
  assert(meta.date.startsWith('2026'), 'viewer parses date');
  assertEq(body, '# Title\n\nBody', 'viewer strips frontmatter from body');
})();

(() => {
  const input = '# No frontmatter\n\nJust content';
  const { meta, body } = parseFrontmatter(input);

  assertEq(meta, null, 'returns null meta when no frontmatter');
  assertEq(body, input, 'body is unchanged');
})();

(() => {
  const input = '---\n---\n# Empty frontmatter';
  const { meta, body } = parseFrontmatter(input);

  assertEq(Object.keys(meta).length, 0, 'empty frontmatter gives empty meta');
  assertEq(body, '# Empty frontmatter', 'body after empty frontmatter');
})();

// ============================================================
console.log('\n=== Round-trip: inject → parse ===');

(() => {
  const original = '# Round Trip Test\n\nContent here.';
  const injected = injectFrontmatter(original, { project: 'RTP', docName: 'RTDoc', description: 'Round trip' });
  const { meta, body } = parseFrontmatter(injected);

  assertEq(meta.project, 'RTP', 'round-trip project matches');
  assertEq(meta.docName, 'RTDoc', 'round-trip docName matches');
  assertEq(meta.description, 'Round trip', 'round-trip description matches');
  assert(meta.date !== undefined, 'round-trip date exists');
  assertEq(body, original, 'round-trip body matches original');
})();

(() => {
  // Double injection (merge)
  const original = '# Double inject';
  const first = injectFrontmatter(original, { project: 'V1' });
  const second = injectFrontmatter(first, { project: 'V2', docName: 'Updated' });
  const { meta, body } = parseFrontmatter(second);

  assertEq(meta.project, 'V2', 'double inject: latest project wins');
  assertEq(meta.docName, 'Updated', 'double inject: new field added');
  assertEq(body, '# Double inject', 'double inject: body preserved');
})();

// ============================================================
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);
