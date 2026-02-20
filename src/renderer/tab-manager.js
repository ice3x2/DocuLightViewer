// src/renderer/tab-manager.js — Tab-based multi-document view module
(function () {
  'use strict';

  const tabs = [];
  let activeTabIndex = -1;
  const MAX_TABS = 20;
  let enableTabs = false;
  let tabBarEl = null;
  let toastTimer = null;
  let tabBarEverShown = false;

  function init() {
    if (window.doclight && window.doclight.getSettings) {
      window.doclight.getSettings().then(settings => {
        enableTabs = settings.enableTabs || false;
        if (enableTabs) {
          setupTabBar();
        }
      });
    }
  }

  function setupTabBar() {
    tabBarEl = document.getElementById('tab-bar');
    if (!tabBarEl) return;

    if (window.DocuLight) {
      window.DocuLight.state.tabs = tabs;
    }

    // Wrap navigateTo for tab interception
    const originalNavigateTo = window.doclight ? window.doclight.navigateTo : null;
    if (window.DocuLight && window.DocuLight.fn) {
      window.DocuLight.fn.navigateToForTab = function (href) {
        if (!enableTabs) {
          if (originalNavigateTo) originalNavigateTo(href);
          return;
        }

        // Resolve relative paths against current file's directory
        var resolvedHref = href;
        if (href && !isAbsolutePath(href)) {
          var currentFp = window.DocuLight.state.currentFilePath;
          if (currentFp) {
            var dir = currentFp.replace(/\\/g, '/');
            dir = dir.substring(0, dir.lastIndexOf('/'));
            // Normalize ./prefix
            var rel = href.replace(/\\/g, '/');
            if (rel.startsWith('./')) rel = rel.substring(2);
            resolvedHref = dir + '/' + rel;
          } else {
            // No current file context — fallback to main process navigation
            if (originalNavigateTo) originalNavigateTo(href);
            return;
          }
        }

        var normalizedHref = resolvedHref.replace(/\\/g, '/');
        var existing = tabs.findIndex(function (t) {
          return t.filePath === normalizedHref || t.filePath === resolvedHref;
        });
        if (existing >= 0) {
          if (existing === activeTabIndex) {
            // Same tab — consume pendingSearchScroll if set
            consumePendingSearchScroll();
          } else {
            switchTab(existing);
          }
          return;
        }
        if (tabs.length >= MAX_TABS) {
          showMaxTabsToast();
          return;
        }
        if (window.doclight && window.doclight.readFileForTab) {
          window.doclight.readFileForTab(resolvedHref).then(function (data) {
            if (data.error) {
              console.error('[doculight] tab read error:', data.error);
              // Fallback to main process navigation
              if (originalNavigateTo) originalNavigateTo(href);
              return;
            }
            createTab(data);
          });
        }
      };
    }

    // [+] button handler — open a blank new tab
    var addBtn = tabBarEl.querySelector('.tab-add');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        if (tabs.length >= MAX_TABS) {
          showMaxTabsToast();
          return;
        }
        createBlankTab();
      });
    }

    createInitialTab();
    updateTabBarVisibility();
  }

  function createInitialTab() {
    var state = window.DocuLight ? window.DocuLight.state : {};
    var contentEl = document.getElementById('content');
    var viewerContainer = document.getElementById('viewer-container');

    if (!contentEl) return;

    var tab = {
      id: generateId(),
      title: document.title || 'DocuLight',
      filePath: state.currentFilePath || null,
      renderedHtml: contentEl.innerHTML,
      scrollTop: viewerContainer ? viewerContainer.scrollTop : 0,
      sidebarTree: state.sidebarTree || null,
      currentSidebarPath: state.currentFilePath || null,
      cachedAt: Date.now()
    };

    tabs.push(tab);
    activeTabIndex = 0;
    renderTabBar();
  }

  function createBlankTab() {
    saveCurrentTabState();

    var contentEl = document.getElementById('content');
    var viewerContainer = document.getElementById('viewer-container');

    if (window.DocuLight && window.DocuLight.state) {
      window.DocuLight.state.currentFilePath = null;
      window.DocuLight.state.imageBasePath = null;
    }

    var tFn = window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.t;
    var blankTitle = tFn ? tFn('viewer.newTab').replace(/\s*\(.*\)$/, '') : 'New Tab';

    var dropHint = tFn ? tFn('viewer.dropHint') : 'Drop a Markdown file here to view';
    var dropFileType = tFn ? tFn('viewer.dropFileType') : 'Supports .md files';
    var emptyHtml =
      '<div class="empty-state">' +
        '<div class="empty-state-icon">📄</div>' +
        '<div class="empty-state-title">DocuLight</div>' +
        '<div class="empty-state-text">' + dropHint + '</div>' +
        '<div class="empty-state-hint">' + dropFileType + '</div>' +
      '</div>';

    if (contentEl) contentEl.innerHTML = emptyHtml;

    var tab = {
      id: generateId(),
      title: blankTitle,
      filePath: null,
      renderedHtml: emptyHtml,
      scrollTop: 0,
      sidebarTree: null,
      currentSidebarPath: null,
      cachedAt: Date.now()
    };

    tabs.push(tab);
    activeTabIndex = tabs.length - 1;

    renderTabBar();
    updateTabBarVisibility();

    if (viewerContainer) viewerContainer.scrollTop = 0;
  }

  function createTab(data) {
    saveCurrentTabState();

    var contentEl = document.getElementById('content');
    var viewerContainer = document.getElementById('viewer-container');

    if (window.DocuLight && window.DocuLight.state) {
      window.DocuLight.state.currentFilePath = data.filePath;
      window.DocuLight.state.imageBasePath = data.imageBasePath || null;
      if (data.platform) window.DocuLight.state.platform = data.platform;
    }

    var renderFn = window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.renderMarkdown;
    if (renderFn) {
      renderFn(data.markdown);
    }

    var tab = {
      id: generateId(),
      title: data.title || 'Untitled',
      filePath: data.filePath || null,
      renderedHtml: contentEl ? contentEl.innerHTML : '',
      scrollTop: 0,
      sidebarTree: data.sidebarTree || null,
      currentSidebarPath: data.filePath || null,
      cachedAt: Date.now()
    };

    tabs.push(tab);
    activeTabIndex = tabs.length - 1;

    if (data.sidebarTree && window.DocuLight && window.DocuLight.state) {
      window.DocuLight.state.sidebarTree = data.sidebarTree;
      var renderSidebar = window.DocuLight.fn && window.DocuLight.fn.renderSidebarTree;
      if (renderSidebar) renderSidebar(data.sidebarTree);
    }
    // Highlight current file in sidebar after tree render
    if (window.DocuLight && window.DocuLight.fn) {
      var updateHighlight = window.DocuLight.fn.updateSidebarHighlight;
      if (updateHighlight) updateHighlight(tab.filePath);
    }

    renderTabBar();
    updateTabBarVisibility();

    if (viewerContainer) viewerContainer.scrollTop = 0;
  }

  function switchTab(index) {
    if (index < 0 || index >= tabs.length || index === activeTabIndex) return;

    saveCurrentTabState();

    var newTab = tabs[index];
    activeTabIndex = index;

    var contentEl = document.getElementById('content');

    if (newTab.filePath && window.doclight && window.doclight.checkFileMtime) {
      window.doclight.checkFileMtime(newTab.filePath).then(function (result) {
        if (result.exists && result.mtime > newTab.cachedAt) {
          if (window.doclight.readFileForTab) {
            window.doclight.readFileForTab(newTab.filePath).then(function (data) {
              if (!data.error) {
                if (window.DocuLight && window.DocuLight.state) {
                  window.DocuLight.state.currentFilePath = data.filePath;
                  window.DocuLight.state.imageBasePath = data.imageBasePath || null;
                }
                var renderFn = window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.renderMarkdown;
                if (renderFn) renderFn(data.markdown);
                newTab.renderedHtml = contentEl ? contentEl.innerHTML : '';
                newTab.cachedAt = Date.now();
                newTab.title = data.title || newTab.title;
                if (data.sidebarTree) {
                  newTab.sidebarTree = data.sidebarTree;
                  if (window.DocuLight) window.DocuLight.state.sidebarTree = data.sidebarTree;
                  var renderSb = window.DocuLight.fn && window.DocuLight.fn.renderSidebarTree;
                  if (renderSb) renderSb(data.sidebarTree);
                }
                var updateHl = window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.updateSidebarHighlight;
                if (updateHl) updateHl(data.filePath);
                renderTabBar();
              }
            });
          }
        } else {
          restoreTabContent(newTab);
        }
      });
    } else {
      restoreTabContent(newTab);
    }

    renderTabBar();
  }

  function restoreTabContent(tab) {
    var contentEl = document.getElementById('content');
    var viewerContainer = document.getElementById('viewer-container');

    if (contentEl) contentEl.innerHTML = tab.renderedHtml;
    if (viewerContainer) viewerContainer.scrollTop = tab.scrollTop;

    if (window.DocuLight && window.DocuLight.state) {
      window.DocuLight.state.currentFilePath = tab.filePath;
      window.DocuLight.state.sidebarTree = tab.sidebarTree;
    }

    if (tab.sidebarTree) {
      var renderSidebar = window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.renderSidebarTree;
      if (renderSidebar) renderSidebar(tab.sidebarTree);
    }

    if (tab.currentSidebarPath) {
      var updateHighlight = window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.updateSidebarHighlight;
      if (updateHighlight) updateHighlight(tab.currentSidebarPath);
    }
  }

  function closeTab(index) {
    if (index === undefined || index === null) index = activeTabIndex;
    if (index < 0 || index >= tabs.length) return;

    tabs.splice(index, 1);

    if (tabs.length === 0) {
      window.close();
      return;
    }

    if (index === activeTabIndex) {
      activeTabIndex = index > 0 ? index - 1 : 0;
      restoreTabContent(tabs[activeTabIndex]);
    } else if (index < activeTabIndex) {
      activeTabIndex--;
    }

    renderTabBar();
    updateTabBarVisibility();
  }

  function saveCurrentTabState() {
    if (activeTabIndex < 0 || activeTabIndex >= tabs.length) return;
    var tab = tabs[activeTabIndex];
    var contentEl = document.getElementById('content');
    var viewerContainer = document.getElementById('viewer-container');
    if (contentEl) tab.renderedHtml = contentEl.innerHTML;
    if (viewerContainer) tab.scrollTop = viewerContainer.scrollTop;
    tab.currentSidebarPath = window.DocuLight ? window.DocuLight.state.currentFilePath : null;
  }

  function renderTabBar() {
    if (!tabBarEl) return;

    var addBtn = tabBarEl.querySelector('.tab-add');
    var existingTabs = tabBarEl.querySelectorAll('.tab-item');
    existingTabs.forEach(function (el) { el.remove(); });

    tabs.forEach(function (tab, index) {
      var tabEl = document.createElement('div');
      tabEl.className = 'tab-item' + (index === activeTabIndex ? ' active' : '');
      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('aria-selected', index === activeTabIndex ? 'true' : 'false');
      tabEl.setAttribute('tabindex', index === activeTabIndex ? '0' : '-1');

      var titleSpan = document.createElement('span');
      titleSpan.className = 'tab-title';
      titleSpan.textContent = tab.title || 'Untitled';
      tabEl.appendChild(titleSpan);

      var closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.setAttribute('aria-label', 'Close tab');
      closeBtn.textContent = '\u00d7';
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeTab(index);
      });
      tabEl.appendChild(closeBtn);

      tabEl.addEventListener('click', function () {
        switchTab(index);
      });

      tabEl.addEventListener('auxclick', function (e) {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(index);
        }
      });

      if (addBtn) {
        tabBarEl.insertBefore(tabEl, addBtn);
      } else {
        tabBarEl.appendChild(tabEl);
      }
    });

    var activeEl = tabBarEl.querySelector('.tab-item.active');
    if (activeEl) {
      activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }

  function updateTabBarVisibility() {
    if (!tabBarEl) return;
    if (tabs.length > 1) {
      tabBarEl.classList.remove('hidden');
      tabBarEverShown = true;
    } else if (tabBarEverShown && tabs.length === 1) {
      // Once tabs have been used, keep tab bar visible with 1 tab
      tabBarEl.classList.remove('hidden');
    } else {
      tabBarEl.classList.add('hidden');
    }
  }

  function showMaxTabsToast() {
    var existing = document.querySelector('.tab-toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.className = 'tab-toast';
    var tFn = window.DocuLight && window.DocuLight.fn && window.DocuLight.fn.t;
    toast.textContent = tFn ? tFn('viewer.maxTabsReached') : 'Maximum tabs reached (20)';
    document.body.appendChild(toast);

    requestAnimationFrame(function () {
      toast.classList.add('visible');
    });

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove('visible');
      setTimeout(function () { toast.remove(); }, 150);
    }, 2700);
  }

  function consumePendingSearchScroll() {
    if (window.DocuLight && window.DocuLight.state && window.DocuLight.state.pendingSearchScroll) {
      var scrollInfo = window.DocuLight.state.pendingSearchScroll;
      window.DocuLight.state.pendingSearchScroll = null;
      var scrollFn = window.DocuLight.fn && window.DocuLight.fn.scrollToTextMatch;
      if (scrollFn) {
        setTimeout(function () { scrollFn(scrollInfo.query, scrollInfo.occurrenceIndex); }, 100);
      }
    }
  }

  function isAbsolutePath(p) {
    if (!p) return false;
    // Unix absolute or Windows absolute (C:/ or C:\)
    return p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p);
  }

  function generateId() {
    return 'tab-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
  }

  function isEnabled() {
    return enableTabs;
  }

  function getActiveTabIndex() {
    return activeTabIndex;
  }

  // Register module
  if (!window.__docuLightModules) window.__docuLightModules = [];
  window.__docuLightModules.push({
    name: 'tabManager',
    init: init,
    closeTab: closeTab,
    createBlankTab: createBlankTab,
    createTab: createTab,
    isEnabled: isEnabled,
    getActiveTabIndex: getActiveTabIndex,
    renderTabBar: renderTabBar
  });
})();
