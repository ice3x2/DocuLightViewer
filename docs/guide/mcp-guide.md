# DocLight MCP 가이드

DocLight는 Model Context Protocol (MCP)을 통해 AI 에이전트가 문서를 효율적으로 검색하고 조회할 수 있도록 지원합니다.

## 목차

- [개요](#개요)
- [연결 설정](#연결-설정)
- [도구 목록](#도구-목록)
- [효율적인 사용 패턴](#효율적인-사용-패턴)
- [도구별 상세 가이드](#도구별-상세-가이드)
- [예제](#예제)
- [오류 처리](#오류-처리)
- [모범 사례](#모범-사례)

---

## 개요

DocLight MCP는 JSON-RPC 2.0 프로토콜을 사용하며, 다음과 같은 기능을 제공합니다:

- **문서 탐색**: 디렉토리 트리 조회
- **문서 검색**: 키워드/시맨틱 검색
- **문서 조회**: 전체 또는 관련 섹션만 조회
- **문서 관리**: 생성, 삭제 (인증 필요)

### 토큰 효율성

Step 16에서 도입된 새로운 도구들은 기존 대비 **80-90% 토큰 절감**을 제공합니다:

| 시나리오 | 기존 방식 | 새로운 방식 | 절감률 |
|----------|----------|-------------|--------|
| 5,000자 문서에서 특정 정보 검색 | 5,000 토큰 | 500 토큰 | 90% |
| 10개 문서 검색 | 10,000 토큰 | 1,500 토큰 | 85% |
| 문서 구조 파악 | 5,000 토큰 | 300 토큰 | 94% |

---

## 연결 설정

### 엔드포인트

```
POST http://localhost:3000/mcp
Content-Type: application/json
```

### 요청 형식 (JSON-RPC 2.0)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "도구명",
    "arguments": {
      "파라미터": "값"
    }
  }
}
```

### 인증

쓰기 작업(생성, 삭제)은 `X-API-Key` 헤더가 필요합니다:

```
X-API-Key: your-api-key
```

---

## 도구 목록

### 읽기 전용 도구 (인증 불필요)

| 도구 | 용도 | 토큰 효율 |
|------|------|----------|
| `list_documents` | 단일 디렉토리 목록 | 낮음 |
| `list_full_tree` | 전체 트리 구조 | 낮음 |
| `read_document` | 문서 전체 읽기 | 낮음 |
| `DocuLight_search` | 키워드 검색 | 중간 |
| `DocuLight_smart_search` | 스마트 검색 (시맨틱/키워드) | **높음** |
| `query_document` | 문서 내 쿼리 검색 | **높음** |
| `summarize_document` | 문서 요약 | **높음** |
| `DocuLight_get_config` | 서버 설정 조회 | - |

### 쓰기 도구 (인증 필요)

| 도구 | 용도 |
|------|------|
| `create_document` | 문서 생성/수정 |
| `delete_document` | 문서/디렉토리 삭제 |

---

## 효율적인 사용 패턴

### 도구 선택 가이드

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        도구 선택 플로우차트                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  "문서 목록이 필요해"                                                     │
│  └─► list_documents (단일 디렉토리) 또는 list_full_tree (전체)           │
│                                                                          │
│  "X에 대한 정보를 찾아야 해" (어느 문서인지 모름)                          │
│  └─► DocuLight_smart_search (가장 효율적)                                │
│  └─► DocuLight_search (키워드만 필요할 때)                               │
│                                                                          │
│  "이 문서에서 Y에 대해 알고 싶어" (문서 알고 있음)                         │
│  └─► query_document (특정 정보만)                                        │
│  └─► summarize_document (구조 파악 먼저)                                 │
│  └─► read_document (전체 필요할 때만)                                    │
│                                                                          │
│  "문서 구조를 파악하고 싶어"                                               │
│  └─► summarize_document                                                  │
│                                                                          │
│  "전체 문서 내용이 필요해"                                                 │
│  └─► read_document (마지막 수단)                                         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 권장 워크플로우

1. **정보 검색 시**: `DocuLight_smart_search` → `query_document` → `read_document`
2. **문서 이해 시**: `summarize_document` → `query_document`
3. **문서 탐색 시**: `list_documents` → `summarize_document`

### AI 에이전트 의사결정 로직

```
FUNCTION SELECT_TOOL(task):
    IF task.type == "SEARCH" AND task.document_unknown:
        IF task.need_semantic:
            RETURN DocuLight_smart_search(mode="auto")
        ELSE:
            RETURN DocuLight_search(mode="titles_only")

    ELIF task.type == "SEARCH" AND task.document_known:
        RETURN query_document(path=task.document, query=task.query)

    ELIF task.type == "UNDERSTAND_STRUCTURE":
        RETURN summarize_document(path=task.document)

    ELIF task.type == "READ_FULL":
        # 마지막 수단으로만 사용
        RETURN read_document(path=task.document)

    ELIF task.type == "LIST":
        IF task.recursive:
            RETURN list_full_tree(maxDepth=task.depth)
        ELSE:
            RETURN list_documents(path=task.directory)

    ELIF task.type == "WRITE":
        REQUIRE X-API-Key
        RETURN create_document(path=task.path, content=task.content)

    ELIF task.type == "DELETE":
        REQUIRE X-API-Key
        CONFIRM "삭제는 복구 불가능합니다"
        RETURN delete_document(path=task.path)
```

---

## 도구별 상세 가이드

### 1. DocuLight_smart_search

가장 효율적인 검색 도구입니다. 임베딩이 설정되어 있으면 시맨틱 검색을, 그렇지 않으면 키워드 검색을 자동으로 수행합니다.

**파라미터:**

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|----------|------|------|--------|------|
| `query` | string | O | - | 검색 쿼리 |
| `path` | string | X | "/" | 검색 범위 |
| `mode` | string | X | "auto" | auto, semantic, keyword |
| `maxTokens` | integer | X | 2000 | 최대 반환 토큰 |
| `limit` | integer | X | 5 | 최대 문서 수 |

**예제:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "DocuLight_smart_search",
    "arguments": {
      "query": "SSL 인증서 설정 방법",
      "maxTokens": 1500,
      "limit": 3
    }
  }
}
```

**응답 예시:**

```markdown
# Search Results for "SSL 인증서 설정 방법"

**Mode**: keyword (semantic unavailable)
**Documents**: 2
**Tokens used**: 1,234 / 1,500

## 1. guide/ssl-setup.md (score: 0.85)

### SSL Configuration

SSL 인증서를 설정하려면 다음 단계를 따르세요...

## 2. reference/security.md (score: 0.72)

### HTTPS 설정

보안 연결을 위한 설정...
```

---

### 2. query_document

특정 문서 내에서 관련 섹션만 추출합니다. 문서 경로를 알고 있을 때 사용합니다.

**파라미터:**

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|----------|------|------|--------|------|
| `path` | string | O | - | 문서 경로 |
| `query` | string | O | - | 찾고자 하는 정보 |
| `maxTokens` | integer | X | 2000 | 최대 반환 토큰 |

**예제:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "query_document",
    "arguments": {
      "path": "guide/configuration.md",
      "query": "포트 설정",
      "maxTokens": 1000
    }
  }
}
```

**응답 예시:**

```markdown
# Query Results: guide/configuration.md

**Query**: 포트 설정
**Sections**: 2 (filtered from 8)
**Tokens**: 450 / 1000

## Configuration (score: 0.92)

포트를 변경하려면 config.json5에서 port 값을 수정하세요:

```json5
{
  port: 8080  // 기본값: 3000
}
```

## Advanced Settings (score: 0.65)

SSL을 사용할 경우 별도의 포트 설정이 필요합니다...
```

---

### 3. summarize_document

문서의 구조와 핵심 내용을 요약합니다. 전체 문서를 읽기 전에 사용하면 효율적입니다.

**파라미터:**

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|----------|------|------|--------|------|
| `path` | string | O | - | 문서 경로 |

**예제:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "summarize_document",
    "arguments": {
      "path": "guide/getting-started.md"
    }
  }
}
```

**응답 예시:**

```markdown
# Document Summary: guide/getting-started.md

**Title**: Getting Started Guide

## Table of Contents

1. Introduction (~50 tokens)
2. Installation (~120 tokens)
   2.1 Prerequisites (~30 tokens)
   2.2 Setup (~90 tokens)
3. Configuration (~200 tokens)
4. First Steps (~150 tokens)

## Key Points

- Node.js 18+ 필요
- npm install로 설치
- config.json5 파일 생성 필요

## Statistics

- Words: 1,234
- Characters: 7,890
- Sections: 8
- Code blocks: 5
- Estimated tokens: 520
```

---

### 4. DocuLight_search

키워드 기반 검색으로 세 가지 모드를 지원합니다.

**파라미터:**

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|----------|------|------|--------|------|
| `query` | string | O | - | 검색어 (최소 2자) |
| `limit` | integer | X | 10 | 최대 결과 수 (1-100) |
| `path` | string | X | "/" | 검색 범위 |
| `mode` | string | X | "snippets" | 결과 상세도 |

**모드 비교:**

| 모드 | 설명 | 예상 토큰 | 용도 |
|------|------|----------|------|
| `titles_only` | 파일명과 제목만 | 50-100 | 문서 목록 파악 |
| `snippets` | 매칭 줄 + 컨텍스트 | 300-500 | 일반 검색 |
| `full_context` | 전체 섹션 | 1000-2000 | 상세 분석 |

**예제 - titles_only:**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "DocuLight_search",
    "arguments": {
      "query": "configuration",
      "mode": "titles_only",
      "limit": 5
    }
  }
}
```

**응답:**

```markdown
# Search Results for "configuration"

**Mode**: titles_only
**Matches**: 5 files

1. guide/setup.md - "Setup Guide"
2. guide/advanced.md - "Advanced Configuration"
3. reference/config.md - "Configuration Reference"
4. faq/common.md - "Common Questions"
5. tutorial/first-app.md - "First App Tutorial"
```

---

### 5. read_document

문서 전체를 읽습니다. 토큰 사용량이 많으므로 마지막 수단으로 사용하세요.

**파라미터:**

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|----------|------|------|--------|------|
| `path` | string | O | - | 문서 경로 |

**권장사항:**
- 먼저 `summarize_document`로 구조 파악
- 특정 정보만 필요하면 `query_document` 사용
- 전체 내용이 반드시 필요할 때만 사용

**예제:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "read_document",
    "arguments": {
      "path": "guide/getting-started.md"
    }
  }
}
```

**응답:**

문서 전체 마크다운 내용이 반환됩니다.

---

### 6. list_documents / list_full_tree

디렉토리 구조를 조회합니다.

**list_documents 파라미터:**

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|----------|------|------|--------|------|
| `path` | string | X | "/" | 조회할 디렉토리 |

**list_full_tree 파라미터:**

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|----------|------|------|--------|------|
| `path` | string | X | "/" | 시작 디렉토리 |
| `maxDepth` | integer | X | 무제한 | 최대 깊이 |

**list_documents 예제:**

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "list_documents",
    "arguments": {
      "path": "guide/"
    }
  }
}
```

**list_full_tree 예제:**

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "list_full_tree",
    "arguments": {
      "path": "/",
      "maxDepth": 2
    }
  }
}
```

**응답 예시:**

```json
{
  "path": "/",
  "entries": [
    {"name": "guide", "type": "directory"},
    {"name": "reference", "type": "directory"},
    {"name": "README.md", "type": "file"}
  ]
}
```

---

### 7. create_document (인증 필요)

문서를 생성하거나 덮어씁니다.

**파라미터:**

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|----------|------|------|--------|------|
| `path` | string | O | - | 문서 경로 |
| `content` | string | O | - | 마크다운 내용 |

**예제:**

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "create_document",
    "arguments": {
      "path": "notes/meeting-2024-01-29.md",
      "content": "# 회의록\n\n## 참석자\n- ..."
    }
  }
}
```

---

### 8. delete_document (인증 필요)

문서 또는 디렉토리를 삭제합니다. **복구 불가능**합니다.

**파라미터:**

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|----------|------|------|--------|------|
| `path` | string | O | - | 삭제할 경로 |

---

### 9. DocuLight_get_config

서버 설정을 조회합니다. 민감한 값(API 키 등)은 마스킹됩니다.

**파라미터:**

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|----------|------|------|--------|------|
| `section` | string | X | "all" | 조회할 섹션 (ui, security, ssl, all) |

**예제:**

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "tools/call",
  "params": {
    "name": "DocuLight_get_config",
    "arguments": {
      "section": "ui"
    }
  }
}
```

**응답 예시:**

```json
{
  "section": "ui",
  "config": {
    "title": "DocLight",
    "icon": "/images/icon.png"
  }
}
```

---

## 예제

### 예제 1: 효율적인 정보 검색

```
목표: "SSL 설정 방법"을 찾아서 설정하기

1단계: 스마트 검색으로 관련 문서 찾기
→ DocuLight_smart_search(query="SSL 설정", limit=3)

2단계: 가장 관련성 높은 문서에서 상세 정보 추출
→ query_document(path="guide/ssl-setup.md", query="인증서 설정")

3단계: 필요시 전체 문서 읽기
→ read_document(path="guide/ssl-setup.md")
```

### 예제 2: 문서 구조 파악 후 탐색

```
목표: API 문서 구조 이해하기

1단계: 문서 요약 확인
→ summarize_document(path="reference/api.md")

2단계: 관심 있는 섹션만 조회
→ query_document(path="reference/api.md", query="인증 API")
```

### 예제 3: 빠른 문서 목록 확인

```
목표: 어떤 가이드 문서가 있는지 확인

1단계: 디렉토리 목록
→ list_documents(path="guide/")

2단계: 관심 문서 요약
→ summarize_document(path="guide/getting-started.md")
```

---

## 오류 처리

### 일반적인 오류 코드

| 코드 | 메시지 | 원인 | 해결 방법 |
|------|--------|------|----------|
| -32600 | Invalid Request | 잘못된 JSON-RPC 형식 | 요청 형식 확인 |
| -32601 | Method not found | 없는 메서드 | 메서드명 확인 |
| -32602 | Invalid params | 잘못된 파라미터 | 필수 파라미터 확인 |
| 401 | Unauthorized | 인증 실패 | X-API-Key 헤더 확인 |
| 404 | Document not found | 문서 없음 | 경로 확인 |

### 도구별 오류

| 도구 | 오류 | 원인 | 해결 방법 |
|------|------|------|----------|
| `DocuLight_search` | QUERY_TOO_SHORT | 검색어 2자 미만 | 2자 이상 입력 |
| `DocuLight_search` | SEARCH_TIMEOUT | 검색 5초 초과 | 범위 축소 (path 지정) |
| `DocuLight_smart_search` | SEMANTIC_UNAVAILABLE | 임베딩 미설정 | mode="keyword" 사용 |
| `query_document` | EMPTY_QUERY | 빈 쿼리 | query 파라미터 필수 |
| `create_document` | PATH_TRAVERSAL | 경로 탈출 시도 | 상대경로 사용 금지 |

### 오류 응답 예시

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid params: path is required"
  }
}
```

### 오류 처리 플로우

```
IF 오류 발생:
    IF code == -32602 (Invalid params):
        → 필수 파라미터 확인
        → 파라미터 타입 확인
    ELIF code == 401 (Unauthorized):
        → X-API-Key 헤더 추가
        → API 키 값 확인
    ELIF code == 404 (Not found):
        → list_documents로 경로 확인
        → 경로 오타 확인
    ELIF SEMANTIC_UNAVAILABLE:
        → mode="keyword"로 재시도
    ELSE:
        → 로그 확인 후 재시도
```

---

## 모범 사례

1. **토큰 효율성**: `read_document` 대신 `query_document` 또는 `summarize_document` 우선 사용
2. **검색 전략**: 먼저 `DocuLight_smart_search`로 문서 찾고, `query_document`로 상세 조회
3. **모드 활용**: `DocuLight_search`에서 `titles_only` → `snippets` → `full_context` 순으로 확장
4. **캐싱**: 동일 문서 반복 조회 시 결과 캐싱 고려

---

## 참고 자료

- [MCP 공식 문서](https://modelcontextprotocol.io/)
- [DocLight API 문서](../api/api.md)
- [Step 16 구현 계획](../plan/step16/00.index.md)
