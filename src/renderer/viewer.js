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

  // === Initialize Mermaid ===
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default'
    });
  }

  // === Configure marked ===
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      gfm: true,
      breaks: true
    });
  }

  // === Rendering Pipeline ===
  async function renderMarkdown(markdown) {
    const contentEl = document.getElementById('content');
    if (!contentEl) return;

    // Performance warning for large documents
    const size = new Blob([markdown]).size;
    if (size > 5 * 1024 * 1024) {
      showPerformanceWarning(size);
    }

    // Step 1: Parse markdown to HTML
    const rawHtml = marked.parse(markdown);

    // Step 2: Sanitize with DOMPurify
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      ADD_TAGS: ['details', 'summary'],
      ADD_ATTR: ['open']
    });

    // Step 3: Insert into DOM
    contentEl.innerHTML = cleanHtml;

    // Step 4: Render Mermaid diagrams
    await renderMermaidDiagrams(contentEl);

    // Step 5: Highlight code blocks
    if (typeof hljs !== 'undefined') {
      contentEl.querySelectorAll('pre code').forEach(block => {
        hljs.highlightElement(block);
      });
    }

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
        const { svg } = await mermaid.render(id, block.textContent.trim());
        const div = document.createElement('div');
        div.className = 'mermaid';
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

  // === IPC Handlers ===

  // render-markdown: initial content when window opens
  cleanups.push(window.doclight.onRenderMarkdown((data) => {
    currentFilePath = data.filePath || null;
    renderMarkdown(data.markdown);
  }));

  // update-markdown: content update for existing window
  cleanups.push(window.doclight.onUpdateMarkdown((data) => {
    currentFilePath = data.filePath || null;
    const contentEl = document.getElementById('content');
    if (contentEl) contentEl.scrollTop = 0;
    const viewerContainer = document.getElementById('viewer-container');
    if (viewerContainer) viewerContainer.scrollTop = 0;
    renderMarkdown(data.markdown);
  }));

  // sidebar-tree: tree data for sidebar
  cleanups.push(window.doclight.onSidebarTree((data) => {
    if (data.tree && data.tree.children && data.tree.children.length > 0) {
      renderSidebarTree(data.tree);
      if (!savedPrefs || savedPrefs.sidebarVisible !== false) {
        showSidebar();
      }
    } else {
      hideSidebar();
    }
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
  }));

  // === Empty Window Handler ===
  cleanups.push(window.doclight.onEmptyWindow(() => {
    const contentEl = document.getElementById('content');
    if (!contentEl) return;
    contentEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📄</div>
        <div class="empty-state-title">DocuLight</div>
        <div class="empty-state-text">${t('viewer.dropHint')}</div>
        <div class="empty-state-hint">${t('viewer.dropFileType')}</div>
      </div>
    `;
  }));

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
      // Use webUtils.getPathForFile via preload (sandbox-safe)
      const filePath = window.doclight.getFilePath(mdFile);
      if (filePath) {
        window.doclight.fileDropped(filePath);
      }
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
    savePanelPrefs({ sidebarVisible, tocVisible, alwaysOnTop: isPinned });
  }

  function renderSidebarTree(tree) {
    const container = document.getElementById('sidebar-tree');
    if (!container) return;
    container.innerHTML = '';
    // 루트 디렉토리 자체 생략, 하위 항목만 표시
    if (tree.children) {
      for (const child of tree.children) {
        renderTreeNode(child, container, 0);
      }
    }
  }

  function renderTreeNode(node, container, depth) {
    if (!node) return;

    const item = document.createElement('div');
    item.className = 'tree-item' + (node.path === currentFilePath ? ' active' : '') + (!node.exists ? ' not-exists' : '');
    item.dataset.path = node.path || '';
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
    icon.textContent = node.isDirectory ? '📁' : '📄';
    item.appendChild(icon);

    // Label
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.title || t('viewer.untitled');
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
        window.doclight.navigateTo(node.path);
      });
    }

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

  function updateSidebarHighlight(currentPath) {
    const container = document.getElementById('sidebar-tree');
    if (!container) return;

    container.querySelectorAll('.tree-item.active').forEach(el => {
      el.classList.remove('active');
    });

    container.querySelectorAll('.tree-item').forEach(el => {
      if (el.dataset.path === currentPath) {
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

    currentFilePath = currentPath;
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
    if (toc) toc.classList.remove('hidden');
    tocVisible = true;
    updateFabStates();
  }

  function hideToc() {
    const toc = document.getElementById('toc-container');
    if (toc) toc.classList.add('hidden');
    tocVisible = false;
    updateFabStates();
  }

  function toggleToc() {
    if (tocVisible) {
      hideToc();
    } else {
      showToc();
    }
    savePanelPrefs({ sidebarVisible, tocVisible, alwaysOnTop: isPinned });
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
      savePanelPrefs({ sidebarVisible, tocVisible, alwaysOnTop: isPinned });
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

    // Local .md links - navigate
    if (href.endsWith('.md') || (!href.startsWith('#') && !href.includes('://'))) {
      // Resolve relative path (basic handling - full resolution happens in main process)
      window.doclight.navigateTo(href);
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

    // Block everything else (javascript:, data:, etc.)
  });

  // === Keyboard Shortcuts ===
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;

    // Ctrl+W / Cmd+W: Close window
    if (mod && e.key === 'w') {
      e.preventDefault();
      window.close();
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

    // Escape: Release always-on-top
    if (e.key === 'Escape') {
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
    });
  }

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
    await initI18n();
    const prefs = await loadPanelPrefs();
    if (prefs) {
      savedPrefs = prefs;
      if (prefs.tocVisible) showToc();
      if (prefs.alwaysOnTop) window.doclight.setAlwaysOnTop(true);
    }
    window.doclight.notifyReady();
  });

  // === Cleanup on unload ===
  window.addEventListener('beforeunload', () => {
    cleanups.forEach(fn => { if (typeof fn === 'function') fn(); });
  });

})();
