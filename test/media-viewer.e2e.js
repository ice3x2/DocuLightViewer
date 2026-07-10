'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ipcPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\doculight-media-viewer-${process.pid}`
  : path.join(os.tmpdir(), `doculight-media-viewer-${process.pid}.sock`);

let app;
let fixtureDir;
let runtimeDir;
let imageServer;
let imageServerBaseUrl;

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

function sendIpcRequest(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `media-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

async function waitForMediaWindow(previousCount = 0) {
  await expect.poll(() => app.windows().filter((win) => win.url().includes('media-viewer.html')).length).toBeGreaterThan(previousCount);
  return app.windows().filter((win) => win.url().includes('media-viewer.html')).at(-1);
}

async function closeAllMediaWindows() {
  for (const win of app.windows().filter((entry) => entry.url().includes('media-viewer.html'))) {
    await win.close().catch(() => {});
  }
}

async function mediaCenterDelta(media) {
  return media.evaluate(() => {
    const viewport = document.getElementById('media-viewport');
    const content = document.getElementById('media-content');
    const viewportRect = viewport.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      dx: Math.abs((contentRect.left + contentRect.width / 2) - (viewportRect.left + viewport.clientWidth / 2)),
      dy: Math.abs((contentRect.top + contentRect.height / 2) - (viewportRect.top + viewport.clientHeight / 2)),
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight,
      contentWidth: contentRect.width,
      contentHeight: contentRect.height
    };
  });
}

async function inlineMediaPercent(wrapper) {
  return wrapper.evaluate((element) => {
    const cssWidth = getComputedStyle(element).getPropertyValue('--inline-media-width').trim();
    const cssPercent = cssWidth.endsWith('%') ? Number.parseFloat(cssWidth) : NaN;
    const availableWidth = element.parentElement ? element.parentElement.clientWidth : 0;
    const layoutPercent = availableWidth > 0
      ? (element.getBoundingClientRect().width / availableWidth) * 100
      : NaN;
    return { cssPercent, layoutPercent };
  });
}

async function expectInlineMediaPercent(wrapper, expected) {
  await expect.poll(async () => {
    const percent = await inlineMediaPercent(wrapper);
    return {
      cssMatches: Number.isFinite(percent.cssPercent) && Math.abs(percent.cssPercent - expected) <= 0.01,
      layoutMatches: Number.isFinite(percent.layoutPercent) && Math.abs(percent.layoutPercent - expected) <= 0.25
    };
  }).toEqual({ cssMatches: true, layoutMatches: true });
}

async function inlineToolbarGeometry(wrapper) {
  return wrapper.evaluate((element) => {
    const toolbar = element.querySelector('.media-inline-toolbar');
    const content = document.getElementById('content');
    if (!toolbar || !content) return null;
    const toolbarRect = toolbar.getBoundingClientRect();
    const wrapperRect = element.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      toolbarTop: toolbarRect.top,
      toolbarRight: toolbarRect.right,
      toolbarLeft: toolbarRect.left,
      wrapperTop: wrapperRect.top,
      wrapperRight: wrapperRect.right,
      contentRight: contentRect.right
    };
  });
}

async function expectInlineToolbarAtDocumentEdge(wrapper) {
  await expect.poll(async () => {
    const geometry = await inlineToolbarGeometry(wrapper);
    return Boolean(
      geometry &&
      Math.abs(geometry.toolbarTop - geometry.wrapperTop) <= 1 &&
      Math.abs(geometry.toolbarRight - geometry.contentRight) <= 1
    );
  }).toBe(true);
  return inlineToolbarGeometry(wrapper);
}

async function expectToolbarReachableAcrossExternalGap(viewer, wrapper) {
  const geometry = await inlineToolbarGeometry(wrapper);
  expect(geometry.toolbarLeft).toBeGreaterThan(geometry.wrapperRight + 1);
  const y = geometry.wrapperTop + 8;
  await viewer.mouse.move(geometry.wrapperRight - 2, y);
  for (let x = geometry.wrapperRight + 1; x < geometry.toolbarLeft + 2; x += 4) {
    await viewer.mouse.move(x, y);
  }
  await expect.poll(() => wrapper.locator('.media-inline-toolbar').evaluate((toolbar) => ({
    opacity: getComputedStyle(toolbar).opacity,
    pointerEvents: getComputedStyle(toolbar).pointerEvents
  }))).toEqual({ opacity: '1', pointerEvents: 'auto' });
}

async function expectedInlineAutoFitPercent(media) {
  return media.evaluate((element) => {
    const viewport = document.getElementById('viewer-container');
    const wrapper = element.closest('.media-expand-wrapper');
    const availableWidth = wrapper && wrapper.parentElement ? wrapper.parentElement.clientWidth : 0;
    let width = 0;
    let height = 0;
    if (element instanceof HTMLImageElement) {
      width = element.naturalWidth;
      height = element.naturalHeight;
    } else {
      const svg = element.matches('svg') ? element : element.querySelector('svg');
      const viewBox = svg && svg.viewBox && svg.viewBox.baseVal;
      width = viewBox && viewBox.width;
      height = viewBox && viewBox.height;
    }
    const rawPercent = viewport.clientHeight * 0.9 * (width / height) / availableWidth * 100;
    return Math.min(100, rawPercent < 0.01 ? rawPercent : Math.floor(rawPercent * 100) / 100);
  });
}

async function expectNativeDisabledStyle(disabledButton, enabledButton) {
  await expect.poll(async () => {
    const disabledState = await disabledButton.evaluate((disabled) => {
      const disabledStyle = getComputedStyle(disabled);
      return {
        isButton: disabled instanceof HTMLButtonElement,
        disabledProperty: disabled.disabled,
        disabledAttribute: disabled.hasAttribute('disabled'),
        color: disabledStyle.color,
        backgroundColor: disabledStyle.backgroundColor,
        opacity: disabledStyle.opacity
      };
    });
    const enabledState = await enabledButton.evaluate((enabled) => {
      const enabledStyle = getComputedStyle(enabled);
      return {
        isButton: enabled instanceof HTMLButtonElement,
        disabledProperty: enabled.disabled,
        color: enabledStyle.color,
        backgroundColor: enabledStyle.backgroundColor,
        opacity: enabledStyle.opacity
      };
    });
    return {
      disabledIsButton: disabledState.isButton,
      enabledIsButton: enabledState.isButton,
      disabledProperty: disabledState.disabledProperty,
      disabledAttribute: disabledState.disabledAttribute,
      enabledProperty: enabledState.disabledProperty,
      grayFamily: (() => {
        const channels = disabledState.color.match(/[0-9.]+/g);
        if (!channels || channels.length < 3) return false;
        const rgb = channels.slice(0, 3).map(Number);
        return Math.max(...rgb) - Math.min(...rgb) <= 24;
      })(),
      lowerOpacity: Number(disabledState.opacity) < Number(enabledState.opacity)
    };
  }).toEqual({
    disabledIsButton: true,
    enabledIsButton: true,
    disabledProperty: true,
    disabledAttribute: true,
    enabledProperty: false,
    grayFamily: true,
    lowerOpacity: true
  });
}

test.describe('FR-RENDER-028 dedicated media viewer', () => {
  test.setTimeout(60000);

  test.beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-media-viewer-'));
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-media-runtime-'));

    imageServer = http.createServer((req, res) => {
      if (req.url === '/remote.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG_1X1.length) });
        res.end(PNG_1X1);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
    imageServerBaseUrl = `http://127.0.0.1:${imageServer.address().port}`;

    const localSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1200" viewBox="0 0 1800 1200">',
      '<rect width="1800" height="1200" fill="#fff"/>',
      '<rect x="40" y="40" width="1720" height="1120" fill="#dbeafe" stroke="#1f2937" stroke-width="12"/>',
      '<text x="120" y="180" font-size="72">Generated DocuLight media fixture</text>',
      '</svg>'
    ].join('');
    const localImagePath = path.join(fixtureDir, 'large-local.svg');
    fs.writeFileSync(localImagePath, localSvg, 'utf-8');

    const hugeSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="18000" height="14000" viewBox="0 0 18000 14000">',
      '<rect width="18000" height="14000" fill="#fff"/>',
      '<rect x="200" y="200" width="17600" height="13600" fill="#f8fafc" stroke="#0f172a" stroke-width="80"/>',
      '<text x="800" y="1200" font-size="520">Huge generated DocuLight media fixture</text>',
      '</svg>'
    ].join('');
    fs.writeFileSync(path.join(fixtureDir, 'huge-local.svg'), hugeSvg, 'utf-8');

    const smallSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#dbeafe"/></svg>';
    const tallSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="8000" viewBox="0 0 400 8000"><rect width="400" height="8000" fill="#dcfce7"/></svg>';
    const ultraTallSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="30000" viewBox="0 0 1 30000"><rect width="1" height="30000" fill="#f3e8ff"/></svg>';
    fs.writeFileSync(path.join(fixtureDir, 'small-local.svg'), smallSvg, 'utf-8');
    fs.writeFileSync(path.join(fixtureDir, 'tall-local.svg'), tallSvg, 'utf-8');
    fs.writeFileSync(path.join(fixtureDir, 'ultra-tall-local.svg'), ultraTallSvg, 'utf-8');

    const markdown = [
      '# Media Viewer E2E',
      '',
      '```mermaid',
      'flowchart TD',
      '  A["매우 긴 한국어 Mermaid 노드 라벨과 mixed language text that must stay inside the node box"] --> B["두 번째 긴 노드 라벨 with extra descriptive text"]',
      '  B --> C{"조건 분기 diamond node with long mixed-language label"}',
      '  C --> D(("원형 노드 circle shape with long mixed-language label"))',
      '```',
      '',
      '![Large local image](./large-local.svg)',
      '',
      `![Remote generated image](${imageServerBaseUrl}/remote.png)`,
      '',
      '![Huge local image](./huge-local.svg)',
      '',
      '![Small local image](./small-local.svg)',
      '',
      '![Tall local image](./tall-local.svg)',
      '',
      '![Ultra tall local image](./ultra-tall-local.svg)',
      '',
      '> ![Nested tall image](./tall-local.svg)'
    ].join('\n');
    fs.writeFileSync(path.join(fixtureDir, 'media.md'), markdown, 'utf-8');

    const electronPath = require('electron');
    app = await electron.launch({
      executablePath: typeof electronPath === 'string' ? electronPath : electronPath.toString(),
      args: [root, '--dev', '--profile=dev'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DOCULIGHT_PROFILE: 'dev',
        DOCULIGHT_DEV_USER_DATA_DIR: runtimeDir,
        DOCULIGHT_DEV_IPC_PATH: ipcPath,
        DOCULIGHT_MEDIA_VIEWER_ALLOW_PRIVATE_REMOTE: '1'
      },
      timeout: 30000
    });

    await waitForIpcServer();
  });

  test.afterAll(async () => {
    if (app) await app.close();
    if (imageServer) await new Promise((resolve) => imageServer.close(resolve));
    if (fixtureDir && fixtureDir.startsWith(os.tmpdir())) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
    if (runtimeDir && runtimeDir.startsWith(os.tmpdir())) {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  test.beforeEach(async () => {
    await closeAllMediaWindows();
    try {
      await sendIpcRequest('close_viewer');
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {
      // ignore cleanup errors
    }
  });

  test('opens Mermaid in an independent viewer and preserves layout and styles', async () => {
    const { viewer } = await openFixture(path.join(fixtureDir, 'media.md'));
    await expect(viewer.locator('.media-expand-wrapper-mermaid .media-expand-button')).toHaveCount(1);

    const previousMediaCount = app.windows().filter((win) => win.url().includes('media-viewer.html')).length;
    await viewer.locator('.media-expand-wrapper-mermaid .media-expand-button').click({ force: true });
    const media = await waitForMediaWindow(previousMediaCount);

    await expect(media.locator('#media-content svg')).toBeVisible();
    await expect(media.locator('.media-toolbar')).toBeVisible();
    await expect(media.locator('#media-fit-window')).toBeVisible();
    await expect.poll(async () => media.evaluate(() => {
      const toolbar = document.querySelector('.media-toolbar').getBoundingClientRect();
      return {
        topFloating: toolbar.top >= 8 && toolbar.top <= 18,
        rightFloating: window.innerWidth - toolbar.right >= 20 && window.innerWidth - toolbar.right <= 28
      };
    })).toEqual({ topFloating: true, rightFloating: true });
    await expect.poll(async () => media.evaluate(() => {
      const shapes = Array.from(document.querySelectorAll('#media-content svg g.node rect, #media-content svg g.node polygon, #media-content svg g.node ellipse, #media-content svg g.node circle, #media-content svg g.node path'));
      return shapes
        .map((shape) => getComputedStyle(shape).fill)
        .filter((fill) => fill && fill !== 'none');
    })).not.toContain('rgb(0, 0, 0)');
    await expect.poll(async () => media.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('#media-content svg g.node'))
        .map((node) => {
          const shape = node.querySelector('[data-doculight-media-shape]') ||
            node.querySelector('polygon') ||
            node.querySelector('rect') ||
            node.querySelector('ellipse') ||
            node.querySelector('circle') ||
            node.querySelector('path');
          if (!shape || typeof shape.getBoundingClientRect !== 'function') return null;
          const rect = shape.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        })
        .filter(Boolean);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const overlapWidth = Math.max(0, Math.min(boxes[i].right, boxes[j].right) - Math.max(boxes[i].left, boxes[j].left));
          const overlapHeight = Math.max(0, Math.min(boxes[i].bottom, boxes[j].bottom) - Math.max(boxes[i].top, boxes[j].top));
          if (overlapWidth * overlapHeight > 4) return false;
        }
      }
      return true;
    })).toBeTruthy();
    await expect.poll(async () => media.evaluate(() => {
      const svg = document.querySelector('#media-content svg');
      const viewBox = svg.getAttribute('viewBox').split(/\s+/).map(Number);
      const rect = svg.getBoundingClientRect();
      return viewBox.length === 4 &&
        rect.width >= viewBox[2] * 0.95 &&
        rect.height >= viewBox[3] * 0.95;
    })).toBeTruthy();
    const mermaidCenter = await mediaCenterDelta(media);
    expect(mermaidCenter.dx).toBeLessThanOrEqual(24);
    expect(mermaidCenter.dy).toBeLessThanOrEqual(24);
    await media.locator('#media-fit-window').click();
    await expect.poll(async () => media.evaluate(() => {
      const viewport = document.getElementById('media-viewport');
      const content = document.getElementById('media-content');
      const rect = content.getBoundingClientRect();
      return {
        transformed: /^scale\((?!1(?:\.0+)?\))/.test(content.style.transform),
        fitsWidth: rect.width <= Math.max(1, viewport.clientWidth - 96),
        fitsHeight: rect.height <= Math.max(1, viewport.clientHeight - 96)
      };
    })).toEqual({ transformed: true, fitsWidth: true, fitsHeight: true });
    await expect.poll(async () => {
      const center = await mediaCenterDelta(media);
      return center.dx <= 24 && center.dy <= 24;
    }).toBe(true);

    await viewer.close();
    await expect.poll(() => media.isClosed()).toBe(false);
  });

  test('opens a large local image with visible scrollbars, cursor zoom, and drag pan', async () => {
    const { viewer } = await openFixture(path.join(fixtureDir, 'media.md'));
    const previousMediaCount = app.windows().filter((win) => win.url().includes('media-viewer.html')).length;
    await viewer.locator('.media-expand-wrapper-image .media-expand-button').first().click({ force: true });
    const media = await waitForMediaWindow(previousMediaCount);

    await expect(media.locator('#media-content img')).toBeVisible();
    await expect.poll(async () => {
      const center = await mediaCenterDelta(media);
      return center.dx <= 24 && center.dy <= 24;
    }).toBe(true);
    await expect.poll(async () => media.evaluate(() => {
      const viewport = document.getElementById('media-viewport');
      return {
        overflow: getComputedStyle(viewport).overflow,
        hasHorizontal: viewport.scrollWidth > viewport.clientWidth,
        hasVertical: viewport.scrollHeight > viewport.clientHeight
      };
    })).toEqual({ overflow: 'scroll', hasHorizontal: true, hasVertical: true });

    const beforeTransform = await media.locator('#media-content').evaluate((el) => el.style.transform);
    await media.locator('#media-viewport').evaluate((viewport) => {
      viewport.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -240,
        clientX: 240,
        clientY: 180
      }));
    });
    await expect.poll(() => media.locator('#media-content').evaluate((el) => el.style.transform)).not.toBe(beforeTransform);

    const beforePan = await media.locator('#media-viewport').evaluate((viewport) => {
      viewport.scrollLeft = 120;
      viewport.scrollTop = 100;
      return { left: viewport.scrollLeft, top: viewport.scrollTop };
    });
    await media.locator('#media-viewport').evaluate((viewport) => {
      viewport.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 300, clientY: 300 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 230, clientY: 220 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await expect.poll(() => media.locator('#media-viewport').evaluate((viewport) => ({
      left: viewport.scrollLeft,
      top: viewport.scrollTop
    }))).not.toEqual(beforePan);

    await media.locator('#media-reset').click();
    await expect.poll(async () => {
      const center = await mediaCenterDelta(media);
      return center.dx <= 24 && center.dy <= 24;
    }).toBe(true);
  });

  test('fits a very large image below the normal manual zoom minimum', async () => {
    const { viewer } = await openFixture(path.join(fixtureDir, 'media.md'));
    const previousMediaCount = app.windows().filter((win) => win.url().includes('media-viewer.html')).length;
    await viewer.locator('.media-expand-wrapper-image .media-expand-button').nth(2).click({ force: true });
    const media = await waitForMediaWindow(previousMediaCount);

    await expect(media.locator('#media-content img')).toBeVisible();
    await media.locator('#media-fit-window').click();
    await expect.poll(async () => media.evaluate(() => {
      const viewport = document.getElementById('media-viewport');
      const content = document.getElementById('media-content');
      const rect = content.getBoundingClientRect();
      const match = content.style.transform.match(/scale\(([^)]+)\)/);
      const scale = match ? Number(match[1]) : 1;
      return {
        belowManualMinimum: scale > 0 && scale < 0.1,
        fitsWidth: rect.width <= Math.max(1, viewport.clientWidth - 96),
        fitsHeight: rect.height <= Math.max(1, viewport.clientHeight - 96)
      };
    })).toEqual({ belowManualMinimum: true, fitsWidth: true, fitsHeight: true });
    await expect.poll(async () => {
      const center = await mediaCenterDelta(media);
      return center.dx <= 24 && center.dy <= 24;
    }).toBe(true);
  });

  test('FR-RENDER-030 sizes inline media responsively and enforces zoom bounds', async () => {
    const { viewer } = await openFixture(path.join(fixtureDir, 'media.md'));
    const imageWrappers = viewer.locator('.media-expand-wrapper-image');
    const mermaidWrapper = viewer.locator('.media-expand-wrapper-mermaid').first();
    const mermaidSvg = mermaidWrapper.locator('svg');
    const smallImage = viewer.locator('img[alt="Small local image"]');
    const tallImage = viewer.locator('img[alt="Tall local image"]');
    const ultraTallImage = viewer.locator('img[alt="Ultra tall local image"]');
    const nestedTallImage = viewer.locator('img[alt="Nested tall image"]');
    const small = imageWrappers.filter({ has: smallImage });
    const tall = imageWrappers.filter({ has: tallImage });
    const ultraTall = imageWrappers.filter({ has: ultraTallImage });
    const nestedTall = imageWrappers.filter({ has: nestedTallImage });

    await expect(small).toHaveCount(1);
    await expect(tall).toHaveCount(1);
    await expect(ultraTall).toHaveCount(1);
    await expect(nestedTall).toHaveCount(1);
    await expect(mermaidSvg).toBeVisible();
    await expect(smallImage).toBeVisible();
    await expect(tallImage).toBeVisible();
    await expect(ultraTallImage).toBeVisible();
    await expect(nestedTallImage).toBeVisible();
    await expect.poll(() => smallImage.evaluate((img) => img.complete && img.naturalWidth === 200 && img.naturalHeight === 100)).toBe(true);
    await expect.poll(() => tallImage.evaluate((img) => img.complete && img.naturalHeight === 8000)).toBe(true);
    await expect.poll(() => ultraTallImage.evaluate((img) => img.complete && img.naturalWidth === 1 && img.naturalHeight === 30000)).toBe(true);
    await expect.poll(() => nestedTallImage.evaluate((img) => img.complete && img.naturalHeight === 8000)).toBe(true);

    const mermaidAutoFit = await expectedInlineAutoFitPercent(mermaidSvg);
    await expectInlineMediaPercent(mermaidWrapper, mermaidAutoFit);

    const smallToolbar = small.locator('.media-inline-toolbar');
    const smallZoomOut = small.locator('.media-inline-zoom-out');
    const smallZoomIn = small.locator('.media-inline-zoom-in');
    const tallZoomOut = tall.locator('.media-inline-zoom-out');
    const tallZoomIn = tall.locator('.media-inline-zoom-in');

    await expect(smallToolbar).toHaveCount(1);
    await expect.poll(() => smallToolbar.evaluate((toolbar) => Array.from(toolbar.children).map((child) => {
      if (child.classList.contains('media-expand-button')) return 'expand';
      if (child.classList.contains('media-inline-zoom-out')) return 'zoom-out';
      if (child.classList.contains('media-inline-zoom-in')) return 'zoom-in';
      return 'unexpected';
    }))).toEqual(['expand', 'zoom-out', 'zoom-in']);

    await small.hover({ position: { x: 1, y: 1 } });
    await expectInlineToolbarAtDocumentEdge(small);
    await mermaidWrapper.hover({ position: { x: 1, y: 1 } });
    await expectInlineToolbarAtDocumentEdge(mermaidWrapper);

    await expectInlineMediaPercent(small, 100);
    await expectNativeDisabledStyle(smallZoomIn, smallZoomOut);

    await smallZoomOut.focus();
    await expect.poll(() => smallToolbar.evaluate((toolbar) => getComputedStyle(toolbar).opacity)).toBe('1');
    await smallZoomOut.press('Enter');
    await expectInlineMediaPercent(small, 90);
    await expectInlineToolbarAtDocumentEdge(small);
    await smallZoomIn.click();
    await expectInlineMediaPercent(small, 100);
    await expect.poll(() => smallToolbar.evaluate((toolbar) => ({
      opacity: getComputedStyle(toolbar).opacity,
      pointerEvents: getComputedStyle(toolbar).pointerEvents
    }))).toEqual({ opacity: '1', pointerEvents: 'auto' });

    for (const expectedPercent of [90, 80, 70, 60, 50, 40, 30, 25]) {
      await smallZoomOut.click();
      await expectInlineMediaPercent(small, expectedPercent);
    }
    await expectNativeDisabledStyle(smallZoomOut, smallZoomIn);

    const tallMinimum = await expectedInlineAutoFitPercent(tallImage);
    expect(tallMinimum).toBeGreaterThan(0);
    expect(tallMinimum).toBeLessThan(25);
    await expectInlineMediaPercent(tall, tallMinimum);
    await expect.poll(() => tall.evaluate((wrapper) => {
      const viewport = document.getElementById('viewer-container');
      return wrapper.getBoundingClientRect().height <= viewport.clientHeight * 0.9 + 2;
    })).toBe(true);
    await expectNativeDisabledStyle(tallZoomOut, tallZoomIn);

    await tall.hover({ position: { x: 1, y: 1 } });
    const tallToolbarGeometry = await expectInlineToolbarAtDocumentEdge(tall);
    expect(tallToolbarGeometry.toolbarLeft).toBeGreaterThan(tallToolbarGeometry.wrapperRight + 1);
    const tallToolbar = tall.locator('.media-inline-toolbar');
    await tallToolbar.hover();
    await expect.poll(() => tallToolbar.evaluate((toolbar) => ({
      opacity: getComputedStyle(toolbar).opacity,
      pointerEvents: getComputedStyle(toolbar).pointerEvents
    }))).toEqual({ opacity: '1', pointerEvents: 'auto' });
    await expectToolbarReachableAcrossExternalGap(viewer, tall);

    const ultraTallMinimum = await expectedInlineAutoFitPercent(ultraTallImage);
    expect(ultraTallMinimum).toBeGreaterThan(0);
    expect(ultraTallMinimum).toBeLessThan(0.01);
    await expectInlineMediaPercent(ultraTall, ultraTallMinimum);
    await expect.poll(() => ultraTall.evaluate((wrapper) => {
      const viewport = document.getElementById('viewer-container');
      return wrapper.getBoundingClientRect().height <= viewport.clientHeight * 0.9 + 2;
    })).toBe(true);

    const nestedTallMinimum = await expectedInlineAutoFitPercent(nestedTallImage);
    await expectInlineMediaPercent(nestedTall, nestedTallMinimum);
    await expect.poll(() => nestedTall.evaluate((wrapper) => {
      const content = document.getElementById('content');
      const parent = wrapper.parentElement;
      const rect = wrapper.getBoundingClientRect();
      return parent.clientWidth < content.clientWidth && rect.width <= parent.clientWidth + 1;
    })).toBe(true);
    await expectInlineToolbarAtDocumentEdge(nestedTall);

    await nestedTall.evaluate((wrapper) => {
      const parent = wrapper.closest('blockquote');
      parent.style.transform = 'translateX(24px)';
    });
    await expectInlineToolbarAtDocumentEdge(nestedTall);
    await nestedTall.evaluate((wrapper) => {
      wrapper.closest('blockquote').style.transform = '';
    });
    await expectInlineToolbarAtDocumentEdge(nestedTall);

    await nestedTall.evaluate((wrapper) => {
      const parent = wrapper.closest('blockquote');
      parent.style.transformOrigin = 'left top';
      parent.style.transform = 'scaleX(0.75)';
    });
    await expectInlineToolbarAtDocumentEdge(nestedTall);
    await nestedTall.evaluate((wrapper) => {
      const parent = wrapper.closest('blockquote');
      parent.style.transform = '';
      parent.style.transformOrigin = '';
    });
    await expectInlineToolbarAtDocumentEdge(nestedTall);

    const originalViewport = await viewer.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await viewer.setViewportSize({
      width: originalViewport.width,
      height: Math.max(420, originalViewport.height - 160)
    });
    const resizedTallMinimum = await expectedInlineAutoFitPercent(tallImage);
    expect(Math.abs(resizedTallMinimum - tallMinimum)).toBeGreaterThan(0.01);
    await expectInlineMediaPercent(tall, resizedTallMinimum);

    await tall.hover({ position: { x: 1, y: 1 } });
    await tallZoomIn.click();
    await expectInlineMediaPercent(tall, resizedTallMinimum + 10);
    await tallZoomOut.click();
    await expectInlineMediaPercent(tall, resizedTallMinimum);
    await expectNativeDisabledStyle(tallZoomOut, tallZoomIn);

    await viewer.setViewportSize({
      width: Math.max(620, originalViewport.width - 140),
      height: originalViewport.height
    });
    await expectInlineMediaPercent(tall, resizedTallMinimum);
    const resizedMermaidAutoFit = await expectedInlineAutoFitPercent(mermaidSvg);
    await expectInlineMediaPercent(mermaidWrapper, resizedMermaidAutoFit);
    await expectInlineToolbarAtDocumentEdge(tall);
    await expectInlineToolbarAtDocumentEdge(mermaidWrapper);
  });

  test('FR-RENDER-030 keeps the latest controller across overlapping renders and PDF cleanup', async () => {
    const { viewer } = await openFixture(path.join(fixtureDir, 'media.md'));

    await viewer.evaluate(async () => {
      const render = window.DocuLight.fn.renderMarkdown;
      const originalRender = mermaid.render.bind(mermaid);
      let delayFirst = true;
      mermaid.render = async (...args) => {
        if (delayFirst) {
          delayFirst = false;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return originalRender(...args);
      };
      try {
        const stale = render('```mermaid\nflowchart LR\n  OLD --> STALE\n```');
        await new Promise((resolve) => setTimeout(resolve, 10));
        const latest = render('![Latest tall image](./tall-local.svg)');
        await Promise.all([stale, latest]);
      } finally {
        mermaid.render = originalRender;
      }
    });

    const latestImage = viewer.locator('img[alt="Latest tall image"]');
    const latestWrapper = viewer.locator('.media-expand-wrapper-image').filter({ has: latestImage });
    await expect(latestImage).toBeVisible();
    await expect(latestWrapper).toHaveCount(1);
    const beforeResize = await expectedInlineAutoFitPercent(latestImage);
    await expectInlineMediaPercent(latestWrapper, beforeResize);

    const viewport = await viewer.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await viewer.setViewportSize({ width: viewport.width, height: Math.max(420, viewport.height - 180) });
    const afterResize = await expectedInlineAutoFitPercent(latestImage);
    expect(Math.abs(afterResize - beforeResize)).toBeGreaterThan(0.01);
    await expectInlineMediaPercent(latestWrapper, afterResize);

    await viewer.evaluate(async () => {
      document.body.classList.add('pdf-mode');
      await window.DocuLight.fn.renderMarkdown('![PDF media](./small-local.svg)');
    });
    await expect(viewer.locator('.media-expand-wrapper')).toHaveCount(0);
  });

  test('opens a generated remote image through the media viewer bridge', async () => {
    const { viewer } = await openFixture(path.join(fixtureDir, 'media.md'));
    const previousMediaCount = app.windows().filter((win) => win.url().includes('media-viewer.html')).length;
    await viewer.locator('.media-expand-wrapper-image .media-expand-button').nth(1).click({ force: true });
    const media = await waitForMediaWindow(previousMediaCount);

    await expect(media.locator('#media-content img')).toBeVisible();
    await expect.poll(() => media.locator('#media-content img').getAttribute('src')).toContain('data:image/png;base64,');
  });

  test('opens a readable absolute md path pasted into the viewer', async () => {
    const pastedPath = path.join(fixtureDir, 'pasted-open.md');
    fs.writeFileSync(pastedPath, '# Pasted Open Target\n\nOpened from an absolute path paste.', 'utf-8');

    const result = await sendIpcRequest('open_markdown', { content: '# Current Content', title: 'Current Content' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const viewer = app.windows().find((win) => win.url().includes('viewer.html'));
    expect(viewer).toBeTruthy();

    await viewer.evaluate((targetPath) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          getData(type) {
            return type === 'text/plain' ? targetPath : '';
          }
        }
      });
      document.dispatchEvent(event);
    }, pastedPath);

    await expect.poll(() => viewer.locator('h1').first().textContent()).toBe('Pasted Open Target');
    await expect.poll(() => viewer.evaluate(() => window.DocuLight.state.currentFilePath)).toBe(pastedPath.replace(/\\/g, '/'));
    await sendIpcRequest('close_viewer', { windowId: result.windowId });
  });

  test('keeps current content when a missing absolute md path is pasted into a non-empty viewer', async () => {
    const missingPath = path.join(fixtureDir, 'missing-paste-target.md');
    const result = await sendIpcRequest('open_markdown', { content: '# Current Content', title: 'Current Content' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const viewer = app.windows().find((win) => win.url().includes('viewer.html'));
    expect(viewer).toBeTruthy();

    await viewer.evaluate((targetPath) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          getData(type) {
            return type === 'text/plain' ? targetPath : '';
          }
        }
      });
      document.dispatchEvent(event);
    }, missingPath);

    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect.poll(() => viewer.locator('h1').first().textContent()).toBe('Current Content');
    await expect.poll(() => viewer.evaluate(() => window.DocuLight.state.currentFilePath)).toBe(null);
    await sendIpcRequest('close_viewer', { windowId: result.windowId });
  });
});
