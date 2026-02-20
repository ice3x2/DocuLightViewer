// src/renderer/sidebar-search.js — Sidebar content search module
(function () {
  'use strict';

  let searchContainer = null;
  let searchInput = null;
  let searchClearBtn = null;
  let searchToggleBtn = null;
  let sidebarTreeEl = null;
  let isSearchMode = false;
  let currentTree = null;
  let filterTimer = null;
  let lastFilteredValue = '';
  let currentAbortId = 0;

  function init() {
    searchToggleBtn = document.getElementById('btn-sidebar-search');
    searchContainer = document.getElementById('sidebar-search-container');
    sidebarTreeEl = document.getElementById('sidebar-tree');

    if (!searchContainer) return;

    searchInput = searchContainer.querySelector('.sidebar-search-input');
    searchClearBtn = searchContainer.querySelector('.sidebar-search-clear');

    if (!searchToggleBtn || !searchInput) return;

    // Toggle search mode on button click
    searchToggleBtn.addEventListener('click', () => {
      if (isSearchMode) {
        exitSearchMode();
      } else {
        enterSearchMode();
      }
    });

    // Debounced search that handles both direct input and IME composition
    function scheduleSearch() {
      clearTimeout(filterTimer);
      var val = searchInput.value.trim();
      // Short queries use title filter (fast, no debounce needed beyond 80ms)
      var delay = val.length < 2 ? 80 : 300;
      filterTimer = setTimeout(() => {
        if (val !== lastFilteredValue) {
          lastFilteredValue = val;
          handleSearch(val);
        }
      }, delay);
    }

    // Direct input (non-IME typing)
    searchInput.addEventListener('input', scheduleSearch);

    // IME composition events (Korean, Japanese, Chinese)
    searchInput.addEventListener('compositionupdate', scheduleSearch);
    searchInput.addEventListener('compositionend', function () {
      // Immediately search on composition end
      clearTimeout(filterTimer);
      var val = searchInput.value.trim();
      lastFilteredValue = val;
      handleSearch(val);
    });

    // Clear button
    if (searchClearBtn) {
      searchClearBtn.addEventListener('click', () => {
        exitSearchMode();
      });
    }
  }

  function enterSearchMode() {
    if (!searchContainer || !sidebarTreeEl || !searchInput) return;
    isSearchMode = true;
    lastFilteredValue = '';
    // Cache current tree data from DocuLight state
    if (window.DocuLight && window.DocuLight.state) {
      currentTree = window.DocuLight.state.sidebarTree || null;
    }
    searchContainer.classList.remove('hidden');
    if (searchToggleBtn) {
      searchToggleBtn.setAttribute('aria-expanded', 'true');
    }
    searchInput.value = '';
    searchInput.focus();
  }

  function exitSearchMode() {
    if (!searchContainer || !sidebarTreeEl) return;
    isSearchMode = false;
    clearTimeout(filterTimer);
    lastFilteredValue = '';
    currentAbortId++;
    searchContainer.classList.add('hidden');
    if (searchToggleBtn) {
      searchToggleBtn.setAttribute('aria-expanded', 'false');
    }
    // Re-render tree from data (preserves event listeners)
    if (currentTree && window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.renderSidebarTree) {
      window.DocuLight.fn.renderSidebarTree(currentTree);
    }
    if (searchInput) {
      searchInput.value = '';
    }
  }

  /**
   * Route search: 0-1 chars → title filter, 2+ chars → content search via IPC.
   */
  function handleSearch(query) {
    if (!sidebarTreeEl) return;

    if (!query) {
      // Show full tree when query is empty but stay in search mode
      if (currentTree && window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.renderSidebarTree) {
        window.DocuLight.fn.renderSidebarTree(currentTree);
      }
      return;
    }

    if (query.length < 2) {
      // Fallback: title-only filter for short queries
      filterSidebarTreeByTitle(query);
      return;
    }

    // Content search via IPC
    searchContent(query);
  }

  /**
   * Title-only filter (original behavior for 0-1 char queries).
   */
  function filterSidebarTreeByTitle(query) {
    if (!sidebarTreeEl) return;

    // Collect all files from tree
    const files = [];
    if (currentTree) {
      collectAllFiles(currentTree, '', files);
    }

    // Filter by query (case-insensitive partial match)
    const lowerQuery = query.toLowerCase();
    const matches = files.filter(f => f.title.toLowerCase().includes(lowerQuery));

    // Render results
    sidebarTreeEl.innerHTML = '';

    if (matches.length === 0) {
      showNoResults();
      return;
    }

    for (const file of matches) {
      const item = createFileResultItem(file.title, file.path, file.parentDir, query);
      sidebarTreeEl.appendChild(item);
    }
  }

  /**
   * Content search via IPC to main process.
   */
  async function searchContent(query) {
    var rootDir = getRootDir();
    if (!rootDir) {
      filterSidebarTreeByTitle(query);
      return;
    }

    var abortId = ++currentAbortId;

    // Show loading indicator
    showLoading();

    try {
      var result = await window.doclight.searchContent(query, rootDir);

      // Check if this search is still current
      if (abortId !== currentAbortId) return;

      if (!result || !result.results || result.results.length === 0) {
        showNoResults();
        return;
      }

      renderContentResults(result.results, query);
    } catch (err) {
      if (abortId !== currentAbortId) return;
      console.error('[sidebar-search] content search error:', err);
      showNoResults();
    }
  }

  /**
   * Get root directory from sidebar tree state.
   */
  function getRootDir() {
    if (!currentTree || !currentTree.path) return null;
    // tree.path is the root directory path
    // For directory trees, path is the directory itself
    var treePath = currentTree.path;
    // Normalize: remove trailing slashes
    if (treePath.endsWith('/') || treePath.endsWith('\\')) {
      treePath = treePath.slice(0, -1);
    }
    return treePath;
  }

  /**
   * Render content search results with file titles and snippets.
   */
  function renderContentResults(results, query) {
    if (!sidebarTreeEl) return;
    sidebarTreeEl.innerHTML = '';

    for (const file of results) {
      var fileGroup = document.createElement('div');
      fileGroup.className = 'search-result-item';

      // File title (clickable)
      var titleEl = document.createElement('div');
      titleEl.className = 'search-result-title';
      titleEl.innerHTML = highlightMatch(file.title || file.fileName, query);
      titleEl.style.cursor = 'pointer';
      var filePath = file.filePath;
      titleEl.addEventListener('click', function () {
        navigateToFile(filePath, query);
      });
      fileGroup.appendChild(titleEl);

      // Snippets
      var occurrenceIdx = 0;
      for (const match of file.matches) {
        if (match.priority === 0) continue; // Skip filename-only matches (no snippet to show)

        var snippetEl = document.createElement('div');
        snippetEl.className = 'search-result-snippet';
        snippetEl.style.cursor = 'pointer';

        // Line number
        var lineNumEl = document.createElement('span');
        lineNumEl.className = 'search-result-line-num';
        lineNumEl.textContent = 'L' + match.line;
        snippetEl.appendChild(lineNumEl);

        // Snippet text with highlight
        var snippetTextEl = document.createElement('span');
        snippetTextEl.className = 'search-result-snippet-text';
        snippetTextEl.innerHTML = highlightMatch(match.snippet, query);
        snippetEl.appendChild(snippetTextEl);

        (function (fp, q, idx) {
          snippetEl.addEventListener('click', function () {
            navigateToFile(fp, q, idx);
          });
        })(filePath, query, occurrenceIdx);

        occurrenceIdx++;
        fileGroup.appendChild(snippetEl);
      }

      sidebarTreeEl.appendChild(fileGroup);
    }
  }

  function showLoading() {
    if (!sidebarTreeEl) return;
    sidebarTreeEl.innerHTML = '';
    var loadingEl = document.createElement('div');
    loadingEl.className = 'search-loading';
    var t = window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.t;
    loadingEl.textContent = t ? t('viewer.searchLoading') : 'Searching...';
    sidebarTreeEl.appendChild(loadingEl);
  }

  function showNoResults() {
    if (!sidebarTreeEl) return;
    sidebarTreeEl.innerHTML = '';
    var noResults = document.createElement('div');
    noResults.className = 'search-no-results';
    var t = window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.t;
    noResults.textContent = t ? t('viewer.searchNoResults') : 'No results found';
    sidebarTreeEl.appendChild(noResults);
  }

  function createFileResultItem(title, filePath, parentDir, query) {
    var item = document.createElement('div');
    item.className = 'search-result-item';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');

    // Highlight matching portion in filename
    var titleSpan = document.createElement('span');
    titleSpan.className = 'search-result-title';
    titleSpan.innerHTML = highlightMatch(title, query);
    item.appendChild(titleSpan);

    // Show parent directory as subtext
    if (parentDir) {
      var dirSpan = document.createElement('span');
      dirSpan.className = 'search-result-dir';
      dirSpan.textContent = parentDir;
      item.appendChild(dirSpan);
    }

    // Click handler
    item.addEventListener('click', function () {
      navigateToFile(filePath);
    });
    item.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigateToFile(filePath);
      }
    });

    return item;
  }

  function collectAllFiles(node, parentDir, result) {
    if (!node) return;

    var isFile = !node.children || node.children.length === 0;
    if (isFile && node.title && node.path) {
      result.push({
        title: node.title,
        path: node.path,
        parentDir: parentDir || ''
      });
    }

    if (node.children) {
      for (var i = 0; i < node.children.length; i++) {
        collectAllFiles(node.children[i], node.title || parentDir, result);
      }
    }
  }

  function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    var lowerText = text.toLowerCase();
    var lowerQuery = query.toLowerCase();
    var idx = lowerText.indexOf(lowerQuery);
    if (idx < 0) return escapeHtml(text);

    var before = text.substring(0, idx);
    var match = text.substring(idx, idx + query.length);
    var after = text.substring(idx + query.length);
    return escapeHtml(before) + '<mark>' + escapeHtml(match) + '</mark>' + escapeHtml(after);
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function navigateToFile(filePath, scrollQuery, occurrenceIndex) {
    // Store pending scroll target so viewer.js can scroll after rendering
    if (scrollQuery && window.DocuLight && window.DocuLight.state) {
      window.DocuLight.state.pendingSearchScroll = {
        query: scrollQuery,
        occurrenceIndex: occurrenceIndex || 0
      };
    }
    // Use tab-aware navigation if available (late binding)
    if (window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.navigateToForTab) {
      window.DocuLight.fn.navigateToForTab(filePath);
    } else if (window.doclight && window.doclight.navigateTo) {
      window.doclight.navigateTo(filePath);
    }
  }

  // Check if search mode is active (for Escape key priority)
  function isActive() {
    return isSearchMode;
  }

  // Register module
  if (!window.__docuLightModules) window.__docuLightModules = [];
  window.__docuLightModules.push({
    name: 'sidebarSearch',
    init: init,
    enterSearchMode: enterSearchMode,
    exitSearchMode: exitSearchMode,
    isActive: isActive
  });
})();
