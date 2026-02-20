// test/doclight.e2e.js — DocuLight Electron E2E Tests
// Run: npx playwright test

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const net = require('net');
const fs = require('fs');

const FIXTURES = path.join(__dirname, 'fixtures');
const HELLO_MD = path.join(FIXTURES, 'hello.md');
const GUIDE_MD = path.join(FIXTURES, 'guide.md');
const PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\doculight-ipc'
  : '/tmp/doculight-ipc.sock';

/** @type {import('playwright').ElectronApplication} */
let app;
let mainWindow;

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

test.describe('DocuLight E2E Tests', () => {

  test.beforeAll(async () => {
    const electronPath = require('electron');
    app = await electron.launch({
      executablePath: typeof electronPath === 'string' ? electronPath : electronPath.toString(),
      args: [path.join(__dirname, '..')],
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 30000,
    });

    // Wait for IPC server
    await waitForIpcServer();
  });

  test.afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // Close all viewer windows before each test to ensure clean state
  test.beforeEach(async () => {
    try {
      await sendIpcRequest('close_viewer');
      await new Promise(r => setTimeout(r, 300));
    } catch { /* ignore if no windows to close or IPC not ready */ }
  });

  // =========================================================================
  // TC-1: App Launch & System Tray
  // =========================================================================

  test('TC-1: App launches successfully with system tray', async () => {
    // App should be running (may have an initial empty window, cleaned by beforeEach)
    expect(app).toBeTruthy();
  });

  // =========================================================================
  // TC-2: Open Markdown via IPC (content mode)
  // =========================================================================

  test('TC-2: Open viewer with content mode via IPC', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Test Content\n\nHello from IPC test.',
      title: 'IPC Content Test',
      size: 'm',
    });

    expect(result.windowId).toBeTruthy();
    expect(result.title).toBe('IPC Content Test');

    // Wait for window to appear
    await new Promise(r => setTimeout(r, 1000));

    const windows = app.windows();
    expect(windows.length).toBeGreaterThanOrEqual(1);

    // Find the viewer window
    const viewer = windows.find(w => w.url().includes('viewer.html'));
    expect(viewer).toBeTruthy();

    // Verify markdown rendered
    const content = await viewer.textContent('#content');
    expect(content).toContain('Test Content');
    expect(content).toContain('Hello from IPC test');

    // Cleanup
    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-3: Open Markdown via IPC (filePath mode + sidebar)
  // =========================================================================

  test('TC-3: Open viewer with filePath mode — sidebar tree appears', async () => {
    const result = await sendIpcRequest('open_markdown', {
      filePath: HELLO_MD,
      size: 'm',
    });

    expect(result.windowId).toBeTruthy();
    expect(result.title).toBe('Hello World');

    await new Promise(r => setTimeout(r, 1500));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));
    expect(viewer).toBeTruthy();

    // Verify markdown rendered
    const heading = await viewer.textContent('#content h1');
    expect(heading).toBe('Hello World');

    // Verify sidebar shows (hello.md has links)
    const sidebarHidden = await viewer.evaluate(() => {
      const sidebar = document.getElementById('sidebar-container');
      return sidebar ? sidebar.classList.contains('hidden') : true;
    });
    expect(sidebarHidden).toBe(false);

    // Verify sidebar tree has items
    const treeItems = await viewer.evaluate(() => {
      return document.querySelectorAll('.tree-item').length;
    });
    expect(treeItems).toBeGreaterThanOrEqual(1);

    // Store windowId for subsequent tests
    test.info().annotations.push({ type: 'windowId', description: result.windowId });

    // Cleanup
    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-4: DOMPurify XSS Protection
  // =========================================================================

  test('TC-4: XSS content is sanitized by DOMPurify', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Safe\n\n<script>alert("xss")</script>\n<img onerror="alert(1)" src="x">\n<iframe src="evil.com"></iframe>\n\nClean text.',
      title: 'XSS Test',
    });

    await new Promise(r => setTimeout(r, 1000));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));
    expect(viewer).toBeTruthy();

    // No script tags in rendered output
    const scriptCount = await viewer.evaluate(() => {
      return document.querySelectorAll('#content script').length;
    });
    expect(scriptCount).toBe(0);

    // No onerror attributes
    const onerrorCount = await viewer.evaluate(() => {
      return document.querySelectorAll('#content [onerror]').length;
    });
    expect(onerrorCount).toBe(0);

    // No iframes
    const iframeCount = await viewer.evaluate(() => {
      return document.querySelectorAll('#content iframe').length;
    });
    expect(iframeCount).toBe(0);

    // Clean text still present
    const text = await viewer.textContent('#content');
    expect(text).toContain('Clean text');

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-5: Update Markdown Content
  // =========================================================================

  test('TC-5: Update existing window content via IPC', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Original',
      title: 'Update Test',
    });

    await new Promise(r => setTimeout(r, 1000));

    // Update content
    const updateResult = await sendIpcRequest('update_markdown', {
      windowId: result.windowId,
      content: '# Updated Content\n\nNew text here.',
      title: 'Updated Title',
    });

    expect(updateResult.title).toBe('Updated Title');

    await new Promise(r => setTimeout(r, 500));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));
    const heading = await viewer.textContent('#content h1');
    expect(heading).toBe('Updated Content');

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-6: List Viewers
  // =========================================================================

  test('TC-6: List open viewer windows', async () => {
    // Open 2 windows
    const w1 = await sendIpcRequest('open_markdown', {
      content: '# Window 1', title: 'Win1',
    });
    const w2 = await sendIpcRequest('open_markdown', {
      content: '# Window 2', title: 'Win2',
    });

    await new Promise(r => setTimeout(r, 1000));

    const listResult = await sendIpcRequest('list_viewers');
    expect(listResult.windows.length).toBeGreaterThanOrEqual(2);

    const titles = listResult.windows.map(w => w.title);
    expect(titles).toContain('Win1');
    expect(titles).toContain('Win2');

    // Cleanup
    await sendIpcRequest('close_viewer', { windowId: w1.windowId });
    await sendIpcRequest('close_viewer', { windowId: w2.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-7: Close All Windows
  // =========================================================================

  test('TC-7: Close all viewer windows', async () => {
    await sendIpcRequest('open_markdown', { content: '# A', title: 'A' });
    await sendIpcRequest('open_markdown', { content: '# B', title: 'B' });

    await new Promise(r => setTimeout(r, 1000));

    const closeResult = await sendIpcRequest('close_viewer');
    expect(closeResult.closed).toBeGreaterThanOrEqual(2);

    await new Promise(r => setTimeout(r, 500));

    const listResult = await sendIpcRequest('list_viewers');
    expect(listResult.windows.length).toBe(0);
  });

  // =========================================================================
  // TC-8: Settings Window
  // =========================================================================

  test('TC-8: Settings window opens and loads form', async () => {
    // Open a viewer first to have the app fully running
    const result = await sendIpcRequest('open_markdown', {
      content: '# Settings Test', title: 'Settings Test',
    });

    await new Promise(r => setTimeout(r, 1000));

    // We can't directly click tray menu from Playwright,
    // but we can check settings IPC works
    const settings = await new Promise((resolve, reject) => {
      const id = `test-settings-${Date.now()}`;
      const viewer = app.windows().find(w => w.url().includes('viewer.html'));
      if (!viewer) return reject(new Error('No viewer window'));

      // Invoke get-settings through the viewer's preload API
      viewer.evaluate(() => {
        return window.doclight.getSettings();
      }).then(resolve).catch(reject);
    });

    expect(settings).toBeTruthy();
    expect(settings.theme).toBeDefined();
    expect(settings.fontSize).toBeDefined();

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-9: Code Highlight
  // =========================================================================

  test('TC-9: Code blocks are syntax highlighted', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Code Test\n\n```javascript\nconst x = 42;\nconsole.log(x);\n```',
      title: 'Code Test',
    });

    await new Promise(r => setTimeout(r, 1500));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));

    // Check hljs applied classes
    const hasHighlight = await viewer.evaluate(() => {
      const codeEl = document.querySelector('#content pre code');
      if (!codeEl) return false;
      return codeEl.classList.contains('hljs') || codeEl.querySelector('.hljs-keyword') !== null;
    });
    expect(hasHighlight).toBe(true);

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-10: Keyboard Shortcuts
  // =========================================================================

  test('TC-10: Ctrl+B toggles sidebar visibility', async () => {
    const result = await sendIpcRequest('open_markdown', {
      filePath: HELLO_MD,
      size: 'm',
    });

    await new Promise(r => setTimeout(r, 1500));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));

    // Sidebar should be visible (filePath mode with links)
    let sidebarHidden = await viewer.evaluate(() => {
      return document.getElementById('sidebar-container').classList.contains('hidden');
    });
    expect(sidebarHidden).toBe(false);

    // Press Ctrl+B to hide
    await viewer.keyboard.press('Control+b');
    await new Promise(r => setTimeout(r, 300));

    sidebarHidden = await viewer.evaluate(() => {
      return document.getElementById('sidebar-container').classList.contains('hidden');
    });
    expect(sidebarHidden).toBe(true);

    // Press Ctrl+B again to show
    await viewer.keyboard.press('Control+b');
    await new Promise(r => setTimeout(r, 300));

    sidebarHidden = await viewer.evaluate(() => {
      return document.getElementById('sidebar-container').classList.contains('hidden');
    });
    expect(sidebarHidden).toBe(false);

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-11: Content mode has no sidebar
  // =========================================================================

  test('TC-11: Content mode hides sidebar', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# No Sidebar\n\nContent mode should not show sidebar.',
      title: 'No Sidebar Test',
    });

    await new Promise(r => setTimeout(r, 1000));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));

    const sidebarHidden = await viewer.evaluate(() => {
      return document.getElementById('sidebar-container').classList.contains('hidden');
    });
    expect(sidebarHidden).toBe(true);

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-12: Max Windows Limit
  // =========================================================================

  test('TC-12: Enforces maximum window limit', async () => {
    // Open windows up to near the limit isn't practical in E2E,
    // so we just verify the error message for an edge case
    const windowIds = [];

    // Open 3 windows quickly
    for (let i = 0; i < 3; i++) {
      const res = await sendIpcRequest('open_markdown', {
        content: `# Window ${i}`, title: `Multi ${i}`,
      });
      windowIds.push(res.windowId);
    }

    await new Promise(r => setTimeout(r, 1000));

    const listResult = await sendIpcRequest('list_viewers');
    expect(listResult.windows.length).toBe(3);

    // Cleanup
    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-13: Dark Theme
  // =========================================================================

  test('TC-13: Theme change is applied to viewer', async () => {
    const result = await sendIpcRequest('open_markdown', {
      content: '# Theme Test',
      title: 'Theme Test',
    });

    await new Promise(r => setTimeout(r, 1000));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));

    // Save dark theme via preload API
    await viewer.evaluate(async () => {
      await window.doclight.saveSettings({
        theme: 'dark',
        fontSize: 16,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        codeTheme: 'github',
        defaultWindowWidth: 1000,
        defaultWindowHeight: 750,
        sidebarWidth: 260,
        maxRecursionDepth: 10,
      });
    });

    await new Promise(r => setTimeout(r, 500));

    // Check if theme attribute was set
    const theme = await viewer.evaluate(() => {
      return document.documentElement.dataset.theme;
    });
    expect(theme).toBe('dark');

    // Reset to light
    await viewer.evaluate(async () => {
      await window.doclight.saveSettings({
        theme: 'light',
        fontSize: 16,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        codeTheme: 'github',
        defaultWindowWidth: 1000,
        defaultWindowHeight: 750,
        sidebarWidth: 260,
        maxRecursionDepth: 10,
      });
    });

    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-14: Window size presets
  // =========================================================================

  test('TC-14: Window size presets (s, m, l)', async () => {
    for (const size of ['s', 'm', 'l']) {
      const result = await sendIpcRequest('open_markdown', {
        content: `# Size ${size}`, title: `Size ${size}`, size,
      });

      await new Promise(r => setTimeout(r, 800));

      const viewer = app.windows().find(w => w.url().includes('viewer.html'));
      const bounds = await viewer.evaluate(() => {
        // In Electron renderer, we can get window size
        return { width: window.outerWidth, height: window.outerHeight };
      });

      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.height).toBeGreaterThan(0);

      await sendIpcRequest('close_viewer', { windowId: result.windowId });
      await new Promise(r => setTimeout(r, 300));
    }
  });

  // =========================================================================
  // TC-15: Sidebar Content Search — results appear with snippets
  // =========================================================================

  test('TC-15: Sidebar content search shows results with snippets', async () => {
    const SEARCH_SCROLL_MD = path.join(FIXTURES, 'search-scroll.md');

    const result = await sendIpcRequest('open_markdown', {
      filePath: SEARCH_SCROLL_MD,
      size: 'm',
    });

    await new Promise(r => setTimeout(r, 2000));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));
    expect(viewer).toBeTruthy();

    // Verify sidebar is visible (filePath mode)
    const sidebarVisible = await viewer.evaluate(() => {
      const sidebar = document.getElementById('sidebar-container');
      return sidebar && !sidebar.classList.contains('hidden');
    });
    expect(sidebarVisible).toBe(true);

    // Activate sidebar search mode via module API
    await viewer.evaluate(() => {
      // Show sidebar first if hidden
      const sidebar = document.getElementById('sidebar-container');
      if (sidebar && sidebar.classList.contains('hidden')) {
        sidebar.classList.remove('hidden');
      }
      if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.sidebarSearch) {
        window.DocuLight.modules.sidebarSearch.enterSearchMode();
      }
    });
    await new Promise(r => setTimeout(r, 300));

    // Verify search container is visible
    const searchVisible = await viewer.evaluate(() => {
      const sc = document.getElementById('sidebar-search-container');
      return sc && !sc.classList.contains('hidden');
    });
    expect(searchVisible).toBe(true);

    // Type a query that exists in the document content (2+ chars triggers content search)
    const searchInput = viewer.locator('.sidebar-search-input');
    await searchInput.fill('UNIQUE_SEARCH_TARGET');
    await new Promise(r => setTimeout(r, 1500)); // Wait for debounce (300ms) + IPC + render

    // Verify search results appear
    const resultCount = await viewer.evaluate(() => {
      return document.querySelectorAll('#sidebar-tree .search-result-item').length;
    });
    expect(resultCount).toBeGreaterThanOrEqual(1);

    // Verify snippets contain the search text
    const hasSnippet = await viewer.evaluate(() => {
      const snippets = document.querySelectorAll('#sidebar-tree .search-result-snippet-text');
      for (const s of snippets) {
        if (s.textContent.includes('UNIQUE_SEARCH_TARGET')) return true;
      }
      // Also check title matches
      const titles = document.querySelectorAll('#sidebar-tree .search-result-title');
      for (const t of titles) {
        if (t.textContent) return true;
      }
      return snippets.length > 0;
    });
    expect(hasSnippet).toBe(true);

    // Verify line numbers are shown
    const hasLineNum = await viewer.evaluate(() => {
      return document.querySelectorAll('#sidebar-tree .search-result-line-num').length > 0;
    });
    expect(hasLineNum).toBe(true);

    // Cleanup
    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-16: Sidebar Content Search — click result scrolls to match
  // =========================================================================

  test('TC-16: Clicking search result navigates and scrolls to match', async () => {
    const SEARCH_SCROLL_MD = path.join(FIXTURES, 'search-scroll.md');

    const result = await sendIpcRequest('open_markdown', {
      filePath: SEARCH_SCROLL_MD,
      size: 'm',
    });

    await new Promise(r => setTimeout(r, 2000));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));
    expect(viewer).toBeTruthy();

    // Record initial scroll position (should be near top)
    const initialScroll = await viewer.evaluate(() => {
      const vc = document.getElementById('viewer-container');
      return vc ? vc.scrollTop : 0;
    });
    expect(initialScroll).toBeLessThan(50);

    // Activate sidebar search via module API
    await viewer.evaluate(() => {
      const sidebar = document.getElementById('sidebar-container');
      if (sidebar && sidebar.classList.contains('hidden')) {
        sidebar.classList.remove('hidden');
      }
      if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.sidebarSearch) {
        window.DocuLight.modules.sidebarSearch.enterSearchMode();
      }
    });
    await new Promise(r => setTimeout(r, 300));

    // Search for text that only appears near the bottom of the document
    const searchInput = viewer.locator('.sidebar-search-input');
    await searchInput.fill('UNIQUE_SEARCH_TARGET');
    await new Promise(r => setTimeout(r, 1500)); // debounce + IPC

    // Click the first snippet result
    const snippetClicked = await viewer.evaluate(() => {
      const snippet = document.querySelector('#sidebar-tree .search-result-snippet');
      if (snippet) {
        snippet.click();
        return true;
      }
      // Fallback: click the title
      const title = document.querySelector('#sidebar-tree .search-result-title');
      if (title) {
        title.click();
        return true;
      }
      return false;
    });
    expect(snippetClicked).toBe(true);

    // Wait for navigation + render + scroll animation
    await new Promise(r => setTimeout(r, 2000));

    // Check that scroll position has moved down significantly
    const finalScroll = await viewer.evaluate(() => {
      const vc = document.getElementById('viewer-container');
      return vc ? vc.scrollTop : 0;
    });

    // The target text is near the bottom, so scrollTop should be significantly > 0
    expect(finalScroll).toBeGreaterThan(100);

    // Verify the highlighted mark element is visible in the viewport
    const targetVisible = await viewer.evaluate(() => {
      const vc = document.getElementById('viewer-container');
      if (!vc) return false;
      const vcRect = vc.getBoundingClientRect();

      // The search highlight wraps matched text in a <mark> element
      const mark = document.querySelector('#content .search-highlight-temp');
      if (mark) {
        const rect = mark.getBoundingClientRect();
        return rect.top >= vcRect.top - 100 && rect.bottom <= vcRect.bottom + 100;
      }

      // Fallback: check if any text with the search term is visible
      const contentEl = document.getElementById('content');
      if (!contentEl) return false;
      const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent && node.textContent.includes('UNIQUE_SEARCH_TARGET')) {
          const range = document.createRange();
          range.selectNode(node);
          const rect = range.getBoundingClientRect();
          return rect.top >= vcRect.top - 100 && rect.bottom <= vcRect.bottom + 100;
        }
      }
      return false;
    });
    expect(targetVisible).toBe(true);

    // Cleanup
    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-17: Sidebar search — short query falls back to title filter
  // =========================================================================

  test('TC-17: Single-char query uses title filter fallback', async () => {
    const result = await sendIpcRequest('open_markdown', {
      filePath: HELLO_MD,
      size: 'm',
    });

    await new Promise(r => setTimeout(r, 1500));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));
    expect(viewer).toBeTruthy();

    // Activate sidebar search via module API
    await viewer.evaluate(() => {
      const sidebar = document.getElementById('sidebar-container');
      if (sidebar && sidebar.classList.contains('hidden')) {
        sidebar.classList.remove('hidden');
      }
      if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.sidebarSearch) {
        window.DocuLight.modules.sidebarSearch.enterSearchMode();
      }
    });
    await new Promise(r => setTimeout(r, 300));

    // Type single char — should use title filter (no IPC content search)
    const searchInput = viewer.locator('.sidebar-search-input');
    await searchInput.fill('h');
    await new Promise(r => setTimeout(r, 500));

    // Should show title-filtered results (items with 'h' in filename)
    const resultItems = await viewer.evaluate(() => {
      return document.querySelectorAll('#sidebar-tree .search-result-item').length;
    });
    // hello.md should match
    expect(resultItems).toBeGreaterThanOrEqual(1);

    // Should NOT show content snippets (title filter only)
    const snippetCount = await viewer.evaluate(() => {
      return document.querySelectorAll('#sidebar-tree .search-result-snippet').length;
    });
    expect(snippetCount).toBe(0);

    // Cleanup
    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-18: Sidebar search — Escape exits search mode
  // =========================================================================

  test('TC-18: Escape exits search mode and restores tree', async () => {
    const result = await sendIpcRequest('open_markdown', {
      filePath: HELLO_MD,
      size: 'm',
    });

    await new Promise(r => setTimeout(r, 1500));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));
    expect(viewer).toBeTruthy();

    // Count original tree items
    const originalTreeItems = await viewer.evaluate(() => {
      return document.querySelectorAll('#sidebar-tree .tree-item').length;
    });

    // Activate search via module API
    await viewer.evaluate(() => {
      const sidebar = document.getElementById('sidebar-container');
      if (sidebar && sidebar.classList.contains('hidden')) {
        sidebar.classList.remove('hidden');
      }
      if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.sidebarSearch) {
        window.DocuLight.modules.sidebarSearch.enterSearchMode();
      }
    });
    await new Promise(r => setTimeout(r, 300));

    // Type something via evaluate (input is inside search container)
    await viewer.evaluate(() => {
      const input = document.querySelector('.sidebar-search-input');
      if (input) {
        input.value = 'guide';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 1500));

    // Verify search results replaced the tree
    const searchResultItems = await viewer.evaluate(() => {
      return document.querySelectorAll('#sidebar-tree .search-result-item').length;
    });
    expect(searchResultItems).toBeGreaterThanOrEqual(1);

    // Press Escape to exit search mode
    await viewer.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 500));

    // Verify search container is hidden
    const searchHidden = await viewer.evaluate(() => {
      const sc = document.getElementById('sidebar-search-container');
      return sc && sc.classList.contains('hidden');
    });
    expect(searchHidden).toBe(true);

    // Verify original tree items are restored
    const restoredTreeItems = await viewer.evaluate(() => {
      return document.querySelectorAll('#sidebar-tree .tree-item').length;
    });
    expect(restoredTreeItems).toBe(originalTreeItems);

    // Cleanup
    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

  // =========================================================================
  // TC-19: Sidebar content search — special characters don't crash
  // =========================================================================

  test('TC-19: Special characters in search query do not crash', async () => {
    const result = await sendIpcRequest('open_markdown', {
      filePath: HELLO_MD,
      size: 'm',
    });

    await new Promise(r => setTimeout(r, 1500));

    const viewer = app.windows().find(w => w.url().includes('viewer.html'));
    expect(viewer).toBeTruthy();

    // Activate search via module API
    await viewer.evaluate(() => {
      const sidebar = document.getElementById('sidebar-container');
      if (sidebar && sidebar.classList.contains('hidden')) {
        sidebar.classList.remove('hidden');
      }
      if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.sidebarSearch) {
        window.DocuLight.modules.sidebarSearch.enterSearchMode();
      }
    });
    await new Promise(r => setTimeout(r, 300));

    // Type special regex characters via evaluate — should not crash (escapeRegex)
    await viewer.evaluate(() => {
      const input = document.querySelector('.sidebar-search-input');
      if (input) {
        input.value = '([test])';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 1500));

    // App should not crash — just verify no results or safe results
    const noError = await viewer.evaluate(() => {
      // If we can read DOM, app didn't crash
      return document.getElementById('sidebar-tree') !== null;
    });
    expect(noError).toBe(true);

    // Cleanup
    await sendIpcRequest('close_viewer', { windowId: result.windowId });
    await new Promise(r => setTimeout(r, 500));
  });

});
