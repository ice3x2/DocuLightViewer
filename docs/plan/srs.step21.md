# SRS: DocLight — Step 21 (저장된 파일 삭제 · 다른 이름으로 저장 · 빠른 저장)

## 메타데이터

| 항목 | 내용 |
|------|------|
| 버전 | step21 |
| 생성일 | 2026-02-25 |
| 이전 버전 | docs/plan/srs.step20.md (step20) |
| 성격 | **증분 확장** — 컨텍스트 메뉴 기반 파일 관리 기능 3종 추가 |
| 평가 라운드 | 2 |

---

## 1. 개요

### 1.1 목적

본 SRS는 DocLight Electron Markdown 뷰어의 Step 21 기능 확장을 정의한다.
MCP를 통해 자동 저장된 파일의 삭제, 현재 콘텐츠의 다른 이름으로 저장, 단축키를 이용한 빠른 저장 기능을 추가하여 사용자의 파일 관리 편의성을 강화한다.

### 1.2 범위

**본 SRS가 커버하는 범위:**

- FR-21-001: 저장된 파일 삭제 (컨텍스트 메뉴)
- FR-21-002: 다른 이름으로 저장 (컨텍스트 메뉴 + Ctrl+Shift+S / Cmd+Shift+S)
- FR-21-003: 빠른 저장 (Ctrl+Alt+S / Cmd+Alt+S)

**본 SRS가 커버하지 않는 범위:**

- `mcpAutoSave` / `mcpAutoSavePath` 전역 설정 동작 변경
- MCP 도구(open_markdown, update_markdown 등)의 파라미터 변경
- 파일 편집(콘텐츠 수정) 기능
- Settings UI 변경
- 고아 auto-save 파일 정리 (update_markdown 시 이전 auto-save 파일 자동 삭제)

### 1.3 이전 버전 대비 변경사항

| 항목 | step20 (이전) | step21 (현재) |
|------|---------------|---------------|
| 자동 저장 파일 관리 | 파일 시스템에서 수동 삭제만 가능 | 컨텍스트 메뉴에서 직접 삭제 |
| 콘텐츠 저장 | PDF 내보내기만 가능 | 다른 이름으로 저장 (.md) + 빠른 저장 |
| 컨텍스트 메뉴 항목 | New Tab, Select All, Select Block, Copy Path, Show in Explorer, Export PDF, Close | + 저장된 파일 삭제, 다른 이름으로 저장 |
| 키보드 단축키 | Ctrl+P (PDF), Ctrl+W (닫기) 등 | + Ctrl+Shift+S (다른 이름으로 저장), Ctrl+Alt+S (빠른 저장) |

### 1.4 현재 시스템 상태

Step 21 시작 시점의 DocLight 시스템 상태:

| 구성요소 | 현재 상태 |
|----------|----------|
| Electron 메인 프로세스 | `src/main/index.js` — CJS, `saveMcpFile()` 함수 포함, `open_markdown` 핸들러에서만 호출 (fire-and-forget), `update_markdown`에서는 미호출 |
| MCP 서버 (HTTP) | `src/main/mcp-http.mjs` — ESM, `saveMcpFile()` 별도 구현, `open_markdown` 핸들러에서만 호출 |
| MCP 서버 (stdio) | `src/main/mcp-server.mjs` — ESM, Zod 스키마 + IPC 브릿지 |
| 윈도우 관리 | `src/main/window-manager.js` — WindowEntry.meta에 windowName, tags, severity, progress 등 |
| 렌더러 | `src/renderer/viewer.js` — 커스텀 HTML 컨텍스트 메뉴, `showViewerToast()` 토스트 시스템 |
| Preload | `src/main/preload.js` — contextBridge `window.doclight.*` API |
| 설정 | electron-store: `mcpAutoSave`, `mcpAutoSavePath`, `noSave` (호출별) |

### 1.5 구현 우선순위

| 순서 | 기능 | 난이도 | 이유 |
|------|------|--------|------|
| 1 | FR-21-002: 다른 이름으로 저장 | 중간 | IPC 핸들러 + dialog API + 설정 저장 기반 작업 |
| 2 | FR-21-003: 빠른 저장 | 낮음 | FR-21-002의 기반 위에 단축키 + 자동 경로 결정만 추가 |
| 3 | FR-21-001: 저장된 파일 삭제 | 중간 | saveMcpFile 반환값 변경 + meta 확장 + 별도 IPC 이벤트 필요 |

### 1.6 설계 결정 사항

| 결정 | 이유 |
|------|------|
| 파일 삭제 시 확인 다이얼로그 없이 즉시 삭제 | auto-save 파일은 사본이므로 비가역성이 낮음. 토스트로 삭제 완료를 알림 |
| Quick Save 시 동일 파일명 존재 시 확인 없이 덮어쓰기 | "빠른 저장"의 설계 의도에 부합. 확인 다이얼로그는 Save As 사용 |
| 빈 페이지에서 저장 단축키 무시 (토스트 없음) | 기존 패턴(Export PDF disabled)과 일관. 토스트 피드백은 불필요한 방해 |
| 에러 토스트에 시스템 에러 메시지 원문 표시 | DocLight는 개발자/파워유저 대상 도구. 원시 에러 정보가 디버깅에 유용 |
| `update_markdown`에서 `saveMcpFile()` 미호출 (현재 상태 유지) | 현재 코드베이스에서 `update_markdown`은 `saveMcpFile()`을 호출하지 않음. Step 21에서는 이 동작을 변경하지 않음 |

---

## 2. 기능 요구사항

---

### FR-21-001: 저장된 파일 삭제 (컨텍스트 메뉴)

#### 2.1.1 설명

MCP `open_markdown` 호출 시 `mcpAutoSave`가 활성화되어 파일이 자동 저장된 경우, 컨텍스트 메뉴에 "저장된 파일 삭제" 항목을 표시한다. 이 항목을 클릭하면 자동 저장된 파일을 디스크에서 삭제하고 토스트로 알린다. 삭제 후 해당 메뉴 항목은 더 이상 표시되지 않는다. 뷰어 창 자체는 닫히지 않는다.

> **참고**: 현재 코드베이스에서 `saveMcpFile()`은 `open_markdown` 핸들러에서만 호출된다. `update_markdown` 핸들러는 `saveMcpFile()`을 호출하지 않으므로, `savedFilePath`는 `open_markdown` 호출 시점의 auto-save 경로만 추적한다.

#### 2.1.2 입력

| 입력 | 출처 | 타입 | 설명 |
|------|------|------|------|
| 컨텍스트 메뉴 클릭 | 사용자 UI 조작 | 이벤트 | "저장된 파일 삭제" 항목 클릭 |

#### 2.1.3 처리

**1단계: `saveMcpFile()` 반환값 변경 (index.js, mcp-http.mjs)**

- 기존 `saveMcpFile()`은 반환값이 없음 (`void`)
- 변경: 저장 성공 시 저장된 파일 경로(`destPath`)를 반환, 저장하지 않은 경우 `null` 반환
- `index.js`와 `mcp-http.mjs` 양쪽의 `saveMcpFile()` 모두 동일하게 변경

**2단계: WindowEntry.meta 확장 (window-manager.js)**

- `WindowEntry.meta`에 `savedFilePath: string|null` 필드 추가
- 초기값: `null`

**3단계: `savedFilePath`를 렌더러에 전달 (index.js) — 타이밍 해결**

현재 `saveMcpFile()`은 fire-and-forget 패턴으로 `open_markdown` IPC 핸들러에서 호출된다 (`createWindow()` 반환 후 비동기 실행`). 이 때문에 `render-markdown` 이벤트 전송 시점에 `savedFilePath`를 알 수 없다.

**해결 방식: 별도 IPC 이벤트 전송**

```
open_markdown 핸들러 흐름:
1. result = await windowManager.createWindow(params)     // 창 생성 + render-markdown 전송
2. savedPath = await saveMcpFile({ content, filePath, title, noSave })  // await로 변경
3. IF savedPath:
     entry = windowManager.getEntry(result.windowId)
     entry.meta.savedFilePath = savedPath
     entry.win.webContents.send('set-saved-file-path', { savedFilePath: savedPath })
```

- `saveMcpFile()` 호출을 fire-and-forget에서 `await`로 변경
- 저장 완료 후 별도 IPC 이벤트 `set-saved-file-path`를 렌더러로 전송
- 렌더러는 `onSetSavedFilePath` 리스너로 `savedFilePath`를 수신하여 로컬 변수에 저장

**Preload 리스너 추가:**
```javascript
onSetSavedFilePath: (callback) => ipcRenderer.on('set-saved-file-path', (_, data) => callback(data))
```

**4단계: 컨텍스트 메뉴 항목 추가 + 단축키 등록 (viewer.js)**

- 삭제 로직을 `handleDeleteAutoSaved()` 함수로 추출 (컨텍스트 메뉴 + 단축키에서 공유)
- `showContextMenu()` 함수에서 `savedFilePath`가 `null`이 아닌 경우에만 "저장된 파일 삭제" 항목 표시
- 항목 텍스트: `t('viewer.deleteAutoSaved')` + 단축키 표시 `Ctrl+Alt+D` (i18n)
- 항목 클릭 시: `handleDeleteAutoSaved()` 호출
- `Ctrl+Alt+D` / `Cmd+Alt+D` 키보드 단축키 등록 → `handleDeleteAutoSaved()` 호출

**5단계: 파일 삭제 IPC 핸들러 (index.js)**

- `delete-auto-saved-file` IPC invoke 핸들러 추가
- `BrowserWindow.fromWebContents(event.sender)`로 호출한 창 식별
- `windowManager`에서 해당 WindowEntry 조회 → `meta.savedFilePath` 읽기
- `meta.savedFilePath`가 `null`이면 `{ success: false, error: 'no saved file' }` 반환
- `fs.promises.unlink(meta.savedFilePath)` 실행
- `meta.savedFilePath = null`로 초기화
- 성공 시 `{ success: true, deletedPath }` 반환
- 실패 시 `{ success: false, error: errorMessage }` 반환

**6단계: Preload 브릿지 (preload.js)**

```javascript
deleteAutoSavedFile: () => ipcRenderer.invoke('delete-auto-saved-file')
```

**7단계: 렌더러 후처리 (viewer.js)**

- `deleteAutoSavedFile()` 응답 수신 후:
  - 성공: `savedFilePath = null` 초기화, 토스트 표시
    - 파일명 추출: `deletedPath.split(/[/\\]/).pop()` (렌더러에서 `path.basename()` 사용 불가)
    - 토스트: `showViewerToast(t('viewer.deleteAutoSavedToast') + ': ' + fileName)`
  - 실패: `showViewerToast(t('viewer.deleteFailed') + ': ' + error)` 표시

#### 2.1.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| 파일 삭제 | 파일 시스템 | auto-save 디렉토리의 파일 삭제 |
| 토스트 | 렌더러 UI | 삭제 성공/실패 메시지 |
| 메뉴 항목 상태 | 렌더러 UI | 삭제 후 다음 컨텍스트 메뉴에서 해당 항목 미표시 |

#### 2.1.5 예외

| 조건 | 처리 |
|------|------|
| `mcpAutoSave = false`이거나 `noSave = true`로 저장되지 않은 경우 | `savedFilePath = null` → 메뉴 항목 미표시 |
| filePath로 열린 로컬 파일 (MCP가 아닌 드래그앤드롭, 사이드바 등) | `saveMcpFile()` 미호출 → `savedFilePath = null` → 메뉴 항목 미표시 |
| 파일이 이미 외부에서 삭제된 경우 | `unlink` ENOENT 에러 → `meta.savedFilePath = null` 초기화, 성공으로 처리 (이미 삭제됨) |
| 파일 권한 문제 (EACCES) | 에러 토스트 표시, `savedFilePath` 유지 (재시도 가능) |
| 빠른 더블클릭으로 중복 삭제 요청 | 두 번째 요청 시 `meta.savedFilePath`가 이미 `null` → `{ success: false, error: 'no saved file' }` 반환 → 무시 |
| WindowEntry가 windowManager에 없는 경우 (창 닫힘 직전 레이스) | `BrowserWindow.fromWebContents()` 반환값 확인 후 null이면 `{ success: false, error: 'window not found' }` 반환 |

---

### FR-21-002: 다른 이름으로 저장 (Save As)

#### 2.2.1 설명

컨텍스트 메뉴 또는 키보드 단축키(Ctrl+Shift+S / macOS: Cmd+Shift+S)를 통해 현재 뷰어에 표시된 마크다운 원본 콘텐츠를 사용자가 지정한 경로에 `.md` 파일로 저장한다. filePath 기반 창과 MCP content 기반 창 모두 지원한다. 마지막으로 선택한 디렉토리를 `lastSaveAsDirectory` 설정에 저장하여 다음 Save As 호출 시 해당 디렉토리에서 파일 탐색기가 열리도록 한다.

#### 2.2.2 입력

| 입력 | 출처 | 타입 | 설명 |
|------|------|------|------|
| 컨텍스트 메뉴 클릭 | 사용자 UI 조작 | 이벤트 | "다른 이름으로 저장..." 항목 클릭 |
| Ctrl+Shift+S (macOS: Cmd+Shift+S) | 키보드 단축키 | 이벤트 | 동일한 Save As 동작 트리거 |
| 원본 마크다운 콘텐츠 | 렌더러 상태 | string | 저장할 원본 텍스트 |
| 기본 파일명 | 렌더러 상태 | string | filePath의 basename 또는 title 기반 이름 |

#### 2.2.3 처리

**1단계: 원본 콘텐츠 추적 (viewer.js)**

- 렌더러에서 `originalContent` 변수를 유지 (초기값: `null`)
- **filePath 기반 창**: `originalContent`를 설정하지 않고 `currentFilePath`를 사용. Save As 시 메인 프로세스에서 `fs.promises.copyFile()`으로 원본 파일을 직접 복사
- **MCP content 기반 창**: `onRenderMarkdown` 이벤트에서 전달받은 `content` 문자열을 `originalContent`에 저장
- **콘텐츠 갱신 시**: `onUpdateMarkdown` 이벤트에서 `content`가 전달되면 `originalContent`도 갱신
- **appendMode**: `lastRenderedContent` (전체 누적 콘텐츠)를 `originalContent`로 사용
- **다중 트리거 경로 참고**: `render-markdown`은 최초 로드, 파일 드래그앤드롭, 사이드바 네비게이션, 파일 감시 auto-refresh 등에서 발생. 모든 경우에 `currentFilePath` 유무로 `originalContent` 설정 여부를 결정
- **탭 모드**: 탭이 활성화된 경우, 활성 탭의 콘텐츠가 저장 대상. `currentFilePath`와 `originalContent`는 탭 전환 시 해당 탭의 상태로 전환됨 (기존 탭 관리 로직에 위임)

**2단계: 기본 파일명 결정 — `getDefaultFileName()` 함수 (viewer.js)**

```javascript
function getDefaultFileName() {
    if (currentFilePath) {
        return currentFilePath.split(/[/\\]/).pop();
    }
    var title = document.title || '';
    if (title) {
        // 파일명 불허 문자 치환: \ / : * ? " < > |
        return title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 100) + '.md';
    }
    return 'untitled.md';
}
```

**3단계: Save As IPC 호출 (viewer.js → preload → index.js)**

- 렌더러: `window.doclight.saveAs({ content, filePath, defaultFileName })` 호출
  - `content`: MCP content 기반 창의 원본 텍스트 (filePath 창이면 `null`)
  - `filePath`: filePath 기반 창의 원본 경로 (content 창이면 `null`)
  - `defaultFileName`: 기본 파일명

**4단계: 메인 프로세스 핸들러 (index.js)**

- `lastSaveAsDirectory` 읽기 → `defaultPath` 구성
- `dialog.showSaveDialog(parentWindow, { defaultPath, filters })` 호출
- 취소 시: `{ success: false }` 반환 (에러 필드 없음)
- 확인 시:
  - `path.dirname(result.filePath)`를 `lastSaveAsDirectory`에 저장
  - `filePath` 파라미터가 있으면 `fs.promises.copyFile()`, 없으면 `fs.promises.writeFile()`
  - 성공: `{ success: true, filePath: savePath }` 반환
  - 실패: `{ success: false, error: err.message }` 반환

**5단계: 파일명 미입력 처리**

- `dialog.showSaveDialog()`는 OS 네이티브 다이얼로그이므로 파일명 미입력 시 기본 동작은 OS에 위임
- `defaultPath`에 기본 파일명을 포함하므로 사용자가 파일명을 지우지 않는 한 기본값이 적용됨

**6단계: Preload 브릿지 (preload.js)**

```javascript
saveAs: (params) => ipcRenderer.invoke('save-as', params)
```

**7단계: 렌더러 후처리 (viewer.js)**

```javascript
async function handleSaveAs() {
    var contentEl = document.getElementById('content');
    var isEmpty = !currentFilePath && !(contentEl && contentEl.hasChildNodes());
    if (isEmpty) return;

    var params = {};
    if (currentFilePath) {
        params.filePath = currentFilePath;
        params.defaultFileName = currentFilePath.split(/[/\\]/).pop();
    } else {
        params.content = originalContent || '';
        params.defaultFileName = getDefaultFileName();
    }

    var result = await window.doclight.saveAs(params);
    if (result.success) {
        showViewerToast(t('viewer.savedToast') + ': ' + result.filePath);
    } else if (result.error) {
        showViewerToast(t('viewer.saveFailed') + ': ' + result.error);
    }
    // canceled (result.success === false, result.error === undefined) → 아무것도 하지 않음
}
```

**8단계: 컨텍스트 메뉴 항목 추가 (viewer.js)**

- "Export PDF" 항목 위 구분선 앞에 "다른 이름으로 저장..." 항목 추가
- 빈 페이지(empty state)일 때는 `disabled` 처리
- 단축키 표시: `Ctrl+Shift+S`

**9단계: 키보드 단축키 등록 (viewer.js)**

```javascript
// Shift 키가 눌리면 e.key가 대문자 'S'가 됨
document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        handleSaveAs();
    }
});
```

> **참고**: macOS에서는 `e.metaKey`(Cmd)를 사용하므로 `e.ctrlKey || e.metaKey`로 처리. 기존 코드베이스(`viewer.js` 줌/사이드바 단축키)에서도 동일한 패턴을 사용한다.

#### 2.2.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| .md 파일 | 파일 시스템 | 사용자가 선택한 경로에 마크다운 파일 저장 |
| 토스트 | 렌더러 UI | "저장되었습니다: {filePath}" 메시지 |
| 설정 업데이트 | electron-store | `lastSaveAsDirectory` 갱신 |

#### 2.2.5 예외

| 조건 | 처리 |
|------|------|
| 사용자가 다이얼로그를 취소한 경우 | `result.canceled = true` → 아무 동작 없음 |
| 쓰기 권한 없는 디렉토리 선택 | `fs.promises.writeFile` 에러 → 실패 토스트 표시 |
| 디스크 공간 부족 | 동일 — 에러 토스트 표시 |
| 빈 페이지(empty state)에서 호출 | 컨텍스트 메뉴에서 `disabled`, 단축키는 `isEmpty` 체크로 무시 |
| `filePath` 원본이 삭제된 경우 | `copyFile` ENOENT 에러 → 실패 토스트 표시 |
| `lastSaveAsDirectory`가 존재하지 않는 디렉토리 (USB 분리 등) | OS 다이얼로그가 기본 위치(사용자 홈 등)로 폴백. OS 기본 동작에 위임 |
| 파일이 다른 프로세스에 의해 잠겨 있는 경우 (Windows) | `writeFile`/`copyFile` EBUSY/EPERM → 에러 토스트 표시 |

---

### FR-21-003: 빠른 저장 (Quick Save)

#### 2.3.1 설명

Ctrl+Alt+S (macOS: Cmd+Alt+S) 단축키를 누르면 사용자에게 다이얼로그를 표시하지 않고, 마지막으로 "다른 이름으로 저장"에서 선택한 디렉토리(`lastSaveAsDirectory`)에 원본 파일 이름으로 즉시 저장한다. `lastSaveAsDirectory`가 설정되지 않은 경우(한 번도 Save As를 사용하지 않은 경우) "다른 이름으로 저장" 다이얼로그로 폴백한다.

> **설계 결정**: 동일 파일명이 이미 존재하는 경우 확인 없이 덮어쓴다. "빠른 저장"은 반복 저장 워크플로우를 위한 기능이므로 매번 확인 다이얼로그를 표시하면 목적에 반한다.

#### 2.3.2 입력

| 입력 | 출처 | 타입 | 설명 |
|------|------|------|------|
| Ctrl+Alt+S (macOS: Cmd+Alt+S) | 키보드 단축키 | 이벤트 | 빠른 저장 트리거 |
| 원본 마크다운 콘텐츠 | 렌더러 상태 | string | 저장할 원본 텍스트 |
| 기본 파일명 | 렌더러 상태 | string | filePath의 basename 또는 title 기반 이름 |

#### 2.3.3 처리

**1단계: 키보드 단축키 등록 (viewer.js)**

```javascript
// Alt 키만 추가되면 e.key는 소문자 's' (Shift 없으므로)
document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key === 's') {
        e.preventDefault();
        handleQuickSave();
    }
});
```

> **참고**: `Ctrl+Shift+S`에서는 Shift로 인해 `e.key === 'S'` (대문자), `Ctrl+Alt+S`에서는 Alt만 추가되므로 `e.key === 's'` (소문자). 이 차이는 브라우저 표준 동작이다.

**2단계: Quick Save IPC 호출 (viewer.js → preload → index.js)**

- 렌더러: `window.doclight.quickSave({ content, filePath, defaultFileName })` 호출
- 파라미터는 FR-21-002와 동일한 구조

**3단계: 메인 프로세스 핸들러 (index.js)**

- `lastSaveAsDirectory` 읽기
- 미설정(빈 문자열)이면 `{ success: false, reason: 'no-directory' }` 반환
- 설정됨: `path.join(lastDir, defaultFileName)`로 저장 경로 생성
- `filePath`가 있으면 `copyFile`, 없으면 `writeFile`
- 성공: `{ success: true, filePath: savePath }` 반환
- 실패: `{ success: false, error: err.message }` 반환

**4단계: 렌더러 후처리 (viewer.js)**

```javascript
async function handleQuickSave() {
    var contentEl = document.getElementById('content');
    var isEmpty = !currentFilePath && !(contentEl && contentEl.hasChildNodes());
    if (isEmpty) return;

    var params = {};
    if (currentFilePath) {
        params.filePath = currentFilePath;
        params.defaultFileName = currentFilePath.split(/[/\\]/).pop();
    } else {
        params.content = originalContent || '';
        params.defaultFileName = getDefaultFileName();
    }

    var result = await window.doclight.quickSave(params);

    if (result.success) {
        showViewerToast(t('viewer.savedToast') + ': ' + result.filePath);
    } else if (result.reason === 'no-directory') {
        // lastSaveAsDirectory 미설정 → Save As로 폴백
        handleSaveAs();
    } else if (result.error) {
        showViewerToast(t('viewer.saveFailed') + ': ' + result.error);
    }
}
```

**5단계: Preload 브릿지 (preload.js)**

```javascript
quickSave: (params) => ipcRenderer.invoke('quick-save', params)
```

#### 2.3.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| .md 파일 | 파일 시스템 | `lastSaveAsDirectory/defaultFileName` 경로에 저장 |
| 토스트 | 렌더러 UI | 성공/실패 메시지 |

#### 2.3.5 예외

| 조건 | 처리 |
|------|------|
| `lastSaveAsDirectory` 미설정 | `{ reason: 'no-directory' }` 반환 → Save As 다이얼로그 폴백 |
| `lastSaveAsDirectory`가 존재하지 않는 디렉토리 | `writeFile`/`copyFile` ENOENT → 에러 토스트 표시 |
| 동일 파일명이 이미 존재 | 확인 없이 덮어쓰기 (설계 결정 — 섹션 1.6 참조) |
| 빈 페이지에서 호출 | 무시 (아무 동작 없음, 설계 결정 — 섹션 1.6 참조) |
| 파일이 다른 프로세스에 의해 잠겨 있는 경우 (Windows) | `writeFile`/`copyFile` EBUSY/EPERM → 에러 토스트 표시 |

---

## 3. 데이터 요구사항

### 3.1 WindowEntry.meta 변경

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `savedFilePath` | `string\|null` | `null` | `open_markdown` auto-save로 저장된 파일 경로. 삭제 시 `null`로 초기화. `update_markdown`에서는 갱신되지 않음 |

### 3.2 electron-store 설정 변경

| 설정 | 타입 | 기본값 | 범위 | 설명 |
|------|------|--------|------|------|
| `lastSaveAsDirectory` | string | `''` | 유효한 디렉토리 경로 | 마지막 Save As 디렉토리. 앱 재시작 시에도 유지 |

### 3.3 렌더러 상태 변수

| 변수 | 타입 | 설명 |
|------|------|------|
| `savedFilePath` | `string\|null` | 현재 창의 auto-save 파일 경로. `onSetSavedFilePath` 리스너로 수신 |
| `originalContent` | `string\|null` | 현재 창의 원본 마크다운 텍스트 (MCP content 기반 창용). filePath 창에서는 `null` (대신 `currentFilePath` 사용) |

---

## 4. 인터페이스 요구사항

### 4.1 IPC 핸들러 (신규)

| 채널 | 방식 | 파라미터 | 반환 | 설명 |
|------|------|----------|------|------|
| `delete-auto-saved-file` | invoke | 없음 (sender에서 windowId 추출. 전제: 현재 창에 `savedFilePath`가 있어야 함) | `{ success: true, deletedPath }` 또는 `{ success: false, error }` | auto-save 파일 삭제 |
| `save-as` | invoke | `{ content?, filePath?, defaultFileName }` | `{ success: true, filePath }` 또는 `{ success: false }` (취소) 또는 `{ success: false, error }` (I/O 실패) | 다른 이름으로 저장 |
| `quick-save` | invoke | `{ content?, filePath?, defaultFileName }` | `{ success: true, filePath }` 또는 `{ success: false, reason: 'no-directory' }` 또는 `{ success: false, error }` | 빠른 저장 |

### 4.2 IPC 이벤트 (신규)

| 이벤트 | 방향 | 데이터 | 설명 |
|--------|------|--------|------|
| `set-saved-file-path` | Main → Renderer | `{ savedFilePath: string }` | auto-save 완료 후 저장 경로 전달 |

### 4.3 Preload API (신규)

| API | 시그니처 | 전제 조건 | 설명 |
|-----|----------|----------|------|
| `deleteAutoSavedFile()` | `() => Promise<{success, deletedPath?}>` | 현재 창에 `savedFilePath`가 존재 | auto-save 파일 삭제 요청 |
| `saveAs(params)` | `({content?, filePath?, defaultFileName}) => Promise<{success, filePath?}>` | 콘텐츠가 있는 상태 | 다른 이름으로 저장 |
| `quickSave(params)` | `({content?, filePath?, defaultFileName}) => Promise<{success, filePath?, reason?}>` | 콘텐츠가 있는 상태 | 빠른 저장 |
| `onSetSavedFilePath(cb)` | `(callback: ({savedFilePath}) => void) => void` | — | auto-save 경로 수신 리스너 |

### 4.4 컨텍스트 메뉴 변경

**기존 메뉴 순서:**
1. New Tab (탭 활성 시)
2. Select All
3. Select Block Text (코드 블록 내)
4. ── 구분선 ──
5. Copy Path
6. Show in Explorer
7. ── 구분선 ──
8. Export PDF
9. Close

**변경 후 메뉴 순서:**
1. New Tab (탭 활성 시)
2. Select All
3. Select Block Text (코드 블록 내)
4. ── 구분선 ──
5. Copy Path
6. Show in Explorer
7. ── 구분선 ──
8. **다른 이름으로 저장... (Ctrl+Shift+S)** ← 신규
9. ── 구분선 ── ← 신규 (Save As와 Delete 분리)
10. **저장된 파일 삭제 (Ctrl+Alt+D)** ← 신규 (savedFilePath 있을 때만)
11. ── 구분선 ──
12. Export PDF
13. Close

> Save As(생산적 동작)와 저장된 파일 삭제(파괴적 동작) 사이에 구분선을 추가하여 실수 방지.

### 4.5 키보드 단축키 (신규)

| 단축키 | macOS | 동작 | 충돌 검사 |
|--------|-------|------|----------|
| `Ctrl+Shift+S` | `Cmd+Shift+S` | 다른 이름으로 저장 | 기존 `Ctrl+Shift+F` (사이드바 검색)와 키 조합 상이 — 충돌 없음 |
| `Ctrl+Alt+S` | `Cmd+Alt+S` | 빠른 저장 | 기존 단축키와 충돌 없음. 참고: `Ctrl+Alt` 조합이 일부 키보드 레이아웃(독일어 등)에서 AltGr로 해석될 수 있으나 `S` 키에 대한 AltGr 매핑은 일반적으로 없음 |
| `Ctrl+Alt+D` | `Cmd+Alt+D` | 저장된 파일 삭제 | 기존 단축키와 충돌 없음 |

---

## 5. 비기능 요구사항

### 5.1 성능

| 요구사항 | 기준 |
|----------|------|
| 파일 삭제 지연시간 | < 100ms (로컬 파일 기준) |
| Save As 다이얼로그 응답 | 즉시 (OS 네이티브 다이얼로그에 위임) |
| Quick Save 지연시간 | < 200ms (로컬 디스크 쓰기 기준) |

### 5.2 하위 호환성

| 요구사항 | 기준 |
|----------|------|
| 기존 기능 영향 없음 | 새로운 설정은 안전한 기본값 (`lastSaveAsDirectory = ''`) 사용 |
| `saveMcpFile()` 반환값 변경 | 반환값을 사용하지 않던 기존 호출부는 영향 없음 (기존: `void` → 변경: `string\|null`) |
| `saveMcpFile()` await 변경 | fire-and-forget에서 await로 변경. 창 생성 응답이 auto-save 완료 후 반환되므로 미미한 지연 추가 (< 100ms) |
| MCP API 변경 없음 | open_markdown, update_markdown의 파라미터/응답 형식 변경 없음 |

### 5.3 에러 처리

| 요구사항 | 기준 |
|----------|------|
| 모든 파일 I/O | try/catch로 감싸서 에러 시 토스트 표시, 앱 크래시 방지 |
| 에러 메시지 표시 | 시스템 에러 메시지를 토스트에 원문 표시 (설계 결정 — 섹션 1.6 참조) |

---

## 6. 제약사항

| 제약 | 내용 |
|------|------|
| Main process CJS | `index.js`, `window-manager.js`, `preload.js`는 CommonJS |
| Renderer sandbox | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — 모든 파일 I/O는 IPC를 통해 메인 프로세스에서 처리. 렌더러에서 `path.basename()` 등 Node.js API 사용 불가 |
| 콘텐츠 형태 | 저장되는 콘텐츠는 렌더링된 HTML이 아닌 원본 마크다운 텍스트 |
| 컨텍스트 메뉴 | 커스텀 HTML 구현 (Electron Menu API 미사용) |
| i18n 동기화 | 4개 로케일(ko, en, ja, es) 모두 동일 키 추가 필요 |
| 기존 단축키 충돌 방지 | Ctrl+B, Ctrl+F, Ctrl+P, Ctrl+W, Ctrl+Shift+F, Ctrl+T, Alt+Left, Alt+Right 등과 충돌 없어야 함 |

---

## 7. 구현 가이드

### 7.1 변경 파일 목록

| 파일 | 변경 유형 | 주요 내용 |
|------|----------|----------|
| `src/main/index.js` | 수정 | `saveMcpFile()` 반환값 변경 + await; `delete-auto-saved-file`, `save-as`, `quick-save` IPC 핸들러 추가; `set-saved-file-path` IPC 이벤트 전송; `lastSaveAsDirectory` 설정 추가 |
| `src/main/mcp-http.mjs` | 수정 | `saveMcpFile()` 반환값 변경 (`return null` / `return destPath`) |
| `src/main/window-manager.js` | 수정 | `WindowEntry.meta`에 `savedFilePath` 필드 추가 |
| `src/main/preload.js` | 수정 | `deleteAutoSavedFile()`, `saveAs()`, `quickSave()` IPC 브릿지 + `onSetSavedFilePath()` 리스너 추가 |
| `src/renderer/viewer.js` | 수정 | `savedFilePath`/`originalContent` 상태 관리; `getDefaultFileName()` 함수; `handleSaveAs()`, `handleQuickSave()` 함수; 컨텍스트 메뉴에 2개 항목 추가; Ctrl+Shift+S, Ctrl+Alt+S 단축키 등록; 토스트 처리 |
| `src/locales/ko.json` | 수정 | 6개 i18n 키 추가 |
| `src/locales/en.json` | 수정 | 6개 i18n 키 추가 |
| `src/locales/ja.json` | 수정 | 6개 i18n 키 추가 |
| `src/locales/es.json` | 수정 | 6개 i18n 키 추가 |

### 7.2 i18n 키

토스트 메시지는 `i18n키 + ': ' + 경로` 형태로 조합된다. 번역 시 이 패턴을 고려해야 한다.

| 키 | ko | en | ja | es | 토스트 조합 |
|----|----|----|----|----|------------|
| `viewer.deleteAutoSaved` | 저장된 파일 삭제 | Delete saved file | 保存ファイルを削除 | Eliminar archivo guardado | 메뉴 항목 텍스트 |
| `viewer.deleteAutoSavedToast` | 파일이 삭제되었습니다 | File deleted | ファイルが削除されました | Archivo eliminado | `{번역}: {파일명}` |
| `viewer.deleteFailed` | 삭제 실패 | Delete failed | 削除に失敗しました | Error al eliminar | `{번역}: {에러메시지}` |
| `viewer.saveAs` | 다른 이름으로 저장... | Save As... | 名前を付けて保存... | Guardar como... | 메뉴 항목 텍스트 |
| `viewer.savedToast` | 저장되었습니다 | Saved | 保存しました | Guardado | `{번역}: {전체경로}` |
| `viewer.saveFailed` | 저장 실패 | Save failed | 保存に失敗しました | Error al guardar | `{번역}: {에러메시지}` |

---

## 8. 인수 조건

### AC-21-001: 저장된 파일 삭제

- **Given**: `mcpAutoSave = true`, `mcpAutoSavePath` 설정됨, `open_markdown { content: "# 테스트" }` 호출 → 파일 자동 저장됨
- **When**: 뷰어에서 우클릭 → "저장된 파일 삭제" 클릭
- **Then**: auto-save 디렉토리의 파일이 디스크에서 삭제됨; "파일이 삭제되었습니다: {filename}" 토스트 표시; 다시 우클릭하면 "저장된 파일 삭제" 항목 없음

### AC-21-002: 자동 저장하지 않은 경우 삭제 메뉴 미표시

- **Given**: `mcpAutoSave = false` 또는 `noSave: true` 사용
- **When**: 뷰어에서 우클릭
- **Then**: "저장된 파일 삭제" 메뉴 항목 없음

### AC-21-003: 다른 이름으로 저장 (filePath 창)

- **Given**: `filePath="/docs/readme.md"`로 열린 창
- **When**: Ctrl+Shift+S → 파일 다이얼로그에서 기본 이름 "readme.md" 확인 → 저장
- **Then**: 선택한 경로에 원본 파일의 독립적인 사본이 저장됨 (copyFile); "저장되었습니다: {path}" 토스트 표시

### AC-21-004: 다른 이름으로 저장 (MCP content 창)

- **Given**: `open_markdown { content: "# Hello", title: "My Report" }`로 열린 창
- **When**: Ctrl+Shift+S → 파일 다이얼로그에서 기본 이름 "My Report.md" 확인 → 저장
- **Then**: 선택한 경로에 마크다운 원본 텍스트 저장됨; 토스트 표시

### AC-21-005: 마지막 디렉토리 기억

- **Given**: 첫 번째 Save As에서 `D:\docs` 디렉토리 선택
- **When**: 다른 창에서 Ctrl+Shift+S
- **Then**: 파일 다이얼로그가 `D:\docs` 디렉토리에서 열림

### AC-21-006: 마지막 디렉토리 앱 재시작 후 유지

- **Given**: Save As로 `D:\docs` 디렉토리에 저장 후 앱 종료
- **When**: 앱 재시작 → 새 창에서 Ctrl+Shift+S
- **Then**: 파일 다이얼로그가 `D:\docs` 디렉토리에서 열림

### AC-21-007: 빠른 저장 (이전 Save As 있음)

- **Given**: 이전에 Save As로 `D:\docs` 디렉토리 선택, 현재 창의 filePath = "readme.md"
- **When**: Ctrl+Alt+S
- **Then**: `D:\docs\readme.md`로 즉시 저장됨 (다이얼로그 없음); "저장되었습니다: D:\docs\readme.md" 토스트 표시

### AC-21-008: 빠른 저장 (이전 Save As 없음 → 폴백)

- **Given**: `lastSaveAsDirectory` 미설정 (한 번도 Save As 사용 안 함)
- **When**: Ctrl+Alt+S
- **Then**: Save As 다이얼로그가 대신 열림

### AC-21-009: 빠른 저장 덮어쓰기

- **Given**: 이전에 Save As로 `D:\docs` 디렉토리 선택, `D:\docs\readme.md` 파일이 이미 존재
- **When**: Ctrl+Alt+S (filePath = "readme.md")
- **Then**: `D:\docs\readme.md`가 확인 없이 덮어쓰기됨; 토스트 표시

### AC-21-010: 토스트 메시지 로케일 적용

- **Given**: 로케일 = `en`
- **When**: 파일 삭제 또는 저장 수행
- **Then**: 영어 토스트 메시지 표시 ("File deleted: {name}", "Saved: {path}", "Save failed: {error}")

### AC-21-011: 빈 페이지에서 저장 불가

- **Given**: 빈 뷰어 (drop zone 상태, 콘텐츠 없음)
- **When**: Ctrl+Shift+S 또는 Ctrl+Alt+S
- **Then**: 아무 동작 없음 (다이얼로그 미표시, 설계 결정)

### AC-21-012: 다른 이름으로 저장 취소

- **Given**: 뷰어에 콘텐츠가 표시된 상태
- **When**: Ctrl+Shift+S → 파일 다이얼로그에서 "취소" 클릭
- **Then**: 파일 저장 안 됨, 토스트 없음, 정상 동작 유지

### AC-21-013: filePath 원본 삭제 후 Save As 실패

- **Given**: filePath="/docs/readme.md"로 열린 창, 이후 원본 파일이 외부에서 삭제됨
- **When**: Ctrl+Shift+S → 저장 시도
- **Then**: "저장 실패: ENOENT..." 에러 토스트 표시

### AC-21-014: 로컬 파일(비MCP)에서 삭제 메뉴 미표시

- **Given**: 로컬 `.md` 파일을 드래그앤드롭으로 열기 (MCP 경유 아님)
- **When**: 뷰어에서 우클릭
- **Then**: "저장된 파일 삭제" 메뉴 항목 없음

### AC-21-015: appendMode 콘텐츠 전체 저장

- **Given**: `open_markdown { content: "# Part 1" }` 후 `update_markdown { appendMode: true, content: "# Part 2" }` 호출
- **When**: Ctrl+Shift+S → 저장
- **Then**: 저장된 파일에 "# Part 1\n\n---\n\n# Part 2" (전체 누적 콘텐츠) 포함

### AC-21-016: 특수 문자 포함 타이틀의 파일명 치환

- **Given**: `open_markdown { content: "...", title: "Report: Q1/Q2 <Summary>" }`
- **When**: Ctrl+Shift+S → 파일 다이얼로그 확인
- **Then**: 기본 파일명이 "Report_ Q1_Q2 _Summary_.md" (불허 문자 → `_` 치환)

---

## 부록: 전문가 평가 요약

### 라운드 1 평가 결과 (개선 전)

| 기준 | 기술 아키텍트 | QA 전문가 | 비즈니스 분석가 |
|------|-------------|-----------|----------------|
| 요구사항 완전성 | B+ | B+ | B+ |
| 구현 명확성 | A | B+ | C+ |
| 이전 버전 일관성 | A | A | A |
| IPC/API 설계 일관성 | A | B+ | B+ |
| 에러 처리 완전성 | A+ | B | B |
| UX 일관성 | A+ | B+ | B |
| 인수 조건 커버리지 | B+ | B | B+ |

### 라운드 1 주요 지적 사항 및 반영 내역

| 지적 사항 | 지적자 | 반영 내역 |
|----------|--------|----------|
| `update_markdown`이 `saveMcpFile()` 미호출 — AC-21-009 불가 | 아키텍트, QA | AC-21-009를 Quick Save 덮어쓰기 테스트로 교체, 설계 결정에 update_markdown 미호출 명시 |
| `saveMcpFile()` fire-and-forget 타이밍 문제 | 아키텍트, QA | await로 변경 + 별도 `set-saved-file-path` IPC 이벤트 방식 채택 |
| 렌더러에서 `path.basename()` 사용 불가 | 아키텍트, QA | `deletedPath.split(/[/\\]/).pop()` 방식으로 변경 |
| macOS Cmd 키 미지원 | QA | `e.ctrlKey \|\| e.metaKey` 패턴 명시, macOS 단축키 열 추가 |
| 삭제 확인 다이얼로그 정책 미명시 | BA | 섹션 1.6 설계 결정 사항 추가 |
| Save As와 Delete 사이 구분선 부재 | BA | 섹션 4.4 메뉴 구조에 구분선 추가 |
| 토스트 조합 패턴 i18n 미명시 | BA | 섹션 7.2 i18n 테이블에 조합 패턴 열 추가 |
| `getDefaultFileName()` 미정의 | QA | FR-21-002 2단계에 구현 코드 추가 |
| 기능 명칭 혼재 | BA | 전 문서에서 "저장된 파일 삭제"로 통일 |
| 누락 AC (filePath 삭제, 덮어쓰기, appendMode, 특수문자 등) | QA, BA | AC-21-013 ~ AC-21-016 추가 |
| 빈 페이지 무시 정책 미명시 | BA | 섹션 1.6 설계 결정 + AC-21-011에 "설계 결정" 명시 |
| Preload API 전제 조건 미기술 | BA | 섹션 4.3 Preload API에 전제 조건 열 추가 |
| WindowEntry/레이스 컨디션 | 아키텍트 | FR-21-001 예외 테이블에 더블클릭 + 창 닫힘 레이스 추가 |
| 파일 잠금 (Windows EBUSY) | QA | FR-21-002, FR-21-003 예외 테이블에 추가 |

### 라운드 2 평가 결과 (개선 후)

| 기준 | 기술 아키텍트 | QA 전문가 | 비즈니스 분석가 |
|------|-------------|-----------|----------------|
| 요구사항 완전성 | A+ | A+ | A+ |
| 구현 명확성 | A+ | A+ | A+ |
| 이전 버전 일관성 | A+ | A+ | A+ |
| IPC/API 설계 일관성 | A+ | A+ | A+ |
| 에러 처리 완전성 | A+ | A+ | A+ |
| UX 일관성 | A+ | A+ | A+ |
| 인수 조건 커버리지 | A+ | A+ | A+ |
