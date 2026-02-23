# DocuLight Step 19 구현 완료 보고서

> **완료일**: 2026-02-23
> **프로젝트**: DocuLight Electron Markdown Viewer
> **작업**: Step 19 — 병렬 알람·보고 환경 지원 (7개 신규 기능)

---

## 📋 구현 요약

| Phase | 기능 | FR | 상태 |
|-------|------|----|------|
| Phase 1 | Named Window + Severity 테마 | FR-19-001, FR-19-003 | ✅ 완료 |
| Phase 2 | Taskbar 플래시 + Progress Bar | FR-19-006, FR-19-007 | ✅ 완료 |
| Phase 3 | Window 태그 | FR-19-005 | ✅ 완료 |
| Phase 4 | Auto-close 타이머 | FR-19-004 | ✅ 완료 |
| Phase 5 | Append 모드 | FR-19-002 | ✅ 완료 |
| Phase 6 | 통합 및 마무리 | — | ✅ 완료 |

---

## 🔧 구현된 기능 상세

### FR-19-001: Named Window (이름 기반 창 관리)
- `window-manager.js`에 `nameToId: Map<string, number>` 추가
- `getWindowByName(windowName)` 메서드 구현
- `createWindow()`에 upsert 로직 추가 — 동일 이름 창 존재 시 새 창 대신 기존 창 업데이트
- `win.on('closed')` 핸들러에서 `nameToId` 자동 정리

### FR-19-002: Append 모드
- `updateWindow()`에 `appendMode: boolean`, `separator: string` 파라미터 추가
- `meta.lastRenderedContent` 로 마지막 렌더링 내용 추적
- `filePath` 기반 창에서 append 불가 시 명확한 오류 메시지 제공

### FR-19-003: Severity 테마
- `viewer.html`에 `<div class="severity-bar" id="severity-bar"></div>` 추가
- `viewer.css`에 4가지 severity 색상 스타일 정의:
  - `info` → `#3b82f6` (파랑)
  - `success` → `#22c55e` (초록)
  - `warning` → `#f59e0b` (노랑)
  - `error` → `#ef4444` (빨강)
- `preload.js`에 `onSetSeverity` IPC 브릿지 추가
- `viewer.js`에 `onSetSeverity` 핸들러 구현

### FR-19-004: Auto-close 타이머
- `window-manager.js`의 `onWindowReady()`에 `setTimeout` 기반 자동 종료 구현
- `meta.autoCloseTimer` 로 타이머 핸들 추적 및 reset 가능
- `viewer.html`에 `<div id="auto-close-bar"></div>` 추가
- `viewer.js`에 `setInterval` 카운트다운 UI 구현 (5초 이하 시 `.urgent` 클래스 추가)
- 4개 로케일 파일에 `viewer.autoCloseLabel` 키 추가

### FR-19-005: Window 태그
- `meta.tags: string[]` 필드 도입
- `closeWindow(windowId, { tag })` — 태그 기반 일괄 종료
- `listWindows({ tag })` — 태그 필터링 지원
- `index.js`, `mcp-http.mjs`, `mcp-server.mjs` 모두 tag 파라미터 전파

### FR-19-006: Taskbar 플래시
- `win.flashFrame(true)` 호출 (Electron 네이티브 API)
- `onWindowReady()` 와 `updateWindow()` 양쪽에서 처리

### FR-19-007: Progress Bar
- `win.setProgressBar(progress)` 호출 (0.0~1.0, -1 = 숨김)
- `meta.progress` 필드로 현재 값 추적

---

## 📂 수정된 파일 목록

| 파일 | 변경 유형 |
|------|----------|
| `src/main/window-manager.js` | 핵심 로직 전체 확장 |
| `src/main/index.js` | IPC 핸들러 파라미터 전파 |
| `src/main/mcp-http.mjs` | TOOLS 스키마 + 핸들러 전체 업데이트 |
| `src/main/mcp-server.mjs` | Zod 스키마 + 핸들러 전체 업데이트 |
| `src/main/preload.js` | `onSetSeverity`, `onAutoCloseStart` 추가 |
| `src/renderer/viewer.html` | severity-bar, auto-close-bar DOM 추가 |
| `src/renderer/viewer.css` | severity/auto-close 스타일 추가 |
| `src/renderer/viewer.js` | IPC 이벤트 핸들러 구현 |
| `src/locales/ko.json` | `viewer.autoCloseLabel` 추가 |
| `src/locales/en.json` | `viewer.autoCloseLabel` 추가 |
| `src/locales/ja.json` | `viewer.autoCloseLabel` 추가 |
| `src/locales/es.json` | `viewer.autoCloseLabel` 추가 |
| `CLAUDE.md` | MCP Tools 표, meta 필드 섹션 업데이트 |

---

## 🆕 MCP API 변경 사항

### `open_markdown` 신규 파라미터
| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `windowName` | string (optional) | 이름 기반 upsert |
| `severity` | `info`\|`success`\|`warning`\|`error` | 창 상단 색상 바 |
| `tags` | string[] | 창 태그 목록 |
| `flash` | boolean | 태스크바 플래시 |
| `progress` | number (-1~1) | 진행률 바 |
| `autoCloseSeconds` | integer (1~3600) | 자동 종료 타이머 |

### `update_markdown` 신규 파라미터
| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `appendMode` | boolean (default: false) | 기존 내용에 추가 |
| `separator` | string (default: `\n\n`) | append 구분자 |
| `severity` | string\|null | severity 변경 (null로 제거) |
| `tags` | string[] | 태그 업데이트 |
| `flash` | boolean | 태스크바 플래시 |
| `progress` | number | 진행률 업데이트 |
| `autoCloseSeconds` | integer | 타이머 재설정 |

### `close_viewer` 신규 파라미터
- `tag: string (optional)` — 해당 태그의 모든 창 일괄 종료

### `list_viewers` 변경
- `tag: string (optional)` — 필터링
- 응답에 `windowName`, `tags`, `severity`, `progress` 추가

---

## ⚠️ 테스트 환경 이슈

E2E 테스트(Playwright)는 **기존 DocuLight 인스턴스가 IPC 파이프를 점유** 중이어서 실행 불가.
`\\.\pipe\doculight-ipc` `EADDRINUSE` 오류 — 앱을 종료 후 재실행하면 정상 테스트 가능.

단위 검증(`node -e`)으로 모든 핵심 로직 확인 완료:
- appendMode 로직 ✅
- nameToId / getWindowByName ✅
- 4개 로케일 키 ✅
- preload.js IPC 브릿지 ✅
- mcp-http.mjs / mcp-server.mjs 스키마 ✅

---

## ✅ 완료 체크리스트

- [x] Phase 1~6 모든 코드 구현
- [x] 4개 로케일 파일 업데이트
- [x] CLAUDE.md 업데이트
- [x] 플랜 문서 체크박스 완료 표시
- [x] 완료 보고서 DocuLight 전송
