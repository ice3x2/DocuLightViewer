// test/doclight.step19.e2e.js — DocuLight Step 19 E2E Tests (TC-20 ~ TC-38)
// Tests for FR-19-001 ~ FR-19-007 (7 new features)
// Run: npx playwright test test/doclight.step19.e2e.js

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const net = require('net');

const FIXTURES = path.join(__dirname, 'fixtures');
const HELLO_MD = path.join(FIXTURES, 'hello.md');
const PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\doculight-ipc'
  : '/tmp/doculight-ipc.sock';

/** @type {import('playwright').ElectronApplication} */
let app;

// Helper: send ndjson IPC request to the Electron app's socket server
function sendIpcRequest(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const socket = net.connect({ path: PIPE_PATH }, () => {
      const msg = JSON.stringify({ id, action, params }) + '\n';
      socket.write(msg);
    });

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        try {
          const response = JSON.parse(line);
          socket.end();
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.result);
          }
        } catch (e) {
          socket.end();
          reject(e);
        }
      }
    });

    socket.on('error', reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error('IPC request timeout'));
    });
  });
}

// Wait for IPC server to be ready
async function waitForIpcServer(maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await sendIpcRequest('list_viewers');
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('IPC server not ready after ' + maxAttempts + ' attempts');
}

// Helper: get viewer window (first viewer.html window)
function getViewer() {
  return app.windows().find(w => w.url().includes('viewer.html'));
}

test.describe('DocuLight Step 19 E2E Tests', () => {

  test.beforeAll(async () => {
    const electronPath = require('electron');
    app = await electron.launch({
      executablePath: typeof electronPath === 'string' ? electronPath : electronPath.toString(),
      args: [path.join(__dirname, '..')],
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 30000,
    });

    await waitForIpcServer();
  });

  test.afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // Close all viewer windows before each test for clean state
  test.beforeEach(async () => {
    try {
      await sendIpcRequest('close_viewer');
      await new Promise(r => setTimeout(r, 300));
    } catch { /* ignore */ }
  });

  // =========================================================================
  // FR-19-001: Named Window (TC-20 ~ TC-22)
  // =========================================================================

  test('TC-20: windowName 지정 시 list_viewers 응답에 windowName 포함', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Named Window Test',
      title: 'Named TC-20',
      windowName: 'tc20-window',
    });

    expect(result.windowId).toBeTruthy();

    await new Promise(r => setTimeout(r, 500));

    const listResult = await sendIpcRequest('list_viewers');
    const found = listResult.windows.find(w => w.windowId === result.windowId);
    expect(found).toBeTruthy();
    expect(found.windowName).toBe('tc20-window');

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-21: 같은 windowName으로 두 번 호출하면 두 번째는 upsert (동일 windowId)', async () => {
    const first = await sendIpcRequest('open_markdown', {
      content: '# First',
      title: 'Upsert First',
      windowName: 'tc21-upsert',
    });

    expect(first.windowId).toBeTruthy();

    await new Promise(r => setTimeout(r, 500));

    const second = await sendIpcRequest('open_markdown', {
      content: '# Second (upserted)',
      title: 'Upsert Second',
      windowName: 'tc21-upsert',
    });

    // Same windowId → upsert
    expect(second.windowId).toBe(first.windowId);
    expect(second.upserted).toBe(true);

    // Only one window exists (no duplicate)
    const listResult = await sendIpcRequest('list_viewers');
    const namedWindows = listResult.windows.filter(w => w.windowName === 'tc21-upsert');
    expect(namedWindows.length).toBe(1);

    await sendIpcRequest('close_viewer', { windowId: first.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-22: 창 닫은 후 같은 windowName으로 재생성하면 새 windowId 발급', async () => {
    const first = await sendIpcRequest('open_markdown', {
      content: '# First',
      windowName: 'tc22-renew',
    });

    const firstId = first.windowId;
    expect(firstId).toBeTruthy();

    await new Promise(r => setTimeout(r, 500));

    // Close the window
    await sendIpcRequest('close_viewer', { windowId: firstId });
    await new Promise(r => setTimeout(r, 500));

    // Re-create with same windowName
    const second = await sendIpcRequest('open_markdown', {
      content: '# Second (new window)',
      windowName: 'tc22-renew',
    });

    expect(second.windowId).toBeTruthy();
    expect(second.windowId).not.toBe(firstId);
    expect(second.upserted).toBeFalsy();

    await sendIpcRequest('close_viewer', { windowId: second.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  // =========================================================================
  // FR-19-002: Append Mode (TC-23 ~ TC-25)
  // =========================================================================

  test('TC-23: appendMode: true로 update하면 이전+새 내용 모두 렌더링', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '첫 번째 내용입니다.',
      title: 'Append TC-23',
    });

    await new Promise(r => setTimeout(r, 1000));

    // Append new content
    await sendIpcRequest('update_markdown', {
      windowId: result.windowId,
      content: '두 번째 내용입니다.',
      appendMode: true,
    });

    await new Promise(r => setTimeout(r, 500));

    const viewer = getViewer();
    expect(viewer).toBeTruthy();

    const text = await viewer.evaluate(() => {
      const el = document.getElementById('content');
      return el ? el.textContent : '';
    });

    expect(text).toContain('첫 번째 내용입니다');
    expect(text).toContain('두 번째 내용입니다');

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-24: separator: "---" 사용 시 구분자 포함 렌더링 (hr 요소 생성)', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '위쪽 내용',
      title: 'Separator TC-24',
    });

    await new Promise(r => setTimeout(r, 1000));

    // Append with markdown hr separator
    await sendIpcRequest('update_markdown', {
      windowId: result.windowId,
      content: '아래쪽 내용',
      appendMode: true,
      separator: '\n\n---\n\n',
    });

    await new Promise(r => setTimeout(r, 500));

    const viewer = getViewer();
    expect(viewer).toBeTruthy();

    // '---' in markdown renders as <hr>
    const hrCount = await viewer.evaluate(() => {
      return document.querySelectorAll('#content hr').length;
    });
    expect(hrCount).toBeGreaterThanOrEqual(1);

    // Both texts must be present
    const text = await viewer.evaluate(() => {
      return document.getElementById('content').textContent;
    });
    expect(text).toContain('위쪽 내용');
    expect(text).toContain('아래쪽 내용');

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-25: filePath 기반 창에 appendMode 시도하면 에러 반환', async () => {
    const result = await sendIpcRequest('open_markdown', {
      filePath: HELLO_MD,
      title: 'Append Error TC-25',
    });

    await new Promise(r => setTimeout(r, 1000));

    // appendMode on filePath window should throw
    await expect(
      sendIpcRequest('update_markdown', {
        windowId: result.windowId,
        content: '추가 내용',
        appendMode: true,
      })
    ).rejects.toThrow();

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  // =========================================================================
  // FR-19-003: Severity 테마 (TC-26 ~ TC-28)
  // =========================================================================

  test('TC-26: severity: "error"로 open하면 #severity-bar에 severity-error 클래스 존재', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Severity Error Test',
      title: 'Severity TC-26',
      severity: 'error',
    });

    await new Promise(r => setTimeout(r, 1000));

    const viewer = getViewer();
    expect(viewer).toBeTruthy();

    const hasClass = await viewer.evaluate(() => {
      const bar = document.getElementById('severity-bar');
      return bar ? bar.classList.contains('severity-error') : false;
    });
    expect(hasClass).toBe(true);

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-27: update_markdown으로 severity를 "warning"으로 변경하면 클래스 변경됨', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Severity Update Test',
      title: 'Severity TC-27',
      severity: 'error',
    });

    await new Promise(r => setTimeout(r, 1000));

    const viewer = getViewer();
    expect(viewer).toBeTruthy();

    // Verify initial severity-error class
    const hasError = await viewer.evaluate(() => {
      const bar = document.getElementById('severity-bar');
      return bar ? bar.classList.contains('severity-error') : false;
    });
    expect(hasError).toBe(true);

    // Update to warning
    await sendIpcRequest('update_markdown', {
      windowId: result.windowId,
      severity: 'warning',
    });

    await new Promise(r => setTimeout(r, 500));

    const hasWarning = await viewer.evaluate(() => {
      const bar = document.getElementById('severity-bar');
      return bar ? bar.classList.contains('severity-warning') : false;
    });
    expect(hasWarning).toBe(true);

    // error class must be removed
    const stillHasError = await viewer.evaluate(() => {
      const bar = document.getElementById('severity-bar');
      return bar ? bar.classList.contains('severity-error') : false;
    });
    expect(stillHasError).toBe(false);

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-28: severity를 null/빈 문자열로 업데이트하면 severity 클래스 제거 (바 숨김)', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Severity Clear Test',
      title: 'Severity TC-28',
      severity: 'info',
    });

    await new Promise(r => setTimeout(r, 1000));

    const viewer = getViewer();
    expect(viewer).toBeTruthy();

    // Confirm info class exists
    const hasInfo = await viewer.evaluate(() => {
      const bar = document.getElementById('severity-bar');
      return bar ? bar.classList.contains('severity-info') : false;
    });
    expect(hasInfo).toBe(true);

    // Clear severity with empty string
    await sendIpcRequest('update_markdown', {
      windowId: result.windowId,
      severity: '',
    });

    await new Promise(r => setTimeout(r, 500));

    // All severity-* classes should be removed; display should be none
    const severityCleared = await viewer.evaluate(() => {
      const bar = document.getElementById('severity-bar');
      if (!bar) return false;
      const hasSeverityClass = ['severity-info', 'severity-success', 'severity-warning', 'severity-error']
        .some(c => bar.classList.contains(c));
      return !hasSeverityClass;
    });
    expect(severityCleared).toBe(true);

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  // =========================================================================
  // FR-19-004: Auto-close 타이머 (TC-29 ~ TC-31)
  // =========================================================================

  test('TC-29: autoCloseSeconds: 2로 open하면 2초 후 창이 list_viewers에서 사라짐', async () => {
    test.setTimeout(15000);

    const result = await sendIpcRequest('open_markdown', {
      content: '# Auto-close Test',
      title: 'AutoClose TC-29',
      autoCloseSeconds: 2,
    });

    expect(result.windowId).toBeTruthy();

    // Window should still exist immediately
    const listBefore = await sendIpcRequest('list_viewers');
    const existsBefore = listBefore.windows.some(w => w.windowId === result.windowId);
    expect(existsBefore).toBe(true);

    // Wait past the auto-close deadline (2s + buffer)
    await new Promise(r => setTimeout(r, 3500));

    const listAfter = await sendIpcRequest('list_viewers');
    const existsAfter = listAfter.windows.some(w => w.windowId === result.windowId);
    expect(existsAfter).toBe(false);
  });

  test('TC-30: update_markdown으로 타이머 재설정하면 초기 만료 이후에도 창 유지', async () => {
    test.setTimeout(20000);

    const result = await sendIpcRequest('open_markdown', {
      content: '# Auto-close Reset Test',
      title: 'AutoClose Reset TC-30',
      autoCloseSeconds: 2,
    });

    expect(result.windowId).toBeTruthy();

    // At ~1s, reset timer to 5 seconds from now
    await new Promise(r => setTimeout(r, 1000));

    await sendIpcRequest('update_markdown', {
      windowId: result.windowId,
      autoCloseSeconds: 5,
    });

    // At ~3s from open (original timer would have fired at 2s, but was reset)
    await new Promise(r => setTimeout(r, 2000));

    // Window should still exist since new timer is 5s from ~1s mark (fires at ~6s from open)
    const listMid = await sendIpcRequest('list_viewers');
    const existsMid = listMid.windows.some(w => w.windowId === result.windowId);
    expect(existsMid).toBe(true);

    // Wait for new timer to fire (5s from the update at ~1s = ~6s from open, we're at ~3s, wait 4 more)
    await new Promise(r => setTimeout(r, 5000));

    const listAfter = await sendIpcRequest('list_viewers');
    const existsAfter = listAfter.windows.some(w => w.windowId === result.windowId);
    expect(existsAfter).toBe(false);
  });

  test('TC-31: autoCloseSeconds: 10으로 open하면 #auto-close-bar가 표시되고 텍스트 포함', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Auto-close Bar Test',
      title: 'AutoClose Bar TC-31',
      autoCloseSeconds: 10,
    });

    await new Promise(r => setTimeout(r, 1000));

    const viewer = getViewer();
    expect(viewer).toBeTruthy();

    // bar should be visible (display: block)
    const barVisible = await viewer.evaluate(() => {
      const bar = document.getElementById('auto-close-bar');
      return bar ? bar.style.display === 'block' : false;
    });
    expect(barVisible).toBe(true);

    // bar text should contain a number (countdown seconds)
    const barText = await viewer.evaluate(() => {
      const bar = document.getElementById('auto-close-bar');
      return bar ? bar.textContent : '';
    });
    expect(barText.length).toBeGreaterThan(0);
    // Text contains a digit (countdown number)
    expect(/\d/.test(barText)).toBe(true);

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  // =========================================================================
  // FR-19-005: Window 태그 (TC-32 ~ TC-35)
  // =========================================================================

  test('TC-32: tags: ["alarm"]으로 open하면 list_viewers 응답에 tags 필드 포함', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Tags Test',
      title: 'Tags TC-32',
      tags: ['alarm'],
    });

    await new Promise(r => setTimeout(r, 500));

    const listResult = await sendIpcRequest('list_viewers');
    const found = listResult.windows.find(w => w.windowId === result.windowId);
    expect(found).toBeTruthy();
    expect(found.tags).toBeDefined();
    expect(found.tags).toContain('alarm');

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-33: list_viewers({ tag: "alarm" })은 해당 태그 창만 반환', async () => {
    // Open tagged window
    const tagged = await sendIpcRequest('open_markdown', {
      content: '# Tagged',
      title: 'Tagged TC-33',
      tags: ['alarm'],
    });

    // Open untagged window
    const untagged = await sendIpcRequest('open_markdown', {
      content: '# Untagged',
      title: 'Untagged TC-33',
    });

    await new Promise(r => setTimeout(r, 500));

    const filteredList = await sendIpcRequest('list_viewers', { tag: 'alarm' });
    expect(filteredList.windows.length).toBeGreaterThanOrEqual(1);

    // Tagged window must appear
    const foundTagged = filteredList.windows.find(w => w.windowId === tagged.windowId);
    expect(foundTagged).toBeTruthy();

    // Untagged window must NOT appear
    const foundUntagged = filteredList.windows.find(w => w.windowId === untagged.windowId);
    expect(foundUntagged).toBeUndefined();

    await sendIpcRequest('close_viewer', { windowId: tagged.windowId });
    await sendIpcRequest('close_viewer', { windowId: untagged.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-34: close_viewer({ tag: "alarm" })은 alarm 태그 창만 닫고 나머지 창 유지', async () => {
    // Open tagged window
    const tagged = await sendIpcRequest('open_markdown', {
      content: '# Tagged',
      title: 'Tagged TC-34',
      tags: ['alarm'],
    });

    // Open untagged window
    const untagged = await sendIpcRequest('open_markdown', {
      content: '# Untagged',
      title: 'Untagged TC-34',
    });

    await new Promise(r => setTimeout(r, 500));

    // Close only alarm tagged windows
    const closeResult = await sendIpcRequest('close_viewer', { tag: 'alarm' });
    expect(closeResult.closed).toBeGreaterThanOrEqual(1);

    await new Promise(r => setTimeout(r, 500));

    const listAfter = await sendIpcRequest('list_viewers');

    // Tagged window must be gone
    const taggedGone = !listAfter.windows.some(w => w.windowId === tagged.windowId);
    expect(taggedGone).toBe(true);

    // Untagged window must still exist
    const untaggedExists = listAfter.windows.some(w => w.windowId === untagged.windowId);
    expect(untaggedExists).toBe(true);

    await sendIpcRequest('close_viewer', { windowId: untagged.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-35: update_markdown으로 tags 교체 후 list_viewers에서 갱신된 tags 확인', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Tags Update Test',
      title: 'Tags Update TC-35',
      tags: ['old-tag'],
    });

    await new Promise(r => setTimeout(r, 500));

    // Verify initial tags
    const listBefore = await sendIpcRequest('list_viewers');
    const before = listBefore.windows.find(w => w.windowId === result.windowId);
    expect(before.tags).toContain('old-tag');

    // Update tags
    await sendIpcRequest('update_markdown', {
      windowId: result.windowId,
      tags: ['new-tag'],
    });

    await new Promise(r => setTimeout(r, 300));

    const listAfter = await sendIpcRequest('list_viewers');
    const after = listAfter.windows.find(w => w.windowId === result.windowId);
    expect(after.tags).toContain('new-tag');
    expect(after.tags).not.toContain('old-tag');

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  // =========================================================================
  // FR-19-006: Taskbar Flash (TC-36)
  // =========================================================================

  test('TC-36: flash: true로 open/update 호출 시 에러 없이 성공 응답 반환', async () => {
    // Open with flash: true
    const result = await sendIpcRequest('open_markdown', {
      content: '# Flash Test',
      title: 'Flash TC-36',
      flash: true,
    });

    expect(result.windowId).toBeTruthy();

    await new Promise(r => setTimeout(r, 500));

    // Update with flash: true (should also succeed without error)
    const updateResult = await sendIpcRequest('update_markdown', {
      windowId: result.windowId,
      content: '# Flash Update',
      flash: true,
    });

    expect(updateResult).toBeTruthy();
    expect(updateResult.title).toBeDefined();

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  // =========================================================================
  // FR-19-007: Progress Bar (TC-37 ~ TC-38)
  // =========================================================================

  test('TC-37: progress: 0.5로 open하면 list_viewers 응답에 progress: 0.5 포함', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Progress Test',
      title: 'Progress TC-37',
      progress: 0.5,
    });

    await new Promise(r => setTimeout(r, 500));

    const listResult = await sendIpcRequest('list_viewers');
    const found = listResult.windows.find(w => w.windowId === result.windowId);
    expect(found).toBeTruthy();
    expect(found.progress).toBe(0.5);

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-38: update_markdown({ progress: -1 })으로 progress 바 숨김 처리', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Progress Clear Test',
      title: 'Progress Clear TC-38',
      progress: 0.7,
    });

    await new Promise(r => setTimeout(r, 500));

    // Verify initial progress value
    const listBefore = await sendIpcRequest('list_viewers');
    const before = listBefore.windows.find(w => w.windowId === result.windowId);
    expect(before.progress).toBe(0.7);

    // Clear progress bar using -1 (Electron convention to hide taskbar progress)
    await sendIpcRequest('update_markdown', {
      windowId: result.windowId,
      progress: -1,
    });

    await new Promise(r => setTimeout(r, 300));

    // After progress: -1, the meta stores -1 (indicating "no progress bar")
    const listAfter = await sendIpcRequest('list_viewers');
    const after = listAfter.windows.find(w => w.windowId === result.windowId);
    expect(after).toBeTruthy();
    // progress is -1 (cleared state) — Electron's setProgressBar(-1) hides taskbar indicator
    expect(after.progress).toBe(-1);

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 300));
  });

});
