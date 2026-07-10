(function () {
  'use strict';

  const MIN_SCALE = 0.1;
  const MAX_SCALE = 8;
  const SCALE_STEP = 1.2;

  let strings = {};
  let currentPayload = null;
  let currentScale = 1;
  let baseWidth = 800;
  let baseHeight = 600;
  let currentMermaidSvg = '';
  let dragState = null;
  let stringsReady = false;
  let pendingPayload = null;
  let renderingPayloadToken = '';
  let renderedPayloadToken = '';
  let mediaReadyPromise = Promise.resolve();

  const viewport = document.getElementById('media-viewport');
  const surface = document.getElementById('media-surface');
  const content = document.getElementById('media-content');
  const status = document.getElementById('media-status');
  const contextMenu = document.getElementById('media-context-menu');

  function t(key, vars) {
    let value = strings[key];
    if (value === undefined) return key;
    if (vars) {
      for (const [name, replacement] of Object.entries(vars)) {
        value = value.replace(new RegExp(`\\{${name}\\}`, 'g'), String(replacement));
      }
    }
    return value;
  }

  async function loadStrings() {
    try {
      const result = await window.doclight.getStrings();
      strings = result && result.strings ? result.strings : {};
      if (result && result.locale && document.documentElement) {
        document.documentElement.lang = String(result.locale);
      }
    } catch {
      strings = {};
    }
    stringsReady = true;
    applyI18n();
    if (!currentPayload) {
      document.title = t('viewer.media.windowTitle');
    }
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      const key = element.getAttribute('data-i18n');
      const value = t(key);
      if (value !== key) element.textContent = value;
    });
    document.querySelectorAll('[data-i18n-title]').forEach((element) => {
      const key = element.getAttribute('data-i18n-title');
      const value = t(key);
      if (value !== key) element.setAttribute('title', value);
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
      const key = element.getAttribute('data-i18n-aria-label');
      const value = t(key);
      if (value !== key) element.setAttribute('aria-label', value);
    });
  }

  function setStatus(message, hidden) {
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('hidden', hidden === true);
  }

  function showMediaError(error) {
    const message = error && error.message ? error.message : (error && error.code ? error.code : String(error || 'media_error'));
    setStatus(t('viewer.media.error', { message }), false);
  }

  function createPayloadToken(payload) {
    if (!payload || typeof payload !== 'object') return '';
    return JSON.stringify({
      type: payload.type || '',
      title: payload.title || '',
      alt: payload.alt || '',
      source: payload.source || '',
      displaySrc: payload.displaySrc || '',
      mermaidSource: payload.mermaidSource || '',
      svg: payload.svg || '',
      mime: payload.mime || '',
      fileName: payload.fileName || ''
    });
  }

  function clampScale(value) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  }

  function updateSurfaceSize() {
    if (!surface || !content) return;
    const viewportWidth = viewport?.clientWidth || window.innerWidth;
    const viewportHeight = viewport?.clientHeight || window.innerHeight;
    const scaledWidth = baseWidth * currentScale;
    const scaledHeight = baseHeight * currentScale;
    const surfaceWidth = Math.max(viewportWidth, scaledWidth + 128);
    const surfaceHeight = Math.max(viewportHeight, scaledHeight + 128);
    const contentLeft = Math.max(64, (surfaceWidth - scaledWidth) / 2);
    const contentTop = Math.max(64, (surfaceHeight - scaledHeight) / 2);

    content.style.transform = `scale(${currentScale})`;
    content.style.left = `${contentLeft}px`;
    content.style.top = `${contentTop}px`;
    surface.style.width = `${surfaceWidth}px`;
    surface.style.height = `${surfaceHeight}px`;
  }

  function getContentOffset() {
    return {
      left: Number.parseFloat(content?.style.left || '') || 64,
      top: Number.parseFloat(content?.style.top || '') || 64
    };
  }

  function centerMediaInViewport() {
    if (!viewport || !content) return;
    const offset = getContentOffset();
    viewport.scrollLeft = Math.max(0, offset.left + (baseWidth * currentScale / 2) - (viewport.clientWidth / 2));
    viewport.scrollTop = Math.max(0, offset.top + (baseHeight * currentScale / 2) - (viewport.clientHeight / 2));
  }

  function measureContent() {
    if (!content) return;
    const element = content.firstElementChild;
    if (!element) return;

    if (element.tagName === 'svg') {
      const svg = element;
      const viewBox = svg.getAttribute('viewBox');
      if (viewBox) {
        const parts = viewBox.split(/\s+/).map(Number);
        if (parts.length === 4 && parts.every(Number.isFinite)) {
          baseWidth = Math.max(1, parts[2]);
          baseHeight = Math.max(1, parts[3]);
          updateSurfaceSize();
          return;
        }
      }
    }

    const rect = element.getBoundingClientRect();
    baseWidth = Math.max(1, rect.width / currentScale);
    baseHeight = Math.max(1, rect.height / currentScale);
    updateSurfaceSize();
  }

  function applyCursorZoom(nextScale, clientX, clientY) {
    if (!viewport) return;
    const scale = clampScale(nextScale);
    const rect = viewport.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    const beforeOffset = getContentOffset();
    const contentX = (viewport.scrollLeft + offsetX - beforeOffset.left) / currentScale;
    const contentY = (viewport.scrollTop + offsetY - beforeOffset.top) / currentScale;

    currentScale = scale;
    updateSurfaceSize();

    const afterOffset = getContentOffset();
    viewport.scrollLeft = Math.max(0, afterOffset.left + (contentX * currentScale) - offsetX);
    viewport.scrollTop = Math.max(0, afterOffset.top + (contentY * currentScale) - offsetY);
  }

  function zoomBy(factor) {
    const rect = viewport.getBoundingClientRect();
    applyCursorZoom(currentScale * factor, rect.left + (rect.width / 2), rect.top + (rect.height / 2));
  }

  function resetZoom() {
    currentScale = 1;
    updateSurfaceSize();
    centerMediaInViewport();
  }

  function fitToWindow() {
    if (!viewport) return;
    const availableWidth = Math.max(1, viewport.clientWidth - 128);
    const availableHeight = Math.max(1, viewport.clientHeight - 128);
    const fitScale = Math.min(availableWidth / baseWidth, availableHeight / baseHeight);
    currentScale = Number.isFinite(fitScale) && fitScale > 0
      ? Math.min(MAX_SCALE, fitScale)
      : MIN_SCALE;
    updateSurfaceSize();
    centerMediaInViewport();
  }

  function startDragPan(event) {
    if (!viewport || event.button !== 0 || event.target.closest('.media-toolbar') || event.target.closest('.media-context-menu')) {
      return;
    }
    dragState = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop
    };
    viewport.classList.add('dragging');
    event.preventDefault();
  }

  function onDragMove(event) {
    if (!dragState || !viewport) return;
    viewport.scrollLeft = dragState.scrollLeft - (event.clientX - dragState.x);
    viewport.scrollTop = dragState.scrollTop - (event.clientY - dragState.y);
  }

  function stopDragPan() {
    dragState = null;
    viewport?.classList.remove('dragging');
  }

  function markMermaidNodeShape(node) {
    const shape = node.querySelector('polygon, rect, ellipse, circle, path');
    if (shape) shape.setAttribute('data-doculight-media-shape', 'true');
  }

  function syncCurrentMermaidSvg(svg = content?.querySelector('svg')) {
    if (svg) currentMermaidSvg = svg.outerHTML;
    return currentMermaidSvg;
  }

  function normalizeMermaidSvgViewport(svg) {
    if (!svg) return;
    const viewBox = svg.getAttribute('viewBox');
    if (!viewBox) return;
    const parts = viewBox.split(/\s+/).map(Number);
    if (parts.length !== 4 || !parts.every(Number.isFinite)) return;
    svg.setAttribute('width', String(Math.max(1, parts[2])));
    svg.setAttribute('height', String(Math.max(1, parts[3])));
  }

  async function wrapLongMermaidLabels(svg) {
    if (!svg) return;
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
    svg.querySelectorAll('g.node').forEach((node) => {
      markMermaidNodeShape(node);
    });
    syncCurrentMermaidSvg(svg);
    measureContent();
  }

  async function renderMermaidMedia(payload) {
    if (typeof mermaid === 'undefined') {
      throw new Error('Mermaid renderer is unavailable.');
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
      flowchart: {
        htmlLabels: false,
        wrappingWidth: 220
      }
    });
    const source = String(payload.mermaidSource || '');
    const id = `media-mermaid-${Date.now()}`;
    const result = await mermaid.render(id, source);
    currentMermaidSvg = result.svg;
    content.innerHTML = result.svg;
    const svg = content.querySelector('svg');
    if (svg) {
      svg.removeAttribute('style');
      normalizeMermaidSvgViewport(svg);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', payload.title || t('viewer.media.mermaidTitle'));
      syncCurrentMermaidSvg(svg);
      await wrapLongMermaidLabels(svg);
    }
  }

  function renderImageMedia(payload) {
    const img = document.createElement('img');
    img.alt = payload.alt || payload.title || t('viewer.media.imageTitle');
    img.src = payload.displaySrc || payload.source || '';
    img.addEventListener('load', () => {
      baseWidth = Math.max(1, img.naturalWidth || img.width || 800);
      baseHeight = Math.max(1, img.naturalHeight || img.height || 600);
      updateSurfaceSize();
      centerMediaInViewport();
      setStatus('', true);
    }, { once: true });
    img.addEventListener('error', () => {
      showMediaError({ code: 'image_load_failed', message: 'image_load_failed' });
    }, { once: true });
    content.replaceChildren(img);
  }

  async function renderPayload(payload) {
    const payloadToken = createPayloadToken(payload);
    if (payloadToken && (payloadToken === renderingPayloadToken || payloadToken === renderedPayloadToken)) {
      return;
    }
    if (!stringsReady) {
      pendingPayload = payload;
      return;
    }
    renderingPayloadToken = payloadToken;
    let renderedSuccessfully = false;
    const renderTask = (async () => {
      currentPayload = payload || {};
      currentScale = 1;
      currentMermaidSvg = '';
      content.replaceChildren();
      setStatus(t('viewer.media.loading'), false);
      hideContextMenu();

      try {
        if (currentPayload.type === 'mermaid') {
          document.title = currentPayload.title || t('viewer.media.mermaidTitle');
          await renderMermaidMedia(currentPayload);
          measureContent();
          centerMediaInViewport();
          setStatus('', true);
        } else if (currentPayload.type === 'image') {
          document.title = currentPayload.title || t('viewer.media.imageTitle');
          renderImageMedia(currentPayload);
        } else {
          throw new Error('Unsupported media type.');
        }
        renderedSuccessfully = true;
      } catch (err) {
        showMediaError(err);
      } finally {
        if (renderedSuccessfully && payloadToken) renderedPayloadToken = payloadToken;
        renderingPayloadToken = '';
      }
    })();
    mediaReadyPromise = renderTask.catch(() => {});
    await renderTask;
  }

  async function renderPendingOrStoredPayload() {
    if (pendingPayload) {
      const payload = pendingPayload;
      pendingPayload = null;
      await renderPayload(payload);
      return;
    }
    const result = await window.doclight.getMediaViewerPayload();
    if (result && result.error) {
      showMediaError(result.error);
      return;
    }
    if (result) await renderPayload(result);
  }

  async function downloadMediaAsset() {
    if (!currentPayload) return;
    await mediaReadyPromise;
    const request = {
      type: currentPayload.type,
      title: currentPayload.title,
      source: currentPayload.source,
      displaySrc: currentPayload.displaySrc,
      mime: currentPayload.mime,
      fileName: currentPayload.fileName
    };
    if (currentPayload.type === 'mermaid') {
      request.svg = syncCurrentMermaidSvg() || '';
    }
    window.doclight.downloadMediaAsset(request).then((result) => {
      if (result && result.error) showMediaError(result.error);
    }).catch(showMediaError);
  }

  function hideContextMenu() {
    contextMenu?.classList.add('hidden');
  }

  function showContextMenu(event) {
    if (!contextMenu) return;
    event.preventDefault();
    contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 150)}px`;
    contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 40)}px`;
    contextMenu.classList.remove('hidden');
  }

  function bindEvents() {
    document.getElementById('media-zoom-in')?.addEventListener('click', () => zoomBy(SCALE_STEP));
    document.getElementById('media-zoom-out')?.addEventListener('click', () => zoomBy(1 / SCALE_STEP));
    document.getElementById('media-reset')?.addEventListener('click', resetZoom);
    document.getElementById('media-fit-window')?.addEventListener('click', fitToWindow);
    document.getElementById('media-download')?.addEventListener('click', () => {
      hideContextMenu();
      downloadMediaAsset();
    });

    viewport?.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP;
      applyCursorZoom(currentScale * factor, event.clientX, event.clientY);
    }, { passive: false });
    viewport?.addEventListener('mousedown', startDragPan);
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', stopDragPan);
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('contextmenu', showContextMenu);
    window.addEventListener('resize', updateSurfaceSize);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    window.doclight.onMediaViewerPayload(renderPayload);
    await loadStrings();
    await renderPendingOrStoredPayload();
  });
})();
