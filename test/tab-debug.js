// test/tab-debug.js — Tab bug fix verification
const { _electron: electron } = require('playwright');
const path = require('path');
const net = require('net');

const FIXTURES = path.join(__dirname, 'fixtures');
const GUIDE_MD = path.join(FIXTURES, 'guide.md');
const PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\doculight-ipc'
  : '/tmp/doculight-ipc.sock';

function sendIpcRequest(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const socket = net.connect({ path: PIPE_PATH }, () => {
      socket.write(JSON.stringify({ id, action, params }) + '\n');
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const i = buffer.indexOf('\n');
      if (i !== -1) {
        socket.end();
        try { resolve(JSON.parse(buffer.slice(0, i).trim()).result); } catch (e) { reject(e); }
      }
    });
    socket.on('error', reject);
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('timeout')); });
  });
}

async function waitForIpc(max = 20) {
  for (let i = 0; i < max; i++) {
    try { await sendIpcRequest('list_viewers'); return; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('IPC not ready');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('=== Tab Bug Fix Verification ===\n');

  const electronPath = require('electron');
  const app = await electron.launch({
    executablePath: typeof electronPath === 'string' ? electronPath : electronPath.toString(),
    args: [path.join(__dirname, '..')],
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 30000,
  });

  try {
    await waitForIpc();

    // Enable tabs
    for (const w of app.windows()) {
      try { await w.evaluate(() => window.doclight && window.doclight.saveSettings({ enableTabs: true })); break; } catch {}
    }

    // Open guide.md
    await sendIpcRequest('open_markdown', { filePath: GUIDE_MD.replace(/\\/g, '/'), foreground: true });
    await sleep(3000);

    // Find the viewer with content
    let vw = null;
    for (const w of app.windows()) {
      if (!w.url().includes('viewer.html')) continue;
      const fp = await w.evaluate(() => window.DocuLight ? window.DocuLight.state.currentFilePath : null).catch(() => null);
      if (fp) { vw = w; break; }
    }
    if (!vw) { console.log('FATAL: no viewer with content'); return; }

    // ============================================================
    // TEST 1: Initial state (1 tab, tab bar hidden)
    // ============================================================
    console.log('=== TEST 1: Initial state ===');
    const init = await vw.evaluate(() => {
      const DL = window.DocuLight;
      return {
        tabEnabled: DL.modules.tabManager.isEnabled(),
        tabCount: DL.state.tabs.length,
        tabs: DL.state.tabs.map(t => ({ title: t.title, fp: t.filePath })),
        tabBarHidden: document.getElementById('tab-bar').classList.contains('hidden'),
        currentFile: DL.state.currentFilePath,
      };
    });
    console.log(JSON.stringify(init, null, 2));
    console.log('Tab enabled:', init.tabEnabled ? 'PASS' : 'FAIL');
    console.log('1 tab:', init.tabCount === 1 ? 'PASS' : 'FAIL');
    console.log('Tab bar hidden:', init.tabBarHidden ? 'PASS' : 'FAIL');

    await vw.screenshot({ path: path.join(__dirname, 'tab-fix-1-initial.png') });

    // ============================================================
    // TEST 2: Click sidebar item → new tab created
    // ============================================================
    console.log('\n=== TEST 2: Sidebar click → new tab ===');

    // Click hello.md in sidebar
    const sidebarClick = await vw.evaluate(() => {
      const items = document.querySelectorAll('#sidebar-tree .tree-item');
      for (const item of items) {
        const label = item.querySelector('.tree-label');
        if (label && label.textContent === 'hello.md') {
          item.click();
          return { clicked: true, path: item.dataset.path };
        }
      }
      return { clicked: false };
    });
    console.log('Clicked:', sidebarClick);
    await sleep(2000);

    const afterSidebar = await vw.evaluate(() => {
      const DL = window.DocuLight;
      return {
        tabCount: DL.state.tabs.length,
        tabs: DL.state.tabs.map(t => ({ title: t.title, fp: t.filePath })),
        tabBarHidden: document.getElementById('tab-bar').classList.contains('hidden'),
        tabItems: document.querySelectorAll('.tab-item').length,
        contentH1: document.querySelector('#content h1')?.textContent || 'none',
        activeTabIndex: DL.modules.tabManager.getActiveTabIndex(),
      };
    });
    console.log(JSON.stringify(afterSidebar, null, 2));
    console.log('2 tabs:', afterSidebar.tabCount === 2 ? 'PASS' : 'FAIL (' + afterSidebar.tabCount + ')');
    console.log('Tab bar visible:', !afterSidebar.tabBarHidden ? 'PASS' : 'FAIL');
    console.log('Content shows hello.md:', afterSidebar.contentH1 === 'Hello World' ? 'PASS' : 'FAIL (' + afterSidebar.contentH1 + ')');

    await vw.screenshot({ path: path.join(__dirname, 'tab-fix-2-sidebar-click.png') });

    // ============================================================
    // TEST 3: Click first tab → switch back, check scroll/content
    // ============================================================
    console.log('\n=== TEST 3: Tab switch ===');
    await vw.evaluate(() => {
      const firstTab = document.querySelector('.tab-item');
      if (firstTab) firstTab.click();
    });
    await sleep(1000);

    const afterSwitch = await vw.evaluate(() => {
      const DL = window.DocuLight;
      return {
        activeTabIndex: DL.modules.tabManager.getActiveTabIndex(),
        contentH1: document.querySelector('#content h1')?.textContent || 'none',
        currentFile: DL.state.currentFilePath,
      };
    });
    console.log(JSON.stringify(afterSwitch, null, 2));
    console.log('Switched to first tab:', afterSwitch.activeTabIndex === 0 ? 'PASS' : 'FAIL');
    console.log('Content shows guide:', afterSwitch.contentH1 === 'User Guide' ? 'PASS' : 'FAIL (' + afterSwitch.contentH1 + ')');

    await vw.screenshot({ path: path.join(__dirname, 'tab-fix-3-switch.png') });

    // ============================================================
    // TEST 4: Markdown link click → new tab or existing tab
    // ============================================================
    console.log('\n=== TEST 4: Markdown link click ===');
    // guide.md has a link to ./hello.md. Since hello.md tab already exists, it should switch.
    const linkClick = await vw.evaluate(() => {
      const links = document.querySelectorAll('#content a[href]');
      for (const link of links) {
        if (link.getAttribute('href') === './hello.md') {
          link.click();
          return { clicked: true, href: './hello.md' };
        }
      }
      return { clicked: false };
    });
    console.log('Link clicked:', linkClick);
    await sleep(1500);

    const afterLink = await vw.evaluate(() => {
      const DL = window.DocuLight;
      return {
        tabCount: DL.state.tabs.length,
        activeTabIndex: DL.modules.tabManager.getActiveTabIndex(),
        contentH1: document.querySelector('#content h1')?.textContent || 'none',
      };
    });
    console.log(JSON.stringify(afterLink, null, 2));
    console.log('Still 2 tabs (reused existing):', afterLink.tabCount === 2 ? 'PASS' : 'FAIL (' + afterLink.tabCount + ')');
    console.log('Switched to hello.md tab:', afterLink.contentH1 === 'Hello World' ? 'PASS' : 'FAIL (' + afterLink.contentH1 + ')');

    await vw.screenshot({ path: path.join(__dirname, 'tab-fix-4-link-click.png') });

    // ============================================================
    // TEST 5: Tab title correctness
    // ============================================================
    console.log('\n=== TEST 5: Tab titles ===');
    const titles = await vw.evaluate(() => {
      return window.DocuLight.state.tabs.map(t => ({ title: t.title, fp: t.filePath }));
    });
    console.log(JSON.stringify(titles, null, 2));
    const guideTab = titles.find(t => t.fp && t.fp.includes('guide.md'));
    const helloTab = titles.find(t => t.fp && t.fp.includes('hello.md'));
    console.log('Guide tab title:', guideTab ? (guideTab.title === 'User Guide' ? 'PASS' : 'FAIL (' + guideTab.title + ')') : 'MISSING');
    console.log('Hello tab title:', helloTab ? (helloTab.title === 'Hello World' ? 'PASS' : 'FAIL (' + helloTab.title + ')') : 'MISSING');

    // ============================================================
    // TEST 6: Close tab (Ctrl+W)
    // ============================================================
    console.log('\n=== TEST 6: Close tab ===');
    await vw.evaluate(() => {
      window.DocuLight.modules.tabManager.closeTab();
    });
    await sleep(500);

    const afterClose = await vw.evaluate(() => {
      const DL = window.DocuLight;
      return {
        tabCount: DL.state.tabs.length,
        tabBarHidden: document.getElementById('tab-bar').classList.contains('hidden'),
      };
    });
    console.log(JSON.stringify(afterClose, null, 2));
    console.log('1 tab remaining:', afterClose.tabCount === 1 ? 'PASS' : 'FAIL');
    console.log('Tab bar hidden:', afterClose.tabBarHidden ? 'PASS' : 'FAIL');

    await vw.screenshot({ path: path.join(__dirname, 'tab-fix-5-after-close.png') });

    // ============================================================
    // SUMMARY
    // ============================================================
    console.log('\n' + '='.repeat(50));
    console.log('All tests completed. Check screenshots.');
    console.log('='.repeat(50));

  } finally {
    await app.close();
    console.log('\n=== Done ===');
  }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
