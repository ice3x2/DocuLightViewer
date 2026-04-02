---
title: 원문 복사 기능 추가
project: DocuLightViewer
date: 2026-04-01
type: feature
tech_stack: Electron 33, JavaScript (CJS renderer)
code_path: C:\Work\git\_Snoworca\DocuLightViewer
request_doc: docs/srs/request/2026-04-01.request.srs-plan.원문복사.md
---

# 원문 복사 기능 추가

---

# Part 1: SRS (무엇을)

## 1.1 목적

뷰어의 컨텍스트 메뉴에 마크다운 원문 복사 기능을 추가하여, 사용자가 렌더링된 문서의 원본 마크다운을 클립보드로 복사할 수 있도록 한다.

## 1.2 배경

DocuLight는 마크다운을 HTML로 렌더링하여 표시한다. 사용자가 렌더링된 내용이 아닌 마크다운 원문을 복사하고 싶을 때, 현재는 파일을 직접 열거나 별도 편집기를 사용해야 한다. 컨텍스트 메뉴에서 바로 원문을 복사할 수 있으면 워크플로우가 개선된다.

## 1.3 기능 요구사항

- **FR-1**: 컨텍스트 메뉴에 "원문 복사" 항목 추가. 문서가 열려있는 상태(`!isEmpty`)에서만 표시.
- **FR-2**: 클릭 시 현재 문서의 마크다운 원문을 클립보드에 복사. 원문 획득 경로는 아래 케이스 구분표 참조.
- **FR-3**: 4개 언어(ko, en, ja, es) i18n 키 추가 — 메뉴 항목명 및 복사 완료 토스트 메시지.

### FR-2 원문 획득 케이스 구분표

| 우선순위 | 조건 | 원문 소스 | 발생 시점 |
|---------|------|----------|----------|
| 1 | `originalContent !== null` | `originalContent` 직접 사용 | MCP `open_markdown`/`update_markdown` (filePath 없음), 붙여넣기 |
| 2 | `currentFilePath !== null` | `readFileForTab(currentFilePath)` IPC 호출 | `.md` 파일 열기 (드래그, 파일 연결, URL 파라미터) |
| 3 | `saveAsFilePath !== null` | `readFileForTab(saveAsFilePath)` IPC 호출 | "다른 이름으로 저장" 실행 후 (`viewer.js:783`) |
| 4 | `savedFilePath !== null` | `readFileForTab(savedFilePath)` IPC 호출 | MCP 자동/수동 저장 후 (`viewer.js:714`, `825`) |
| - | 모두 null | 복사 불가 (아무 동작 안 함) | 빈 페이지 (isEmpty=true이므로 메뉴 항목 미표시) |

> **참고**: `readFileForTab`은 저장된 파일의 현재 내용을 반환한다. MCP 자동저장 파일은 frontmatter가 주입된 상태이므로, 순수 원문이 아닌 frontmatter 포함 마크다운이 복사된다. 이는 파일의 현재 상태를 정확히 반영하므로 의도된 동작이다.

## 1.4 비기능 요구사항

- **NFR-1**: 파일 읽기는 비동기(async)로 수행하여 UI 블로킹 방지.

## 1.5 제약사항

- 기존 컨텍스트 메뉴 항목 추가 패턴(`createElement` + `t()` + click handler) 준수
- 기존 복사 토스트 메시지 패턴(`showViewerToast`) 준수
- 기존 클립보드 복사 패턴(`navigator.clipboard.writeText().then().catch()`) 준수

## 1.6 현행 코드 분석

### 영향 범위

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `src/renderer/viewer.js` | 수정 | `showContextMenu()` 함수에 "원문 복사" 항목 추가 |
| `src/locales/ko.json` | 수정 | `viewer.copySource`, `viewer.sourceCopied` 키 추가 |
| `src/locales/en.json` | 수정 | 동일 |
| `src/locales/ja.json` | 수정 | 동일 |
| `src/locales/es.json` | 수정 | 동일 |

### 재사용 가능 코드

| 코드 | 위치 | 용도 |
|------|------|------|
| `showViewerToast(message, type)` | `viewer.js:732` | 복사 성공 토스트 표시 |
| `navigator.clipboard.writeText().then().catch()` | `viewer.js:1011` | 클립보드 복사 + 에러 처리 패턴 |
| `window.doclight.readFileForTab(filePath)` | `preload.js:135` | 파일 경로로 마크다운 원문 읽기 |
| `originalContent` 변수 | `viewer.js:59` | MCP/붙여넣기 문서의 마크다운 원문 |
| `currentFilePath` 변수 | `viewer.js:52` | 파일 기반 문서 경로 |
| `saveAsFilePath` 변수 | `viewer.js:63` | "다른 이름으로 저장" 경로 |
| `savedFilePath` 변수 | `viewer.js:58` | 자동 저장 파일 경로 (항상 `.md` — `viewer.js:825`에서 MCP 저장 결과 경로만 할당) |
| `isEmpty` 변수 | `viewer.js:930` | 빈 페이지 판정 (기존 변수 재사용) |

### 주의사항

- `originalContent`는 `filePath` 기반 문서에서 `null`임 (`viewer.js:519`). 반드시 파일 읽기 경로를 지원해야 함.
- `readFileForTab` IPC는 `.md`/`.markdown` 확장자만 허용 (`index.js:1554`). `savedFilePath`/`saveAsFilePath` 모두 `.md` 경로.
- `readFileForTab`은 파일 미존재 시 `{ error: 'File not found' }` 객체를 반환 (`index.js:1561`). `result.error` 존재 여부를 반드시 확인해야 함.
- 빈 페이지(`isEmpty`) 상태에서는 복사 대상 없음 — 메뉴 항목 자체를 표시하지 않음.

---

# Part 2: 구현 계획 (어떻게)

## Phase 1: 컨텍스트 메뉴 항목 추가 및 원문 복사 로직

- [ ] Phase 1-1: `viewer.js` `showContextMenu()` 함수의 `if (!isEmpty)` 블록 내부에 "원문 복사" 항목 추가 `FR-1` `FR-2`
  - **삽입 위치**: `sep`를 `menu.appendChild(sep)`하는 `viewer.js:1001` 행 직전에 삽입. 즉, 블럭 선택(`selectBlockItem`) 조건부 블록(`viewer.js:982~996`) 이후, 구분선 생성(`viewer.js:998`) 이전.
  - **조건**: `if (!isEmpty)` 블록 내부이므로 별도 isEmpty 체크 불필요 (기존 `isEmpty` 변수 `viewer.js:930` 재사용)
  - **패턴**: 기존 `ctx-menu-item` 생성 패턴 준수
  ```javascript
  // Copy Source (원문 복사)
  const copySourceItem = document.createElement('div');
  copySourceItem.className = 'ctx-menu-item';
  copySourceItem.textContent = t('viewer.copySource');
  copySourceItem.addEventListener('click', async () => {
    menu.remove();
    // FR-2: 원문 획득 (케이스 구분표 순서대로)
    let markdown = originalContent;
    if (!markdown) {
      const filePath = currentFilePath || saveAsFilePath || savedFilePath;
      if (filePath) {
        try {
          const result = await window.doclight.readFileForTab(filePath);
          if (result && !result.error && result.markdown) {
            markdown = result.markdown;
          }
        } catch (err) {
          console.error('[doculight] Failed to read source:', err);
        }
      }
    }
    if (markdown) {
      navigator.clipboard.writeText(markdown).then(() => {
        showViewerToast(t('viewer.sourceCopied'));
      }).catch((err) => {
        console.error('[doculight] Failed to copy source:', err);
      });
    }
  });
  menu.appendChild(copySourceItem);
  ```

- [ ] Phase 1-2: 4개 언어 파일에 i18n 키 추가 `FR-3`
  - `ko.json`: `"viewer.copySource": "원문 복사"`, `"viewer.sourceCopied": "원문이 복사되었습니다"`
  - `en.json`: `"viewer.copySource": "Copy Source"`, `"viewer.sourceCopied": "Source copied"`
  - `ja.json`: `"viewer.copySource": "ソースをコピー"`, `"viewer.sourceCopied": "ソースがコピーされました"`
  - `es.json`: `"viewer.copySource": "Copiar fuente"`, `"viewer.sourceCopied": "Fuente copiada"`
  - **삽입 위치**: 기존 `viewer.copy` 키 근처에 추가 (복사 관련 키 그룹)

- **재사용:** `showViewerToast` (`viewer.js:732`), `navigator.clipboard.writeText` 패턴 (`viewer.js:1011`), `readFileForTab` IPC (`preload.js:135`), `isEmpty` 변수 (`viewer.js:930`)
- **테스트:**
  - 정상 (MCP): MCP `open_markdown` 호출 → 우클릭 → "원문 복사" → 클립보드에 마크다운 원문 복사됨, 토스트 표시
  - 정상 (파일): `.md` 파일 드래그 → 우클릭 → "원문 복사" → 클립보드 내용이 원본 파일과 일치
  - 정상 (savedFilePath): MCP 문서 수동 저장 후(`savedFilePath` 있음, `currentFilePath`/`originalContent` 없음) → 우클릭 → "원문 복사" → `savedFilePath` 파일 내용과 일치
  - 정상 (saveAsFilePath): "다른 이름으로 저장" 실행 후 → 우클릭 → "원문 복사" → 저장된 파일 내용과 일치
  - 정상 (update_markdown): MCP `update_markdown` 호출 후 → 우클릭 → "원문 복사" → 갱신된 `originalContent` 복사됨
  - 예외 (빈 페이지): empty-state → 우클릭 → "원문 복사" 항목 미표시
  - 예외 (파일 삭제됨): `currentFilePath`의 파일이 삭제된 상태 → 원문 복사 시도 → 아무 동작 없음 (에러 토스트 없음, console.error만)
  - 경계값: 대용량 마크다운 파일(1MB+) → 복사 성공 확인

## 단위 테스트 계획

### 테스트 대상

| 대상 | 테스트 유형 | 시나리오 |
|------|------------|----------|
| 컨텍스트 메뉴 항목 표시 | 수동 테스트 | 문서 열림 → 항목 표시 / 빈 페이지 → 항목 미표시 |
| MCP 원문 복사 (`originalContent`) | 수동 테스트 | MCP `open_markdown` → 우클릭 → 원문 복사 → 붙여넣기 비교 |
| MCP update 후 원문 복사 | 수동 테스트 | MCP `update_markdown` → 우클릭 → 원문 복사 → 갱신 내용 확인 |
| 파일 원문 복사 (`currentFilePath`) | 수동 테스트 | `.md` 파일 드래그 → 우클릭 → 원문 복사 → 원본 파일과 비교 |
| 다른 이름으로 저장 후 (`saveAsFilePath`) | 수동 테스트 | "다른 이름으로 저장" → 우클릭 → 원문 복사 → 저장 파일과 비교 |
| 자동 저장 후 (`savedFilePath`) | 수동 테스트 | MCP 문서 수동 저장 → 우클릭 → 원문 복사 → 저장 파일과 비교 |
| 파일 삭제 후 복사 시도 | 수동 테스트 | 파일 열기 → 파일 삭제 → 우클릭 → 원문 복사 → 무동작 확인 |
| i18n 키 | 수동 테스트 | `npm run dev -- locale {ko,en,ja,es}` 로 4개 언어별 메뉴/토스트 텍스트 확인 |

### 기존 테스트 영향

- 기존 테스트 파일: `test/doclight.e2e.js` (E2E)
- 회귀 위험: 없음 (신규 메뉴 항목 추가만, 기존 항목 변경 없음)
- 추가 필요 테스트: 0개 (수동 테스트로 충분)

## 검증 기준

- [ ] 빌드 성공 (`npm start`)
- [ ] 기존 테스트 통과 (`npx playwright test`)
- [ ] MCP 문서에서 원문 복사 동작 확인
- [ ] 파일 기반 문서에서 원문 복사 동작 확인
- [ ] `saveAsFilePath` 케이스에서 원문 복사 동작 확인
- [ ] `savedFilePath` 단독 케이스에서 원문 복사 동작 확인
- [ ] `update_markdown` 후 원문 복사 동작 확인
- [ ] 빈 페이지에서 항목 미표시 확인
- [ ] 파일 삭제 상태에서 오류 없이 무동작 확인
- [ ] 4개 언어별 메뉴 텍스트 및 토스트 메시지 확인
- [ ] 요구사항 전수 매핑: FR-1 → Phase 1-1, FR-2 → Phase 1-1, FR-3 → Phase 1-2

## 후속 파이프라인

- 다음 단계: `snowroca-plan-driven-coder`
- 입력 인자:
  - PLAN_PATH: `docs/srs/step25.srs-plan.원문복사.2026-04-01.md`
  - LANGUAGE: JavaScript (ES2020, Electron renderer)
  - FRAMEWORK: Electron 33
  - CODE_PATH: `C:\Work\git\_Snoworca\DocuLightViewer`
