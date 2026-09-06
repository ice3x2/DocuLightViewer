// src/renderer/viewer.js — DocuLight Viewer Renderer Logic

(function() {
  'use strict';

  // === i18n ===
  let _strings = {};

  function t(key, vars) {
    let str = _strings[key];
    if (str === undefined) return key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return str;
  }

  async function initI18n() {
    try {
      const { strings } = await window.doclight.getStrings();
      _strings = strings;
    } catch {
      _strings = {};
    }
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const translated = t(key);
      if (translated !== key) {
        el.textContent = translated;
      }
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const translated = t(key);
      if (translated !== key) {
        el.setAttribute('title', translated);
      }
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria-label');
      const translated = t(key);
      if (translated !== key) {
        el.setAttribute('aria-label', translated);
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const translated = t(key);
      if (translated !== key) {
        el.setAttribute('placeholder', translated);
      }
    });
  }

  // === State ===
  const cleanups = [];
  let currentFilePath = null;
  let sidebarVisible = false;
  let tocVisible = false;
  let isPinned = false;
  let savedPrefs = null;
  let userToggledPin = false;
  let savedFilePath = null;
  let originalContent = null;
  let isMcpDocument = false;
  let mcpAutoSaveEnabled = false;
  let currentProject = '';
  let saveAsFilePath = null;
  let navigationTrail = [];

  // Find-in-page state
  let findBarVisible = false;
  let findMatches = [];
  let findCurrentIndex = -1;
  let findQuery = '';
  let findDebounceTimer = null;

  // === Code Theme CSS Mapping ===
  const CODE_THEME_CSS = {
    github: { light: './lib/highlight-github.min.css', dark: './lib/highlight-github-dark.min.css' },
    monokai: './lib/highlight-monokai.min.css',
    dracula: './lib/highlight-dracula.min.css'
  };

  let currentCodeTheme = 'github';
  let currentAppTheme = 'light';

  function applyCodeTheme(codeTheme, appTheme) {
    const link = document.getElementById('highlight-theme');
    if (!link) return;

    let href;
    const entry = CODE_THEME_CSS[codeTheme];
    if (typeof entry === 'object') {
      href = entry[appTheme] || entry.light;
    } else {
      href = entry;
    }

    if (href && link.getAttribute('href') !== href) {
      link.setAttribute('href', href);
    }

    currentCodeTheme = codeTheme || currentCodeTheme;
    currentAppTheme = appTheme || currentAppTheme;
  }

  // === IndexedDB Preferences ===
  const PREFS_DB_NAME = 'doculight';
  const PREFS_STORE_NAME = 'ui-prefs';
  const PREFS_KEY = 'panel-state';

  function openPrefsDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(PREFS_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PREFS_STORE_NAME)) {
          db.createObjectStore(PREFS_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function loadPanelPrefs() {
    return openPrefsDB().then(db => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PREFS_STORE_NAME, 'readonly');
        const store = tx.objectStore(PREFS_STORE_NAME);
        const req = store.get(PREFS_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    }).catch(() => null);
  }

  function savePanelPrefs(prefs) {
    return openPrefsDB().then(db => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PREFS_STORE_NAME, 'readwrite');
        const store = tx.objectStore(PREFS_STORE_NAME);
        const req = store.put(prefs, PREFS_KEY);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }).catch(() => {});
  }

  function getCurrentPanelPrefs() {
    const sidebar = document.getElementById('sidebar-container');
    const toc = document.getElementById('toc-container');
    return {
      sidebarVisible,
      tocVisible,
      alwaysOnTop: isPinned,
      sidebarWidth: sidebar ? sidebar.offsetWidth : undefined,
      tocWidth: toc ? toc.offsetWidth : undefined
    };
  }

  // === Initialize Mermaid ===
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default'
    });
  }

  // === Search Scroll Helper ===
  /**
   * Find the first occurrence of query text in the rendered content,
   * scroll to it, and temporarily highlight the match with a yellow background.
   * @param {string} query - The search text to find
   */
  function scrollToTextMatch(query, occurrenceIndex) {
    const contentEl = document.getElementById('content');
    const viewerContainerEl = document.getElementById('viewer-container');
    if (!contentEl || !viewerContainerEl || !query) return;

    // Remove any previous search highlights
    contentEl.querySelectorAll('.search-highlight-temp').forEach(el => {
      const parent = el.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
      }
    });

    occurrenceIndex = occurrenceIndex || 0;
    let matchCount = 0;
    const lowerQuery = query.toLowerCase();
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null);

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      if (!text) continue;
      const matchIdx = text.toLowerCase().indexOf(lowerQuery);
      if (matchIdx < 0) continue;

      if (matchCount < occurrenceIndex) {
        matchCount++;
        continue;
      }

      // Split the text node and wrap the matched portion in a highlight <mark>
      const before = text.substring(0, matchIdx);
      const match = text.substring(matchIdx, matchIdx + query.length);
      const after = text.substring(matchIdx + query.length);
      const parent = node.parentNode;
      if (!parent) return;

      const highlightEl = document.createElement('mark');
      highlightEl.className = 'search-highlight-temp';
      highlightEl.textContent = match;

      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(highlightEl);
      if (after) frag.appendChild(document.createTextNode(after));
      parent.replaceChild(frag, node);

      // Scroll to the highlight element
      requestAnimationFrame(() => {
        const containerRect = viewerContainerEl.getBoundingClientRect();
        const targetRect = highlightEl.getBoundingClientRect();
        const targetMiddle = targetRect.top - containerRect.top + viewerContainerEl.scrollTop;
        const centeredScroll = targetMiddle - (containerRect.height / 2);
        viewerContainerEl.scrollTo({
          top: Math.max(0, centeredScroll),
          behavior: 'smooth'
        });
      });

      // Fade out after 5 seconds
      setTimeout(() => {
        highlightEl.classList.add('search-highlight-fade');
        // Remove the element after the fade animation completes
        highlightEl.addEventListener('transitionend', () => {
          const p = highlightEl.parentNode;
          if (p) {
            p.replaceChild(document.createTextNode(highlightEl.textContent), highlightEl);
            p.normalize();
          }
        }, { once: true });
      }, 5000);

      return;
    }
  }

  // === Local Image Resolution ===
  // After DOMPurify inserts HTML, any <img> whose src is a file:// URL or a
  // relative path won't load in a sandboxed Electron renderer.  We ask the
  // main process to read each such file and hand back a data URI instead.
  async function resolveLocalImages(container) {
    const imgs = Array.from(container.querySelectorAll('img[src]'));
    if (imgs.length === 0) return;

    const state = window.DocuLight && window.DocuLight.state;
    const imageBasePath = state ? (state.imageBasePath || '') : '';

    await Promise.all(imgs.map(async (img) => {
      const src = img.getAttribute('src') || '';
      if (src && !img.getAttribute('data-original-src')) {
        img.setAttribute('data-original-src', src);
      }

      // Skip data URIs and web URLs — they load fine without help
      if (!src ||
          src.startsWith('data:') ||
          src.startsWith('http://') ||
          src.startsWith('https://')) return;

      let filePath;

      if (src.startsWith('file:///')) {
        // Strip scheme to get the raw filesystem path
        let p = src.slice(8); // remove 'file:///'
        try { p = decodeURIComponent(p); } catch (e) { /* keep as-is */ }
        filePath = p;
      } else if (!src.startsWith('/') && imageBasePath) {
        // Relative path (e.g. ./img.png or ../img.png) — join with basePath
        // Main process path.normalize() will resolve any .. segments.
        const clean = src.replace(/^\.\//, '');
        filePath = imageBasePath + '/' + clean;
      }

      if (!filePath) return;

      try {
        const result = await window.doclight.readImageAsDataUrl(filePath);
        if (result && result.dataUrl) {
          img.setAttribute('src', result.dataUrl);
          img.setAttribute('data-resolved-source', filePath);
        }
      } catch (e) { /* silently ignore unreadable images */ }
    }));
  }

  // === Frontmatter Parser (Step 20) ===

  /**
   * Extract YAML frontmatter from markdown content.
   * Returns { meta: object|null, body: string }.
   */
  function parseFrontmatter(markdown) {
    const fmRegex = /^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/;
    const match = markdown.match(fmRegex);
    if (!match) {
      return { meta: null, body: markdown };
    }

    const yamlContent = match[1] || '';
    const meta = {};

    for (const line of yamlContent.split(/\r?\n/)) {
      const m = line.match(/^(\w+)\s*:\s*(.*)$/);
      if (m) {
        const key = m[1];
        let value = m[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        meta[key] = value;
      }
    }

    const body = markdown.slice(match[0].length);
    return { meta, body };
  }

  // Document type icon mapping (Step 23)
  const DOC_TYPE_ICONS = {
    note:       '📝',
    plan:       '📋',
    report:     '📊',
    completion: '✅',
    issue:      '🐛',
    review:     '🔍',
    log:        '📜',
    reference:  '📖',
    guide:      '📘',
    spec:       '📐',
  };

  /**
   * Render the frontmatter metabox UI.
   */
  function renderMetabox(meta) {
    const metabox = document.getElementById('frontmatter-metabox');
    if (!metabox) return;

    if (!meta || Object.keys(meta).length === 0) {
      metabox.classList.add('hidden');
      return;
    }

    metabox.classList.remove('hidden');

    const contentEl = metabox.querySelector('.metabox-content');
    if (!contentEl) return;

    const fieldLabels = {
      project: t('viewer.metaProject'),
      projectPath: t('viewer.metaProjectPath'),
      gitRemote: t('viewer.metaGitRemote'),
      gitBranch: t('viewer.metaGitBranch'),
      gitLastCommit: t('viewer.metaGitLastCommit'),
      docName: t('viewer.metaDocName'),
      docType: t('viewer.metaDocType'),
      description: t('viewer.metaDescription'),
      date: t('viewer.metaDate')
    };

    let html = '<table class="metabox-table">';
    for (const [key, value] of Object.entries(meta)) {
      const label = fieldLabels[key] || key;
      let displayValue;
      if (key === 'docType' && DOC_TYPE_ICONS[value]) {
        const icon = DOC_TYPE_ICONS[value];
        const typeLabel = t('docType.' + value) || value;
        displayValue = escapeHtml(icon + ' ' + typeLabel);
      } else {
        displayValue = escapeHtml(String(value));
      }
      html += `<tr><td class="metabox-key">${escapeHtml(label)}</td><td class="metabox-value">${displayValue}</td></tr>`;
    }
    html += '</table>';

    contentEl.innerHTML = html;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // === Rendering Pipeline ===
  let markdownRenderGeneration = 0;

  async function renderMarkdown(markdown) {
    const contentEl = document.getElementById('content');
    if (!contentEl) return;
    const renderGeneration = ++markdownRenderGeneration;
    disposeInlineMediaController();

    // Step 0: Extract frontmatter (before markdown parsing)
    const { meta, body } = parseFrontmatter(markdown);
    renderMetabox(meta);

    // Use body (without frontmatter) for rendering
    const renderTarget = body;

    // Performance warning for large documents
    const size = new Blob([renderTarget]).size;
    if (size > 5 * 1024 * 1024) {
      showPerformanceWarning(size);
    }

    // Step 1: Parse markdown to HTML
    const rawHtml = marked.parse(renderTarget);

    // Step 2: Sanitize with DOMPurify
    // ALLOWED_URI_REGEXP is extended to permit file:// URLs so that local images
    // resolved by image-resolver.js are not stripped by DOMPurify's default policy.
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      ADD_TAGS: ['details', 'summary'],
      ADD_ATTR: ['open'],
      ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
    });

    // Step 3: Insert into DOM
    contentEl.innerHTML = cleanHtml;

    // Step 3a: Generate slug-based IDs for headings (marked v17+ does not generate them)
    contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
      if (!heading.id) {
        const slug = heading.textContent
          .trim()
          .toLowerCase()
          .replace(/[^\w\s\u3131-\uD79D\u3000-\u9FFF-]/g, '')
          .replace(/\s+/g, '-');
        if (slug) heading.id = slug;
      }
    });

    // Step 3b: Convert local file:// image URLs to data URIs.
    // Electron's sandbox prevents the renderer from loading file:// resources
    // that reside outside the app directory (Chromium same-origin policy).
    // We resolve each image via IPC so the main process reads and returns
    // the binary as a base64 data URL, which Chromium accepts unconditionally.
    await resolveLocalImages(contentEl);
    if (renderGeneration !== markdownRenderGeneration) return;

    // Step 4: Render Mermaid diagrams
    await renderMermaidDiagrams(contentEl);
    if (renderGeneration !== markdownRenderGeneration) return;

    // Step 5: Highlight code blocks
    if (typeof hljs !== 'undefined') {
      contentEl.querySelectorAll('pre code').forEach(block => {
        hljs.highlightElement(block);
      });
    }

    attachCodeBlockCopyAffordances(contentEl);
    setupMediaExpandAffordances(contentEl);

    // Step 6: Build TOC from headings
    buildToc();
  }

  // === Mermaid Rendering ===
  async function renderMermaidDiagrams(container) {
    if (typeof mermaid === 'undefined') return;

    const mermaidBlocks = container.querySelectorAll('code.language-mermaid');
    let idx = 0;

    for (const block of mermaidBlocks) {
      const pre = block.parentElement;
      if (!pre || pre.tagName !== 'PRE') continue;

      try {
        const id = `mermaid-${Date.now()}-${idx++}`;
        const source = block.textContent.trim();
        const { svg } = await mermaid.render(id, source);
        const div = document.createElement('div');
        div.className = 'mermaid';
        div.setAttribute('data-mermaid-source', source);
        div.innerHTML = svg;
        pre.replaceWith(div);
      } catch (err) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'mermaid-error';
        errorDiv.textContent = t('viewer.mermaidError', { message: err.message });
        pre.replaceWith(errorDiv);
      }
    }
  }

  // === Performance Warning ===
  function showPerformanceWarning(size) {
    const warningEl = document.getElementById('performance-warning');
    const textEl = document.getElementById('warning-text');
    if (!warningEl || !textEl) return;

    const sizeMB = (size / (1024 * 1024)).toFixed(1);
    textEl.textContent = t('viewer.largeDocWarning', { sizeMB });
    warningEl.style.display = 'block';

    setTimeout(() => {
      warningEl.style.display = 'none';
    }, 3000);
  }

  function normalizeBreadcrumbTrail(trail) {
    if (!Array.isArray(trail)) return [];
    const normalized = trail
      .filter(item => item && typeof item.index === 'number')
      .map(item => ({
        index: item.index,
        filePath: item.filePath || '',
        label: item.label || item.filePath || t('viewer.untitled'),
        current: item.current === true
      }));
    if (normalized.length && !normalized.some(item => item.current)) {
      normalized[normalized.length - 1].current = true;
    }
    return normalized;
  }

  function navigateBreadcrumbToIndex(index) {
    const tabMod = window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.tabManager;
    if (tabMod && tabMod.isEnabled && tabMod.isEnabled() && tabMod.navigateBreadcrumbToIndex) {
      tabMod.navigateBreadcrumbToIndex(index);
      return;
    }
    if (window.doclight && window.doclight.navigateToHistoryIndex) {
      window.doclight.navigateToHistoryIndex(index);
    }
  }

  const INLINE_MEDIA_ZOOM_STEP = 10;
  const INLINE_MEDIA_MANUAL_MIN = 25;
  const INLINE_MEDIA_MAX = 100;
  const INLINE_MEDIA_HEIGHT_RATIO = 0.9;
  const INLINE_MEDIA_EPSILON = 0.01;
  let inlineMediaResizeObserver = null;
  let inlineMediaMutationObserver = null;
  let inlineMediaResizeFrame = null;

  function createMediaExpandButton(payloadFactory) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'media-expand-button media-inline-tool-button';
    button.setAttribute('title', t('viewer.media.expand'));
    button.setAttribute('aria-label', t('viewer.media.expand'));
    button.textContent = '⛶';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const payload = payloadFactory();
      window.doclight.openMediaViewer(payload).then((result) => {
        if (result && result.error) showMediaError(result.error);
      }).catch(showMediaError);
    });
    return button;
  }

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

  function getInlineMediaAspectRatio(media) {
    if (media && media.tagName === 'IMG' && media.naturalWidth > 0 && media.naturalHeight > 0) {
      return media.naturalWidth / media.naturalHeight;
    }

    const svg = media && media.matches && media.matches('.mermaid') ? media.querySelector('svg') : null;
    const viewBox = svg && svg.viewBox && svg.viewBox.baseVal;
    if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
      return viewBox.width / viewBox.height;
    }

    if (svg) {
      const width = Number.parseFloat(svg.getAttribute('width'));
      const height = Number.parseFloat(svg.getAttribute('height'));
      if (width > 0 && height > 0) return width / height;
    }
    return 0;
  }

  function calculateInlineAutoFitPercent(media, contentWidth, viewportHeight) {
    const aspectRatio = getInlineMediaAspectRatio(media);
    if (!(aspectRatio > 0) || !(contentWidth > 0) || !(viewportHeight > 0)) {
      return INLINE_MEDIA_MAX;
    }
    const rawPercent = viewportHeight * INLINE_MEDIA_HEIGHT_RATIO * aspectRatio / contentWidth * 100;
    const fittedPercent = rawPercent < INLINE_MEDIA_EPSILON
      ? rawPercent
      : Math.floor(rawPercent * 100) / 100;
    return Math.min(INLINE_MEDIA_MAX, fittedPercent);
  }

  function applyInlineMediaPercent(entry, percent) {
    const normalizedPercent = percent < INLINE_MEDIA_EPSILON
      ? percent
      : Math.round(percent * 100) / 100;
    const boundedPercent = Math.max(
      entry.minPercent,
      Math.min(INLINE_MEDIA_MAX, normalizedPercent)
    );
    entry.currentPercent = boundedPercent;
    const widthValue = `${boundedPercent}%`;
    if (entry.wrapper.style.getPropertyValue('--inline-media-width') !== widthValue) {
      entry.wrapper.style.setProperty('--inline-media-width', widthValue);
    }
    entry.zoomOut.disabled = boundedPercent <= entry.minPercent + INLINE_MEDIA_EPSILON;
    entry.zoomIn.disabled = boundedPercent >= INLINE_MEDIA_MAX - INLINE_MEDIA_EPSILON;
  }

  function positionInlineMediaToolbar(entry, container) {
    const content = document.getElementById('content') || container;
    if (!entry || !entry.wrapper || !entry.toolbar || !content) return;

    const wrapperRect = entry.wrapper.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const layoutWidth = Number.parseFloat(getComputedStyle(entry.wrapper).width);
    const horizontalScale = layoutWidth > 0 ? wrapperRect.width / layoutWidth : 1;
    const rightValue = `${(wrapperRect.right - contentRect.right) / horizontalScale}px`;
    if (entry.wrapper.style.getPropertyValue('--inline-media-toolbar-right') !== rightValue) {
      entry.wrapper.style.setProperty('--inline-media-toolbar-right', rightValue);
    }
  }

  function initializeInlineMediaEntry(entry, container, viewport) {
    const availableWidth = entry.wrapper.parentElement
      ? entry.wrapper.parentElement.clientWidth
      : container.clientWidth;
    const autoFitPercent = calculateInlineAutoFitPercent(
      entry.media,
      availableWidth,
      viewport.clientHeight
    );
    entry.autoFitPercent = autoFitPercent;
    entry.minPercent = Math.min(INLINE_MEDIA_MANUAL_MIN, autoFitPercent);
    if (!entry.userAdjusted) applyInlineMediaPercent(entry, autoFitPercent);
    positionInlineMediaToolbar(entry, container);
  }

  function disposeInlineMediaController() {
    if (inlineMediaResizeObserver) {
      inlineMediaResizeObserver.disconnect();
      inlineMediaResizeObserver = null;
    }
    if (inlineMediaMutationObserver) {
      inlineMediaMutationObserver.disconnect();
      inlineMediaMutationObserver = null;
    }
    if (inlineMediaResizeFrame !== null) {
      cancelAnimationFrame(inlineMediaResizeFrame);
      inlineMediaResizeFrame = null;
    }
  }

  function setupInlineMediaController(container, entries) {
    disposeInlineMediaController();

    const viewport = document.getElementById('viewer-container');
    if (!container || !viewport || !entries.length) return;

    const initializeReadyEntry = (entry) => {
      const ratio = getInlineMediaAspectRatio(entry.media);
      if (ratio > 0) initializeInlineMediaEntry(entry, container, viewport);
    };

    const refreshEntries = () => {
      entries.forEach((entry) => {
        if (!entry.userAdjusted) initializeReadyEntry(entry);
        positionInlineMediaToolbar(entry, container);
      });
    };

    const scheduleRefresh = () => {
      if (inlineMediaResizeFrame !== null) cancelAnimationFrame(inlineMediaResizeFrame);
      inlineMediaResizeFrame = requestAnimationFrame(() => {
        inlineMediaResizeFrame = null;
        refreshEntries();
      });
    };

    entries.forEach((entry) => {
      applyInlineMediaPercent(entry, INLINE_MEDIA_MAX);
      positionInlineMediaToolbar(entry, container);
      if (entry.media.tagName === 'IMG' && !(entry.media.complete && entry.media.naturalWidth > 0)) {
        entry.media.addEventListener('load', () => initializeReadyEntry(entry), { once: true });
      } else {
        initializeReadyEntry(entry);
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      inlineMediaResizeObserver = new ResizeObserver(scheduleRefresh);
      inlineMediaResizeObserver.observe(container);
      inlineMediaResizeObserver.observe(viewport);
      entries.forEach((entry) => inlineMediaResizeObserver.observe(entry.wrapper));
    }

    if (typeof MutationObserver !== 'undefined') {
      inlineMediaMutationObserver = new MutationObserver(scheduleRefresh);
      inlineMediaMutationObserver.observe(container, {
        attributes: true,
        attributeFilter: ['class', 'style'],
        childList: true,
        subtree: true
      });
    }
  }

  function showMediaError(error) {
    const message = error && error.message ? error.message : (error && error.code ? error.code : String(error || 'media_error'));
    const warningEl = document.getElementById('performance-warning');
    const textEl = document.getElementById('warning-text');
    if (!warningEl || !textEl) return;
    textEl.textContent = t('viewer.media.error', { message });
    warningEl.style.display = 'block';
    setTimeout(() => {
      warningEl.style.display = 'none';
    }, 5000);
  }

  function wrapMediaElement(element, className) {
    if (!element || element.closest('.media-expand-wrapper')) return null;
    const wrapper = document.createElement(element.tagName === 'IMG' ? 'span' : 'div');
    wrapper.className = `media-expand-wrapper ${className || ''}`.trim();
    element.replaceWith(wrapper);
    wrapper.appendChild(element);
    return wrapper;
  }

  function createInlineMediaEntry(wrapper, media, payloadFactory) {
    const toolbar = document.createElement('div');
    toolbar.className = 'media-inline-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', t('viewer.media.toolbarAriaLabel'));

    const entry = {
      wrapper,
      media,
      currentPercent: INLINE_MEDIA_MAX,
      autoFitPercent: INLINE_MEDIA_MAX,
      minPercent: INLINE_MEDIA_MANUAL_MIN,
      userAdjusted: false,
      toolbar,
      zoomOut: null,
      zoomIn: null
    };

    const expand = createMediaExpandButton(payloadFactory);
    entry.zoomOut = createInlineMediaToolButton(
      'media-inline-zoom-out',
      'viewer.media.zoomOut',
      '-',
      () => {
        entry.userAdjusted = true;
        applyInlineMediaPercent(entry, entry.currentPercent - INLINE_MEDIA_ZOOM_STEP);
      }
    );
    entry.zoomIn = createInlineMediaToolButton(
      'media-inline-zoom-in',
      'viewer.media.zoomIn',
      '+',
      () => {
        entry.userAdjusted = true;
        applyInlineMediaPercent(entry, entry.currentPercent + INLINE_MEDIA_ZOOM_STEP);
      }
    );

    toolbar.append(expand, entry.zoomOut, entry.zoomIn);
    wrapper.appendChild(toolbar);
    return entry;
  }

  function setupMediaExpandAffordances(container) {
    disposeInlineMediaController();
    if (!container || container.querySelector('.empty-state')) return;
    if (document.body.classList.contains('pdf-mode')) return;

    const entries = [];

    container.querySelectorAll('.mermaid[data-mermaid-source]').forEach((mermaidEl, index) => {
      const wrapper = wrapMediaElement(mermaidEl, 'media-expand-wrapper-mermaid');
      if (!wrapper) return;
      entries.push(createInlineMediaEntry(wrapper, mermaidEl, () => ({
        type: 'mermaid',
        title: t('viewer.media.mermaidTitle', { index: index + 1 }),
        mermaidSource: mermaidEl.getAttribute('data-mermaid-source') || ''
      })));
    });

    container.querySelectorAll('img[src]').forEach((img) => {
      const wrapper = wrapMediaElement(img, 'media-expand-wrapper-image');
      if (!wrapper) return;
      entries.push(createInlineMediaEntry(wrapper, img, () => {
        const originalSrc = img.getAttribute('data-original-src') || img.getAttribute('src') || '';
        const resolvedSource = img.getAttribute('data-resolved-source') || '';
        const displaySrc = img.getAttribute('src') || '';
        return {
          type: 'image',
          title: img.getAttribute('title') || img.getAttribute('alt') || t('viewer.media.imageTitle'),
          alt: img.getAttribute('alt') || '',
          source: resolvedSource || originalSrc,
          displaySrc,
          fileName: originalSrc.split('/').pop() || ''
        };
      }));
    });

    setupInlineMediaController(container, entries);
  }

  const CODE_COPY_FEEDBACK_MS = 650;
  const CODE_COPY_FADE_MS = 180;

  function setCodeCopyButtonLabel(button, copied) {
    button.textContent = copied ? t('viewer.codeBlockCopied') : t('viewer.codeBlockCopy');
    button.setAttribute('aria-label', copied ? t('viewer.codeBlockCopiedAriaLabel') : t('viewer.codeBlockCopyAriaLabel'));
    button.setAttribute('title', button.getAttribute('aria-label'));
  }

  function clearCodeCopyTimers(button) {
    if (button._codeCopyFadeTimer) {
      clearTimeout(button._codeCopyFadeTimer);
      button._codeCopyFadeTimer = null;
    }
    if (button._codeCopyResetTimer) {
      clearTimeout(button._codeCopyResetTimer);
      button._codeCopyResetTimer = null;
    }
  }

  function showCodeCopiedFeedback(pre, button) {
    clearCodeCopyTimers(button);
    pre.classList.remove('code-copy-dismissed', 'code-copy-fading');
    pre.classList.add('code-copy-copied');
    setCodeCopyButtonLabel(button, true);

    button._codeCopyFadeTimer = setTimeout(() => {
      pre.classList.add('code-copy-fading');
      button._codeCopyResetTimer = setTimeout(() => {
        pre.classList.remove('code-copy-copied', 'code-copy-fading');
        pre.classList.add('code-copy-dismissed');
        setCodeCopyButtonLabel(button, false);
      }, CODE_COPY_FADE_MS);
    }, CODE_COPY_FEEDBACK_MS);
  }

  function createCodeCopyButton(pre, code) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy-button';
    setCodeCopyButtonLabel(button, false);
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = code.textContent || code.innerText || '';
      try {
        await navigator.clipboard.writeText(text);
        showCodeCopiedFeedback(pre, button);
      } catch (err) {
        console.warn('Failed to copy code block', err);
      }
    });
    return button;
  }

  function attachCodeBlockCopyAffordances(container) {
    if (!container || container.querySelector('.empty-state')) return;
    if (document.body.classList.contains('pdf-mode')) return;

    container.querySelectorAll('pre > code').forEach((code) => {
      const pre = code.parentElement;
      if (!pre || pre.tagName !== 'PRE') return;
      if (code.classList.contains('language-mermaid') || pre.closest('.mermaid')) return;
      if (Array.from(pre.children).some((child) => child.classList && child.classList.contains('code-copy-button'))) return;

      pre.classList.add('code-copy-host');
      pre.addEventListener('mouseleave', () => {
        pre.classList.remove('code-copy-dismissed');
      });
      pre.addEventListener('focusin', () => {
        pre.classList.remove('code-copy-dismissed');
      });
      pre.appendChild(createCodeCopyButton(pre, code));
    });
  }

  function renderBreadcrumbTrail(trail) {
    const breadcrumbEl = document.getElementById('viewer-breadcrumb');
    if (!breadcrumbEl) return;

    navigationTrail = normalizeBreadcrumbTrail(trail);
    if (window.DocuLight && window.DocuLight.state) {
      window.DocuLight.state.navigationTrail = navigationTrail;
    }

    breadcrumbEl.setAttribute('aria-label', t('viewer.breadcrumbAriaLabel'));
    breadcrumbEl.innerHTML = '';

    if (document.body.classList.contains('pdf-mode') || navigationTrail.length < 2) {
      breadcrumbEl.classList.add('hidden');
      return;
    }

    const frag = document.createDocumentFragment();
    navigationTrail.forEach((item, position) => {
      if (position > 0) {
        const separator = document.createElement('span');
        separator.className = 'viewer-breadcrumb-separator';
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '>';
        frag.appendChild(separator);
      }

      if (item.current || position === navigationTrail.length - 1) {
        const current = document.createElement('span');
        current.className = 'viewer-breadcrumb-current';
        current.setAttribute('aria-current', 'page');
        current.setAttribute('aria-label', t('viewer.breadcrumbCurrentAriaLabel', { label: item.label }));
        current.setAttribute('title', item.filePath);
        current.textContent = item.label;
        frag.appendChild(current);
        return;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'viewer-breadcrumb-segment';
      button.dataset.breadcrumbIndex = String(item.index);
      button.setAttribute('title', item.filePath);
      button.setAttribute('aria-label', t('viewer.breadcrumbSegmentAriaLabel', { label: item.label }));
      button.textContent = item.label;
      button.addEventListener('click', () => navigateBreadcrumbToIndex(item.index));
      frag.appendChild(button);
    });

    breadcrumbEl.appendChild(frag);
    breadcrumbEl.classList.remove('hidden');
    requestAnimationFrame(() => {
      breadcrumbEl.scrollLeft = breadcrumbEl.scrollWidth;
    });
  }

  /**
   * Open an already-resolved absolute document path: as a tab when tab mode is
   * active, otherwise in the current window. Callers must pass a resolved path,
   * never a raw href.
   */
  function openResolvedDocument(filePath) {
    if (window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.navigateToForTab) {
      window.DocuLight.fn.navigateToForTab(filePath);
    } else {
      window.doclight.navigateTo(filePath);
    }
  }

  /** Absolute path of the document the user is currently reading. */
  function activeDocumentPath() {
    const state = window.DocuLight && window.DocuLight.state;
    return (state && state.currentFilePath) || currentFilePath || null;
  }

  // === IPC Handlers ===

  // set-mcp-state: MCP document state from main process (FR-22-001)
  cleanups.push(window.doclight.onSetMcpState((data) => {
    isMcpDocument = !!data.isMcpDocument;
    mcpAutoSaveEnabled = !!data.mcpAutoSave;
    currentProject = data.project || '';
  }));

  // render-markdown: initial content when window opens
  cleanups.push(window.doclight.onRenderMarkdown((data) => {
    const isSameFile = currentFilePath && data.filePath && currentFilePath === data.filePath;
    const viewerContainerEl = document.getElementById('viewer-container');
    const savedScrollTop = isSameFile && viewerContainerEl ? viewerContainerEl.scrollTop : 0;

    currentFilePath = data.filePath || null;
    // Reset save-as path on new content
    saveAsFilePath = null;
    // Non-MCP sources (paste, file) reset MCP state
    if (data.source === 'paste') {
      isMcpDocument = false;
    }
    // Track original content for Save As (FR-21-002)
    if (!data.filePath) {
      originalContent = data.markdown || '';
    } else {
      originalContent = null;
    }
    if (window.DocuLight) {
      window.DocuLight.state.currentFilePath = data.filePath || null;
      window.DocuLight.state.imageBasePath = data.imageBasePath || null;
      if (data.platform) window.DocuLight.state.platform = data.platform;
    }
    document.body.classList.toggle('pdf-mode', data.pdfMode === true);
    renderBreadcrumbTrail(data.pdfMode ? [] : (data.navigationTrail || []));
    renderMarkdown(data.markdown);

    // PDF mode: hide UI elements and signal completion
    if (data.pdfMode) {
      // Hide non-content UI
      const floatingBtns = document.getElementById('floating-buttons');
      const sidebarContainer = document.getElementById('sidebar-container');
      const tocContainer = document.getElementById('toc-container');
      const resizeHandle = document.getElementById('resize-handle');
      const tabBar = document.getElementById('tab-bar');
      const metabox = document.getElementById('frontmatter-metabox');
      if (floatingBtns) floatingBtns.style.display = 'none';
      if (sidebarContainer) sidebarContainer.style.display = 'none';
      if (tocContainer) tocContainer.style.display = 'none';
      if (resizeHandle) resizeHandle.style.display = 'none';
      if (tabBar) tabBar.style.display = 'none';
      if (metabox) metabox.style.display = 'none';

      // Wait for Mermaid rendering then signal completion
      setTimeout(() => {
        if (window.doclight && window.doclight.pdfRenderComplete) {
          window.doclight.pdfRenderComplete();
        }
      }, 500);
    }

    // Restore scroll position for same-file refresh, or reset for new documents
    if (isSameFile && viewerContainerEl) {
      viewerContainerEl.scrollTop = savedScrollTop;
    } else if (viewerContainerEl) {
      viewerContainerEl.scrollTop = 0;
    }

    // Scroll to search match if pending from sidebar content search
    if (window.DocuLight && window.DocuLight.state && window.DocuLight.state.pendingSearchScroll) {
      const scrollInfo = window.DocuLight.state.pendingSearchScroll;
      window.DocuLight.state.pendingSearchScroll = null;
      // Delay to ensure rendering is fully complete (Mermaid, highlight, layout)
      setTimeout(() => {
        scrollToTextMatch(scrollInfo.query, scrollInfo.occurrenceIndex);
      }, 300);
    }

    // Update active tab state if tabs enabled
    if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.tabManager &&
        window.DocuLight.modules.tabManager.isEnabled() &&
        !data.pdfMode) {
      var tabIndex = window.DocuLight.modules.tabManager.getActiveTabIndex();
      if (tabIndex >= 0 && window.DocuLight.state.tabs && window.DocuLight.state.tabs[tabIndex]) {
        var activeTab = window.DocuLight.state.tabs[tabIndex];
        var cEl = document.getElementById('content');
        if (cEl) activeTab.renderedHtml = cEl.innerHTML;
        activeTab.filePath = data.filePath || activeTab.filePath;
        activeTab.navigationTrail = normalizeBreadcrumbTrail(data.navigationTrail || activeTab.navigationTrail || []);
        if (data.filePath) {
          var h1El = cEl && cEl.querySelector('h1');
          if (h1El) {
            activeTab.title = h1El.textContent;
          } else {
            var fp = data.filePath;
            activeTab.title = fp.substring(fp.replace(/\\/g, '/').lastIndexOf('/') + 1);
          }
        }
        activeTab.cachedAt = Date.now();
        // Re-render tab bar to reflect updated title
        var tabMod = window.DocuLight.modules.tabManager;
        if (tabMod && tabMod.renderTabBar) tabMod.renderTabBar();
      }
    }

    // Re-apply find highlights if find bar is open
    if (findBarVisible && findQuery) {
      setTimeout(() => performFind(findQuery), 300);
    }

    // 하단 이전/다음 파일 박스 업데이트
    updateDocNavBox();
  }));

  // update-markdown: content update for existing window
  cleanups.push(window.doclight.onUpdateMarkdown((data) => {
    currentFilePath = data.filePath || null;
    renderBreadcrumbTrail(data.navigationTrail || []);
    // Update originalContent for Save As (FR-21-002)
    if (!data.filePath && data.markdown != null) {
      originalContent = data.markdown;
    }
    const contentEl = document.getElementById('content');
    if (contentEl) contentEl.scrollTop = 0;
    const viewerContainer = document.getElementById('viewer-container');
    if (viewerContainer) viewerContainer.scrollTop = 0;
    renderMarkdown(data.markdown);

    // Re-apply find highlights if find bar is open
    if (findBarVisible && findQuery) {
      setTimeout(() => performFind(findQuery), 300);
    }
  }));

  // step28 Phase 2~3: 진행 중 사이드바 트리 로드 ID + 스피너 refCount
  let _currentTreeLoadId = 0;
  let _spinnerRefCount = 0;
  // step29 Phase 2: 사이드바 검색 모드 활성 여부 (doculight:searchmode CustomEvent로 추적)
  let _sidebarSearchModeActive = false;

  function showSidebarSpinner() {
    const el = document.getElementById('sidebar-loading-spinner');
    if (!el) return;
    _spinnerRefCount++;
    el.style.display = 'flex';
    el.setAttribute('aria-hidden', 'false');
  }
  function hideSidebarSpinner() {
    const el = document.getElementById('sidebar-loading-spinner');
    if (!el) return;
    _spinnerRefCount = Math.max(0, _spinnerRefCount - 1);
    if (_spinnerRefCount === 0) {
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
    }
  }
  function forceHideSidebarSpinner() {
    const el = document.getElementById('sidebar-loading-spinner');
    if (!el) return;
    _spinnerRefCount = 0;
    el.style.display = 'none';
    el.setAttribute('aria-hidden', 'true');
  }

  // step29 Phase 2: 사이드바 트리 전체 접기 — 모든 .tree-children 숨김 + toggle 문자 '▶'
  function collapseAllSidebarDirs() {
    const container = document.getElementById('sidebar-tree');
    if (!container) return;
    const childrenEls = container.querySelectorAll('.tree-children');
    for (const el of childrenEls) {
      el.style.display = 'none';
      const item = el.previousElementSibling;
      if (item && item.classList.contains('tree-item')) {
        const tog = item.querySelector('.tree-toggle');
        if (tog && tog.textContent) tog.textContent = '▶';
      }
    }
  }

  // step29 Phase 2: 사이드바 트리 전체 펼치기 — 모든 .tree-children 표시 + toggle 문자 '▼'
  function expandAllSidebarDirs() {
    const container = document.getElementById('sidebar-tree');
    if (!container) return;
    const childrenEls = container.querySelectorAll('.tree-children');
    for (const el of childrenEls) {
      el.style.display = 'block';
      const item = el.previousElementSibling;
      if (item && item.classList.contains('tree-item')) {
        const tog = item.querySelector('.tree-toggle');
        if (tog && tog.textContent) tog.textContent = '▼';
      }
    }
  }

  // step29 Phase 2: 접기/펼치기 버튼 disabled 상태 통합 관리
  //   disabled = 검색모드 || 로딩 || 트리부재 (OR 논리, AC-012)
  function updateSidebarToggleButtons() {
    const collapseBtn = document.getElementById('btn-sidebar-collapse-all');
    const expandBtn  = document.getElementById('btn-sidebar-expand-all');
    if (!collapseBtn || !expandBtn) return;

    const treeState = (window.DocuLight && window.DocuLight.state)
      ? window.DocuLight.state.sidebarTree : null;
    const treeEmpty = !treeState || !treeState.children || treeState.children.length === 0;
    const loading = _currentTreeLoadId !== 0;
    const disabled = _sidebarSearchModeActive || loading || treeEmpty;

    collapseBtn.disabled = disabled;
    expandBtn.disabled   = disabled;
  }

  // step28 Phase 2: 현재 로드 취소 헬퍼 (Phase 4에서 폴더 전환 시 호출)
  async function cancelCurrentTreeLoadIfAny() {
    if (_currentTreeLoadId > 0) {
      try { await window.doclight.cancelSidebarTreeLoad(_currentTreeLoadId); }
      catch { /* ignore */ }
      _currentTreeLoadId = 0;
    }
  }

  // step28 Phase 3: 배치 IPC 이벤트 → 스피너/증분 렌더 연결
  cleanups.push(window.doclight.onSidebarTreeStart((data) => {
    if (!data) return;
    _currentTreeLoadId = (typeof data.loadId === 'number') ? data.loadId : 0;
    if (!data.fromCache) showSidebarSpinner();
    const container = document.getElementById('sidebar-tree');
    if (container) container.innerHTML = '';
    updateSidebarToggleButtons();
  }));

  cleanups.push(window.doclight.onSidebarTreeBatch((data) => {
    if (!data || data.loadId !== _currentTreeLoadId) return;  // 구 로드 잔여 드롭
    appendPartialNodesToSidebar(data.nodes);
  }));

  cleanups.push(window.doclight.onSidebarTreeDone((data) => {
    if (!data || data.loadId !== _currentTreeLoadId) return;
    // 완성 트리로 깨끗하게 재렌더 (정렬/링크마킹/외부노드 반영)
    if (data.tree) {
      renderSidebarTree(data.tree);
      if (window.DocuLight) window.DocuLight.state.sidebarTree = data.tree;
    }
    hideSidebarSpinner();
    _currentTreeLoadId = 0;
    updateSidebarToggleButtons();
  }));

  cleanups.push(window.doclight.onSidebarTreeError((data) => {
    if (!data || data.loadId !== _currentTreeLoadId) return;
    hideSidebarSpinner();
    if (data.reason === 'aborted') {
      // 전환 중이므로 DOM 유지 (곧 새 start가 innerHTML=''로 리셋)
    } else {
      // 실제 에러 → 빈 사이드바
      const container = document.getElementById('sidebar-tree');
      if (container) container.innerHTML = '';
    }
    _currentTreeLoadId = 0;
    updateSidebarToggleButtons();
  }));

  // 헬퍼 전역 export (Phase 4에서 폴더 전환 경로에서 사용)
  if (!window.DocuLight) window.DocuLight = {};
  if (!window.DocuLight.fn) window.DocuLight.fn = {};
  window.DocuLight.fn.cancelCurrentTreeLoadIfAny = cancelCurrentTreeLoadIfAny;
  window.DocuLight.fn.showSidebarSpinner = showSidebarSpinner;
  window.DocuLight.fn.hideSidebarSpinner = hideSidebarSpinner;
  window.DocuLight.fn.forceHideSidebarSpinner = forceHideSidebarSpinner;
  // step29 Phase 2: 3함수 export (테스트/디버그용)
  window.DocuLight.fn.collapseAllSidebarDirs = collapseAllSidebarDirs;
  window.DocuLight.fn.expandAllSidebarDirs = expandAllSidebarDirs;
  window.DocuLight.fn.updateSidebarToggleButtons = updateSidebarToggleButtons;

  // step29 Phase 2: 사이드바 검색 모드 전환 감지 → 버튼 disabled 갱신
  const _sidebarSearchmodeHandler = (e) => {
    _sidebarSearchModeActive = !!(e && e.detail && e.detail.active);
    updateSidebarToggleButtons();
  };
  document.addEventListener('doculight:searchmode', _sidebarSearchmodeHandler);
  cleanups.push(() => document.removeEventListener('doculight:searchmode', _sidebarSearchmodeHandler));

  // step29 Phase 2: 접기/펼치기 버튼 click 이벤트 바인딩
  const _collapseAllBtn = document.getElementById('btn-sidebar-collapse-all');
  const _expandAllBtn = document.getElementById('btn-sidebar-expand-all');
  if (_collapseAllBtn) {
    _collapseAllBtn.addEventListener('click', () => {
      if (_collapseAllBtn.disabled) return;
      collapseAllSidebarDirs();
    });
  }
  if (_expandAllBtn) {
    _expandAllBtn.addEventListener('click', () => {
      if (_expandAllBtn.disabled) return;
      expandAllSidebarDirs();
    });
  }
  // 초기 상태 확정 (트리 부재 → disabled)
  updateSidebarToggleButtons();

  // sidebar-tree: tree data for sidebar (기존 호환 경로)
  //   step28 Phase 3: 스트리밍 로드 진행 중이면 중복 렌더 방지
  cleanups.push(window.doclight.onSidebarTree((data) => {
    if (_currentTreeLoadId !== 0) {
      // 스트리밍 done이 처리 예정 → 기존 이벤트 렌더링 생략 (중복 방지)
      // 단, sidebar 토글 관련 상태만 업데이트
      const nameToggleBtn = document.getElementById('btn-sidebar-name-toggle');
      if (data.tree && data.tree.children && data.tree.children.length > 0) {
        if (window.DocuLight) window.DocuLight.state.sidebarTree = data.tree;
        if (!savedPrefs || savedPrefs.sidebarVisible !== false) showSidebar();
        if (nameToggleBtn) nameToggleBtn.disabled = false;
        updateDocNavBox();
      } else {
        hideSidebar();
        if (nameToggleBtn) nameToggleBtn.disabled = true;
      }
      updateSidebarToggleButtons();
      return;
    }
    const nameToggleBtn = document.getElementById('btn-sidebar-name-toggle');
    if (data.tree && data.tree.children && data.tree.children.length > 0) {
      renderSidebarTree(data.tree);
      if (window.DocuLight) {
        window.DocuLight.state.sidebarTree = data.tree;
      }
      if (!savedPrefs || savedPrefs.sidebarVisible !== false) {
        showSidebar();
      }
      if (nameToggleBtn) nameToggleBtn.disabled = false;
      updateDocNavBox();
    } else {
      hideSidebar();
      if (nameToggleBtn) nameToggleBtn.disabled = true;
    }
    updateSidebarToggleButtons();
  }));

  // sidebar-highlight: update active item in tree
  cleanups.push(window.doclight.onSidebarHighlight((data) => {
    updateSidebarHighlight(data.currentPath);
  }));

  // theme-changed
  cleanups.push(window.doclight.onThemeChanged((data) => {
    if (data.theme) {
      document.documentElement.dataset.theme = data.theme;
      currentAppTheme = data.theme;
      applyCodeTheme(currentCodeTheme, data.theme);
    }
  }));

  // settings-changed
  cleanups.push(window.doclight.onSettingsChanged((data) => {
    if (data.fontSize) {
      document.documentElement.style.setProperty('--font-size', data.fontSize + 'px');
    }
    if (data.fontFamily) {
      document.documentElement.style.setProperty('--font-family', data.fontFamily);
    }
    if (data.codeTheme) {
      applyCodeTheme(data.codeTheme, currentAppTheme);
    }
    if (data.contentWidth !== undefined) {
      document.documentElement.style.setProperty('--content-width', data.contentWidth || 'auto');
    }
    if (data.contentMaxWidth !== undefined) {
      document.documentElement.style.setProperty('--content-max-width', data.contentMaxWidth || 'none');
    }
  }));

  // === Severity Bar (FR-19-003) ===
  cleanups.push(window.doclight.onSetSeverity((data) => {
    const bar = document.getElementById('severity-bar');
    if (!bar) return;
    bar.className = 'severity-bar';
    if (data.severity) {
      bar.classList.add('severity-' + data.severity);
    }
  }));

  // === Auto-close Countdown (FR-19-004) ===
  let _autoCloseInterval = null;
  cleanups.push(window.doclight.onAutoCloseStart((data) => {
    const bar = document.getElementById('auto-close-bar');
    if (!bar) return;

    if (_autoCloseInterval) {
      clearInterval(_autoCloseInterval);
      _autoCloseInterval = null;
    }

    let remaining = data.seconds;

    function updateBar() {
      bar.style.display = 'block';
      bar.textContent = t('viewer.autoCloseLabel', { seconds: remaining });
      if (remaining <= 5) {
        bar.classList.add('urgent');
      } else {
        bar.classList.remove('urgent');
      }
    }

    updateBar();
    _autoCloseInterval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(_autoCloseInterval);
        _autoCloseInterval = null;
        return;
      }
      updateBar();
    }, 1000);
  }));

  // set-saved-file-path: auto-save path from main (FR-21-001)
  cleanups.push(window.doclight.onSetSavedFilePath((data) => {
    savedFilePath = data.savedFilePath || null;
  }));

  // === Empty Window Handler ===
  cleanups.push(window.doclight.onEmptyWindow(() => {
    const contentEl = document.getElementById('content');
    if (!contentEl) return;
    markdownRenderGeneration += 1;
    disposeInlineMediaController();
    renderBreadcrumbTrail([]);
    contentEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📄</div>
        <div class="empty-state-title">DocuLight</div>
        <div class="empty-state-text">${t('viewer.dropHint')}</div>
        <div class="empty-state-hint">${t('viewer.dropFileType')}</div>
      </div>
    `;
  }));

  // === Viewer Toast ===
  function showViewerToast(message, type) {
    var existing = document.querySelector('.viewer-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.className = 'viewer-toast' + (type ? ' ' + type : '');
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(function () {
      toast.classList.add('visible');
    });
    var duration = type === 'error' ? 3500 : 2500;
    setTimeout(function () {
      toast.classList.remove('visible');
      setTimeout(function () { toast.remove(); }, 200);
    }, duration);
  }

  // === Save As / Quick Save (FR-21-002, FR-21-003) ===
  function getDefaultFileName() {
    if (currentFilePath) {
      return currentFilePath.split(/[/\\]/).pop();
    }
    var title = document.title || '';
    if (title) {
      return title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 100) + '.md';
    }
    return 'untitled.md';
  }

  function buildSaveParams() {
    var contentEl = document.getElementById('content');
    var isEmpty = !currentFilePath && !(contentEl && contentEl.hasChildNodes());
    if (isEmpty) return null;

    var params = {};
    if (currentFilePath) {
      params.filePath = currentFilePath;
      params.defaultFileName = currentFilePath.split(/[/\\]/).pop();
    } else {
      params.content = originalContent || '';
      params.defaultFileName = getDefaultFileName();
    }
    return params;
  }

  async function handleSaveAs() {
    var params = buildSaveParams();
    if (!params) return;

    var result = await window.doclight.saveAs(params);
    if (result.success) {
      saveAsFilePath = result.filePath;
      showViewerToast(t('viewer.savedToast') + ': ' + result.filePath);
    } else if (result.error) {
      showViewerToast(t('viewer.saveFailed') + ': ' + result.error);
    }
  }

  async function handleQuickSave() {
    var params = buildSaveParams();
    if (!params) return;

    var result = await window.doclight.quickSave(params);
    if (result.success) {
      showViewerToast(t('viewer.savedToast') + ': ' + result.filePath);
    } else if (result.reason === 'no-directory') {
      handleSaveAs();
    } else if (result.error) {
      showViewerToast(t('viewer.saveFailed') + ': ' + result.error);
    }
  }

  async function handleDeleteAutoSaved() {
    if (!savedFilePath) return;
    var result = await window.doclight.deleteAutoSavedFile();
    if (result.success) {
      var fileName = result.deletedPath ? result.deletedPath.split(/[/\\]/).pop() : '';
      savedFilePath = null;
      showViewerToast(t('viewer.deleteAutoSavedToast') + ': ' + fileName);
    } else if (result.error && result.error !== 'no saved file') {
      showViewerToast(t('viewer.deleteFailed') + ': ' + result.error);
    }
  }

  // === MCP Manual Save (FR-22-001) ===
  async function handleMcpSave() {
    if (!isMcpDocument) return;
    var params = buildSaveParams();
    if (!params) return;
    params.title = document.title || '';
    params.project = currentProject || '';
    var result = await window.doclight.mcpManualSave(params);
    if (result.success) {
      savedFilePath = result.filePath;
      showViewerToast(t('viewer.savedToast') + ': ' + result.filePath);
    } else {
      showViewerToast(t(result.errorKey) + (result.errorDetail ? ': ' + result.errorDetail : ''), 'error');
    }
  }

  // === Path Copy Helper (FR-22-003) ===
  function getCopyablePath() {
    if (currentFilePath) return currentFilePath;
    if (saveAsFilePath) return saveAsFilePath;
    if (savedFilePath) return savedFilePath;
    return null;
  }

  // === Context Menu Positioning & Close (shared) ===
  function positionAndBindContextMenu(menu, e) {
    document.body.appendChild(menu);
    var rect = menu.getBoundingClientRect();
    var x = e.clientX, y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    function closeMenu(ev) {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', closeMenu);
        document.removeEventListener('keydown', escH);
      }
    }
    function escH(ev) {
      if (ev.key === 'Escape') {
        menu.remove();
        document.removeEventListener('mousedown', closeMenu);
        document.removeEventListener('keydown', escH);
      }
    }
    setTimeout(function () {
      document.addEventListener('mousedown', closeMenu);
      document.addEventListener('keydown', escH);
    }, 0);
  }

  // === Sidebar Context Menu (FR-22-002) ===
  function showSidebarContextMenu(e, itemPath, isDirectory) {
    var old = document.querySelector('.ctx-menu');
    if (old) old.remove();
    var menu = document.createElement('div');
    menu.className = 'ctx-menu';

    // Open in New Tab (only if tabs enabled and item is a file)
    var tabMod = window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.tabManager;
    var tabsEnabled = tabMod && tabMod.isEnabled();
    if (tabsEnabled && !isDirectory) {
      var openTabItem = document.createElement('div');
      openTabItem.className = 'ctx-menu-item';
      openTabItem.textContent = t('viewer.openInNewTab');
      openTabItem.addEventListener('click', function () {
        menu.remove();
        if (window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.navigateToForTab) {
          window.DocuLight.fn.navigateToForTab(itemPath);
        }
      });
      menu.appendChild(openTabItem);
    }

    var copyItem = document.createElement('div');
    copyItem.className = 'ctx-menu-item';
    copyItem.textContent = t('viewer.copyPath');
    copyItem.addEventListener('click', function () {
      menu.remove();
      navigator.clipboard.writeText(itemPath).then(function () {
        showViewerToast(t('viewer.pathCopied', { path: itemPath }));
      }).catch(function (err) { console.error('Failed to copy path:', err); });
    });
    menu.appendChild(copyItem);

    var explorerItem = document.createElement('div');
    explorerItem.className = 'ctx-menu-item';
    explorerItem.textContent = t('viewer.showInExplorer');
    explorerItem.addEventListener('click', function () {
      menu.remove();
      window.doclight.showFileInExplorer(itemPath);
    });
    menu.appendChild(explorerItem);

    positionAndBindContextMenu(menu, e);
  }

  // === Context Menu ===
  function showContextMenu(e) {
    // Remove any existing context menu
    const old = document.querySelector('.ctx-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';

    const tabMod = window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.tabManager;
    const tabsEnabled = tabMod && tabMod.isEnabled();

    // Empty page: no content rendered yet, or showing drop zone (empty-state).
    // Content-string windows have no filePath but are not empty.
    const contentEl = document.getElementById('content');
    const isEmpty = !currentFilePath && (!contentEl || !contentEl.hasChildNodes() || !!contentEl.querySelector('.empty-state'));

    // Check if right-click target is inside a code block
    const codeBlock = !isEmpty && e.target.closest('pre');

    // When empty (drop zone), show only Close
    if (!isEmpty) {
      // Copy selected text
      const selectedText = window.getSelection().toString();
      if (selectedText.length > 0) {
        const copyItem = document.createElement('div');
        copyItem.className = 'ctx-menu-item';
        copyItem.innerHTML = t('viewer.copy') + '<span class="ctx-menu-shortcut">Ctrl+C</span>';
        copyItem.addEventListener('click', () => {
          menu.remove();
          navigator.clipboard.writeText(selectedText).catch(() => {
            document.execCommand('copy');
          });
        });
        menu.appendChild(copyItem);
      }

      // New Tab (only if tabs enabled)
      if (tabsEnabled) {
        const newTabItem = document.createElement('div');
        newTabItem.className = 'ctx-menu-item';
        newTabItem.innerHTML = t('viewer.newTab').replace(/\s*\(.*\)$/, '') + '<span class="ctx-menu-shortcut">Ctrl+T</span>';
        newTabItem.addEventListener('click', () => {
          menu.remove();
          if (tabMod.createBlankTab) tabMod.createBlankTab();
        });
        menu.appendChild(newTabItem);
      }

      // Select All
      const selectAllItem = document.createElement('div');
      selectAllItem.className = 'ctx-menu-item';
      selectAllItem.innerHTML = t('viewer.selectAll') + '<span class="ctx-menu-shortcut">Ctrl+A</span>';
      selectAllItem.addEventListener('click', () => {
        menu.remove();
        const contentEl = document.getElementById('content');
        if (contentEl) {
          const range = document.createRange();
          range.selectNodeContents(contentEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
      menu.appendChild(selectAllItem);

      // Select Block Text (only if inside code block)
      if (codeBlock) {
        const selectBlockItem = document.createElement('div');
        selectBlockItem.className = 'ctx-menu-item';
        selectBlockItem.textContent = t('viewer.selectBlock');
        selectBlockItem.addEventListener('click', () => {
          menu.remove();
          const range = document.createRange();
          const codeEl = codeBlock.querySelector('code') || codeBlock;
          range.selectNodeContents(codeEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        });
        menu.appendChild(selectBlockItem);
      }

      // Copy Source (원문 복사)
      const copySourceItem = document.createElement('div');
      copySourceItem.className = 'ctx-menu-item';
      copySourceItem.textContent = t('viewer.copySource');
      copySourceItem.addEventListener('click', async () => {
        menu.remove();
        let markdown = originalContent;
        if (!markdown) {
          const filePath = currentFilePath || saveAsFilePath || savedFilePath;
          if (filePath) {
            try {
              const result = await window.doclight.readFileForTab(filePath);
              if (result && !result.error && result.markdown) {
                markdown = result.markdown;
              }
            } catch (err) {
              console.error('[doculight] Failed to read source:', err);
            }
          }
        }
        if (markdown) {
          navigator.clipboard.writeText(markdown).then(() => {
            showViewerToast(t('viewer.sourceCopied'));
          }).catch((err) => {
            console.error('[doculight] Failed to copy source:', err);
          });
        }
      });
      menu.appendChild(copySourceItem);

      // Separator
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);

      // Copy Path (FR-22-003: extended to MCP saved files)
      const copyPath = getCopyablePath();
      const copyPathItem = document.createElement('div');
      copyPathItem.className = 'ctx-menu-item' + (copyPath ? '' : ' disabled');
      copyPathItem.innerHTML = t('viewer.copyPath') + '<span class="ctx-menu-shortcut">Ctrl+Shift+C</span>';
      if (copyPath) {
        copyPathItem.addEventListener('click', () => {
          menu.remove();
          navigator.clipboard.writeText(copyPath).then(() => {
            showViewerToast(t('viewer.pathCopied', { path: copyPath }));
          }).catch(function(err) {
            console.error('Failed to copy path:', err);
          });
        });
      }
      menu.appendChild(copyPathItem);

      // Show in Explorer
      const showExplorerItem = document.createElement('div');
      showExplorerItem.className = 'ctx-menu-item' + (copyPath ? '' : ' disabled');
      showExplorerItem.textContent = t('viewer.showInExplorer');
      if (copyPath) {
        showExplorerItem.addEventListener('click', () => {
          menu.remove();
          window.doclight.showFileInExplorer(copyPath);
        });
      }
      menu.appendChild(showExplorerItem);

      // Separator before Save
      const sep2 = document.createElement('div');
      sep2.className = 'ctx-menu-sep';
      menu.appendChild(sep2);

      // Save (FR-22-001: MCP manual save when auto-save is off)
      if (isMcpDocument && !mcpAutoSaveEnabled) {
        const saveItem = document.createElement('div');
        saveItem.className = 'ctx-menu-item';
        saveItem.innerHTML = t('viewer.save') + '<span class="ctx-menu-shortcut">Ctrl+S</span>';
        saveItem.addEventListener('click', () => { menu.remove(); handleMcpSave(); });
        menu.appendChild(saveItem);
      }

      // Save As (FR-21-002)
      const saveAsItem = document.createElement('div');
      saveAsItem.className = 'ctx-menu-item';
      saveAsItem.innerHTML = t('viewer.saveAs') + '<span class="ctx-menu-shortcut">Ctrl+Shift+S</span>';
      saveAsItem.addEventListener('click', () => {
        menu.remove();
        handleSaveAs();
      });
      menu.appendChild(saveAsItem);

      // Delete auto-saved file (FR-21-001) — only when savedFilePath exists
      if (savedFilePath) {
        const sepDelete = document.createElement('div');
        sepDelete.className = 'ctx-menu-sep';
        menu.appendChild(sepDelete);

        const deleteItem = document.createElement('div');
        deleteItem.className = 'ctx-menu-item';
        deleteItem.innerHTML = t('viewer.deleteAutoSaved') + '<span class="ctx-menu-shortcut">Ctrl+Alt+D</span>';
        deleteItem.addEventListener('click', () => {
          menu.remove();
          handleDeleteAutoSaved();
        });
        menu.appendChild(deleteItem);
      }

      // Separator before PDF
      const sep3 = document.createElement('div');
      sep3.className = 'ctx-menu-sep';
      menu.appendChild(sep3);

      // Print (PDF export)
      const printItem = document.createElement('div');
      printItem.className = 'ctx-menu-item';
      printItem.innerHTML = t('viewer.exportPdf') + '<span class="ctx-menu-shortcut">Ctrl+P</span>';
      printItem.addEventListener('click', () => {
        menu.remove();
        if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.pdfExportUi &&
            window.DocuLight.modules.pdfExportUi.openModal) {
          window.DocuLight.modules.pdfExportUi.openModal();
        }
      });
      menu.appendChild(printItem);
    }

    // Close
    const closeItem = document.createElement('div');
    closeItem.className = 'ctx-menu-item';
    closeItem.innerHTML = t('viewer.closeWindow') + '<span class="ctx-menu-shortcut">Ctrl+W</span>';
    closeItem.addEventListener('click', () => {
      menu.remove();
      if (tabsEnabled) {
        tabMod.closeTab();
      } else {
        window.close();
      }
    });
    menu.appendChild(closeItem);

    positionAndBindContextMenu(menu, e);
  }

  // Attach context menu to viewer area
  document.addEventListener('contextmenu', (e) => {
    const viewerContainer = document.getElementById('viewer-container');
    if (viewerContainer && viewerContainer.contains(e.target)) {
      e.preventDefault();
      showContextMenu(e);
    }
  });

  function getCurrentPastePlatform() {
    var state = window.DocuLight && window.DocuLight.state;
    if (state && state.platform) return state.platform;
    var platform = (navigator && navigator.platform) ? navigator.platform.toLowerCase() : '';
    return platform.indexOf('win') >= 0 ? 'win32' : '';
  }

  function looksLikeAbsoluteMarkdownPathPaste(text) {
    if (typeof text !== 'string') return false;
    var value = text.trim();
    if (!value || /[\r\n]/.test(value)) return false;
    if ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'")) {
      value = value.slice(1, -1).trim();
    }
    if (!/\.md$/i.test(value)) return false;
    var platform = getCurrentPastePlatform();
    if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(value);
    return value[0] === '/';
  }

  // === MD Paste on Empty Page / Absolute Path Paste (FR-RENDER-025, FR-WIN-014) ===
  document.addEventListener('paste', function (e) {
    var contentEl = document.getElementById('content');
    var isEmpty = !currentFilePath && (!contentEl || !contentEl.hasChildNodes() ||
                  !!contentEl.querySelector('.empty-state'));

    var active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    if (findBarVisible) return;

    var text = null;
    if (e.clipboardData) {
      text = e.clipboardData.getData('text/plain');
    }
    if (!text || !text.trim()) return;

    var isPathPaste = looksLikeAbsoluteMarkdownPathPaste(text);
    if (!isEmpty && !isPathPaste) return;

    e.preventDefault();
    if (isEmpty) {
      originalContent = text;
      currentFilePath = null;
      saveAsFilePath = null;
      savedFilePath = null;
    }
    var allowMarkdownFallback = isEmpty;
    window.doclight.renderPastedContent(isPathPaste
      ? { text: text, allowMarkdownFallback: allowMarkdownFallback }
      : text);
  });

  // === Find in Page ===

  function openFindBar() {
    const bar = document.getElementById('find-bar');
    const input = document.getElementById('find-input');
    if (!bar || !input) return;
    bar.classList.remove('hidden');
    findBarVisible = true;
    input.focus();
    input.select();
    updateFindPosition();
  }

  function closeFindBar() {
    const bar = document.getElementById('find-bar');
    if (bar) bar.classList.add('hidden');
    findBarVisible = false;
    clearFindHighlights();
    findMatches = [];
    findCurrentIndex = -1;
    findQuery = '';
    updateFindCount();
    hideMarkerTrack();
  }

  function clearFindHighlights() {
    const contentEl = document.getElementById('content');
    if (!contentEl) return;
    const marks = contentEl.querySelectorAll('mark.find-highlight');
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      }
    });
  }

  function performFind(query) {
    clearFindHighlights();
    findMatches = [];
    findCurrentIndex = -1;
    findQuery = query;

    if (!query || query.length === 0) {
      updateFindCount();
      hideMarkerTrack();
      updateFindButtons();
      return;
    }

    const contentEl = document.getElementById('content');
    if (!contentEl) return;

    const lowerQuery = query.toLowerCase();
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.toLowerCase().includes(lowerQuery)) {
        textNodes.push(node);
      }
    }

    for (const textNode of textNodes) {
      highlightMatchesInNode(textNode, query);
    }

    findMatches = Array.from(contentEl.querySelectorAll('mark.find-highlight'));

    if (findMatches.length > 0) {
      findCurrentIndex = 0;
      findMatches[0].classList.add('find-current');
      scrollToFindMatch(findMatches[0]);
    }

    updateFindCount();
    updateFindButtons();
    updateMarkerTrack();
  }

  function highlightMatchesInNode(textNode, query) {
    const text = textNode.textContent;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const parent = textNode.parentNode;
    if (!parent) return;

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let idx = lowerText.indexOf(lowerQuery, lastIndex);

    while (idx !== -1) {
      if (idx > lastIndex) {
        frag.appendChild(document.createTextNode(text.substring(lastIndex, idx)));
      }
      const mark = document.createElement('mark');
      mark.className = 'find-highlight';
      mark.textContent = text.substring(idx, idx + query.length);
      frag.appendChild(mark);
      lastIndex = idx + query.length;
      idx = lowerText.indexOf(lowerQuery, lastIndex);
    }

    if (lastIndex < text.length) {
      frag.appendChild(document.createTextNode(text.substring(lastIndex)));
    }

    if (lastIndex > 0) {
      parent.replaceChild(frag, textNode);
    }
  }

  function findNext() {
    if (findMatches.length === 0) return;
    findMatches[findCurrentIndex].classList.remove('find-current');
    findCurrentIndex = (findCurrentIndex + 1) % findMatches.length;
    findMatches[findCurrentIndex].classList.add('find-current');
    scrollToFindMatch(findMatches[findCurrentIndex]);
    updateFindCount();
    updateMarkerTrack();
  }

  function findPrev() {
    if (findMatches.length === 0) return;
    findMatches[findCurrentIndex].classList.remove('find-current');
    findCurrentIndex = (findCurrentIndex - 1 + findMatches.length) % findMatches.length;
    findMatches[findCurrentIndex].classList.add('find-current');
    scrollToFindMatch(findMatches[findCurrentIndex]);
    updateFindCount();
    updateMarkerTrack();
  }

  function scrollToFindMatch(markEl) {
    const viewer = document.getElementById('viewer-container');
    if (!viewer || !markEl) return;
    const rect = markEl.getBoundingClientRect();
    const viewerRect = viewer.getBoundingClientRect();
    const scrollTop = viewer.scrollTop + (rect.top - viewerRect.top) - (viewerRect.height / 2);
    viewer.scrollTo({ top: scrollTop, behavior: 'smooth' });
  }

  function updateFindCount() {
    const countEl = document.getElementById('find-count');
    if (!countEl) return;
    if (findMatches.length === 0) {
      countEl.textContent = findQuery ? t('viewer.findNoResults') : '';
    } else {
      countEl.textContent = (findCurrentIndex + 1) + '/' + findMatches.length;
    }
  }

  function updateFindButtons() {
    const prevBtn = document.getElementById('find-prev');
    const nextBtn = document.getElementById('find-next');
    const hasMatches = findMatches.length > 0;
    if (prevBtn) prevBtn.disabled = !hasMatches;
    if (nextBtn) nextBtn.disabled = !hasMatches;
  }

  function updateMarkerTrack() {
    const track = document.getElementById('find-marker-track');
    const viewer = document.getElementById('viewer-container');
    if (!track || !viewer) return;

    track.innerHTML = '';
    if (findMatches.length === 0) {
      track.classList.add('hidden');
      return;
    }

    track.classList.remove('hidden');
    const scrollHeight = viewer.scrollHeight;
    if (scrollHeight === 0) return;

    // Limit markers to 500 for performance
    let markersToShow = findMatches;
    if (findMatches.length > 500) {
      const step = findMatches.length / 500;
      markersToShow = [];
      for (let i = 0; i < 500; i++) {
        markersToShow.push(findMatches[Math.floor(i * step)]);
      }
      // Always include current match
      if (findCurrentIndex >= 0 && !markersToShow.includes(findMatches[findCurrentIndex])) {
        markersToShow.push(findMatches[findCurrentIndex]);
      }
    }

    const trackHeight = track.offsetHeight;
    const frag = document.createDocumentFragment();

    for (let i = 0; i < markersToShow.length; i++) {
      const mark = markersToShow[i];
      const top = getElementScrollPosition(mark, viewer);
      const ratio = top / scrollHeight;
      const markerDiv = document.createElement('div');
      markerDiv.className = 'find-marker';
      if (mark === findMatches[findCurrentIndex]) {
        markerDiv.classList.add('find-marker-current');
      }
      markerDiv.style.top = (ratio * trackHeight) + 'px';
      const matchIndex = findMatches.indexOf(mark);
      markerDiv.addEventListener('click', () => {
        if (findCurrentIndex >= 0 && findCurrentIndex < findMatches.length) {
          findMatches[findCurrentIndex].classList.remove('find-current');
        }
        findCurrentIndex = matchIndex;
        findMatches[findCurrentIndex].classList.add('find-current');
        scrollToFindMatch(findMatches[findCurrentIndex]);
        updateFindCount();
        updateMarkerTrack();
      });
      frag.appendChild(markerDiv);
    }

    track.appendChild(frag);
  }

  function getElementScrollPosition(el, container) {
    let top = 0;
    let current = el;
    while (current && current !== container) {
      top += current.offsetTop;
      current = current.offsetParent;
    }
    return top;
  }

  function hideMarkerTrack() {
    const track = document.getElementById('find-marker-track');
    if (track) {
      track.classList.add('hidden');
      track.innerHTML = '';
    }
  }

  function updateFindPosition() {
    const findBar = document.getElementById('find-bar');
    const markerTrack = document.getElementById('find-marker-track');
    const tocContainer = document.getElementById('toc-container');
    const tocHandle = document.getElementById('toc-resize-handle');

    let rightOffset = 0;
    if (tocVisible && tocContainer && !tocContainer.classList.contains('hidden')) {
      rightOffset += tocContainer.offsetWidth;
    }
    if (tocVisible && tocHandle && !tocHandle.classList.contains('hidden')) {
      rightOffset += tocHandle.offsetWidth;
    }

    if (findBar) findBar.style.right = (rightOffset + 16) + 'px';
    if (markerTrack) markerTrack.style.right = rightOffset + 'px';
  }

  // Find bar event bindings
  (function initFindBar() {
    const input = document.getElementById('find-input');
    const prevBtn = document.getElementById('find-prev');
    const nextBtn = document.getElementById('find-next');
    const closeBtn = document.getElementById('find-close');

    if (input) {
      input.addEventListener('input', () => {
        clearTimeout(findDebounceTimer);
        findDebounceTimer = setTimeout(() => {
          performFind(input.value);
        }, 200);
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) { findPrev(); } else { findNext(); }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeFindBar();
        }
      });
    }

    if (prevBtn) prevBtn.addEventListener('click', findPrev);
    if (nextBtn) nextBtn.addEventListener('click', findNext);
    if (closeBtn) closeBtn.addEventListener('click', closeFindBar);

    // Recalculate marker track on window resize
    window.addEventListener('resize', () => {
      if (findBarVisible && findMatches.length > 0) {
        requestAnimationFrame(updateMarkerTrack);
      }
      updateFindPosition();
    });
  })();

  // === Drag & Drop ===
  let dragCounter = 0;

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter++;
    document.body.classList.add('drag-over');
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      document.body.classList.remove('drag-over');
    }
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    document.body.classList.remove('drag-over');

    const files = [...e.dataTransfer.files];
    const mdFile = files.find(f => f.name.endsWith('.md'));
    if (mdFile) {
      const filePath = window.doclight.getFilePath(mdFile);
      if (!filePath) return;

      // If tabs enabled and current tab has content, open in new tab
      const tabMod = window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.tabManager;
      if (tabMod && tabMod.isEnabled() && currentFilePath) {
        if (window.doclight.readFileForTab) {
          window.doclight.readFileForTab(filePath).then((data) => {
            if (!data.error && tabMod.createTab) {
              tabMod.createTab(data);
              // Notify main for watcher + recent tracking
              if (window.doclight.fileOpenedInTab) {
                window.doclight.fileOpenedInTab(filePath);
              }
            } else {
              // Fallback to replacing current content
              window.doclight.fileDropped(filePath);
            }
          });
          return;
        }
      }

      window.doclight.fileDropped(filePath);
    }
  });

  // === Sidebar Functions (Phase 5 stubs, basic implementation) ===

  function showSidebar() {
    const sidebar = document.getElementById('sidebar-container');
    const handle = document.getElementById('resize-handle');
    if (sidebar) sidebar.classList.remove('hidden');
    if (handle) handle.classList.remove('hidden');
    sidebarVisible = true;
    updateFabStates();
  }

  function hideSidebar() {
    const sidebar = document.getElementById('sidebar-container');
    const handle = document.getElementById('resize-handle');
    if (sidebar) sidebar.classList.add('hidden');
    if (handle) handle.classList.add('hidden');
    sidebarVisible = false;
    updateFabStates();
  }

  function toggleSidebar() {
    if (sidebarVisible) {
      hideSidebar();
    } else {
      showSidebar();
    }
    savePanelPrefs(getCurrentPanelPrefs());
  }

  /**
   * 이름 토글 상태에 따라 파일 노드 표시명 반환
   * isDirectory/isVirtual 노드는 caller(renderTreeNode, updateDocNavBox)에서 제외 후 호출
   * @param {Object} node - 파일 노드 (isDirectory: false)
   * @returns {string} 표시명
   */
  function getDisplayName(node) {
    const state = window.DocuLight && window.DocuLight.state;
    if (state && state.showFrontmatterName &&
        node.frontmatterName && node.frontmatterName.trim() !== '') {
      return node.frontmatterName;
    }
    return node.title || '';
  }

  /**
   * 사이드바 트리를 DFS 순회하여 모든 파일 노드를 순서대로 수집
   * 가상 노드(isVirtual, __external_links__)와 그 하위는 제외
   * @param {Object} node - 트리 노드
   * @returns {Array} 파일 노드 배열 (정렬 순서 유지)
   */
  function collectNavFiles(node) {
    if (!node) return [];
    if (node.isVirtual || node.title === '__external_links__') return [];
    if (!node.isDirectory) return [node];
    const result = [];
    if (node.children) {
      for (const child of node.children) {
        result.push(...collectNavFiles(child));
      }
    }
    return result;
  }

  /**
   * #doc-nav-box DOM 요소가 없으면 생성하고, 있으면 재사용 (display 복원)
   * #content 다음 형제로 삽입 (NFR-26-001: DOM 재사용)
   */
  function ensureDocNavBox() {
    let box = document.getElementById('doc-nav-box');
    if (box) {
      box.style.display = '';
      return;
    }
    const contentEl = document.getElementById('content');
    if (!contentEl) return;

    box = document.createElement('nav');
    box.id = 'doc-nav-box';
    box.setAttribute('role', 'navigation');
    box.setAttribute('aria-label', t('docNav.ariaLabel') || '문서 네비게이션');

    const prevEl = document.createElement('a');
    prevEl.id = 'doc-nav-prev';
    prevEl.className = 'doc-nav-item doc-nav-prev';
    prevEl.setAttribute('tabindex', '0');
    prevEl.innerHTML = '<span class="doc-nav-arrow">\u2190</span>' +
      '<span class="doc-nav-label">' + (t('docNav.prev') || '이전') + '</span>' +
      '<span class="doc-nav-title"></span>';

    const nextEl = document.createElement('a');
    nextEl.id = 'doc-nav-next';
    nextEl.className = 'doc-nav-item doc-nav-next';
    nextEl.setAttribute('tabindex', '0');
    nextEl.innerHTML = '<span class="doc-nav-title"></span>' +
      '<span class="doc-nav-label">' + (t('docNav.next') || '다음') + '</span>' +
      '<span class="doc-nav-arrow">\u2192</span>';

    box.appendChild(prevEl);
    box.appendChild(nextEl);
    contentEl.insertAdjacentElement('afterend', box);

    // 클릭/키보드 이벤트 (한 번만 등록)
    [prevEl, nextEl].forEach(function(el) {
      el.addEventListener('click', function() {
        const targetPath = el.dataset.path;
        if (!targetPath) return;
        openResolvedDocument(targetPath);
      });
      el.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          el.click();
        }
      });
    });
  }

  function updateNavItem(el, node, direction) {
    if (!el) return;
    if (!node) {
      el.style.display = 'none';
      el.removeAttribute('data-path');
      return;
    }
    el.style.display = '';
    const name = getDisplayName(node);
    const titleEl = el.querySelector('.doc-nav-title');
    if (titleEl) titleEl.textContent = name;
    const label = direction === 'prev'
      ? (t('docNav.prevAriaLabel', { name: name }) || ('\uC774\uC804: ' + name))
      : (t('docNav.nextAriaLabel', { name: name }) || ('\uB2E4\uC74C: ' + name));
    el.setAttribute('aria-label', label);
    el.dataset.path = node.path;
  }

  /**
   * 뷰어 하단 이전/다음 파일 박스 업데이트 (NFR-26-001: DOM 재사용)
   */
  function updateDocNavBox() {
    const state = window.DocuLight && window.DocuLight.state;
    // 설정에서 비활성화된 경우 숨김
    if (state && state.settings && state.settings.showDocNav === false) {
      var box = document.getElementById('doc-nav-box');
      if (box) box.style.display = 'none';
      return;
    }
    if (!state || !state.sidebarTree || !state.currentFilePath) {
      var box = document.getElementById('doc-nav-box');
      if (box) box.style.display = 'none';
      return;
    }

    var files = collectNavFiles(state.sidebarTree);
    var currentNorm = state.currentFilePath.replace(/\\/g, '/').toLowerCase();
    var idx = files.findIndex(function(f) {
      return f.path.replace(/\\/g, '/').toLowerCase() === currentNorm;
    });
    if (idx < 0) {
      const box = document.getElementById('doc-nav-box');
      if (box) box.style.display = 'none';
      return;
    }

    const prev = idx > 0 ? files[idx - 1] : null;
    const next = idx < files.length - 1 ? files[idx + 1] : null;

    if (!prev && !next) {
      const box = document.getElementById('doc-nav-box');
      if (box) box.style.display = 'none';
      return;
    }

    ensureDocNavBox();
    updateNavItem(document.getElementById('doc-nav-prev'), prev, 'prev');
    updateNavItem(document.getElementById('doc-nav-next'), next, 'next');
  }

  function renderSidebarTree(tree) {
    const container = document.getElementById('sidebar-tree');
    if (!container) return;
    container.innerHTML = '';

    if (tree.treeType === 'link') {
      // 호환: 순수 링크 트리 (안전장치)
      renderTreeNode(tree, container, 0);
    } else {
      // directory / merged: 루트 디렉토리 생략, children만 렌더
      if (tree.children) {
        for (const child of tree.children) {
          renderTreeNode(child, container, 0);
        }
      }
    }
  }

  /**
   * step28 Phase 3: 단일 사이드바 노드 DOM 생성 (재귀 없음, children 제외).
   *   재귀 렌더와 배치 증분 렌더 양쪽에서 재사용.
   *   반환값: { item, toggle } — 호출자가 children 섹션 이어붙이기 용도로 toggle 참조.
   */
  function buildSidebarNodeElement(node, depth) {
    const normalizedNodePath = (node.path || '').replace(/\\/g, '/');
    const normalizedCurrent = (currentFilePath || '').replace(/\\/g, '/');
    const item = document.createElement('div');
    item.className = 'tree-item' + (normalizedNodePath === normalizedCurrent ? ' active' : '') + (!node.exists ? ' not-exists' : '');
    if (node.linked) item.classList.add('linked');
    if (node.isVirtual) item.classList.add('virtual-dir');
    item.dataset.path = normalizedNodePath;
    item.style.paddingLeft = (16 + depth * 16) + 'px';

    // Toggle arrow for nodes with children
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    if (node.children && node.children.length > 0) {
      toggle.textContent = '▼';
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const childrenEl = item.nextElementSibling;
        if (childrenEl && childrenEl.classList.contains('tree-children')) {
          const isHidden = childrenEl.style.display === 'none';
          childrenEl.style.display = isHidden ? 'block' : 'none';
          toggle.textContent = isHidden ? '▼' : '▶';
        }
      });
    } else {
      toggle.textContent = '';
    }
    item.appendChild(toggle);

    // Icon
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    if (node.isDirectory) {
      icon.textContent = node.isVirtual ? '🔗' : '📁';
    } else {
      icon.textContent = node.linked ? '🔗' : '📄';
    }
    item.appendChild(icon);

    // Label
    const label = document.createElement('span');
    label.className = 'tree-label';
    const displayTitle = (node.title === '__external_links__')
      ? (t('sidebar.externalLinks') || '외부 링크')
      : (!node.isDirectory ? getDisplayName(node) : node.title) || t('viewer.untitled');
    label.textContent = displayTitle;
    label.title = node.path || '';
    item.appendChild(label);

    // Click handler - directory toggle or file navigate
    if (node.isDirectory) {
      item.addEventListener('click', () => {
        const childrenEl = item.nextElementSibling;
        if (childrenEl && childrenEl.classList.contains('tree-children')) {
          const isHidden = childrenEl.style.display === 'none';
          childrenEl.style.display = isHidden ? 'block' : 'none';
          toggle.textContent = isHidden ? '▼' : '▶';
        }
      });
    } else if (node.exists !== false && node.path) {
      item.addEventListener('click', () => {
        openResolvedDocument(node.path);
      });
    }

    // Sidebar context menu (FR-22-002)
    if (node.path) {
      item.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        showSidebarContextMenu(ev, node.path, !!node.isDirectory);
      });
    }

    return item;
  }

  function renderTreeNode(node, container, depth) {
    if (!node) return;

    const item = buildSidebarNodeElement(node, depth);
    container.appendChild(item);

    // Children
    if (node.children && node.children.length > 0) {
      const childrenEl = document.createElement('div');
      childrenEl.className = 'tree-children';
      for (const child of node.children) {
        renderTreeNode(child, childrenEl, depth + 1);
      }
      container.appendChild(childrenEl);
    }
  }

  /**
   * step28 Phase 3: 배치 노드 증분 추가 (DocumentFragment로 리페인트 최소화).
   *   배치는 "루트 디렉토리 직계 .md 파일" 단위 (buildDirectoryTree 배치 규칙).
   *   done 이벤트에서 renderSidebarTree가 완성 트리로 재렌더하므로 정렬/링크마킹은 그때 반영.
   */
  function appendPartialNodesToSidebar(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) return;
    const container = document.getElementById('sidebar-tree');
    if (!container) return;
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      if (!n) continue;
      const el = buildSidebarNodeElement(n, 0);
      if (el) frag.appendChild(el);
    }
    container.appendChild(frag);
  }

  function updateSidebarHighlight(currentPath) {
    const container = document.getElementById('sidebar-tree');
    if (!container) return;

    const normalizedPath = (currentPath || '').replace(/\\/g, '/');

    container.querySelectorAll('.tree-item.active').forEach(el => {
      el.classList.remove('active');
    });

    container.querySelectorAll('.tree-item').forEach(el => {
      if (el.dataset.path === normalizedPath) {
        el.classList.add('active');
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        // Expand parent tree-children
        let parent = el.parentElement;
        while (parent) {
          if (parent.classList && parent.classList.contains('tree-children')) {
            parent.style.display = 'block';
            const prevToggle = parent.previousElementSibling?.querySelector('.tree-toggle');
            if (prevToggle) prevToggle.textContent = '▼';
          }
          parent = parent.parentElement;
        }
      }
    });

    currentFilePath = normalizedPath;
  }

  // === TOC Functions ===

  function buildToc() {
    const tocList = document.getElementById('toc-list');
    if (!tocList) return;
    tocList.innerHTML = '';

    const contentEl = document.getElementById('content');
    if (!contentEl) return;

    const headings = contentEl.querySelectorAll('h1, h2, h3, h4');
    if (headings.length === 0) return;

    headings.forEach((heading, idx) => {
      if (!heading.id) {
        heading.id = 'heading-' + idx;
      }

      const level = parseInt(heading.tagName.charAt(1));
      const item = document.createElement('div');
      item.className = 'toc-item';
      item.dataset.level = level;
      item.textContent = heading.textContent;
      item.title = heading.textContent;
      item.addEventListener('click', () => {
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      tocList.appendChild(item);
    });
  }

  function updateTocHighlight() {
    const tocList = document.getElementById('toc-list');
    const viewerContainer = document.getElementById('viewer-container');
    if (!tocList || !viewerContainer) return;

    const headings = document.getElementById('content')?.querySelectorAll('h1, h2, h3, h4');
    if (!headings || headings.length === 0) return;

    const scrollTop = viewerContainer.scrollTop;
    let activeHeading = null;

    for (const heading of headings) {
      if (heading.offsetTop - 80 <= scrollTop) {
        activeHeading = heading;
      }
    }

    tocList.querySelectorAll('.toc-item.active').forEach(el => el.classList.remove('active'));
    if (activeHeading) {
      const items = tocList.querySelectorAll('.toc-item');
      const idx = Array.from(headings).indexOf(activeHeading);
      if (idx >= 0 && items[idx]) {
        items[idx].classList.add('active');
        items[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  function showToc() {
    const toc = document.getElementById('toc-container');
    const tocHandle = document.getElementById('toc-resize-handle');
    if (toc) toc.classList.remove('hidden');
    if (tocHandle) tocHandle.classList.remove('hidden');
    tocVisible = true;
    updateFabStates();
    updateFindPosition();
  }

  function hideToc() {
    const toc = document.getElementById('toc-container');
    const tocHandle = document.getElementById('toc-resize-handle');
    if (toc) toc.classList.add('hidden');
    if (tocHandle) tocHandle.classList.add('hidden');
    tocVisible = false;
    updateFabStates();
    updateFindPosition();
  }

  function toggleToc() {
    if (tocVisible) {
      hideToc();
    } else {
      showToc();
    }
    savePanelPrefs(getCurrentPanelPrefs());
  }

  // === Floating Button State Sync ===

  function updateFabStates() {
    document.getElementById('btn-toggle-sidebar')?.classList.toggle('active', sidebarVisible);
    document.getElementById('btn-toggle-toc')?.classList.toggle('active', tocVisible);
    document.getElementById('btn-toggle-pin')?.classList.toggle('active', isPinned);
  }

  // === Always-on-Top State Sync ===

  cleanups.push(window.doclight.onAlwaysOnTopChanged((data) => {
    isPinned = data.alwaysOnTop;
    updateFabStates();
    if (userToggledPin) {
      userToggledPin = false;
      savePanelPrefs(getCurrentPanelPrefs());
    }
  }));

  // === Panel Visibility Control (from main process) ===

  cleanups.push(window.doclight.onPanelVisibility((data) => {
    if (data.sidebar === false) hideSidebar();
    if (data.sidebar === true) showSidebar();
    if (data.toc === false) hideToc();
    if (data.toc === true) showToc();
  }));

  // === TOC Scroll Highlight (throttled) ===

  let tocThrottleTimer = null;
  const viewerContainer = document.getElementById('viewer-container');
  if (viewerContainer) {
    viewerContainer.addEventListener('scroll', () => {
      if (tocThrottleTimer) return;
      tocThrottleTimer = setTimeout(() => {
        tocThrottleTimer = null;
        updateTocHighlight();
      }, 100);
    });
  }

  // === External Link Handling ===
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href) return;

    e.preventDefault();

    // External URLs
    if (href.startsWith('http://') || href.startsWith('https://')) {
      window.doclight.openExternal(href);
      return;
    }

    // Anchor links - scroll to element
    if (href.startsWith('#')) {
      const targetId = href.substring(1);
      const target = document.getElementById(targetId);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth' });
      }
      return;
    }

    // Local .md links - navigate.
    // The markdown parser percent-encodes hrefs, so the raw attribute is not a
    // usable path. The main process owns decoding and target classification for
    // both window and tab navigation; anything that is not a local markdown
    // document (javascript:, data:, images, other file types) resolves to null
    // and stays blocked.
    window.doclight.resolveLinkTarget(href, activeDocumentPath())
      .then((result) => {
        const targetPath = result && result.filePath;
        if (targetPath) {
          openResolvedDocument(targetPath);
        } else {
          console.warn('[doculight] link is not a local markdown document:', href);
        }
      })
      .catch((err) => {
        console.error('[doculight] link target resolution failed:', href, err);
      });
  });

  // === Keyboard Shortcuts ===
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;

    // Ctrl+W / Cmd+W: Close tab or window
    if (mod && e.key === 'w') {
      e.preventDefault();
      if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.tabManager &&
          window.DocuLight.modules.tabManager.isEnabled()) {
        window.DocuLight.modules.tabManager.closeTab();
      } else {
        window.close();
      }
      return;
    }

    // Ctrl+T / Cmd+T: New blank tab
    if (mod && e.key === 't') {
      e.preventDefault();
      if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.tabManager &&
          window.DocuLight.modules.tabManager.isEnabled() &&
          window.DocuLight.modules.tabManager.createBlankTab) {
        window.DocuLight.modules.tabManager.createBlankTab();
      }
      return;
    }

    // Ctrl+B / Cmd+B: Toggle sidebar
    if (mod && e.key === 'b') {
      e.preventDefault();
      toggleSidebar();
      return;
    }

    // Ctrl+= / Cmd+=: Zoom in
    if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      window.doclight.zoomIn();
      return;
    }

    // Ctrl+- / Cmd+-: Zoom out
    if (mod && e.key === '-') {
      e.preventDefault();
      window.doclight.zoomOut();
      return;
    }

    // Ctrl+0 / Cmd+0: Zoom reset
    if (mod && e.key === '0') {
      e.preventDefault();
      window.doclight.zoomReset();
      return;
    }

    // Ctrl+ArrowLeft or Alt+ArrowLeft: Navigate back
    if ((mod || e.altKey) && e.key === 'ArrowLeft') {
      e.preventDefault();
      window.doclight.navigateBack();
      return;
    }

    // Ctrl+ArrowRight or Alt+ArrowRight: Navigate forward
    if ((mod || e.altKey) && e.key === 'ArrowRight') {
      e.preventDefault();
      window.doclight.navigateForward();
      return;
    }

    // Ctrl+P / Cmd+P: Print (PDF export)
    if (mod && e.key === 'p') {
      e.preventDefault();
      if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.pdfExportUi &&
          window.DocuLight.modules.pdfExportUi.openModal) {
        window.DocuLight.modules.pdfExportUi.openModal();
      }
      return;
    }

    // Ctrl+Shift+C / Cmd+Shift+C: Copy path (FR-22-003)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
      e.preventDefault();
      var pathToCopy = getCopyablePath();
      if (pathToCopy) {
        navigator.clipboard.writeText(pathToCopy).then(function () {
          showViewerToast(t('viewer.pathCopied', { path: pathToCopy }));
        });
      } else if (isMcpDocument) {
        showViewerToast(t('viewer.saveFirstToCopyPath'), 'error');
      }
      return;
    }

    // Ctrl+Shift+S / Cmd+Shift+S: Save As (FR-21-002)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      handleSaveAs();
      return;
    }

    // Ctrl+S / Cmd+S: MCP manual save (FR-22-001)
    if (mod && !e.shiftKey && !e.altKey && e.key === 's') {
      e.preventDefault();
      handleMcpSave();
      return;
    }

    // Ctrl+Alt+S / Cmd+Alt+S: Quick Save (FR-21-003)
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key === 's') {
      e.preventDefault();
      handleQuickSave();
      return;
    }

    // Ctrl+Alt+D / Cmd+Alt+D: Delete auto-saved file (FR-21-001)
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key === 'd') {
      e.preventDefault();
      handleDeleteAutoSaved();
      return;
    }

    // Ctrl+F: Find in page
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openFindBar();
      return;
    }

    // Ctrl+Shift+F: sidebar search
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      // Show sidebar if hidden
      const sidebar = document.getElementById('sidebar-container');
      if (sidebar && sidebar.classList.contains('hidden')) {
        showSidebar();
      }
      // Enter search mode
      if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.sidebarSearch) {
        window.DocuLight.modules.sidebarSearch.enterSearchMode();
      }
      return;
    }

    // Escape key priority chain
    if (e.key === 'Escape') {
      // Priority 1: PDF modal
      if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.pdfExportUi &&
          window.DocuLight.modules.pdfExportUi.isActive()) {
        window.DocuLight.modules.pdfExportUi.closeModal();
        return;
      }
      // Priority 2: Sidebar search
      if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.sidebarSearch &&
          window.DocuLight.modules.sidebarSearch.isActive()) {
        window.DocuLight.modules.sidebarSearch.exitSearchMode();
        return;
      }
      // Priority 3: Find-in-page bar
      if (findBarVisible) {
        closeFindBar();
        return;
      }
      // Priority 4: Text selection clear
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) {
        sel.removeAllRanges();
        return;
      }
      // Priority 5: Always-on-top release
      userToggledPin = true;
      window.doclight.releaseAlwaysOnTop();
      return;
    }
  });

  // === Resize Handle (Sidebar) ===
  const resizeHandle = document.getElementById('resize-handle');
  if (resizeHandle) {
    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      const sidebar = document.getElementById('sidebar-container');
      startWidth = sidebar ? sidebar.offsetWidth : 260;
      resizeHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const sidebar = document.getElementById('sidebar-container');
      if (!sidebar) return;

      const diff = e.clientX - startX;
      let newWidth = startWidth + diff;
      newWidth = Math.max(150, Math.min(newWidth, window.innerWidth * 0.5));

      requestAnimationFrame(() => {
        sidebar.style.width = newWidth + 'px';
      });
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      resizeHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      savePanelPrefs(getCurrentPanelPrefs());
    });
  }

  // === Resize Handle (TOC) ===
  const tocResizeHandle = document.getElementById('toc-resize-handle');
  if (tocResizeHandle) {
    let tocDragging = false;
    let tocStartX = 0;
    let tocStartWidth = 0;

    tocResizeHandle.addEventListener('mousedown', (e) => {
      tocDragging = true;
      tocStartX = e.clientX;
      const toc = document.getElementById('toc-container');
      tocStartWidth = toc ? toc.offsetWidth : 220;
      tocResizeHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!tocDragging) return;
      const toc = document.getElementById('toc-container');
      if (!toc) return;

      const diff = tocStartX - e.clientX;
      let newWidth = tocStartWidth + diff;
      newWidth = Math.max(150, Math.min(newWidth, window.innerWidth * 0.4));

      requestAnimationFrame(() => {
        toc.style.width = newWidth + 'px';
        updateFindPosition();
      });
    });

    document.addEventListener('mouseup', () => {
      if (!tocDragging) return;
      tocDragging = false;
      tocResizeHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      savePanelPrefs(getCurrentPanelPrefs());
    });
  }

  // === Sidebar Name Toggle ===
  document.addEventListener('DOMContentLoaded', () => {
    const nameToggleBtn = document.getElementById('btn-sidebar-name-toggle');
    if (nameToggleBtn) {
      nameToggleBtn.addEventListener('click', () => {
        const state = window.DocuLight.state;
        // 검색 모드 중이면 무시
        const searchModule = window.DocuLight.modules && window.DocuLight.modules.sidebarSearch;
        if (searchModule && typeof searchModule.isActive === 'function' && searchModule.isActive()) return;

        state.showFrontmatterName = !state.showFrontmatterName;
        nameToggleBtn.setAttribute('aria-pressed', String(state.showFrontmatterName));
        nameToggleBtn.classList.toggle('active', state.showFrontmatterName);

        // 사이드바 재렌더링
        if (state.sidebarTree) {
          try {
            renderSidebarTree(state.sidebarTree);
          } catch (e) {
            console.error('[NameToggle] 재렌더링 오류:', e);
          }
        }
        // 하단 박스 표시명 업데이트 (Phase 3에서 정의됨, 가드 필요)
        if (typeof updateDocNavBox === 'function') updateDocNavBox();
      });

      // 검색 모드 변경 이벤트 구독 (doculight:searchmode)
      document.addEventListener('doculight:searchmode', (e) => {
        nameToggleBtn.disabled = e.detail.active;
      });
    }
  });

  // === Floating Button Handlers ===
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-toggle-sidebar')?.addEventListener('click', () => {
      toggleSidebar();
    });

    document.getElementById('btn-toggle-toc')?.addEventListener('click', () => {
      toggleToc();
    });

    document.getElementById('btn-toggle-pin')?.addEventListener('click', () => {
      userToggledPin = true;
      window.doclight.toggleAlwaysOnTop();
    });
  });

  // === Window Ready ===
  document.addEventListener('DOMContentLoaded', async () => {
    // === Module System Initialization ===
    window.DocuLight = {
      state: {
        currentFilePath: null,
        imageBasePath: null,
        sidebarTree: null,
        tabs: [],
        activeTabIndex: 0,
        navigationTrail: [],
        settings: {},
        platform: null,
        showFrontmatterName: false
      },
      dom: {
        content: document.getElementById('content'),
        sidebarTree: document.getElementById('sidebar-tree'),
        viewerContainer: document.getElementById('viewer-container'),
        tabBar: document.getElementById('tab-bar')
      },
      fn: {
        renderMarkdown: renderMarkdown,
        renderBreadcrumbTrail: renderBreadcrumbTrail,
        renderSidebarTree: renderSidebarTree,
        updateSidebarHighlight: updateSidebarHighlight,
        scrollToTextMatch: scrollToTextMatch,
        navigateTo: function(href) { window.doclight.navigateTo(href); },
        t: t
      },
      modules: {}
    };

    // Register and initialize modules
    if (window.__docuLightModules) {
      for (var i = 0; i < window.__docuLightModules.length; i++) {
        var mod = window.__docuLightModules[i];
        window.DocuLight.modules[mod.name] = mod;
        mod.init();
      }
    }

    await initI18n();

    // Metabox toggle (collapsible, Step 20)
    const metaboxToggle = document.querySelector('.metabox-toggle');
    if (metaboxToggle) {
      metaboxToggle.addEventListener('click', () => {
        const metabox = document.getElementById('frontmatter-metabox');
        if (metabox) {
          metabox.classList.toggle('collapsed');
          const isCollapsed = metabox.classList.contains('collapsed');
          metaboxToggle.setAttribute('aria-expanded', String(!isCollapsed));
        }
      });
    }

    const prefs = await loadPanelPrefs();
    if (prefs) {
      savedPrefs = prefs;
      if (prefs.sidebarWidth) {
        const sidebar = document.getElementById('sidebar-container');
        if (sidebar) sidebar.style.width = prefs.sidebarWidth + 'px';
      }
      if (prefs.tocWidth) {
        const toc = document.getElementById('toc-container');
        if (toc) toc.style.width = prefs.tocWidth + 'px';
      }
      if (prefs.tocVisible) showToc();
      if (prefs.alwaysOnTop) window.doclight.setAlwaysOnTop(true);
    }
    window.doclight.notifyReady();
  });

  // === Cleanup on unload ===
  window.addEventListener('beforeunload', () => {
    disposeInlineMediaController();
    cleanups.forEach(fn => { if (typeof fn === 'function') fn(); });
  });

})();
