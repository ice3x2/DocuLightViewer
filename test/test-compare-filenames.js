'use strict';
const assert = require('assert');
const path = require('path');
const { compareFileNames } = require(path.join(__dirname, '..', 'src', 'main', 'link-parser'));

console.log('=== compareFileNames tests ===');

// Test: Korean vs Latin sorting consistency (en locale)
{
  const files = ['한글파일.md', 'abc.md', '가나다.md', 'xyz.md'];
  const sorted = [...files].sort(compareFileNames);
  const latinIdx1 = sorted.indexOf('abc.md');
  const latinIdx2 = sorted.indexOf('xyz.md');
  const koreanIdx1 = sorted.indexOf('한글파일.md');
  const koreanIdx2 = sorted.indexOf('가나다.md');
  assert.ok(latinIdx1 < koreanIdx1, `Latin 'abc.md' (${latinIdx1}) should sort before Korean '한글파일.md' (${koreanIdx1})`);
  assert.ok(latinIdx2 < koreanIdx2, `Latin 'xyz.md' (${latinIdx2}) should sort before Korean '가나다.md' (${koreanIdx2})`);
  console.log('PASS: Korean vs Latin sorting with en locale');
}

// Test: Numeric prefix sorting
{
  const files = ['10.md', '02.md', '01.md'];
  const sorted = [...files].sort(compareFileNames);
  assert.deepStrictEqual(sorted, ['01.md', '02.md', '10.md']);
  console.log('PASS: Numeric prefix sorting');
}

// Test: Sub-number sorting
{
  const files = ['02.md', '01-1.md', '01.md'];
  const sorted = [...files].sort(compareFileNames);
  assert.deepStrictEqual(sorted, ['01.md', '01-1.md', '02.md']);
  console.log('PASS: Sub-number sorting');
}

console.log('=== All compareFileNames tests passed ===');
