'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const {
  normalizePastedMarkdownPathCandidate,
  resolveReadablePastedMarkdownPath
} = require('../src/main/pasted-markdown-path');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

function pasteAssert(condition, message) {
  assert(condition, `FR-RENDER-025/FR-WIN-014 pasted markdown path contract: ${message}`);
}

pasteAssert(
  normalizePastedMarkdownPathCandidate('C:/Docs/Guide.md', { platform: 'win32' }) === path.win32.normalize('C:/Docs/Guide.md'),
  'Windows drive absolute paths with forward slashes are accepted'
);
pasteAssert(
  normalizePastedMarkdownPathCandidate('C:\\Docs\\Guide.md', { platform: 'win32' }) === path.win32.normalize('C:\\Docs\\Guide.md'),
  'Windows drive absolute paths with backslashes are accepted'
);
pasteAssert(
  normalizePastedMarkdownPathCandidate('/docs/Guide.md', { platform: 'linux' }) === path.posix.normalize('/docs/Guide.md'),
  'POSIX absolute markdown paths are accepted'
);
pasteAssert(
  normalizePastedMarkdownPathCandidate('docs/Guide.md', { platform: 'linux' }) === null,
  'relative markdown paths are not treated as paste-open candidates'
);
pasteAssert(
  normalizePastedMarkdownPathCandidate('C:/Docs/Guide.txt', { platform: 'win32' }) === null,
  'non-md extensions are rejected'
);
pasteAssert(
  normalizePastedMarkdownPathCandidate('C:/Docs/Guide.md\n# title', { platform: 'win32' }) === null,
  'multi-line clipboard text is rejected as a path candidate'
);

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-paste-path-'));
  try {
    const readablePath = path.join(tempDir, 'Readable.md');
    fs.writeFileSync(readablePath, '# Readable paste target\n', 'utf-8');

    const resolved = await resolveReadablePastedMarkdownPath(` "${readablePath}" `);
    pasteAssert(resolved === path.normalize(readablePath), 'readable absolute .md path resolves after trimming and quote removal');

    const missing = await resolveReadablePastedMarkdownPath(path.join(tempDir, 'Missing.md'));
    pasteAssert(missing === null, 'missing absolute .md path is not resolved');

    const directoryPath = path.join(tempDir, 'Directory.md');
    fs.mkdirSync(directoryPath);
    const directoryResolved = await resolveReadablePastedMarkdownPath(directoryPath);
    pasteAssert(directoryResolved === null, 'absolute .md directories are not resolved as pasted documents');

    const viewerJs = read('src/renderer/viewer.js');
    pasteAssert(viewerJs.includes('looksLikeAbsoluteMarkdownPathPaste'), 'renderer detects path-like paste text before routing non-empty viewers');
    pasteAssert(viewerJs.includes('getCurrentPastePlatform'), 'renderer resolves the active platform before path-like paste detection');
    pasteAssert(/platform\s*===\s*['"]win32['"][\s\S]*\^\[A-Za-z\]:/.test(viewerJs), 'renderer only treats drive-letter absolute paths as Windows path paste candidates on Windows');
    pasteAssert(viewerJs.includes('allowMarkdownFallback'), 'renderer tells main whether Markdown text fallback is allowed');

    const mainJs = read('src/main/index.js');
    pasteAssert(mainJs.includes('resolveReadablePastedMarkdownPath'), 'main process validates readable pasted markdown paths');
    pasteAssert(/windowManager\.navigateTo\(windowId,\s*pastedFilePath\)/.test(mainJs), 'main process opens readable pasted markdown paths through window navigation');

    console.log('PASS: FR-RENDER-025/FR-WIN-014 pasted markdown path contract');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
