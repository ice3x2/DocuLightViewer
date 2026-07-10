# Inline Media Toolbar Document-Edge Positioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or an equivalent independent implementation/review loop. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `FR-RENDER-031` so every inline image and Mermaid toolbar shares the media top Y coordinate while its right edge aligns with the current `#content` right edge.

**Architecture:** Keep `.media-inline-toolbar` as a child of `.media-expand-wrapper` so the existing hover, focus-within, and keyboard behavior survives. The renderer calculates the offset between the wrapper's right edge and `#content`'s right edge, writes it to `--inline-media-toolbar-right`, and CSS uses that value as the toolbar's absolute `right` offset. The existing inline-media `ResizeObserver` recalculates this value after initial media sizing and every relevant layout change.

**Tech Stack:** Electron renderer JavaScript, CSS custom properties, DOM `ResizeObserver`, Node static contract tests, Playwright Electron E2E, SpecKiwi SRS.

## Global Constraints

- Requirement ID: `FR-RENDER-031`, extending verified `FR-RENDER-030`.
- Toolbar top and `#content` right-edge alignment tolerance is 1 CSS px in E2E assertions.
- The toolbar remains a child of its media wrapper; do not introduce a global overlay layer.
- A narrow auto-fitted image or Mermaid must expose the toolbar outside the media's right edge while preserving the shared top Y coordinate.
- At full document width, media and document right edges coincide, so the toolbar appears at their common top-right corner.
- Existing order remains expand, zoom-out, zoom-in; locales, focus behavior, native disabled state, zoom sizing, dedicated media viewer, and PDF mode must not change.
- Preserve unrelated user changes in the shared dirty `main` worktree. Do not create commits automatically.

---

### Task 1: Define the failing document-edge placement contracts

**Files:**
- Modify: `test/test-media-viewer-contract.js`
- Modify: `test/media-viewer.e2e.js`

**Interfaces:**
- Consumes: `.media-expand-wrapper`, `.media-inline-toolbar`, `#content`, `openFixture()`, and the existing `media.md` image/Mermaid fixture.
- Produces: static and browser assertions that fail while the toolbar is still `top: 6px; left: 6px` inside its wrapper.

- [x] **Step 1: Add a static contract for the new renderer positioning helper**

```js
const positionInlineMediaToolbarSource = functionSource(viewerJs, 'positionInlineMediaToolbar');
inlineMediaAssert(
  positionInlineMediaToolbarSource.includes("document.getElementById('content')") &&
    positionInlineMediaToolbarSource.includes('getBoundingClientRect') &&
    positionInlineMediaToolbarSource.includes("style.setProperty('--inline-media-toolbar-right'"),
  'FR-RENDER-031 computes the wrapper-to-content right-edge offset'
);
```

- [x] **Step 2: Add static CSS contracts that reject the old top-left placement**

```js
inlineMediaAssert(
  /top:\s*0(?:px)?/.test(inlineToolbarCss) &&
    /right:\s*var\(--inline-media-toolbar-right(?:,\s*0px)?\)/.test(inlineToolbarCss) &&
    !/left:\s*6px/.test(inlineToolbarCss),
  'FR-RENDER-031 toolbar uses its media top and the computed content-right offset'
);
```

- [x] **Step 3: Add reusable E2E geometry helpers and assertions**

```js
async function inlineToolbarGeometry(wrapper) {
  return wrapper.evaluate((entry) => {
    const toolbar = entry.querySelector('.media-inline-toolbar').getBoundingClientRect();
    const wrapperRect = entry.getBoundingClientRect();
    const contentRect = document.getElementById('content').getBoundingClientRect();
    return { toolbarTop: toolbar.top, toolbarRight: toolbar.right, wrapperTop: wrapperRect.top, wrapperRight: wrapperRect.right, contentRight: contentRect.right };
  });
}

async function expectInlineToolbarAtDocumentEdge(wrapper) {
  await expect.poll(() => inlineToolbarGeometry(wrapper)).toMatchObject({});
  const geometry = await inlineToolbarGeometry(wrapper);
  expect(Math.abs(geometry.toolbarTop - geometry.wrapperTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.toolbarRight - geometry.contentRight)).toBeLessThanOrEqual(1);
  return geometry;
}
```

- [x] **Step 4: Extend `FR-RENDER-030 sizes inline media responsively and enforces zoom bounds` with document-edge cases**

```js
await small.hover({ position: { x: 1, y: 1 } });
await expectInlineToolbarAtDocumentEdge(small);
await mermaidWrapper.hover({ position: { x: 1, y: 1 } });
await expectInlineToolbarAtDocumentEdge(mermaidWrapper);

await tall.hover({ position: { x: 1, y: 1 } });
const tallGeometry = await expectInlineToolbarAtDocumentEdge(tall);
expect(tallGeometry.toolbarRight).toBeGreaterThan(tallGeometry.wrapperRight + 1);
```

After the existing viewport-width resize, repeat `expectInlineToolbarAtDocumentEdge()` for the tall image and Mermaid. This proves the observer recalculates the offset and does not merely set it once.

- [x] **Step 5: Run RED checks and confirm expected failure**

Run: `node test/test-media-viewer-contract.js`

Expected: FAIL because `positionInlineMediaToolbar` and `--inline-media-toolbar-right` do not exist and the toolbar still uses `top: 6px; left: 6px`.

Run: `npx playwright test test/media-viewer.e2e.js --reporter=line`

Expected: FAIL only in the new geometry assertions because the current toolbar remains at the wrapper's upper-left corner.

### Task 2: Implement wrapper-relative document-edge positioning

**Files:**
- Modify: `src/renderer/viewer.js`
- Modify: `src/renderer/viewer.css`
- Test: `test/test-media-viewer-contract.js`
- Test: `test/media-viewer.e2e.js`

**Interfaces:**
- Consumes: `createInlineMediaEntry(wrapper, media, payloadFactory)`, `initializeInlineMediaEntry(entry, container, viewport)`, and `setupInlineMediaController(container, entries)`.
- Produces: `positionInlineMediaToolbar(entry, container)` and CSS variable `--inline-media-toolbar-right`.

- [x] **Step 1: Add the toolbar reference to each entry and write the positioning helper**

```js
function positionInlineMediaToolbar(entry, container) {
  if (!entry || !entry.wrapper || !entry.toolbar || !container) return;
  const wrapperRect = entry.wrapper.getBoundingClientRect();
  const contentRect = container.getBoundingClientRect();
  entry.toolbar.style.setProperty(
    '--inline-media-toolbar-right',
    `${wrapperRect.right - contentRect.right}px`
  );
}
```

Assign `toolbar` on the entry returned by `createInlineMediaEntry()`.

- [x] **Step 2: Invoke the helper after layout-affecting operations**

```js
function initializeInlineMediaEntry(entry, container, viewport) {
  // existing percentage and min-percent calculation
  if (!entry.userAdjusted) applyInlineMediaPercent(entry, autoFitPercent);
  positionInlineMediaToolbar(entry, container);
}
```

In the existing shared `ResizeObserver` animation-frame callback, call `positionInlineMediaToolbar(entry, container)` for every entry, including user-adjusted media. This decouples positioning from whether the width is recalculated.

- [x] **Step 3: Replace the toolbar's CSS placement**

```css
.media-inline-toolbar {
  position: absolute;
  top: 0;
  right: var(--inline-media-toolbar-right, 0px);
  z-index: 5;
  /* retain existing display, visibility, pointer, and transition rules */
}
```

Remove `left: 6px`. Do not add clipping to `.media-expand-wrapper`; toolbar overflow must remain visible when media is narrower than `#content`.

- [x] **Step 4: Run GREEN checks**

Run: `node test/test-media-viewer-contract.js`

Expected: PASS.

Run: `npx playwright test test/media-viewer.e2e.js --reporter=line`

Expected: PASS, including image, Mermaid, narrow-media, and resize placement assertions.

- [x] **Step 5: Run focused regression coverage**

Run: `node test/test-media-viewer-window-contract.js`

Expected: PASS.

Run: `node test/test-media-viewer-remote-image-contract.js`

Expected: PASS.

Run: `npx playwright test test/code-block-copy.e2e.js --reporter=line`

Expected: PASS.

### Task 3: Review, repair, and record verification evidence

**Files:**
- Modify: `docs/spec/80.renderer-pipeline.srs.md` through SpecKiwi MCP only
- Modify: `docs/spec/00.index.md` through SpecKiwi MCP only when a completed-work entry is warranted
- Review: `src/renderer/viewer.js`, `src/renderer/viewer.css`, `test/test-media-viewer-contract.js`, `test/media-viewer.e2e.js`

**Interfaces:**
- Consumes: passing Task 2 checks and the `FR-RENDER-031` acceptance criteria.
- Produces: independent review findings, any TDD repair loop, verification evidence, checked acceptance criteria, and verified requirement status.

- [x] **Step 1: Dispatch an independent reviewer**

Ask the reviewer to check `FR-RENDER-031` AC-1 through AC-5, coordinate math for centered/narrow/nested media, hover/focus continuity, resize lifecycle, CSS overflow, existing zoom behavior, and test adequacy. Require findings ordered by severity with file/line references.

- [x] **Step 2: Repair every Critical or Important finding with TDD**

For each accepted finding, first add or modify the focused static/E2E test so it fails for the reported gap, run it to observe RED, make the smallest renderer/CSS change, and rerun the focused plus regression commands. Re-dispatch the reviewer until it returns no Critical or Important findings.

- [x] **Step 3: Record requirement evidence after clean review**

Use SpecKiwi to add evidence for static contracts, E2E geometry and regression tests, and the independent review report. Then check AC-1 through AC-5, move `FR-RENDER-031` to `verified`, add a RENDER completed-work entry, and run:

Run: `speckiwi validate --strict --fail-on-warning --json`

Expected: zero errors and zero warnings.

## Self-Review

- Spec coverage: Task 1 tests AC-1 through AC-4 before code changes; Task 2 implements those behaviors; Task 3 verifies AC-5 and records all evidence.
- Placeholder scan: the plan specifies concrete file paths, helpers, coordinate equations, test commands, and expected outcomes.
- Type consistency: `positionInlineMediaToolbar(entry, container)` is used consistently by initialization and shared resize observation.
- Scope: the plan does not alter dedicated media viewer code, IPC, locale files, or inline zoom semantics.
