## Step 13.1: 문서 검색 기능 (Search Documents)

작성일: 2026-01-03
상위 문서: plan.step13.md (Phase 8에서 분리)

---

### 개요

Context MCP에 전문 검색 기능을 추가하여 AI 에이전트가 문서 내용을 키워드로 검색할 수 있도록 함.

### 요구사항

| 항목 | 요구사항 |
|------|----------|
| 검색어 | 필수, 문자열, 1~200자 |
| 대소문자 구분 | 기본 미구분 (case-insensitive) |
| 컨텍스트 길이 | 검색어 앞뒤 문자 수 (기본 50자, 10~500) |
| 검색 범위 | 전체 문서 또는 특정 경로 |
| 결과 포맷 | 파일별 매칭 결과 그룹화 |
| 파일당 최대 매칭 | 기본 10개, 최대 100개 |
| 전역 최대 매칭 | 500개 (초과 시 truncated 표시) |
| 최대 검색 파일 수 | 1000개 |

### 제한 및 검증 규칙

| 파라미터 | 타입 | 범위 | 기본값 | 검증 |
|----------|------|------|--------|------|
| `query` | string | 1~200자 | - | trim 후 빈 문자열 거부 |
| `context_chars` | number | 10~500 | 50 | 범위 외 값은 clamp |
| `max_results` | number | 1~100 | 10 | 범위 외 값은 clamp |
| `case_sensitive` | boolean | - | false | truthy 검사 |
| `path` | string | - | `/` | validatePath() 검증 |

---

### API 설계

#### 1. MCP Tool: `search_documents`

**Tool 정의**:
```javascript
{
  name: 'search_documents',
  description: 'Search for text across all markdown documents. Returns matching excerpts with surrounding context. Results are limited to 500 total matches across 1000 files maximum.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keyword or phrase (required, 1-200 chars, trimmed)',
        minLength: 1,
        maxLength: 200
      },
      context_chars: {
        type: 'number',
        description: 'Characters before/after match (default: 50, range: 10-500)',
        default: 50,
        minimum: 10,
        maximum: 500
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Case-sensitive search (default: false)',
        default: false
      },
      path: {
        type: 'string',
        description: 'Directory path to search in (default: /)',
        default: '/'
      },
      max_results: {
        type: 'number',
        description: 'Max matches per file (default: 10, range: 1-100)',
        default: 10,
        minimum: 1,
        maximum: 100
      }
    },
    required: ['query']
  }
}
```

**MCP 응답 (Markdown 형식)**:
```markdown
# Search Results for 'query'

Found 5 matches in 2 files

## /guide/getting-started.md (Getting Started Guide)

1. Line 15: ...before text **query** after text...
2. Line 42: ...another **query** match here...

## /api/endpoints.md (API Reference)

1. Line 7: ...context **query** example...
```

#### 2. GET 엔드포인트

**URL**: `GET /context?action=search&query=xxx`

**Query Parameters**:
| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|----------|------|------|--------|------|
| `action` | string | O | - | `search` |
| `query` | string | O | - | 검색어 |
| `context_chars` | number | - | 50 | 앞뒤 컨텍스트 문자 수 |
| `case_sensitive` | boolean | - | false | 대소문자 구분 |
| `path` | string | - | `/` | 검색 시작 경로 |
| `max_results` | number | - | 10 | 파일당 최대 매칭 수 |

**응답 예시**:
```json
{
  "success": true,
  "query": "authentication",
  "total_matches": 5,
  "total_files": 2,
  "truncated": false,
  "results": [
    {
      "path": "/guide/security.md",
      "name": "Security Guide",
      "match_count": 3,
      "matches": [
        { "line": 15, "excerpt": "...API key **authentication** is required for..." },
        { "line": 42, "excerpt": "...token-based **authentication** provides..." }
      ]
    }
  ]
}
```

**truncated 필드**:
- `false`: 모든 결과 반환됨
- `true`: 전역 제한(500개)에 도달하여 일부 결과 생략됨

#### 3. POST (JSON-RPC 2.0)

**요청**:
```bash
curl -X POST http://localhost:3000/context \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search_documents",
      "arguments": { "query": "authentication" }
    }
  }'
```

---

### 기술 설계

#### 1. context-service.js 확장

**신규 함수**: `searchDocuments()`

```javascript
/**
 * Search for text across all markdown documents
 * @param {Object} config - Application configuration
 * @param {Object} logger - Logger instance
 * @param {string} query - Search keyword
 * @param {Object} options - Search options
 * @returns {Promise<{ query, total_matches, total_files, truncated, results }>}
 */
async function searchDocuments(config, logger, query, options = {}) {
  // ============ 1. Input Validation ============
  const trimmedQuery = (query || '').trim();
  if (trimmedQuery.length === 0) {
    throw new Error('query is required and must not be empty');
  }
  if (trimmedQuery.length > 200) {
    throw new Error('query must be 200 characters or less');
  }

  // ============ 2. Sanitize Options ============
  const contextChars = Math.min(Math.max(parseInt(options.context_chars) || 50, 10), 500);
  const maxResultsPerFile = Math.min(Math.max(parseInt(options.max_results) || 10, 1), 100);
  const caseSensitive = options.case_sensitive === true;
  const searchPath = options.path || '/';

  // ============ 3. Path Normalization (consistent with getDocumentContent) ============
  const normalizedPath = (searchPath && searchPath !== '/' && searchPath.startsWith('/'))
    ? searchPath.slice(1)
    : searchPath;

  // ============ 4. Global Limits ============
  const MAX_TOTAL_MATCHES = 500;
  const MAX_FILES_TO_SEARCH = 1000;

  const absolutePath = validatePath(config.docsRoot, normalizedPath);
  const ig = ignore().add(config.excludes);
  const results = [];
  let totalMatches = 0;
  let filesSearched = 0;
  let truncated = false;

  const searchQuery = caseSensitive ? trimmedQuery : trimmedQuery.toLowerCase();

  // ============ 5. File Search Function ============
  async function searchInFile(filePath, relativePath) {
    if (totalMatches >= MAX_TOTAL_MATCHES || filesSearched >= MAX_FILES_TO_SEARCH) {
      truncated = true;
      return;
    }
    filesSearched++;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const textContent = frontmatter.content;

      if (!textContent || textContent.length === 0) return;

      const lines = textContent.split(/\r?\n/);
      const matches = [];
      let lineNumber = 0;
      let charOffset = 0;

      for (const line of lines) {
        lineNumber++;
        const searchLine = caseSensitive ? line : line.toLowerCase();
        let searchIndex = 0;

        while ((searchIndex = searchLine.indexOf(searchQuery, searchIndex)) !== -1) {
          if (matches.length >= maxResultsPerFile) break;
          if (totalMatches + matches.length >= MAX_TOTAL_MATCHES) {
            truncated = true;
            break;
          }

          // Context extraction
          const globalStart = charOffset + searchIndex;
          const contextStart = Math.max(0, globalStart - contextChars);
          const contextEnd = Math.min(textContent.length, globalStart + trimmedQuery.length + contextChars);
          let excerpt = textContent.slice(contextStart, contextEnd);

          if (contextStart > 0) excerpt = '...' + excerpt;
          if (contextEnd < textContent.length) excerpt = excerpt + '...';

          // Highlight match
          const matchStart = globalStart - contextStart + (contextStart > 0 ? 3 : 0);
          const matchEnd = matchStart + trimmedQuery.length;
          excerpt = excerpt.slice(0, matchStart) + '**' +
                   excerpt.slice(matchStart, matchEnd) + '**' +
                   excerpt.slice(matchEnd);

          matches.push({
            line: lineNumber,
            excerpt: excerpt.replace(/\r?\n/g, ' ')
          });
          searchIndex += trimmedQuery.length;
        }

        charOffset += line.length + 1;
        if (matches.length >= maxResultsPerFile || truncated) break;
      }

      if (matches.length > 0) {
        totalMatches += matches.length;
        results.push({
          path: '/' + relativePath.replace(/\\/g, '/'),
          name: frontmatter.name || path.basename(filePath, '.md'),
          match_count: matches.length,
          matches
        });
      }
    } catch (error) {
      logger.warn('Search file error', { path: relativePath, error: error.message });
    }
  }

  // ============ 6. Sequential Directory Scan ============
  async function scanRecursive(currentPath) {
    if (totalMatches >= MAX_TOTAL_MATCHES || filesSearched >= MAX_FILES_TO_SEARCH) {
      truncated = true;
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      logger.warn('Directory read error', { path: currentPath, error: error.message });
      return;
    }

    for (const entry of entries) {
      if (totalMatches >= MAX_TOTAL_MATCHES || filesSearched >= MAX_FILES_TO_SEARCH) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith('.')) continue;

      const entryAbsolute = path.join(currentPath, entry.name);
      const relativePath = path.relative(config.docsRoot, entryAbsolute);
      if (ig.ignores(relativePath)) continue;

      if (entry.isDirectory()) {
        await scanRecursive(entryAbsolute);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        await searchInFile(entryAbsolute, relativePath);
      }
    }
  }

  await scanRecursive(absolutePath);
  results.sort((a, b) => b.match_count - a.match_count);

  logger.info('Document search completed', {
    query: trimmedQuery,
    total_matches: totalMatches,
    total_files: results.length,
    truncated
  });

  return { query: trimmedQuery, total_matches: totalMatches, total_files: results.length, truncated, results };
}

module.exports = { getContextDocuments, getDocumentContent, searchDocuments };
```

#### 2. context-mcp.js 수정

**import 문 수정** (line 10):
```javascript
// Before
const { getContextDocuments, getDocumentContent } = require('../services/context-service');

// After
const { getContextDocuments, getDocumentContent, searchDocuments } = require('../services/context-service');
```

**TOOLS 배열에 추가** (기존 TOOLS 배열 끝에):
```javascript
{
  name: 'search_documents',
  description: 'Search for text across all markdown documents.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keyword (1-200 chars)', minLength: 1, maxLength: 200 },
      context_chars: { type: 'number', default: 50, minimum: 10, maximum: 500 },
      case_sensitive: { type: 'boolean', default: false },
      path: { type: 'string', default: '/' },
      max_results: { type: 'number', default: 10, minimum: 1, maximum: 100 }
    },
    required: ['query']
  }
}
```

**executeTool 함수에 case 추가**:
```javascript
case 'search_documents': {
  const searchResults = await searchDocuments(config, logger, args.query, {
    context_chars: args.context_chars,
    case_sensitive: args.case_sensitive,
    path: args.path,
    max_results: args.max_results
  });

  if (searchResults.total_matches === 0) {
    return { content: [{ type: 'text', text: `# Search Results for '${searchResults.query}'\n\nNo matches found.` }] };
  }

  let output = `# Search Results for '${searchResults.query}'\n\n`;
  output += `Found ${searchResults.total_matches} matches in ${searchResults.total_files} files`;
  if (searchResults.truncated) output += ` (truncated)`;
  output += '\n\n';

  searchResults.results.forEach(file => {
    output += `## ${file.path} (${file.name})\n\n`;
    file.matches.forEach((m, i) => output += `${i + 1}. Line ${m.line}: ${m.excerpt}\n`);
    output += '\n';
  });

  return { content: [{ type: 'text', text: output }] };
}
```

**usage 객체 업데이트** (line 119-122):
```javascript
// Before
usage: {
  list: 'GET /context?action=list&path=/',
  read: 'GET /context?action=read&path=/path/to/doc.md',
  post: 'POST /context with JSON-RPC 2.0 body'
}

// After
usage: {
  list: 'GET /context?action=list&path=/',
  read: 'GET /context?action=read&path=/path/to/doc.md',
  search: 'GET /context?action=search&query=keyword',
  post: 'POST /context with JSON-RPC 2.0 body'
}
```

**Unknown action 에러 메시지 업데이트** (line 157):
```javascript
// Before
message: `Unknown action: ${action}. Use 'list' or 'read'`

// After
message: `Unknown action: ${action}. Use 'list', 'read', or 'search'`
```

**GET 핸들러에 action=search 추가** (action=read 다음에):
```javascript
if (action === 'search') {
  const { query, context_chars, case_sensitive, max_results } = req.query;

  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: 'query required' } });
  }

  try {
    const searchResults = await searchDocuments(config, logger, query, {
      context_chars: context_chars ? parseInt(context_chars, 10) : undefined,
      case_sensitive: case_sensitive === 'true',
      path: docPath || '/',
      max_results: max_results ? parseInt(max_results, 10) : undefined
    });
    return res.json({ success: true, ...searchResults });
  } catch (error) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: error.message } });
  }
}
```

---

### 테스트 계획

#### 통합 테스트 (curl)

```bash
# 기본 검색
curl "http://localhost:3000/context?action=search&query=config"

# 대소문자 구분 검색
curl "http://localhost:3000/context?action=search&query=API&case_sensitive=true"

# 컨텍스트 길이 조정
curl "http://localhost:3000/context?action=search&query=test&context_chars=100"

# 빈 query 에러 테스트 (400 예상)
curl "http://localhost:3000/context?action=search&query="

# POST 검색
curl -X POST http://localhost:3000/context \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_documents","arguments":{"query":"config"}}}'
```

---

### 성능/보안 고려사항

| 항목 | 대응 |
|------|------|
| 대용량 파일 | 파일당 max_results 제한 (최대 100개) |
| 많은 파일 | 순차 처리로 file descriptor 고갈 방지 |
| 전역 결과 제한 | MAX_TOTAL_MATCHES=500, MAX_FILES=1000 |
| ReDoS 방지 | indexOf 사용, 정규식 미사용 |
| Path Traversal | validatePath() 검증 |
| 입력 검증 | query 길이 제한, 옵션 범위 clamp |

---

### 구현 체크리스트

**context-service.js:**
- [x] `searchDocuments()` 함수 추가 `2026-01-03`
- [x] `module.exports`에 `searchDocuments` 추가 `2026-01-03`

**context-mcp.js:**
- [x] import 문 수정 (`searchDocuments` 추가) `2026-01-03`
- [x] TOOLS 배열에 `search_documents` tool 추가 `2026-01-03`
- [x] `executeTool` 함수에 `search_documents` case 추가 `2026-01-03`
- [x] GET handler에 `action=search` 추가 `2026-01-03`
- [x] usage 객체에 `search` 추가 `2026-01-03`
- [x] Unknown action 에러 메시지 업데이트 `2026-01-03`

**테스트:**
- [x] 통합 테스트 수행 (20개 테스트 통과) `2026-01-03`
- [x] 빈 검색어 에러 테스트 `2026-01-03`
- [x] 대소문자 구분 테스트 `2026-01-03`
- [x] 경로 제한 테스트 `2026-01-03`

### 테스트 결과

**단위 테스트** (`test/test-search-documents.js`):
- 20개 테스트 모두 통과

**통합 테스트**:
- GET `/context` - search_documents tool 포함 확인
- GET `/context?action=search&query=config` - 정상 동작
- 빈 쿼리 에러 처리 - 정상 동작
- POST JSON-RPC - 정상 동작
