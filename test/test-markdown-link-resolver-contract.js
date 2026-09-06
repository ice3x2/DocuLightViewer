'use strict';

// FR-WIN-014 / FR-RENDER-014 / FR-RENDER-024
// Markdown link hrefs are percent-encoded by the renderer's markdown parser, so
// every navigation path must decode them before touching the filesystem, and the
// decoding must happen in exactly one place that both window navigation and tab
// navigation go through.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  decodeHrefPath,
  isMarkdownExtension,
  isUsableLinkBase,
  resolveMarkdownDocumentPath,
  resolveMarkdownLinkTarget
} = require('../src/main/markdown-link-resolver');

const viewerSource = fs.readFileSync(path.join(__dirname, '../src/renderer/viewer.js'), 'utf-8');
const tabManagerSource = fs.readFileSync(path.join(__dirname, '../src/renderer/tab-manager.js'), 'utf-8');
const preloadSource = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf-8');
const indexSource = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf-8');
const windowManagerSource = fs.readFileSync(path.join(__dirname, '../src/main/window-manager.js'), 'utf-8');
const linkParserSource = fs.readFileSync(path.join(__dirname, '../src/main/link-parser.js'), 'utf-8');

// The module builds real filesystem paths, so the fixtures have to be shaped
// like the paths of the platform the test is running on.
const docsRoot = process.platform === 'win32' ? path.join('C:', 'docs') : path.join(path.sep, 'docs');
const baseDoc = path.join(docsRoot, 'index.md');

function expectTarget(href, expected, label) {
  assert.strictEqual(resolveMarkdownLinkTarget(href, baseDoc), expected, label);
}

function expectRejected(href, label) {
  assert.strictEqual(resolveMarkdownLinkTarget(href, baseDoc), null, label);
}

// --- decodeHrefPath: the single percent-decoder shared by every link consumer ---

assert.strictEqual(typeof decodeHrefPath, 'function', 'decodeHrefPath is exported');
assert.strictEqual(
  decodeHrefPath('%ED%95%9C%EA%B8%80%EB%AC%B8%EC%84%9C.md'),
  '한글문서.md',
  'percent-encoded Korean file names decode back to their original characters'
);
assert.strictEqual(
  decodeHrefPath('plain-english.md'),
  'plain-english.md',
  'ASCII hrefs pass through unchanged'
);
assert.strictEqual(
  decodeHrefPath('%E0%A4%A.md'),
  '%E0%A4%A.md',
  'malformed percent sequences keep their original text instead of throwing'
);
// The markdown parser turns `%` back into a bare `%` after encoding, so a file
// name containing one arrives as a mix of decodable runs and a literal percent.
// Decoding has to be per-run: giving up on the whole string leaves the encoded
// text as the file name and the document never opens.
assert.strictEqual(
  decodeHrefPath('%EC%A7%84%ED%96%89%EB%A5%A0%2080%.md'),
  '진행률 80%.md',
  'a literal trailing percent does not stop the rest of the name from decoding'
);
assert.strictEqual(
  decodeHrefPath('100%%20done.md'),
  '100% done.md',
  'a literal percent in front of a valid sequence keeps both intact'
);
assert.strictEqual(
  decodeHrefPath('%EC%A7%84%ED%96%89%EB%A5%A0%25.md'),
  '진행률%.md',
  'an explicitly encoded percent decodes alongside the rest of the name'
);

// --- resolveMarkdownLinkTarget: href -> absolute markdown path ---

assert.strictEqual(typeof resolveMarkdownLinkTarget, 'function', 'resolveMarkdownLinkTarget is exported');

expectTarget(
  './%ED%95%9C%EA%B8%80%EB%AC%B8%EC%84%9C.md',
  path.join(docsRoot, '한글문서.md'),
  'a percent-encoded Korean sibling document resolves to its real path'
);
expectTarget(
  './english.md',
  path.join(docsRoot, 'english.md'),
  'an ASCII sibling document keeps working'
);
expectTarget(
  '../%ED%95%98%EC%9C%84%ED%8F%B4%EB%8D%94/%EB%B3%B4%EA%B3%A0%EC%84%9C.md',
  path.resolve(docsRoot, '..', '하위폴더', '보고서.md'),
  'encoded directory segments decode as well as the file name'
);
expectTarget(
  'my%20report.md',
  path.join(docsRoot, 'my report.md'),
  'encoded spaces in ASCII names decode too'
);
expectTarget(
  './%EC%A7%84%ED%96%89%EB%A5%A0%2080%.md',
  path.join(docsRoot, '진행률 80%.md'),
  'a Korean name ending in a literal percent sign resolves to the real file'
);
expectTarget(
  './%ED%95%9C%EA%B8%80%EB%AC%B8%EC%84%9C.md#%EC%A0%9C%EB%AA%A9',
  path.join(docsRoot, '한글문서.md'),
  'fragment suffixes are stripped before decoding the path'
);
expectTarget(
  './%ED%95%9C%EA%B8%80%EB%AC%B8%EC%84%9C.md?v=2',
  path.join(docsRoot, '한글문서.md'),
  'query suffixes are stripped before decoding the path'
);
expectTarget(
  './%ED%95%9C%EA%B8%80%EB%AC%B8%EC%84%9C',
  path.join(docsRoot, '한글문서.md'),
  'an extension-less encoded href gains the .md extension after decoding'
);
expectTarget(
  './%ED%95%9C%EA%B8%80%EB%AC%B8%EC%84%9C.MARKDOWN',
  path.join(docsRoot, '한글문서.MARKDOWN'),
  'uppercase .markdown is accepted'
);
expectTarget(
  path.join(docsRoot, '이미절대경로.md'),
  path.join(docsRoot, '이미절대경로.md'),
  'an already absolute path is returned normalized'
);

if (process.platform === 'win32') {
  expectTarget(
    '.\\%ED%95%9C%EA%B8%80%EB%AC%B8%EC%84%9C.md',
    path.join(docsRoot, '한글문서.md'),
    'backslash separators are accepted on Windows'
  );
}

assert.strictEqual(
  resolveMarkdownLinkTarget('./한글문서.md', baseDoc),
  path.join(docsRoot, '한글문서.md'),
  'an href that was never encoded still resolves'
);
assert.strictEqual(
  resolveMarkdownLinkTarget('sibling.md', ''),
  null,
  'a relative href without a base document is rejected instead of guessing the working directory'
);

// --- rejected hrefs ---

expectRejected('https://example.com/doc.md', 'https URLs are not local navigation targets');
expectRejected('http://example.com/doc.md', 'http URLs are not local navigation targets');
expectRejected('javascript:alert(1)', 'javascript scheme is rejected');
expectRejected('data:text/plain,hello', 'data scheme is rejected');
expectRejected('mailto:someone@example.com', 'mailto scheme is rejected');
expectRejected('//example.com/share/doc.md', 'protocol-relative hrefs are rejected');
expectRejected('\\\\host\\share\\doc.md', 'UNC paths are rejected');
expectRejected('./image.png', 'non-markdown extensions are rejected');
expectRejected('./note.txt', 'non-markdown extensions are rejected');
expectRejected('#anchor-only', 'anchor-only hrefs are not navigation targets');
expectRejected('', 'empty hrefs are rejected');
expectRejected('   ', 'blank hrefs are rejected');
expectRejected(null, 'non-string hrefs are rejected');

// Percent-encoding must not smuggle a rejected shape past the guards: the same
// checks run on the decoded value, not only on the raw href.
expectRejected('%2F%2Fexample.com/share/doc.md', 'encoded protocol-relative hrefs stay rejected after decoding');
expectRejected('%5C%5Chost%5Cshare%5Cdoc.md', 'encoded UNC paths stay rejected after decoding');
expectRejected('javascript%3Aalert(1)', 'encoded javascript scheme stays rejected after decoding');
expectRejected('http%3A%2F%2Fexample.com/doc.md', 'encoded http URLs stay rejected after decoding');
expectRejected('./doc%00.md', 'NUL bytes are rejected');
// Mixed separators only become a network location once the path is normalized,
// so the guard has to run on the resolved value as well as the raw href.
// Windows only: on POSIX a backslash is an ordinary file name character, so
// `/\host\share\doc.md` names a local file and rejecting it would be wrong.
if (process.platform === 'win32') {
  expectRejected('/\\host\\share\\doc.md', 'a mixed-separator href that normalizes to UNC is rejected');
  expectRejected('%2F%5Chost%5Cshare%5Cdoc.md', 'an encoded mixed-separator UNC href is rejected');
}

// --- resolveMarkdownDocumentPath: an already-resolved path is never decoded again ---
// A link click crosses two hops (renderer -> resolve, then main -> navigate), so a
// path that came back from the first hop must survive the second one untouched.
// Percent sequences that are part of the real file name would otherwise be eaten.

const literalPercentDoc = path.join(docsRoot, 'discount%20list.md');
assert.strictEqual(
  resolveMarkdownDocumentPath(literalPercentDoc, baseDoc),
  literalPercentDoc,
  'a resolved path keeps literal percent sequences in the file name'
);
assert.strictEqual(
  resolveMarkdownDocumentPath(path.join(docsRoot, '진행률 80%.md'), baseDoc),
  path.join(docsRoot, '진행률 80%.md'),
  'a resolved path keeps a bare percent sign'
);
assert.strictEqual(
  resolveMarkdownDocumentPath(path.join(docsRoot, 'C#가이드.md'), baseDoc),
  path.join(docsRoot, 'C#가이드.md'),
  'a resolved path keeps a hash in the file name instead of truncating at it'
);
assert.strictEqual(
  resolveMarkdownDocumentPath(path.join(docsRoot, '한글문서'), baseDoc),
  path.join(docsRoot, '한글문서.md'),
  'a resolved path without an extension still gains .md'
);
assert.strictEqual(
  resolveMarkdownDocumentPath('sibling.md', baseDoc),
  path.join(docsRoot, 'sibling.md'),
  'a relative path resolves against the base document'
);

for (const rejected of [null, '', '   ', './image.png', 'javascript:alert(1)', '//example.com/doc.md', '\\\\host\\share\\doc.md', 'doc\0.md']) {
  assert.strictEqual(
    resolveMarkdownDocumentPath(rejected, baseDoc),
    null,
    `resolveMarkdownDocumentPath rejects ${JSON.stringify(rejected)}`
  );
}

// Resolving twice must land on the same file: this is what the two-hop click path
// actually does, and what a single-decode implementation silently got wrong.
for (const href of [
  './%ED%95%9C%EA%B8%80%EB%AC%B8%EC%84%9C.md',
  './english.md',
  'my%20report.md',
  './%ED%99%95%EC%9E%A5%EC%9E%90%EC%97%86%EC%9D%8C',
  './discount%2520list.md'
]) {
  const once = resolveMarkdownLinkTarget(href, baseDoc);
  assert.strictEqual(
    resolveMarkdownDocumentPath(once, baseDoc),
    once,
    `resolving ${href} and then navigating to the result stays on the same file`
  );
}

// --- isUsableLinkBase: which base the resolve-link-target handler may trust ---

assert.strictEqual(isUsableLinkBase(baseDoc), true, 'an absolute document path is a usable base');
assert.strictEqual(isUsableLinkBase('relative/doc.md'), false, 'a relative path is not a usable base');
assert.strictEqual(isUsableLinkBase(''), false, 'an empty string is not a usable base');
assert.strictEqual(isUsableLinkBase(null), false, 'null is not a usable base');
assert.strictEqual(isUsableLinkBase(undefined), false, 'undefined is not a usable base');
assert.strictEqual(isUsableLinkBase({}), false, 'a non-string is not a usable base');
assert.strictEqual(isUsableLinkBase(baseDoc + '\0'), false, 'a NUL-bearing path is not a usable base');

// --- isMarkdownExtension: the one markdown extension policy ---

assert.strictEqual(isMarkdownExtension('.md'), true, '.md is markdown');
assert.strictEqual(isMarkdownExtension('.markdown'), true, '.markdown is markdown');
assert.strictEqual(isMarkdownExtension('.MD'), true, 'extension matching is case-insensitive');
assert.strictEqual(isMarkdownExtension('.txt'), false, '.txt is not markdown');
assert.strictEqual(isMarkdownExtension(''), false, 'an empty extension is not markdown');

// --- window navigation delegates to the shared resolver (FR-WIN-014) ---

const { WindowManager } = require('../src/main/window-manager');
assert.strictEqual(typeof WindowManager, 'function', 'WindowManager is exported for contract testing');

const navigationEntry = { meta: { filePath: baseDoc } };
assert.strictEqual(
  WindowManager.prototype._resolveNavigationPath.call({}, navigationEntry, path.join(docsRoot, '한글문서.md')),
  path.join(docsRoot, '한글문서.md'),
  'navigateTo opens the resolved Korean document it was handed'
);
assert.strictEqual(
  WindowManager.prototype._resolveNavigationPath.call({}, navigationEntry, literalPercentDoc),
  literalPercentDoc,
  'navigateTo does not decode again, so literal percent sequences survive the second hop'
);
// The message is localized through strings.js, which is uninitialized outside
// Electron, so the contract asserted here is the rejection itself.
for (const rejected of ['./image.png', 'javascript:alert(1)', '//example.com/doc.md', '\\\\host\\share\\doc.md']) {
  assert.throws(
    () => WindowManager.prototype._resolveNavigationPath.call({}, navigationEntry, rejected),
    Error,
    `navigateTo path resolution rejects ${rejected}`
  );
}

// --- structural contract: href decoding and path policy live in one module ---
// These guard the architecture the fix depends on, so they check concepts (does
// this module still decode? does it still decide what a markdown path is?) rather
// than exact implementation lines.

assert(
  /require\(['"]\.\/markdown-link-resolver['"]\)/.test(linkParserSource),
  'link-parser decodes hrefs and applies the extension policy through the shared module'
);
assert(
  !/decodeURIComponent\(/.test(linkParserSource),
  'link-parser keeps no second percent decoder'
);

assert(
  /require\(['"]\.\/markdown-link-resolver['"]\)/.test(windowManagerSource),
  'window navigation resolves targets through the shared module'
);
assert(
  /require\(['"]\.\/markdown-link-resolver['"]\)/.test(indexSource),
  'the main process resolves link targets through the shared module'
);
assert(
  /ipcMain\.handle\(\s*['"]resolve-link-target['"]/.test(indexSource),
  'the main process answers resolve-link-target'
);
assert(
  /invoke\(\s*['"]resolve-link-target['"]/.test(preloadSource),
  'preload bridges resolve-link-target to the renderer'
);

assert(
  /resolveLinkTarget\(/.test(viewerSource),
  'the viewer link click handler asks the main process for the target'
);
assert(
  !viewerSource.includes('getLocalMarkdownHrefTarget'),
  'the viewer no longer classifies local markdown hrefs on its own'
);

assert(
  !/decodeURIComponent\(/.test(tabManagerSource),
  'tab navigation never decodes an href'
);
assert(
  !/\.markdown/.test(tabManagerSource),
  'tab navigation keeps no markdown extension policy of its own'
);
assert(
  !/isAbsolutePath/.test(tabManagerSource),
  'tab navigation makes no judgement about path shape, which is what looped on root-relative Windows paths'
);

console.log('markdown link resolver contract: PASS');
