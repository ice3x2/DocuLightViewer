# Step 7: 색인 파일 관리 및 UI 개선

## 개요

**목표**: 색인 파일 관리, UI 개선, 전체 트리 구조 API 구현

**핵심 요구사항**:
1. 기본 환영 화면을 영어로 변경
2. 구성 가능한 색인 파일 경로 지원 (절대 경로 또는 docsRoot 상대 경로)
3. 시작 시 색인 파일 자동 로드
4. 사이드바 헤더 클릭으로 색인 탐색
5. API 및 MCP 문서용 색인 경로
6. 유효하지 않은 색인 경로에 대한 폴백
7. 전체 문서 트리 구조 API

---

## 1. 설정 변경

### 1.1 설정 구조

**파일**: `config.json5`

**새 필드**:
```json5
{
  docsRoot: "/data/docs",
  apiKey: "your-api-key",
  port: 3000,

  // UI 설정
  ui: {
    title: "DocuLight",
    icon: "/images/icon.svg",

    // NEW: 색인 파일 경로
    indexFile: "/README.md",           // 주 문서 색인 (docsRoot 상대 경로)
    apiIndexFile: "/public/api-doc.md", // API 문서 색인 (프로젝트 루트 또는 절대 경로 상대)
    mcpIndexFile: "/public/mcp-doc.md"  // MCP 문서 색인 (프로젝트 루트 또는 절대 경로 상대)
  },

  // 기존 필드...
  maxUploadMB: 10,
  excludes: [],
  security: { allows: [] },
  ssl: { enabled: false }
}
```

### 1.2 경로 해석 규칙

**`ui.indexFile` (주 문서)**:
- 절대 경로: `/absolute/path/to/index.md`
- 상대 경로: `README.md` 또는 `/guide/index.md` (docsRoot 상대)
- 기본값: `null` (자동 로드 없음)

**`ui.apiIndexFile` 및 `ui.mcpIndexFile`**:
- 절대 경로: `/absolute/path/to/doc.md`
- 상대 경로: 프로젝트 루트 상대
- 기본값: `/public/api-doc.md` 및 `/public/mcp-doc.md`

**경로 검증**:
- 파일 존재 여부 확인
- 주 문서의 경로가 docsRoot 내에 있는지 확인
- 파일이 .md 확장자인지 확인
- 유효하지 않으면 기본 화면으로 폴백

---

## 2. 설정 로더 업데이트

### 2.1 향상된 설정 검증

**파일**: `src/utils/config-loader.js`

**새 검증**:
```javascript
// UI 설정 검증
if (config.ui) {
  // 색인 파일 경로 검증
  if (config.ui.indexFile) {
    const indexPath = resolveIndexPath(config.ui.indexFile, config.docsRoot);
    if (indexPath && fs.existsSync(indexPath)) {
      config.ui.resolvedIndexFile = indexPath;
      console.log(`Index file configured: ${config.ui.indexFile}`);
    } else {
      console.warn(`Index file not found: ${config.ui.indexFile}, using default welcome screen`);
      config.ui.resolvedIndexFile = null;
    }
  }

  // API/MCP 색인 파일 검증
  if (config.ui.apiIndexFile) {
    const apiIndexPath = resolveDocPath(config.ui.apiIndexFile);
    config.ui.resolvedApiIndexFile = fs.existsSync(apiIndexPath) ? apiIndexPath : null;
  }

  if (config.ui.mcpIndexFile) {
    const mcpIndexPath = resolveDocPath(config.ui.mcpIndexFile);
    config.ui.resolvedMcpIndexFile = fs.existsSync(mcpIndexPath) ? mcpIndexPath : null;
  }
}

function resolveIndexPath(indexPath, docsRoot) {
  if (path.isAbsolute(indexPath)) {
    return indexPath;
  }
  return path.join(docsRoot, indexPath);
}

function resolveDocPath(docPath) {
  if (path.isAbsolute(docPath)) {
    return docPath;
  }
  return path.join(__dirname, '../../', docPath);
}
```

---

## 3. 기본 환영 화면 (영어)

### 3.1 뷰 템플릿 업데이트

**파일**: `src/views/index.ejs`

**기존 (한글)**:
```html
<div class="welcome">
  <h1>환영합니다</h1>
  <p>좌측 트리에서 Markdown 문서를 선택하여 열람하세요.</p>
</div>
```

**새로운 (영어 및 브랜딩)**:
```html
<div class="welcome">
  <div class="welcome-logo">
    <svg width="80" height="80" viewBox="0 0 24 24">
      <!-- DocuLight 아이콘 SVG -->
    </svg>
  </div>
  <h1>Welcome to DocuLight</h1>
  <p class="welcome-subtitle">A lightweight Markdown documentation viewer</p>
  <div class="welcome-actions">
    <div class="welcome-card">
      <h3>📂 Browse Documents</h3>
      <p>Select a file from the sidebar to start reading</p>
    </div>
    <div class="welcome-card">
      <h3>🔍 Quick Start</h3>
      <p>Use Ctrl+K to search, or click any folder to explore</p>
    </div>
    <div class="welcome-card">
      <h3>📖 Documentation</h3>
      <p>
        <a href="/api/doc" target="_blank">API Reference</a> •
        <a href="/mcp/doc" target="_blank">MCP Integration</a>
      </p>
    </div>
  </div>
</div>
```

### 3.2 환영 화면 CSS

**향상된 스타일링**:
```css
.welcome {
  text-align: center;
  padding: 80px 40px;
  max-width: 900px;
  margin: 0 auto;
}

.welcome-logo {
  margin-bottom: 30px;
  opacity: 0.8;
}

.welcome h1 {
  font-size: 42px;
  font-weight: 600;
  margin-bottom: 12px;
  color: #0366d6;
}

.welcome-subtitle {
  font-size: 18px;
  color: #586069;
  margin-bottom: 50px;
}

.welcome-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 24px;
  margin-top: 40px;
}

.welcome-card {
  background: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 8px;
  padding: 24px;
  text-align: left;
  transition: all 0.2s;
}

.welcome-card:hover {
  border-color: #0366d6;
  box-shadow: 0 4px 12px rgba(3, 102, 214, 0.1);
  transform: translateY(-2px);
}

.welcome-card h3 {
  font-size: 18px;
  margin-bottom: 8px;
  color: #24292e;
}

.welcome-card p {
  font-size: 14px;
  color: #586069;
  line-height: 1.6;
}

.welcome-card a {
  color: #0366d6;
  text-decoration: none;
  font-weight: 500;
}

.welcome-card a:hover {
  text-decoration: underline;
}
```

---

## 4. 색인 파일 자동 로드

### 4.1 클라이언트 측 구현

**파일**: `public/js/app.js`

**자동 로드 로직**:
```javascript
// 페이지 로드 시
async function initializeApp() {
  try {
    // 트리 로드
    await loadTree('/');

    // 색인 파일이 구성되었는지 확인
    const indexFile = await checkIndexFile();

    if (indexFile) {
      // 색인 파일 자동 로드
      console.log('Loading index file:', indexFile);
      await loadFile(indexFile);

      // 트리에서 확장 및 강조 표시
      await expandToFile(indexFile);
    } else {
      // IndexedDB에서 마지막으로 열린 파일 확인
      const lastOpened = await getLastOpened();
      if (lastOpened) {
        await loadFile(lastOpened);
        await expandToFile(lastOpened);
      } else {
        // 환영 화면 표시
        showWelcomeScreen();
      }
    }
  } catch (error) {
    console.error('Initialization error:', error);
    showWelcomeScreen();
  }
}

// 색인 파일이 구성되었는지 확인
async function checkIndexFile() {
  try {
    const response = await fetch('/api/config/index');
    if (response.ok) {
      const data = await response.json();
      return data.indexFile || null;
    }
  } catch (error) {
    console.error('Failed to check index file:', error);
  }
  return null;
}

// 환영 화면 표시
function showWelcomeScreen() {
  const content = document.getElementById('markdown-content');
  content.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">
        <svg>...</svg>
      </div>
      <h1>Welcome to DocuLight</h1>
      <p class="welcome-subtitle">A lightweight Markdown documentation viewer</p>
      <div class="welcome-actions">
        <!-- 환영 카드 -->
      </div>
    </div>
  `;
}
```

### 4.2 서버 측 색인 설정 API

**새 엔드포인트**: `GET /api/config/index`

**파일**: `src/controllers/config-controller.js` (새 파일)

```javascript
const path = require('path');

/**
 * 색인 파일 설정 가져오기
 */
function getIndexConfig(req, res) {
  const config = req.app.locals.config;

  let indexFile = null;

  if (config.ui && config.ui.resolvedIndexFile) {
    // 절대 경로를 클라이언트를 위한 상대 경로로 변환
    const docsRoot = config.docsRoot;
    indexFile = path.relative(docsRoot, config.ui.resolvedIndexFile);

    // 선행 슬래시 확인
    if (!indexFile.startsWith('/')) {
      indexFile = '/' + indexFile;
    }
  }

  res.json({
    indexFile,
    hasIndex: !!indexFile
  });
}

module.exports = { getIndexConfig };
```

**라우트 추가**: `src/app.js`
```javascript
const { getIndexConfig } = require('./controllers/config-controller');

// API 라우터 이전
app.get('/api/config/index', getIndexConfig);
```

---

## 5. 사이드바 헤더 탐색

### 5.1 사이드바 헤더 업데이트

**파일**: `src/views/index.ejs`

**기존**:
```html
<div class="sidebar-title">
  <img src="<%= uiIcon %>" alt="icon" class="sidebar-icon">
  <h1 title="<%= uiTitle %>"><%= uiTitle %></h1>
</div>
```

**새로운 (클릭 가능)**:
```html
<div class="sidebar-title" id="sidebar-title" role="button" tabindex="0" title="Go to home">
  <img src="<%= uiIcon %>" alt="icon" class="sidebar-icon">
  <h1><%= uiTitle %></h1>
</div>
```

**CSS 업데이트**:
```css
.sidebar-title {
  cursor: pointer;
  transition: opacity 0.2s;
  user-select: none;
}

.sidebar-title:hover {
  opacity: 0.8;
}

.sidebar-title:active {
  opacity: 0.6;
}
```

**JavaScript**:
```javascript
// 사이드바 헤더 클릭 처리
document.getElementById('sidebar-title').addEventListener('click', async () => {
  const indexFile = await checkIndexFile();

  if (indexFile) {
    // 색인 파일 로드
    await loadFile(indexFile);
    await expandToFile(indexFile);
  } else {
    // 환영 화면 표시
    showWelcomeScreen();
    updateBreadcrumb('Home');
  }
});

// 키보드 탐색 처리 (Enter/Space)
document.getElementById('sidebar-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    document.getElementById('sidebar-title').click();
  }
});
```

---

## 6. API/MCP 문서 색인

### 6.1 문서 컨트롤러 업데이트

**파일**: `src/controllers/doc-controller.js`

**향상된 함수**:
```javascript
const path = require('path');
const fs = require('fs');

/**
 * API 또는 MCP 문서 제공
 */
function getDocumentation(req, res, next) {
  const docType = req.params.docType; // 'api' 또는 'mcp'
  const config = req.app.locals.config;

  // 문서 유형 검증
  if (!['api', 'mcp'].includes(docType)) {
    return res.status(404).json({
      error: {
        code: 'INVALID_DOC_TYPE',
        message: 'Documentation type must be "api" or "mcp"'
      }
    });
  }

  // 설정에서 사용자 정의 색인 파일을 가져오려고 시도
  let docPath;
  if (docType === 'api' && config.ui?.resolvedApiIndexFile) {
    docPath = config.ui.resolvedApiIndexFile;
  } else if (docType === 'mcp' && config.ui?.resolvedMcpIndexFile) {
    docPath = config.ui.resolvedMcpIndexFile;
  } else {
    // 기본값으로 폴백
    const docFile = `${docType}-doc.md`;
    docPath = path.join(__dirname, '../../public', docFile);
  }

  // 문서 존재 여부 확인
  if (!fs.existsSync(docPath)) {
    return res.status(404).json({
      error: {
        code: 'DOC_NOT_FOUND',
        message: `Documentation file not found: ${path.basename(docPath)}`
      }
    });
  }

  try {
    const content = fs.readFileSync(docPath, 'utf-8');
    const stats = fs.statSync(docPath);

    res.json({
      content,
      type: docType,
      path: `/${docType}/doc`,
      size: stats.size,
      modified: stats.mtime,
      isCustom: !!(docType === 'api' ? config.ui?.resolvedApiIndexFile : config.ui?.resolvedMcpIndexFile)
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getDocumentation };
```

---

## 7. 전체 트리 구조 API

### 7.1 새 API 엔드포인트

**엔드포인트**: `GET /api/tree/full`

**목적**: 완전한 문서 트리 구조 반환 (경로 매개변수 없음)

**파일**: `src/controllers/tree-controller.js`

**새 함수**:
```javascript
/**
 * 전체 문서 트리 구조 가져오기
 */
async function getFullTree(req, res, next) {
  const config = req.app.locals.config;
  const logger = req.app.locals.logger;

  try {
    const tree = await buildTree(config.docsRoot, config.docsRoot, config.excludes);

    res.json({
      root: config.docsRoot,
      tree,
      timestamp: new Date().toISOString(),
      totalFiles: countFiles(tree),
      totalDirectories: countDirectories(tree)
    });
  } catch (error) {
    logger.error('Failed to build full tree', { error: error.message });
    next(error);
  }
}

/**
 * 트리의 파일 개수 세기
 */
function countFiles(node) {
  if (node.type === 'file') return 1;
  if (node.type === 'directory' && node.children) {
    return node.children.reduce((sum, child) => sum + countFiles(child), 0);
  }
  return 0;
}

/**
 * 트리의 디렉터리 개수 세기
 */
function countDirectories(node) {
  if (node.type === 'file') return 0;
  if (node.type === 'directory' && node.children) {
    return 1 + node.children.reduce((sum, child) => sum + countDirectories(child), 0);
  }
  return node.type === 'directory' ? 1 : 0;
}

module.exports = { getTree, getFullTree };
```

**라우트 추가**: `src/routes/api.js`
```javascript
const { getTree, getFullTree } = require('../controllers/tree-controller');

// 공개 라우트
router.get('/tree/full', getFullTree);  // NEW: 전체 트리
router.get('/tree', getTree);           // 기존: 부분 트리
```

### 7.2 전체 트리용 MCP 도구

**파일**: `DocuLight-mcp-server/src/tools/list.js`

**향상된 함수**:
```javascript
export async function listDocuments(config, path) {
  const client = new DocuLightClient(config.baseUrl, config.apiKey);

  try {
    let result;

    // 경로가 루트이거나 비어 있으면 전체 트리 가져오기
    if (!path || path === '/' || path === '') {
      result = await client.getFullTree();

      // 전체 트리 형식화
      const treeText = formatFullTree(result.tree);

      return {
        content: [
          {
            type: 'text',
            text: `# Full Document Tree\n\nRoot: ${result.root}\nFiles: ${result.totalFiles}\nDirectories: ${result.totalDirectories}\n\n${treeText}`
          }
        ]
      };
    } else {
      // 특정 경로에 대한 부분 트리 가져오기
      result = await client.getTree(path);
      const treeText = formatTree(result.children || [result]);

      return {
        content: [
          {
            type: 'text',
            text: `# Documents at ${path}\n\n${treeText}`
          }
        ]
      };
    }
  } catch (error) {
    throw new Error(`Failed to list documents: ${error.message}`);
  }
}

function formatFullTree(node, indent = 0) {
  let output = '';
  const prefix = '  '.repeat(indent);
  const icon = node.type === 'directory' ? '📁' : '📄';

  output += `${prefix}${icon} ${node.name}\n`;

  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      output += formatFullTree(child, indent + 1);
    }
  }

  return output;
}
```

**클라이언트 업데이트**: `DocuLight-mcp-server/src/client.js`
```javascript
/**
 * 전체 디렉터리 트리 가져오기
 */
async getFullTree() {
  return this.request('GET', '/tree/full');
}
```

---

## 8. 설정 파일 핫 리로드 (선택사항)

### 8.1 설정 파일 감시

**파일**: `src/app.js`

**파일 감시자 추가**:
```javascript
const fs = require('fs');
const path = require('path');

// 설정 파일 변경 사항 감시
const configPath = path.join(__dirname, '../config.json5');

fs.watch(configPath, (eventType) => {
  if (eventType === 'change') {
    logger.info('Config file changed, reloading...');

    try {
      // 설정 다시 로드
      delete require.cache[require.resolve('./utils/config-loader')];
      const { loadConfig } = require('./utils/config-loader');
      const newConfig = loadConfig();

      // app.locals.config 업데이트
      app.locals.config = newConfig;

      logger.info('Config reloaded successfully');
    } catch (error) {
      logger.error('Failed to reload config', { error: error.message });
    }
  }
});
```

---

## 9. 구현 단계

### Phase 1: 설정 및 백엔드 (2-3시간)

1. ✅ `config.example.json5`를 새로운 UI 필드로 업데이트
2. ✅ `config-loader.js`를 경로 해석 및 검증으로 향상
3. ✅ 색인 설정 API용 `config-controller.js` 생성
4. ✅ 사용자 정의 색인 경로용 `doc-controller.js` 업데이트
5. ✅ `tree-controller.js`에 `getFullTree` 함수 추가
6. ✅ `/api/config/index` 및 `/api/tree/full` 라우트 추가

### Phase 2: 프론트엔드 UI (2-3시간)

1. ✅ 환영 화면을 영어로 향상된 디자인으로 업데이트
2. ✅ 환영 화면 CSS 추가
3. ✅ `checkIndexFile()` 함수 구현
4. ✅ `showWelcomeScreen()` 함수 구현
5. ✅ 자동 로드 로직을 사용하여 `initializeApp()` 업데이트
6. ✅ 사이드바 헤더 클릭 핸들러 추가
7. ✅ 사이드바 헤더의 키보드 탐색 추가

### Phase 3: MCP 서버 업데이트 (1-2시간)

1. ✅ `getFullTree()` 메서드로 `client.js` 업데이트
2. ✅ 전체 트리 지원을 위한 `list.js` 도구 향상
3. ✅ MCP 전체 트리 목록 테스트

### Phase 4: 테스트 및 문서화 (1-2시간)

1. ✅ 유효한 경로로 색인 파일 자동 로드 테스트
2. ✅ 유효하지 않은 경로로 폴백 테스트
3. ✅ 사이드바 헤더 탐색 테스트
4. ✅ 사용자 정의 API/MCP 색인 파일 테스트
5. ✅ 전체 트리 API 엔드포인트 테스트
6. ✅ MCP 전체 트리 도구 테스트
7. ✅ README.md를 새 구성 옵션으로 업데이트

**예상 총 소요 시간**: 6-10시간

---

## 10. 설정 예제

### 10.1 기본 설정

```json5
{
  docsRoot: "/data/docs",
  apiKey: "your-api-key",

  ui: {
    title: "My Documentation",
    icon: "/images/icon.svg",
    indexFile: "/README.md"  // 시작 시 README.md 자동 로드
  }
}
```

### 10.2 고급 설정

```json5
{
  docsRoot: "/data/docs",
  apiKey: "your-api-key",

  ui: {
    title: "Company Docs",
    icon: "/images/logo.png",

    // 사용자 정의 색인 파일
    indexFile: "/welcome.md",                    // 주 문서 색인
    apiIndexFile: "/docs/api/reference.md",      // 사용자 정의 API 문서
    mcpIndexFile: "/docs/integration/mcp.md"     // 사용자 정의 MCP 문서
  }
}
```

### 10.3 자동 로드 없음 설정

```json5
{
  docsRoot: "/data/docs",
  apiKey: "your-api-key",

  ui: {
    title: "DocuLight",
    icon: "/images/icon.svg"
    // indexFile 지정 없음 - 환영 화면 표시
  }
}
```

---

## 11. 테스트 계획

### 11.1 설정 검증 테스트

```bash
# 테스트 1: 유효한 상대 경로
echo '{ ui: { indexFile: "/README.md" } }' >> config.json5
curl http://localhost:3000/api/config/index
# 예상: { "indexFile": "/README.md", "hasIndex": true }

# 테스트 2: 유효하지 않은 경로
echo '{ ui: { indexFile: "/nonexistent.md" } }' >> config.json5
curl http://localhost:3000/api/config/index
# 예상: { "indexFile": null, "hasIndex": false }

# 테스트 3: 절대 경로
echo '{ ui: { indexFile: "/absolute/path/to/doc.md" } }' >> config.json5
# 예상: 파일이 존재하면 작동, 그렇지 않으면 null
```

### 11.2 자동 로드 테스트

```bash
# 테스트 1: 브라우저 열기, 색인 파일 자동 로드되어야 함
open http://localhost:3000

# 테스트 2: 사이드바 헤더 클릭, 색인으로 돌아가야 함
# (수동 브라우저 테스트)

# 테스트 3: 색인 파일 없음, 환영 화면 표시되어야 함
# (수동 브라우저 테스트)
```

### 11.3 전체 트리 API 테스트

```bash
# 테스트 1: 전체 트리 가져오기
curl http://localhost:3000/api/tree/full | jq

# 예상 출력:
# {
#   "root": "/data/docs",
#   "tree": { ... },
#   "totalFiles": 42,
#   "totalDirectories": 15
# }

# 테스트 2: MCP 전체 트리
echo '{"name":"DocuLight_list","arguments":{}}' | \
  DocuLight_URL=http://localhost:3000 \
  DocuLight_API_KEY=your-key \
  node DocuLight-mcp-server/src/index.js
```

---

## 12. 성공 기준

- [ ] 환영 화면이 영어이고 향상된 디자인 사용
- [ ] 설정이 `ui.indexFile`, `ui.apiIndexFile`, `ui.mcpIndexFile` 지원
- [ ] 색인 파일이 시작 시 자동 로드됨 (구성된 경우)
- [ ] 사이드바 헤더 클릭으로 색인 탐색
- [ ] 유효하지 않은 색인 경로가 환영 화면으로 폴백
- [ ] `/api/config/index`이 올바른 색인 파일 경로 반환
- [ ] `/api/tree/full`이 완전한 트리 구조 반환
- [ ] 사용자 정의 API/MCP 색인 파일이 올바르게 로드됨
- [ ] MCP `DocuLight_list` 도구가 전체 트리 지원
- [ ] 모든 기능이 핫 설정 리로드에서 작동

---

## 13. 향후 개선사항

- [ ] 언어별 여러 색인 파일
- [ ] 색인 파일 템플릿
- [ ] 자동 생성된 목차
- [ ] 색인과 검색 통합
- [ ] 설정 UI의 색인 파일 미리 보기
- [ ] 큰 문서 세트용 트리 캐싱

---

**버전**: 1.0.0
**마지막 업데이트**: 2025-10-24
