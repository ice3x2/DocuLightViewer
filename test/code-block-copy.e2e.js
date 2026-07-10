'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ipcPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\doculight-code-copy-${process.pid}`
  : path.join(os.tmpdir(), `doculight-code-copy-${process.pid}.sock`);

let app;
let fixtureDir;
let runtimeDir;

function sendIpcRequest(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `code-copy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
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
  await new Promise((resolve) => setTimeout(resolve, 900));
  const viewer = app.windows().find((win) => win.url().includes('viewer.html'));
  expect(viewer).toBeTruthy();
  return { result, viewer };
}

async function buttonOpacity(locator) {
  return locator.evaluate((el) => getComputedStyle(el).opacity);
}

async function closeElectronApp() {
  if (!app) return;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Electron close timeout')), 10000))
    ]);
  } catch {
    const proc = app.process && app.process();
    if (proc && !proc.killed) proc.kill();
  }
}

test.describe('FR-RENDER-029 code block copy affordance', () => {
  test.setTimeout(60000);

  test.beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-code-copy-'));
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-code-copy-runtime-'));

    const markdown = [
      '# Code Copy',
      '',
      '```javascript',
      'const alpha = 1;',
      'console.log(alpha);',
      '```',
      '',
      '```',
      'plain block',
      'second line',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```'
    ].join('\n');
    fs.writeFileSync(path.join(fixtureDir, 'code-copy.md'), markdown, 'utf-8');

    const electronPath = require('electron');
    app = await electron.launch({
      executablePath: typeof electronPath === 'string' ? electronPath : electronPath.toString(),
      args: [root, '--dev', '--profile=dev'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DOCULIGHT_PROFILE: 'dev',
        DOCULIGHT_DEV_USER_DATA_DIR: runtimeDir,
        DOCULIGHT_DEV_IPC_PATH: ipcPath
      },
      timeout: 30000
    });

    await waitForIpcServer();
  });

  test.afterAll(async () => {
    await closeElectronApp();
    if (fixtureDir && fixtureDir.startsWith(os.tmpdir())) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
    if (runtimeDir && runtimeDir.startsWith(os.tmpdir())) {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test.beforeEach(async () => {
    try {
      await sendIpcRequest('close_viewer');
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {
      // ignore cleanup errors
    }
  });

  test.afterEach(async () => {
    try {
      await sendIpcRequest('close_viewer');
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {
      // ignore cleanup errors
    }
  });

  test('shows a text-only copy button on code block hover and fades after copying only that block', async () => {
    const { result, viewer } = await openFixture(path.join(fixtureDir, 'code-copy.md'));

    const buttons = viewer.locator('#content pre .code-copy-button');
    await expect(buttons).toHaveCount(2);
    await expect(viewer.locator('#content .mermaid .code-copy-button')).toHaveCount(0);

    const firstPre = viewer.locator('#content pre').first();
    const firstButton = buttons.first();
    await expect(firstButton).toHaveText('copy');
    await expect.poll(() => buttonOpacity(firstButton)).toBe('0');

    await firstPre.hover();
    await expect.poll(() => buttonOpacity(firstButton)).toBe('1');
    await expect(firstButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(firstButton).toHaveCSS('color', 'rgb(106, 115, 125)');

    await firstButton.hover();
    await expect(firstButton).toHaveCSS('color', 'rgb(36, 41, 46)');
    await firstButton.click();

    await expect(firstButton).toHaveText('copied!');
    const copiedText = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copiedText.replace(/\r\n/g, '\n').trim()).toBe('const alpha = 1;\nconsole.log(alpha);');

    await expect.poll(() => buttonOpacity(firstButton), { timeout: 2000 }).toBe('0');
    await expect(firstButton).toHaveText('copy');

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
  });

  test('keeps the copy affordance for content-only markdown documents', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Content Only\n\n```js\ncontentOnlyCopy();\n```',
      title: 'Content Only Code Copy'
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const viewer = app.windows().find((win) => win.url().includes('viewer.html'));
    expect(viewer).toBeTruthy();

    await expect(viewer.locator('#content pre .code-copy-button')).toHaveCount(1);
    await viewer.locator('#content pre').hover();
    await expect.poll(() => buttonOpacity(viewer.locator('#content pre .code-copy-button'))).toBe('1');

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
  });
});
