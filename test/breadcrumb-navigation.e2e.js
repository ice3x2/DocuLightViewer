// test/breadcrumb-navigation.e2e.js — FR-RENDER-027 breadcrumb navigation tests
'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const root = path.resolve(__dirname, '..');
const ipcPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\doculight-breadcrumb-${process.pid}`
  : path.join(os.tmpdir(), `doculight-breadcrumb-${process.pid}.sock`);

let app;
let fixtureDir;

function writeDoc(name, content) {
  const filePath = path.join(fixtureDir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function sendIpcRequest(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `breadcrumb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

async function breadcrumbText(viewer) {
  const text = await viewer.locator('#viewer-breadcrumb').innerText();
  return text.replace(/\s+/g, ' ').trim();
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

async function clickBreadcrumbIndex(viewer, index) {
  await viewer.locator(`#viewer-breadcrumb [data-breadcrumb-index="${index}"]`).evaluate((el) => {
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  });
}

async function clickTabIndex(viewer, index) {
  await viewer.locator('#tab-bar .tab-item').nth(index).evaluate((el) => {
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  });
}

test.describe('FR-RENDER-027 breadcrumb navigation', () => {
  test.setTimeout(45000);

  test.beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-breadcrumb-'));
    writeDoc('A.md', '# A\n\n[A to C](./C.md)\n\n[External](https://example.com)\n\n[Script](javascript:alert(1))\n\n[Data](data:text/plain,hello)\n\n[Text](./note.txt)\n\n[Missing](./Missing.md)');
    writeDoc('C.md', '# C\n\n[C to X](./X.md)\n\n[Anchor](#local-section)\n\n## local section');
    writeDoc('X.md', '# X\n\n[X to A](./A.md)');
    writeDoc('note.txt.md', '# Should Not Open');

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

  test.afterAll(async () => {
    if (app) await app.close();
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

  test('shows link traversal trail and truncates when a previous segment is selected', async () => {
    const { viewer } = await openFixture(path.join(fixtureDir, 'A.md'));

    await clickContentLink(viewer, 'A to C');
    await expect(viewer.locator('#content h1')).toHaveText('C');
    await expect(viewer.locator('#viewer-breadcrumb')).toBeVisible();
    await expect.poll(() => breadcrumbText(viewer)).toContain('A > C');
    await expect(viewer.locator('#viewer-breadcrumb [aria-current="page"]')).toHaveText('C');
    await expect(viewer.locator('#viewer-breadcrumb [aria-current="page"]')).toHaveAttribute('aria-label', /C/);

    await clickContentLink(viewer, 'C to X');
    await expect(viewer.locator('#content h1')).toHaveText('X');
    await expect.poll(() => breadcrumbText(viewer)).toContain('A > C > X');

    await clickContentLink(viewer, 'X to A');
    await expect(viewer.locator('#content h1')).toHaveText('A');
    await expect.poll(() => breadcrumbText(viewer)).toContain('A > C > X > A');

    await viewer.locator('#viewer-breadcrumb [data-breadcrumb-index="1"]').focus();
    await viewer.keyboard.press('Enter');
    await expect(viewer.locator('#content h1')).toHaveText('C');
    await expect.poll(() => breadcrumbText(viewer)).toContain('A > C');
    await expect.poll(() => breadcrumbText(viewer)).not.toContain('X');
  });

  test('does not change the breadcrumb for non-document or failed navigation', async () => {
    const { viewer } = await openFixture(path.join(fixtureDir, 'A.md'));

    await clickContentLink(viewer, 'A to C');
    await expect.poll(() => breadcrumbText(viewer)).toContain('A > C');

    await clickContentLink(viewer, 'Anchor');
    await expect.poll(() => breadcrumbText(viewer)).toContain('A > C');

    await clickBreadcrumbIndex(viewer, 0);
    await expect(viewer.locator('#content h1')).toHaveText('A');

    const beforeMissing = await breadcrumbText(viewer);
    await clickContentLink(viewer, 'Script');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await breadcrumbText(viewer)).toBe(beforeMissing);

    await clickContentLink(viewer, 'Data');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await breadcrumbText(viewer)).toBe(beforeMissing);

    await viewer.evaluate(() => {
      window.__breadcrumbNavCalls = [];
      window.DocuLight.fn.navigateToForTab = (target) => window.__breadcrumbNavCalls.push(target);
      const link = document.createElement('a');
      link.href = '//example.com/protocol.md';
      link.textContent = 'Protocol Relative';
      document.getElementById('content').appendChild(link);
    });
    await clickContentLink(viewer, 'Protocol Relative');
    expect(await viewer.evaluate(() => window.__breadcrumbNavCalls)).toEqual([]);
    await viewer.evaluate(() => {
      delete window.DocuLight.fn.navigateToForTab;
    });

    await clickContentLink(viewer, 'Text');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(viewer.locator('#content h1')).toHaveText('A');
    expect(await breadcrumbText(viewer)).toBe(beforeMissing);

    await clickContentLink(viewer, 'Missing');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await breadcrumbText(viewer)).toBe(beforeMissing);
  });

  test('keeps the current trail when a breadcrumb target disappears', async () => {
    writeDoc('M1.md', '# M1\n\n[M1 to M2](./M2.md)');
    writeDoc('M2.md', '# M2\n\n[M2 to M3](./M3.md)');
    writeDoc('M3.md', '# M3\n\n[M3 to M1](./M1.md)');

    const { viewer } = await openFixture(path.join(fixtureDir, 'M1.md'));

    await clickContentLink(viewer, 'M1 to M2');
    await clickContentLink(viewer, 'M2 to M3');
    await expect.poll(() => breadcrumbText(viewer)).toContain('M1 > M2 > M3');

    fs.unlinkSync(path.join(fixtureDir, 'M2.md'));
    await clickBreadcrumbIndex(viewer, 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(viewer.locator('#content h1')).toHaveText('M3');
    await expect.poll(() => breadcrumbText(viewer)).toContain('M1 > M2 > M3');

    await clickContentLink(viewer, 'M3 to M1');
    await expect(viewer.locator('#content h1')).toHaveText('M1');
    await expect.poll(() => breadcrumbText(viewer)).toContain('M1 > M2 > M3 > M1');
  });

  test('opens Markdown links with fragments without corrupting the file path', async () => {
    writeDoc('F1.md', '# F1\n\n[F1 to F2 section](./F2.md#target-section)');
    writeDoc('F2.md', '# F2\n\n## Target Section\n\nBody');

    const { viewer } = await openFixture(path.join(fixtureDir, 'F1.md'));

    await clickContentLink(viewer, 'F1 to F2 section');
    await expect(viewer.locator('#content h1')).toHaveText('F2');
    await expect.poll(() => breadcrumbText(viewer)).toContain('F1 > F2');
  });

  test('uses a single-line horizontally scrollable bar for long trails', async () => {
    const { viewer } = await openFixture(path.join(fixtureDir, 'A.md'));

    for (let i = 0; i < 18; i++) {
      await clickContentLink(viewer, 'A to C');
      await clickContentLink(viewer, 'C to X');
      await clickContentLink(viewer, 'X to A');
    }

    const metrics = await viewer.locator('#viewer-breadcrumb').evaluate((el) => {
      const styles = getComputedStyle(el);
      return {
        overflowX: styles.overflowX,
        whiteSpace: styles.whiteSpace,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        height: el.getBoundingClientRect().height
      };
    });

    expect(metrics.overflowX).toMatch(/auto|scroll/);
    expect(metrics.whiteSpace).toBe('nowrap');
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
    expect(metrics.height).toBeGreaterThanOrEqual(28);
    expect(metrics.height).toBeLessThanOrEqual(32);
  });

  test('preserves and truncates the breadcrumb in tab mode', async () => {
    await saveSettings({ enableTabs: true, theme: 'light' });
    const { viewer } = await openFixture(path.join(fixtureDir, 'A.md'));

    await expect.poll(() => viewer.evaluate(() => {
      return !!(window.DocuLight &&
        window.DocuLight.modules &&
        window.DocuLight.modules.tabManager &&
        window.DocuLight.modules.tabManager.isEnabled());
    })).toBe(true);

    await clickContentLink(viewer, 'A to C');
    await expect(viewer.locator('#content h1')).toHaveText('C');
    await expect.poll(() => breadcrumbText(viewer)).toContain('A > C');

    await clickContentLink(viewer, 'C to X');
    await expect(viewer.locator('#content h1')).toHaveText('X');
    await expect.poll(() => breadcrumbText(viewer)).toContain('A > C > X');

    await clickContentLink(viewer, 'X to A');
    await expect(viewer.locator('#content h1')).toHaveText('A');
    await expect.poll(() => breadcrumbText(viewer)).toContain('A > C > X > A');

    await clickBreadcrumbIndex(viewer, 1);
    await expect(viewer.locator('#content h1')).toHaveText('C');
    await expect.poll(() => breadcrumbText(viewer)).toContain('A > C');
    await expect.poll(() => breadcrumbText(viewer)).not.toContain('X');

    await saveSettings({ enableTabs: false, theme: 'light' });
  });

  test('opens extensionless Markdown links in tab mode', async () => {
    writeDoc('E1.md', '# E1\n\n[E1 to E2](./E2)');
    writeDoc('E2.md', '# E2\n\nE2 body');

    await saveSettings({ enableTabs: true, theme: 'light' });
    const { viewer } = await openFixture(path.join(fixtureDir, 'E1.md'));

    await expect.poll(() => viewer.evaluate(() => {
      return !!(window.DocuLight &&
        window.DocuLight.modules &&
        window.DocuLight.modules.tabManager &&
        window.DocuLight.modules.tabManager.isEnabled());
    })).toBe(true);

    await clickContentLink(viewer, 'E1 to E2');
    await expect(viewer.locator('#content h1')).toHaveText('E2');
    await expect.poll(() => breadcrumbText(viewer)).toContain('E1 > E2');

    await saveSettings({ enableTabs: false, theme: 'light' });
  });

  test('does not switch an existing tab when the target file disappeared', async () => {
    writeDoc('T1.md', '# T1\n\n[T1 to T2](./T2.md)');
    writeDoc('T2.md', '# T2\n\nT2 body');

    await saveSettings({ enableTabs: true, theme: 'light' });
    const { viewer } = await openFixture(path.join(fixtureDir, 'T1.md'));

    await expect.poll(() => viewer.evaluate(() => {
      return !!(window.DocuLight &&
        window.DocuLight.modules &&
        window.DocuLight.modules.tabManager &&
        window.DocuLight.modules.tabManager.isEnabled());
    })).toBe(true);

    await clickContentLink(viewer, 'T1 to T2');
    await expect(viewer.locator('#content h1')).toHaveText('T2');

    await clickTabIndex(viewer, 0);
    await expect(viewer.locator('#content h1')).toHaveText('T1');
    fs.unlinkSync(path.join(fixtureDir, 'T2.md'));

    const before = await breadcrumbText(viewer);
    await clickContentLink(viewer, 'T1 to T2');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(viewer.locator('#content h1')).toHaveText('T1');
    expect(await breadcrumbText(viewer)).toBe(before);

    await saveSettings({ enableTabs: false, theme: 'light' });
  });
});
