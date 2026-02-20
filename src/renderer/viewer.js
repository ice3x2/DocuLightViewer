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
        }
      } catch (e) { /* silently ignore unreadable images */ }
    }));
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

    // Step 3b: Convert local file:// image URLs to data URIs.
    // Electron's sandbox prevents the renderer from loading file:// resources
    // that reside outside the app directory (Chromium same-origin policy).
    // We resolve each image via IPC so the main process reads and returns
    // the binary as a base64 data URL, which Chromium accepts unconditionally.
    await resolveLocalImages(contentEl);

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
    const isSameFile = currentFilePath && data.filePath && currentFilePath === data.filePath;
    const viewerContainerEl = document.getElementById('viewer-container');
    const savedScrollTop = isSameFile && viewerContainerEl ? viewerContainerEl.scrollTop : 0;

    currentFilePath = data.filePath || null;
    if (window.DocuLight) {
      window.DocuLight.state.currentFilePath = data.filePath || null;
      window.DocuLight.state.imageBasePath = data.imageBasePath || null;
      if (data.platform) window.DocuLight.state.platform = data.platform;
    }
    renderMarkdown(data.markdown);

    // PDF mode: hide UI elements and signal completion
    if (data.pdfMode) {
      document.body.classList.add('pdf-mode');
      // Hide non-content UI
      const floatingBtns = document.getElementById('floating-buttons');
      const sidebarContainer = document.getElementById('sidebar-container');
      const tocContainer = document.getElementById('toc-container');
      const resizeHandle = document.getElementById('resize-handle');
      const tabBar = document.getElementById('tab-bar');
      if (floatingBtns) floatingBtns.style.display = 'none';
      if (sidebarContainer) sidebarContainer.style.display = 'none';
      if (tocContainer) tocContainer.style.display = 'none';
      if (resizeHandle) resizeHandle.style.display = 'none';
      if (tabBar) tabBar.style.display = 'none';

      // Wait for Mermaid rendering then signal completion
      setTimeout(() => {
        if (window.doclight && window.doclight.pdfRenderComplete) {
          window.doclight.pdfRenderComplete();
        }
      }, 500);
    }

    // Restore scroll position for same-file refresh (auto-refresh)
    if (isSameFile && viewerContainerEl) {
      viewerContainerEl.scrollTop = savedScrollTop;
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
      if (window.DocuLight) {
        window.DocuLight.state.sidebarTree = data.tree;
      }
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

  // === Context Menu ===
  function showContextMenu(e) {
    // Remove any existing context menu
    const old = document.querySelector('.ctx-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';

    const tabMod = window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.tabManager;
    const tabsEnabled = tabMod && tabMod.isEnabled();

    // Empty page: no file loaded in current context
    const isEmpty = !currentFilePath;

    // Check if right-click target is inside a code block
    const codeBlock = !isEmpty && e.target.closest('pre');

    // New Tab (only if tabs enabled)
    if (tabsEnabled) {
      const newTabItem = document.createElement('div');
      newTabItem.className = 'ctx-menu-item' + (isEmpty ? ' disabled' : '');
      newTabItem.innerHTML = t('viewer.newTab').replace(/\s*\(.*\)$/, '') + '<span class="ctx-menu-shortcut">Ctrl+T</span>';
      if (!isEmpty) {
        newTabItem.addEventListener('click', () => {
          menu.remove();
          if (tabMod.createBlankTab) tabMod.createBlankTab();
        });
      }
      menu.appendChild(newTabItem);
    }

    // Select All
    const selectAllItem = document.createElement('div');
    selectAllItem.className = 'ctx-menu-item' + (isEmpty ? ' disabled' : '');
    selectAllItem.innerHTML = t('viewer.selectAll') + '<span class="ctx-menu-shortcut">Ctrl+A</span>';
    if (!isEmpty) {
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
    }
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

    // Separator
    const sep = document.createElement('div');
    sep.className = 'ctx-menu-sep';
    menu.appendChild(sep);

    // Print (PDF export)
    const printItem = document.createElement('div');
    printItem.className = 'ctx-menu-item' + (isEmpty ? ' disabled' : '');
    printItem.innerHTML = t('viewer.exportPdf') + '<span class="ctx-menu-shortcut">Ctrl+P</span>';
    if (!isEmpty) {
      printItem.addEventListener('click', () => {
        menu.remove();
        if (window.DocuLight && window.DocuLight.modules && window.DocuLight.modules.pdfExportUi &&
            window.DocuLight.modules.pdfExportUi.openModal) {
          window.DocuLight.modules.pdfExportUi.openModal();
        }
      });
    }
    menu.appendChild(printItem);

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

    document.body.appendChild(menu);

    // Position: ensure menu stays within viewport
    const rect = menu.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Close on click outside or Escape
    function closeMenu(ev) {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', closeMenu);
        document.removeEventListener('keydown', escHandler);
      }
    }
    function escHandler(ev) {
      if (ev.key === 'Escape') {
        menu.remove();
        document.removeEventListener('mousedown', closeMenu);
        document.removeEventListener('keydown', escHandler);
      }
    }
    setTimeout(() => {
      document.addEventListener('mousedown', closeMenu);
      document.addEventListener('keydown', escHandler);
    }, 0);
  }

  // Attach context menu to viewer area
  document.addEventListener('contextmenu', (e) => {
    const viewerContainer = document.getElementById('viewer-container');
    if (viewerContainer && viewerContainer.contains(e.target)) {
      e.preventDefault();
      showContextMenu(e);
    }
  });

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

    const normalizedNodePath = (node.path || '').replace(/\\/g, '/');
    const normalizedCurrent = (currentFilePath || '').replace(/\\/g, '/');
    const item = document.createElement('div');
    item.className = 'tree-item' + (normalizedNodePath === normalizedCurrent ? ' active' : '') + (!node.exists ? ' not-exists' : '');
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
        if (window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.navigateToForTab) {
          window.DocuLight.fn.navigateToForTab(node.path);
        } else {
          window.doclight.navigateTo(node.path);
        }
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
      if (window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.navigateToForTab) {
        window.DocuLight.fn.navigateToForTab(href);
      } else {
        window.doclight.navigateTo(href);
      }
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
      // Priority 3: Always-on-top release
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
    // === Module System Initialization ===
    window.DocuLight = {
      state: {
        currentFilePath: null,
        imageBasePath: null,
        sidebarTree: null,
        tabs: [],
        activeTabIndex: 0,
        settings: {},
        platform: null
      },
      dom: {
        content: document.getElementById('content'),
        sidebarTree: document.getElementById('sidebar-tree'),
        viewerContainer: document.getElementById('viewer-container'),
        tabBar: document.getElementById('tab-bar')
      },
      fn: {
        renderMarkdown: renderMarkdown,
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
