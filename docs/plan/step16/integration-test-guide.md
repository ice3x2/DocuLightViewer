# Step 16: 통합 테스트 가이드

## 개요

Step 16 구현이 완료된 후 수행할 통합 테스트 시나리오입니다.

---

## 테스트 환경

### 사전 조건

1. DocLight 서버 실행 중 (포트 3000)
2. 테스트 문서 준비 (`test-source/` 디렉토리)
3. 임베딩 설정 테스트를 위한 두 가지 환경:
   - 임베딩 미설정 (config.json5에서 chatbot 섹션 주석 처리)
   - 임베딩 설정됨 (config.json5에서 chatbot.embedding 설정)

### 테스트 문서 구조

```
test-source/
├── guide/
│   ├── setup.md              # 설치 가이드 (~2000 토큰)
│   ├── configuration.md      # 설정 가이드 (~3000 토큰)
│   └── advanced/
│       └── ssl.md            # SSL 설정 (~1500 토큰)
├── api/
│   ├── endpoints.md          # API 엔드포인트 (~2500 토큰)
│   └── authentication.md     # 인증 (~1000 토큰)
└── faq/
    └── common-issues.md      # FAQ (~1000 토큰)
```

---

## E2E 테스트 시나리오

### 시나리오 1: query_document 기본 동작 (CRITICAL)

**목적**: 단일 문서 내 쿼리 기반 섹션 추출 검증

**Steps**:
1. MCP 호출: `query_document({ path: "guide/setup.md", query: "installation", maxTokens: 500 })`
2. 응답 확인:
   - 설치 관련 섹션이 포함되어 있는가?
   - 토큰 사용량 ≤ 500인가?
   - 섹션 점수가 포함되어 있는가?

**예상 결과**:
```json
{
  "path": "guide/setup.md",
  "query": "installation",
  "sections": [
    { "heading": "## Installation", "score": 0.85, "content": "..." }
  ],
  "tokensUsed": 487,
  "maxTokens": 500
}
```

**Pass 기준**: 토큰 예산 준수, 관련 섹션 반환

---

### 시나리오 2: summarize_document 기본 동작 (CRITICAL)

**목적**: 문서 요약 기능 검증

**Steps**:
1. MCP 호출: `summarize_document({ path: "guide/configuration.md" })`
2. 응답 확인:
   - TOC가 정확한가?
   - 핵심 포인트가 추출되었는가?
   - 통계가 합리적인가?

**예상 결과**:
```json
{
  "title": "Configuration Guide",
  "toc": [
    { "level": 1, "text": "Configuration Guide" },
    { "level": 2, "text": "Basic Settings" },
    { "level": 2, "text": "Advanced Options" }
  ],
  "keyPoints": ["..."],
  "stats": {
    "wordCount": 450,
    "sectionCount": 5,
    "codeBlockCount": 3
  }
}
```

**Pass 기준**: TOC 정확성, 통계 정확성

---

### 시나리오 3: DocuLight_smart_search - 키워드 모드 (HIGH)

**목적**: 임베딩 없이 키워드 검색 동작 검증

**환경**: 임베딩 미설정

**Steps**:
1. MCP 호출: `DocuLight_smart_search({ query: "SSL configuration", mode: "auto" })`
2. 응답 확인:
   - mode가 "keyword"로 표시되는가?
   - SSL 관련 문서가 반환되는가?
   - 토큰 예산이 준수되는가?

**Pass 기준**: 키워드 폴백 동작, 관련 결과 반환

---

### 시나리오 4: DocuLight_smart_search - 시맨틱 모드 (HIGH)

**목적**: 임베딩 설정 시 시맨틱 검색 동작 검증

**환경**: 임베딩 설정됨

**Steps**:
1. MCP 호출: `DocuLight_smart_search({ query: "how to secure connections", mode: "auto" })`
2. 응답 확인:
   - mode가 "semantic"으로 표시되는가?
   - 의미적으로 관련된 문서가 반환되는가? (정확한 키워드 없어도)

**Pass 기준**: 시맨틱 검색 동작, 의미 기반 결과

---

### 시나리오 5: DocuLight_search 모드 비교 (HIGH)

**목적**: 검색 모드별 출력 차이 검증

**Steps**:
1. `DocuLight_search({ query: "config", mode: "titles_only" })`
2. `DocuLight_search({ query: "config", mode: "snippets" })`
3. `DocuLight_search({ query: "config", mode: "full_context" })`
4. 각 결과의 토큰 사용량 비교

**예상 결과**:
- titles_only: ~50 토큰
- snippets: ~300 토큰
- full_context: ~1500 토큰

**Pass 기준**: 모드별 토큰 사용량 차이 명확

---

### 시나리오 6: 대용량 문서 처리 (MEDIUM)

**목적**: 토큰 예산 제한 검증

**Steps**:
1. 5000+ 토큰 문서 준비
2. `query_document({ path: "large-doc.md", query: "test", maxTokens: 500 })`
3. 응답 확인: tokensUsed ≤ 500

**Pass 기준**: 토큰 예산 절대 초과하지 않음

---

### 시나리오 7: 에러 처리 (HIGH)

**목적**: 에러 상황에서의 동작 검증

**Steps**:
1. 존재하지 않는 파일: `query_document({ path: "nonexistent.md", query: "test" })`
   - 예상: DOCUMENT_NOT_FOUND 에러
2. 빈 쿼리: `DocuLight_smart_search({ query: "" })`
   - 예상: INVALID_QUERY 에러
3. 시맨틱 강제 (임베딩 없음): `DocuLight_smart_search({ query: "test", mode: "semantic" })`
   - 예상: SEMANTIC_SEARCH_UNAVAILABLE 에러

**Pass 기준**: 적절한 에러 코드 및 메시지

---

### 시나리오 8: 하위 호환성 (CRITICAL)

**목적**: 기존 MCP 도구 동작 유지 검증

**Steps**:
1. 기존 도구들 테스트:
   - `list_documents({ path: "/" })`
   - `list_full_tree({ path: "/" })`
   - `read_document({ path: "guide/setup.md" })`
   - `DocuLight_search({ query: "config" })` (mode 없이)
2. 응답이 기존과 동일한지 확인

**Pass 기준**: 기존 동작 100% 유지

---

## 컴포넌트 통합 테스트

### SectionExtractor ↔ QueryDocumentService

```
query_document 호출
       │
       ▼
QueryDocumentService
       │
       ├─► 파일 읽기
       │
       ├─► SectionExtractor.splitByHeadings
       │
       ├─► SectionExtractor.calculateRelevance
       │
       └─► SectionExtractor.selectWithinBudget
              │
              ▼
         결과 반환
```

**검증 포인트**:
- [ ] 섹션 분할 정확성
- [ ] 점수 계산 일관성
- [ ] 토큰 예산 준수

---

### SmartSearchService ↔ VectorStoreManager

```
smart_search 호출 (mode=auto, 임베딩 있음)
       │
       ▼
SmartSearchService
       │
       ├─► hasEmbeddingConfig() → true
       │
       ├─► VectorStoreManager.similaritySearch()
       │
       └─► SectionExtractor.extractRelevantSections()
              │
              ▼
         결과 반환
```

**검증 포인트**:
- [ ] VectorStore 정상 연동
- [ ] 시맨틱 검색 결과 품질
- [ ] 폴백 동작

---

### SmartSearchService ↔ search-service

```
smart_search 호출 (mode=keyword)
       │
       ▼
SmartSearchService
       │
       ├─► searchDocuments()
       │
       └─► SectionExtractor.extractRelevantSections()
              │
              ▼
         결과 반환
```

**검증 포인트**:
- [ ] 키워드 검색 정상 동작
- [ ] 결과 포맷 통일

---

## 요구사항 추적 매트릭스

| 요구사항 | 테스트 시나리오 | 상태 |
|----------|----------------|------|
| 토큰 80% 절감 | 시나리오 5, 6 | - |
| 쿼리 기반 섹션 추출 | 시나리오 1 | - |
| 문서 요약 | 시나리오 2 | - |
| 하이브리드 검색 | 시나리오 3, 4 | - |
| 검색 모드 옵션 | 시나리오 5 | - |
| 에러 처리 | 시나리오 7 | - |
| 하위 호환성 | 시나리오 8 | - |

---

## 테스트 실행 명령어

```bash
# 단위 테스트
npm run test:mcp

# 특정 테스트 파일
npm run test -- test/mcp/section-extractor.test.js
npm run test -- test/mcp/query-document.test.js
npm run test -- test/mcp/smart-search.test.js

# MCP 통합 테스트 (서버 실행 필요)
npm run test:mcp-integration
```

---

## 수동 테스트 체크리스트

- [ ] query_document: 관련 섹션만 반환
- [ ] summarize_document: TOC 및 통계 정확
- [ ] smart_search (임베딩 없음): 키워드 폴백
- [ ] smart_search (임베딩 있음): 시맨틱 검색
- [ ] search modes: titles_only, snippets, full_context
- [ ] 에러 처리: 적절한 에러 메시지
- [ ] 하위 호환성: 기존 도구 정상 동작
