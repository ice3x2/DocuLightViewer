---
title: alwaysOnTop 창 PDF 내보내기 멈춤 및 다중 창 z-order 수정
project: DocuLightViewer
date: 2026-03-25
type: fix
tech_stack: Electron 33 + Node.js (CJS main / ESM MCP)
code_path: C:\Work\git\_Snoworca\DocuLightViewer
---

# alwaysOnTop 창 PDF 내보내기 멈춤 및 다중 창 z-order 수정

## 1. 의도 및 요구사항

### 1.1 목적
alwaysOnTop 창에서 PDF 내보내기 시 네이티브 다이얼로그가 창 뒤에 숨어 멈추는 문제와, 여러 alwaysOnTop 창 간 클릭 시 z-order가 전환되지 않는 문제를 수정한다.

### 1.2 배경
MCP HTTP로 열린 DocuLight 창은 기본적으로 `alwaysOnTop: true`이다 (`mcp-http.mjs:165`). 이 상태에서:
1. PDF 내보내기 시 `dialog.showSaveDialog(senderWin)`의 네이티브 다이얼로그가 topmost 창 뒤에 열려 사용자에게 보이지 않고, 동시에 창을 모달로 잠가 완전히 멈춘 것처럼 보인다.
2. 여러 alwaysOnTop 창이 있을 때, 뒤에 있는 창을 클릭해도 앞으로 오지 않는다. Windows의 HWND_TOPMOST 그룹 내 z-order는 단순 클릭으로 자동 변경되지 않으며, `setAlwaysOnTop(true)` 재호출이 필요하지만 `focus` 이벤트 핸들러가 없다.

### 1.3 기능 요구사항
- FR-1: PDF 내보내기 시 `dialog.showSaveDialog` 호출 전에 `alwaysOnTop`를 임시 해제하고, 다이얼로그 닫힌 후 복원한다.
- FR-2: MCP 콘텐츠(`meta.filePath` null) 창에서도 PDF 내보내기가 가능하도록 `savedFilePath` → `lastRenderedContent` 순으로 fallback한다. `lastRenderedContent` 사용 시 `imageBasePath`는 `savedFilePath`가 있으면 그 디렉터리, 없으면 null(인라인 이미지 없음 가정)로 설정한다.
- FR-3: 콘텐츠 확보 가능 여부를 저장 다이얼로그 표시 **전에** 먼저 확인하여, 내보낼 수 없을 때 불필요하게 저장 위치를 선택하지 않도록 한다.
- FR-4: `window-ready` 대기에 15초 타임아웃을 추가하여 PDF 렌더링 창이 준비 신호를 보내지 못할 경우 무한 대기를 방지한다.
- FR-5: BrowserWindow `focus` 이벤트 핸들러를 추가하여, `alwaysOnTop` 창이 포커스를 받을 때 `setAlwaysOnTop(true)`를 재호출하여 topmost 그룹 내 최상위로 이동시킨다.

### 1.4 비기능 요구사항
- NFR-1: `alwaysOnTop` 해제/복원은 다이얼로그 표시 직전/직후에만 적용한다. 다른 MCP 호출이나 사용자 조작에 영향을 주지 않는다.
- NFR-2: `focus` 이벤트 핸들러에서 `setAlwaysOnTop` 재호출 시 무한 루프나 플리커가 발생하지 않아야 한다.

### 1.5 제약사항
- batch export (`scope === 'all'`)에도 동일하게 `alwaysOnTop` 임시 해제를 적용한다 (line 1311에도 `dialog.showSaveDialog` 호출 존재).
- `createEmptyWindow`에도 `focus` 핸들러를 추가한다 (빈 창도 `alwaysOnTop` 가능).

## 2. 현행 코드 분석

### 2.1 영향 범위
| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `src/main/index.js` | 수정 | `export-pdf` 핸들러: alwaysOnTop 임시 해제, MCP 콘텐츠 fallback, window-ready 타임아웃 |
| `src/main/window-manager.js` | 수정 | `createWindow`, `createEmptyWindow`: `focus` 이벤트 핸들러 추가 |

### 2.2 재사용 가능 코드
- `senderWin.isAlwaysOnTop()` / `senderWin.setAlwaysOnTop(bool)` — Electron BrowserWindow API 직접 사용
- `senderEntry.meta.alwaysOnTop` — 기존 meta에 이미 alwaysOnTop 상태 추적 중
- `senderEntry.meta.savedFilePath` — MCP 자동저장 경로 (기존 필드)
- `senderEntry.meta.lastRenderedContent` — MCP 콘텐츠 원본 (기존 필드)
- `pdf-render-complete` 대기의 타임아웃 패턴 (line 1269-1284) — `window-ready` 타임아웃에 동일 패턴 적용

### 2.3 주의사항
- `dialog.showSaveDialog` 후 `senderWin`이 destroyed 될 수 있으므로 복원 전 `isDestroyed()` 체크 필요
- batch export (scope=all)에도 line 1311에 별도의 `dialog.showSaveDialog` 호출이 있으므로 동일 패턴 적용 필요
- `focus` 이벤트에서 `setAlwaysOnTop(true)` 재호출 시 `meta.alwaysOnTop`가 `false`인 창에는 적용하지 않도록 조건 체크 필요
- `focus` 이벤트 핸들러는 window `closed` 시 자동 해제되므로 별도 cleanup 불필요

## 3. 구현 계획

## Phase 1: PDF 내보내기 alwaysOnTop 임시 해제 + MCP 콘텐츠 fallback
- [x] Phase 1-1: `export-pdf` 핸들러의 `scope === 'current'` 분기에서 콘텐츠 소스를 다이얼로그 표시 전에 먼저 확보한다. `meta.filePath` → `meta.savedFilePath` → `meta.lastRenderedContent` 순으로 fallback하고, 모두 없으면 `{ error }` 반환. `defaultName` 계산도 `filePath` → `savedFilePath` → `'document.pdf'` 순으로 수정. `imageBasePath`는 `filePath` 또는 `savedFilePath`의 디렉터리, 없으면 null `FR-2` `FR-3` ✅ (90점, 2026-03-25)
- [x] Phase 1-2: `scope === 'current'` 분기의 `dialog.showSaveDialog` 호출을 `try/finally` 패턴으로 감싸 alwaysOnTop 복원을 보장한다. `try` 전에 `const wasOnTop = senderWin.isAlwaysOnTop(); if (wasOnTop) senderWin.setAlwaysOnTop(false);`, `finally`에서 `if (wasOnTop && !senderWin.isDestroyed()) senderWin.setAlwaysOnTop(true);`. 다이얼로그 취소(canceled) 경우에도 반드시 복원됨 `FR-1` ✅ (90점, 2026-03-25)
- [x] Phase 1-3: `scope === 'all'` 분기(line 1311)의 `dialog.showSaveDialog`에도 동일한 `try/finally` alwaysOnTop 해제/복원 패턴 적용 `FR-1` ✅ (90점, 2026-03-25)
- [x] Phase 1-4: `window-ready` 대기(line 1233-1242)에 15초 타임아웃 추가. 기존 `pdf-render-complete` 타임아웃 패턴(line 1269-1284)과 동일한 구조 사용 `FR-4` ✅ (90점, 2026-03-25)
- [x] Phase 1-5: batch export의 `window-ready` 대기(line 1358-1367)에도 동일 타임아웃 적용 `FR-4` ✅ (90점, 2026-03-25)
- **테스트:**
  - (정상) alwaysOnTop 창에서 PDF 내보내기 → 저장 다이얼로그가 창 위에 정상 표시되고 저장 완료
  - (정상) MCP 콘텐츠(filePath null, savedFilePath 있음) 창에서 PDF 내보내기 → savedFilePath의 파일로 정상 내보내기
  - (정상) MCP 콘텐츠(filePath null, savedFilePath null, lastRenderedContent 있음) 창에서 PDF 내보내기 → 인메모리 콘텐츠로 정상 내보내기
  - (예외) 내보낼 콘텐츠가 전혀 없는 창 → 저장 다이얼로그 표시 없이 에러 반환
  - (예외) PDF 렌더링 창이 15초 내 준비되지 않음 → 타임아웃 에러 반환, 모달 정상 닫힘

## Phase 2: 다중 alwaysOnTop 창 z-order 수정
- [x] Phase 2-1: `window-manager.js`의 `createWindow`에서 `win.on('closed', ...)` 근처에 `win.on('focus', ...)` 이벤트 핸들러 추가. 핸들러 내에서 `entry.meta.alwaysOnTop`가 `true`이고 `!win.isDestroyed()`일 때만 `win.setAlwaysOnTop(true)` 재호출 `FR-5` ✅ (90점, 2026-03-25)
- [x] Phase 2-2: `createEmptyWindow`에도 동일한 `focus` 이벤트 핸들러 추가 `FR-5` ✅ (90점, 2026-03-25)
- **테스트:**
  - (정상) alwaysOnTop 창 A, B 순서로 열림 → B가 A 위 → A 클릭 → A가 B 위로 이동
  - (정상) alwaysOnTop=false 창 클릭 → `setAlwaysOnTop` 재호출 안 됨 (불필요한 API 호출 없음)
  - (예외) alwaysOnTop 해제(핀 토글) 후 클릭 → `setAlwaysOnTop` 재호출 안 됨

## 4. 검증 기준
- [ ] 빌드 성공 (`npm start`로 앱 실행 가능)
- [ ] 기존 E2E 테스트 통과 (`npx playwright test`)
- [ ] 요구사항 전수 매핑: FR-1 → Phase 1-2, 1-3 / FR-2 → Phase 1-1 / FR-3 → Phase 1-1 / FR-4 → Phase 1-4, 1-5 / FR-5 → Phase 2-1, 2-2
