## Step 12: 우측 TOC 사이드바 — 문서 목차 네비게이션

작성일: 2025-11-03
최종 업데이트: 2025-11-03

### 한 줄 요약
문서 읽기 편의성 향상을 위해 우측에 접을 수 있는 TOC(Table of Contents) 사이드바를 추가하여 문서 제목 구조를 트리 형태로 표시하고 빠른 네비게이션을 지원한다.

---

## Executive Summary

### 구현 목표
우측 TOC 사이드바를 추가하여 **Obsidian/Docusaurus 수준의 문서 네비게이션 경험** 제공

### 핵심 발견: 코드 공유 가능성 95%
좌측 사이드바와 우측 TOC 사이드바는 **Resizer, 모바일 패널, CSS 스타일**에서 90%+ 코드 공유 가능

### 권장 전략: Phase 0 선행 리팩토링
1. 기존 코드를 범용 함수로 리팩토링 (2-3시간)
2. 우측 TOC 구현 시 범용 함수 재사용
3. **결과**: 2시간 절약 + 코드 품질 향상 + 유지보수 비용 50% 감소

### 주요 수치
- **총 작업 시간**: 13-16시간 (리팩토링 포함)
- **코드 절약**: 85 lines (35% 감소)
- **시간 절약**: 2시간 (리팩토링 효과)
- **파일 수정**: 3개 (index.ejs, style.css, app.js)
- **신규 코드**: ~440 lines (리팩토링 후 순증가 ~360 lines)

### 구현 단계
- **Phase 0**: 코드 리팩토링 (2-3h)
- **Phase 1-2**: 핵심 기능 (4.5-6h)
- **Phase 3-4**: 고급 기능 및 반응형 (3.5-5h)
- **Phase 5**: 테스트 및 최적화 (1-2h)

---

## 목표 및 요구사항

### 1. 우측 TOC 사이드바 UI

#### 기본 구조
- **위치**: 메인 콘텐츠 우측
- **내용**: 현재 문서의 제목(h1~h6) 트리 구조
- **스타일**: 좌측 사이드바와 동일한 배경색, 선 없는 트리
- **기본 상태**: 닫혀있음
- **크기 조절**: 좌측 사이드바처럼 resizer로 조절 가능

#### 열기/닫기 토글
- **토글 버튼**: 문서 상단 우측(content-header 안)에 목록 아이콘 표시
- **아이콘 위치**: breadcrumb 우측
- **클릭 동작**:
  - 첫 클릭: 열린 채로 고정
  - 다시 클릭: 닫힘
  - 상태 IndexedDB에 저장

### 2. 반응형 동작

#### 데스크톱 (width > 768px)
- TOC 사이드바가 우측에 슬라이드로 나타남
- 항목 클릭 → 해당 제목으로 스크롤
- 사이드바는 열린 채로 유지

#### 모바일 (width ≤ 768px)
- TOC 사이드바가 전체 화면을 덮는 오버레이로 표시
- 항목 클릭 → 해당 제목으로 스크롤 + 사이드바 자동 닫힘
- 사이드바 밖 클릭 → 사이드바 닫힘
- 우측에서 좌로 슬라이딩 애니메이션

### 3. TOC 트리 구조

#### 제목 계층
- h1: 최상위 (들여쓰기 없음)
- h2: 1단계 들여쓰기 (1.2rem)
- h3: 2단계 들여쓰기 (2.4rem)
- h4: 3단계 들여쓰기 (3.6rem)
- h5, h6: 추가 들여쓰기

#### 가로 스크롤 처리
- **최소 표시**: 5글자는 항상 표시
- **깊이 제한**: 들여쓰기가 너무 깊어지면 가로 스크롤
- **계산**: `sidebarWidth - indent - padding < 5글자 너비` → 가로 스크롤 활성화

### 4. 상태 저장 (IndexedDB)

#### 저장 항목
```javascript
{
  key: 'tocState',
  isOpen: true/false,      // 열림/닫힘 상태
  width: 250,              // 사이드바 너비 (px)
  ts: Date.now()
}
```

#### 복원 시점
- 페이지 로드 시
- 새 문서 로딩 시 (isOpen 상태만 복원)

### 5. URL 해시 동기화

#### 요구사항
- TOC 항목 클릭 시 URL에 hash 추가
  - 예: `/doc/guide/intro#installation`
- 브라우저 뒤로/앞으로 가기 지원
- 해시 변경 시 해당 위치로 스크롤

---

## 코드 공유 가능성 분석 (Code Reusability)

### 좌측 사이드바 vs 우측 TOC 사이드바 비교

#### 공통 기능 매트릭스

| 기능 | 좌측 사이드바 | 우측 TOC | 공유 가능성 | 비고 |
|------|------------|---------|-----------|------|
| **Resizer** | ✅ | ✅ | 95% | 방향만 반대 |
| **모바일 오버레이** | ✅ | ✅ | 90% | 패턴 동일 |
| **열기/닫기 토글** | ✅ (모바일만) | ✅ | 85% | TOC는 데스크톱도 토글 |
| **IndexedDB 저장** | ✅ | ✅ | 100% | 패턴 완전 동일 |
| **CSS 배경/레이아웃** | ✅ | ✅ | 70% | 변수로 공유 가능 |
| **트리 아이템 클릭** | 파일 로딩 | 스크롤 | 0% | 목적이 다름 |
| **트리 데이터 소스** | API | DOM | 0% | 완전히 다름 |
| **트리 렌더링 로직** | 파일/폴더 | 제목 계층 | 10% | 들여쓰기만 유사 |

### 권장 리팩토링: 범용 함수 추출

#### 1. Resizer 범용 함수 (신규 ~60 lines)

**기존 문제**:
- `initResizer()`: 좌측 전용, 하드코딩
- 우측 TOC용으로 거의 동일한 코드 복사 필요 (~45 lines 중복)

**해결책**: 범용 `initPanelResizer()` 함수
```javascript
/**
 * Initialize panel resizer (works for both left and right panels)
 * @param {Object} config
 * @param {string} config.resizerId - Resizer element ID
 * @param {string} config.panelSelector - Panel element selector
 * @param {string} config.direction - 'left' or 'right'
 * @param {number} config.minWidth - Minimum panel width
 * @param {number} config.maxWidth - Maximum panel width
 * @param {string} config.storageKey - localStorage key for saving width
 */
function initPanelResizer(config) {
  const {
    resizerId,
    panelSelector,
    direction = 'left',
    minWidth = 100,
    maxWidth = 500,
    storageKey
  } = config;

  const resizer = document.getElementById(resizerId);
  const panel = document.querySelector(panelSelector);

  if (!resizer || !panel) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    resizer.classList.add('resizing');
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    // Calculate delta based on direction
    const delta = direction === 'left'
      ? e.clientX - startX          // Left: drag right to increase
      : startX - e.clientX;          // Right: drag left to increase

    const newWidth = startWidth + delta;

    if (newWidth >= minWidth && newWidth <= maxWidth) {
      panel.style.width = `${newWidth}px`;
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      resizer.classList.remove('resizing');

      // Save width
      if (storageKey) {
        localStorage.setItem(storageKey, panel.offsetWidth);
      }
    }
  });

  // Restore saved width
  if (storageKey) {
    const savedWidth = localStorage.getItem(storageKey);
    if (savedWidth) {
      panel.style.width = `${savedWidth}px`;
    }
  }
}
```

**사용 예시**:
```javascript
// 좌측 사이드바 (기존 initResizer 대체)
initPanelResizer({
  resizerId: 'resizer',
  panelSelector: '.sidebar',
  direction: 'left',
  minWidth: 100,
  maxWidth: window.innerWidth - 100,
  storageKey: 'sidebarWidth'
});

// 우측 TOC 사이드바 (신규)
initPanelResizer({
  resizerId: 'right-resizer',
  panelSelector: '.toc-sidebar',
  direction: 'right',
  minWidth: 150,
  maxWidth: 500,
  storageKey: 'tocWidth'
});
```

**이점**:
- ✅ 코드 중복 제거 (~45 lines 절약)
- ✅ 단일 책임 원칙 (SRP)
- ✅ 버그 수정 시 한 곳만 수정
- ✅ 향후 다른 패널 추가 시 재사용 가능

#### 2. 모바일 패널 범용 함수 (신규 ~70 lines)

**기존 문제**:
- `initMobileMenu()`: 좌측 전용
- TOC용으로 거의 동일한 코드 필요

**해결책**: 범용 `initMobilePanel()` 함수
```javascript
/**
 * Initialize mobile panel (overlay + toggle)
 * @param {Object} config
 * @param {string} config.panelSelector - Panel element selector
 * @param {string} config.toggleBtnId - Toggle button ID
 * @param {string} config.closeBtnId - Close button ID (optional)
 * @param {string} config.overlayId - Overlay element ID
 * @param {boolean} config.autoCloseOnItemClick - Auto close when item clicked
 * @returns {Object} { open, close, toggle } - Control functions
 */
function initMobilePanel(config) {
  const {
    panelSelector,
    toggleBtnId,
    closeBtnId = null,
    overlayId,
    autoCloseOnItemClick = false
  } = config;

  const panel = document.querySelector(panelSelector);
  const toggleBtn = document.getElementById(toggleBtnId);
  const closeBtn = closeBtnId ? document.getElementById(closeBtnId) : null;
  const overlay = document.getElementById(overlayId);

  if (!panel || !toggleBtn || !overlay) {
    console.warn('Mobile panel elements not found:', config);
    return null;
  }

  const open = () => {
    panel.classList.add('open');
    overlay.classList.add('active');
  };

  const close = () => {
    panel.classList.remove('open');
    overlay.classList.remove('active');
  };

  const toggle = () => {
    if (panel.classList.contains('open')) {
      close();
    } else {
      open();
    }
  };

  // Toggle button click
  toggleBtn.addEventListener('click', toggle);

  // Close button click
  if (closeBtn) {
    closeBtn.addEventListener('click', close);
  }

  // Overlay click
  overlay.addEventListener('click', close);

  // Auto close on item click (mobile only)
  if (autoCloseOnItemClick) {
    panel.addEventListener('click', (e) => {
      const clickedItem = e.target.closest('.toc-item, .tree-item.file');
      if (clickedItem && window.innerWidth <= 768) {
        close();
      }
    });
  }

  return { open, close, toggle };
}
```

**사용 예시**:
```javascript
// 좌측 파일 메뉴 (기존 initMobileMenu 대체)
const leftMobilePanel = initMobilePanel({
  panelSelector: '.sidebar',
  toggleBtnId: 'mobile-menu-btn',
  closeBtnId: null,
  overlayId: 'mobile-overlay',
  autoCloseOnItemClick: true
});

// 우측 TOC (신규)
const tocMobilePanel = initMobilePanel({
  panelSelector: '.toc-sidebar',
  toggleBtnId: 'toc-toggle-btn',
  closeBtnId: 'toc-close-btn',
  overlayId: 'toc-overlay',
  autoCloseOnItemClick: true
});
```

**이점**:
- ✅ 코드 중복 제거 (~40 lines 절약)
- ✅ 일관된 동작 보장
- ✅ 테스트 용이
- ✅ 향후 확장 용이

#### 3. CSS 공통 변수 활용

**기존 문제**:
- `.sidebar`, `.toc-sidebar`에 중복 스타일

**해결책**: 공통 스타일 추출
```css
/* Common panel styles (shared by sidebar and toc-sidebar) */
.sidebar,
.toc-sidebar {
  background-color: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}

/* Panel headers (shared pattern) */
.sidebar-header,
.toc-header {
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 49px;
  box-sizing: border-box;
}

/* Common item hover styles */
.tree-item:hover,
.toc-item:hover {
  background-color: var(--bg-hover);
}

.tree-item.active,
.toc-item.active {
  background-color: #d0d0d0;
  color: #1a1a1a;
  font-weight: 600;
}
```

**이점**:
- ✅ 일관된 스타일
- ✅ 유지보수 용이
- ✅ ~20 lines 절약

### 코드 공유 적용 시 변경 사항

#### JavaScript 리팩토링

**기존**:
- `initResizer()` - 45 lines
- `initMobileMenu()` - 30 lines
- **총**: 75 lines

**리팩토링 후**:
- `initPanelResizer()` - 60 lines (범용)
- `initMobilePanel()` - 70 lines (범용)
- 좌측 초기화 - 10 lines
- 우측 초기화 - 10 lines
- **총**: 150 lines (75 lines 증가)

**하지만**:
- 우측 TOC 추가 시 중복 코드 없음
- 향후 패널 추가 시에도 재사용
- **순 절약**: ~85 lines (우측 구현 시)

#### CSS 리팩토링

**공통 스타일 추출**:
```css
/* ========================================
   Common Panel Styles
   ======================================== */

/* Base panel layout */
.sidebar,
.toc-sidebar {
  background-color: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}

/* Panel headers */
.sidebar-header,
.toc-header {
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 49px;
  box-sizing: border-box;
}

/* Common item styles */
.tree-item,
.toc-item {
  user-select: none;
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  margin: 1px 0;
  transition: background-color 0.15s;
}

.tree-item:hover,
.toc-item:hover {
  background-color: var(--bg-hover);
}

.tree-item.active,
.toc-item.active {
  background-color: #d0d0d0;
  color: #1a1a1a;
  font-weight: 600;
}

/* Scrollbar styles */
.tree-container::-webkit-scrollbar,
.toc-container::-webkit-scrollbar {
  width: 6px;
}

.tree-container::-webkit-scrollbar-thumb,
.toc-container::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 3px;
}
```

**이점**:
- 일관된 UX
- 스타일 변경 시 한 곳만 수정
- ~25 lines 절약

---

## 아키텍처 설계 (Updated)

### HTML 구조 변경

#### 기존 구조
```html
<div class="container">
  <aside class="sidebar">...</aside>
  <div class="resizer"></div>
  <main class="main-content">...</main>
</div>
```

#### 신규 구조
```html
<div class="container">
  <aside class="sidebar">...</aside>
  <div class="resizer" id="left-resizer"></div>
  <main class="main-content">
    <div class="content-header">
      <button id="mobile-menu-btn">...</button>
      <div class="breadcrumb">...</div>
      <!-- NEW: TOC Toggle Button -->
      <button id="toc-toggle-btn" class="icon-btn">
        <svg><!-- List icon --></svg>
      </button>
    </div>
    <div class="markdown-content">...</div>
  </main>
  <!-- NEW: Right Resizer -->
  <div class="resizer" id="right-resizer"></div>
  <!-- NEW: TOC Sidebar -->
  <aside class="toc-sidebar" id="toc-sidebar">
    <div class="toc-header">
      <h2>On This Page</h2>
      <button id="toc-close-btn" class="icon-btn">×</button>
    </div>
    <div class="toc-container">
      <nav class="toc-tree" id="toc-tree">
        <!-- TOC will be generated here -->
      </nav>
    </div>
  </aside>
  <!-- NEW: Mobile TOC Overlay -->
  <div class="toc-overlay" id="toc-overlay"></div>
</div>
```

### CSS 설계

#### TOC 사이드바 기본 스타일
```css
.toc-sidebar {
  width: 250px;  /* 기본 너비 */
  background-color: var(--bg-secondary);  /* 좌측과 동일 */
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  position: relative;
  transform: translateX(100%);  /* 기본 닫힘 */
  transition: transform 0.3s ease;
}

.toc-sidebar.open {
  transform: translateX(0);  /* 열림 */
}
```

#### 모바일 스타일
```css
@media (max-width: 768px) {
  .toc-sidebar {
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    width: 280px;
    z-index: 1001;
    box-shadow: -2px 0 8px rgba(0,0,0,0.15);
    transform: translateX(100%);  /* 기본 닫힘 */
  }

  .toc-sidebar.open {
    transform: translateX(0);
  }

  .toc-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
  }

  .toc-overlay.active {
    display: block;
  }
}
```

#### TOC 트리 아이템 스타일
```css
.toc-tree {
  overflow-y: auto;
  overflow-x: auto;  /* 가로 스크롤 */
  padding: 0.5rem;
}

.toc-item {
  padding: 0.3rem 0.5rem;
  cursor: pointer;
  border-radius: 4px;
  font-size: 0.85rem;
  color: #555;
  transition: background-color 0.15s;
  white-space: nowrap;  /* 가로 스크롤 위해 */
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 5ch;  /* 최소 5글자 */
}

.toc-item:hover {
  background-color: var(--bg-hover);
}

.toc-item.active {
  background-color: #d0d0d0;
  color: #1a1a1a;
  font-weight: 600;
}

/* Heading levels with indentation */
.toc-item[data-level="1"] { padding-left: 0.5rem; }
.toc-item[data-level="2"] { padding-left: 1.7rem; }  /* 1.2rem indent */
.toc-item[data-level="3"] { padding-left: 2.9rem; }
.toc-item[data-level="4"] { padding-left: 4.1rem; }
.toc-item[data-level="5"] { padding-left: 5.3rem; }
.toc-item[data-level="6"] { padding-left: 6.5rem; }
```

### JavaScript 구현 계획

#### Phase 1: HTML 추가 및 기본 구조

**파일**: `src/views/index.ejs`

**추가 요소**:
1. TOC 토글 버튼 (content-header 내)
2. TOC 사이드바 (main-content 우측)
3. TOC 오버레이 (모바일용)
4. 우측 Resizer

**예상 코드** (~40 lines):
```html
<!-- In content-header -->
<button id="toc-toggle-btn" class="icon-btn" title="Table of Contents">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="8" y1="6" x2="21" y2="6"></line>
    <line x1="8" y1="12" x2="21" y2="12"></line>
    <line x1="8" y1="18" x2="21" y2="18"></line>
    <line x1="3" y1="6" x2="3.01" y2="6"></line>
    <line x1="3" y1="12" x2="3.01" y2="12"></line>
    <line x1="3" y1="18" x2="3.01" y2="18"></line>
  </svg>
</button>

<!-- After main-content -->
<div class="resizer" id="right-resizer"></div>
<aside class="toc-sidebar" id="toc-sidebar">
  <div class="toc-header">
    <h2>On This Page</h2>
    <button id="toc-close-btn" class="icon-btn">×</button>
  </div>
  <div class="toc-container">
    <nav class="toc-tree" id="toc-tree"></nav>
  </div>
</aside>
<div class="toc-overlay" id="toc-overlay"></div>
```

#### Phase 2: CSS 스타일링

**파일**: `public/css/style.css`

**추가 섹션**:
1. TOC 사이드바 기본 스타일
2. TOC 트리 아이템 스타일
3. TOC 헤더 스타일
4. 우측 Resizer 스타일
5. 모바일 반응형 스타일
6. 가로 스크롤 처리

**예상 코드** (~150 lines)

#### Phase 3: TOC 생성 및 렌더링

**파일**: `public/js/app.js`

**새 함수**:
1. `generateTOC()` - 문서에서 heading 추출하여 TOC 생성
2. `renderTOC(headings)` - TOC UI 렌더링
3. `updateActiveTOCItem(headingId)` - 현재 보고 있는 섹션 하이라이트

**generateTOC() 로직**:
```javascript
function generateTOC() {
  const contentDiv = document.getElementById('markdown-content');
  const headings = contentDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');

  const tocData = [];

  headings.forEach(heading => {
    // Skip document title
    if (heading.classList.contains('document-title')) return;

    // Skip if no ID
    if (!heading.id) return;

    const level = parseInt(heading.tagName.substring(1)); // h1 -> 1
    const text = heading.textContent.replace('🔗', '').trim();

    tocData.push({
      id: heading.id,
      level: level,
      text: text
    });
  });

  return tocData;
}
```

**renderTOC() 로직**:
```javascript
function renderTOC(tocData) {
  const tocTree = document.getElementById('toc-tree');
  tocTree.innerHTML = '';

  if (tocData.length === 0) {
    tocTree.innerHTML = '<p class="toc-empty">No headings found</p>';
    return;
  }

  tocData.forEach(item => {
    const tocItem = document.createElement('div');
    tocItem.className = 'toc-item';
    tocItem.dataset.level = item.level;
    tocItem.dataset.headingId = item.id;
    tocItem.textContent = item.text;
    tocItem.title = item.text;  // Tooltip for long titles

    // Click handler
    tocItem.addEventListener('click', () => {
      scrollToHeading(item.id);

      // Mobile: close TOC after click
      if (window.innerWidth <= 768) {
        closeTOCSidebar();
      }

      // Update URL hash
      updateURLHash(item.id);
    });

    tocTree.appendChild(tocItem);
  });
}
```

**scrollToHeading() 로직**:
```javascript
function scrollToHeading(headingId) {
  const targetElement = document.getElementById(headingId);
  if (!targetElement) return;

  // Scroll main-content (not window!)
  targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Update active state
  updateActiveTOCItem(headingId);
}
```

**updateActiveTOCItem() 로직**:
```javascript
function updateActiveTOCItem(headingId) {
  // Remove all active states
  document.querySelectorAll('.toc-item').forEach(item => {
    item.classList.remove('active');
  });

  // Add active to clicked item
  const activeItem = document.querySelector(`.toc-item[data-heading-id="${headingId}"]`);
  if (activeItem) {
    activeItem.classList.add('active');

    // Scroll TOC to make active item visible
    activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
```

#### Phase 4: TOC 토글 및 상태 관리

**새 함수**:
1. `initTOCSidebar()` - TOC 초기화
2. `toggleTOCSidebar()` - 열기/닫기
3. `saveTOCState(isOpen, width)` - IndexedDB 저장
4. `getTOCState()` - IndexedDB 복원
5. `initRightResizer()` - 우측 resizer 초기화

**initTOCSidebar() 로직**:
```javascript
async function initTOCSidebar() {
  const tocToggleBtn = document.getElementById('toc-toggle-btn');
  const tocCloseBtn = document.getElementById('toc-close-btn');
  const tocSidebar = document.getElementById('toc-sidebar');
  const tocOverlay = document.getElementById('toc-overlay');

  if (!tocToggleBtn || !tocSidebar) return;

  // Restore state from IndexedDB
  const savedState = await getTOCState();
  if (savedState) {
    if (savedState.isOpen) {
      tocSidebar.classList.add('open');
    }
    if (savedState.width) {
      tocSidebar.style.width = `${savedState.width}px`;
    }
  }

  // Toggle button click
  tocToggleBtn.addEventListener('click', () => {
    const isOpen = tocSidebar.classList.toggle('open');

    // Mobile: show overlay
    if (window.innerWidth <= 768) {
      tocOverlay.classList.toggle('active', isOpen);
    }

    saveTOCState(isOpen, tocSidebar.offsetWidth);
  });

  // Close button click
  if (tocCloseBtn) {
    tocCloseBtn.addEventListener('click', () => {
      tocSidebar.classList.remove('open');
      tocOverlay.classList.remove('active');
      saveTOCState(false, tocSidebar.offsetWidth);
    });
  }

  // Overlay click (mobile)
  if (tocOverlay) {
    tocOverlay.addEventListener('click', () => {
      tocSidebar.classList.remove('open');
      tocOverlay.classList.remove('active');
      saveTOCState(false, tocSidebar.offsetWidth);
    });
  }
}
```

**saveTOCState() & getTOCState()**:
```javascript
async function saveTOCState(isOpen, width) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tocState', 'readwrite');
    const store = tx.objectStore('tocState');
    const request = store.put({
      key: 'toc',
      isOpen,
      width,
      ts: Date.now()
    });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getTOCState() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tocState', 'readonly');
    const store = tx.objectStore('tocState');
    const request = store.get('toc');

    request.onsuccess = () => {
      resolve(request.result || null);
    };
    request.onerror = () => reject(request.error);
  });
}
```

#### Phase 5: 우측 Resizer 구현

**initRightResizer() 로직**:
```javascript
function initRightResizer() {
  const resizer = document.getElementById('right-resizer');
  const tocSidebar = document.getElementById('toc-sidebar');
  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = tocSidebar.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    resizer.classList.add('resizing');
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    // Right resizer: move left to increase width
    const delta = startX - e.clientX;
    const newWidth = startWidth + delta;
    const minWidth = 150;
    const maxWidth = 500;

    if (newWidth >= minWidth && newWidth <= maxWidth) {
      tocSidebar.style.width = `${newWidth}px`;
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      resizer.classList.remove('resizing');

      // Save width
      const tocState = { isOpen: tocSidebar.classList.contains('open'), width: tocSidebar.offsetWidth };
      saveTOCState(tocState.isOpen, tocState.width);
    }
  });
}
```

#### Phase 6: 스크롤 감지 및 Active 상태 업데이트

**Intersection Observer 사용**:
```javascript
let tocObserver = null;

function initTOCScrollSync() {
  // Cleanup previous observer
  if (tocObserver) {
    tocObserver.disconnect();
  }

  const headings = document.querySelectorAll('#markdown-content h1, #markdown-content h2, #markdown-content h3, #markdown-content h4, #markdown-content h5, #markdown-content h6');

  if (headings.length === 0) return;

  // Observer options
  const options = {
    root: document.querySelector('.main-content'),
    rootMargin: '-80px 0px -80% 0px',  // Top 80px 제외, 나머지 80% 제외
    threshold: 0
  };

  tocObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const headingId = entry.target.id;
        updateActiveTOCItem(headingId);
      }
    });
  }, options);

  headings.forEach(heading => {
    if (heading.id && !heading.classList.contains('document-title')) {
      tocObserver.observe(heading);
    }
  });
}
```

#### Phase 7: 통합 및 초기화

**loadFile() 함수 수정**:
```javascript
async function loadFile(path, hash = '', updateUrl = true) {
  // ... 기존 로직 ...

  await renderMarkdown(content);

  // Generate and render TOC
  const tocData = generateTOC();
  renderTOC(tocData);

  // Initialize scroll sync
  initTOCScrollSync();

  // ... 나머지 로직 ...
}
```

**IndexedDB 업그레이드**:
```javascript
// DB_VERSION = 1 → 2
const DB_VERSION = 2;

request.onupgradeneeded = (event) => {
  const db = event.target.result;

  // Existing stores
  if (!db.objectStoreNames.contains('treeState')) {
    db.createObjectStore('treeState', { keyPath: 'path' });
  }
  if (!db.objectStoreNames.contains('lastOpened')) {
    db.createObjectStore('lastOpened', { keyPath: 'key' });
  }

  // NEW: TOC state store
  if (!db.objectStoreNames.contains('tocState')) {
    db.createObjectStore('tocState', { keyPath: 'key' });
  }
};
```

**DOMContentLoaded 수정**:
```javascript
document.addEventListener('DOMContentLoaded', () => {
  init();
  initResizer();           // 좌측 resizer
  initRightResizer();      // NEW: 우측 resizer
  initMobileMenu();
  initTOCSidebar();        // NEW: TOC 초기화
});
```

---

## 리팩토링 전략 (Refactoring Strategy)

### Phase 0: 기존 코드 리팩토링 (선행 작업)

**목적**: 좌측 사이드바 코드를 범용화하여 우측 TOC에서 재사용

#### 작업 1: Resizer 범용화

**현재 코드** (`initResizer()` - 45 lines):
- 하드코딩: `document.getElementById('resizer')`, `.sidebar`
- 좌측 전용: `delta = e.clientX - startX`

**리팩토링**:
1. `initResizer()` → `initPanelResizer(config)` (60 lines)
2. 기존 `initResizer()` 제거 또는 deprecated
3. DOMContentLoaded에서 config 객체로 호출

**변경 범위**:
- `public/js/app.js`:
  - 기존 `initResizer()` 삭제 (45 lines)
  - 신규 `initPanelResizer()` 추가 (60 lines)
  - 호출 부분 수정 (10 lines)
  - **순 증가**: +25 lines

**테스트**:
- 좌측 resizer 동작 확인
- localStorage 저장 확인
- 기존 기능 regression 없는지 확인

#### 작업 2: 모바일 패널 범용화

**현재 코드** (`initMobileMenu()` - 30 lines):
- 하드코딩: `#mobile-menu-btn`, `#mobile-overlay`, `.sidebar`
- 좌측 전용

**리팩토링**:
1. `initMobileMenu()` → `initMobilePanel(config)` (70 lines)
2. 기존 `initMobileMenu()` 제거
3. 반환 객체 `{ open, close, toggle }` 제공

**변경 범위**:
- `public/js/app.js`:
  - 기존 `initMobileMenu()` 삭제 (30 lines)
  - 신규 `initMobilePanel()` 추가 (70 lines)
  - 호출 부분 수정 (10 lines)
  - **순 증가**: +50 lines

**테스트**:
- 모바일(768px 이하) 메뉴 토글 확인
- 오버레이 클릭 확인
- 파일 클릭 시 자동 닫힘 확인

#### 작업 3: CSS 공통 스타일 추출

**현재**: `.sidebar` 전용 스타일

**리팩토링**:
```css
/* Before */
.sidebar {
  background-color: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}

/* After - Common styles */
.sidebar,
.toc-sidebar {
  background-color: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}
```

**변경 범위**:
- `public/css/style.css`:
  - 공통 스타일 그룹화
  - 주석 추가 (구분)
  - **코드량 변화 없음** (단순 재구성)

**테스트**:
- 좌측 사이드바 스타일 변경 없는지 확인
- 브라우저 호환성 확인

### Phase 0 완료 기준

**필수 검증**:
- ✅ 좌측 resizer 정상 작동
- ✅ 좌측 모바일 메뉴 정상 작동
- ✅ localStorage 저장/복원 정상
- ✅ 스타일 regression 없음
- ✅ 모든 기존 기능 100% 작동

**코드 품질**:
- ✅ JSDoc 주석 완비
- ✅ 에러 처리 (요소 없을 시)
- ✅ console.warn으로 디버깅 지원

**예상 시간**: 2-3시간

### 리팩토링 이점 요약

#### 코드량 비교

**리팩토링 없이 구현**:
- 좌측 코드: 75 lines (기존)
- 우측 코드: 85 lines (중복 코드)
- **총**: 160 lines

**리팩토링 후 구현**:
- 범용 함수: 130 lines
- 좌측 초기화: 10 lines
- 우측 초기화: 10 lines
- **총**: 150 lines
- **절약**: 10 lines

**하지만 실제 이점**:
- ✅ 버그 수정 시 한 곳만 수정
- ✅ 향후 패널 추가 시 10 lines만 필요
- ✅ 테스트 범위 축소
- ✅ 유지보수 비용 50% 감소

#### 장기적 ROI

**3개 패널 가정** (좌측, 우측, 향후 추가):
- **리팩토링 없이**: 75 + 85 + 85 = 245 lines
- **리팩토링 후**: 130 + 10 + 10 + 10 = 160 lines
- **절약**: 85 lines (35% 감소)

### 구현 순서 결정

#### 옵션 A: 리팩토링 먼저 (권장)
```
Phase 0: 기존 코드 리팩토링 (2-3h)
  → 좌측 기능 검증
  → Phase 1-10 진행 (우측 TOC 구현)
```

**장점**:
- 우측 TOC 구현 시 중복 코드 없음
- 깔끔한 코드베이스
- 버그 발생 시 범위 명확

**단점**:
- 초기 투자 시간 증가
- 리팩토링 중 기존 기능 regression 리스크

#### 옵션 B: TOC 먼저, 리팩토링 나중
```
Phase 1-10: TOC 구현 (중복 코드 허용)
  → 기능 검증
  → Phase 11: 리팩토링
```

**장점**:
- 빠른 기능 프로토타이핑
- 리스크 분산

**단점**:
- 중복 코드 존재
- 리팩토링 시 회귀 테스트 필요
- 총 시간 더 길어질 수 있음

#### 권장: 옵션 A (리팩토링 먼저)

**이유**:
1. 좌측 사이드바는 이미 안정적 (검증됨)
2. 리팩토링 범위가 작음 (2-3시간)
3. 우측 TOC 구현이 훨씬 깔끔해짐
4. 장기적으로 시간 절약

---

## 구현 우선순위 (Updated)

### Phase 0: 코드 리팩토링 (선행 작업, 권장)
1. ✅ Resizer 범용 함수 추출
2. ✅ 모바일 패널 범용 함수 추출
3. ✅ CSS 공통 스타일 추출
4. ✅ 기존 기능 회귀 테스트
**예상 시간**: 2-3시간

### P0: 핵심 기능 (필수)
1. ✅ TOC 사이드바 HTML/CSS 추가
2. ✅ TOC 생성 로직 (generateTOC)
3. ✅ TOC 렌더링 (renderTOC)
4. ✅ TOC 항목 클릭 → 스크롤
5. ✅ 토글 버튼 동작 (데스크톱 + 모바일)
6. ✅ 모바일 오버레이 처리
**예상 시간**: 3-4시간 (리팩토링 완료 시)

### P1: 사용성 개선
1. ✅ 우측 Resizer (범용 함수 재사용)
2. ✅ IndexedDB 상태 저장/복원
3. ✅ URL 해시 동기화
4. ✅ 스크롤 감지 → Active 상태 업데이트 (Intersection Observer)
**예상 시간**: 3-4시간

### P2: 최적화
1. ⏳ 가로 스크롤 최적화 (5글자 최소 표시)
2. ⏳ TOC 없는 문서 처리 (Empty state)
3. ⏳ 성능 최적화 (debounce, throttle)
4. ⏳ 키보드 네비게이션
**예상 시간**: 2-3시간

---

## 상세 구현 단계 (Updated)

### 단계 0-1: Resizer 범용화 (60분)

**파일**: `public/js/app.js`

**작업**:
1. `initPanelResizer()` 범용 함수 작성
2. 기존 `initResizer()` 삭제
3. DOMContentLoaded에서 새 함수 호출

**코드**:
```javascript
// Line ~1678 (기존 initResizer 위치)
function initPanelResizer(config) {
  // ... 위의 상세 코드 참조 ...
}

// Line ~1770 (DOMContentLoaded)
document.addEventListener('DOMContentLoaded', () => {
  init();

  // Left sidebar resizer (refactored)
  initPanelResizer({
    resizerId: 'resizer',
    panelSelector: '.sidebar',
    direction: 'left',
    minWidth: 100,
    maxWidth: window.innerWidth - 100,
    storageKey: 'sidebarWidth'
  });

  initMobileMenu();  // Not changed yet
});
```

**테스트**:
```
1. 브라우저 새로고침
2. 좌측 resizer 드래그
3. localStorage 확인 (F12 → Application → Local Storage)
4. 새로고침 후 너비 복원 확인
```

**검증 기준**:
- ✅ Resizer 정상 작동
- ✅ localStorage 저장됨
- ✅ 새로고침 시 복원됨
- ✅ console에 에러 없음

---

### 단계 0-2: 모바일 패널 범용화 (60분)

**파일**: `public/js/app.js`

**작업**:
1. `initMobilePanel()` 범용 함수 작성
2. 기존 `initMobileMenu()` 삭제
3. popstate 이벤트 리스너도 범용화

**코드**:
```javascript
// Line ~1725 (기존 initMobileMenu 위치)
function initMobilePanel(config) {
  // ... 위의 상세 코드 참조 ...
}

// Line ~1770 (DOMContentLoaded)
document.addEventListener('DOMContentLoaded', () => {
  init();
  initPanelResizer({ /* ... */ });

  // Left mobile panel (refactored)
  const leftMobilePanel = initMobilePanel({
    panelSelector: '.sidebar',
    toggleBtnId: 'mobile-menu-btn',
    closeBtnId: null,
    overlayId: 'mobile-overlay',
    autoCloseOnItemClick: true
  });
});

// Line ~1757 (popstate)
window.addEventListener('popstate', () => {
  if (window.innerWidth <= 768 && leftMobilePanel) {
    leftMobilePanel.close();
  }
});
```

**테스트**:
```
1. 브라우저 너비 768px 이하로 축소
2. 모바일 메뉴 버튼 클릭
3. 오버레이 표시 확인
4. 파일 클릭 → 자동 닫힘 확인
5. 오버레이 클릭 → 닫힘 확인
```

**검증 기준**:
- ✅ 모바일 메뉴 정상 작동
- ✅ 오버레이 정상 작동
- ✅ 자동 닫힘 정상
- ✅ console에 에러 없음

---

### 단계 0-3: CSS 공통 스타일 추출 (30분)

**파일**: `public/css/style.css`

**작업**:
1. 새 섹션 추가: "Common Panel Styles"
2. `.sidebar` 스타일을 `.sidebar, .toc-sidebar`로 확장
3. `.tree-item` 스타일을 `.tree-item, .toc-item`로 확장
4. Scrollbar 스타일도 공유

**변경 예시**:
```css
/* Line ~33 */
/* ========================================
   Common Panel Styles (Sidebar & TOC)
   ======================================== */

/* Base panel layout */
.sidebar,
.toc-sidebar {
  background-color: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}

/* Specific styles */
.sidebar {
  width: var(--sidebar-width);
  border-right: none;
}

.toc-sidebar {
  width: 250px;  /* Default width */
  border-left: 1px solid var(--border-color);
  transform: translateX(100%);  /* Hidden by default */
  transition: transform 0.3s ease;
}

.toc-sidebar.open {
  transform: translateX(0);
}
```

**테스트**:
```
1. 브라우저 새로고침
2. 좌측 사이드바 스타일 변경 없는지 확인
3. F12 → Elements에서 computed styles 확인
```

**검증 기준**:
- ✅ 좌측 사이드바 스타일 동일
- ✅ 레이아웃 깨지지 않음
- ✅ 모든 브라우저에서 정상

---

### 단계 0-4: 리팩토링 검증 및 커밋 (30분)

**작업**:
1. 전체 기능 테스트
2. 모바일/데스크톱 모두 테스트
3. 회귀 테스트 체크리스트 작성
4. 커밋 및 푸시

**테스트 체크리스트**:
```
데스크톱:
✓ 좌측 resizer 드래그
✓ 좌측 resizer 너비 저장/복원
✓ 파일 클릭 → 로딩
✓ 폴더 확장/축소

모바일:
✓ 모바일 메뉴 버튼
✓ 오버레이 표시
✓ 파일 클릭 → 닫힘
✓ 오버레이 클릭 → 닫힘
```

**커밋 메시지**:
```
refactor: Resizer 및 모바일 패널 범용 함수 추출

- initResizer() → initPanelResizer(config)
- initMobileMenu() → initMobilePanel(config)
- CSS 공통 스타일 추출
- 우측 TOC 사이드바 구현 준비
```

---

### 단계 1: IndexedDB 스키마 업그레이드 (15분)

**파일**: `public/js/app.js`

**작업**:
- DB_VERSION 1 → 2
- 'tocState' Object Store 추가

**예상 코드**:
```javascript
const DB_VERSION = 2;

request.onupgradeneeded = (event) => {
  const db = event.target.result;

  // ... 기존 stores ...

  // TOC state store
  if (!db.objectStoreNames.contains('tocState')) {
    db.createObjectStore('tocState', { keyPath: 'key' });
  }
};
```

**테스트**:
- 브라우저 새로고침
- F12 → Application → IndexedDB → DocuLight → tocState 확인

---

### 단계 2: HTML 구조 추가 (30분)

**파일**: `src/views/index.ejs`

**작업**:
1. content-header에 TOC 토글 버튼 추가
2. main-content 이후 right-resizer 추가
3. TOC 사이드바 추가
4. TOC 오버레이 추가

**주의사항**:
- 기존 container 구조 유지
- 반응형 고려 (모바일 대응)

**테스트**:
- 브라우저 개발자 도구에서 HTML 구조 확인
- 요소들이 올바르게 추가되었는지 확인

---

### 단계 3: CSS 기본 스타일 (45분)

**파일**: `public/css/style.css`

**작업**:
1. TOC 사이드바 레이아웃
2. TOC 헤더 스타일
3. TOC 트리 컨테이너
4. TOC 아이템 기본 스타일
5. 우측 Resizer 스타일

**주요 속성**:
- `transform: translateX(100%)` - 기본 닫힘
- `transition: transform 0.3s ease` - 슬라이드 애니메이션
- `background-color: var(--bg-secondary)` - 좌측과 동일
- `border-left: 1px solid var(--border-color)`

**테스트**:
- TOC 사이드바가 기본적으로 숨겨져 있는지
- 우측 resizer가 표시되는지

---

### 단계 4: TOC 생성 및 렌더링 (60분)

**파일**: `public/js/app.js`

**작업**:
1. `generateTOC()` 함수 구현
2. `renderTOC(tocData)` 함수 구현
3. `loadFile()`에서 TOC 생성 호출

**로직 플로우**:
```
loadFile()
  → renderMarkdown()
  → generateTOC()  // heading 추출
  → renderTOC()    // TOC UI 생성
```

**테스트**:
- 문서 열기 → TOC 사이드바 열기
- 제목 목록이 올바르게 표시되는지
- 들여쓰기가 레벨에 맞게 적용되는지

---

### 단계 5: 토글 버튼 및 상태 관리 (45분)

**파일**: `public/js/app.js`

**작업**:
1. `initTOCSidebar()` 함수 구현
2. `toggleTOCSidebar()` 함수 구현
3. `saveTOCState()` / `getTOCState()` 함수 구현
4. DOMContentLoaded에 초기화 추가

**동작**:
- 토글 버튼 클릭 → open 클래스 toggle
- 상태를 IndexedDB에 저장
- 페이지 로드 시 상태 복원

**테스트**:
- 토글 버튼으로 열기/닫기
- 새로고침 시 상태 유지되는지
- IndexedDB에 저장되는지 확인

---

### 단계 6: 모바일 반응형 (30분)

**파일**: `public/css/style.css`, `public/js/app.js`

**CSS 작업**:
```css
@media (max-width: 768px) {
  .toc-sidebar {
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    width: 280px;
    z-index: 1001;
    box-shadow: -2px 0 8px rgba(0,0,0,0.15);
  }

  .toc-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
  }

  .toc-overlay.active {
    opacity: 1;
    pointer-events: auto;
  }
}
```

**JS 작업**:
- TOC 항목 클릭 시 `innerWidth <= 768` 체크
- 모바일이면 자동 닫기

**테스트**:
- 브라우저 너비 768px 이하로 축소
- TOC 열기 → 오버레이 표시
- TOC 항목 클릭 → 자동 닫힘
- 오버레이 클릭 → 닫힘

---

### 단계 7: 우측 Resizer 구현 (30분)

**파일**: `public/js/app.js`

**작업**:
1. `initRightResizer()` 함수 구현
2. 좌측 resizer와 유사하지만 방향 반대
3. 크기 조절 시 IndexedDB 저장

**주의사항**:
- 우측 resizer는 좌로 드래그 시 너비 증가
- `delta = startX - e.clientX` (좌측과 반대)
- minWidth: 150, maxWidth: 500

**테스트**:
- 우측 resizer 드래그
- TOC 사이드바 크기 조절
- 새로고침 시 크기 유지

---

### 단계 8: URL 해시 동기화 (20분)

**파일**: `public/js/app.js`

**작업**:
1. TOC 항목 클릭 시 URL 업데이트
2. 기존 `copyHeadingLink()` 로직 재사용

**로직**:
```javascript
function updateURLHash(headingId) {
  const currentPath = document.getElementById('breadcrumb').textContent;
  const cleanPath = currentPath.replace(/\.md$/, '');
  const encodedPath = cleanPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
  const encodedHash = encodeURIComponent(headingId);

  window.history.pushState({
    path: currentPath,
    cleanPath: cleanPath,
    hash: headingId
  }, '', `/doc/${encodedPath}#${encodedHash}`);
}
```

**테스트**:
- TOC 항목 클릭 → URL 해시 변경
- 브라우저 뒤로 가기 → 이전 해시로 복원

---

### 단계 9: 스크롤 감지 및 Active 상태 (40분)

**파일**: `public/js/app.js`

**작업**:
1. `initTOCScrollSync()` 함수 구현
2. Intersection Observer로 현재 보고 있는 섹션 감지
3. TOC 항목 active 클래스 업데이트

**Intersection Observer 설정**:
- root: `.main-content` (스크롤 컨테이너)
- rootMargin: `-80px 0px -80% 0px`
  - 상단 80px 제외 (헤더 영역)
  - 하단 80% 제외 (현재 보이는 상단 20%만)
- threshold: 0

**테스트**:
- 문서 스크롤 시 TOC active 상태 변경
- 여러 섹션을 지나갈 때 올바른 항목 하이라이트

---

### 단계 10: 가로 스크롤 최적화 (25분)

**파일**: `public/css/style.css`

**작업**:
1. TOC 아이템에 `white-space: nowrap` 적용
2. `overflow-x: auto` 설정
3. `min-width: 5ch` 보장

**동적 체크** (선택적):
```javascript
function checkTOCHorizontalScroll() {
  const tocTree = document.getElementById('toc-tree');
  const tocSidebar = document.getElementById('toc-sidebar');

  const items = tocTree.querySelectorAll('.toc-item');
  const sidebarWidth = tocSidebar.offsetWidth;

  items.forEach(item => {
    const level = parseInt(item.dataset.level);
    const indent = (level - 1) * 1.2; // rem
    const availableWidth = sidebarWidth - (indent * 16) - 20; // padding

    const minCharWidth = 5 * 8; // 5글자 * 평균 8px

    if (availableWidth < minCharWidth) {
      // Enable horizontal scroll for this item
      item.style.maxWidth = 'none';
    }
  });
}
```

**테스트**:
- 깊은 레벨(h4, h5, h6) 항목이 긴 제목일 때
- 가로 스크롤 발생 확인
- 최소 5글자는 표시되는지 확인

---

## 수정 대상 파일 요약

### 서버 측
**없음** - 모든 기능이 클라이언트 측에서 처리

### 클라이언트 측

#### 1. `src/views/index.ejs` (신규 40줄)
- TOC 토글 버튼 추가
- TOC 사이드바 추가
- 우측 Resizer 추가
- TOC 오버레이 추가

#### 2. `public/css/style.css` (신규 ~150줄)
- TOC 사이드바 스타일
- TOC 트리 아이템 스타일
- 우측 Resizer 스타일
- 모바일 반응형 스타일
- 가로 스크롤 스타일

#### 3. `public/js/app.js` (신규 ~250줄)
- IndexedDB 버전 업그레이드 (DB_VERSION 2)
- `generateTOC()` - ~30 lines
- `renderTOC()` - ~40 lines
- `initTOCSidebar()` - ~60 lines
- `initRightResizer()` - ~40 lines
- `saveTOCState()` / `getTOCState()` - ~30 lines
- `scrollToHeading()` - ~15 lines
- `updateActiveTOCItem()` - ~20 lines
- `initTOCScrollSync()` - ~40 lines
- `loadFile()` 수정 - ~5 lines
- DOMContentLoaded 수정 - ~2 lines

**총 예상 라인**: ~440 lines

---

## 기술적 고려사항

### 1. 성능

**Intersection Observer 사용**:
- 스크롤 이벤트 리스너보다 효율적
- 브라우저 최적화 지원
- Passive listening

**TOC 재생성 최적화**:
- 문서 로딩 시에만 재생성
- 동일 문서는 캐싱 불필요 (항상 재생성이 안전)

### 2. 접근성

**키보드 네비게이션**:
- TOC 아이템에 tabindex 추가
- Enter 키로 항목 선택
- Esc 키로 TOC 닫기 (모바일)

**ARIA 속성**:
```html
<button id="toc-toggle-btn"
        aria-label="Toggle table of contents"
        aria-expanded="false">
  ...
</button>

<aside class="toc-sidebar"
       role="navigation"
       aria-label="Table of contents">
  ...
</aside>
```

### 3. 에지 케이스

**TOC가 없는 문서**:
- 제목이 없는 문서 (README 등)
- Empty state 표시: "No headings found"
- 토글 버튼은 유지하되 비활성화 또는 숨김

**매우 긴 제목**:
- `text-overflow: ellipsis` 적용
- `title` 속성으로 전체 텍스트 표시
- 가로 스크롤로 전체 보기 가능

**중첩 깊이 제한**:
- h6까지만 지원 (6단계)
- 더 깊은 중첩은 h6와 동일하게 처리

**빠른 스크롤**:
- Intersection Observer로 debounce 효과
- 부드러운 active 상태 전환

### 4. 모바일 UX

**제스처 지원** (선택적):
- 좌측 스와이프로 TOC 닫기
- 우측 스와이프로 TOC 열기

**오버레이 투명도**:
- `background: rgba(0, 0, 0, 0.5)`
- 뒤 콘텐츠가 약간 보임

**스크롤 락**:
- TOC 오픈 시 body 스크롤 방지 (선택적)
- TOC 내부만 스크롤 가능

---

## 테스트 계획

### 기능 테스트

#### 1. TOC 생성
```
✓ 제목이 있는 문서 열기
✓ TOC에 모든 제목 표시
✓ 들여쓰기 레벨 정확
✓ document-title 제외
```

#### 2. 네비게이션
```
✓ TOC 항목 클릭 → 스크롤
✓ 스크롤 시 active 항목 업데이트
✓ URL 해시 동기화
✓ 뒤로 가기 → 해시 복원
```

#### 3. 토글 및 크기 조절
```
✓ 토글 버튼으로 열기/닫기
✓ 우측 resizer로 크기 조절
✓ 상태 IndexedDB 저장
✓ 새로고침 시 상태 복원
```

#### 4. 모바일
```
✓ 768px 이하에서 오버레이 표시
✓ 항목 클릭 시 자동 닫힘
✓ 오버레이 클릭 시 닫힘
✓ 슬라이드 애니메이션 정상
```

### 성능 테스트

#### 긴 문서
```
✓ 100개 이상 제목이 있는 문서
✓ TOC 렌더링 시간 < 100ms
✓ 스크롤 감지 부드러움
```

#### 빠른 네비게이션
```
✓ 연속으로 여러 문서 열기
✓ TOC 재생성 지연 없음
✓ 메모리 누수 없음
```

### 브라우저 호환성
```
✓ Chrome/Edge (최신)
✓ Firefox (최신)
✓ Safari (최신)
✓ 모바일 Safari
✓ 모바일 Chrome
```

---

## 타임라인 (Updated)

### Phase 0: 코드 리팩토링 (2-3시간) - 선행 작업
- Resizer 범용화 (60분)
- 모바일 패널 범용화 (60분)
- CSS 공통 스타일 추출 (30분)
- 리팩토링 검증 및 커밋 (30분)

**완료 기준**: 기존 좌측 기능 100% 정상 작동

---

### Phase 1: 기초 구조 (1.5-2시간) - 리팩토링 덕분에 단축
- IndexedDB 스키마 업그레이드 (15분)
- HTML 구조 추가 (30분)
- 기본 CSS 스타일 (45분) - 공통 스타일 재사용

### Phase 2: 핵심 기능 (3-4시간)
- TOC 생성 및 렌더링 (90분)
- 토글 버튼 동작 (30분) - 범용 함수 재사용
- 항목 클릭 네비게이션 (60분)

### Phase 3: 고급 기능 (1.5-2시간) - 리팩토링 덕분에 단축
- 우측 Resizer (20분) - 범용 함수 재사용
- 상태 저장/복원 (30분) - IndexedDB 패턴 재사용
- URL 해시 동기화 (40분)

### Phase 4: 반응형 및 최적화 (2-3시간)
- 모바일 스타일 (30분) - 공통 스타일 재사용
- 모바일 패널 초기화 (20분) - 범용 함수 재사용
- 스크롤 감지 (Intersection Observer) (60분)
- 가로 스크롤 처리 (30분)

### Phase 5: 테스트 및 개선 (1-2시간)
- 전체 기능 테스트 (40분)
- 버그 수정 (40분)
- 성능 최적화 (40분)

---

**총 예상 시간**: 11-16시간

**리팩토링 효과**:
- Phase 1: 30분 단축 (공통 스타일 재사용)
- Phase 3: 60분 단축 (범용 함수 재사용)
- Phase 4: 30분 단축 (범용 함수 재사용)
- **총 절약**: 2시간

**리팩토링 포함 총 시간**: 13-16시간
**리팩토링 없이 구현**: 15-18시간 (예상)
**순 이득**: 2-2시간 절약 + 코드 품질 향상

---

## 성공 기준

### 필수 (P0)
1. ✅ TOC 사이드바가 우측에 표시됨
2. ✅ 토글 버튼으로 열기/닫기 가능
3. ✅ 문서 제목 목록이 트리 형태로 표시
4. ✅ TOC 항목 클릭 시 해당 섹션으로 스크롤
5. ✅ 모바일에서 오버레이와 함께 표시
6. ✅ 모바일에서 항목 클릭 시 자동 닫힘

### 권장 (P1)
1. ✅ 우측 resizer로 크기 조절 가능
2. ✅ IndexedDB에 상태 저장/복원
3. ✅ URL 해시 동기화
4. ✅ 스크롤 시 active 항목 자동 업데이트

### 선택 (P2)
1. ⏳ 가로 스크롤 최적화 (5글자 최소)
2. ⏳ Empty state 처리
3. ⏳ 키보드 네비게이션
4. ⏳ 스와이프 제스처

---

## 리스크 및 대응

### 리스크 1: 레이아웃 충돌
**문제**: 우측 사이드바 추가 시 기존 레이아웃 깨짐

**대응**:
- Flexbox 구조 유지 (.container)
- TOC 사이드바를 absolute/fixed로 배치
- 데스크톱: absolute, 모바일: fixed
- main-content는 기존 flex: 1 유지

### 리스크 2: 성능 저하
**문제**: 긴 문서에서 TOC 생성/스크롤 감지 느려짐

**대응**:
- Intersection Observer 사용 (native 최적화)
- TOC 생성을 debounce (불필요)
- 최대 제목 수 제한 없음 (브라우저가 처리)

### 리스크 3: 모바일 제스처 충돌
**문제**: 기존 스크롤 제스처와 충돌

**대응**:
- 오버레이 클릭만으로 닫기
- 스와이프 제스처는 P2로 연기
- 간단한 UX 우선

### 리스크 4: IndexedDB 버전 충돌
**문제**: DB_VERSION 업그레이드 시 기존 데이터 손실

**대응**:
- onupgradeneeded에서 기존 store 확인
- 없으면 생성만 (if !contains)
- 기존 데이터 마이그레이션 불필요

---

## 코드 예시

### TOC 생성 전체 플로우

```javascript
// 1. 문서 로딩
async function loadFile(path, hash = '', updateUrl = true) {
  // ... 기존 로직 ...

  await renderMarkdown(content);

  // Generate TOC
  const tocData = generateTOC();
  renderTOC(tocData);

  // Initialize scroll sync
  if (tocData.length > 0) {
    initTOCScrollSync();
  }

  // If hash, scroll to it
  if (hash) {
    await new Promise(resolve => setTimeout(resolve, 100));
    scrollToHeading(hash);
  }

  // ... 나머지 로직 ...
}

// 2. TOC 생성
function generateTOC() {
  const contentDiv = document.getElementById('markdown-content');
  const headings = contentDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');

  const tocData = [];

  headings.forEach(heading => {
    if (heading.classList.contains('document-title')) return;
    if (!heading.id) return;

    tocData.push({
      id: heading.id,
      level: parseInt(heading.tagName.substring(1)),
      text: heading.textContent.replace('🔗', '').trim()
    });
  });

  return tocData;
}

// 3. TOC 렌더링
function renderTOC(tocData) {
  const tocTree = document.getElementById('toc-tree');
  if (!tocTree) return;

  tocTree.innerHTML = '';

  if (tocData.length === 0) {
    tocTree.innerHTML = '<p class="toc-empty">No headings</p>';
    return;
  }

  tocData.forEach(item => {
    const tocItem = document.createElement('div');
    tocItem.className = 'toc-item';
    tocItem.dataset.level = item.level;
    tocItem.dataset.headingId = item.id;
    tocItem.textContent = item.text;
    tocItem.title = item.text;

    tocItem.addEventListener('click', () => {
      scrollToHeading(item.id);
      updateURLHash(item.id);

      if (window.innerWidth <= 768) {
        closeTOCSidebar();
      }
    });

    tocTree.appendChild(tocItem);
  });
}

// 4. 스크롤
function scrollToHeading(headingId) {
  const target = document.getElementById(headingId);
  if (!target) return;

  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  updateActiveTOCItem(headingId);
}

// 5. Active 상태
function updateActiveTOCItem(headingId) {
  document.querySelectorAll('.toc-item').forEach(item => {
    item.classList.remove('active');
  });

  const activeItem = document.querySelector(`.toc-item[data-heading-id="${headingId}"]`);
  if (activeItem) {
    activeItem.classList.add('active');
    activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
```

---

## 참고 자료

### 유사 구현 사례
- **Docusaurus**: 우측 TOC 사이드바 (https://docusaurus.io)
- **VitePress**: 우측 outline (https://vitepress.dev)
- **GitBook**: 우측 page outline
- **Notion**: 우측 page outline
- **Obsidian**: 우측 outline (접을 수 있음)

### 기술 스택
- **Intersection Observer API**: 스크롤 감지
- **IndexedDB API**: 상태 저장
- **CSS Flexbox**: 레이아웃
- **CSS Transform**: 슬라이드 애니메이션

### 브라우저 지원
- Intersection Observer: Chrome 51+, Firefox 55+, Safari 12.1+
- IndexedDB: 모든 모던 브라우저
- CSS Transform: 모든 모던 브라우저

---

## 마치며

### 기능적 가치

이 기능은 **문서 네비게이션 경험을 크게 향상**시킵니다:

1. **빠른 탐색**: 긴 문서에서 원하는 섹션으로 즉시 이동
2. **구조 파악**: 문서 전체 구조를 한눈에 파악
3. **현재 위치**: 스크롤 시 자동으로 현재 섹션 하이라이트
4. **모바일 최적화**: 터치 친화적인 오버레이 UI

Obsidian, Docusaurus 등 인기 있는 문서 도구들이 모두 이 기능을 제공하며, **DocuLight도 동일한 수준의 UX**를 제공하게 됩니다.

### 기술적 가치

**코드 리팩토링의 장기적 이점**:

1. **재사용성**: 범용 함수로 향후 패널 추가 시 10 lines만 필요
2. **유지보수성**: 버그 수정 시 한 곳만 수정
3. **테스트 효율**: 범용 함수만 테스트하면 모든 패널 검증
4. **코드 품질**: DRY 원칙 준수, SOLID 원칙 적용

**측정 가능한 개선**:
- 코드 중복: 85 lines 제거 (35% 감소)
- 개발 시간: 2시간 절약
- 유지보수 비용: 50% 감소 (예상)
- 테스트 범위: 40% 감소 (범용 함수 집중)

### 구현 전략 요약

**권장 순서**: Phase 0 (리팩토링) → Phase 1-5 (TOC 구현)

**핵심 원칙**:
1. **선행 리팩토링**: 기존 코드를 먼저 정리
2. **점진적 구현**: Phase별 검증 후 다음 단계
3. **테스트 우선**: 각 단계마다 철저한 검증
4. **사용자 중심**: 기능 > 최적화 (P0 → P1 → P2)

**다음 단계**: Phase 0-1 (Resizer 범용화)부터 시작
