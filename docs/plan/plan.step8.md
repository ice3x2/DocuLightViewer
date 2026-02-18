# DocuLight Step 8 구현 계획

## 개요

Step 8에서는 DocuLight의 고급 기능들을 추가하여 사용자 경험과 개발자 편의성을 크게 향상시킵니다.

**예상 소요 시간**: 12-16시간

## 1. Config Hot Reload (설정 파일 핫 리로드)

### 목표
설정 파일(`config.json5`) 변경 시 서버 재시작 없이 자동으로 반영하고, 잘못된 설정 발견 시 이전 설정으로 롤백합니다.

### 구현 내용

#### 1.1 파일 모니터링 시스템
```javascript
// src/utils/config-watcher.js
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config-loader');

class ConfigWatcher {
  constructor(app) {
    this.app = app;
    this.configPath = path.join(process.cwd(), 'config.json5');
    this.currentConfig = null;
    this.watcher = null;
    this.reloadTimeout = null;
  }

  start() {
    // fs.watch()로 config.json5 모니터링
    // 변경 감지 시 debounce 적용 (1초)
    // loadAndValidate() 호출
  }

  async loadAndValidate() {
    // 1. 새로운 설정 로드 시도
    // 2. 검증 성공 시 app.locals.config 업데이트
    // 3. 검증 실패 시 currentConfig로 롤백
    // 4. 로그 출력
  }

  stop() {
    // watcher 정리
  }
}
```

#### 1.2 검증 로직
- 필수 필드 존재 여부 확인
- docsRoot 경로 유효성 검증
- apiKey 보안 검증
- 포트 번호 범위 확인
- IP 패턴 유효성 검증

#### 1.3 롤백 메커니즘
```javascript
// 설정 로드 실패 시
{
  success: false,
  error: "검증 실패 사유",
  rolledBack: true,
  previousConfig: { ... }
}
```

#### 1.4 테스트 시나리오
1. **정상 변경**: 포트 번호 변경 → 서버 재시작 없이 반영 확인
2. **잘못된 설정**: docsRoot를 존재하지 않는 경로로 변경 → 롤백 확인
3. **부분 변경**: excludes 패턴 추가 → 트리 갱신 확인
4. **동시 변경**: 여러 필드 동시 수정 → debounce 동작 확인

### 성공 기준
- ✅ 설정 변경 후 1초 이내 자동 반영
- ✅ 잘못된 설정 감지 및 롤백
- ✅ 로그에 변경 내역 기록
- ✅ 서버 재시작 불필요

---

## 2. MCP Tools 확장

### 목표
MCP Server에 전체 트리 조회와 새로운 API 기능을 추가합니다.

### 구현 내용

#### 2.1 DocuLight_get_full_tree 도구
```javascript
// DocuLight-mcp-server/src/tools/list_full_tree.js
{
  name: "DocuLight_get_full_tree",
  description: "문서 디렉터리의 전체 트리 구조를 재귀적으로 조회합니다",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
}

// 구현
async function getFullTree(args, config) {
  const response = await fetch(`${config.baseUrl}/api/tree/full`);
  const data = await response.json();

  return {
    content: [{
      type: "text",
      text: `전체 트리 구조:\n총 ${data.stats.totalFiles}개 파일, ${data.stats.totalDirs}개 디렉터리`
    }]
  };
}
```

#### 2.2 새로운 API 도구 추가

**DocuLight_get_config**
```javascript
{
  name: "DocuLight_get_config",
  description: "현재 DocuLight 설정 정보를 조회합니다",
  inputSchema: {
    type: "object",
    properties: {
      section: {
        type: "string",
        description: "조회할 설정 섹션 (ui, security, ssl 등)",
        enum: ["ui", "security", "ssl", "all"]
      }
    }
  }
}
```

**DocuLight_search**
```javascript
{
  name: "DocuLight_search",
  description: "문서 내용에서 키워드를 검색합니다",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "검색할 키워드"
      },
      limit: {
        type: "number",
        description: "최대 결과 개수",
        default: 10
      }
    },
    required: ["query"]
  }
}
```

#### 2.3 MCP 도구 목록 업데이트
```javascript
// DocuLight-mcp-server/src/index.js
const tools = {
  DocuLight_list: require('./tools/list'),
  DocuLight_read: require('./tools/read'),
  DocuLight_create: require('./tools/create'),
  DocuLight_update: require('./tools/update'),
  DocuLight_delete: require('./tools/delete'),
  DocuLight_get_full_tree: require('./tools/list_full_tree'),    // 신규
  DocuLight_get_config: require('./tools/get-config'),           // 신규
  DocuLight_search: require('./tools/search')                    // 신규
};
```

### 성공 기준
- ✅ 총 8개 MCP 도구 제공
- ✅ Claude/Copilot에서 정상 동작
- ✅ 에러 처리 및 fallback 제공
- ✅ README 업데이트

---

## 3. 다국어 지원 (i18n)

### 목표
한국어와 영어를 지원하는 i18n 시스템을 도입하여 사용자가 언어를 선택할 수 있도록 합니다.

### 구현 내용

#### 3.1 i18n 라이브러리 설치
```bash
npm install i18next i18next-browser-languagedetector i18next-http-middleware
```

#### 3.2 언어 파일 구조
```
public/locales/
├── en/
│   └── translation.json
└── ko/
    └── translation.json
```

**en/translation.json**
```json
{
  "welcome": {
    "title": "Welcome to DocuLight",
    "subtitle": "A lightweight Markdown documentation viewer and management system"
  },
  "sidebar": {
    "title": "Documents",
    "refresh": "Refresh",
    "search": "Search documents..."
  },
  "breadcrumb": {
    "select": "Select a document"
  },
  "error": {
    "title": "Error Occurred",
    "retry": "Retry",
    "notFound": "{{context}} not found",
    "network": "Please check your network connection"
  }
}
```

**ko/translation.json**
```json
{
  "welcome": {
    "title": "DocuLight에 오신 것을 환영합니다",
    "subtitle": "경량 Markdown 문서 뷰어 및 관리 시스템"
  },
  "sidebar": {
    "title": "문서",
    "refresh": "새로고침",
    "search": "문서 검색..."
  },
  "breadcrumb": {
    "select": "문서를 선택하세요"
  },
  "error": {
    "title": "오류 발생",
    "retry": "다시 시도",
    "notFound": "{{context}}을(를) 찾을 수 없습니다",
    "network": "네트워크 연결을 확인해주세요"
  }
}
```

#### 3.3 클라이언트 i18n 초기화
```javascript
// public/js/i18n.js
import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

await i18next
  .use(LanguageDetector)
  .init({
    fallbackLng: 'en',
    supportedLngs: ['en', 'ko'],
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage']
    },
    resources: {
      en: { translation: await fetch('/locales/en/translation.json').then(r => r.json()) },
      ko: { translation: await fetch('/locales/ko/translation.json').then(r => r.json()) }
    }
  });
```

#### 3.4 UI 업데이트
```javascript
// 텍스트 변경 함수
function updateUILanguage() {
  document.querySelector('.welcome h1').textContent = i18next.t('welcome.title');
  document.querySelector('.welcome-subtitle').textContent = i18next.t('welcome.subtitle');
  document.getElementById('breadcrumb').innerHTML = `<span>${i18next.t('breadcrumb.select')}</span>`;
  // ... 모든 UI 텍스트 업데이트
}

// 언어 변경 이벤트
i18next.on('languageChanged', updateUILanguage);
```

#### 3.5 언어 전환 UI
```html
<!-- 사이드바 하단에 언어 선택 버튼 추가 -->
<div class="language-selector">
  <button class="lang-btn" data-lang="en">English</button>
  <button class="lang-btn" data-lang="ko">한국어</button>
</div>
```

```css
.language-selector {
  padding: 1rem;
  border-top: 1px solid var(--border-color);
  display: flex;
  gap: 0.5rem;
}

.lang-btn {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.lang-btn.active {
  background: var(--accent-color);
  color: white;
}
```

### 성공 기준
- ✅ 한국어/영어 전환 가능
- ✅ 브라우저 언어 자동 감지
- ✅ localStorage에 선택 언어 저장
- ✅ 모든 UI 텍스트 번역 적용

---

## 4. 검색 기능

### 목표
전체 문서에서 키워드를 검색하고 결과를 빠르게 탐색할 수 있는 기능을 제공합니다.

### 구현 내용

#### 4.1 검색 API
```javascript
// src/controllers/search-controller.js
async function searchDocuments(req, res, next) {
  const { query, limit = 50 } = req.query;

  // 1. docsRoot에서 모든 .md 파일 검색
  // 2. 각 파일에서 query 포함 여부 확인
  // 3. 매칭된 라인과 컨텍스트 추출
  // 4. 결과 반환

  res.json({
    query,
    results: [
      {
        path: "/guide/getting-started.md",
        matches: [
          {
            line: 15,
            content: "DocuLight is a <mark>lightweight</mark> viewer",
            context: "..."
          }
        ]
      }
    ],
    total: 10
  });
}
```

#### 4.2 검색 UI (사이드바 헤더 아래)
```html
<div class="sidebar-search">
  <input
    type="text"
    id="search-input"
    placeholder="Search documents..."
    autocomplete="off"
  />
  <div class="search-results" id="search-results">
    <!-- 검색 결과 표시 -->
  </div>
</div>
```

```css
.sidebar-search {
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border-color);
}

.sidebar-search input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 0.9rem;
}

.search-results {
  max-height: 300px;
  overflow-y: auto;
  background: white;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  margin-top: 0.5rem;
  display: none;
}

.search-results.active {
  display: block;
}

.search-result-item {
  padding: 0.75rem;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  transition: background 0.2s;
}

.search-result-item:hover {
  background: var(--bg-hover);
}

.search-result-path {
  font-size: 0.85rem;
  color: var(--accent-color);
  margin-bottom: 0.25rem;
}

.search-result-content {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.search-result-content mark {
  background: #fff176;
  padding: 0 0.2rem;
  border-radius: 2px;
}
```

#### 4.3 검색 로직 (클라이언트)
```javascript
// Debounce 적용 (300ms)
let searchTimeout;
const searchInput = document.getElementById('search-input');

searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const query = e.target.value.trim();

  if (query.length < 2) {
    hideSearchResults();
    return;
  }

  searchTimeout = setTimeout(() => {
    performSearch(query);
  }, 300);
});

async function performSearch(query) {
  const results = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
  const data = await results.json();
  displaySearchResults(data);
}

function displaySearchResults(data) {
  const container = document.getElementById('search-results');
  container.innerHTML = data.results.map(result => `
    <div class="search-result-item" data-path="${result.path}">
      <div class="search-result-path">${result.path}</div>
      <div class="search-result-content">${result.matches[0].content}</div>
    </div>
  `).join('');
  container.classList.add('active');
}
```

#### 4.4 검색 최적화
- **캐싱**: 검색 결과 캐싱 (5분)
- **인덱싱**: 서버 시작 시 문서 인덱스 생성
- **정규식**: 대소문자 구분 없는 검색
- **하이라이팅**: 매칭된 텍스트 하이라이트

### 성공 기준
- ✅ 2글자 이상 입력 시 검색 시작
- ✅ 300ms debounce 적용
- ✅ 검색 결과 클릭 시 해당 문서 열림
- ✅ 검색어 하이라이팅

---

## 5. 테마 설정 (다크 모드)

### 목표
라이트 모드와 다크 모드를 지원하여 사용자가 선호하는 테마를 선택할 수 있도록 합니다.

### 구현 내용

#### 5.1 CSS 변수 확장
```css
/* style.css */
:root {
  /* Light Mode */
  --bg-primary: #ffffff;
  --bg-secondary: #f5f5f5;
  --bg-hover: #e8e8e8;
  --text-primary: #2c3e50;
  --text-secondary: #7f8c8d;
  --border-color: #ddd;
  --accent-color: #3498db;
  --code-bg: #f6f8fa;
  --code-border: #d0d7de;
}

[data-theme="dark"] {
  /* Dark Mode */
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --bg-hover: #2d2d30;
  --text-primary: #d4d4d4;
  --text-secondary: #9d9d9d;
  --border-color: #3e3e42;
  --accent-color: #569cd6;
  --code-bg: #1e1e1e;
  --code-border: #3e3e42;
}
```

#### 5.2 테마 전환 UI
```html
<!-- 사이드바 하단에 테마 토글 추가 -->
<div class="theme-toggle">
  <button id="theme-toggle-btn" aria-label="Toggle theme">
    <svg class="sun-icon" width="20" height="20">
      <circle cx="10" cy="10" r="5"/>
    </svg>
    <svg class="moon-icon" width="20" height="20" style="display: none;">
      <path d="M10,2 Q8,8 10,14 Q12,8 10,2"/>
    </svg>
  </button>
</div>
```

```css
.theme-toggle {
  padding: 1rem;
  border-top: 1px solid var(--border-color);
  text-align: center;
}

#theme-toggle-btn {
  padding: 0.5rem;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  border-radius: 50%;
  width: 40px;
  height: 40px;
  cursor: pointer;
  transition: all 0.3s ease;
}

#theme-toggle-btn:hover {
  background: var(--bg-hover);
  transform: rotate(15deg);
}
```

#### 5.3 테마 전환 로직
```javascript
// Theme management
const ThemeManager = {
  init() {
    // localStorage에서 테마 로드 또는 시스템 설정 감지
    const savedTheme = localStorage.getItem('theme');
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const theme = savedTheme || systemTheme;

    this.setTheme(theme);
    this.initToggleButton();
    this.watchSystemTheme();
  },

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    this.updateIcon(theme);
  },

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    this.setTheme(next);
  },

  updateIcon(theme) {
    const sunIcon = document.querySelector('.sun-icon');
    const moonIcon = document.querySelector('.moon-icon');

    if (theme === 'dark') {
      sunIcon.style.display = 'none';
      moonIcon.style.display = 'block';
    } else {
      sunIcon.style.display = 'block';
      moonIcon.style.display = 'none';
    }
  },

  initToggleButton() {
    document.getElementById('theme-toggle-btn')
      .addEventListener('click', () => this.toggleTheme());
  },

  watchSystemTheme() {
    window.matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
          this.setTheme(e.matches ? 'dark' : 'light');
        }
      });
  }
};

// 초기화
ThemeManager.init();
```

#### 5.4 Markdown 콘텐츠 다크 모드 지원
```css
/* 다크 모드에서 Markdown 스타일 조정 */
[data-theme="dark"] .markdown-content {
  color: var(--text-primary);
}

[data-theme="dark"] .markdown-content a {
  color: var(--accent-color);
}

[data-theme="dark"] .markdown-content code {
  background-color: var(--code-bg);
  color: #ce9178;
}

[data-theme="dark"] .markdown-content pre {
  background-color: var(--code-bg) !important;
  border-color: var(--code-border);
}

[data-theme="dark"] .markdown-content table th {
  background-color: var(--bg-secondary);
}

[data-theme="dark"] .markdown-content blockquote {
  border-left-color: var(--accent-color);
  color: var(--text-secondary);
}
```

#### 5.5 Highlight.js 테마 전환
```javascript
function updateHighlightTheme(theme) {
  const lightTheme = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
  const darkTheme = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';

  const link = document.querySelector('link[href*="highlight.js"]');
  link.href = theme === 'dark' ? darkTheme : lightTheme;
}
```

### 성공 기준
- ✅ 라이트/다크 모드 전환 가능
- ✅ 시스템 설정 자동 감지
- ✅ localStorage에 선택 테마 저장
- ✅ 모든 UI 요소 테마 적용
- ✅ 코드 블록 테마 동기화

---

## 구현 순서

### Phase 1: 인프라 개선 (4-5시간)
1. ✅ Config Hot Reload 구현 및 테스트
2. ✅ MCP Tools 확장

### Phase 2: 사용자 경험 개선 (4-5시간)
3. ✅ 다국어 지원 (i18n) 도입
4. ✅ 검색 기능 구현

### Phase 3: UI 테마 (3-4시간)
5. ✅ 다크 모드 구현 및 테마 전환

### Phase 4: 통합 테스트 (1-2시간)
- 전체 기능 통합 테스트
- 성능 테스트
- 크로스 브라우저 테스트
- 문서 업데이트

---

## 테스트 체크리스트

### Config Hot Reload
- [ ] 설정 변경 후 1초 이내 반영
- [ ] 잘못된 설정 롤백 동작
- [ ] 로그 출력 확인
- [ ] 동시 변경 처리

### MCP Tools
- [ ] getFullTree 도구 동작
- [ ] getConfig 도구 동작
- [ ] search 도구 동작
- [ ] 에러 처리 확인

### i18n
- [ ] 영어/한국어 전환
- [ ] 브라우저 언어 감지
- [ ] 설정 저장/복원
- [ ] 모든 텍스트 번역

### 검색
- [ ] 키워드 검색 동작
- [ ] 검색 결과 표시
- [ ] 결과 클릭 시 문서 열림
- [ ] 검색어 하이라이팅

### 다크 모드
- [ ] 테마 전환 동작
- [ ] 시스템 설정 감지
- [ ] 설정 저장/복원
- [ ] 모든 UI 요소 적용
- [ ] 코드 블록 테마 동기화

---

## 성공 기준

### 전체 목표
- ✅ 서버 재시작 없이 설정 변경
- ✅ MCP 도구 8개 제공
- ✅ 2개 언어 지원 (한국어, 영어)
- ✅ 전체 문서 검색 가능
- ✅ 라이트/다크 모드 지원

### 성능 목표
- 설정 반영: < 1초
- 검색 응답: < 500ms
- 테마 전환: < 100ms
- i18n 전환: < 200ms

### 품질 목표
- 모든 기능 단위 테스트 작성
- 통합 테스트 통과
- 에러 처리 완벽
- 문서 완전성

---

## 다음 단계

Step 8 완료 후:
- Step 9: 고급 기능 추가 (북마크, 히스토리, 즐겨찾기)
- Step 10: 성능 최적화 (캐싱, 레이지 로딩, 번들 최적화)
- Step 11: 보안 강화 (CSP, rate limiting, audit logging)
- Step 12: 프로덕션 배포 (Docker, CI/CD, 모니터링)

---

**작성일**: 2025-10-25
**버전**: 1.0.0
**상태**: 계획 단계

---

## 운영 가이드 (핫 리로드 요약)

실제 구현은 `src/app.js`의 `start()`/`stop()`/`restart()` API, `src/utils/config-watcher.js`(파일 감시자), 그리고 `src/utils/backup-utils.js`(백업/복원)를 중심으로 동작합니다. 아래는 운영자·개발자를 위한 핵심 안내입니다.

- 변경 감지: watcher가 `config.json5` 변경을 감지합니다. 안정성 확보를 위해 polling(usePolling: true)과 awaitWriteFinish를 사용합니다.
- 검증: 변경 시 `loadConfig()`로 새 구성을 검증합니다. 검증 실패 시 자동 복원 절차가 실행됩니다.
- 적용: 검증 성공 시 `app.restart()`로 안전한 stop→start를 수행하며, API 라우터를 재마운트하여 런타임 참조가 갱신됩니다.
- 백업/롤백: 정상 시작 시 `config.json5.bak`에 백업을 생성합니다. 재시작 실패 시 자동 복원하고 단 한 차례 재시작을 시도합니다.

운영 체크리스트
- 변경 전: `git diff config.json5`로 변경 내용 검토
- 변경 적용: 파일 저장 후 로그와 `server:restart` 이벤트를 확인
- 이상 시: `config.json5.bak`로 복원 후 `node src/app.js` 또는 `npm start`로 수동 시작

개발자 규칙 (핵심)
1. 모듈 최상단에서 `loadConfig()`를 바로 호출해 전역 변수로 저장하지 마세요. (예: `const cfg = loadConfig();`)
2. 런타임에서 항상 `req.app.locals.config` 또는 `app.locals.config`를 통해 구성에 접근하세요.
3. 라우터/미들웨어 팩토리에서 config를 캡처할 경우 라우터 재마운트나 요청-레벨 팩토리를 사용하세요.

도구
- 감사 스크립트: `scripts/audit-config-capture.js` — 코드베이스에서 모듈-레벨 구성 캡처 패턴을 찾아 경고합니다.
- 통합 테스트: `test/test-start-stop.js`, `test/test-watcher-restart.js`

