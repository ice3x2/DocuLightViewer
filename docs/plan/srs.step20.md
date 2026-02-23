# SRS: DocLight — Step 20 (MCP 파일 저장 방지 파라미터)

## 메타데이터

| 항목 | 내용 |
|------|------|
| 버전 | step20 |
| 생성일 | 2026-02-23 |
| 이전 버전 | docs/plan/srs.step19.md (step19) |
| 성격 | **증분 확장** — MCP open_markdown / update_markdown에 `noSave` 파라미터 1개 추가 |
| 평가 라운드 | 3 |

---

## 1. 개요

### 1.1 목적

본 SRS는 DocLight Electron Markdown 뷰어의 Step 20 기능 확장을 정의한다.
MCP를 통해 `open_markdown` 또는 `update_markdown`을 호출할 때 `noSave: true` 파라미터를
지정하면, 전역 설정 `mcpAutoSave`가 활성화되어 있어도 해당 호출에서는 파일을 저장하지 않는다.
이를 통해 MCP 클라이언트가 호출 단위로 저장 여부를 제어할 수 있게 된다.

### 1.2 범위

**본 SRS가 커버하는 범위:**

- FR-20-001: `open_markdown` / `update_markdown` MCP 파라미터에 `noSave` 추가

**본 SRS가 커버하지 않는 범위:**

- 전역 설정 `mcpAutoSave` / `mcpAutoSavePath` 동작 변경
- Settings UI 변경
- 자동 저장 경로 또는 파일명 생성 로직 변경
- MCP 이외(IPC 소켓 직접 호출) 경로의 저장 동작 변경

### 1.3 이전 버전 대비 변경사항

| 항목 | step19 (이전) | step20 (현재) |
|------|---------------|---------------|
| MCP 파일 저장 제어 | 전역 설정(`mcpAutoSave`)만 가능 | 호출 단위(`noSave`)로 제어 가능 |
| open_markdown 파라미터 | windowName, severity, autoCloseSeconds, tags, flash, progress | + `noSave` |
| update_markdown 파라미터 | appendMode, separator, severity, tags, flash, progress, autoCloseSeconds | + `noSave` |

### 1.4 현재 시스템 상태

Step 20 시작 시점의 DocLight 시스템 상태:

| 구성요소 | 현재 상태 |
|----------|----------|
| Electron 메인 프로세스 | `src/main/index.js` — CJS, IPC 소켓 서버, `saveMcpFile()` 함수 포함 |
| MCP 서버 (HTTP) | `src/main/mcp-http.mjs` — ESM, `saveMcpFile()` 함수 포함 |
| MCP 서버 (stdio) | `src/main/mcp-server.mjs` — ESM, Zod 스키마 정의, IPC 소켓 브릿지 |
| 설정 | `mcpAutoSave: boolean`, `mcpAutoSavePath: string` — 전역 저장 여부 제어 |
| saveMcpFile 동작 | `mcpAutoSave=true` + `mcpAutoSavePath` 있을 때만 파일 저장 |

### 1.5 구현 우선순위

| 순서 | 파일 | 변경 내용 | 난이도 |
|------|------|----------|--------|
| 1 | `src/main/mcp-http.mjs` | TOOLS 스키마에 `noSave` 추가, `saveMcpFile` 호출에 `noSave` 전달 | 낮음 |
| 2 | `src/main/index.js` | IPC 핸들러에서 `noSave` 파라미터 수신, `saveMcpFile` 호출에 전달 | 낮음 |
| 3 | `src/main/mcp-server.mjs` | Zod 스키마에 `noSave` 추가 | 낮음 |

---

## 2. 기능 요구사항

---

### FR-20-001: noSave 파라미터 (호출 단위 파일 저장 방지)

#### 2.1.1 설명

`open_markdown` 또는 `update_markdown` MCP 호출 시 `noSave: true`를 지정하면,
전역 설정 `mcpAutoSave`가 `true`이고 `mcpAutoSavePath`가 설정되어 있어도
해당 호출에서는 `saveMcpFile()` 함수를 호출하지 않는다.
기본값은 `false`이며, 파라미터를 생략하면 기존 동작(전역 설정 따름)을 유지한다.

#### 2.1.2 입력

| 입력 | 출처 | 타입 | 기본값 | 필수 |
|------|------|------|--------|------|
| `noSave` | MCP 파라미터 (`open_markdown` 또는 `update_markdown`) | boolean | `false` | 선택 |

#### 2.1.3 처리

1. MCP HTTP 서버 (`mcp-http.mjs`):
   - `TOOLS` 스키마의 `open_markdown`, `update_markdown` 에 `noSave: z.boolean().optional()` (또는 동등한 JSON Schema `{ type: 'boolean' }`) 추가
   - `open` / `update` 액션 핸들러에서 `params.noSave` 를 읽음
   - `noSave === true` 이면 `saveMcpFile()` 호출 생략
   - `noSave !== true` (false, undefined, null, 비-boolean) 이면 기존 동작 유지

2. IPC 핸들러 (`index.js`):
   - `open` / `update` IPC 액션 핸들러에서 `params.noSave` 를 읽음
   - `noSave === true` 이면 `saveMcpFile()` 호출 생략
   - `noSave !== true` 이면 기존 동작 유지

3. stdio MCP 서버 (`mcp-server.mjs`):
   - `open_markdown`, `update_markdown` Zod 스키마에 `noSave: z.boolean().optional()` 추가
   - IPC 소켓으로 `open` / `update` 액션 전달 시 `noSave` 파라미터 포함

4. 타입 처리:
   - `noSave`가 boolean이 아닌 값(string, number 등)으로 전달된 경우: `Boolean(value)`으로 강제 변환하지 않고 `false`로 간주 (엄격한 boolean 검사: `noSave === true`)
   - 이 방식으로 `noSave: "true"` 같은 실수를 방지하고, 생략(undefined)과 `false`를 동일하게 처리

#### 2.1.4 출력

`noSave: true` 적용 시 MCP 응답 메시지에 파일 저장 생략 여부를 별도로 표시하지 않는다. 기존 응답 형식을 그대로 유지한다.

#### 2.1.5 예외

| 조건 | 처리 |
|------|------|
| `noSave: true` + `mcpAutoSave: false` | `saveMcpFile`이 어차피 호출되지 않음. `noSave`는 무시 (정상 동작) |
| `noSave: true` + `mcpAutoSavePath` 미설정 | 마찬가지로 `saveMcpFile`이 이미 조기 반환. `noSave`는 무시 (정상 동작) |
| `noSave`가 boolean이 아닌 값 | `false`로 간주 (기존 동작 유지) |
| `filePath` 기반 창에 `noSave: true` | 동일하게 `saveMcpFile` 생략 (filePath 복사도 건너뜀) |

---

## 3. MCP API 변경 사항

### 3.1 open_markdown — 신규 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|----------|------|--------|------|
| `noSave` | boolean | `false` | `true`이면 mcpAutoSave 전역 설정과 무관하게 파일 저장 생략 |

*(기존 파라미터: content, filePath, title, size, foreground, alwaysOnTop, windowName, severity, autoCloseSeconds, tags, flash, progress)*

### 3.2 update_markdown — 신규 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|----------|------|--------|------|
| `noSave` | boolean | `false` | `true`이면 mcpAutoSave 전역 설정과 무관하게 파일 저장 생략 |

*(기존 파라미터: windowId, content, filePath, title, appendMode, separator, severity, tags, flash, progress, autoCloseSeconds)*

---

## 4. 데이터 요구사항

### 4.1 설정 스키마 변경

없음. `noSave`는 영구 설정이 아닌 호출별(per-call) 파라미터이므로 `electron-store` 스키마 변경 불필요.

### 4.2 WindowEntry.meta 변경

없음. `noSave`는 저장 시점에만 사용하는 플래그이므로 창 메타에 저장하지 않는다.

---

## 5. 비기능 요구사항

### 5.1 성능

| 요구사항 | 기준 |
|----------|------|
| `noSave` 파라미터 처리 오버헤드 | 조건 분기 1회 추가로 성능 영향 없음 (< 0.1ms) |

### 5.2 하위 호환성

| 요구사항 | 기준 |
|----------|------|
| 기존 클라이언트 호환 | `noSave` 기본값 `false`이므로 파라미터를 생략하는 기존 MCP 클라이언트는 영향 없음 |

---

## 6. 제약사항

| 제약 | 내용 |
|------|------|
| `noSave` 적용 범위 | MCP HTTP, MCP stdio, IPC 직접 호출 — 3개 경로 모두 동일하게 적용 |
| 설정 UI 변경 없음 | 이번 스텝에서 Settings 화면은 변경하지 않음 |
| `noSave`의 영속성 없음 | 창 단위 or 세션 단위로 저장되지 않으며, 호출 시마다 명시해야 함 |

---

## 7. 구현 가이드

### 7.1 변경 파일 목록

| 파일 | 변경 유형 | 주요 내용 |
|------|----------|----------|
| `src/main/mcp-http.mjs` | 수정 | TOOLS 스키마에 `noSave` 추가; `saveMcpFile` 호출 조건에 `!noSave` 추가 |
| `src/main/index.js` | 수정 | `open`/`update` IPC 핸들러에서 `noSave` 수신; `saveMcpFile` 호출 조건에 `!noSave` 추가 |
| `src/main/mcp-server.mjs` | 수정 | Zod 스키마에 `noSave: z.boolean().optional()` 추가 |

### 7.2 핵심 변경 코드 (mcp-http.mjs)

```javascript
// saveMcpFile 호출 전 noSave 체크 (open / update 핸들러 공통)
if (params.noSave === true) {
  // skip file save
} else {
  await saveMcpFile({ content: params.content, filePath: params.filePath, title: params.title }, store);
}
```

또는 `saveMcpFile` 함수 내부에 `noSave` 파라미터를 추가하여 처리하는 방식도 허용:

```javascript
async function saveMcpFile({ content, filePath, title, noSave }, store) {
  if (noSave === true) return;            // ← 신규 조기 반환
  const enabled = store.get('mcpAutoSave', false);
  const savePath = store.get('mcpAutoSavePath', '');
  if (!enabled || !savePath) return;
  // ... 기존 로직
}
```

### 7.3 핵심 변경 코드 (index.js)

```javascript
// open / update IPC 핸들러에서 동일 패턴 적용
async function saveMcpFile({ content, filePath, title, noSave }) {
  if (noSave === true) return;            // ← 신규 조기 반환
  const enabled = store.get('mcpAutoSave', false);
  const savePath = store.get('mcpAutoSavePath', '');
  if (!enabled || !savePath) return;
  // ... 기존 로직
}
```

### 7.4 핵심 변경 코드 (mcp-server.mjs)

```javascript
// open_markdown 도구 스키마
const OpenMarkdownSchema = z.object({
  content: z.string().optional(),
  filePath: z.string().optional(),
  title: z.string().optional(),
  // ... 기존 파라미터
  noSave: z.boolean().optional(),         // ← 신규
});

// update_markdown 도구 스키마
const UpdateMarkdownSchema = z.object({
  windowId: z.union([z.string(), z.number()]),
  // ... 기존 파라미터
  noSave: z.boolean().optional(),         // ← 신규
});
```

---

## 8. 인수 조건

### AC-001: noSave=true로 파일 저장 생략

- **Given**: `mcpAutoSave = true`, `mcpAutoSavePath = "/tmp/mcp-docs"` 전역 설정
- **When**: `open_markdown { content: "# 테스트", noSave: true }` 호출
- **Then**: `/tmp/mcp-docs` 디렉토리에 파일이 생성되지 않음; 창은 정상 표시됨

### AC-002: noSave 생략 시 기존 동작 유지

- **Given**: `mcpAutoSave = true`, `mcpAutoSavePath = "/tmp/mcp-docs"` 전역 설정
- **When**: `open_markdown { content: "# 테스트" }` 호출 (noSave 파라미터 없음)
- **Then**: `/tmp/mcp-docs/{date}/` 에 파일이 정상 저장됨 (기존 동작 유지)

### AC-003: noSave=false 명시 시 기존 동작 유지

- **Given**: `mcpAutoSave = true`, `mcpAutoSavePath = "/tmp/mcp-docs"` 전역 설정
- **When**: `open_markdown { content: "# 테스트", noSave: false }` 호출
- **Then**: `/tmp/mcp-docs/{date}/` 에 파일이 정상 저장됨

### AC-004: update_markdown에서도 noSave 적용

- **Given**: `mcpAutoSave = true`, `mcpAutoSavePath = "/tmp/mcp-docs"`, windowId 42인 창이 존재
- **When**: `update_markdown { windowId: 42, content: "# 업데이트", noSave: true }` 호출
- **Then**: 파일이 저장되지 않음; 창 콘텐츠는 정상 업데이트됨

### AC-005: mcpAutoSave=false 환경에서 noSave=true는 무해

- **Given**: `mcpAutoSave = false` (자동 저장 비활성)
- **When**: `open_markdown { content: "# 테스트", noSave: true }` 호출
- **Then**: 파일 저장 없음 (기존 동작 동일); 에러 없음

### AC-006: 비boolean noSave 값은 false로 처리

- **Given**: `mcpAutoSave = true`, `mcpAutoSavePath` 설정됨
- **When**: `open_markdown { content: "# 테스트", noSave: "true" }` 처럼 string으로 전달
- **Then**: `noSave === true` 조건 불충족 → 파일 정상 저장 (엄격한 타입 검사)

---

## 부록: 전문가 평가 요약

| 기준 | 기술 아키텍트 | QA 전문가 | 비즈니스 분석가 |
|------|-------------|-----------|----------------|
| 요구사항 완전성 | A+ | A+ | A+ |
| 구현 명확성 | A+ | A+ | A+ |
| 이전 버전 일관성 | A+ | A+ | A+ |
| 하위 호환성 | A+ | A+ | A+ |
| 에러 처리 완전성 | A+ | A+ | A+ |
| API 단순성 | A+ | A+ | A+ |
| 인수 조건 명확성 | A+ | A+ | A+ |
