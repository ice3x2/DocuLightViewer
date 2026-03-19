'use strict';
const assert = require('assert');
const path = require('path');
const { extractMarkdownLinks } = require(path.join(__dirname, '..', 'src', 'main', 'link-parser'));

console.log('=== extractMarkdownLinks tests ===');

const basePath = path.resolve(__dirname, 'fixtures', 'link-tree');

// Test: Basic [text](file.md) extraction
{
  const content = '# Test\n[Link A](a.md)\n[Link B](b.md)\n';
  const links = extractMarkdownLinks(content, basePath);
  assert.strictEqual(links.length, 2);
  assert.strictEqual(path.basename(links[0].resolvedPath), 'a.md');
  assert.strictEqual(links[0].title, 'Link A');
  assert.strictEqual(path.basename(links[1].resolvedPath), 'b.md');
  console.log('PASS: Basic link extraction');
}

// Test: Wikilink [[file]] extraction
{
  const content = '# Test\n[[myfile]]\n';
  const links = extractMarkdownLinks(content, basePath);
  assert.strictEqual(links.length, 1);
  assert.ok(links[0].resolvedPath.endsWith('myfile.md'), `Expected .md extension, got: ${links[0].resolvedPath}`);
  console.log('PASS: Wikilink extraction');
}

// Test: Code block links ignored
{
  const content = '# Test\n```\n[fake](fake.md)\n```\nInline `[code](code.md)` here\n';
  const links = extractMarkdownLinks(content, basePath);
  assert.strictEqual(links.length, 0, `Expected 0 links, got ${links.length}`);
  console.log('PASS: Code block links ignored');
}

// Test: External URLs skipped
{
  const content = '[Google](https://google.com)\n[Local](local.md)\n';
  const links = extractMarkdownLinks(content, basePath);
  assert.strictEqual(links.length, 1);
  assert.ok(links[0].resolvedPath.endsWith('local.md'));
  console.log('PASS: External URLs skipped');
}

// Test: Anchor-only links skipped
{
  const content = '[Section](#section)\n[File](file.md)\n';
  const links = extractMarkdownLinks(content, basePath);
  assert.strictEqual(links.length, 1);
  console.log('PASS: Anchor-only links skipped');
}

// Test: Image extensions skipped
{
  const content = '![img](photo.png)\n[doc](doc.md)\n';
  const links = extractMarkdownLinks(content, basePath);
  assert.strictEqual(links.length, 1);
  assert.ok(links[0].resolvedPath.endsWith('doc.md'));
  console.log('PASS: Image extensions skipped');
}

// Test: Query string and anchor removal
{
  const content = '[File](file.md?v=1#section)\n';
  const links = extractMarkdownLinks(content, basePath);
  assert.strictEqual(links.length, 1);
  assert.ok(links[0].resolvedPath.endsWith('file.md'), `Should strip query/anchor, got: ${links[0].resolvedPath}`);
  console.log('PASS: Query string and anchor removal');
}

// Test: Relative path resolution
{
  const content = '[Sibling](../sibling/file.md)\n';
  const links = extractMarkdownLinks(content, basePath);
  assert.strictEqual(links.length, 1);
  assert.ok(links[0].resolvedPath.includes('sibling'), `Expected sibling in path, got: ${links[0].resolvedPath}`);
  console.log('PASS: Relative path resolution');
}

// Test: Duplicate removal
{
  const content = '[A](same.md)\n[B](same.md)\n';
  const links = extractMarkdownLinks(content, basePath);
  assert.strictEqual(links.length, 1, `Expected 1 unique link, got ${links.length}`);
  console.log('PASS: Duplicate removal');
}

console.log('=== All extractMarkdownLinks tests passed ===');
