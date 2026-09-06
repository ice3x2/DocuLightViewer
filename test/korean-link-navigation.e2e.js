// test/korean-link-navigation.e2e.js — FR-WIN-014 / FR-RENDER-014 / FR-RENDER-024
// Non-ASCII document names survive the markdown parser's percent-encoding on the
// way from a clicked link to the file that actually gets opened, in both the
// single-window navigation path and the tab navigation path.
'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const root = path.resolve(__dirname, '..');
const ipcPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\doculight-korean-link-${process.pid}`
  : path.join(os.tmpdir(), `doculight-korean-link-${process.pid}.sock`);

let app;
let fixtureDir;

function writeDoc(relativeName, content) {
  const filePath = path.join(fixtureDir, relativeName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function sendIpcRequest(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `korean-link-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const socket = net.connect({ path: ipcPath }, () => {
      socket.write(JSON.stringify({ id, action, params }) + '\n');
    });

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx).trim();
      socket.end();
      try {
        const response = JSON.parse(line);
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result);
        }
      } catch (err) {
        reject(err);
      }
    });

    socket.on('error', reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error('IPC request timeout'));
    });
  });
}

async function waitForIpcServer(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await sendIpcRequest('list_viewers');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('IPC server not ready');
}

async function openFixture(filePath) {
  const result = await sendIpcRequest('open_markdown', { filePath, title: path.basename(filePath) });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const viewer = app.windows().find((win) => win.url().includes('viewer.html'));
  expect(viewer).toBeTruthy();
  return { result, viewer };
}

async function saveSettings(settings) {
  const temp = await sendIpcRequest('open_markdown', { content: '# Configure', title: 'Configure' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const viewer = app.windows().find((win) => win.url().includes('viewer.html'));
  if (viewer) {
    await viewer.evaluate(async (nextSettings) => {
      await window.doclight.saveSettings(nextSettings);
    }, settings);
  }
  await sendIpcRequest('close_viewer', { windowId: temp.windowId });
}

async function ensureSidebarVisible(viewer) {
  const container = viewer.locator('#sidebar-container');
  if (await container.evaluate((el) => el.classList.contains('hidden'))) {
    await viewer.locator('#btn-toggle-sidebar').click();
  }
  await expect(container).toBeVisible();
  await expect(viewer.locator('#sidebar-tree .tree-item').first()).toBeVisible();
}

async function clickSidebarFile(viewer, fileName) {
  await viewer.locator('#sidebar-tree .tree-item', { hasText: fileName }).first().evaluate((el) => {
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  });
}

async function clickContentLink(viewer, text) {
  await viewer.locator('#content a', { hasText: text }).evaluate((el) => {
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  });
}

test.describe('non-ASCII document link navigation', () => {
  test.setTimeout(60000);

  test.beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-korean-link-'));

    // Root-relative, i.e. drive-relative on Windows: the fixture lives on the same
    // drive as the temp directory, so dropping the drive letter still finds it.
    const rootRelativeHref = fixtureDir.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '') + '/루트상대.md';
    writeDoc('루트상대.md', '# 루트상대');

    writeDoc('시작문서.md', [
      '# 시작문서',
      '',
      '[한글 이웃 문서](./한글이웃.md)',
      '',
      // Angle brackets are how CommonMark carries a space in a destination; the
      // parser turns it into %20 exactly like it encodes non-ASCII names.
      '[공백 있는 영문](<./spaced report.md>)',
      '',
      '[한글 폴더 문서](./한글폴더/안쪽문서.md)',
      '',
      // The parser re-emits an encoded `%` as a bare one, so this href arrives as
      // a mix of decodable runs and a literal percent sign.
      '[퍼센트 있는 한글](<./진행률 80%.md>)',
      '',
      '[영문 문서](./english.md)',
      '',
      '[확장자 없는 한글](./확장자없음)',
      '',
      '[한글 앵커 링크](./한글이웃.md#섹션)',
      '',
      '[차단 대상 이미지](./그림.png)',
      '',
      '[차단 대상 스크립트](javascript:alert(1))',
      '',
      // A root-relative href normalizes to a drive-relative path on Windows. Tab
      // navigation used to re-check that shape itself and never agree it was
      // resolved, looping forever instead of opening anything.
      `[루트 상대 링크](${rootRelativeHref})`
    ].join('\n'));

    writeDoc('한글이웃.md', '# 한글이웃\n\n## 섹션\n\n[되돌아가기](./시작문서.md)');
    writeDoc('진행률 80%.md', '# 진행률 80퍼센트');
    writeDoc('C#가이드.md', '# C샵 가이드');
    writeDoc('spaced report.md', '# spaced report');
    writeDoc('한글폴더/안쪽문서.md', '# 안쪽문서');
    writeDoc('english.md', '# english');
    writeDoc('확장자없음.md', '# 확장자없음');
    writeDoc('그림.png.md', '# 열리면 안 되는 문서');

    const electronPath = require('electron');
    app = await electron.launch({
      executablePath: typeof electronPath === 'string' ? electronPath : electronPath.toString(),
      args: [root, '--dev', '--profile=dev'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DOCULIGHT_PROFILE: 'dev',
        DOCULIGHT_DEV_IPC_PATH: ipcPath
      },
      timeout: 30000
    });

    await waitForIpcServer();

    await saveSettings({ enableTabs: false, theme: 'light' });
  });

  async function waitForTabMode(viewer) {
    await expect.poll(() => viewer.evaluate(() => {
      return !!(window.DocuLight &&
        window.DocuLight.modules &&
        window.DocuLight.modules.tabManager &&
        window.DocuLight.modules.tabManager.isEnabled());
    })).toBe(true);
  }

  test.afterAll(async () => {
    // Electron shutdown occasionally outruns the default hook budget on Windows;
    // a slow teardown must not be reported as a product failure.
    test.setTimeout(90000);
    if (app) {
      try {
        await app.close();
      } catch (err) {
        console.warn('[korean-link] electron close failed during teardown:', err && err.message);
      }
    }
    if (fixtureDir && fixtureDir.startsWith(os.tmpdir())) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test.beforeEach(async () => {
    try {
      await sendIpcRequest('close_viewer');
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch { /* ignore */ }
  });

  // Restored in a hook rather than at the end of each test, so a failing
  // assertion cannot leave tab mode switched on for the tests that follow.
  test.afterEach(async () => {
    try {
      await saveSettings({ enableTabs: false, theme: 'light' });
    } catch { /* ignore */ }
  });

  test.describe('single window mode', () => {
    test('opens documents whose names are Korean, spaced, or extension-less', async () => {
      const { viewer } = await openFixture(path.join(fixtureDir, '시작문서.md'));

      await clickContentLink(viewer, '한글 이웃 문서');
      await expect(viewer.locator('#content h1')).toHaveText('한글이웃');

      await clickContentLink(viewer, '되돌아가기');
      await expect(viewer.locator('#content h1')).toHaveText('시작문서');

      await clickContentLink(viewer, '공백 있는 영문');
      await expect(viewer.locator('#content h1')).toHaveText('spaced report');

      await sendIpcRequest('close_viewer');
      await new Promise((resolve) => setTimeout(resolve, 300));

      const withPercent = await openFixture(path.join(fixtureDir, '시작문서.md'));
      await clickContentLink(withPercent.viewer, '퍼센트 있는 한글');
      await expect(withPercent.viewer.locator('#content h1')).toHaveText('진행률 80퍼센트');

      await sendIpcRequest('close_viewer');
      await new Promise((resolve) => setTimeout(resolve, 300));

      const second = await openFixture(path.join(fixtureDir, '시작문서.md'));
      await clickContentLink(second.viewer, '한글 폴더 문서');
      await expect(second.viewer.locator('#content h1')).toHaveText('안쪽문서');
    });

    test('keeps ASCII, anchor-suffixed, and extension-less links working', async () => {
      const { viewer } = await openFixture(path.join(fixtureDir, '시작문서.md'));

      await clickContentLink(viewer, '영문 문서');
      await expect(viewer.locator('#content h1')).toHaveText('english');

      await sendIpcRequest('close_viewer');
      await new Promise((resolve) => setTimeout(resolve, 300));

      const withAnchor = await openFixture(path.join(fixtureDir, '시작문서.md'));
      await clickContentLink(withAnchor.viewer, '한글 앵커 링크');
      await expect(withAnchor.viewer.locator('#content h1')).toHaveText('한글이웃');

      await sendIpcRequest('close_viewer');
      await new Promise((resolve) => setTimeout(resolve, 300));

      const withoutExt = await openFixture(path.join(fixtureDir, '시작문서.md'));
      await clickContentLink(withoutExt.viewer, '확장자 없는 한글');
      await expect(withoutExt.viewer.locator('#content h1')).toHaveText('확장자없음');
    });

    // The sidebar hands over a real filesystem path, not an href. Those paths are
    // the ones that must NOT be percent-decoded on the way to navigateTo, so a
    // file whose own name contains `%` or `#` is what proves the two are separated.
    test('opens sidebar files whose names contain percent or hash characters', async () => {
      const { viewer } = await openFixture(path.join(fixtureDir, '시작문서.md'));
      await ensureSidebarVisible(viewer);

      await clickSidebarFile(viewer, '진행률 80%');
      await expect(viewer.locator('#content h1')).toHaveText('진행률 80퍼센트');

      await clickSidebarFile(viewer, 'C#가이드');
      await expect(viewer.locator('#content h1')).toHaveText('C샵 가이드');

      await clickSidebarFile(viewer, '한글이웃');
      await expect(viewer.locator('#content h1')).toHaveText('한글이웃');
    });

    // sidebar-search.js reaches navigateToForTab through its own call site, so it
    // needs its own coverage rather than inheriting the tree's.
    test('opens a percent-named file from the sidebar file search', async () => {
      const { viewer } = await openFixture(path.join(fixtureDir, '시작문서.md'));
      await ensureSidebarVisible(viewer);

      await viewer.locator('#btn-sidebar-search').click();
      // A term that appears only in the target document's body: the start document
      // also mentions the file name in its link, so searching the name matches both.
      await viewer.locator('.sidebar-search-input').fill('80퍼센트');

      // The click handler sits on the title element inside each result group.
      const resultTitle = viewer.locator('#sidebar-tree .search-result-item .search-result-title');
      await expect(resultTitle).toHaveCount(1);
      await expect(resultTitle).toBeVisible();
      await resultTitle.evaluate((el) => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });

      await expect(viewer.locator('#content h1')).toHaveText('진행률 80퍼센트');
    });

    test('still blocks non-markdown and unsafe links', async () => {
      const { viewer } = await openFixture(path.join(fixtureDir, '시작문서.md'));

      await clickContentLink(viewer, '차단 대상 이미지');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(viewer.locator('#content h1')).toHaveText('시작문서');

      await clickContentLink(viewer, '차단 대상 스크립트');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(viewer.locator('#content h1')).toHaveText('시작문서');
    });
  });

  test.describe('tab mode', () => {
    test('opens a Korean-named document in a new tab', async () => {
      await saveSettings({ enableTabs: true, theme: 'light' });
      const { viewer } = await openFixture(path.join(fixtureDir, '시작문서.md'));
      await waitForTabMode(viewer);

      await clickContentLink(viewer, '한글 이웃 문서');
      await expect(viewer.locator('#content h1')).toHaveText('한글이웃');
      // The tab bar stays hidden while a single document is open, so its
      // appearance is itself evidence that the link opened a second tab.
      await expect(viewer.locator('#tab-bar')).toBeVisible();
      await expect(viewer.locator('#tab-bar .tab-item')).toHaveCount(2);
    });

    test('reuses the existing tab instead of opening a duplicate', async () => {
      await saveSettings({ enableTabs: true, theme: 'light' });
      const { viewer } = await openFixture(path.join(fixtureDir, '시작문서.md'));
      await waitForTabMode(viewer);

      await clickContentLink(viewer, '한글 이웃 문서');
      await expect(viewer.locator('#content h1')).toHaveText('한글이웃');
      await expect(viewer.locator('#tab-bar .tab-item')).toHaveCount(2);

      await clickContentLink(viewer, '되돌아가기');
      await expect(viewer.locator('#content h1')).toHaveText('시작문서');
      await expect(viewer.locator('#tab-bar .tab-item')).toHaveCount(2);

      await clickContentLink(viewer, '한글 이웃 문서');
      await expect(viewer.locator('#content h1')).toHaveText('한글이웃');
      await expect(viewer.locator('#tab-bar .tab-item')).toHaveCount(2);
    });

    test('opens a document inside a Korean-named directory in a tab', async () => {
      await saveSettings({ enableTabs: true, theme: 'light' });
      const { viewer } = await openFixture(path.join(fixtureDir, '시작문서.md'));
      await waitForTabMode(viewer);

      await clickContentLink(viewer, '한글 폴더 문서');
      await expect(viewer.locator('#content h1')).toHaveText('안쪽문서');
      await expect(viewer.locator('#tab-bar .tab-item')).toHaveCount(2);
    });

    test('opens a root-relative link instead of looping on it', async () => {
      await saveSettings({ enableTabs: true, theme: 'light' });
      const { viewer } = await openFixture(path.join(fixtureDir, '시작문서.md'));
      await waitForTabMode(viewer);

      await clickContentLink(viewer, '루트 상대 링크');
      await expect(viewer.locator('#content h1')).toHaveText('루트상대');
      await expect(viewer.locator('#tab-bar .tab-item')).toHaveCount(2);
    });
  });
});
