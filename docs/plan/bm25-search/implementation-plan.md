# BM25 검색 API 구현 계획서

> 작성일: 2026-02-27
> 기반 조사: `research-report.md`
> 대상: DocuLight Viewer v0.10.5+

---

## 1. 목표

MCP 자동 저장(`mcpAutoSave`)으로 저장된 마크다운 문서에 대해 BM25 전문 검색 기능을 제공한다.

**두 개의 MCP 도구를 추가한다:**

| 도구 | 용도 |
|------|------|
| `search_documents` | 본문 + 프론트매터 메타데이터 통합 BM25 검색 |
| `search_projects` | 프론트매터의 project/description 필드로 프로젝트 목록/검색 |

---

## 2. 전제 조건 (이미 구현됨)

| 항목 | 위치 | 상태 |
|------|------|------|
| `mcpAutoSave` 설정 | `index.js:116` | 완료 |
| `mcpAutoSavePath` 설정 | `index.js:117` | 완료 |
| `saveMcpFile()` 저장 로직 | `mcp-http.mjs:45`, `mcp-server.mjs` | 완료 |
| 프론트매터 주입 | `frontmatter.js` (`injectFrontmatter`) | 완료 |
| 프론트매터 파싱 | `frontmatter.js` (`parseSimpleYaml`) | 완료 |
| Settings UI | `settings.html/js` (토글 + 경로 + 찾아보기) | 완료 |
| 저장 구조 | `{savePath}/{YYYY-MM-DD}/{HHMMSS_제목.md}` | 완료 |

---

## 3. 기술 결정 요약

| 항목 | 선택 | 근거 |
|------|------|------|
| BM25 엔진 | `wink-bm25-text-search` v3.x | 필드별 가중치(BM25F), 커스텀 토크나이저, 인덱스 직렬화 |
| 토크나이저 | 어절 + 조사 제거 + Character Bi-gram 복합 | 네이티브 의존성 제로, 한국어 복합어/띄어쓰기 변이 대응 |
| 프론트매터 파싱 | 기존 `frontmatter.js` 확장 | 외부 라이브러리 불필요 |
| 인덱스 저장 | JSON 파일 (`{savePath}/.doculight-search-index.json`) | wink의 `exportJSON()`/`importJSON()` 직접 활용 |
| 추가 npm | `wink-bm25-text-search` 1개 (제로 하위 의존성, ~30KB) | |

---

## 4. 아키텍처

### 4.1 새 파일

| 파일 | 모듈 | 역할 |
|------|------|------|
| `src/main/search-engine.js` | CJS | BM25 인덱스 관리, 검색, 인덱스 직렬화 핵심 모듈 |
| `src/main/tokenizer.js` | CJS | 한국어 복합 토크나이저 (어절+조사제거+bi-gram) |

### 4.2 수정 파일

| 파일 | 변경 내용 |
|------|----------|
| `package.json` | `wink-bm25-text-search` 의존성 추가 |
| `src/main/mcp-http.mjs` | `search_documents`, `search_projects` 도구 정의 + 핸들러 |
| `src/main/mcp-server.mjs` | `search_documents`, `search_projects` Zod 스키마 + IPC 핸들러 |
| `src/main/index.js` | IPC 라우팅 (`search_documents`, `search_projects`, `rebuild_index`) + 앱 시작 시 인덱스 로드 |
| `src/main/frontmatter.js` | `parseFrontmatter(content)` 래퍼 함수 추가 (파일 전체에서 프론트매터 추출+파싱+본문 분리) |
| `CLAUDE.md` | MCP Tools 테이블에 새 도구 추가 |

### 4.3 데이터 흐름

```
[MCP 클라이언트]
    │
    ├─ search_documents({ query: "전자문서" })
    │       ↓
    │   mcp-server.mjs (stdio) ──IPC──→ index.js ──→ searchEngine.search(query)
    │   mcp-http.mjs (HTTP)    ──직접──→ searchEngine.search(query)
    │       ↓
    │   search-engine.js:
    │     1. 토크나이저로 쿼리 처리
    │     2. wink BM25 search()
    │     3. 결과에 프론트매터 메타데이터 첨부
    │       ↓
    │   ← 결과 반환: [{filePath, score, title, project, description, snippet}]
    │
    └─ search_projects({ query: "DocuLight" })
            ↓
        searchEngine.searchProjects(query)
            ↓
        프론트매터 project/description 필드만 대상으로 BM25 검색
            ↓
        ← 결과 반환: [{project, description, documentCount, documents}]
```

### 4.4 인덱스 생명주기

```
[앱 시작]
  → mcpAutoSave && mcpAutoSavePath 확인
  → 인덱스 파일 존재? → importJSON() → 검색 가능
  → 없으면? → 백그라운드 전체 스캔 → consolidate → exportJSON()

[문서 저장 시 (saveMcpFile 호출 후)]
  → searchEngine.markDirty()
  → 다음 검색 요청 시 lazy rebuild 또는 즉시 rebuild

[설정 변경 시 (mcpAutoSavePath 변경)]
  → 인덱스 무효화 → 새 경로로 재빌드

[수동 rebuild]
  → rebuild_index IPC 액션으로 강제 재빌드 가능
```

---

## 5. 모듈 상세 설계

### 5.1 `src/main/tokenizer.js`

```javascript
// 한국어 복합 토크나이저
// wink-bm25-text-search의 definePrepTasks()에 전달할 함수

'use strict';

// 한글 조사/어미 패턴 (빈도 높은 것만)
const KO_SUFFIXES = /(?:을|를|이|가|은|는|에|의|로|와|과|에서|까지|부터|으로|에게|한테|하다|합니다|입니다|하는|하여|된|되는|되어|했다|됩니다|입니까)$/;

/**
 * 한국어 + 영문 복합 토크나이저
 *
 * Layer 1: 어절 단위 (공백 분리)
 * Layer 2: 한글 조사/어미 단순 제거
 * Layer 3: Character Bi-gram (공백 제거 후)
 *
 * @param {string} text
 * @returns {string[]} tokens
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];

  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s가-힣\u3040-\u30FF\u4E00-\u9FFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return [];

  const tokens = [];
  const words = normalized.split(' ');

  // Layer 1: 원형 어절
  for (const w of words) {
    if (w.length > 0) tokens.push(w);
  }

  // Layer 2: 한글 조사/어미 제거
  for (const w of words) {
    if (/[가-힣]/.test(w)) {
      const stripped = w.replace(KO_SUFFIXES, '');
      if (stripped && stripped !== w && stripped.length >= 2) {
        tokens.push(stripped);
      }
    }
  }

  // Layer 3: Character Bi-gram
  const flat = words.join('');  // 공백 제거
  for (let i = 0; i < flat.length - 1; i++) {
    tokens.push(flat.substring(i, i + 2));
  }

  return tokens;
}

module.exports = { tokenize };
```

### 5.2 `src/main/search-engine.js`

```javascript
'use strict';

const bm25 = require('wink-bm25-text-search');
const path = require('path');
const fs = require('fs');
const { tokenize } = require('./tokenizer');
const { parseSimpleYaml } = require('./frontmatter');

const INDEX_FILENAME = '.doculight-search-index.json';
const FM_REGEX = /^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/;

class SearchEngine {
  constructor(store) {
    this.store = store;
    this.engine = null;         // wink BM25 인스턴스
    this.docMeta = new Map();   // docId → { title, project, docName, description, filePath, date }
    this.dirty = false;
    this.initialized = false;
  }

  // ─── 초기화 ─────────────────────────────────────────

  /**
   * 앱 시작 시 호출. 인덱스 파일이 있으면 로드, 없으면 전체 빌드.
   */
  async initialize() {
    const savePath = this.store.get('mcpAutoSavePath', '');
    if (!savePath) return;

    const indexPath = path.join(savePath, INDEX_FILENAME);
    try {
      if (fs.existsSync(indexPath)) {
        await this._loadIndex(indexPath);
      } else {
        await this.rebuild();
      }
      this.initialized = true;
    } catch (err) {
      console.error('[doculight] Search index init failed:', err.message);
      // 실패 시 빈 엔진으로 시작
      this._createFreshEngine();
      this.initialized = true;
    }
  }

  // ─── 인덱스 빌드 ───────────────────────────────────

  /**
   * mcpAutoSavePath 전체를 스캔하여 인덱스를 재빌드한다.
   */
  async rebuild() {
    const savePath = this.store.get('mcpAutoSavePath', '');
    if (!savePath) throw new Error('mcpAutoSavePath not configured');

    this._createFreshEngine();

    const mdFiles = await this._scanMarkdownFiles(savePath);
    for (const filePath of mdFiles) {
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        this._indexDocument(filePath, content);
      } catch (err) {
        console.error(`[doculight] Failed to index ${filePath}:`, err.message);
      }
    }

    this.engine.consolidate();
    this.dirty = false;

    // 인덱스 저장
    await this._saveIndex(path.join(savePath, INDEX_FILENAME));

    return { indexed: mdFiles.length };
  }

  // ─── 검색: search_documents ─────────────────────────

  /**
   * BM25 전문 검색 (본문 + 프론트매터 통합)
   *
   * @param {string} query - 검색어
   * @param {object} [options]
   * @param {number} [options.limit=20] - 최대 결과 수
   * @param {string} [options.project] - 프로젝트 필터
   * @returns {Array<{filePath, score, title, project, docName, description, snippet}>}
   */
  search(query, { limit = 20, project } = {}) {
    if (!this.engine) return [];

    // dirty 상태면 lazy rebuild (동기적으로는 불가하므로 현재 인덱스로 검색)
    const filterFn = project
      ? (ovFields) => ovFields.project === project
      : undefined;

    const results = this.engine.search(query, limit, filterFn);

    return results.map(([docId, score]) => {
      const meta = this.docMeta.get(docId) || {};
      return {
        filePath: docId,
        score: Math.round(score * 1000) / 1000,
        title: meta.title || path.basename(docId, '.md'),
        project: meta.project || null,
        docName: meta.docName || null,
        description: meta.description || null,
        date: meta.date || null,
        snippet: meta.snippet || null
      };
    });
  }

  // ─── 검색: search_projects ──────────────────────────

  /**
   * 프론트매터의 project/description 필드로 프로젝트 검색
   *
   * @param {string} [query] - 검색어 (비어있으면 전체 프로젝트 목록)
   * @param {number} [limit=20]
   * @returns {Array<{project, description, documentCount, documents}>}
   */
  searchProjects(query, limit = 20) {
    // docMeta에서 project별로 그룹핑
    const projectMap = new Map();
    for (const [docId, meta] of this.docMeta) {
      const proj = meta.project || '(no project)';
      if (!projectMap.has(proj)) {
        projectMap.set(proj, {
          project: proj,
          description: meta.description || '',
          documents: []
        });
      }
      projectMap.get(proj).documents.push({
        filePath: docId,
        title: meta.title || path.basename(docId, '.md'),
        docName: meta.docName || null,
        date: meta.date || null
      });
    }

    let projects = Array.from(projectMap.values());

    // 쿼리가 있으면 BM25로 project+description 검색
    if (query && query.trim()) {
      const queryTokens = tokenize(query.toLowerCase());
      // 간단한 토큰 매칭 점수 계산
      projects = projects
        .map(p => {
          const targetTokens = tokenize(`${p.project} ${p.description}`.toLowerCase());
          let score = 0;
          for (const qt of queryTokens) {
            for (const tt of targetTokens) {
              if (tt.includes(qt) || qt.includes(tt)) score++;
            }
          }
          return { ...p, _score: score };
        })
        .filter(p => p._score > 0)
        .sort((a, b) => b._score - a._score);
    }

    return projects.slice(0, limit).map(p => ({
      project: p.project,
      description: p.description,
      documentCount: p.documents.length,
      documents: p.documents
    }));
  }

  // ─── 인덱스 갱신 ───────────────────────────────────

  /**
   * 새 문서가 저장되면 dirty 마킹.
   * 다음 rebuild() 호출 시 전체 재인덱싱.
   */
  markDirty() {
    this.dirty = true;
  }

  /**
   * dirty 상태면 rebuild 후 리턴.
   */
  async ensureFresh() {
    if (this.dirty || !this.initialized) {
      await this.rebuild();
    }
  }

  // ─── 내부 메서드 ───────────────────────────────────

  _createFreshEngine() {
    this.engine = bm25();
    this.docMeta = new Map();

    // BM25F 필드 가중치 설정
    this.engine.defineConfig({
      fldWeights: {
        title: 5,
        project: 4,
        docName: 3,
        description: 2,
        body: 1
      },
      bm25Params: { k1: 1.2, b: 0.75, k: 1 },
      ovFldNames: ['project', 'docName']
    });

    // 한국어 복합 토크나이저 등록
    this.engine.definePrepTasks([tokenize]);
  }

  /**
   * 단일 문서를 인덱스에 추가
   */
  _indexDocument(filePath, content) {
    // 프론트매터 추출
    const fmMatch = content.match(FM_REGEX);
    let fmData = {};
    let body = content;

    if (fmMatch) {
      fmData = parseSimpleYaml(fmMatch[1] || '');
      body = content.slice(fmMatch[0].length);
    }

    const title = fmData.title || fmData.docName || this._extractTitle(body) || path.basename(filePath, '.md');

    // wink BM25에 문서 추가
    const doc = {
      title: title,
      project: fmData.project || '',
      docName: fmData.docName || '',
      description: fmData.description || '',
      body: body
    };

    this.engine.addDoc(doc, filePath);

    // 메타데이터 저장 (검색 결과에 첨부용)
    this.docMeta.set(filePath, {
      title,
      project: fmData.project || null,
      docName: fmData.docName || null,
      description: fmData.description || null,
      date: fmData.date || null,
      snippet: body.replace(/\s+/g, ' ').trim().slice(0, 200)
    });
  }

  _extractTitle(content) {
    const m = content.match(/^#{1,6}\s+(.+)/m);
    return m ? m[1].trim() : null;
  }

  /**
   * mcpAutoSavePath 하위 모든 .md 파일 재귀 스캔
   */
  async _scanMarkdownFiles(dirPath) {
    const results = [];
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;  // 숨김 파일/폴더 스킵
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = await this._scanMarkdownFiles(fullPath);
        results.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  /**
   * 인덱스를 JSON 파일로 저장
   */
  async _saveIndex(indexPath) {
    try {
      const indexJson = this.engine.exportJSON();
      const metaJson = JSON.stringify(Object.fromEntries(this.docMeta));
      const combined = JSON.stringify({ index: indexJson, meta: metaJson });
      await fs.promises.writeFile(indexPath, combined, 'utf-8');
      console.log(`[doculight] Search index saved: ${indexPath}`);
    } catch (err) {
      console.error(`[doculight] Failed to save index: ${err.message}`);
    }
  }

  /**
   * JSON 파일에서 인덱스 복원
   */
  async _loadIndex(indexPath) {
    const raw = await fs.promises.readFile(indexPath, 'utf-8');
    const { index: indexJson, meta: metaJson } = JSON.parse(raw);

    this.engine = bm25();
    this.engine.definePrepTasks([tokenize]);
    this.engine.importJSON(indexJson);

    const metaObj = JSON.parse(metaJson);
    this.docMeta = new Map(Object.entries(metaObj));

    console.log(`[doculight] Search index loaded: ${this.docMeta.size} documents`);
  }
}

module.exports = { SearchEngine };
```

### 5.3 `src/main/frontmatter.js` 변경

기존 코드에 `parseFrontmatter()` 래퍼 함수 추가:

```javascript
/**
 * 파일 내용에서 프론트매터 블록을 추출하고 파싱한다.
 *
 * @param {string} content - 전체 마크다운 내용
 * @returns {{ data: object, body: string }} data: 파싱된 key-value, body: 프론트매터 제거된 본문
 */
function parseFrontmatter(content) {
  const fmRegex = /^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/;
  const match = content.match(fmRegex);
  if (match) {
    return {
      data: parseSimpleYaml(match[1] || ''),
      body: content.slice(match[0].length)
    };
  }
  return { data: {}, body: content };
}

module.exports = { injectFrontmatter, parseSimpleYaml, buildYamlBlock, parseFrontmatter };
```

---

## 6. MCP 도구 스키마

### 6.1 `search_documents`

```
이름: search_documents
설명: Search saved markdown documents using BM25 full-text search.
      Searches across document body and frontmatter metadata (title, project, description).
      Requires mcpAutoSave to be enabled with a configured save path.

파라미터:
  query       string  (required)  검색어 (한국어/영문 모두 지원)
  limit       integer (optional)  최대 결과 수 (기본 20, 최소 1, 최대 100)
  project     string  (optional)  특정 프로젝트로 필터링

반환:
  results: [
    {
      filePath: string,      // 문서 절대 경로
      score: number,         // BM25 점수
      title: string,         // 문서 제목
      project: string|null,  // 프로젝트명 (프론트매터)
      docName: string|null,  // 문서명 (프론트매터)
      description: string|null, // 설명 (프론트매터)
      date: string|null,     // 날짜 (프론트매터)
      snippet: string|null   // 본문 미리보기 (200자)
    }
  ]
  totalIndexed: number       // 인덱스에 등록된 전체 문서 수
```

### 6.2 `search_projects`

```
이름: search_projects
설명: Search or list projects from saved document frontmatter metadata.
      Returns project names with descriptions and associated document counts.
      Requires mcpAutoSave to be enabled with a configured save path.

파라미터:
  query   string  (optional)  프로젝트명/설명 검색어 (비어있으면 전체 목록)
  limit   integer (optional)  최대 결과 수 (기본 20, 최소 1, 최대 100)

반환:
  projects: [
    {
      project: string,        // 프로젝트명
      description: string,    // 대표 설명
      documentCount: number,  // 소속 문서 수
      documents: [
        {
          filePath: string,
          title: string,
          docName: string|null,
          date: string|null
        }
      ]
    }
  ]
```

---

## 7. 수정 파일별 변경 사항

### 7.1 `package.json`

```diff
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1",
    "electron-store": "^8.2.0",
-   "pdf-lib": "^1.17.1"
+   "pdf-lib": "^1.17.1",
+   "wink-bm25-text-search": "^3.1.2"
  }
```

### 7.2 `src/main/index.js`

**변경 1:** SearchEngine 인스턴스 생성 + 앱 시작 시 초기화

```javascript
const { SearchEngine } = require('./search-engine');
const searchEngine = new SearchEngine(store);

// app.whenReady() 내부에서:
if (store.get('mcpAutoSave', false) && store.get('mcpAutoSavePath', '')) {
  searchEngine.initialize().catch(err => {
    console.error('[doculight] Search engine init error:', err.message);
  });
}
```

**변경 2:** IPC 핸들러에 검색 액션 추가

```javascript
// handleIpcMessage switch 문 내:
case 'search_documents':
  await searchEngine.ensureFresh();
  result = {
    results: searchEngine.search(params.query, {
      limit: params.limit,
      project: params.project
    }),
    totalIndexed: searchEngine.docMeta.size
  };
  break;

case 'search_projects':
  await searchEngine.ensureFresh();
  result = {
    projects: searchEngine.searchProjects(params.query, params.limit)
  };
  break;

case 'rebuild_index':
  result = await searchEngine.rebuild();
  break;
```

**변경 3:** saveMcpFile 호출 후 인덱스 dirty 마킹

```javascript
// 기존 saveMcpFile 호출 후:
searchEngine.markDirty();
```

**변경 4:** MCP HTTP 서버에 searchEngine 전달

```javascript
// mcp-http 동적 import 시:
const mcpHttp = await import('./mcp-http.mjs');
mcpHttp.startServer(windowManager, store, searchEngine);
```

### 7.3 `src/main/mcp-http.mjs`

**변경 1:** TOOLS 배열에 `search_documents`, `search_projects` 추가

**변경 2:** `createToolHandlers(windowManager, store, searchEngine)`에 핸들러 추가

```javascript
async search_documents({ query, limit, project }) {
  if (!query) {
    return { isError: true, content: [{ type: 'text', text: 'query is required.' }] };
  }
  await searchEngine.ensureFresh();
  const results = searchEngine.search(query, { limit: limit || 20, project });
  const totalIndexed = searchEngine.docMeta.size;

  if (results.length === 0) {
    return { content: [{ type: 'text', text: `No results found for "${query}". (${totalIndexed} documents indexed)` }] };
  }

  const lines = results.map((r, i) =>
    `${i + 1}. [${r.score}] ${r.title}${r.project ? ` (${r.project})` : ''}\n   ${r.filePath}\n   ${r.snippet || ''}`
  );
  return {
    content: [{
      type: 'text',
      text: `Found ${results.length} result(s) for "${query}" (${totalIndexed} indexed):\n\n${lines.join('\n\n')}`
    }]
  };
},

async search_projects({ query, limit }) {
  await searchEngine.ensureFresh();
  const projects = searchEngine.searchProjects(query, limit || 20);

  if (projects.length === 0) {
    return { content: [{ type: 'text', text: query ? `No projects found for "${query}".` : 'No projects found.' }] };
  }

  const lines = projects.map(p =>
    `- **${p.project}** (${p.documentCount} docs)${p.description ? `: ${p.description}` : ''}`
  );
  return {
    content: [{
      type: 'text',
      text: `${query ? `Projects matching "${query}"` : 'All projects'} (${projects.length}):\n\n${lines.join('\n')}`
    }]
  };
}
```

### 7.4 `src/main/mcp-server.mjs`

stdio MCP에 동일한 두 도구 등록 (Zod 스키마 + `sendIpcRequest` 호출):

```javascript
// Tool: search_documents
server.tool(
  'search_documents',
  'Search saved markdown documents using BM25 full-text search. Searches across body and frontmatter metadata.',
  {
    query:   z.string().describe('Search query (Korean and English supported)'),
    limit:   z.number().int().min(1).max(100).default(20).describe('Max results'),
    project: z.string().optional().describe('Filter by project name')
  },
  async ({ query, limit, project }) => {
    try {
      const result = await sendIpcRequest('search_documents', { query, limit, project });
      // ... 결과 포맷팅
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool: search_projects
server.tool(
  'search_projects',
  'Search or list projects from saved document frontmatter metadata.',
  {
    query: z.string().optional().describe('Search query for project name/description (omit for full list)'),
    limit: z.number().int().min(1).max(100).default(20).describe('Max results')
  },
  async ({ query, limit }) => {
    try {
      const result = await sendIpcRequest('search_projects', { query, limit });
      // ... 결과 포맷팅
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);
```

---

## 8. 구현 Phase

### Phase 1: 기반 모듈 (tokenizer + search-engine)

| # | 작업 | 파일 |
|---|------|------|
| 1-1 | `npm install wink-bm25-text-search` | `package.json` |
| 1-2 | 한국어 복합 토크나이저 구현 | `src/main/tokenizer.js` (신규) |
| 1-3 | `parseFrontmatter()` 래퍼 추가 | `src/main/frontmatter.js` |
| 1-4 | SearchEngine 클래스 구현 | `src/main/search-engine.js` (신규) |

**검증:** 단위 테스트 또는 수동 테스트로 토크나이저 + 인덱싱 + 검색 동작 확인

### Phase 2: MCP 도구 통합

| # | 작업 | 파일 |
|---|------|------|
| 2-1 | IPC 라우팅 추가 + SearchEngine 인스턴스 생성 | `src/main/index.js` |
| 2-2 | HTTP MCP 도구 + 핸들러 추가 | `src/main/mcp-http.mjs` |
| 2-3 | stdio MCP 도구 + 핸들러 추가 | `src/main/mcp-server.mjs` |
| 2-4 | `saveMcpFile()` 후 `markDirty()` 호출 연결 | `index.js` + `mcp-http.mjs` |

**검증:** MCP 클라이언트에서 `search_documents`, `search_projects` 도구 호출 테스트

### Phase 3: 인덱스 영속화 + 최적화

| # | 작업 | 파일 |
|---|------|------|
| 3-1 | 앱 시작 시 인덱스 로드 | `index.js` |
| 3-2 | rebuild 후 JSON 저장 | `search-engine.js` |
| 3-3 | 설정 변경 감지 시 인덱스 무효화 | `index.js` |
| 3-4 | CLAUDE.md 문서 업데이트 | `CLAUDE.md` |

**검증:** 앱 재시작 후 인덱스 즉시 로드 + 검색 동작 확인

### Phase 4: E2E 테스트

| # | 작업 | 파일 |
|---|------|------|
| 4-1 | 검색 E2E 테스트 작성 | `test/search.e2e.js` (신규) |
| 4-2 | 한국어 토크나이저 테스트 | `test/test-tokenizer.js` (신규) |

---

## 9. 검증 계획

### 9.1 수동 테스트 시나리오

| # | 시나리오 | 기대 결과 |
|---|---------|----------|
| 1 | Settings에서 mcpAutoSave 활성 + 경로 설정 | 설정 저장됨 |
| 2 | MCP `open_markdown`으로 문서 열기 (project, docName, description 포함) | 문서 저장됨 + 프론트매터 주입 |
| 3 | `search_documents` 호출 (영문 쿼리) | 관련 문서 반환 |
| 4 | `search_documents` 호출 (한국어 쿼리 "전자문서") | 띄어쓰기 변이 문서도 매칭 |
| 5 | `search_documents` 호출 (project 필터) | 해당 프로젝트 문서만 반환 |
| 6 | `search_projects` 호출 (쿼리 없음) | 전체 프로젝트 목록 |
| 7 | `search_projects` 호출 (쿼리 있음) | 매칭 프로젝트만 반환 |
| 8 | 앱 재시작 후 검색 | 인덱스 로드 성공 + 즉시 검색 가능 |

### 9.2 한국어 검색 품질 검증

| 쿼리 | 문서 내용 | 매칭 여부 |
|------|----------|----------|
| "전자문서" | "전자 문서 관리" | O (바이그램) |
| "설치 방법" | "설치하는 방법" | O (어절+바이그램) |
| "API 문서" | "REST API 설계" | O (어절) |
| "시스템" | "시스템을 구축" | O (조사제거) |
| "DocuLight" | "DocuLight 가이드" | O (영문 완전일치) |

---

## 10. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|--------|------|------|
| wink consolidate 후 문서 추가 불가 | 새 문서 저장 시 즉시 검색 불가 | dirty 마킹 → 다음 검색 시 lazy rebuild |
| 대량 문서(1000+) 시 rebuild 시간 | 검색 지연 | 백그라운드 rebuild + 진행 중 이전 인덱스 유지 |
| 한국어 바이그램 노이즈 | 정밀도 저하 | BM25 IDF가 자연스럽게 노이즈 토큰 가중치 감소 |
| `parseSimpleYaml` 한계 (배열/중첩 미지원) | 복잡한 프론트매터 파싱 실패 | 현재 DocuLight 프론트매터는 단순 key-value만 사용하므로 충분. 추후 필요 시 gray-matter 도입 |
