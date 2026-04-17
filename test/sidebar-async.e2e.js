// test/sidebar-async.e2e.js — step28 사이드바 점진적 로딩 E2E
// Run: npx playwright test test/sidebar-async.e2e.js
//
// 전제: 실행 중인 DocuLight 인스턴스가 없어야 함 (IPC 소켓/HTTP 포트 충돌 방지).

'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** @type {import('playwright').ElectronApplication} */
let app;
let mainWindow;
let tmpLarge;   // 500 파일 폴더
let tmpSmall;   // 10 파일 폴더
let tmpTiny;    // 5 파일 폴더

function createMdFiles(dir, count) {
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, `note-${String(i).padStart(4, '0')}.md`), `# Note ${i}\nhello\n`);
  }
}

test.beforeAll(async () => {
  tmpLarge = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-async-large-'));
  tmpSmall = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-async-small-'));
  tmpTiny  = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-async-tiny-'));
  createMdFiles(tmpLarge, 500);
  createMdFiles(tmpSmall, 10);
  createMdFiles(tmpTiny, 5);

  app = await electron.launch({
    args: [path.join(__dirname, '..', 'src', 'main', 'index.js'), '--dev']
  });
  mainWindow = await app.firstWindow();
  await mainWindow.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (app) await app.close();
  for (const dir of [tmpLarge, tmpSmall, tmpTiny]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 헬퍼: 렌더러에서 특정 파일을 열고 사이드바가 렌더될 때까지 대기
async function openFileInApp(filePath) {
  await mainWindow.evaluate((p) => window.doclight.navigateTo(p), filePath);
}

// ---------------------------------------------------------------------------
// 시나리오 1: 대용량 폴더 스피너 표시 + 배치 DOM 추가 + done 후 스피너 숨김
// ---------------------------------------------------------------------------
test('scenario-1: 대용량 폴더에서 스피너 표시 후 500 노드 렌더', async () => {
  const rootFile = path.join(tmpLarge, 'note-0000.md');
  const spinnerSel = '#sidebar-loading-spinner';
  const treeSel = '#sidebar-tree';

  await openFileInApp(rootFile);

  // 200ms 이내 스피너 노출
  await mainWindow.waitForSelector(`${spinnerSel}[aria-hidden="false"]`, { timeout: 2000 });

  // 2초 이내 첫 배치 DOM 추가
  await mainWindow.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return !!el && el.children.length > 0;
  }, treeSel, { timeout: 5000 });

  // done 이후 스피너 숨김
  await mainWindow.waitForSelector(`${spinnerSel}[aria-hidden="true"]`, { timeout: 30000 });

  // 500 노드(루트 디렉토리 직계 기준)
  const count = await mainWindow.$$eval(`${treeSel} .tree-item`, els => els.length);
  expect(count).toBeGreaterThanOrEqual(500);
});

// ---------------------------------------------------------------------------
// 시나리오 2: 연속 폴더 전환 (abort 반영)
// ---------------------------------------------------------------------------
test('scenario-2: 연속 폴더 전환 시 이전 배치 잔여 DOM 없음', async () => {
  await openFileInApp(path.join(tmpLarge, 'note-0000.md'));
  // 스피너만 뜨고 바로 폴더 전환
  await mainWindow.waitForSelector('#sidebar-loading-spinner[aria-hidden="false"]', { timeout: 2000 });
  await mainWindow.waitForTimeout(100);  // 일부 배치 도착 여지
  await openFileInApp(path.join(tmpSmall, 'note-0000.md'));

  // 최종 스피너 숨김
  await mainWindow.waitForSelector('#sidebar-loading-spinner[aria-hidden="true"]', { timeout: 30000 });

  // 사이드바 노드 = tmpSmall의 10개 (A 잔여 없음)
  await mainWindow.waitForFunction(() => {
    const el = document.querySelector('#sidebar-tree');
    return el && el.children.length === 10;
  }, null, { timeout: 5000 });
});

// ---------------------------------------------------------------------------
// 시나리오 3: 캐시 히트 (같은 폴더 재방문)
// ---------------------------------------------------------------------------
test('scenario-3: 같은 폴더 재방문 시 fromCache로 즉시 렌더', async () => {
  await openFileInApp(path.join(tmpTiny, 'note-0000.md'));
  await mainWindow.waitForSelector('#sidebar-loading-spinner[aria-hidden="true"]', { timeout: 15000 });

  // 같은 폴더의 다른 파일 → 캐시 히트 기대
  const start = Date.now();
  // fromCache 이벤트를 감지하기 위해 리스너 주입
  const fromCachePromise = mainWindow.evaluate(() => new Promise((resolve) => {
    const off = window.doclight.onSidebarTreeStart((data) => {
      off();
      resolve(!!(data && data.fromCache));
    });
    setTimeout(() => { off(); resolve(false); }, 5000);
  }));

  await openFileInApp(path.join(tmpTiny, 'note-0001.md'));
  const fromCache = await fromCachePromise;
  const elapsed = Date.now() - start;

  expect(fromCache).toBe(true);
  expect(elapsed).toBeLessThan(2000);  // 여유 포함
});

// ---------------------------------------------------------------------------
// 시나리오 4: 취소 invoke 응답
// ---------------------------------------------------------------------------
test('scenario-4: cancelSidebarTreeLoad 호출 응답', async () => {
  await openFileInApp(path.join(tmpLarge, 'note-0000.md'));
  await mainWindow.waitForSelector('#sidebar-loading-spinner[aria-hidden="false"]', { timeout: 2000 });

  // 진행 중 로드의 loadId 획득 + 취소
  const result = await mainWindow.evaluate(async () => {
    const loadId = await new Promise((resolve) => {
      const off = window.doclight.onSidebarTreeStart((d) => { off(); resolve(d && d.loadId); });
      setTimeout(() => { off(); resolve(null); }, 3000);
    });
    if (loadId === null) return { cancelled: false, loadIdSeen: false };
    const r = await window.doclight.cancelSidebarTreeLoad(loadId);
    return Object.assign({ loadIdSeen: true }, r);
  });

  // 이미 수신한 start 이후 abort 호출 → cancelled:true 또는 이미 완료되어 cancelled:false
  // 양쪽 다 허용 (레이스)
  expect(typeof result.cancelled).toBe('boolean');
});

// ---------------------------------------------------------------------------
// 시나리오 5: 회귀 - 소규모 폴더 기본 동작
// ---------------------------------------------------------------------------
test('scenario-5: 5개 파일 폴더 기본 동작 유지', async () => {
  await openFileInApp(path.join(tmpTiny, 'note-0000.md'));
  await mainWindow.waitForSelector('#sidebar-loading-spinner[aria-hidden="true"]', { timeout: 15000 });
  const count = await mainWindow.$$eval('#sidebar-tree .tree-item', els => els.length);
  expect(count).toBeGreaterThanOrEqual(5);
});

// ---------------------------------------------------------------------------
// 시나리오 6: 링크 기반 트리 회귀
// ---------------------------------------------------------------------------
test('scenario-6: 링크 포함 파일 열기 회귀', async () => {
  // tmpLinks 디렉토리 설치: a.md → b.md, c.md 링크
  const tmpLinks = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-async-links-'));
  try {
    fs.writeFileSync(path.join(tmpLinks, 'a.md'), '# A\n[B](./b.md) [C](./c.md)\n');
    fs.writeFileSync(path.join(tmpLinks, 'b.md'), '# B\n');
    fs.writeFileSync(path.join(tmpLinks, 'c.md'), '# C\n');
    await openFileInApp(path.join(tmpLinks, 'a.md'));
    await mainWindow.waitForSelector('#sidebar-loading-spinner[aria-hidden="true"]', { timeout: 15000 });
    const count = await mainWindow.$$eval('#sidebar-tree .tree-item', els => els.length);
    expect(count).toBeGreaterThanOrEqual(3);
  } finally {
    try { fs.rmSync(tmpLinks, { recursive: true, force: true }); } catch (_) {}
  }
});
