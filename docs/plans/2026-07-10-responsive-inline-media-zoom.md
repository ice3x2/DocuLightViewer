# Responsive Inline Media Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `FR-RENDER-030` so inline Markdown images and Mermaid diagrams fill the document width when possible, auto-fit to 90% of the document viewport height, and expose bounded responsive zoom controls beside the existing dedicated-viewer control.

**Architecture:** Keep dedicated media viewer behavior unchanged. Add a renderer-local inline media controller that stores percentage width state per wrapper, derives aspect ratio from image intrinsic dimensions or Mermaid SVG viewBox, applies initial height-aware fitting, and reflows unadjusted media through a shared `ResizeObserver`. Render one hover/focus toolbar per media wrapper with expand, zoom-out, and zoom-in buttons.

**Tech Stack:** Electron renderer JavaScript, CSS custom properties, DOM `ResizeObserver`, Node static contract tests, Playwright Electron E2E, SpecKiwi SRS.

## Global Constraints

- Requirement ID: `FR-RENDER-030`, extending `FR-RENDER-028`.
- Inline default width is 100% of `#content`; intrinsic media size does not cap it.
- Initial media height must not exceed 90% of `#viewer-container.clientHeight`.
- Auto-fit percentages may be below 25%; manual zoom uses 10 percentage point steps.
- Manual maximum is 100%; manual minimum is `min(25, autoFitPercent)`.
- Auto-fit percentage is floored to 0.01%; disabled boundary epsilon is 0.01%.
- Hover/focus toolbar order is expand, zoom-out, zoom-in.
- Limit buttons use the native `disabled` attribute and a visible gray disabled style.
- User-visible labels reuse locale keys `viewer.media.expand`, `viewer.media.zoomOut`, and `viewer.media.zoomIn` in all four locales.
- Existing dedicated media viewer zoom, pan, fit, reset, download, security, and always-on-top behavior must not change.
- Do not commit automatically: the worktree contains overlapping user changes in the target files.

---

### Task 1: Add RED contracts for responsive inline media

**Files:**
- Modify: `test/test-media-viewer-contract.js`
- Modify: `test/media-viewer.e2e.js`

**Interfaces:**
- Consumes: existing `.media-expand-wrapper`, `.media-expand-button`, and `openFixture()` test helpers.
- Produces: failing assertions for `setupInlineMediaController`, `.media-inline-toolbar`, `.media-inline-zoom-out`, `.media-inline-zoom-in`, CSS percentage width, height fit, 10%p zoom, and disabled bounds.

- [x] **Step 1: Extend the static contract with FR-RENDER-030 tokens**

```js
for (const token of [
  'INLINE_MEDIA_ZOOM_STEP',
  'INLINE_MEDIA_MANUAL_MIN',
  'INLINE_MEDIA_MAX',
  'INLINE_MEDIA_HEIGHT_RATIO',
  'setupInlineMediaController',
  'calculateInlineAutoFitPercent',
  'applyInlineMediaPercent',
  'ResizeObserver',
  'media-inline-toolbar',
  'media-inline-zoom-out',
  'media-inline-zoom-in'
]) {
  mediaAssert(viewerJs.includes(token), `FR-RENDER-030 viewer contains ${token}`);
}

mediaAssert(/\.media-expand-wrapper[\s\S]*width:\s*var\(--inline-media-width/.test(viewerCss),
  'FR-RENDER-030 wrapper width is controlled by a percentage CSS property');
mediaAssert(/\.media-inline-tool-button:disabled[\s\S]*cursor:\s*not-allowed/.test(viewerCss),
  'FR-RENDER-030 limit controls have a visible disabled style');
```

- [x] **Step 2: Add generated small and tall SVG fixtures after existing image fixtures**

```js
const smallSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#dbeafe"/></svg>';
const tallSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="8000" viewBox="0 0 400 8000"><rect width="400" height="8000" fill="#dcfce7"/></svg>';
fs.writeFileSync(path.join(fixtureDir, 'small-local.svg'), smallSvg, 'utf-8');
fs.writeFileSync(path.join(fixtureDir, 'tall-local.svg'), tallSvg, 'utf-8');
```

Append `![Small local image](./small-local.svg)` and `![Tall local image](./tall-local.svg)` after the existing huge image so existing `nth()` selectors remain stable.

- [x] **Step 3: Add E2E scenarios for default, auto-fit, controls, and disabled state**

```js
test('sizes inline media responsively and enforces zoom bounds', async () => {
  const { viewer } = await openFixture(path.join(fixtureDir, 'media.md'));
  const wrappers = viewer.locator('.media-expand-wrapper-image');
  const small = wrappers.nth(3);
  const tall = wrappers.nth(4);

  await expect.poll(() => small.evaluate((wrapper) => {
    const content = document.getElementById('content');
    return Math.abs(wrapper.getBoundingClientRect().width - content.clientWidth) <= 2;
  })).toBe(true);

  await expect.poll(() => tall.evaluate((wrapper) => {
    const viewport = document.getElementById('viewer-container');
    return wrapper.getBoundingClientRect().height <= viewport.clientHeight * 0.9 + 2;
  })).toBe(true);

  await expect(small.locator('.media-inline-zoom-in')).toBeDisabled();
  await small.locator('.media-inline-zoom-out').click();
  await expect(small.locator('.media-inline-zoom-in')).toBeEnabled();
});
```

- [x] **Step 4: Run RED tests**

Run: `node test/test-media-viewer-contract.js`

Expected: FAIL because the inline controller and toolbar tokens do not exist.

Run: `npx playwright test test/media-viewer.e2e.js --reporter=line`

Expected: FAIL in the new inline sizing scenario while existing dedicated-viewer scenarios remain diagnostic evidence.

---

### Task 2: Implement percentage sizing and height-aware auto-fit

**Files:**
- Modify: `src/renderer/viewer.js:540-620`
- Modify: `src/renderer/viewer.css:336-390`

**Interfaces:**
- Consumes: `#content.clientWidth`, `#viewer-container.clientHeight`, image `naturalWidth/naturalHeight`, Mermaid SVG `viewBox`.
- Produces: `calculateInlineAutoFitPercent(media, contentWidth, viewportHeight)`, `applyInlineMediaPercent(entry, percent)`, and `setupInlineMediaController(container)`.

- [x] **Step 1: Add deterministic sizing constants and aspect-ratio extraction**

```js
const INLINE_MEDIA_ZOOM_STEP = 10;
const INLINE_MEDIA_MANUAL_MIN = 25;
const INLINE_MEDIA_MAX = 100;
const INLINE_MEDIA_HEIGHT_RATIO = 0.9;
const INLINE_MEDIA_EPSILON = 0.01;
let inlineMediaResizeObserver = null;

function getInlineMediaAspectRatio(media) {
  if (media.tagName === 'IMG' && media.naturalWidth > 0 && media.naturalHeight > 0) {
    return media.naturalWidth / media.naturalHeight;
  }
  const svg = media.matches('.mermaid') ? media.querySelector('svg') : null;
  const viewBox = svg && svg.viewBox && svg.viewBox.baseVal;
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) return viewBox.width / viewBox.height;
  return 0;
}
```

- [x] **Step 2: Implement auto-fit and percentage application**

```js
function calculateInlineAutoFitPercent(media, contentWidth, viewportHeight) {
  const ratio = getInlineMediaAspectRatio(media);
  if (!(ratio > 0) || !(contentWidth > 0) || !(viewportHeight > 0)) return INLINE_MEDIA_MAX;
  const raw = (viewportHeight * INLINE_MEDIA_HEIGHT_RATIO * ratio / contentWidth) * 100;
  return Math.min(INLINE_MEDIA_MAX, Math.floor(raw * 100) / 100);
}

function applyInlineMediaPercent(entry, percent) {
  entry.currentPercent = Math.max(entry.minPercent, Math.min(INLINE_MEDIA_MAX, percent));
  entry.wrapper.style.setProperty('--inline-media-width', `${entry.currentPercent}%`);
  entry.wrapper.dataset.inlineMediaPercent = String(entry.currentPercent);
  entry.zoomOut.disabled = entry.currentPercent <= entry.minPercent + INLINE_MEDIA_EPSILON;
  entry.zoomIn.disabled = entry.currentPercent >= INLINE_MEDIA_MAX - INLINE_MEDIA_EPSILON;
}
```

- [x] **Step 3: Initialize after media readiness and observe layout changes**

```js
function initializeInlineMediaEntry(entry, content, viewport) {
  entry.autoFitPercent = calculateInlineAutoFitPercent(entry.media, content.clientWidth, viewport.clientHeight);
  entry.minPercent = Math.min(INLINE_MEDIA_MANUAL_MIN, entry.autoFitPercent);
  if (!entry.userAdjusted) applyInlineMediaPercent(entry, entry.autoFitPercent);
}

function setupInlineMediaController(container, entries) {
  if (inlineMediaResizeObserver) inlineMediaResizeObserver.disconnect();
  const viewport = document.getElementById('viewer-container');
  if (!viewport || typeof ResizeObserver === 'undefined') return;
  inlineMediaResizeObserver = new ResizeObserver(() => {
    entries.forEach((entry) => {
      if (!entry.userAdjusted) initializeInlineMediaEntry(entry, container, viewport);
    });
  });
  inlineMediaResizeObserver.observe(container);
  inlineMediaResizeObserver.observe(viewport);
}
```

For images, call initialization immediately when `img.complete && img.naturalWidth > 0`; otherwise attach `{ once: true }` to `load`. Mermaid SVG is ready after `renderMermaidDiagrams()` resolves.

- [x] **Step 4: Make wrapper and media dimensions responsive in CSS**

```css
.media-expand-wrapper {
  position: relative;
  display: block;
  width: var(--inline-media-width, 100%);
  max-width: 100%;
  margin: 1em auto;
}

.media-expand-wrapper-image img,
.media-expand-wrapper-mermaid > .mermaid,
.media-expand-wrapper-mermaid svg {
  display: block;
  width: 100% !important;
  max-width: none !important;
  height: auto !important;
}
```

- [x] **Step 5: Run focused static contract**

Run: `node test/test-media-viewer-contract.js`

Expected: sizing/controller token assertions PASS; toolbar assertions may remain RED until Task 3.

---

### Task 3: Implement hover/focus toolbar and bounded zoom

**Files:**
- Modify: `src/renderer/viewer.js:548-618`
- Modify: `src/renderer/viewer.css:358-390`

**Interfaces:**
- Consumes: Task 2 entry shape `{ wrapper, media, currentPercent, autoFitPercent, minPercent, userAdjusted, zoomOut, zoomIn }`.
- Produces: `.media-inline-toolbar` containing `.media-expand-button`, `.media-inline-zoom-out`, and `.media-inline-zoom-in` in that order.

- [x] **Step 1: Add a localized icon button factory**

```js
function createInlineMediaToolButton(className, labelKey, icon, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `media-inline-tool-button ${className}`;
  button.setAttribute('title', t(labelKey));
  button.setAttribute('aria-label', t(labelKey));
  button.textContent = icon;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}
```

- [x] **Step 2: Build toolbar and wire 10%p zoom**

```js
const toolbar = document.createElement('div');
toolbar.className = 'media-inline-toolbar';
const expand = createMediaExpandButton(payloadFactory);
const zoomOut = createInlineMediaToolButton('media-inline-zoom-out', 'viewer.media.zoomOut', '-', () => {
  entry.userAdjusted = true;
  applyInlineMediaPercent(entry, Math.max(entry.minPercent, entry.currentPercent - INLINE_MEDIA_ZOOM_STEP));
});
const zoomIn = createInlineMediaToolButton('media-inline-zoom-in', 'viewer.media.zoomIn', '+', () => {
  entry.userAdjusted = true;
  applyInlineMediaPercent(entry, Math.min(INLINE_MEDIA_MAX, entry.currentPercent + INLINE_MEDIA_ZOOM_STEP));
});
toolbar.append(expand, zoomOut, zoomIn);
```

- [x] **Step 3: Style hover/focus and native disabled states**

```css
.media-inline-toolbar {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 5;
  display: flex;
  gap: 4px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}

.media-expand-wrapper:hover > .media-inline-toolbar,
.media-expand-wrapper:focus-within > .media-inline-toolbar {
  opacity: 1;
  pointer-events: auto;
}

.media-inline-tool-button:disabled {
  color: #a8adb4;
  background: #eef0f2;
  cursor: not-allowed;
  opacity: 0.65;
}
```

Keep `.media-expand-button` as a compatibility selector by adding `media-inline-tool-button` to its class list. Hide `.media-inline-toolbar` in PDF mode.

- [x] **Step 4: Run static and E2E tests to GREEN**

Run: `node test/test-media-viewer-contract.js`

Expected: PASS.

Run: `npx playwright test test/media-viewer.e2e.js --reporter=line`

Expected: all media viewer tests PASS, including responsive inline sizing and zoom bounds.

---

### Task 4: Verify resize persistence, regressions, and SRS evidence

**Files:**
- Modify: `test/media-viewer.e2e.js`
- Modify through SpecKiwi: `docs/spec/80.renderer-pipeline.srs.md` (`FR-RENDER-030` only)
- Modify through SpecKiwi if counts change: `docs/spec/00.index.md`

**Interfaces:**
- Consumes: completed inline media controller and toolbar.
- Produces: authoritative E2E evidence for AC-1 through AC-8 and a verified requirement state only after all checks pass.

- [x] **Step 1: Add a resize persistence assertion**

```js
const before = await small.evaluate((wrapper) => Number(wrapper.dataset.inlineMediaPercent));
await viewer.setViewportSize({ width: 760, height: 620 });
await expect.poll(() => small.evaluate((wrapper) => Number(wrapper.dataset.inlineMediaPercent))).toBe(before);
await expect.poll(() => small.evaluate((wrapper) => {
  const content = document.getElementById('content');
  return wrapper.getBoundingClientRect().width <= content.clientWidth + 2;
})).toBe(true);
```

Add a separate unadjusted tall-media resize assertion proving its auto-fit percentage recalculates against `#viewer-container.clientHeight`.

- [x] **Step 2: Run focused and regression checks**

Run: `node test/test-media-viewer-contract.js`

Expected: PASS.

Run: `npx playwright test test/media-viewer.e2e.js --reporter=line`

Expected: PASS.

Run: `node test/test-media-viewer-window-contract.js`

Expected: PASS.

Run: `node test/test-media-viewer-remote-image-contract.js`

Expected: PASS.

Run: `speckiwi validate --strict --fail-on-warning --json`

Expected: zero errors and zero warnings.

- [x] **Step 3: Request an independent sub-agent review**

Review scope: `FR-RENDER-030`, `src/renderer/viewer.js`, `src/renderer/viewer.css`, `test/test-media-viewer-contract.js`, and `test/media-viewer.e2e.js`. Require findings ordered by severity and corrections for any behavioral, accessibility, lifecycle, or regression issue.

- [x] **Step 4: Address findings and rerun all checks**

Repeat the exact commands from Step 2 after every accepted correction. Explicitly reject any finding that conflicts with `FR-RENDER-030`, with the requirement text cited in the review record.

- [x] **Step 5: Record SpecKiwi evidence and completion state**

Add verification evidence covering AC-1 through AC-8 with the focused commands and sub-agent review summary. Check each AC only after its evidence passes, update status to `verified`, add a Completed Work Log entry, and run strict validation again.

## Self-Review

- Spec coverage: Tasks 2 and 3 cover AC-1 through AC-7; Task 4 covers dedicated-viewer and output regressions in AC-8.
- Placeholder scan: no incomplete implementation markers are present.
- Type consistency: every task uses the same entry fields and the same `calculateInlineAutoFitPercent`, `applyInlineMediaPercent`, and `setupInlineMediaController` names.
- Safety: no main/preload IPC or dedicated media viewer files are changed.
- Working tree: automatic commits are intentionally omitted because target files already contain overlapping uncommitted user work.
