# MCP 효율성 연구 보고서

## 개요

Model Context Protocol (MCP)의 효율적인 적용 방안을 연구하기 위해 Context7 MCP 서버의 동작 원리와 구조를 분석했습니다.

**연구 일자**: 2026-01-28
**연구 대상**: Context7 MCP Server (github.com/upstash/context7)
**참고 문서**: [MCP 공식 문서](https://modelcontextprotocol.io/)

---

## 1. MCP 아키텍처 핵심 개념

### 1.1 참여자 (Participants)

MCP는 클라이언트-서버 아키텍처를 따릅니다:

```
┌─────────────────────────────────────────────────────┐
│              MCP Host (AI Application)              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │MCP Client│ │MCP Client│ │MCP Client│            │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘            │
└───────┼────────────┼────────────┼──────────────────┘
        │            │            │
        ▼            ▼            ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐
   │MCP      │  │MCP      │  │MCP      │
   │Server A │  │Server B │  │Server C │
   │(Local)  │  │(Local)  │  │(Remote) │
   └─────────┘  └─────────┘  └─────────┘
```

- **MCP Host**: AI 애플리케이션 (Claude Code, Claude Desktop, VS Code 등)
- **MCP Client**: MCP 서버에 연결을 유지하는 컴포넌트
- **MCP Server**: 컨텍스트를 제공하는 프로그램

### 1.2 프로토콜 레이어

**Data Layer (내부)**:
- JSON-RPC 2.0 기반 프로토콜
- 라이프사이클 관리 (initialize, capabilities 협상)
- Primitives: Tools, Resources, Prompts

**Transport Layer (외부)**:
- **STDIO**: 로컬 프로세스 간 통신 (로컬 서버)
- **Streamable HTTP**: 원격 서버 통신 (HTTP POST + SSE)

### 1.3 핵심 Primitives

| Primitive | 설명 | 메서드 |
|-----------|------|--------|
| **Tools** | LLM이 호출할 수 있는 실행 가능한 함수 | `tools/list`, `tools/call` |
| **Resources** | 컨텍스트 데이터 (파일, API 응답 등) | `resources/list`, `resources/read` |
| **Prompts** | 재사용 가능한 상호작용 템플릿 | `prompts/list`, `prompts/get` |

---

## 2. Context7 MCP의 효율성 분석

### 2.1 2단계 검색 방식

Context7의 핵심 효율성은 **2단계 검색 패턴**에서 나옵니다:

```
┌─────────────────────────────────────────────────────────┐
│  Step 1: resolve-library-id                             │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Input: "react hooks"                             │   │
│  │ Output: "/facebook/react" (Context7 ID)          │   │
│  │ Token 사용: 매우 적음 (ID만 반환)                 │   │
│  └─────────────────────────────────────────────────┘   │
│                          ▼                              │
│  Step 2: query-docs                                     │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Input: libraryId="/facebook/react"               │   │
│  │        query="useEffect cleanup function"        │   │
│  │ Output: 관련 문서 섹션만 (전체 문서 X)            │   │
│  │ Token 사용: 쿼리 관련 부분만                      │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**장점**:
1. 전체 문서를 로드하지 않고 관련 부분만 검색
2. 토큰 사용량 최소화
3. 불필요한 컨텍스트 제거

### 2.2 원격 서버 처리

```
┌─────────────┐    Query    ┌─────────────────────────┐
│ MCP Client  │ ─────────▶ │ Context7 Remote Server   │
│ (Claude)    │            │                          │
│             │ ◀───────── │ • 문서 인덱싱            │
│             │   결과     │ • 벡터 검색              │
│             │            │ • 관련 섹션 추출         │
└─────────────┘            └─────────────────────────┘
```

**효율성 요인**:
- 무거운 인덱싱/검색 작업은 서버에서 처리
- 클라이언트는 가벼운 요청만 전송
- 캐싱을 통한 응답 속도 최적화

### 2.3 선택적 정보 제공

Context7은 다음 정보를 선별적으로 제공합니다:

| 정보 유형 | 포함 여부 | 이유 |
|-----------|----------|------|
| 관련 코드 스니펫 | ✅ | 실용적 |
| API 사용 예제 | ✅ | 직접 활용 가능 |
| 전체 API 목록 | ❌ | 토큰 낭비 |
| 히스토리/변경로그 | ❌ | 일반적으로 불필요 |
| 전체 소스 코드 | ❌ | 과도한 컨텍스트 |

---

## 3. 현재 DocLight MCP의 문제점

### 3.1 현재 도구 목록

```
list_documents      - 디렉토리 목록
list_full_tree      - 전체 트리
read_document       - 문서 읽기
create_document     - 문서 생성
delete_document     - 문서 삭제
DocuLight_get_config - 설정 조회
DocuLight_search    - 문서 검색
```

### 3.2 비효율성 원인

1. **전체 문서 반환**
   - `read_document`가 전체 문서 내용을 반환
   - 큰 문서의 경우 불필요한 토큰 소비

2. **검색 결과 최적화 부재**
   - `DocuLight_search`가 매칭된 전체 컨텍스트 반환
   - 관련 섹션만 추출하는 기능 없음

3. **2단계 검색 패턴 미적용**
   - 문서 ID 해결과 내용 검색이 분리되지 않음
   - 쿼리 기반 섹션 추출 미지원

4. **도구 설명 불충분**
   - AI가 어떤 도구를 언제 사용해야 할지 명확하지 않음

---

## 4. 개선 방안

### 4.1 쿼리 기반 문서 검색 도구 추가

**새로운 도구 제안: `query_document`**

```json
{
  "name": "query_document",
  "description": "Search within a specific document and return only relevant sections",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Document path"
      },
      "query": {
        "type": "string",
        "description": "What information you need from this document"
      },
      "maxTokens": {
        "type": "integer",
        "description": "Maximum tokens to return (default: 2000)",
        "default": 2000
      }
    },
    "required": ["path", "query"]
  }
}
```

**동작 방식**:
1. 문서를 섹션(헤딩 기준)으로 분할
2. 쿼리와 관련된 섹션만 추출
3. maxTokens 내에서 우선순위 높은 섹션 반환

### 4.2 문서 요약 도구

**새로운 도구 제안: `summarize_document`**

```json
{
  "name": "summarize_document",
  "description": "Get a structured summary of a document including TOC and key points",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Document path"
      }
    },
    "required": ["path"]
  }
}
```

**반환 형식**:
```markdown
# 문서 요약: /guide/setup.md

## 목차
1. 설치 방법
2. 기본 설정
3. 고급 설정

## 핵심 내용
- 설치: npm install doclight
- 포트: 기본 3000
- 설정 파일: config.json5

## 통계
- 총 길이: 2,500 단어
- 섹션 수: 5개
- 코드 블록: 3개
```

### 4.3 스마트 검색 개선

**`DocuLight_search` 개선안**:

```json
{
  "name": "DocuLight_search",
  "description": "Search documents with semantic understanding",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query"
      },
      "mode": {
        "type": "string",
        "enum": ["titles_only", "snippets", "full_context"],
        "description": "Result detail level",
        "default": "snippets"
      },
      "limit": {
        "type": "integer",
        "default": 10
      }
    },
    "required": ["query"]
  }
}
```

**모드별 반환량**:
- `titles_only`: 파일명과 제목만 (최소 토큰)
- `snippets`: 매칭된 줄 ±2줄 (기본)
- `full_context`: 매칭된 섹션 전체 (상세 분석 필요시)

### 4.4 도구 설명 개선

현재:
```
"description": "Read a markdown document"
```

개선:
```
"description": "Read the complete content of a markdown document. Use this when you need to see the full document. For specific information, prefer query_document instead to reduce token usage."
```

---

## 5. 구현 아키텍처

### 5.1 문서 인덱싱 시스템

```
┌─────────────────────────────────────────────────────┐
│                Document Index                        │
├─────────────────────────────────────────────────────┤
│ ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│ │ Path Index  │  │Section Index│  │Keyword Index│  │
│ │ (파일 목록) │  │(헤딩별 분할)│  │(전문 검색)  │  │
│ └─────────────┘  └─────────────┘  └─────────────┘  │
│                                                      │
│ 문서 변경 감지 → 자동 재인덱싱                      │
└─────────────────────────────────────────────────────┘
```

### 5.2 섹션 추출 알고리즘

```javascript
// 의사 코드
function extractRelevantSections(document, query, maxTokens) {
  // 1. 문서를 헤딩 기준으로 섹션 분할
  const sections = splitByHeadings(document);

  // 2. 각 섹션의 쿼리 관련성 점수 계산
  const scored = sections.map(s => ({
    section: s,
    score: calculateRelevance(s.content, query)
  }));

  // 3. 점수순 정렬
  scored.sort((a, b) => b.score - a.score);

  // 4. maxTokens 내에서 섹션 선택
  const result = [];
  let tokens = 0;
  for (const item of scored) {
    const sectionTokens = countTokens(item.section.content);
    if (tokens + sectionTokens <= maxTokens) {
      result.push(item.section);
      tokens += sectionTokens;
    }
  }

  // 5. 원래 문서 순서로 재정렬
  return result.sort((a, b) => a.position - b.position);
}
```

### 5.3 캐싱 전략

```
┌─────────────────────────────────────────────────────┐
│                  Cache Layers                        │
├─────────────────────────────────────────────────────┤
│ L1: 메모리 캐시 (인기 문서, 5분 TTL)                │
│ L2: 섹션 인덱스 캐시 (문서별, 변경시 무효화)        │
│ L3: 검색 결과 캐시 (쿼리+경로 키, 1분 TTL)         │
└─────────────────────────────────────────────────────┘
```

---

## 6. 구현 우선순위

### Phase 1: 핵심 개선 (P0)
1. `query_document` 도구 구현
2. 문서 섹션 분할 기능
3. 기본 관련성 점수 계산

### Phase 2: 검색 개선 (P1)
1. `DocuLight_search` 모드 추가
2. `summarize_document` 구현
3. 도구 설명 개선

### Phase 3: 최적화 (P2)
1. 인덱싱 시스템 구축
2. 캐싱 레이어 추가
3. 성능 모니터링

---

## 7. 예상 효과

### 토큰 사용량 비교

| 시나리오 | 현재 | 개선 후 | 절감률 |
|----------|------|---------|--------|
| 5,000자 문서에서 특정 정보 검색 | 5,000 토큰 | 500 토큰 | 90% |
| 10개 문서 검색 | 10,000 토큰 | 1,500 토큰 | 85% |
| 문서 구조 파악 | 5,000 토큰 | 300 토큰 | 94% |

### 사용자 경험 개선

- **응답 속도**: 전송 데이터 감소로 더 빠른 응답
- **정확성**: 관련 정보만 제공되어 AI 답변 품질 향상
- **비용**: API 호출당 토큰 사용량 감소

---

## 8. 참고 자료

### Sources
- [Context7 MCP Server - GitHub](https://github.com/upstash/context7)
- [MCP Architecture Overview](https://modelcontextprotocol.io/docs/learn/architecture)
- [MCP Build Server Guide](https://modelcontextprotocol.io/docs/develop/build-server)
- [Model Context Protocol - Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol)
- [MCP SDK Documentation](https://modelcontextprotocol.io/docs/sdk)

### 관련 문서
- [DocLight MCP API 문서](../mcp/doc/mcp.md)
- [DocLight REST API 문서](../api/doc/api.md)

---

## 9. 하이브리드 검색 전략

DocLight의 기존 인프라를 활용한 하이브리드 검색 전략을 제안합니다.

### 9.1 현재 DocLight 인프라 분석

**이미 구현된 기능:**

| 모듈 | 파일 | 기능 |
|------|------|------|
| 키워드 검색 | `search-service.js` | 파일명, 제목, 내용 텍스트 검색 |
| 임베딩 팩토리 | `embedding-factory.js` | OpenAI, Azure, Ollama 지원 |
| 벡터 스토어 | `vector-store.js` | 인메모리/HNSWLib 영속성 |
| 벡터 스토리지 | `vector-storage.js` | 문서 변경 감지, 청크 관리 |

### 9.2 하이브리드 검색 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Query Request                        │
│                    (query_document)                         │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Config Check: chatbot.embedding?               │
└─────────────┬─────────────────────────────┬─────────────────┘
              │ Yes (설정 있음)              │ No (설정 없음)
              ▼                              ▼
┌─────────────────────────┐    ┌─────────────────────────────┐
│    Semantic Search      │    │    Keyword Search           │
│  (VectorStoreManager)   │    │  (search-service.js)        │
│                         │    │                             │
│  • 임베딩 생성          │    │  • 정규식 매칭              │
│  • 코사인 유사도        │    │  • 파일명/제목/내용 검색    │
│  • 관련 청크 추출       │    │  • 우선순위 정렬            │
└───────────┬─────────────┘    └───────────────┬─────────────┘
            │                                  │
            └──────────────┬───────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Section Extractor (공통)                       │
│                                                             │
│  • 헤딩 기반 섹션 분할                                      │
│  • 관련성 점수 기준 정렬                                    │
│  • maxTokens 내 섹션 선택                                   │
└─────────────────────────────────────────────────────────────┘
```

### 9.3 설정 기반 모드 선택

```javascript
// config.json5 예시

// Case 1: 임베딩 모델 미설정 → 키워드 검색만 사용
{
  docsRoot: "/data/docs",
  // chatbot 설정 없음 → 키워드 검색 모드
}

// Case 2: 임베딩 모델 설정 → 시맨틱 검색 사용
{
  docsRoot: "/data/docs",
  chatbot: {
    embedding: {
      type: "openai",
      endpoint: "https://api.openai.com/v1",
      apiKey: "sk-xxx",
      model: "text-embedding-3-small"
    }
    // LLM 설정 없어도 임베딩만으로 검색 가능
  }
}

// Case 3: Ollama (로컬) 임베딩 → 무료 시맨틱 검색
{
  chatbot: {
    embedding: {
      type: "ollama",
      endpoint: "http://localhost:11434",
      model: "nomic-embed-text"
    }
  }
}
```

### 9.4 검색 모드별 특성 비교

| 특성 | 키워드 검색 | 시맨틱 검색 |
|------|------------|------------|
| **요구사항** | 없음 (기본) | 임베딩 모델 필요 |
| **검색 방식** | 정확한 텍스트 매칭 | 의미적 유사도 |
| **장점** | 빠름, 무료, 설정 불필요 | 동의어, 유사 표현 검색 가능 |
| **단점** | 동의어 검색 불가 | API 비용, 초기 인덱싱 시간 |
| **적합한 케이스** | 정확한 용어 검색, 코드 검색 | 자연어 질문, 개념 검색 |

### 9.5 제안하는 새 MCP 도구

**`DocuLight_smart_search` - 하이브리드 검색 도구**

```json
{
  "name": "DocuLight_smart_search",
  "description": "Search documents using semantic search (if embedding configured) or keyword search (fallback). Returns only relevant sections to minimize token usage.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query (natural language for semantic, keywords for fallback)"
      },
      "path": {
        "type": "string",
        "description": "Directory to search within (default: /)",
        "default": "/"
      },
      "mode": {
        "type": "string",
        "enum": ["auto", "semantic", "keyword"],
        "description": "Search mode: auto (use semantic if available), semantic (force), keyword (force)",
        "default": "auto"
      },
      "maxTokens": {
        "type": "integer",
        "description": "Maximum tokens to return (default: 2000)",
        "default": 2000
      },
      "limit": {
        "type": "integer",
        "description": "Maximum number of documents (default: 5)",
        "default": 5
      }
    },
    "required": ["query"]
  }
}
```

**반환 형식:**

```markdown
# Search Results for "configuration options"

**Mode**: semantic (embedding: text-embedding-3-small)
**Documents**: 3 matches

## 1. /guide/setup.md (score: 0.89)

### Configuration Options

DocLight uses JSON5 format for configuration...
- `docsRoot`: Root directory for documents
- `port`: Server port number

## 2. /guide/advanced.md (score: 0.76)

### Advanced Configuration

For advanced users, the following options...

---
**Tokens used**: 1,847 / 2,000
```

### 9.6 구현 전략

**Phase 1: 기본 하이브리드 (기존 코드 재활용)**

```javascript
// mcp.js - DocuLight_smart_search 구현

async function smartSearch(config, logger, query, options) {
  const { mode = 'auto', maxTokens = 2000, limit = 5 } = options;

  // 검색 모드 결정
  const useSemanticSearch =
    mode === 'semantic' ||
    (mode === 'auto' && hasEmbeddingConfig(config));

  let results;

  if (useSemanticSearch) {
    // 벡터 스토어 사용 (chatbot 서비스 재활용)
    const vectorStore = await getVectorStoreManager(config, logger);
    results = await vectorStore.similaritySearch(query, limit);
  } else {
    // 기존 키워드 검색 재활용
    results = await searchDocuments(config, logger, query, {
      limit,
      includeContext: true
    });
  }

  // 섹션 추출 및 토큰 제한
  return extractSections(results, query, maxTokens);
}

function hasEmbeddingConfig(config) {
  return !!(
    config.chatbot?.embedding?.type &&
    config.chatbot?.embedding?.endpoint
  );
}
```

**Phase 2: 섹션 추출기 구현**

```javascript
// section-extractor.js

function extractSections(document, query, maxTokens) {
  // 1. 마크다운 헤딩 기준 섹션 분할
  const sections = splitByHeadings(document);

  // 2. 각 섹션 관련성 점수 계산 (키워드 밀도 기반)
  const scored = sections.map(section => ({
    ...section,
    score: calculateRelevance(section.content, query)
  }));

  // 3. 점수순 정렬 후 토큰 예산 내 선택
  scored.sort((a, b) => b.score - a.score);

  const selected = [];
  let usedTokens = 0;

  for (const section of scored) {
    const sectionTokens = estimateTokens(section.content);
    if (usedTokens + sectionTokens <= maxTokens) {
      selected.push(section);
      usedTokens += sectionTokens;
    }
  }

  // 4. 원본 순서로 재정렬
  return selected.sort((a, b) => a.position - b.position);
}
```

### 9.7 마이그레이션 경로

```
┌─────────────────────────────────────────────────────────────┐
│  현재: DocuLight_search (키워드만)                          │
└─────────────────────┬───────────────────────────────────────┘
                      │ Phase 1
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  DocuLight_smart_search 추가                                │
│  • 기존 DocuLight_search 유지 (하위 호환)                   │
│  • 하이브리드 검색 도입                                     │
└─────────────────────┬───────────────────────────────────────┘
                      │ Phase 2
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  query_document 추가                                        │
│  • 단일 문서 내 쿼리 기반 섹션 추출                         │
│  • 토큰 최적화                                              │
└─────────────────────┬───────────────────────────────────────┘
                      │ Phase 3
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  summarize_document 추가                                    │
│  • 문서 요약/목차 제공                                      │
│  • 토큰 사용량 최소화                                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. 결론

### 핵심 발견

1. **Context7의 효율성 비결**: 쿼리 기반 선택적 정보 제공
2. **DocLight의 강점**: 이미 임베딩/벡터 스토어 인프라 보유
3. **하이브리드 전략의 장점**: 설정에 따라 적응적 검색

### 제안하는 접근법

| 환경 | 검색 방식 | 비용 |
|------|----------|------|
| 임베딩 미설정 | 키워드 검색 (기존 search-service.js) | 무료 |
| OpenAI/Azure 임베딩 | 시맨틱 검색 | API 비용 발생 |
| Ollama 임베딩 | 시맨틱 검색 (로컬) | 무료 |

### 예상 효과

- **토큰 절감**: 80-90% (전체 문서 대신 관련 섹션만 반환)
- **유연성**: 환경에 따라 자동 모드 선택
- **하위 호환**: 기존 API 유지

### 다음 단계

1. **Phase 1**: `DocuLight_smart_search` 도구 구현
2. **Phase 2**: `query_document` 도구 구현
3. **Phase 3**: `summarize_document` 도구 구현

구현을 진행할까요?
