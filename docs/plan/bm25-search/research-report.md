# BM25 검색 API 기술 조사 보고서

> 작성일: 2026-02-27
> 대상 프로젝트: DocuLight Viewer
> 목적: MCP 자동 저장 문서에 대한 BM25 전문 검색 + 프론트매터 메타데이터 검색

---

## 1. 현재 시스템 분석

### 1.1 자동 저장 시스템 (이미 구현됨)

| 항목 | 현재 상태 |
|------|----------|
| 설정 `mcpAutoSave` | `boolean`, 기본 `false` — 스키마 정의 완료 |
| 설정 `mcpAutoSavePath` | `string`, 기본 `''` — 스키마 정의 완료 |
| 설정 UI | Settings에 토글 + 경로 입력 + 찾아보기 버튼 구현됨 |
| 저장 로직 | `mcp-http.mjs:45` `saveMcpFile()` — 날짜 폴더(`YYYY-MM-DD`) 하위에 `HHMMSS_제목.md` 형식으로 저장 |
| 호출 시점 | `open_markdown`, `update_markdown` 호출 시 자동 |
| `noSave` | Step 20에서 추가 — 호출별 저장 건너뛰기 |
| stdio MCP | `mcp-server.mjs`에도 동일 `saveMcpFile()` 구현 |

**저장 경로 구조:**
```
{mcpAutoSavePath}/
├── 2026-02-27/
│   ├── 103000_API-Reference.md
│   ├── 114523_Error-Log.md
│   └── 150000_설치가이드.md
├── 2026-02-28/
│   └── 090000_릴리스노트.md
```

### 1.2 프론트매터 시스템 (이미 구현됨)

| 항목 | 현재 상태 |
|------|----------|
| 유틸리티 | `src/main/frontmatter.js` — CJS, 자체 구현 |
| 필드 | `project`, `docName`, `description`, `date` (자동) |
| 주입 시점 | MCP 서버에서 content에 프론트매터 블록 prepend |
| 파싱 | `parseSimpleYaml()` — 간단한 key-value 파싱 (중첩/배열 미지원) |
| 렌더러 | 프론트매터를 metabox로 표시 후 본문에서 제거 |
| MCP 파라미터 | `open_markdown`, `update_markdown`에 `project`, `docName`, `description` 옵션 |

**프론트매터 예시:**
```yaml
---
project: DocuLightViewer
docName: API Reference
description: MCP 도구 API 문서
date: 2026-02-27T10:30:00
---
```

### 1.3 검색 기능 현황

| 항목 | 현재 상태 |
|------|----------|
| 사이드바 검색 | `sidebar-search.js` — 파일명 필터링만 (내용 검색 없음) |
| Find-in-Page | `Ctrl+F` — 현재 보이는 문서 내 텍스트 검색 |
| MCP 검색 도구 | **없음** — 이번에 추가 대상 |

---

## 2. BM25 라이브러리 평가

### 2.1 후보 라이브러리 비교

| 기준 | wink-bm25-text-search | okapibm25 | 자체 구현 |
|------|----------------------|-----------|----------|
| **다중 필드 가중치** | O (BM25F) | X | 직접 구현 필요 |
| **커스텀 토크나이저** | O (필드별 파이프라인) | X | O |
| **인덱스 직렬화** | O (`exportJSON`/`importJSON`) | X | 직접 구현 필요 |
| **인크리멘탈 추가** | O (`consolidate` 전) | X | O |
| **결과 필터링** | O (`search`의 filter 파라미터) | X | 직접 구현 필요 |
| **의존성** | 0개 | 0개 | 0개 |
| **번들 크기** | ~30KB | ~10KB | 0KB |
| **유지보수** | 활발 (winkjs 팀) | 활발 | 자체 |
| **TypeScript** | JSDoc 타입 | 네이티브 TS | - |
| **npm 다운로드** | 중간 | 111K/년 | - |

### 2.2 선정: wink-bm25-text-search

**선정 이유:**

1. **필드별 가중치 (BM25F)**: `project: 4, title: 5, description: 2, body: 1` 같은 가중치 설정이 핵심 요구사항. okapibm25는 단일 문자열만 지원하므로 프론트매터 필드 검색에 부적합.

2. **커스텀 토크나이저 파이프라인**: 한국어 토크나이저를 필드별로 다르게 적용 가능. `definePrepTasks([tokenizer], 'fieldName')`.

3. **인덱스 영속화**: `exportJSON()`/`importJSON()`으로 JSON 파일에 인덱스 저장/복원. 앱 재시작 시 전체 재인덱싱 불필요.

4. **필터링**: `search(query, limit, filterFn)`으로 특정 프로젝트만 검색 가능.

5. **제로 의존성**: 추가 npm 패키지 없음.

**API 핵심:**
```javascript
const bm25 = require('wink-bm25-text-search');
const engine = bm25();

// 필드 가중치 설정
engine.defineConfig({
  fldWeights: { title: 5, project: 4, description: 2, body: 1 },
  bm25Params: { k1: 1.2, b: 0.75, k: 1 },
  ovFldNames: ['project', 'tags']  // 필터링용 원본값 보존
});

// 커스텀 토크나이저 등록
engine.definePrepTasks([koreanTokenizer]);

// 문서 추가
engine.addDoc({ title: '...', project: '...', body: '...' }, 'doc-id');
engine.consolidate();

// 검색
const results = engine.search('전자문서');
// → [['doc-id', 12.5], ['doc-id-2', 8.3]]

// 직렬화
const json = engine.exportJSON();
fs.writeFileSync('index.json', json);
```

**주의사항:**
- `consolidate()` 호출 후에는 문서 추가 불가 → 재빌드 필요
- `importJSON()` 후 반드시 `definePrepTasks()` 재호출 필요

---

## 3. 한국어 토크나이징 전략

### 3.1 문제 정의

한국어는 영어와 달리:
- **교착어**: 어간 + 조사/어미가 결합 ("시스템을", "시스템이", "시스템에서" → 모두 "시스템")
- **복합어**: 띄어쓰기가 불규칙 ("전자문서" vs "전자 문서")
- **형태소 변이**: "설치하다" → "설치하는", "설치했던", "설치할"

| 쿼리 | 매칭해야 하는 문서 | 난이도 |
|------|-------------------|--------|
| "전자문서" | "전자 문서 관리 시스템" | 중 (띄어쓰기) |
| "설치 방법" | "설치하는 방법을 설명합니다" | 상 (어미 변형) |
| "DocuLight" | "DocuLight 사용 가이드" | 하 (영문 완전 일치) |
| "API" | "REST API 설계 문서" | 하 (영문) |

### 3.2 접근법 비교

#### A. 형태소 분석기 (MeCab, khaiii)

| 항목 | 평가 |
|------|------|
| 정확도 | 최상 (Recall ~0.87) |
| 네이티브 의존성 | MeCab: C++ 바이너리 필요, 사전 파일 수십 MB |
| khaiii.js | WASM 컴파일, 모델 데이터 수십 MB |
| Electron 배포 | 매우 어려움 (Windows 크로스컴파일 문제) |
| **결론** | **부적합** — Electron 앱 배포 복잡도 과도 |

#### B. Character Bi-gram (문자 바이그램)

학술적 근거: Lee, Cho, Park(1999) 논문에서 **바이그램 기반 인덱싱이 형태소 분석 기반보다 빠르면서도 검색 효과가 동등하거나 더 높다**고 보고. MySQL ngram 파서도 CJK에 이 방식 채택.

```
입력: "전자문서관리시스템"
바이그램: ["전자", "자문", "문서", "서관", "관리", "리시", "시스", "스템"]

쿼리: "전자 문서 관리"
바이그램: ["전자", "자문", "문서", "서관", "관리"]  (공백 제거 후)

겹치는 토큰: 5개 → 높은 BM25 점수
```

| 항목 | 평가 |
|------|------|
| 복합어 매칭 | **강함** — 띄어쓰기 변이에 강건 |
| 어미 변형 | 부분 매칭 가능 ("설치하" ∩ "설치한" = "설치") |
| 노이즈 | "자문", "서관" 같은 무의미 토큰 생성 |
| 번들 크기 | **0KB** |
| 크로스플랫폼 | **완벽** |

#### C. 공백 분리 + 조사 제거

```
입력: "시스템을 구축합니다"
토큰: ["시스템", "구축합니다"]  (조사 "을" 제거)
```

| 항목 | 평가 |
|------|------|
| 복합어 | **약함** — "전자문서" ≠ "전자" + "문서" |
| 어미 변형 | **약함** — "구축합니다" ≠ "구축" |
| 간단한 조사 패턴 | 가능 ("을/를/이/가/은/는/에/의/로/와/과" 등) |

### 3.3 선정: 복합 토크나이징 (Bi-gram + 어절 + 조사 제거)

세 가지 레이어를 결합하여 최적 품질:

```javascript
/**
 * DocuLight 한국어 복합 토크나이저
 * Layer 1: 어절 단위 (공백 분리)
 * Layer 2: 조사/어미 단순 제거 (정규식)
 * Layer 3: Character Bi-gram (공백 제거)
 */
function koreanTokenize(text) {
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s가-힣]/g, ' ')   // 특수문자 제거
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return [];

  const tokens = [];
  const words = normalized.split(' ');

  // Layer 1: 원형 어절
  tokens.push(...words);

  // Layer 2: 한글 조사/어미 단순 제거
  const suffixes = /(?:을|를|이|가|은|는|에|의|로|와|과|에서|까지|부터|으로|하다|합니다|합니까|하는|하여|된|되는|되어|이다|입니다)$/;
  for (const word of words) {
    if (/[가-힣]/.test(word)) {
      const stripped = word.replace(suffixes, '');
      if (stripped && stripped !== word && stripped.length >= 2) {
        tokens.push(stripped);
      }
    }
  }

  // Layer 3: 문자 바이그램 (공백 제거 텍스트)
  const flat = normalized.replace(/\s/g, '');
  for (let i = 0; i < flat.length - 1; i++) {
    tokens.push(flat.substring(i, i + 2));
  }

  return tokens;  // 중복 유지 (BM25 TF에 자연스럽게 반영)
}
```

### 3.4 검색 품질 검증 시나리오

| # | 쿼리 | 문서 | 예상 결과 |
|---|------|------|----------|
| 1 | "전자문서" | "전자 문서 관리" | **매칭** — 바이그램 "전자" 공유 |
| 2 | "설치 방법" | "설치하는 방법" | **매칭** — 어절 "방법" + 바이그램 "설치" 공유 |
| 3 | "DocuLight" | "DocuLight 가이드" | **매칭** — 영문 완전 일치 |
| 4 | "API 문서" | "REST API 설계" | **매칭** — "api" 일치 + 바이그램 "문서" |
| 5 | "시스템" | "시스템을 구축" | **매칭** — 조사 제거 "시스템" + 바이그램 "시스" |
| 6 | "프로젝트 검색" | "프로젝트별 검색 기능" | **매칭** — 어절 + 바이그램 다수 공유 |

### 3.5 한글 자모 분해 (es-hangul) — 보류

| 항목 | 결정 |
|------|------|
| 패키지 | `es-hangul` (Toss, ESM, tree-shakable) |
| 기능 | `disassemble()`: 자모 분해, `getChoseong()`: 초성 추출 |
| BM25 적합성 | **낮음** — 토큰 수 폭발로 TF-IDF 희석 |
| 활용 가능성 | 초성 검색 (`ㄱㄱ` → "검색 가이드") 보조 기능으로 추후 고려 |
| **결론** | **BM25 토크나이저로는 사용하지 않음**, 추후 초성 검색 기능으로 별도 검토 |

---

## 4. 프론트매터 파싱 라이브러리 평가

### 4.1 후보 비교

| 기준 | gray-matter | front-matter | 자체 구현 (현재) |
|------|------------|-------------|----------------|
| YAML 지원 | O | O | O (단순 key-value만) |
| JSON 지원 | O | X | X |
| 중첩 객체 | O | O | **X** |
| 배열 | O | O | **X** |
| stringify | O | X | O (`buildYamlBlock`) |
| `test()` 검증 | X | O | 정규식 가능 |
| 번들 크기 | 중간 (~50KB) | 작음 (~15KB) | 0KB |
| npm 다운로드/주 | 1.9M | 2.7M | - |
| 의존성 | js-yaml 등 | js-yaml | 없음 |

### 4.2 결정: 자체 구현 확장 (외부 라이브러리 불필요)

**이유:**
1. 현재 `frontmatter.js`에 `parseSimpleYaml()` + `buildYamlBlock()` 이미 구현됨
2. DocuLight 프론트매터는 **단순 key-value만 사용** (project, docName, description, date)
3. gray-matter 추가 시 번들 크기 +50KB + js-yaml 의존성 추가
4. 검색 인덱싱용 파싱은 이미 있는 `parseSimpleYaml()`로 충분
5. 추후 배열/중첩 지원 필요 시 gray-matter로 마이그레이션 용이

**확장 필요 사항:**
- `parseSimpleYaml()`이 파일 전체에서 프론트매터 블록을 추출 + 파싱하는 래퍼 함수 추가
- 이미 `fmRegex = /^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/` 패턴 존재

---

## 5. 인덱스 영속화 전략

### 5.1 방식 비교

| 방식 | 장점 | 단점 | 적합도 |
|------|------|------|--------|
| JSON 파일 | 간단, 디버깅 용이, 백업 가능 | 대규모 시 느림 | ★★★ |
| SQLite FTS5 | 고성능, 내장 전문검색 | 의존성 추가, 스키마 관리 | ★★ |
| IndexedDB | Electron 렌더러에서 사용 가능 | Main process 접근 불가 | ★ |

### 5.2 선정: JSON 파일

**저장 위치:** `{mcpAutoSavePath}/.doculight-search-index.json`

**이유:**
- 검색 대상 문서가 저장되는 경로에 인덱스도 함께 저장 → 논리적 일관성
- `wink-bm25-text-search`의 `exportJSON()`/`importJSON()` 직접 활용
- 숨김 파일(`.` 접두사)로 사용자에게 노출 방지
- 1,000개 문서 기준 인덱스 크기 ~1MB 이하 → JSON 충분

**인덱스 생명주기:**
```
[앱 시작]
  → mcpAutoSave 활성 + mcpAutoSavePath 설정됨?
  → YES: 인덱스 파일 존재?
    → YES: importJSON() → 즉시 검색 가능
    → NO: 전체 디렉토리 스캔 → 인덱싱 → exportJSON()
  → NO: 검색 비활성

[새 문서 저장 시]
  → 인덱스 무효화 마킹 → 백그라운드 재빌드

[검색 요청 시]
  → 인덱스 무효화 상태면 재빌드 후 검색
  → 유효하면 즉시 검색
```

---

## 6. 추가 의존성 영향 분석

### 현재 production 의존성 (3개)
```json
{
  "@modelcontextprotocol/sdk": "^1.12.1",
  "electron-store": "^8.2.0",
  "pdf-lib": "^1.17.1"
}
```

### 추가 예정 (1개)
```json
{
  "wink-bm25-text-search": "^3.1.2"  // 제로 의존성, ~30KB
}
```

**영향:**
- 의존성 트리: +1 패키지 (하위 의존성 없음)
- 번들 크기: +~30KB
- 보안 위험: 낮음 (winkjs 팀, MIT 라이선스, 활발한 유지보수)
- Electron 빌드: 영향 없음 (순수 JS)

---

## 7. 결론 요약

| 결정 사항 | 선택 | 근거 |
|----------|------|------|
| BM25 라이브러리 | `wink-bm25-text-search` | 필드별 가중치, 커스텀 토크나이저, 인덱스 직렬화 |
| 한국어 토크나이저 | 어절 + 조사 제거 + Character Bi-gram 복합 | 제로 의존성, 학술적 검증, 크로스플랫폼 |
| 프론트매터 파싱 | 자체 구현 확장 (`frontmatter.js`) | 이미 구현됨, 단순 key-value 충분 |
| 인덱스 저장 | JSON 파일 (`{savePath}/.doculight-search-index.json`) | `exportJSON()`/`importJSON()` 직접 활용 |
| 추가 의존성 | npm 1개 (`wink-bm25-text-search`) | 제로 하위 의존성 |
