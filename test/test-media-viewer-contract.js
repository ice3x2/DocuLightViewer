'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function mediaAssert(condition, message) {
  assert(condition, `FR-RENDER-028 media viewer contract: ${message}`);
}

function inlineMediaAssert(condition, message, requirementId = 'FR-RENDER-030') {
  assert(condition, `${requirementId} inline media contract: ${message}`);
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const remainder = source.slice(start + 1);
  const nextFunction = /\n\s*function\s+[A-Za-z_$][\w$]*\s*\(/.exec(remainder);
  return source.slice(start, nextFunction ? start + 1 + nextFunction.index : source.length);
}

const preload = read('src/main/preload.js');
const mainJs = read('src/main/index.js');
const viewerJs = read('src/renderer/viewer.js');
const viewerCss = read('src/renderer/viewer.css');

mediaAssert(exists('src/renderer/media-viewer.html'), 'dedicated media-viewer.html exists');
mediaAssert(exists('src/renderer/media-viewer.css'), 'dedicated media-viewer.css exists');
mediaAssert(exists('src/renderer/media-viewer.js'), 'dedicated media-viewer.js exists');

const mediaHtml = read('src/renderer/media-viewer.html');
const mediaCss = read('src/renderer/media-viewer.css');
const mediaJs = read('src/renderer/media-viewer.js');
const mediaToolbarCss = (mediaCss.match(/\.media-toolbar\s*\{[^}]+\}/) || [''])[0];

for (const apiName of ['openMediaViewer', 'onMediaViewerPayload', 'getMediaViewerPayload', 'downloadMediaAsset']) {
  mediaAssert(preload.includes(`${apiName}:`), `preload exposes ${apiName}`);
}

for (const channel of ['media-viewer:open', 'media-viewer:download', 'media-viewer:get-payload', 'media-viewer-payload']) {
  mediaAssert(preload.includes(channel), `preload references ${channel}`);
}

mediaAssert(viewerJs.includes('data-mermaid-source'), 'viewer preserves Mermaid source text after rendering');
mediaAssert(viewerJs.includes('data-original-src'), 'viewer preserves original image source separately from display src');
mediaAssert(viewerJs.includes('media-expand-button'), 'viewer creates inline media expand buttons');
mediaAssert(viewerJs.includes('window.doclight.openMediaViewer'), 'viewer opens dedicated media viewer through preload API');
mediaAssert(viewerCss.includes('.media-expand-button'), 'viewer CSS styles the inline media expand affordance');
mediaAssert(viewerCss.includes(':focus-within') || viewerCss.includes('focus-visible'), 'inline affordance is reachable by keyboard focus');
mediaAssert(viewerJs.includes('document.body.classList.contains(\'pdf-mode\')') || viewerJs.includes('document.body.classList.contains("pdf-mode")'), 'viewer does not add inline media expand affordances in PDF mode');
mediaAssert(viewerJs.indexOf('classList.toggle(\'pdf-mode\'') >= 0 && viewerJs.indexOf('classList.toggle(\'pdf-mode\'') < viewerJs.indexOf('renderMarkdown(data.markdown)'), 'PDF mode class is applied before markdown rendering creates media affordances');
mediaAssert(/body\.pdf-mode[\s\S]*\.media-expand-button[\s\S]*display:\s*none\s*!important/.test(viewerCss), 'PDF mode CSS suppresses inline media expand controls');

for (const [name, value] of [
  ['INLINE_MEDIA_ZOOM_STEP', '10'],
  ['INLINE_MEDIA_MANUAL_MIN', '25'],
  ['INLINE_MEDIA_MAX', '100'],
  ['INLINE_MEDIA_HEIGHT_RATIO', '0.9']
]) {
  inlineMediaAssert(
    new RegExp(`const\\s+${name}\\s*=\\s*${value.replace('.', '\\.')}\\s*;`).test(viewerJs),
    `viewer declares ${name} as ${value}`
  );
}

for (const token of [
  'setupInlineMediaController',
  'calculateInlineAutoFitPercent',
  'applyInlineMediaPercent',
  'ResizeObserver',
  'media-inline-toolbar',
  'media-inline-zoom-out',
  'media-inline-zoom-in'
]) {
  inlineMediaAssert(viewerJs.includes(token), `viewer contains ${token}`);
}

const calculateInlineAutoFitSource = functionSource(viewerJs, 'calculateInlineAutoFitPercent');
const applyInlineMediaSource = functionSource(viewerJs, 'applyInlineMediaPercent');
const initializeInlineMediaSource = functionSource(viewerJs, 'initializeInlineMediaEntry');
const disposeInlineMediaSource = functionSource(viewerJs, 'disposeInlineMediaController');
const setupInlineMediaSource = functionSource(viewerJs, 'setupInlineMediaController');
const setupMediaAffordancesSource = functionSource(viewerJs, 'setupMediaExpandAffordances');
const renderMarkdownSource = functionSource(viewerJs, 'renderMarkdown');
const positionInlineMediaToolbarSource = functionSource(viewerJs, 'positionInlineMediaToolbar');

inlineMediaAssert(
  calculateInlineAutoFitSource.includes('getInlineMediaAspectRatio') &&
    calculateInlineAutoFitSource.includes('INLINE_MEDIA_HEIGHT_RATIO') &&
    calculateInlineAutoFitSource.includes('INLINE_MEDIA_MAX') &&
    !calculateInlineAutoFitSource.includes('Math.max(INLINE_MEDIA_EPSILON'),
  'auto-fit calculation uses media aspect ratio and height ratio without a positive minimum clamp'
);
inlineMediaAssert(
  applyInlineMediaSource.includes("style.setProperty('--inline-media-width'") &&
    applyInlineMediaSource.includes('zoomOut.disabled') &&
    applyInlineMediaSource.includes('zoomIn.disabled') &&
    applyInlineMediaSource.includes('percent < INLINE_MEDIA_EPSILON'),
  'percentage application preserves sub-0.01 auto-fit values and updates native zoom bounds'
);
inlineMediaAssert(
  initializeInlineMediaSource.includes('calculateInlineAutoFitPercent') &&
    initializeInlineMediaSource.includes('applyInlineMediaPercent') &&
    initializeInlineMediaSource.includes('entry.wrapper.parentElement'),
  'entry initialization calculates auto-fit from its available block width before applying its percentage'
);
inlineMediaAssert(
  setupInlineMediaSource.includes('new ResizeObserver') &&
    setupInlineMediaSource.includes('new MutationObserver') &&
    setupInlineMediaSource.includes('initializeInlineMediaEntry') &&
    setupInlineMediaSource.includes('positionInlineMediaToolbar(entry, container)') &&
    setupInlineMediaSource.includes('.observe(container)') &&
    setupInlineMediaSource.includes('.observe(viewport)'),
  'inline controller recalculates unadjusted media and toolbar placement when content or viewport resizes',
  'FR-RENDER-031'
);
inlineMediaAssert(
  positionInlineMediaToolbarSource.includes("document.getElementById('content')") &&
    positionInlineMediaToolbarSource.includes('getBoundingClientRect') &&
    positionInlineMediaToolbarSource.includes('getComputedStyle(entry.wrapper).width') &&
    positionInlineMediaToolbarSource.includes('Number.parseFloat') &&
    positionInlineMediaToolbarSource.includes('wrapperRect.width / layoutWidth') &&
    positionInlineMediaToolbarSource.includes('style.setProperty') &&
    positionInlineMediaToolbarSource.includes("'--inline-media-toolbar-right'") &&
    positionInlineMediaToolbarSource.includes('wrapperRect.right - contentRect.right'),
  'FR-RENDER-031 computes the wrapper-to-content right-edge offset',
  'FR-RENDER-031'
);
inlineMediaAssert(
  setupMediaAffordancesSource.includes('setupInlineMediaController'),
  'media affordance setup connects entries to the inline controller'
);
inlineMediaAssert(
  disposeInlineMediaSource.includes('inlineMediaResizeObserver.disconnect()') &&
    disposeInlineMediaSource.includes('inlineMediaMutationObserver.disconnect()') &&
    disposeInlineMediaSource.includes('cancelAnimationFrame(inlineMediaResizeFrame)'),
  'inline controller disposal disconnects resize and mutation observation and pending animation work',
  'FR-RENDER-031'
);
inlineMediaAssert(
  setupMediaAffordancesSource.indexOf('disposeInlineMediaController()') >= 0 &&
    setupMediaAffordancesSource.indexOf('disposeInlineMediaController()') < setupMediaAffordancesSource.indexOf('empty-state') &&
    setupMediaAffordancesSource.indexOf('disposeInlineMediaController()') < setupMediaAffordancesSource.indexOf('pdf-mode'),
  'media setup disposes the previous controller before empty/PDF early returns'
);
inlineMediaAssert(
  /const\s+renderGeneration\s*=\s*\+\+markdownRenderGeneration\s*;/.test(renderMarkdownSource) &&
    (renderMarkdownSource.match(/renderGeneration\s*!==\s*markdownRenderGeneration/g) || []).length >= 2,
  'async markdown rendering uses a generation guard after image and Mermaid awaits'
);
inlineMediaAssert(
  /onEmptyWindow\([\s\S]{0,500}disposeInlineMediaController\(\)/.test(viewerJs),
  'empty-window replacement disposes inline media observation'
);

const inlineWrapperCss = (viewerCss.match(/\.media-expand-wrapper\s*\{[^}]*\}/) || [''])[0];
const inlineToolbarCss = (viewerCss.match(/\.media-inline-toolbar\s*\{[^}]*\}/) || [''])[0];
const inlineToolbarVisibleCss = (viewerCss.match(/\.media-expand-wrapper:hover[^}]*\{[^}]*\}/) || [''])[0];
const inlineDisabledCss = (viewerCss.match(/\.media-inline-tool-button:disabled\s*\{[^}]*\}/) || [''])[0];
const inlineDisabledOpacity = (inlineDisabledCss.match(/opacity:\s*([0-9.]+)/) || [])[1];
inlineMediaAssert(
  /width:\s*var\(--inline-media-width(?:,\s*100%)?\)/.test(inlineWrapperCss),
  'wrapper rule controls width with the inline percentage CSS property'
);
inlineMediaAssert(
  /cursor:\s*not-allowed/.test(inlineDisabledCss) &&
    /color:\s*var\(--muted-text\)/.test(inlineDisabledCss) &&
    Number(inlineDisabledOpacity) > 0 && Number(inlineDisabledOpacity) < 1,
  'disabled button rule uses muted text, reduced opacity, and a not-allowed cursor'
);
inlineMediaAssert(
  /pointer-events:\s*none/.test(inlineToolbarCss) &&
    /pointer-events:\s*auto/.test(inlineToolbarVisibleCss),
  'hidden toolbar does not intercept media clicks and becomes interactive on hover/focus'
);
inlineMediaAssert(
  /top:\s*0(?:px)?/.test(inlineToolbarCss) &&
    /right:\s*var\(--inline-media-toolbar-right(?:,\s*0px)?\)/.test(inlineToolbarCss) &&
    !/left:\s*6px/.test(inlineToolbarCss),
  'FR-RENDER-031 toolbar uses the media top and computed document-right offset',
  'FR-RENDER-031'
);
inlineMediaAssert(
  /\.media-expand-wrapper::after\s*\{[^}]*left:\s*100%[^}]*right:\s*var\(--inline-media-toolbar-right(?:,\s*0px)?\)[^}]*height:\s*28px/.test(viewerCss),
  'FR-RENDER-031 wrapper supplies a narrow hover bridge from media to an external toolbar',
  'FR-RENDER-031'
);

mediaAssert(mediaHtml.includes('Content-Security-Policy'), 'media viewer declares a CSP');
mediaAssert(!mediaHtml.includes('>Download<'), 'media viewer HTML does not seed English download text before i18n');
mediaAssert(!mediaHtml.includes('Loading media'), 'media viewer HTML does not seed English loading text before i18n');
mediaAssert(!mediaHtml.includes('Media viewer controls'), 'media viewer HTML does not seed English toolbar label before i18n');
mediaAssert(!/script-src[^"]*https?:/i.test(mediaHtml), 'media viewer CSP does not allow remote scripts');
mediaAssert(!/style-src[^"]*https?:/i.test(mediaHtml), 'media viewer CSP does not allow remote styles');
mediaAssert(/style-src[^"]*'unsafe-inline'/i.test(mediaHtml), 'media viewer CSP permits inline SVG styles needed by Mermaid rendering');
mediaAssert(!/font-src[^"]*https?:/i.test(mediaHtml), 'media viewer CSP does not allow remote fonts');
mediaAssert(!/img-src[^"]*file:/i.test(mediaHtml), 'media viewer CSP does not allow direct file images');
mediaAssert(mediaHtml.includes('data-i18n-aria-label="viewer.media.toolbarAriaLabel"'), 'media toolbar aria-label is localized');
mediaAssert(mediaHtml.includes('id="media-fit-window"'), 'media toolbar exposes a fit-to-window control');
mediaAssert((mediaHtml.match(/<svg/g) || []).length >= 4, 'media toolbar controls use icon markup instead of visible text labels');
mediaAssert(!mediaHtml.includes('>1:1</button>'), 'media toolbar reset control is not rendered as visible 1:1 text');
mediaAssert(mediaHtml.includes('./media-viewer.css'), 'media viewer loads local stylesheet');
mediaAssert(mediaHtml.includes('./media-viewer.js'), 'media viewer loads local script');
mediaAssert(mediaHtml.includes('./lib/mermaid.min.js'), 'media viewer can render Mermaid from the vendored local library');
mediaAssert(mediaJs.includes('document.documentElement.lang') && mediaJs.includes('result.locale'), 'media viewer applies the active locale to document language metadata');
mediaAssert(mediaJs.includes('mediaReadyPromise') && mediaJs.includes('await mediaReadyPromise'), 'media viewer waits for rendered media readiness before download');
mediaAssert(mediaJs.includes('await wrapLongMermaidLabels(svg)'), 'Mermaid render waits for label containment before download can use the displayed SVG');
mediaAssert(mediaJs.includes('function centerMediaInViewport') && mediaJs.match(/centerMediaInViewport\(\)/g).length >= 3, 'media viewer centers rendered media after initial render, reset, and fit');

for (const token of [
  'onMediaViewerPayload',
  'applyCursorZoom',
  'fitToWindow',
  'startDragPan',
  'renderMermaidMedia',
  'normalizeMermaidSvgViewport',
  'wrapLongMermaidLabels',
  'markMermaidNodeShape',
  'syncCurrentMermaidSvg',
  'downloadMediaAsset',
  'getMediaViewerPayload',
  'showMediaError',
  "img.addEventListener('error'",
  'result.error'
]) {
  mediaAssert(mediaJs.includes(token), `media viewer JS contains ${token}`);
}
mediaAssert(
  !mediaJs.includes('request.svg = currentMermaidSvg || content.querySelector'),
  'Mermaid download prefers the displayed containment-adjusted SVG over the pre-adjustment SVG'
);
mediaAssert(
  !/shape\.setAttribute\('(points|cx|cy|r|rx|ry|width|height)'/.test(mediaJs) &&
    !/existingShape\.setAttribute\('(points|cx|cy|r|rx|ry|width|height)'/.test(mediaJs),
  'media viewer does not mutate Mermaid node geometry after Mermaid computes layout'
);

mediaAssert(viewerJs.includes('showMediaError'), 'viewer surfaces media open failures to the user');
mediaAssert(viewerJs.includes('result.error'), 'viewer checks resolved openMediaViewer error payloads');
mediaAssert(
  /DOCULIGHT_MEDIA_VIEWER_ALLOW_PRIVATE_REMOTE[\s\S]*NODE_ENV[\s\S]*test[\s\S]*dev/.test(mainJs),
  'private remote image override is gated to test/dev execution'
);
mediaAssert(mainJs.includes('decodeDataUrl(displaySrc)'), 'image downloads can reuse the displayed data URL bytes');
mediaAssert(
  !mainJs.includes('const src = isRemoteHttpUrl(source) ? source : displaySrc || source;'),
  'remote image download does not re-fetch when a displayed data URL snapshot exists'
);

mediaAssert(mediaCss.includes('overflow: scroll'), 'media viewer viewport keeps visible horizontal and vertical scrollbars');
mediaAssert(mediaCss.includes('.media-toolbar'), 'media viewer CSS contains toolbar styles');
mediaAssert(/--media-bg:\s*#ffffff/i.test(mediaCss), 'media viewer outer background is white');
mediaAssert(/top:\s*12px/i.test(mediaToolbarCss) && /right:\s*24px/i.test(mediaToolbarCss), 'media viewer toolbar is floating at the upper-right corner with right margin');
mediaAssert(!/left:\s*0/i.test(mediaToolbarCss), 'media viewer toolbar is no longer anchored to the upper-left corner');
mediaAssert(/\.media-tool-button[\s\S]*width:\s*48px/i.test(mediaCss) && /\.media-tool-button[\s\S]*height:\s*44px/i.test(mediaCss), 'media viewer zoom/reset/fit buttons are large enough for direct use');
mediaAssert(/\.media-tool-button svg[\s\S]*width:\s*24px/i.test(mediaCss) && /\.media-tool-button svg[\s\S]*height:\s*24px/i.test(mediaCss), 'media viewer icon buttons have stable icon dimensions');
mediaAssert(mediaCss.includes('.media-context-menu'), 'media viewer CSS contains dedicated context menu styles');

const localeKeys = [
  'viewer.media.expand',
  'viewer.media.zoomIn',
  'viewer.media.zoomOut',
  'viewer.media.reset',
  'viewer.media.fitWindow',
  'viewer.media.download',
  'viewer.media.mermaidTitle',
  'viewer.media.imageTitle',
  'viewer.media.windowTitle',
  'viewer.media.toolbarAriaLabel',
  'viewer.media.error',
  'viewer.media.loading'
];

for (const locale of ['en', 'ko', 'ja', 'es']) {
  const data = JSON.parse(read(`src/locales/${locale}.json`));
  for (const key of localeKeys) {
    mediaAssert(Object.prototype.hasOwnProperty.call(data, key), `${locale} locale contains ${key}`);
  }
}

async function assertMediaPayloadRaceIsRenderedOnce() {
  let payloadCallback = null;
  let resolveStoredPayload;
  let storedPayloadRequested;
  const storedPayloadRequestedPromise = new Promise((resolve) => {
    storedPayloadRequested = resolve;
  });
  const storedPayloadPromise = new Promise((resolve) => {
    resolveStoredPayload = resolve;
  });

  class FakeClassList {
    add() {}
    remove() {}
    toggle() {}
  }

  class FakeElement {
    constructor(tagName, id = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.style = {};
      this.children = [];
      this.textContent = '';
      this.classList = new FakeClassList();
      this.replaceChildrenCallCount = 0;
    }

    setAttribute(name, value) {
      this[name] = String(value);
    }

    getAttribute(name) {
      return this[name] || null;
    }

    addEventListener() {}

    closest() {
      return null;
    }

    querySelector() {
      return null;
    }

    querySelectorAll() {
      return [];
    }

    replaceChildren(...children) {
      this.replaceChildrenCallCount += 1;
      this.children = children;
      this.firstElementChild = children[0] || null;
    }

    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600 };
    }
  }

  const elements = new Map();
  for (const id of [
    'media-viewport',
    'media-surface',
    'media-content',
    'media-status',
    'media-context-menu',
    'media-zoom-in',
    'media-zoom-out',
    'media-reset',
    'media-fit-window',
    'media-download'
  ]) {
    elements.set(id, new FakeElement(id === 'media-content' ? 'section' : 'div', id));
  }
  const domListeners = new Map();
  const fakeDocument = {
    title: '',
    documentElement: {
      lang: 'en',
      setAttribute(name, value) {
        this[name] = String(value);
      }
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    createElementNS(_namespace, tagName) {
      return new FakeElement(tagName);
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(eventName, callback) {
      domListeners.set(eventName, callback);
    }
  };

  const fakeWindow = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener() {},
    doclight: {
      getStrings: async () => ({
        locale: 'ko',
        strings: {
          'viewer.media.loading': 'loading',
          'viewer.media.error': 'error {message}',
          'viewer.media.imageTitle': 'image',
          'viewer.media.windowTitle': 'media'
        }
      }),
      onMediaViewerPayload(callback) {
        payloadCallback = callback;
      },
      getMediaViewerPayload() {
        storedPayloadRequested();
        return storedPayloadPromise;
      },
      downloadMediaAsset: async () => ({ success: true })
    }
  };
  const context = {
    window: fakeWindow,
    document: fakeDocument,
    console,
    requestAnimationFrame: (callback) => callback()
  };

  vm.runInNewContext(mediaJs, context, { filename: 'src/renderer/media-viewer.js' });
  const startupPromise = domListeners.get('DOMContentLoaded')();
  await storedPayloadRequestedPromise;

  const payload = {
    type: 'image',
    title: 'Generated image',
    source: 'data:image/png;base64,AAAA',
    displaySrc: 'data:image/png;base64,AAAA',
    mime: 'image/png',
    fileName: 'generated.png'
  };
  payloadCallback(payload);
  resolveStoredPayload({ ...payload });
  await startupPromise;

  mediaAssert(
    elements.get('media-content').replaceChildrenCallCount === 2,
    'same media payload received from event and fallback is rendered once'
  );
  mediaAssert(fakeDocument.documentElement.lang === 'ko', 'active locale is applied to media viewer documentElement.lang');
}

assertMediaPayloadRaceIsRenderedOnce()
  .then(() => {
    console.log('PASS: FR-RENDER-028 media viewer static contract');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
