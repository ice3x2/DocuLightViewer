# SRS: DocLight — Step 18 (기능 확장)

## 메타데이터

| 항목 | 내용 |
|------|------|
| 버전 | step18 |
| 생성일 | 2026-02-19 |
| 이전 버전 | docs/plan/srs.pivot.md (pivot-v1.0) |
| 성격 | **증분 확장** — 기존 Electron 데스크톱 뷰어에 7개 신규 기능 추가 |
| 평가 라운드 | 17 |

---

## 1. 개요

### 1.1 목적

본 SRS는 DocLight Electron Markdown 뷰어의 Step 18 기능 확장을 정의한다. 파일 감시 자동 새로고침, MCP 포트 디스커버리, PDF 내보내기, 사이드바 파일 검색, 최근 파일 트레이 메뉴, 탭 기반 다중 문서 뷰, 로컬 이미지 경로 해석 등 7개 기능을 추가하여 DocLight를 본격적인 데스크톱 Markdown 뷰어로 완성한다.

### 1.2 범위

**본 SRS가 커버하는 범위:**

- FR-18-001: 파일 감시 및 자동 새로고침 (File Watcher & Auto-Refresh)
- FR-18-002: MCP HTTP 포트 디스커버리 파일 (Port Discovery File)
- FR-18-003: PDF 내보내기 (PDF Export)
- FR-18-004: 사이드바 파일 검색 (Sidebar File Search)
- FR-18-005: 최근 파일 트레이 메뉴 (Recent Files in Tray Menu)
- FR-18-006: 탭 기반 다중 문서 뷰 (Tab-based Multi-document View)
- FR-18-007: 로컬 이미지 경로 해석 (Local Image Path Resolution)

**본 SRS가 커버하지 않는 범위:**

- 기존 기능의 변경 (MCP 도구 스키마, 사이드바 트리 로직 등은 기존 동작 유지)
- 클라우드 동기화, 협업 편집
- 모바일 앱

**Phase 2 백로그 (Step 18 초기 릴리스 이후 구현 예정):**

| 항목 | 관련 FR | 현재 상태 | 구현 조건 |
|------|---------|-----------|-----------|
| 탭 드래그 앤 드롭 순서 변경 | FR-18-006 | Phase 2 연기 (§2.6.3-F, AC-006-10) | 탭 핵심 기능 안정화 후 |
| 분당 최대 파일 갱신 횟수 제한 | FR-18-001 | 알려진 제한 (§2.1.3-4.1) | 빌드 스크립트 연속 갱신 사례 보고 시 |

### 1.3 이전 버전 대비 변경사항

| 항목 | pivot-v1.0 (이전) | step18 (현재) |
|------|-------------------|---------------|
| 파일 감시 | 없음 (수동 새로고침만) | `fs.watch()` 기반 자동 새로고침 |
| 포트 디스커버리 | 콘솔 로그로만 출력 | well-known 파일에 포트 기록 |
| PDF 내보내기 | 없음 | `printToPDF()` 기반 내보내기 UI |
| 사이드바 검색 | 없음 | 실시간 필터링 검색 |
| 최근 파일 | 없음 | 트레이 메뉴 서브메뉴 (최대 7개) |
| 다중 문서 | 창 1개 = 문서 1개 | 탭 기반 다중 문서 (창당 최대 20탭) |
| 이미지 경로 | 상대 경로 깨짐 | 자동 `file://` 절대 경로 변환 |

### 1.4 현재 시스템 상태

Step 18 시작 시점의 DocLight 시스템 상태:

| 구성요소 | 현재 상태 |
|----------|----------|
| Electron 메인 프로세스 | `src/main/index.js` — CJS, 시스템 트레이 상주, IPC 소켓 서버 |
| 윈도우 매니저 | `src/main/window-manager.js` — 다중 창 관리, 네비게이션 히스토리 |
| MCP 서버 (stdio) | `src/main/mcp-server.mjs` — ESM, IPC 소켓 브릿지 |
| MCP 서버 (HTTP) | `src/main/mcp-http.mjs` — ESM, JSON-RPC 2.0, 동적 포트 바인딩 |
| 렌더러 | `src/renderer/viewer.js` — marked + DOMPurify + highlight.js + Mermaid |
| 사이드바 | 디렉토리 트리 기반 (`link-parser.js → buildDirectoryTree()`) |
| i18n | 4개 로케일 (en, ko, ja, es), `src/main/strings.js` |
| 설정 | electron-store: theme, fontSize, fontFamily, codeTheme, mcpPort, defaultWindowSize, lastWindowBounds, fileAssociation |
| CSP | `img-src 'self' data: blob: file:` — file:// 이미지 허용 완료 |

### 1.5 구현 우선순위

| 순서 | 기능 | 난이도 | 이유 |
|------|------|--------|------|
| 1 | FR-18-007 이미지 경로 해석 | 낮음 | 의존성 없음, 렌더러 단독 변경 |
| 2 | FR-18-002 포트 디스커버리 | 낮음 | ~20줄 변경, AI 에이전트에 높은 가치 |
| 3 | FR-18-001 파일 감시 | 중간 | CLAUDE.md에 "Future Enhancement"로 언급. 잘 격리됨 |
| 4 | FR-18-005 최근 파일 | 낮음 | 트레이 메뉴만 변경, 렌더러 변경 없음 |
| 5 | FR-18-004 사이드바 검색 | 중간 | 렌더러 단독 기능. 탭 전에 안정화 필요 |
| 6 | FR-18-003 PDF 내보내기 | 높음 | 숨겨진 BrowserWindow 관리 복잡. 단일 파일 먼저, 배치 후순위 |
| 7 | FR-18-006 탭 | 매우 높음 | 모든 레이어 영향. 다른 기능 안정화 후 구현 |

---

## 2. 기능 요구사항

---

### FR-18-001: 파일 감시 및 자동 새로고침 (File Watcher & Auto-Refresh)

#### 2.1.1 설명

열려 있는 `.md` 파일의 변경을 감지하여 자동으로 다시 렌더링한다. 외부 에디터에서 Markdown 파일을 수정하면 DocLight 뷰어에 실시간으로 반영된다.

#### 2.1.2 입력

| 입력 | 출처 | 설명 |
|------|------|------|
| 파일 시스템 이벤트 | OS (`fs.watch()`) | 감시 대상 `.md` 파일의 `change` 이벤트 |
| `autoRefresh` 설정값 | electron-store | `true`(기본값)이면 감시 활성화, `false`이면 비활성화 |

#### 2.1.3 처리 로직

1. **감시 시작 조건**: 뷰어 창에 `filePath`로 문서가 로드될 때 (createWindow, navigateTo, file-dropped 모두 포함)
2. **감시 대상**: `entry.meta.filePath`에 저장된 절대 경로의 `.md` 파일
3. **감시 방법**: Node.js `fs.watch(filePath, { persistent: false })` 사용
   - `persistent: false`: 앱 종료를 방해하지 않음
   - Windows NTFS에서 정상 동작 (`fs.watchFile` 대비 성능 우수)
   - `change`와 `rename` 두 이벤트 타입 모두 수신
   - **macOS filename=null 대응**: macOS의 `fs.watch()`는 이벤트 콜백의 두 번째 인자(`filename`)가 `null`일 수 있다. 이 경우 원본 `filePath`로 폴백한다:
     ```javascript
     fs.watch(filePath, { persistent: false }, (eventType, filename) => {
       // macOS에서 filename이 null일 수 있음 — 원본 filePath로 폴백
       // rename 이벤트 처리는 항상 원본 filePath 기준으로 existsSync 확인
       const targetPath = (filename && eventType === 'change')
         ? path.join(path.dirname(filePath), filename)
         : filePath;
       // 이후 rename 처리: fs.existsSync(filePath) 로 원본 존재 확인
     });
     ```
3.1. **rename 이벤트 처리** (atomic save 대응):
   - VS Code, Vim 등의 에디터는 atomic save를 사용 (임시 파일에 쓰기 → 원본 파일명으로 rename)
   - `rename` 이벤트 수신 시: `fs.existsSync(filePath)`로 파일 존재 여부 확인
     - 파일이 존재하면: atomic save로 판단, `change` 이벤트와 동일하게 처리 (디바운스 타이머 적용 후 파일 재읽기)
     - 파일이 존재하지 않으면: 파일 삭제로 판단, watcher 해제 및 `console.error` 로깅
3.2. **fs.watch() 생성 시 예외 처리**:
   - `fs.watch()` 호출 자체를 try/catch로 감싸 안전하게 처리
   - 예외 발생 시 (파일 미존재, 권한 부족 등): `console.error` 로깅 후 watcher를 `null`로 설정
   - 앱 크래시 방지: watcher 생성 실패가 뷰어 기능에 영향을 주지 않음
4. **디바운스**: `change` 이벤트 수신 후 **300ms** 디바운스 타이머 적용
   - 300ms 이내 연속 이벤트는 무시 (에디터의 임시 저장 등 대응)
   - 디바운스 타이머 만료 시 파일 다시 읽기 실행
4.1. **장기 재렌더링 빈도 제한**: 디바운스는 짧은 연속 이벤트를 합산하지만, 장시간에 걸친 빈번한 변경(예: 빌드 스크립트가 반복적으로 파일 수정)에 대한 보호는 없다. **알려진 제한**: 현재 별도의 분당 최대 횟수 제한은 적용하지 않는다. 디바운스(300ms)만으로 대부분의 실사용 시나리오에서 충분하며, 추후 필요 시 분당 최대 갱신 횟수(예: 30회) 제한을 추가할 수 있다.
5. **파일 재읽기 및 렌더링**:
   ```
   console.log('[doculight] file-changed:', filePath)  // E2E 검증 포인트 (AC-001-1)
   fs.promises.readFile(filePath, 'utf-8')
   → win.webContents.send('render-markdown', { markdown, filePath, imageBasePath, platform: process.platform })
   ```
6. **스크롤 위치 보존**: 렌더러에서 `render-markdown` 수신 시, `filePath`가 이전과 동일하면 현재 `viewerContainer.scrollTop` 값을 저장하고 렌더링 후 복원
7. **감시 해제 조건**:
   - 창이 닫힐 때 (`win.on('closed')`)
   - 다른 파일로 네비게이션할 때 (`navigateTo` 호출 시 기존 watcher 해제 후 새 파일 감시 시작)
   - `content`만 제공되어 열린 창 (filePath 없음)은 감시 대상이 아님
8. **설정 변경 반영**: `autoRefresh` 설정이 변경되면 모든 열린 창의 watcher를 활성화/비활성화
   - `stopFileWatcher(windowId)` 호출 시: 진행 중인 디바운스 타이머(`clearTimeout(debounceTimer)`)를 **먼저** 해제한 후 `watcher.close()`를 호출한다. 타이머 해제 없이 watcher만 닫으면, 이미 스케줄된 파일 재읽기 콜백이 watcher 종료 후에도 실행되어 불필요한 I/O가 발생한다.
   - 각 watcher 엔트리는 `{ watcher: FSWatcher, debounceTimer: number | null }` 형태로 `WindowManager` 내부 Map에 저장하여 타이머 참조를 보관한다.
9. **에러 처리**: `fs.watch()` 에러 (파일 삭제, 권한 변경 등) 발생 시 `console.error` 로깅 후 해당 파일의 감시만 중단. 앱 크래시 금지

#### 2.1.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| 렌더링 갱신 | 뷰어 렌더러 | `render-markdown` IPC 메시지로 새 콘텐츠 전달 |
| 스크롤 위치 | 렌더러 내부 | 이전 스크롤 위치 복원 |

#### 2.1.5 예외

| 상황 | 동작 |
|------|------|
| 감시 중 파일 삭제 | watcher 해제, 기존 렌더링 유지, 콘솔 에러 로깅 |
| 감시 중 파일 권한 변경 (읽기 불가) | 재읽기 실패 시 기존 렌더링 유지, 콘솔 에러 로깅 |
| `autoRefresh: false` 설정 | 감시 시작하지 않음, 기존 watcher 있으면 해제 |
| content-only 모드 (filePath 없음) | 감시 대상 아님, 무시 |
| 동일 파일을 여러 창에서 열기 | 각 창이 독립적으로 감시 (탭 모드에서는 현재 활성 탭의 파일만 감시). **OS 리소스 영향**: `fs.watch()`는 OS 수준의 inotify(Linux)/FSEvents(macOS)/ReadDirectoryChangesW(Windows) 핸들을 사용하며, 동일 파일에 대해 복수 watcher를 생성해도 OS가 자체적으로 중복 핸들링하므로 리소스 영향은 미미하다. 이벤트 중복 발생 가능성은 각 watcher의 독립 디바운스(300ms)로 처리된다. |

#### 2.1.6 구현 위치

| 파일 | 변경 내용 |
|------|----------|
| `src/main/window-manager.js` | `startFileWatcher(windowId)`, `stopFileWatcher(windowId)` 메서드 추가. `createWindow`, `navigateTo`, `onWindowReady`에서 호출 |
| `src/main/index.js` | `file-dropped` 핸들러에서 watcher 시작. `autoRefresh` 설정 변경 시 전체 watcher 제어 |
| `src/renderer/viewer.js` | `render-markdown` 핸들러에서 동일 filePath 감지 시 스크롤 위치 보존 로직 추가 |
| `src/renderer/settings.html` | `autoRefresh` 체크박스 추가 |
| `src/renderer/settings.js` | `autoRefresh` 설정 저장/로드 |

#### 2.1.7 설정 스키마

```json
{
  "autoRefresh": {
    "type": "boolean",
    "default": true
  }
}
```

---

### FR-18-002: MCP HTTP 포트 디스커버리 파일

#### 2.2.1 설명

HTTP MCP 서버가 포트에 바인딩한 후, 외부 MCP 클라이언트가 포트를 발견할 수 있도록 well-known 파일에 포트 번호를 기록한다.

#### 2.2.2 입력

| 입력 | 출처 | 설명 |
|------|------|------|
| 바인딩된 포트 번호 | `httpServer.address().port` | 동적 포트 바인딩 결과 |

#### 2.2.3 처리 로직

1. **포트 파일 경로** (크로스 플랫폼):

   | 플랫폼 | 경로 | 결정 방법 |
   |--------|------|----------|
   | Windows | `%APPDATA%\doclight\mcp-port` | `app.getPath('userData')` 상위 → `process.env.APPDATA + '/doclight/mcp-port'` |
   | macOS | `~/Library/Application Support/doclight/mcp-port` | `app.getPath('userData') + '/mcp-port'` |
   | Linux | `~/.config/doclight/mcp-port` | `app.getPath('userData') + '/mcp-port'` |

   > **참고**: electron-store가 이미 `doclight` 디렉토리를 사용하므로 (`app.getPath('userData')` = `%APPDATA%\doclight`), 포트 파일 경로는 `path.join(app.getPath('userData'), 'mcp-port')`로 단순하게 결정한다.

2. **파일 기록 시점**: `startMcpHttpServer()` 함수 내에서 `httpServer.listen()` 콜백 성공 직후
3. **파일 내용**: 포트 번호만 평문으로 기록 (예: `52580`). 줄바꿈 없음, BOM 없음, UTF-8 인코딩
4. **기록 방법**:
   ```javascript
   const portFilePath = path.join(app.getPath('userData'), 'mcp-port');
   try {
     fs.writeFileSync(portFilePath, String(boundPort), 'utf-8');
   } catch (err) {
     console.error('[doculight] Failed to write port discovery file:', err.message);
     // NEVER throw — app must continue functioning
   }
   ```
5. **앱 종료 시 삭제**: `app.on('before-quit')` 핸들러에서 포트 파일 삭제 시도
   ```javascript
   try { fs.unlinkSync(portFilePath); } catch { /* best-effort, ignore errors */ }
   ```
   **`before-quit` 실행 순서**: 동일한 `before-quit` 핸들러에서 여러 정리 작업이 수행될 경우, 의존성 있는 순서로 실행한다:
   1. 모든 파일 watcher 해제 (`windowManager.stopAllFileWatchers()` — debounce 타이머 포함)
   2. 포트 파일 삭제 (best-effort, 위 코드 참조)
   각 단계는 try/catch로 독립적으로 감싸 하나의 실패가 이후 단계를 막지 않도록 한다.
6. **MCP 클라이언트 사용법**: 클라이언트는 해당 경로의 파일을 읽어 `parseInt(content.trim(), 10)`으로 포트를 얻는다

#### 2.2.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| 포트 파일 | 로컬 파일시스템 | `{userData}/mcp-port` 파일에 포트 번호 기록 |
| 콘솔 로그 | stderr | 기록 성공/실패 로깅 |

#### 2.2.5 예외

| 상황 | 동작 |
|------|------|
| 파일 쓰기 실패 (권한, 디스크 풀 등) | `console.error` 로깅, 앱 정상 계속 실행. **절대 크래시하지 않음** |
| 앱 종료 시 파일 삭제 실패 | 무시 (best-effort). 다음 실행 시 덮어쓰기 |
| userData 디렉토리 미존재 | electron-store가 이미 생성하므로 발생하지 않음. 만약 발생 시 `fs.mkdirSync(dir, { recursive: true })` 후 재시도 |
| 앱 비정상 종료 (크래시) | 포트 파일이 삭제되지 않아 stale 정보 잔존. **대응**: 앱 시작 시 포트 파일을 무조건 덮어쓰므로 다음 실행에서 자동 해소. 외부 클라이언트는 포트 연결 실패 시 포트 파일을 무시해야 한다. |

#### 2.2.6 구현 위치

| 파일 | 변경 내용 |
|------|----------|
| `src/main/mcp-http.mjs` | `startMcpHttpServer(windowManager, store, userDataPath)` — 세 번째 파라미터로 `app.getPath('userData')` 전달. 포트 바인딩 후 `path.join(userDataPath, 'mcp-port')` 파일에 기록 |
| `src/main/index.js` | `startMcpHttpServer(windowManager, store, app.getPath('userData'))` 호출. `before-quit`에서 포트 파일 삭제 |

---

### FR-18-003: PDF 내보내기

#### 2.3.1 설명

현재 보고 있는 Markdown 문서 또는 사이드바의 모든 파일을 PDF로 내보내는 기능. 뷰어 하단 우측 플로팅 버튼 영역에 PDF 내보내기 아이콘을 추가하고, 클릭 시 옵션 팝업을 표시한다.

#### 2.3.2 입력

| 입력 | 출처 | 설명 |
|------|------|------|
| 사용자 클릭 | PDF 내보내기 FAB 버튼 | 내보내기 다이얼로그 열기 |
| 내보내기 범위 | 라디오 버튼 | "현재 파일" 또는 "사이드바 전체 파일" |
| 페이지 크기 | 드롭다운 | A4 (기본값) 또는 Letter |

#### 2.3.3 처리 로직

**A. UI 흐름**

1. 플로팅 버튼 영역에 PDF 아이콘 버튼 추가 (기존 sidebar/toc/pin 버튼 사이)
2. 버튼 클릭 시 모달 오버레이 다이얼로그 표시:
   - 내보내기 범위: 라디오 버튼 2개
   - 페이지 크기: select 드롭다운
   - Save / Cancel 버튼
3. Cancel 클릭 또는 Escape 키: 다이얼로그 닫기
4. Save 클릭: IPC로 메인 프로세스에 내보내기 요청

**B. "현재 파일" 내보내기**

1. 렌더러에서 `ipcRenderer.invoke('export-pdf', { scope: 'current', pageSize })` 호출

   **`export-pdf` 요청 스키마:**
   ```json
   {
     "scope": "current | all",
     "pageSize": "A4 | Letter"
   }
   ```

   **입력 검증 (메인 프로세스):**
   1. `scope`가 `'current'` 또는 `'all'`인지 확인. 무효 값 수신 시 `{ error: "Invalid scope. Expected 'current' or 'all'" }` 반환
   2. `pageSize`가 `'A4'` 또는 `'Letter'`인지 확인. 무효 값 수신 시 기본값 `'A4'` 적용 (관대한 처리)
   3. `scope: 'all'`인데 사이드바 트리가 없는 경우 (content-only 모드): `{ error: "No sidebar tree available for batch export" }` 반환

2. 메인 프로세스에서 `dialog.showSaveDialog()` 실행:
   - 기본 파일명: 현재 파일명의 `.md`를 `.pdf`로 치환 (예: `README.md` → `README.pdf`)
   - content-only 모드인 경우 기본 파일명: `document.pdf`
   - 필터: `[{ name: 'PDF', extensions: ['pdf'] }]`
   - `savePath` 검증: (1) `savePath === undefined` (취소) → `{ cancelled: true }` 즉시 반환, (2) `path.extname(savePath).toLowerCase() !== '.pdf'` → `.pdf` 확장자 강제 추가
3. 사용자가 저장 위치 선택 후:
   a. 숨겨진 `BrowserWindow` 생성 (offscreen, `show: false`):
      ```javascript
      const pdfWin = new BrowserWindow({
        show: false,
        width: 1024,
        height: 768,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      ```
      - WindowManager의 `windows` Map에 등록하지 않음 (별도 참조 변수로 관리)
      - MCP `list_viewers` 도구에서 이 숨겨진 창이 노출되지 않음을 보장 (windows Map 미등록이므로 자동 제외)
   b. `viewer.html` 로드 후 `pdfWin.webContents.once('did-finish-load', callback)` 이벤트 대기. `did-finish-load`가 발생해야 렌더러의 `<script>` 실행이 완료되어 IPC 수신이 가능하다.
   c. `did-finish-load` 콜백 내에서 현재 문서의 markdown을 `render-markdown` IPC로 전달 (추가 필드 `{ pdfMode: true }` 포함). **주의**: 일반 뷰어 창은 `notifyReady` 핸드셰이크를 사용하지만, PDF 창은 WindowManager에 등록하지 않으므로 `did-finish-load` 이벤트를 직접 사용한다.
   c-1. **pdfMode 수신 시 렌더러 동작**:
      - FAB 버튼 영역 (`#floating-buttons`) 숨김 (`display: none`)
      - 사이드바 (`#sidebar-container`), TOC (`#toc-container`) 숨김
      - 리사이즈 핸들 (`#resize-handle`) 숨김
      - 탭 바 (`#tab-bar`) 숨김
      - `@media print` 또는 pdfMode 전용 CSS 적용: `body { margin: 0; } #viewer-container { width: 100%; overflow: visible; }`
      - 드래그앤드롭 이벤트 리스너 비활성화
      - 렌더러는 `pdfMode: true` 수신 시 `notifyReady()`를 WindowManager에 전송하지 않음. pdfWin은 `WindowManager.windows` Map에 등록되지 않으므로, 전역 `notify-ready` 핸들러가 windowId로 분기할 때 pdfWin 메시지는 자연스럽게 무시된다
      - 대신 Mermaid SVG 삽입 완료를 MutationObserver로 감지 후 200ms idle 타이머 후 `pdf-render-complete` IPC 전송
   d. 렌더링 완료 대기:
      1. 숨겨진 창의 렌더러가 `pdf-render-complete` IPC를 전송할 때까지 대기. **sender 검증**: `ipcMain.once('pdf-render-complete')` 대신 `pdfWin.webContents.ipc.once('pdf-render-complete')` 를 사용하여 해당 숨겨진 창의 렌더러에서 보낸 메시지만 수신한다. 이로써 다른 창에서 동일 채널명으로 전송한 메시지를 오인 수신하는 문제를 원천 차단한다. **동시 내보내기 방지**: `export-pdf` IPC 핸들러(`index.js` 내 `ipcMain.handle('export-pdf', ...)`) 클로저 스코프에 `let isExporting = false` 플래그를 선언한다. 핸들러 진입 시 `isExporting`을 확인하고, 이미 내보내기 진행 중이면 `{ isError: true, message: 'Export already in progress' }`를 반환한다. 성공/실패 모두 `finally { isExporting = false; }` 블록에서 플래그를 리셋하여 모든 종료 경로에서 복구를 보장한다. **pdfWin과 WindowManager의 관계**: 숨겨진 BrowserWindow(`pdfWin`)는 `WindowManager.windows` Map에 등록하지 않는다. 따라서 `ipcMain.on('notify-ready')` 전역 핸들러가 windowId 기반으로 분기할 때 pdfWin의 메시지는 무시된다(정상). 전역 핸들러에서 알 수 없는 windowId 수신 시 추가 로깅은 불필요하다.
      2. 렌더러는 Mermaid SVG 삽입 완료를 MutationObserver로 감지 후 200ms idle 타이머 후 IPC 전송
      > **렌더링 완료 감지 신뢰성**: MutationObserver + 200ms idle 타이머는 대부분의 경우 충분하나, 복잡한 Mermaid 다이어그램이 포함된 문서에서는 SVG 렌더링이 200ms를 초과할 수 있다. **Fallback 전략**: (1) Mermaid v10의 `mermaid.run()` Promise가 resolve된 후 200ms 대기 (Mermaid API 활용), (2) MutationObserver가 500ms 이상 추가 변경을 감지하지 못하면 완료로 판정, (3) 최대 대기 시간 30초는 안전망으로 유지. 구현 시 Mermaid의 `mermaid.run()` 완료를 우선 사용하고, MutationObserver는 Mermaid 외 비동기 콘텐츠(예: 지연 로드 이미지)에 대한 보조 감지로 활용한다.
      3. 최대 대기 시간: 30초 (타임아웃 시 현재 상태로 PDF 생성). **타임아웃 리스너 정리**: `pdfWin.webContents.ipc.once('pdf-render-complete')` 리스너는 타임아웃 발생 시 반드시 `pdfWin.webContents.ipc.removeListener()`로 해제한다. 구현 패턴: `setTimeout` + `pdfWin.webContents.ipc.once`를 `Promise`로 래핑하고, resolve/reject 시점에 상대 핸들러를 정리 (예: `AbortController` 또는 수동 `removeListener`).
   e. `pdfWin.webContents.printToPDF(options)` 호출:
      ```javascript
      {
        pageSize: pageSize, // 'A4' 또는 'Letter'
        printBackground: true,
        margins: { marginType: 'default' }
        // Electron 33의 printToPDF()는 margins 옵션으로 { marginType } 또는
        // { top, bottom, left, right } (인치 단위)를 지원한다.
        // marginType: 'default' (Chromium 기본 마진, ~0.4인치 ≈ 1cm)를 사용한다.
        // 이 값은 Electron 33.x 공식 API에서 확인된 사양이며, 추가 조사 불필요.
      }
      ```
   f. 반환된 Buffer를 `fs.promises.writeFile(savePath, buffer)` 로 저장
   g. 숨겨진 BrowserWindow 닫기
   h. 성공/실패 결과를 렌더러에 반환

**IPC 응답 스키마 (`export-pdf`):**

```
성공 (단일 파일):
{ success: true, path: "/path/to/output.pdf" }

성공 (다중 파일):
{ success: true, count: 15, directory: "/path/to/output/" }

부분 성공 (다중 파일, 일부 실패):
{ success: true, count: 12, failed: 3, directory: "/path/to/output/" }

취소:
{ cancelled: true, count: 5, total: 15, directory: "/path/to/output/" }

실패:
{ success: false, error: "에러 메시지" }
```

**C. "사이드바 전체 파일" 내보내기**

1. 렌더러에서 `ipcRenderer.invoke('export-pdf', { scope: 'all', pageSize })` 호출
2. 메인 프로세스에서 `dialog.showOpenDialog({ properties: ['openDirectory'] })` 실행
3. 사용자가 출력 디렉토리 선택 후:
   a. 현재 창의 `entry.meta.tree`에서 모든 `.md` 파일 경로 재귀 수집 — `collectMdPaths(tree, depth = 0): string[]` 함수를 `window-manager.js`에 구현. 반환 타입은 파일 절대 경로 문자열 배열이다. `tree.children`을 재귀 순회하며 `child.children`이 없는(파일) 노드의 `child.path` 중 `.md`/`.markdown` 확장자만 수집하여 배열로 반환한다. **재귀 깊이 제한**: `depth > 20`이면 해당 노드의 하위 순회를 중단하고 `console.warn('[doculight] collectMdPaths: depth limit exceeded at depth ' + depth)` 로깅. 실제 Markdown 문서 구조가 20레벨을 초과하는 경우는 없으므로 실용적 안전망이다.
   b. 각 파일에 대해 순차적으로:
      - 숨겨진 BrowserWindow 생성
      - 파일 읽기 → 렌더링 → `printToPDF()` → 저장
      - 파일명: 원본 `.md` 파일명의 확장자를 `.pdf`로 치환
      - BrowserWindow 닫기
   c. 진행률을 렌더러에 IPC로 전달: `win.webContents.send('export-progress', { current, total, fileName })`
   d. 취소 지원:
      - 다이얼로그의 Cancel 버튼이 내보내기 중에도 활성화
      - **취소 신호 메커니즘**: `ipcMain.handle`은 단일 invoke이므로 배치 루프 진행 중 렌더러에서 cancel을 전달하려면 별도 사이드채널 IPC를 사용한다:
        1. `export-pdf` 핸들러 진입 시, 클로저 스코프에 `let cancelled = false` 플래그 선언
        2. `ipcMain.once('cancel-export', () => { cancelled = true; })` 핸들러 등록
        3. 렌더러의 Cancel 버튼 클릭 → `ipcRenderer.send('cancel-export')` 호출
        4. 배치 루프에서 각 파일 처리 완료 후 `if (cancelled) break` 로 조기 종료
        5. 루프 완료(정상/취소) 후 `ipcMain.removeListener('cancel-export', handler)` 로 핸들러 해제
      - Cancel 클릭 시 현재 파일 처리 완료 후 나머지 중단
      - 이미 생성된 PDF 파일은 유지 (삭제하지 않음)
      - 결과 메시지: "내보내기 취소됨 (N/M 파일 완료)"
   e. 모든 파일 완료 후 결과 반환

**D. 진행률 표시 (렌더러)**

- "사이드바 전체 파일" 선택 시, 다이얼로그 내부에 프로그레스 바 + 텍스트 표시
- 텍스트: `"파일명.pdf (3/15)"` 형태
- 완료 시: "내보내기 완료" 메시지 2초간 표시 후 다이얼로그 자동 닫기

#### 2.3.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| PDF 파일(들) | 로컬 파일시스템 | 사용자가 선택한 경로에 저장 |
| 진행률 | 렌더러 UI | 다중 파일 내보내기 시 진행 표시 |
| 결과 메시지 | 렌더러 UI | 성공/실패 알림 |

#### 2.3.5 예외

| 상황 | 동작 |
|------|------|
| 저장 다이얼로그 취소 | 아무 동작 없이 다이얼로그 닫기 |
| PDF 생성 실패 (printToPDF 에러) | 에러 메시지 표시, 해당 파일 건너뛰고 다음 파일 계속 |
| 파일 쓰기 실패 (디스크 풀, 권한) | 에러 메시지 표시 |
| 사이드바 파일 없음 (content-only) | "사이드바 전체 파일" 라디오 버튼 비활성화 |
| 내보내기 중 앱 종료 | 숨겨진 BrowserWindow 정리 (before-quit 핸들러) |

#### 2.3.6 UI 목업

```
┌───────────────────────────────────────┐
│          PDF 내보내기 / PDF Export     │
│───────────────────────────────────────│
│                                       │
│  내보내기 범위:                        │
│  (●) 현재 파일                        │
│  ( ) 사이드바 전체 파일                │
│                                       │
│  페이지 크기:                          │
│  ┌─────────────────────────────┐      │
│  │ A4                     ▼   │      │
│  └─────────────────────────────┘      │
│                                       │
│  ┌──────────────────────────────────┐ │
│  │ ████████████░░░░░░  3/15        │ │  ← 다중 파일 시만 표시
│  │ exporting: chapter3.pdf          │ │
│  └──────────────────────────────────┘ │
│                                       │
│           [ Cancel ]  [ Save ]        │
│                                       │
└───────────────────────────────────────┘
```

**플로팅 버튼 영역 (기존 + 신규):**

```
┌─────────┐
│ ☰ Files │  ← btn-toggle-sidebar (기존)
├─────────┤
│ # TOC   │  ← btn-toggle-toc (기존)
├─────────┤
│ 📌 Pin  │  ← btn-toggle-pin (기존)
├─────────┤
│ 📄 PDF  │  ← btn-export-pdf (신규)
└─────────┘
```

#### 2.3.7 구현 위치

| 파일 | 변경 내용 |
|------|----------|
| `src/renderer/viewer.html` | PDF FAB 버튼 추가, 내보내기 모달 HTML 추가 |
| `src/renderer/viewer.js` | PDF 버튼 클릭 핸들러, 모달 로직, 진행률 표시, IPC 호출 |
| `src/renderer/viewer.css` | 모달 스타일, 프로그레스 바 스타일 |
| `src/main/index.js` | `export-pdf` IPC 핸들러 등록 |
| `src/main/window-manager.js` | `exportPdf(windowId, opts)` 메서드 — 숨겨진 BrowserWindow 생성, printToPDF 실행, 결과 반환 |
| `src/main/preload.js` | `exportPdf(opts)` invoke 추가, `onExportProgress(callback)` 리스너 추가 |

#### 2.3.8 Preload API 추가

> **참고**: 탭 관련 Preload API는 §2.6.8에 별도 정의. `preload.js`의 최종 추가 목록은 부록 Preload API 요약과 §2.6.8을 함께 참조한다.

```javascript
// Senders (Renderer → Main)
exportPdf: (opts) => ipcRenderer.invoke('export-pdf', opts),
pdfRenderComplete: () => ipcRenderer.send('pdf-render-complete'),
// ⚠️ pdfRenderComplete는 pdfMode: true인 숨겨진 PDF 창에서만 호출한다.
// 일반 뷰어 창은 이 메서드를 절대 호출하지 않는다.

// Listeners (Main → Renderer)
onExportProgress: (callback) => {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on('export-progress', handler);
  return () => ipcRenderer.removeListener('export-progress', handler);
}
```

---

### FR-18-004: 사이드바 파일 검색

#### 2.4.1 설명

사이드바 상단에 검색 입력 필드를 추가하여 파일 트리를 실시간으로 필터링한다. 대소문자 무시 부분 일치로 파일명을 검색하고, 일치하는 부분을 하이라이트한다.

#### 2.4.2 입력

| 입력 | 출처 | 설명 |
|------|------|------|
| 검색 텍스트 | 사이드바 검색 입력 필드 | 실시간 `input` 이벤트 |
| 키보드 단축키 | `Ctrl+Shift+F` / `Cmd+Shift+F` | 검색 필드 포커스 |
| Escape 키 | 검색 필드 포커스 상태 | 검색 모드 종료 |

#### 2.4.3 처리 로직

1. **검색 UI 구조**:
   - 사이드바 헤더 (`#sidebar-header`) 내에 검색 토글 버튼 (돋보기 아이콘) 추가
   - 검색 토글 클릭 시 사이드바 헤더 아래에 검색 입력 필드 슬라이드 표시
   - 검색 입력 필드: `<input type="text">` + 우측 X(닫기) 버튼

2. **검색 모드 진입**:
   - 검색 버튼 클릭 또는 `Ctrl+Shift+F` / `Cmd+Shift+F`
   - 검색 입력 필드 표시 및 자동 포커스
   - 기존 트리 뷰 유지 (검색어 입력 시부터 필터링 시작)

3. **실시간 필터링** (`input` 이벤트):
   - 검색어가 빈 문자열이면 전체 트리 표시 (검색 모드 유지)
   - 검색어가 있으면:
     a. 전체 트리의 모든 파일(비디렉토리) 노드를 플랫 리스트로 수집
     b. `node.title.toLowerCase().includes(query.toLowerCase())` 조건으로 필터링
     c. 필터링 결과를 플랫 리스트로 표시 (디렉토리 계층 무시)
     d. 파일명에서 일치하는 부분을 `<mark>` 태그로 감싸 하이라이트
     e. 부모 디렉토리명을 회색 서브텍스트로 표시 (동명 파일 구분용)

4. **검색 모드 종료**:
   - X 버튼 클릭, Escape 키, 또는 검색어 전체 삭제 후 X 클릭
   - 검색 입력 필드 숨김
   - 원래 트리 뷰 복원
   - **Escape 키 우선순위** (전역):
     1. PDF 내보내기 모달이 열려 있으면 → 모달 닫기
     2. 사이드바 검색 모드가 활성이면 → 검색 모드 종료
     3. always-on-top이 활성이면 → always-on-top 해제
     - 첫 번째 일치하는 핸들러가 이벤트를 소비

5. **결과 클릭**: 필터링된 결과 항목 클릭 시 해당 파일로 네비게이션 (`window.DocuLight.fn.navigateToForTab(href)` 호출). **Late binding 패턴**: 이 함수 참조는 클릭 이벤트가 발생하는 시점에 `window.DocuLight.fn.navigateToForTab`를 조회하므로, sidebar-search.js 모듈이 tab-manager.js init() 실행 전에 초기화되더라도 올바른 구현(탭 인터셉트 포함)을 호출한다. 즉, 모듈 간 초기화 순서에 의존하지 않는 안전한 참조 방식이다.

#### 2.4.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| 필터링된 트리 | `#sidebar-tree` DOM | 검색어와 일치하는 파일만 표시 |
| 하이라이트 | 파일명 텍스트 | `<mark>` 태그로 일치 부분 강조 |

#### 2.4.5 예외

| 상황 | 동작 |
|------|------|
| 사이드바에 파일이 없는 경우 | 검색 버튼 숨김 또는 비활성화 |
| 검색 결과 0건 | "결과 없음" 메시지 표시 |
| 매우 긴 검색어 (100자 초과) | 100자로 자르기 (maxlength 속성) |
| 특수문자 입력 | 정규식 이스케이프 없이 `String.includes()` 사용 (안전) |

#### 2.4.6 UI 목업

**검색 모드 비활성 상태:**

```
┌─ Sidebar ────────────────────┐
│ Navigation            [🔍]   │  ← 헤더에 검색 버튼
│──────────────────────────────│
│ ▼ 📁 docs                    │
│   📄 README.md               │
│   📄 guide.md                │
│   ▼ 📁 api                   │
│     📄 endpoints.md          │
│     📄 auth.md               │
│   📄 changelog.md            │
└──────────────────────────────┘
```

**검색 모드 활성 상태:**

```
┌─ Sidebar ────────────────────┐
│ Navigation            [🔍]   │
│ ┌────────────────────┬──┐    │
│ │ auth               │✕ │    │  ← 검색 입력 필드
│ └────────────────────┴──┘    │
│──────────────────────────────│
│ 📄 <mark>auth</mark>.md      │  ← 일치 부분 하이라이트
│     api/                     │  ← 부모 디렉토리 (서브텍스트)
│ 📄 <mark>auth</mark>-guide.md│
│     docs/                    │
└──────────────────────────────┘
```

#### 2.4.7 구현 위치

| 파일 | 변경 내용 |
|------|----------|
| `src/renderer/viewer.html` | 사이드바 헤더에 검색 버튼, 검색 입력 필드 HTML 추가 |
| `src/renderer/viewer.js` | `filterSidebarTree(query)`, `restoreSidebarTree()`, `collectAllFiles(tree)` 함수 추가. 키보드 단축키 핸들러 추가 |
| `src/renderer/viewer.css` | 검색 필드 스타일, `mark` 하이라이트 스타일, 검색 결과 리스트 스타일 |

#### 2.4.8 키보드 단축키

```javascript
// Ctrl+Shift+F / Cmd+Shift+F: 사이드바 검색 포커스
if (mod && e.shiftKey && e.key === 'F') {
  e.preventDefault();
  activateSidebarSearch();
  return;
}
```

---

### FR-18-005: 최근 파일 트레이 메뉴

#### 2.5.1 설명

시스템 트레이 컨텍스트 메뉴에 "최근 문서 (Recent Documents)" 서브메뉴를 추가하여 최근에 열었던 `.md` 파일에 빠르게 접근할 수 있게 한다.

#### 2.5.2 입력

| 입력 | 출처 | 설명 |
|------|------|------|
| 파일 열기 이벤트 | `createWindow({ filePath })`, `navigateTo()`, `file-dropped` | `.md` 파일이 열릴 때마다 발생 |
| "Clear Recent" 클릭 | 트레이 메뉴 | 최근 파일 목록 초기화 |

#### 2.5.3 처리 로직

1. **저장소**: electron-store 키 `recentFiles` (string 배열, 절대 경로)
2. **최대 항목 수**: 7개
3. **갱신 로직** (파일 열기 시):
   ```javascript
   function addRecentFile(filePath) {
     // 입력 검증
     if (typeof filePath !== 'string') return;
     if (!path.isAbsolute(filePath)) return;
     const ext = path.extname(filePath).toLowerCase();
     if (ext !== '.md' && ext !== '.markdown') return;

     let recent = store.get('recentFiles', []);
     // 이미 있으면 제거 (중복 방지, 최상단으로 이동)
     recent = recent.filter(p => p !== filePath);
     // 맨 앞에 추가
     recent.unshift(filePath);
     // 7개 초과 시 뒤에서 제거
     if (recent.length > 7) recent = recent.slice(0, 7);
     store.set('recentFiles', recent);
     updateTrayMenu(); // 트레이 메뉴 재구성
   }
   ```
4. **트레이 메뉴 구조**:
   ```
   - [열린 창 목록...]
   - ─────────────
   - 새 뷰어
   - 최근 문서 ▸
     - document1.md (C:\docs)
     - guide.md (C:\project)
     - ... (최대 7개)
     - ─────────────
     - 목록 지우기
   - 모든 창 닫기
   - 설정
   - ─────────────
   - DocLight 종료
   ```
5. **표시 형식**: `파일명 (부모 디렉토리)` — 예: `README.md (C:\projects\myapp)`
   ```javascript
   const label = `${path.basename(filePath)} (${path.dirname(filePath)})`;
   ```
6. **클릭 동작**: `windowManager.createWindow({ filePath })` 호출 — 새 뷰어 창에서 열기
7. **목록 지우기**: `store.set('recentFiles', [])` 후 `updateTrayMenu()`
8. **갱신 호출 지점**:
   - `windowManager.createWindow()` 에서 `filePath`가 있을 때
   - `windowManager.navigateTo()` 에서
   - `index.js`의 `file-dropped` 핸들러에서
   - `openFileFromPath()` 에서

#### 2.5.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| 트레이 서브메뉴 | 시스템 트레이 | "최근 문서" 서브메뉴 항목 |
| electron-store | `config.json` | `recentFiles` 배열 영속 저장 |

#### 2.5.5 예외

| 상황 | 동작 |
|------|------|
| 최근 파일 클릭 시 파일이 삭제되어 없음 | 트레이 메뉴 클릭 핸들러에서 `fs.existsSync(filePath)`로 사전 확인 → 존재하지 않으면 `createWindow` 호출 없이 해당 항목을 `recentFiles`에서 제거하고 `updateTrayMenu()` 호출. 콘솔에 `[doculight] Recent file not found: {filePath}` 로깅 |
| 최근 파일 목록이 비어있음 | "최근 문서" 서브메뉴에 "(비어 있음)" 비활성 항목 표시 |
| content-only로 열린 문서 | filePath가 없으므로 최근 파일에 추가하지 않음 |

#### 2.5.6 구현 위치

| 파일 | 변경 내용 |
|------|----------|
| `src/main/index.js` | `addRecentFile(filePath)` 함수 추가. `updateTrayMenu()` 에 최근 문서 서브메뉴 추가. `file-dropped` 핸들러에서 호출. `openFileFromPath`에서 호출 |
| `src/main/window-manager.js` | `createWindow()`, `navigateTo()`에서 `this.onRecentFile` 콜백 호출 (index.js에서 `windowManager.onRecentFile = addRecentFile` 으로 연결) |

#### 2.5.7 설정 스키마

```json
{
  "recentFiles": {
    "type": "array",
    "items": { "type": "string" },
    "default": [],
    "maxItems": 7
  }
}
```

---

### FR-18-006: 탭 기반 다중 문서 뷰

#### 2.6.1 설명

단일 뷰어 창 내에서 여러 문서를 탭으로 관리한다. 각 탭은 독립적인 콘텐츠, 스크롤 위치, 사이드바 트리를 유지한다. 탭이 1개일 때는 탭 바가 숨겨져 깔끔한 외관을 유지한다.

#### 2.6.2 입력

| 입력 | 출처 | 설명 |
|------|------|------|
| `enableTabs` 설정 | electron-store | `true`이면 탭 기능 활성화 (기본값: `false`) |
| 사이드바 파일 클릭 | 사이드바 트리 항목 | 새 탭에서 열기 (또는 동일 파일 탭 포커스) |
| `Ctrl+T` / `Cmd+T` | 키보드 | 시스템 파일 선택 다이얼로그 열기 (.md 필터). 파일 선택 시 새 탭 생성, 취소 시 아무 동작 없음 |
| `Ctrl+W` / `Cmd+W` | 키보드 | 현재 탭 닫기 (마지막 탭이면 창 닫기) |
| 탭 클릭 | 탭 바 | 해당 탭으로 전환 |
| 탭 X 버튼 클릭 | 탭 닫기 버튼 | 해당 탭 닫기 |
| 탭 중클릭 | 마우스 중앙 버튼 | 해당 탭 닫기 |
| 탭 드래그 | 마우스 드래그 | 탭 순서 변경 |

#### 2.6.3 처리 로직

**A. 데이터 모델 (렌더러 측)**

```javascript
// 탭 상태 — 렌더러의 JS 메모리에서 관리
const tabs = [];        // Tab[]
let activeTabIndex = 0; // 현재 활성 탭 인덱스

// Tab 객체 구조
{
  id: string,           // UUID
  title: string,        // 탭에 표시할 제목
  filePath: string|null,// 파일 경로 (content-only이면 null)
  markdown: string,     // 원본 markdown 텍스트
  renderedHtml: string, // 렌더링된 HTML (캐시)
  scrollTop: number,    // 스크롤 위치
  sidebarTree: object|null, // 사이드바 트리 데이터
  currentSidebarPath: string|null, // 사이드바 하이라이트 경로
  cachedAt: number      // 탭 콘텐츠가 캐시된 시점의 타임스탬프 (Date.now())
}
```

**B. 탭 생성**

1. 최대 20개 탭 제한. 초과 시 새 탭 생성 무시 + 사용자 알림 (탭 바 영역에 3초간 토스트 메시지 표시: "최대 탭 수(20)에 도달했습니다" / i18n 키: `viewer.maxTabsReached`) + 콘솔 경고
   **토스트 메시지 UI 스펙**:
   - 위치: 탭 바(`#tab-bar`) 하단 우측, CSS `position: absolute; bottom: -32px; right: 8px`
   - 크기/스타일: `padding: 4px 12px; border-radius: 4px; font-size: 12px; white-space: nowrap`
   - 색상: 라이트 테마 — `background: var(--toast-bg, #333); color: var(--toast-color, #fff)`; 다크 테마 — `background: var(--toast-bg, #e0e0e0); color: var(--toast-color, #111)`
   - 애니메이션: `opacity: 0 → 1` (150ms ease-in), 2700ms 유지, `opacity: 1 → 0` (150ms ease-out). 총 표시 시간 3000ms
   - z-index: 200 (탭 바보다 위, 모달(z-index: 1000)보다 아래)
   - DOM: `<div class="tab-toast" role="status" aria-live="polite">` — 스크린 리더 알림 지원
2. 새 탭 생성 시:
   a. Tab 객체 생성하여 `tabs` 배열에 추가
   b. 탭 바 UI에 탭 요소 추가
   c. 해당 탭으로 전환 (`switchTab`)
3. 탭이 2개 이상이면 탭 바 표시, 1개면 숨김
4. `enableTabs: false`일 때: 탭 바 전체(`#tab-bar`)가 렌더링되지 않으며, [+] 버튼도 존재하지 않음. 기존 단일 문서 동작을 유지.

**C. 탭 전환 (`switchTab`)**

1. 현재 활성 탭의 상태 저장:
   ```javascript
   tabs[activeTabIndex].scrollTop = viewerContainer.scrollTop;
   tabs[activeTabIndex].renderedHtml = contentEl.innerHTML;
   ```
2. 새 탭의 상태 복원:
   ```javascript
   contentEl.innerHTML = newTab.renderedHtml;
   viewerContainer.scrollTop = newTab.scrollTop;
   ```
   > **참고 — innerHTML 복원의 기술적 근거**:
   > - **Mermaid SVG**: Mermaid v10+에서 렌더링 결과는 `<svg>` 요소 + 인라인 `<style>` 태그이다. innerHTML 복원 시 SVG 구조와 스타일이 모두 보존된다. Mermaid의 클릭 핸들러(`securityLevel: 'loose'`에서만 활성)는 DocLight에서 사용하지 않으므로(`securityLevel: 'strict'` 기본값), 이벤트 리스너 유실 문제가 없다.
   > - **DOMPurify 재적용 불필요**: innerHTML에 저장되는 시점에 이미 DOMPurify로 세정된 상태이므로, 복원 시 재세정하면 이중 처리가 된다. 따라서 innerHTML을 직접 복원한다.
   > - **highlight.js**: 코드 블록의 하이라이트가 이미 `<span class="hljs-*">` 형태로 DOM에 적용된 상태이므로 재실행 불필요.
   > - **알려진 제한**: Mermaid SVG 내부에 `<style>` 태그가 포함되는데, 다른 탭의 Mermaid SVG와 CSS 클래스명이 충돌할 가능성이 있다. Mermaid는 `.mermaid-svg-{id}` 형태의 scoped 클래스를 생성하므로 실질적 충돌 확률은 극히 낮다.
3. 사이드바 트리 교체: 새 탭의 `sidebarTree`가 있으면 표시, 없으면 숨김
4. 사이드바 하이라이트 업데이트
5. `currentFilePath` 업데이트
6. 탭 바에서 활성 탭 시각적 표시 (`.active` 클래스)

**D. 탭 닫기**

1. `tabs` 배열에서 제거
2. 남은 탭이 0개면 `window.close()` (창 닫기)
3. 남은 탭이 1개면 탭 바 숨김
4. 닫힌 탭이 활성 탭이었으면:
   - 닫힌 인덱스의 이전 탭으로 전환 (또는 첫 번째 탭)

**E. 사이드바 파일 클릭 동작 변경**

- `enableTabs: true`일 때:
  1. 클릭한 파일이 이미 열린 탭에 있으면 → 해당 탭으로 전환
  2. 없으면 → 새 탭 생성하여 파일 열기
- `enableTabs: false`일 때:
  - 기존 동작 유지 (`navigateTo`)

**F. 탭 드래그 & 드롭 (순서 변경) — Phase 2 후속 구현**

> 탭 순서 변경(드래그 앤 드롭)은 Step 18의 초기 구현(Phase 1)에서 **제외**한다. 탭 핵심 기능(생성, 전환, 닫기, 오버플로우)이 안정화된 후 Phase 2에서 추가한다.
>
> **Phase 2 구현 시 필요 항목 (참조용):**
> 1. `mousedown` on 탭 → 드래그 시작 (최소 이동 거리 5px 초과 시 활성화)
> 2. `mousemove` → 고스트 탭 요소를 CSS `transform: translateX()` 로 마우스 추적, 드롭 위치 인디케이터(세로 파란 줄) 표시
> 3. 드롭 위치 판정: 마우스 X좌표가 대상 탭의 좌측 50% 이내면 왼쪽에, 그렇지 않으면 오른쪽에 삽입
> 4. `mouseup` → `tabs` 배열에서 splice로 순서 변경, 탭 바 재렌더링
> 5. 애니메이션: `transition: transform 150ms ease`

**G-1. 탭 바 오버플로우 처리**

탭 수가 많아 탭 바 너비를 초과할 경우:
1. 탭 바에 `overflow-x: auto`를 적용하여 가로 스크롤 활성화
2. 스크롤바는 thin scrollbar 스타일 적용 (CSS `scrollbar-width: thin`)
3. 활성 탭이 보이지 않는 위치에 있으면 `scrollIntoView({ inline: 'nearest' })`로 자동 스크롤
4. [+] 버튼은 탭 바 우측 끝에 sticky 고정 (항상 표시)

**H. 메인 프로세스 연동**

- 탭은 순수 렌더러 측 기능이므로 메인 프로세스 변경 최소화
- `render-markdown` IPC 수신 시: 활성 탭의 상태 업데이트
- `sidebar-tree` IPC 수신 시: 활성 탭의 `sidebarTree` 업데이트
- `navigate-to` IPC 발신 시: `enableTabs`이면 렌더러에서 인터셉트하여 새 탭 생성 (IPC 미발신).
  - **인터셉트 위치**: `tab-manager.js`에서 `window.DocuLight.fn.navigateTo`를 래핑. 원래 `viewer.js`의 사이드바 클릭 핸들러가 `window.doclight.navigateTo(href)`를 호출하는 부분을, `tab-manager.js` 초기화 시점에 `enableTabs` 설정을 확인하여 새 탭 생성 로직으로 교체한다:
    ```javascript
    // 간략화된 의사코드 — 정확한 초기화 시퀀스는 §6.1.1 참조
    // tab-manager.js의 init() (viewer.js가 DOMContentLoaded에서 호출):
    function init() {
      const originalNavigateTo = window.doclight?.navigateTo;
      if (!originalNavigateTo) { console.error('[tab-manager] navigateTo not found'); return; }
      window.DocuLight.fn.navigateToForTab = async function(href) {
        if (!settings.enableTabs) { originalNavigateTo(href); return; }
        // 이미 열린 탭이면 포커스
        const existing = tabs.findIndex(t => t.filePath === href);
        if (existing >= 0) { switchTab(existing); return; }
        // 새 탭: 메인에서 파일 읽기
        const data = await window.doclight.readFileForTab(href);
        // createTab(data) 내부에서 fn.renderMarkdown(data.markdown, data.filePath) 호출로
        // marked.use() + DOMPurify + highlight.js + Mermaid 파이프라인을 통해 renderedHtml을 생성 후
        // Tab 객체의 cachedHtml에 저장 (raw markdown을 저장하지 않음)
        createTab(data);
      };
    }
    ```
  - 새로운 IPC: `ipcRenderer.invoke('read-file-for-tab', filePath)` → 메인에서 파일 읽기 + 사이드바 트리 반환

#### 2.6.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| 탭 바 UI | 뷰어 창 상단 | 열린 탭 목록 표시 |
| 콘텐츠 전환 | `#content` DOM | 탭 전환 시 콘텐츠 교체 |
| 사이드바 전환 | `#sidebar-tree` DOM | 탭 전환 시 사이드바 트리 교체 |

#### 2.6.5 예외

| 상황 | 동작 |
|------|------|
| 탭 20개 도달 시 새 탭 시도 | 새 탭 생성 차단, 탭 바에 토스트 메시지 3초 표시 + 콘솔 경고 |
| `enableTabs: false` 설정 | 기존 단일 문서 동작 유지 (탭 바 미표시, 네비게이션은 현재 창 내 교체) |
| 설정에서 `enableTabs` 변경 | 다음 새 창부터 적용 (이미 열린 창은 재시작 필요) |
| 빈 탭에서 파일 드롭 | 해당 탭의 콘텐츠로 로드 (새 탭 생성하지 않음) |

#### 2.6.6 UI 목업

**탭이 2개 이상일 때:**

```
┌──────────────────────────────────────────────────────────┐
│ ┌──────────┐ ┌──────────┐ ┌──────────┐                  │  ← 탭 바
│ │README.md ×│ │guide.md ×│ │api.md  ×│         [+]      │
│ └──active───┘ └──────────┘ └──────────┘                  │
│──────────────────────────────────────────────────────────│
│ ┌─Sidebar─┐ ┌──────────────Content──────────────┐ ┌TOC┐│
│ │ 📁 docs  │ │                                   │ │   ││
│ │  📄 READ │ │  # README                        │ │ H1││
│ │  📄 guide│ │                                   │ │ H2││
│ │  📄 api  │ │  This is the readme file...       │ │   ││
│ └─────────┘ └───────────────────────────────────┘ └───┘│
│                                    [☰] [#] [📌] [📄]    │  ← FAB 버튼
└──────────────────────────────────────────────────────────┘
```

**탭이 1개일 때 (탭 바 숨김):**

```
┌──────────────────────────────────────────────────────────┐
│ ┌─Sidebar─┐ ┌──────────────Content──────────────┐ ┌TOC┐│
│ │ 📁 docs  │ │                                   │ │   ││
│ │  📄 READ │ │  # README                        │ │ H1││
│ └─────────┘ └───────────────────────────────────┘ └───┘│
│                                    [☰] [#] [📌] [📄]    │
└──────────────────────────────────────────────────────────┘
```

**탭 요소 상세:**

```
┌─────────────────┐
│ 📄 README.md  × │   ← 파일 아이콘 + 파일명 + 닫기 버튼
└─────────────────┘
  ↑ active 탭: 밑줄 또는 배경색 강조
  ↑ hover: 닫기 버튼(×) 표시
  ↑ 중클릭: 탭 닫기
```

#### 2.6.7 구현 위치

| 파일 | 변경 내용 |
|------|----------|
| `src/renderer/viewer.html` | `#app-container` 상단에 `#tab-bar` div 추가 |
| `src/renderer/viewer.js` | 탭 초기화 연결 및 `Ctrl+W` 분기 조건 추가. 탭 핵심 로직은 `tab-manager.js`에 전면 위임 (§6.1.1 참조) |
| `src/renderer/tab-manager.js` | (신규) 탭 매니저 로직 전체 (생성/삭제/전환/드래그). 사이드바 클릭 동작 분기 (`enableTabs` 확인). 키보드 단축키 (`Ctrl+T`) |
| `src/renderer/viewer.css` | 탭 바 스타일, 탭 항목 스타일, 드래그 중 스타일, 활성 탭 스타일 |
| `src/main/index.js` | `read-file-for-tab` IPC 핸들러 등록 (파일 읽기 + 사이드바 트리 반환) |
| `src/main/index.js` | `check-file-mtime` IPC 핸들러 등록 (`fs.stat`으로 mtime 반환). `open-file-dialog` IPC 핸들러 등록 (`dialog.showOpenDialog()` — 필터: `*.md`, `*.markdown`). 응답: `{ filePath: string | null }` (취소 시 `null`) |
| `src/main/preload.js` | `readFileForTab(filePath)` invoke 추가 |
| `src/renderer/settings.html` | `enableTabs` 체크박스 추가 |
| `src/renderer/settings.js` | `enableTabs` 설정 저장/로드 |

#### 2.6.8 Preload API 추가

> **참고**: PDF 관련 Preload API는 §2.3.8에 별도 정의. `preload.js`의 최종 추가 목록은 부록 Preload API 요약과 §2.3.8을 함께 참조한다.

```javascript
// Senders (Renderer → Main)
readFileForTab: (filePath) => ipcRenderer.invoke('read-file-for-tab', filePath),
checkFileMtime: (filePath) => ipcRenderer.invoke('check-file-mtime', filePath),
openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
```

#### 2.6.9 IPC: `read-file-for-tab` 응답 스키마

```json
{
  "markdown": "string (파일 내용)",
  "filePath": "string (절대 경로)",
  "title": "string (추출된 제목)",
  "sidebarTree": { "path": "...", "title": "...", "children": [...] }
}
```

**입력 검증 (메인 프로세스):**

1. `filePath`가 `.md` 또는 `.markdown` 확장자인지 확인 (Windows 대소문자 무시: `path.extname(filePath).toLowerCase()` 사용)
2. `filePath`가 절대 경로인지 확인 (Windows: 드라이브 레터, Unix: `/` 시작)
3. `filePath`가 실제 존재하는 파일인지 `fs.existsSync()` 확인
4. 검증 실패 시 에러 응답: `{ error: "Invalid file path" }`

> **참고**: Ctrl+T 파일 선택 다이얼로그에서 임의 경로의 .md 파일을 열 수 있으므로, 사이드바 트리 루트 하위로 제한하지 않는다. 사이드바 파일 클릭 시에도 동일한 IPC를 사용하므로 경로 제약 없이 유효한 .md 파일이면 허용한다. `sidebarTree` 응답 구조는 `link-parser.js`의 `buildDirectoryTree()` 반환값과 동일하다 (`{ path, title, children: [...] }` 형식).

> **보안 분석**: `read-file-for-tab`은 임의의 `.md` 파일 읽기를 허용하므로, 악의적 렌더러 프로세스가 시스템의 모든 `.md` 파일을 읽을 수 있다. 위험도: **낮음** — (1) `.md` 확장자 제한으로 민감한 시스템 파일 접근 불가, (2) Markdown 콘텐츠만 반환하므로 바이너리 데이터 유출 위험 없음, (3) Electron의 contextIsolation이 렌더러-메인 간 격리를 보장. 수용 가능한 수준으로 판단.

#### 2.6.9.1 IPC: `check-file-mtime`

탭 전환 시 비활성 탭의 파일이 변경되었는지 확인하는 IPC.

**요청**: `ipcRenderer.invoke('check-file-mtime', filePath)`
- `filePath`: string (절대 경로)

**응답 스키마**:
```json
{
  "mtime": 1738800000000,
  "exists": true
}
```

파일이 존재하지 않는 경우:
```json
{
  "mtime": 0,
  "exists": false
}
```

**구현 위치**: `src/main/index.js` — `ipcMain.handle('check-file-mtime')` 등록. `fs.stat(filePath)`로 `mtimeMs`를 반환.

**입력 검증**: `read-file-for-tab`과 동일한 검증 적용 — (1) `.md`/`.markdown` 확장자 확인, (2) 절대 경로 확인, (3) `typeof filePath === 'string'` 타입 확인. 검증 실패 시 `{ mtime: 0, exists: false }` 반환 (에러 throw 대신 graceful 응답).

> **검증 근거**: mtime 조회 대상은 항상 탭에 로드된 `.md` 파일이지만, 렌더러 프로세스가 compromised된 경우 임의 경로의 mtime을 탐침(probe)하여 파일 존재 여부를 파악하는 정보 유출 공격이 가능하다. `.md` 확장자 제한으로 이 공격 표면을 축소한다.

> **타이밍 사이드채널 평가**: `fs.stat()` 응답 시간 차이로 파일 존재 여부를 추론하는 타이밍 사이드채널 공격은 이론적으로 가능하나, (1) `.md` 확장자 제한으로 탐색 범위가 극히 제한적이고, (2) Electron IPC 오버헤드가 파일 시스템 응답 시간보다 훨씬 크므로 유의미한 시간 차 측정이 어려우며, (3) 공격자가 렌더러를 compromise한 상태에서는 더 직접적인 공격 벡터가 존재한다. **위험도: 무시 가능 (Negligible)**.

**사용 흐름** (탭 전환 시):
1. `switchTab()` 호출 시, 새 탭의 `filePath`와 `cachedAt` 확인
2. **`filePath === null` (content-only 탭)**: mtime 조회를 완전히 생략하고 캐시된 `renderedHtml`을 그대로 복원. `check-file-mtime` IPC 미호출.
3. `filePath`가 있으면 `window.doclight.checkFileMtime(filePath)` 호출
4. 응답의 `mtime > tab.cachedAt`이면 파일 재읽기 (`readFileForTab`) → 재렌더링
   - 단위 일치 필수: `mtime`은 `fs.stat()`의 `mtimeMs`(Unix ms), `cachedAt`은 `Date.now()`(Unix ms) — 동일 단위이므로 직접 비교 가능
5. 파일이 존재하지 않으면 (`exists: false`) 기존 캐시 유지 + 콘솔 경고

#### 2.6.10 설정 스키마

```json
{
  "enableTabs": {
    "type": "boolean",
    "default": false
  }
}
```

> **근거**: `enableTabs: true`는 사이드바 클릭 동작을 근본적으로 변경한다. 기본값 `false`로 기존 UX를 보존하고, 사용자가 Settings에서 직접 활성화하도록 한다.

#### 2.6.11 키보드 단축키 변경

| 단축키 | 기존 동작 | 변경 동작 (`enableTabs: true`) |
|--------|----------|-------------------------------|
| `Ctrl+W` / `Cmd+W` | 창 닫기 | 현재 탭 닫기 (마지막 탭이면 창 닫기) |
| `Ctrl+T` / `Cmd+T` | (없음) | .md 파일 선택 다이얼로그 열기 → 선택 시 새 탭 생성 |

---

### FR-18-007: 로컬 이미지 경로 해석

#### 2.7.1 설명

Markdown 문서 내의 상대 경로 이미지 참조를 자동으로 `file://` 절대 URL로 변환하여 올바르게 표시한다.

#### 2.7.2 입력

| 입력 | 출처 | 설명 |
|------|------|------|
| Markdown 이미지 토큰 | marked 파서 | `![alt](href)` 형태 |
| `filePath` (basePath) | 메인 프로세스 → 렌더러 | 현재 문서의 절대 파일 경로 |

#### 2.7.3 처리 로직

1. **marked 커스텀 렌더러 설정** (`marked.use()` — marked v17.0.1 최신 API):
   ```javascript
   // marked.setOptions({ renderer })는 deprecated. marked.use()를 사용.
   // 기존 marked.setOptions({ gfm: true, breaks: true })를 통합 교체
   marked.use({
     gfm: true,
     breaks: true,
     renderer: {
       image({ href, title, text }) {
         const resolvedHref = resolveImagePath(href);
         const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
         const altAttr = text ? escapeHtml(text) : '';
         return `<img src="${escapeHtml(resolvedHref)}" alt="${altAttr}"${titleAttr}>`;
       }
     }
   });
   ```
   > **참고**: `marked.use()`는 marked v17.0.1의 공식 API이다. `marked.setOptions({ renderer })`는 deprecated이므로 사용하지 않는다.

   > **마이그레이션 주의**: 현재 `viewer.js` (약 143줄)에 `marked.setOptions({ ... })` 호출이 존재할 수 있다. 이 호출을 `marked.use({ ... })` 형태로 교체해야 한다. 이미지 렌더러는 기존 옵션과 함께 `marked.use()`에 통합한다. 이 마이그레이션은 FR-18-007의 커스텀 렌더러 등록을 위해 필수적이며, FR-18-007 구현의 일부로 수행한다.

2. **경로 해석 함수 `resolveImagePath(href)`** (순수 JS — `path` 모듈 미사용):
   ```
   입력: href (이미지 경로 문자열)

   IF href가 data: URL → 그대로 반환
   IF href가 http:// 또는 https:// → 그대로 반환
   IF href가 file:// → 보안 검증 후 그대로 반환
   // URL 인코딩 디코딩 (marked 파서가 디코딩하지 않을 수 있으므로 안전 처리)
   try { href = decodeURIComponent(href); } catch (e) { /* malformed URI — href 원본 유지 */ }
   IF href가 상대 경로:
     IF currentFilePath가 있음:
       basePath = imageBasePath (메인 프로세스에서 render-markdown IPC로 전달)
                  || dirname(currentFilePath)  (fallback)
       absolutePath = resolveRelativePath(basePath, href)  // 섹션 6.3의 순수 JS 함수 사용
       IF isPathWithin(absolutePath, basePath) → pathToFileUrl()로 file:// URL 변환
       ELSE → 차단 (path traversal 방지), 빈 문자열 반환
     ELSE (content-only 모드):
       그대로 반환 (표시 불가, 예상 동작)
   ```

3. **경로 변환 세부사항** (순수 JS 문자열 연산):
   - 상대 경로 패턴: `./image.png`, `images/photo.jpg`, `../assets/logo.svg`
   - 절대 경로 변환: `resolveRelativePath(basePath, href)` (섹션 6.3 참조) → `pathToFileUrl()` → `file:///C:/docs/images/photo.jpg`
   - Windows 경로 처리: 메인 프로세스에서 `filePath.replace(/\\/g, '/')` 변환 후 렌더러에 전달
     ```javascript
     function pathToFileUrl(absPath) {
       // Windows: C:/docs/img.png → file:///C:/docs/img.png
       const normalized = absPath.replace(/\\/g, '/');
       // Encode special characters but keep slashes and colon
       const encoded = normalized.split('/').map(segment =>
         encodeURIComponent(segment).replace(/%3A/g, ':')
       ).join('/');
       return `file:///${encoded.replace(/^\//, '')}`;
     }
     ```

4. **보안: 경로 트래버설 방지** (순수 JS — `path` 모듈 미사용):
   ```javascript
   function isPathWithin(absPath, basePath) {
     // Windows는 대소문자 무시, Unix(Linux/macOS)는 대소문자 구분
     // 플랫폼 감지: render-markdown IPC에서 전달되는 platform 필드 사용 (우선),
     // fallback으로 드라이브 레터 패턴 `/^[A-Za-z]:/` 검사 (콜론 포함 Linux 파일명 오판 방지)
     const isWindows = (window.DocuLight?.state?.platform === 'win32')
                    || /^[A-Za-z]:/.test(absPath);
     const normalizedAbs = absPath.replace(/\\/g, '/');
     const normalizedBase = basePath.replace(/\\/g, '/');
     const a = isWindows ? normalizedAbs.toLowerCase() : normalizedAbs;
     const b = isWindows ? normalizedBase.toLowerCase() : normalizedBase;
     return a.startsWith(b + '/') || a === b;
   }
   ```
   - `../../../etc/passwd` 같은 경로 차단
   - `resolveRelativePath()`가 `..` 세그먼트를 해석한 후 검증하므로 안전

4.1. **basePath 결정** (**Fix #13**: 경로 트래버설 정책 완화):
   - 기본 basePath: 사이드바 트리의 루트 디렉토리 (메인 프로세스에서 `render-markdown` IPC의 `imageBasePath` 필드로 전달)
   - 사이드바 트리가 없으면 fallback: `currentFilePath`의 디렉토리 (순수 JS `lastIndexOf('/')` 사용)
   - 이를 통해 프로젝트 구조 내 형제 디렉토리의 이미지 허용 (예: `../shared-assets/logo.png`)
   - **루트 디렉토리 가드**: `imageBasePath`가 드라이브 루트 (`C:\`, `/`) 또는 깊이 1 디렉토리인 경우, 사실상 모든 경로가 허용되므로 보안 효과가 감소한다. 이 경우 `currentFilePath`의 디렉토리로 fallback하여 범위를 좁힌다.

5. **지원 이미지 포맷**: png, jpg, jpeg, gif, svg, webp
   - 확장자 검증은 하지 않음 (CSP와 `<img>` 태그가 자연스럽게 제한)

6. **CSP 확인**: `viewer.html`의 CSP에 이미 `img-src 'self' data: blob: file:` 가 설정되어 있으므로 추가 변경 불필요

7. **basePath 전달 방식**:
   - 렌더러의 `currentFilePath` 변수를 사용 (이미 `render-markdown` IPC에서 `filePath`로 전달됨)
   - `resolveImagePath()` 함수가 `currentFilePath`를 클로저로 참조

#### 2.7.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| 변환된 `<img>` 태그 | rendered HTML | `src` 속성이 `file://` 절대 URL로 변환됨 |

#### 2.7.5 예외

| 상황 | 동작 |
|------|------|
| 상대 경로 이미지 + content-only 모드 | 이미지 표시 불가 (basePath 없음). href 그대로 유지 |
| 경로 트래버설 시도 (`../../secret.png`) | 차단, 이미지 비표시. `src`를 빈 문자열로 설정 |
| 존재하지 않는 이미지 경로 | `file://` URL로 변환은 하되, 브라우저가 깨진 이미지 아이콘 표시 (기본 동작) |
| Windows UNC 경로 (`\\server\share\img.png`) | 지원하지 않음 (로컬 파일만) |
| 이미지 파일이 심볼릭 링크 | OS가 해석하므로 정상 동작. **알려진 제한**: basePath 내부의 심볼릭 링크가 basePath 외부를 가리키면 `isPathWithin` 검증을 우회할 수 있음. 렌더러는 sandbox 모드이므로 `fs.realpathSync` 사용 불가하여 이 제한을 수용한다. **대안 검토**: 메인 프로세스에서 `render-markdown` IPC 전달 전 `imageBasePath`에 대해 `fs.realpathSync()`를 적용하면 basePath 자체의 심볼릭 링크 해석이 가능하나, 이미지 파일 개별 경로는 렌더러에서 해석되므로 근본적 해결은 아니다. 위험도: **낮음** (로컬 앱에서 사용자가 직접 심볼릭 링크를 생성해야 하며, 읽기 전용 이미지 표시만 가능). |

#### 2.7.6 구현 위치

| 파일 | 변경 내용 |
|------|----------|
| `src/renderer/viewer.js` | `resolveImagePath(href)` 함수 추가. marked 커스텀 렌더러의 `image` 메서드 오버라이드. `renderMarkdown()` 함수 내에서 렌더러 적용 |
| `src/main/window-manager.js` | `render-markdown` IPC 전송 시 `imageBasePath` 필드 추가 (`onWindowReady`, `navigateTo`, `navigateBack`, `navigateForward` 모든 지점). 값: `entry.meta.tree ? dirname(entry.meta.tree.path) : dirname(filePath)`, 백슬래시를 슬래시로 변환. **`entry.meta.tree` 경로별 보장**: (1) `onWindowReady` — `createWindow()` 내 `buildDirectoryTree()` 호출로 설정됨, (2) `navigateTo(windowId, filePath)` — 인자로 전달된 `filePath`가 `entry.meta.tree` 범위 밖이면 `dirname(filePath)` fallback 사용, (3) `navigateBack`/`navigateForward` — 히스토리 스택의 `filePath`로 `dirname()` fallback 적용. 세 경로 모두 `entry.meta.tree`가 `null`인 경우(content-only 모드)에도 `dirname(filePath)` fallback이 동작한다. |

> **참고**: 이미지 경로 해석 로직은 렌더러 측에서 처리되나, `imageBasePath` 필드를 `render-markdown` IPC에 추가하기 위해 `window-manager.js`의 수정이 필요하다.

---

### 2.8 기능 간 상호작용

7개 기능이 동시에 존재할 때의 상호작용을 명시한다. 구현 시 이 매트릭스를 참조하여 기능 간 충돌을 방지한다.

| 상호작용 | 동작 규칙 |
|----------|----------|
| **파일 감시 + 탭** | `switchTab()` 시 활성 watcher를 새 탭의 `filePath`로 교체. 비활성 탭의 `renderedHtml`은 stale 상태가 됨. 탭을 다시 활성화할 때, `ipcRenderer.invoke('check-file-mtime', filePath)`로 서버에 mtime을 조회하여 `tab.cachedAt`보다 최신이면 파일을 다시 읽어 재렌더링한다. (렌더러는 sandbox 모드이므로 `fs.stat` 직접 호출 불가) |
| **PDF 내보내기 + 탭** | "현재 파일" 내보내기는 활성 탭의 콘텐츠를 사용. "사이드바 전체" 내보내기는 활성 탭의 사이드바 트리를 기준으로 파일 목록을 수집한다. |
| **최근 파일 + 탭** | 트레이 "최근 문서" 항목 클릭 시 새 **창**(window)에서 열기 (새 탭이 아님). 트레이 메뉴는 외부 진입점이므로 항상 새 창으로 연다. |
| **사이드바 검색 + 탭** | 검색 결과 클릭은 일반 사이드바 클릭과 동일한 탭 연동 동작을 따른다 (`enableTabs: true`이면 새 탭 또는 기존 탭 포커스, `false`이면 `navigateTo`). |
| **파일 감시 + PDF 내보내기** | PDF 내보내기는 내보내기 시작 시점의 파일 스냅샷을 사용한다. 내보내기 진행 중 파일이 변경되어도 생성 중인 PDF에 반영되지 않는다. |
| **Escape 키 우선순위** | 여러 기능이 Escape 키를 사용할 때의 우선순위: (1) PDF 내보내기 모달 열림 → 모달 닫기, (2) 사이드바 검색 모드 활성 → 검색 모드 종료, (3) always-on-top 활성 → always-on-top 해제. 첫 번째 일치하는 핸들러가 이벤트를 소비한다. |
| **파일 감시 + 사이드바 검색** | 검색 필터링 중에도 파일 감시 이벤트는 정상 발생. 감시 이벤트로 인한 자동 새로고침 시 사이드바 검색 필터 상태는 유지된다 (검색 키워드가 지워지지 않음). |

---

## 3. 비기능 요구사항

### 3.1 성능

| 항목 | 기준 |
|------|------|
| 파일 감시 디바운스 | 300ms (연속 변경 이벤트 합산) |
| 탭 전환 | < 100ms (DOM 교체, 스크롤 복원) |
| 사이드바 검색 필터링 | < 50ms (200 파일 기준) |
| PDF 단일 파일 내보내기 | < 5초 (일반 문서 기준) |
| 이미지 경로 해석 | marked 파서 렌더러 오버라이드이므로 추가 오버헤드 무시 가능 |
| 트레이 메뉴 갱신 (FR-18-005) | < 50ms (파일 열기 이벤트 후 `tray.setContextMenu()` 호출까지) |

### 3.2 메모리

| 항목 | 기준 |
|------|------|
| 탭당 메모리 사용량 | renderedHtml 캐시로 인해 탭당 ~1-5MB (문서 크기 비례) |
| 최대 탭 수 | 20개 (하드 리밋). 20탭 × 5MB = 최대 ~100MB 추가 |

> **메모리 초과 대응**: `renderedHtml` 캐시는 대형 문서(data URL 이미지, 대규모 Mermaid SVG 포함)에서 탭당 5MB를 초과할 수 있다. Phase 1에서는 최대 탭 수(20개)로 상한을 제어하되, 실측 결과에 따라 Phase 2에서 LRU 기반 캐시 eviction(가장 오래된 비활성 탭의 `renderedHtml`을 null로 설정, 탭 전환 시 재렌더링) 도입을 검토한다.

| PDF 내보내기 시 | 숨겨진 BrowserWindow 1개 (순차 처리). 동시 생성 금지 |

### 3.3 호환성

| 항목 | 기준 |
|------|------|
| 파일 감시 | Windows NTFS, macOS APFS/HFS+, Linux ext4 에서 `fs.watch()` 정상 동작 |
| 포트 디스커버리 파일 | 3개 OS 모두 `app.getPath('userData')` 경로 사용 |
| PDF 내보내기 | Electron `printToPDF()` — Chromium 기반이므로 크로스 플랫폼 |
| 이미지 경로 | Windows `C:\`, macOS `/Users/`, Linux `/home/` 경로 모두 `file://` 변환 가능 |

### 3.4 보안

| 항목 | 기준 |
|------|------|
| 이미지 경로 트래버설 | basePath 하위만 허용. 순수 JS `resolveRelativePath()` + `isPathWithin()` 검증 (섹션 6.3 참조) |
| PDF 생성 BrowserWindow | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` 유지. `pdf-render-complete` IPC는 `pdfWin.webContents.ipc.once()`로 수신하여 sender를 해당 숨겨진 창으로 한정 |
| 포트 파일 내용 | 숫자만 기록, 코드 인젝션 불가 |
| DOMPurify | 기존 새니타이징 유지 (이미지 경로 해석은 marked 렌더러 단계에서 처리, DOMPurify 전) |
| `read-file-for-tab` 범위 | `.md` 확장자 제한은 확장자 기반이므로 임의 `.md` 파일 읽기 허용됨. `check-file-mtime` 대비 실제 콘텐츠를 반환하므로 정보 노출 범위가 더 크나, 로컬 앱 특성상 수용 가능 (위험도: 낮음) |

### 3.5 테스트 전략

> **테스트 전략**: 4개 신규 렌더러 모듈(`image-resolver.js`, `sidebar-search.js`, `pdf-export-ui.js`, `tab-manager.js`)의 순수 함수(`resolveRelativePath`, `isPathWithin`, `pathToFileUrl`, `collectMdPaths`)는 Node.js 환경에서 단위 테스트 가능하다. 나머지 DOM 의존 로직은 기존 Playwright E2E 테스트 프레임워크로 검증한다. 단위 테스트 파일: `test/unit/image-resolver.test.js` 등.

### 3.6 국제화 (i18n)

각 기능에서 추가되는 모든 사용자 대면 문자열은 4개 로케일 (en, ko, ja, es) JSON 파일에 추가한다.

**추가 i18n 키 목록:**

| 키 | 설명 | 사용 위치 |
|----|------|----------|
| `settings.autoRefresh` | "자동 새로고침" 라벨 | Settings UI |
| `settings.autoRefreshHint` | "파일 변경 시 자동 갱신" 힌트 | Settings UI |
| `settings.enableTabs` | "탭 기능 사용" 라벨 | Settings UI |
| `settings.enableTabsHint` | "하나의 창에서 여러 문서를 탭으로 관리 (새 창부터 적용)" 힌트 | Settings UI |
| `viewer.exportPdf` | "PDF 내보내기" | FAB 버튼 title |
| `viewer.exportTitle` | "PDF 내보내기" | 모달 제목 |
| `viewer.exportScopeCurrent` | "현재 파일" | 라디오 버튼 |
| `viewer.exportScopeAll` | "사이드바 전체 파일" | 라디오 버튼 |
| `viewer.exportPageSize` | "페이지 크기" | 드롭다운 라벨 |
| `viewer.exportSave` | "저장" | 버튼 |
| `viewer.exportCancel` | "취소" | 버튼 |
| `viewer.exportProgress` | "내보내기 중: {fileName} ({current}/{total})" | 진행률 텍스트. **파라미터 치환**: `str.replace('{fileName}', fileName).replace('{current}', current).replace('{total}', total)` 방식으로 구현. `strings.js`의 `t()` 함수가 `{key}` 패턴 치환을 지원 |
| `viewer.exportComplete` | "내보내기 완료" | 완료 메시지 |
| `viewer.exportError` | "내보내기 실패: {message}" | 에러 메시지 |
| `viewer.sidebarSearch` | "파일 검색" | 검색 입력 **placeholder** (시각적 힌트 텍스트) |
| `viewer.sidebarSearchAriaLabel` | "사이드바 파일 검색" | 검색 입력 **aria-label** (스크린리더 접근성용, `viewer.sidebarSearch`와 별도 키 사용) |
| `viewer.searchNoResults` | "결과 없음" | 검색 결과 없음 |
| `viewer.tabClose` | "{title} 탭 닫기" | 탭 닫기 버튼 동적 aria-label. **파라미터 치환**: `t('viewer.tabClose').replace('{title}', tab.title)` (§5.8.1 참조) |
| `tray.recentDocs` | "최근 문서" | 트레이 서브메뉴 |
| `tray.clearRecent` | "목록 지우기" | 트레이 메뉴 항목 |
| `tray.recentEmpty` | "(비어 있음)" | 목록 비어있을 때 |
| `viewer.newTab` | "새 탭" | 빈 탭 제목 |
| `viewer.maxTabsReached` | "탭 최대 수(20)에 도달했습니다" | 탭 바 영역 토스트 메시지 (3초) + 콘솔 경고 (`§2.6.3-B` 참조) |

---

## 4. 데이터 요구사항

### 4.1 electron-store 스키마 변경

기존 스키마에 추가되는 키:

| 키 | 타입 | 기본값 | 설명 |
|----|------|--------|------|
| `autoRefresh` | boolean | `true` | 파일 변경 시 자동 새로고침 |
| `enableTabs` | boolean | `false` | 탭 기반 다중 문서 뷰 활성화 |
| `recentFiles` | string[] | `[]` | 최근 열었던 파일 경로 목록 (최대 7개) |

### 4.2 포트 디스커버리 파일

| 항목 | 내용 |
|------|------|
| 경로 | `{app.getPath('userData')}/mcp-port` |
| 포맷 | 평문, 포트 번호만 (예: `52580`) |
| 인코딩 | UTF-8, BOM 없음 |
| 생명주기 | 앱 시작 시 생성, 앱 종료 시 삭제 (best-effort) |

### 4.3 렌더러 메모리 (탭 상태)

| 항목 | 내용 |
|------|------|
| 위치 | 렌더러 프로세스의 JS 힙 메모리 |
| 데이터 | `tabs[]` 배열: 탭별 markdown, renderedHtml, scrollTop, sidebarTree |
| 영속성 | 없음 (창 닫기 시 소멸) |
| 최대 크기 | 20탭 × ~5MB = ~100MB |

### 4.4 파일 감시 상태

| 항목 | 내용 |
|------|------|
| 위치 | 메인 프로세스 메모리 (WindowManager 내부) |
| 데이터 | `Map<windowId, FSWatcher>` |
| 영속성 | 없음 (창 닫기 시 watcher 해제) |

---

## 5. 인터페이스 요구사항

### 5.1 Settings UI 변경

**기존 설정 폼에 추가할 항목:**

```
┌─────────────────────────────────────────────┐
│ Settings                                    │
│─────────────────────────────────────────────│
│                                             │
│ Theme:          [Light      ▼]              │
│ Font Size (px): [16         ]               │
│ Font Family:    [system-ui... ]             │
│ Code Theme:     [GitHub     ▼]              │
│ MCP Server Port:[52580      ]               │
│   Requires app restart after change         │
│ Default Window Size: [Auto  ▼]              │
│─────────────────────────────────────────────│  ← section divider
│ File Association                            │
│ ☑ Register as default app for .md files     │
│─────────────────────────────────────────────│  ← section divider (NEW)
│                                             │
│ ☑ Auto Refresh                              │  ← FR-18-001
│   Automatically refresh when file changes   │
│                                             │
│ ☑ Enable Tabs                               │  ← FR-18-006
│   Manage multiple documents as tabs         │
│                                             │
│─────────────────────────────────────────────│
│       [ Reset to Defaults ]  [ Save ]       │
│                                             │
│ Settings saved                              │
└─────────────────────────────────────────────┘
```

### 5.2 트레이 메뉴 구조 (변경 후)

```
┌─────────────────────────────────────┐
│ [창 제목 1]                          │  ← 열린 창 목록
│ [창 제목 2]                          │
│─────────────────────────────────────│
│ 새 뷰어                             │
│ 최근 문서                  ▸         │  ← FR-18-005 (서브메뉴)
│   ├─ README.md (C:\projects)         │
│   ├─ guide.md (C:\docs)             │
│   ├─ api.md (C:\work)               │
│   ├────────────────────────          │
│   └─ 목록 지우기                      │
│ 모든 창 닫기                          │
│─────────────────────────────────────│
│ 설정                                 │
│─────────────────────────────────────│
│ DocLight 종료                        │
└─────────────────────────────────────┘
```

### 5.3 PDF 내보내기 모달

```
┌───────────────────────────────────────┐
│          PDF 내보내기                   │
│───────────────────────────────────────│
│                                       │
│  내보내기 범위:                        │
│  (●) 현재 파일                        │
│  ( ) 사이드바 전체 파일  ← disabled    │
│      when no sidebar files            │
│                                       │
│  페이지 크기:                          │
│  ┌─────────────────────────┐          │
│  │ A4                   ▼  │          │
│  └─────────────────────────┘          │
│                                       │
│  ┌────────────────────────────────┐   │
│  │ ██████████░░░░  3/15           │   │  ← 진행률 (전체 내보내기 시만)
│  │ chapter3.pdf                   │   │
│  └────────────────────────────────┘   │
│                                       │
│         [ Cancel ]    [ Save ]        │
│                                       │
└───────────────────────────────────────┘
```

**완료 상태 (내보내기 완료):**
```
┌───────────────────────────────────────┐
│          PDF 내보내기                   │
│───────────────────────────────────────│
│                                       │
│  ✅ 내보내기 완료                      │
│     15개 파일이 저장되었습니다.         │
│                                       │
│  ┌────────────────────────────────┐   │
│  │ ████████████████  15/15        │   │
│  │ complete                       │   │
│  └────────────────────────────────┘   │
│                                       │
│              [ 닫기 ]                  │  ← Save 버튼이 "닫기"로 전환, Cancel 비활성화
│                                       │
└───────────────────────────────────────┘
```
> **참고**: 완료 시 Save 버튼 텍스트는 "닫기"로 변경되고 Cancel 버튼은 비활성화된다. `isExporting = false` 상태로 전환되며 모달은 수동 닫기까지 유지된다.

### 5.4 사이드바 검색 영역

```
┌─ Sidebar ───────────────────────────┐
│ Navigation                    [🔍]  │  ← 검색 토글 버튼
│ ┌──────────────────────────┬───┐    │  ← 검색 필드 (토글 시)
│ │ 검색어...                │ ✕ │    │
│ └──────────────────────────┴───┘    │
│─────────────────────────────────────│
│ (필터링된 결과 또는 전체 트리)        │
└─────────────────────────────────────┘
```

### 5.5 탭 바

```
┌─────────────────────────────────────────────────────────┐
│ ┌────────────┐ ┌────────────┐ ┌────────────┐     [+]   │
│ │📄 README ×│ │📄 guide  ×│ │📄 api    ×│           │
│ └═══active═══┘ └────────────┘ └────────────┘           │
│─────────────────────────────────────────────────────────│
│                    (viewer content)                      │
└─────────────────────────────────────────────────────────┘

탭 스타일:
- active: 하단 border 강조 (primary color), 배경 약간 밝음
- hover: 배경 subtle highlight
- × 버튼: hover 시만 표시 (active 탭은 항상 표시)
- [+] 버튼: 새 탭 추가 (Ctrl+T와 동일)
- 드래그: 마우스 커서 grab/grabbing *(Phase 2에서 구현 — 초기 릴리스에서는 드래그 비활성)*
```

### 5.6 플로팅 버튼 영역 (변경 후)

```
┌─────────┐
│ ☰ Files │  ← btn-toggle-sidebar
├─────────┤
│ # TOC   │  ← btn-toggle-toc
├─────────┤
│ 📌 Pin  │  ← btn-toggle-pin
├─────────┤
│ 📄 PDF  │  ← btn-export-pdf (NEW)
└─────────┘
```

### 5.6.1 CSS 클래스 인벤토리 (신규 추가분)

| CSS 클래스 | 대상 요소 | 관련 FR | 설명 |
|-----------|----------|---------|------|
| `.tab-bar` | `#tab-bar` div | FR-18-006 | 탭 바 컨테이너 |
| `.tab-item` | 개별 탭 요소 | FR-18-006 | 탭 항목 |
| `.tab-item.active` | 활성 탭 | FR-18-006 | 활성 탭 강조 스타일 |
| `.tab-close` | 탭 닫기 버튼 | FR-18-006 | × 버튼 |
| `.tab-add` | [+] 버튼 | FR-18-006 | 새 탭 추가 버튼 |
| `.sidebar-search-container` | 검색 입력 래퍼 | FR-18-004 | 검색 필드 슬라이드 컨테이너 |
| `.sidebar-search-input` | 검색 `<input>` | FR-18-004 | 텍스트 입력 필드 |
| `.sidebar-search-clear` | X(닫기) 버튼 | FR-18-004 | 검색 해제 버튼 |
| `.search-result-item` | 검색 결과 항목 | FR-18-004 | 필터링된 파일 리스트 항목 |
| `.search-result-dir` | 부모 디렉토리 텍스트 | FR-18-004 | 회색 서브텍스트 |
| `.pdf-modal-overlay` | 모달 오버레이 | FR-18-003 | 반투명 배경 |
| `.pdf-modal` | 모달 컨텐츠 | FR-18-003 | 중앙 다이얼로그 박스 |
| `.pdf-progress-bar` | 프로그레스 바 | FR-18-003 | 배치 내보내기 진행률 |
| `.pdf-progress-text` | 진행률 텍스트 | FR-18-003 | 파일명 + 카운터 |
| `.fab.btn-export-pdf` | PDF FAB 버튼 | FR-18-003 | 플로팅 내보내기 버튼 |
| `.tab-toast` | 탭 최대 수 알림 토스트 | FR-18-006 | §2.6.3-B 참조 |

**탭 닫기 버튼 hover/active 표시 규칙 (CSS 힌트):**

```css
/* 기본 상태: 닫기 버튼 숨김 */
.tab-item .tab-close {
  opacity: 0;
  pointer-events: none;
}
/* tab-item hover 시: 닫기 버튼 표시 */
.tab-item:hover .tab-close {
  opacity: 1;
  pointer-events: auto;
}
/* active 탭: 닫기 버튼 항상 표시 */
.tab-item.active .tab-close {
  opacity: 1;
  pointer-events: auto;
}
/* 닫기 버튼 자체 hover: 배경 강조 */
.tab-close:hover {
  background: var(--tab-close-hover-bg);
  border-radius: 4px;
}
```

**다크 테마 CSS 변수 (신규 추가분):**

신규 컴포넌트는 기존 `body.dark` 선택자 하에 다음 CSS 변수를 정의한다:

```css
/* viewer.css — 라이트 테마 기본값 */
:root {
  --tab-bar-bg: #f0f0f0;
  --tab-bar-border: #d0d0d0;
  --tab-item-bg: #e0e0e0;
  --tab-item-active-bg: #ffffff;
  --tab-item-active-border: #0078d4;   /* primary accent */
  --tab-item-hover-bg: #d8d8d8;
  --tab-close-hover-bg: #c0c0c0;
  --tab-add-hover-bg: #d0d0d0;
  --pdf-modal-overlay-bg: rgba(0, 0, 0, 0.5);
  --pdf-modal-bg: #ffffff;
  --pdf-modal-border: #d0d0d0;
  --toast-bg: #333333;
  --toast-color: #ffffff;
  --search-input-bg: #ffffff;
  --search-input-border: #b0b0b0;
  --search-highlight-bg: #fff176;      /* 검색어 하이라이트 */
}

/* 다크 테마 오버라이드 */
body.dark {
  --tab-bar-bg: #252526;
  --tab-bar-border: #3e3e42;
  --tab-item-bg: #2d2d2d;
  --tab-item-active-bg: #1e1e1e;
  --tab-item-active-border: #0078d4;
  --tab-item-hover-bg: #383838;
  --tab-close-hover-bg: #4a4a4a;
  --tab-add-hover-bg: #3a3a3a;
  --pdf-modal-overlay-bg: rgba(0, 0, 0, 0.7);
  --pdf-modal-bg: #2d2d2d;
  --pdf-modal-border: #555555;
  --toast-bg: #e0e0e0;
  --toast-color: #111111;
  --search-input-bg: #3c3c3c;
  --search-input-border: #555555;
  --search-highlight-bg: #5d4037;
}
```

> **Windows 스크롤바 호환성**: `scrollbar-width: thin`은 Firefox(Windows 포함)에서 지원되나 Chromium(Electron)에서는 `::-webkit-scrollbar` 의사 선택자를 사용해야 한다. 탭 바 오버플로우 스크롤 시 Chromium용 스타일을 추가한다:
> ```css
> #tab-bar::-webkit-scrollbar { height: 4px; }
> #tab-bar::-webkit-scrollbar-thumb { background: var(--tab-bar-border); border-radius: 2px; }
> ```
> `scrollbar-width: thin`은 호환성 없음을 확인하고 제거한다.

### 5.7 Escape 키 우선순위

여러 기능이 Escape 키를 사용하므로, 충돌을 방지하기 위해 우선순위를 정의한다:

| 우선순위 | 조건 | 동작 |
|----------|------|------|
| 1 (최우선) | PDF 내보내기 모달이 열려 있음 | 모달 닫기 |
| 2 | 사이드바 검색 모드가 활성 | 검색 모드 종료 |
| 3 | always-on-top이 활성 | always-on-top 해제 |

- 첫 번째 일치하는 핸들러가 이벤트를 소비 (`e.stopPropagation()` 또는 조건부 `return`)
- 해당 조건이 모두 비활성이면 Escape 키는 기본 동작 (없음)

### 5.8 접근성 (ARIA) 요구사항

Step 18에서 추가되는 신규 UI 컴포넌트에 적용할 ARIA 속성을 정의한다.

#### 5.8.1 탭 바 (FR-18-006)

```html
<!-- 탭 바 컨테이너 -->
<div id="tab-bar" role="tablist" aria-label="열린 문서 탭">

  <!-- 개별 탭 -->
  <div class="tab-item active"
       role="tab"
       aria-selected="true"
       aria-controls="tab-panel-{id}"
       id="tab-{id}"
       tabindex="0">
    📄 README
    <button class="tab-close" aria-label="README 탭 닫기" tabindex="-1">×</button>
  </div>

  <div class="tab-item"
       role="tab"
       aria-selected="false"
       aria-controls="tab-panel-{id2}"
       id="tab-{id2}"
       tabindex="-1">
    📄 guide
    <button class="tab-close" aria-label="guide 탭 닫기" tabindex="-1">×</button>
  </div>
  <!-- 동적 aria-label 생성 패턴:
       closeBtn.setAttribute('aria-label', t('viewer.tabClose').replace('{title}', tab.title))
       예: "README 탭 닫기" (한국어), "Close README tab" (영어)
  -->

  <!-- 새 탭 추가 버튼 -->
  <button class="tab-add" aria-label="새 탭 열기 (Ctrl+T)">+</button>
</div>

<!-- 탭 패널 (뷰어 컨텐츠 영역) -->
<div id="tab-panel-{id}"
     role="tabpanel"
     aria-labelledby="tab-{id}"
     tabindex="0">
  <!-- viewer content -->
</div>
```

**탭 키보드 네비게이션** (`tab-manager.js`에서 구현):

| 키 | 동작 |
|----|------|
| `ArrowRight` / `ArrowLeft` | 탭 포커스 이동 (circular) — `tabindex` 속성 갱신 |
| `Enter` / `Space` | 포커스된 탭 활성화 |
| `Delete` / `Ctrl+W` | 활성 탭 닫기 |
| `Tab` | tablist 바깥으로 포커스 이동 |

구현: `role="tablist"` 요소에 `keydown` 이벤트 리스너 추가. `ArrowRight` 시 `tabs[(currentIndex + 1) % tabs.length]`로 포커스 이동, `aria-selected` 및 `tabindex` 갱신.

#### 5.8.2 PDF 내보내기 모달 (FR-18-003)

```html
<div class="pdf-modal-overlay"
     role="dialog"
     aria-modal="true"
     aria-labelledby="pdf-modal-title"
     id="pdf-modal">

  <h2 id="pdf-modal-title">PDF 내보내기</h2>
  <!-- modal content -->
</div>
```

**Focus Trap 구현** (`pdf-export-ui.js`에서 구현):
- 모달 열릴 때: 모달 내 첫 번째 포커스 가능 요소(라디오 버튼)로 포커스 이동. 열리기 전 포커스 요소를 `previousFocus` 변수에 저장.
- 모달 내에서 `Tab` / `Shift+Tab`: 마지막 요소(Cancel 버튼)에서 Tab 시 첫 번째 요소로 순환. 첫 번째 요소에서 Shift+Tab 시 마지막 요소로 순환.
- 포커스 가능 요소 순서: 라디오(현재 파일) → 라디오(전체) → 드롭다운(페이지 크기) → Cancel 버튼 → Save 버튼.
- 모달 닫힐 때: `previousFocus.focus()` 호출하여 원래 위치로 복원.

#### 5.8.3 사이드바 검색 (FR-18-004)

```html
<!-- 검색 토글 버튼 -->
<button id="btn-sidebar-search"
        aria-label="파일 검색 (Ctrl+Shift+F)"
        aria-expanded="false"
        aria-controls="sidebar-search-container">🔍</button>

<!-- 검색 입력 필드 -->
<div id="sidebar-search-container" class="sidebar-search-container hidden">
  <input type="search"
         class="sidebar-search-input"
         aria-label="사이드바 파일 검색"   <!-- i18n 키: viewer.sidebarSearchAriaLabel (스크린리더용) -->
         placeholder="파일 검색"           <!-- i18n 키: viewer.sidebarSearch (시각적 힌트) -->
         autocomplete="off">
  <button class="sidebar-search-clear" aria-label="검색 지우기">✕</button>
</div>
```

> **i18n 주의**: `aria-label`과 `placeholder`는 **별도 i18n 키**를 사용한다. `aria-label`은 `viewer.sidebarSearchAriaLabel` 키(스크린리더 접근성용, 더 설명적인 문구), `placeholder`는 `viewer.sidebarSearch` 키(시각적 힌트용, 간결한 문구)를 각각 독립적으로 로컬라이즈한다. (§3.6 참조)

- 검색 모드 열릴 때: `aria-expanded="true"` 갱신 + `input.focus()`
- 검색 결과 항목: `role="option"` 추가 고려 (파일 목록이 listbox 역할인 경우). 단, 현재 구현에서는 단순 `<li>` 목록으로 충분하며 스크린 리더가 자연스럽게 읽힘.
- 검색어 하이라이트: `<mark>` 태그 사용. `<mark>` 요소는 스크린 리더에서 별도 강조 없이 텍스트로 읽히므로 추가 aria 처리 불필요. (스크린 리더가 `<mark>`를 명시적으로 알리지 않는 것은 수용 가능한 동작)

#### 5.8.4 토스트 메시지 (FR-18-006)

- `<div class="tab-toast" role="status" aria-live="polite">` — `aria-live="polite"`: 스크린 리더가 현재 읽기 완료 후 알림. `aria-atomic="true"` 추가하여 전체 메시지가 한 번에 읽히도록 한다.

---

## 6. 제약사항

### 6.1 기술적 제약

| 제약 | 설명 | 영향 범위 |
|------|------|----------|
| `fs.watch()` 플랫폼 차이 | macOS에서 `filename` 콜백 인자가 `null`일 수 있음, Windows에서 이벤트 중복 발생 가능 | FR-18-001: macOS는 원본 `filePath`로 폴백 (§2.1.3-3), Windows 중복 이벤트는 디바운스(300ms)로 대응 |
| `printToPDF()` 제한 | Electron의 Chromium 기반. CSS 페이지 나누기 지원 불완전 | FR-18-003: 결과물 품질은 Chromium 의존 |
| 렌더러 프로세스 메모리 | `sandbox: true`이므로 Node.js API 사용 불가 | FR-18-007: 경로 해석을 순수 JS 문자열 처리로 구현 (path 모듈 미사용) |
| CSP 정책 | `img-src file:` 이미 허용됨 | FR-18-007: 추가 변경 불필요 |
| electron-store 동기 쓰기 | `store.set()` 호출이 동기적으로 파일에 기록 | FR-18-005: 최근 파일 갱신 시 I/O 오버헤드 미미 |
| `viewer.js` 크기 증가 | 5개 FR이 viewer.js를 수정하여 파일 크기가 크게 증가 | **필수**: 4개 신규 모듈로 분리. 상세 구조는 §6.1.1 참조 |

#### 6.1.1 모듈 분리 상세 구조

`viewer.js`에서 분리하는 4개 신규 모듈의 구조:

**모듈 패턴**: 각 파일은 IIFE로 감싸고, `window.DocuLight` 네임스페이스를 통해 공유 상태와 함수를 노출한다.

**로드 순서** (`viewer.html` `<script>` 태그 순서):
1. `image-resolver.js`
2. `sidebar-search.js`
3. `pdf-export-ui.js`
4. `tab-manager.js`
5. `viewer.js` (마지막 — 초기화 실행)

**`viewer.js` 초기화**: `DOMContentLoaded` 이벤트에서 `window.DocuLight = { state: {}, dom: {}, fn: {}, modules: {} }` 네임스페이스를 생성하고, DOM 참조와 공유 함수를 등록한다. 이후 각 모듈의 `init()` 함수를 순차 호출한다. 각 모듈은 IIFE 내에서 `init` 함수를 `window.DocuLight.modules.{moduleName}.init`로 노출하며, `viewer.js`가 이를 호출하는 구조이다.

**초기화 시퀀스** (정확한 실행 순서):
1. 브라우저가 `<script>` 태그를 순서대로 실행 → 각 모듈 IIFE는 모듈 내부에 `init` 함수를 정의하되, 즉시 `window.DocuLight`에 등록하지 않는다. 대신 각 IIFE가 전역 배열(`window.__docuLightModules = window.__docuLightModules || []`)에 `{ name, init }` 객체를 push한다. 이 패턴은 `window.DocuLight`가 아직 존재하지 않는 시점에서도 안전하다.
2. `viewer.js` 로드 → IIFE 내에서 `DOMContentLoaded` 리스너 등록
3. `DOMContentLoaded` 발생 → `viewer.js` 핸들러 실행:
   a. `window.DocuLight = { state: {}, dom: {}, fn: {}, modules: {} }` 생성
   b. DOM 참조 등록 (`dom.content`, `dom.sidebarTree`, 등)
   c. `fn.renderMarkdown`, `fn.navigateTo` 등록
   c-1. `window.__docuLightModules` 배열을 순회하며 각 모듈을 `window.DocuLight.modules.{name}`에 등록
   d. 각 모듈 `init()` 순차 호출: `imageResolver.init()` → `sidebarSearch.init()` → `pdfExportUi.init()` → `tabManager.init()`
4. `tab-manager.js`의 `init()`은 `viewer.js`가 호출하므로, `window.DocuLight.fn.navigateTo`가 이미 존재함이 보장된다

> **주의**: 각 모듈은 자체적으로 `DOMContentLoaded`를 리스닝하지 않는다. 모든 초기화는 `viewer.js`의 `DOMContentLoaded` 핸들러가 중앙에서 제어한다.

> **스크립트 로드 순서**: 신규 모듈 5개는 기존 vendored 라이브러리 이후에 로드되어야 한다. `viewer.html`의 최종 `<script>` 순서: `marked.min.js` → `purify.min.js` → `highlight.min.js` → `mermaid.min.js` → `image-resolver.js` → `sidebar-search.js` → `pdf-export-ui.js` → `tab-manager.js` → `viewer.js`. `image-resolver.js`가 `marked.use()`를 호출하므로 `marked.min.js` 이후에 위치해야 한다.

**모듈별 인터페이스**:

| 모듈 | 읽기 | 쓰기 | 비고 |
|------|------|------|------|
| `image-resolver.js` | `state.currentFilePath`, `state.imageBasePath` | 없음 | 순수 함수 |
| `sidebar-search.js` | `dom.sidebarTree` | DOM 필터링만 | state 변경 없음 |
| `pdf-export-ui.js` | `state.currentFilePath`, `state.sidebarTree` | 없음 | IPC 호출만. `onExportProgress` 리스너의 cleanup 함수를 모달 닫기/완료 시 호출하여 리스너 누수 방지 |
| `tab-manager.js` | `dom.content`, `dom.viewerContainer`, `dom.sidebarTree` | `state.tabs`, `state.activeTabIndex`, `state.currentFilePath` | `fn.renderMarkdown()` 호출 |
| `viewer.js` (코어) | `render-markdown` IPC → writes `state.currentFilePath`, `state.imageBasePath` | `state.sidebarTree` (`sidebar-tree` IPC 수신 시 업데이트) | IPC 이벤트 수신 및 상태 배분 담당 |

**전체 `window.DocuLight` 인터페이스**:
- `state`: `{ currentFilePath, imageBasePath, sidebarTree, tabs, activeTabIndex, settings }`
- `dom`: `{ content, sidebarTree, viewerContainer, tabBar }`
- `fn`: `{ renderMarkdown, navigateTo, navigateToForTab }` — `navigateToForTab`는 `tab-manager.js`의 `init()`에서 등록하며, 기존 `navigateTo`를 탭 인터셉트 로직으로 래핑한 버전이다. **호출 규칙**: `tab-manager.js` init() 이후에는 모든 모듈이 `fn.navigateTo` 대신 `fn.navigateToForTab`을 호출해야 한다. 또한, 각 모듈은 init 시점에 `fn.navigateTo`를 로컬 변수에 캐싱하지 않아야 한다 — `tab-manager.js`가 마지막으로 초기화되므로 캐싱 시점에 래핑 전 원본이 캡처될 수 있다. 외부에서 직접 파일 열기가 필요한 경우 preload의 `window.doclight.navigateTo()`를 사용한다
- `modules`: `{ imageResolver, sidebarSearch, pdfExportUi, tabManager }` (각 `{ init }`)

> **IIFE vs ES Module 설계 결정**: Electron 렌더러에서 `<script type="module">`은 기술적으로 사용 가능하나, (1) 기존 vendored 라이브러리(marked, DOMPurify, highlight.js, mermaid)가 전역 변수로 노출되는 UMD 번들이므로 ES import와 혼용 시 로드 순서 복잡도 증가, (2) ES Module의 `defer` 특성으로 인해 기존 `viewer.js`의 `DOMContentLoaded` 타이밍 변경, (3) 번들러(webpack/vite) 미사용 프로젝트에서 bare import specifier 불가. 이러한 이유로 IIFE + `window.DocuLight` 네임스페이스 패턴을 채택한다. 향후 빌드 도구 도입 시 ES Module 전환을 고려할 수 있다.

### 6.2 호환성 제약

| 제약 | 설명 |
|------|------|
| Node.js ≥ 20.0.0 | `fs.watch()` 동작 보장을 위해 유지 |
| Electron ≥ 33.0.0 | `printToPDF()` 옵션 호환 |
| Windows NTFS | `fs.watch()`의 `recursive` 옵션 필요 없음 (단일 파일 감시) |

### 6.3 렌더러 경로 해석 제약 (FR-18-007)

렌더러 프로세스는 `sandbox: true`이므로 Node.js의 `path` 모듈을 사용할 수 없다. 따라서 이미지 경로 해석은 순수 JavaScript 문자열 연산으로 구현해야 한다:

```javascript
// 렌더러에서 사용할 경로 해석 유틸리티
function resolveRelativePath(basePath, relativePath) {
  // 엣지케이스: basePath가 빈 문자열이면 relativePath 그대로 반환 (content-only 모드 안전 처리)
  if (!basePath) return relativePath;
  // basePath: imageBasePath — 항상 디렉토리 경로 (예: "C:/docs/project")
  // window-manager.js에서 dirname() 처리 후 전달하므로 파일명 제거 불필요
  const baseDir = basePath;
  // relativePath: "./images/fig1.png" → 합쳐서 정규화
  const combined = baseDir + '/' + relativePath;
  const isUnix = combined.startsWith('/');
  const parts = combined.split('/');
  const resolved = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      // 드라이브 레터/루트 보호: resolved가 비어있거나 드라이브 레터만 남으면 pop 금지
      if (resolved.length > 0 && !/^[A-Za-z]:$/.test(resolved[resolved.length - 1])) {
        resolved.pop();
      }
      continue;
    }
    resolved.push(part);
  }
  const result = resolved.join('/');
  return isUnix ? '/' + result : result;
}
```

> **참고**: 위 구현에서 Unix 선행 `/` 보존과 Windows 드라이브 레터(`C:`) 보호가 모두 통합되어 있다. `..`으로 인한 루트/드라이브 이탈이 방지된다.

> **중요**: 메인 프로세스에서 `filePath`를 렌더러에 전달할 때 Windows 백슬래시를 슬래시로 변환하여 전달해야 한다. 이미 `render-markdown` IPC에서 `filePath`를 전달하고 있으므로, 전달 전에 `filePath.replace(/\\/g, '/')` 처리를 추가한다.

---

## 7. 인수 조건

### FR-18-001: 파일 감시 및 자동 새로고침

**AC-001-1: 파일 변경 시 자동 렌더링**
```
Given: 뷰어 창에 filePath로 test.md가 열려 있고, autoRefresh가 true
When: 외부 에디터에서 test.md 파일 내용을 수정하고 저장
Then: 300ms 디바운스 후 뷰어 창의 렌더링이 새 내용으로 갱신된다.
     검증 기준: 파일 저장 후 1000ms 이내에 render-markdown IPC 이벤트가 렌더러에 수신되면 통과.
     E2E 검증: page.waitForEvent('console', { predicate: m => m.text().includes('[doculight] file-changed'), timeout: 1000 })
               또는 Playwright IPC 스파이로 render-markdown 채널 수신 확인
```

**AC-001-2: 스크롤 위치 보존**
```
Given: test.md가 열려 있고 scrollTop을 500px로 내린 상태
When: 외부 에디터에서 test.md를 수정하고 저장
Then: 자동 새로고침 후 viewerContainer.scrollTop이 이전 값 ±5px 이내로 복원된다
     검증: window.doclight.state.scrollTop (재렌더링 전 저장값)과 실제 scrollTop 비교
```

**AC-001-3: 설정 비활성화**
```
Given: Settings에서 autoRefresh를 false로 변경하고 저장
When: 외부 에디터에서 test.md를 수정하고 저장
Then: 뷰어 창의 렌더링이 갱신되지 않는다
```

**AC-001-4: 파일 삭제 시 안전 처리**
```
Given: 뷰어 창에 test.md가 열려 있고 감시 중
When: 외부에서 test.md 파일을 삭제
Then: 기존 렌더링이 유지되고, 콘솔에 에러 로깅되며, 앱이 크래시하지 않는다
```

**AC-001-5: 네비게이션 시 감시 전환**
```
Given: 뷰어 창에 a.md가 열려 있고 감시 중
When: 사이드바에서 b.md를 클릭하여 네비게이션
Then: a.md의 감시가 해제되고, b.md의 감시가 시작된다
     검증: WindowManager 내부 Map에서 해당 windowId의 watcher 엔트리 filePath가 b.md로 변경되었는지 확인.
           이후 a.md를 수정해도 렌더링이 갱신되지 않고, b.md를 수정하면 갱신된다
```

**AC-001-6: fs.watch rename 이벤트 (atomic save)**
```
Given: 뷰어 창에 test.md가 열려 있고 autoRefresh: true
When: VS Code에서 test.md를 수정하고 저장 (atomic save, rename 이벤트 발생)
Then: 뷰어 창의 렌더링이 갱신된다
```

**AC-001-7: 설정에서 autoRefresh 런타임 변경**
```
Given: 3개 뷰어 창이 열려 있고, autoRefresh가 true이며, 각각 파일을 감시 중
When: Settings에서 autoRefresh를 false로 변경하고 저장
Then: 3개 창의 모든 watcher가 즉시 중지되고, 이후 파일 변경 시 렌더링이 갱신되지 않는다
```

### FR-18-002: MCP HTTP 포트 디스커버리 파일

**AC-002-1: 포트 파일 생성**
```
Given: DocLight 앱이 시작되고 MCP HTTP 서버가 포트 52580에 바인딩
When: 서버 바인딩 완료
Then: {userData}/mcp-port 파일이 생성되고 내용이 "52580"이다
```

**AC-002-2: 포트 파일 삭제**
```
Given: DocLight 앱이 실행 중이고 mcp-port 파일이 존재
When: 앱을 종료 (트레이 → 종료)
Then: mcp-port 파일이 삭제된다
```

**AC-002-3: 쓰기 실패 시 앱 계속 실행**
```
Given: {userData} 디렉토리에 쓰기 권한이 없음 (시뮬레이션)
When: MCP HTTP 서버가 포트에 바인딩
Then: 콘솔에 에러가 로깅되고, 앱은 정상적으로 계속 실행된다
```

### FR-18-003: PDF 내보내기

**AC-003-1: 현재 파일 PDF 내보내기**
```
Given: README.md가 뷰어에 열려 있음
When: PDF FAB 버튼 클릭 → "현재 파일" 선택 → A4 → Save 클릭 → 저장 위치 선택
Then: 선택한 위치에 README.pdf 파일이 생성된다. 검증 기준: (1) 파일 크기 > 0 bytes, (2) PDF 헤더(%PDF-) 존재, (3) 내보내기 완료 토스트 표시
```

**AC-003-2: 사이드바 전체 파일 PDF 내보내기**
```
Given: 사이드바에 5개 .md 파일이 표시됨
When: PDF FAB 버튼 클릭 → "사이드바 전체 파일" 선택 → Letter → Save → 출력 디렉토리 선택
Then: 선택한 디렉토리에 5개 .pdf 파일이 생성되고, 진행률이 표시된다
```

**AC-003-3: content-only 모드에서 사이드바 옵션 비활성화**
```
Given: MCP content 파라미터로 문서가 열림 (filePath 없음)
When: PDF FAB 버튼 클릭
Then: "사이드바 전체 파일" 라디오 버튼이 비활성화 상태이다
```

**AC-003-4: 내보내기 취소**
```
Given: PDF 내보내기 다이얼로그가 열려 있음
When: Cancel 버튼 클릭 또는 Escape 키
Then: 다이얼로그가 닫히고 아무 파일도 생성되지 않는다
```

**AC-003-5: 배치 내보내기 취소**
```
Given: 15개 파일의 사이드바 전체 PDF 내보내기가 진행 중 (5/15)
When: Cancel 버튼 클릭
Then: 현재 파일 완료 후 내보내기 중단. 이미 생성된 5개 PDF 유지
```

**AC-003-6: Mermaid 다이어그램 포함 문서 PDF 내보내기**
```
Given: 3개의 Mermaid 다이어그램이 포함된 문서가 열려 있음
When: PDF 내보내기 → "현재 파일" → Save
Then: 모든 Mermaid SVG가 렌더링 완료된 후 PDF가 생성되며, 다이어그램이 올바르게 표시된다
     검증 기준: (1) PDF 파일 크기 > 50KB (텍스트만인 경우 <10KB이므로 다이어그램 포함 판단),
               (2) PDF 헤더(%PDF-) 존재, (3) pdf-render-complete IPC가 타임아웃 전에 수신됨
```

**AC-003-7: PDF 렌더링 타임아웃 시 현재 상태로 생성**
```
Given: Mermaid 렌더링이 30초 이상 걸리는 복잡한 다이어그램 포함 문서
When: PDF 내보내기 실행
Then: 30초 후 타임아웃되어 현재 렌더링 상태로 PDF가 생성된다
```

**AC-003-8: 다중 파일 내보내기 완료 후 다이얼로그 자동 닫기**
```
Given: "사이드바 전체 파일" PDF 내보내기가 성공적으로 완료
When: 모든 파일 내보내기 완료
Then: "내보내기 완료" 메시지가 2초간 표시된 후 다이얼로그가 자동으로 닫힌다
      E2E 검증: await page.waitForSelector('.pdf-modal-overlay',
                  { state: 'hidden', timeout: 3000 })
                // 완료 메시지 표시(2초) + 닫힘 여유(1초) = 3초 이내
```

**AC-003-9: 동시 내보내기 방지 (isExporting 플래그)**
```
Given: PDF 내보내기가 진행 중 (isExporting=true)
When: 다른 창 또는 동일 창에서 PDF 내보내기 FAB 버튼을 클릭하여 export-pdf IPC를 다시 호출
Then: { isError: true, message: "Export already in progress" } 가 반환되고,
      내보내기 중임을 알리는 메시지가 표시된다. 진행 중인 내보내기는 영향 없이 계속된다.
```

### FR-18-004: 사이드바 파일 검색

**AC-004-1: 검색 필터링**
```
Given: 사이드바에 10개 파일이 표시됨
When: 검색 아이콘 클릭 → "api" 입력
Then: 파일명에 "api"가 포함된 파일만 표시되고, "api" 부분이 하이라이트된다
      E2E 검증: const mark = await page.$('.search-result-item mark')
                expect(mark).not.toBeNull()  // <mark> 태그 DOM 존재 확인
                expect(await mark.textContent()).toBe('api')  // 하이라이트 텍스트 검증
```

**AC-004-2: 대소문자 무시**
```
Given: 사이드바에 "API.md"와 "api-guide.md"가 있음
When: 검색 필드에 "api" 입력
Then: 두 파일 모두 결과에 표시된다
```

**AC-004-3: 검색 모드 종료**
```
Given: 검색 모드가 활성화되어 있고 필터링된 결과가 표시 중
When: Escape 키 또는 X 버튼 클릭
Then: 검색 필드가 숨겨지고 원래 트리 뷰가 복원된다
```

**AC-004-4: 검색 결과 클릭**
```
Given: 검색 결과에 "api.md"가 표시됨
When: "api.md" 항목 클릭
Then: 해당 파일이 뷰어에서 열린다 (탭 모드면 새 탭, 아니면 현재 창에서 교체)
```

**AC-004-5: 키보드 단축키**
```
Given: 뷰어 창이 포커스 상태
When: Ctrl+Shift+F (또는 Cmd+Shift+F)
Then: 사이드바가 표시되고 검색 입력 필드에 포커스가 이동한다
```

**AC-004-6: 검색 결과 클릭과 탭 연동**
```
Given: enableTabs: true이고, 사이드바 검색에서 "api.md" 결과가 표시됨
When: "api.md" 클릭
Then: 새 탭이 생성되어 api.md가 표시된다
```

### FR-18-005: 최근 파일 트레이 메뉴

**AC-005-1: 최근 파일 추가**
```
Given: 최근 파일 목록이 비어 있음
When: test.md 파일을 뷰어에서 열기
Then: 트레이 메뉴의 "최근 문서" 서브메뉴에 "test.md (C:\docs)" 항목이 표시된다
```

**AC-005-2: 중복 파일 최상단 이동**
```
Given: 최근 파일 목록에 [a.md, b.md, c.md] 순서로 있음
When: b.md를 다시 열기
Then: 목록이 [b.md, a.md, c.md] 순서로 변경된다
```

**AC-005-3: 최대 7개 제한**
```
Given: 최근 파일 목록에 7개 파일이 있음
When: 새로운 h.md 파일을 열기
Then: h.md가 맨 위에 추가되고, 7번째(가장 오래된) 항목이 제거된다
```

**AC-005-4: 최근 파일 클릭으로 열기**
```
Given: 트레이 메뉴의 최근 문서에 "test.md (C:\docs)" 항목이 있음
When: 해당 항목 클릭
Then: test.md가 새 뷰어 창에서 열린다
```

**AC-005-5: 목록 지우기**
```
Given: 최근 파일 목록에 3개 항목이 있음
When: "목록 지우기" 클릭
Then: 최근 문서 서브메뉴가 "(비어 있음)"으로 표시된다
```

**AC-005-6: 최근 파일 앱 재시작 후 유지**
```
Given: 최근 파일 목록에 3개 파일이 있는 상태에서 앱 종료
When: 앱 재시작
Then: 트레이 메뉴의 최근 문서에 동일한 3개 파일이 유지된다
```

**AC-005-7: 삭제된 최근 파일 클릭 시 처리**
```
Given: 최근 문서에 "deleted.md (C:\docs)"가 있고, 해당 파일이 디스크에서 삭제됨
When: 트레이 메뉴에서 "deleted.md" 클릭
Then: 에러가 콘솔에 로깅되고, 해당 항목이 최근 문서 목록에서 자동 제거되며, 트레이 메뉴가 갱신된다
```

**AC-005-8: content-only 모드에서 최근 파일 미추가**
```
Given: MCP open_markdown 도구로 content 파라미터만 전달하여 문서를 열기 (filePath 없음)
When: 뷰어 창이 열림
Then: 트레이 메뉴의 최근 문서 목록에 해당 문서가 추가되지 않는다 (filePath가 없으므로)
```

### FR-18-006: 탭 기반 다중 문서 뷰

**AC-006-1: 사이드바 클릭으로 새 탭 생성**
```
Given: enableTabs: true이고, 뷰어에 README.md가 열려 있음
When: 사이드바에서 guide.md 클릭
Then: 새 탭이 생성되어 guide.md가 표시되고, 탭 바에 2개 탭이 보인다
```

**AC-006-2: 탭 전환 시 상태 보존**
```
Given: 탭 1 (README.md)에서 viewerContainer.scrollTop = 300px, 탭 2 (guide.md)에서 scrollTop = 100px
When: 탭 1 클릭 → 탭 2 클릭 → 탭 1 클릭
Then: 탭 1 활성화 시 viewerContainer.scrollTop이 300 ±5 픽셀 이내로 복원된다.
     탭 2 활성화 시 scrollTop이 100 ±5 픽셀 이내로 복원된다.
     검증: E2E에서 탭 전환 후
       const st = await page.evaluate(() => document.querySelector('#viewer-container').scrollTop);
       expect(st).toBeGreaterThanOrEqual(295);
       expect(st).toBeLessThanOrEqual(305);
```

**AC-006-3: 탭 닫기 (이전 탭으로 전환)**
```
Given: 3개 탭 [탭0, 탭1, 탭2]가 열려 있고 탭1(index=1)이 활성
When: 탭1의 × 버튼 클릭
Then: 탭1이 닫히고, 탭0(닫힌 인덱스-1의 탭)이 활성화되며, 탭 바에 2개 탭 표시
     규칙: 닫힌 탭이 index=0이면 남은 첫 번째 탭(새 index=0)으로 전환
```

**AC-006-3b: 첫 번째 탭 닫기 (다음 탭으로 전환)**
```
Given: 3개 탭 [탭0, 탭1, 탭2]가 열려 있고 탭0(index=0)이 활성
When: 탭0의 × 버튼 클릭
Then: 탭0이 닫히고, 기존 탭1(새 index=0)이 활성화되며, 탭 바에 2개 탭 표시
```

**AC-006-4: 마지막 탭 닫기**
```
Given: 1개 탭만 열려 있음 (탭 바 숨김 상태)
When: Ctrl+W
Then: 뷰어 창이 닫힌다
```

**AC-006-5: 탭 1개일 때 탭 바 숨김**
```
Given: 문서를 새로 열어 1개 탭만 있음
When: 화면 확인
Then: 탭 바가 보이지 않고 기존과 동일한 깔끔한 UI
```

**AC-006-6: 동일 파일 탭 포커스**
```
Given: guide.md가 탭 2에서 열려 있음
When: 사이드바에서 guide.md를 다시 클릭
Then: 새 탭이 생성되지 않고, 기존 탭 2로 전환된다
```

**AC-006-7: 최대 탭 수**
```
Given: 20개 탭이 열려 있음
When: 사이드바에서 새 파일 클릭
Then: 새 탭이 생성되지 않고, UI 토스트로 경고 메시지 표시 (i18n 키: viewer.maxTabsReached). 메시지 예: "최대 탭 수(20개)에 도달했습니다."
```

**AC-006-8: enableTabs: false (사이드바 클릭)**
```
Given: Settings에서 enableTabs를 false로 설정
When: 새 창을 열고 사이드바에서 파일 클릭
Then: 탭 바 없이 기존 단일 문서 교체 동작 (navigateTo)
```

**AC-006-9: enableTabs: false + Ctrl+W**
```
Given: enableTabs: false인 뷰어 창
When: Ctrl+W 입력
Then: 탭 닫기 시도 없이 창이 즉시 닫힌다 (기존 동작 유지)
```

**AC-006-12: Ctrl+T로 파일 선택 다이얼로그**
```
Given: enableTabs: true이고 뷰어 창이 열려 있음
When: Ctrl+T (또는 탭 바 [+] 버튼) 클릭
Then: .md 파일 선택 다이얼로그가 열리고, 파일 선택 시 새 탭에서 열린다
```

**AC-006-10: 탭 드래그 앤 드롭 순서 변경 (Phase 2)**
```
Given: 3개 탭 [A, B, C]가 열려 있음
When: 탭 B를 드래그하여 탭 A 앞으로 이동
Then: 탭 순서가 [B, A, C]로 변경된다
```

> **Phase 2 후속 구현** — 이 AC는 Step 18 Phase 1에서 구현하지 않으며, 탭 핵심 기능 안정화 후 Phase 2에서 구현한다.

**AC-006-11: 탭 전환 시 stale 파일 재렌더링**
```
Given: enableTabs: true, 탭0 (README.md, cachedAt=T0)과 탭1 (guide.md) 중 탭1 활성
When: T0 이후 외부에서 README.md를 수정 (mtime=T1, T1 > T0), 그 후 탭0으로 전환
Then: check-file-mtime IPC 응답의 mtime(T1, ms) > tab.cachedAt(T0, ms) 조건으로
      README.md를 다시 읽어 재렌더링한다.
      검증: 재렌더링 후 뷰어에 수정된 내용이 표시됨.
      단, filePath=null인 content-only 탭 전환 시에는 check-file-mtime을 호출하지 않음
```

### FR-18-007: 로컬 이미지 경로 해석

**AC-007-1: 상대 경로 이미지 표시**
```
Given: C:\docs\README.md 파일에 ![logo](./images/logo.png) 포함
When: 뷰어에서 README.md를 filePath로 열기
Then: C:\docs\images\logo.png 이미지가 정상적으로 표시된다
```

**AC-007-2: 절대 URL 이미지 유지**
```
Given: 문서에 ![](https://example.com/image.jpg) 포함
When: 뷰어에서 렌더링
Then: 외부 URL 이미지가 그대로 유지되어 표시된다 (CSP에 의해 차단될 수 있음은 기존 동작)
```

**AC-007-3: data: URL 이미지 유지**
```
Given: 문서에 ![](data:image/png;base64,iVBOR...) 포함
When: 뷰어에서 렌더링
Then: 인라인 data: URL 이미지가 정상 표시된다
```

**AC-007-4: content-only 모드에서 상대 경로**
```
Given: MCP content 파라미터로 ![](./img.png) 포함 문서 열기 (filePath 없음)
When: 뷰어에서 렌더링
Then: 이미지가 표시되지 않음 (basePath 없음, 예상 동작)
```

**AC-007-5: 경로 트래버설 차단**
```
Given: C:\docs\project\README.md에 ![](../../secret/data.png) 포함
When: 뷰어에서 렌더링
Then: C:\docs\project 외부 경로이므로 이미지가 차단되고 표시되지 않는다
```

**AC-007-6: 지원 이미지 포맷**
```
Given: 문서에 png, jpg, gif, svg, webp 이미지 참조 포함
When: 뷰어에서 렌더링 (모든 이미지가 basePath 하위에 존재)
Then: 모든 이미지가 정상적으로 표시된다
```

**AC-007-7: Windows 백슬래시 경로 정규화**
```
Given: 메인 프로세스가 Windows 백슬래시 경로 "C:\docs\project"를 imageBasePath로 전달
When: 렌더러의 resolveRelativePath()가 이 경로를 수신하여 이미지 경로를 해석
Then: 슬래시 변환("C:/docs/project") 후 정상적으로 이미지 경로가 해석된다
      검증: 렌더러 수신 전 메인 프로세스에서 filePath.replace(/\\/g, '/') 처리되므로
            렌더러의 imageBasePath는 항상 슬래시 형식이다 (§6.3 참조)
```

---

## 부록: 설정 스키마 변경 전체

### 변경 전 (pivot-v1.0)

```json
{
  "theme": { "type": "string", "enum": ["light", "dark"], "default": "light" },
  "fontSize": { "type": "number", "minimum": 8, "maximum": 32, "default": 16 },
  "fontFamily": { "type": "string", "minLength": 1, "default": "system-ui, -apple-system, sans-serif" },
  "codeTheme": { "type": "string", "default": "github" },
  "mcpPort": { "type": "number", "minimum": 1024, "maximum": 65535, "default": 52580 },
  "defaultWindowSize": { "type": "string", "enum": ["auto", "s", "m", "l", "f"], "default": "auto" },
  "lastWindowBounds": { "type": "object", "default": {} },
  "fileAssociation": { "type": "boolean", "default": false },
  "fileAssociationPrevProgId": { "type": "string", "default": "" }
}
```

### 변경 후 (step18)

```json
{
  "theme": { "type": "string", "enum": ["light", "dark"], "default": "light" },
  "fontSize": { "type": "number", "minimum": 8, "maximum": 32, "default": 16 },
  "fontFamily": { "type": "string", "minLength": 1, "default": "system-ui, -apple-system, sans-serif" },
  "codeTheme": { "type": "string", "default": "github" },
  "mcpPort": { "type": "number", "minimum": 1024, "maximum": 65535, "default": 52580 },
  "defaultWindowSize": { "type": "string", "enum": ["auto", "s", "m", "l", "f"], "default": "auto" },
  "lastWindowBounds": { "type": "object", "default": {} },
  "fileAssociation": { "type": "boolean", "default": false },
  "fileAssociationPrevProgId": { "type": "string", "default": "" },
  "autoRefresh": { "type": "boolean", "default": true },
  "enableTabs": { "type": "boolean", "default": false },
  "recentFiles": { "type": "array", "items": { "type": "string" }, "default": [], "maxItems": 7 }
}
```

### 추가된 키 요약

| 키 | 타입 | 기본값 | 관련 FR |
|----|------|--------|---------|
| `autoRefresh` | boolean | `true` | FR-18-001 |
| `enableTabs` | boolean | `false` | FR-18-006 |
| `recentFiles` | string[] | `[]` | FR-18-005 |

### Preload API 추가 요약

> **명명 규칙**: IPC 채널명은 kebab-case (`pdf-render-complete`), JavaScript 함수명은 camelCase (`pdfRenderComplete`). 이는 기존 패턴(`render-markdown` / `onRenderMarkdown`)과 일치한다.

```javascript
// === 신규 Senders (Renderer → Main) ===
exportPdf: (opts) => ipcRenderer.invoke('export-pdf', opts),
cancelExport: () => ipcRenderer.send('cancel-export'),       // 배치 내보내기 취소 신호
readFileForTab: (filePath) => ipcRenderer.invoke('read-file-for-tab', filePath),
pdfRenderComplete: () => ipcRenderer.send('pdf-render-complete'),
checkFileMtime: (filePath) => ipcRenderer.invoke('check-file-mtime', filePath),
openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),

// === 신규 Listeners (Main → Renderer) ===
onExportProgress: (callback) => { ... }
```

### IPC 메시지 추가 요약

| 방향 | 채널 | 용도 | 관련 FR |
|------|------|------|---------|
| Renderer → Main | `export-pdf` (invoke) | PDF 내보내기 요청 | FR-18-003 |
| Main → Renderer | `export-progress` (send) | PDF 내보내기 진행률 | FR-18-003 |
| Renderer → Main | `pdf-render-complete` (send) | 숨겨진 PDF 창의 렌더링 완료 알림 | FR-18-003 |
| Renderer → Main | `cancel-export` (send) | 배치 PDF 내보내기 취소 신호 (§2.3.3-C-d 참조) | FR-18-003 |
| Renderer → Main | `read-file-for-tab` (invoke) | 탭용 파일 읽기 + 사이드바 트리 | FR-18-006 |
| Renderer → Main | `check-file-mtime` (invoke) | 파일 mtime 조회 (탭 전환 시 stale 체크) | FR-18-006 |
| Renderer → Main | `open-file-dialog` (invoke) | .md 파일 선택 다이얼로그 표시 (Ctrl+T). 응답: `{ filePath: string \| null }` (§2.6.7 참조) | FR-18-006 |

### 파일 변경 요약

| 파일 | 변경 FR | 변경 유형 |
|------|---------|----------|
| `src/main/index.js` | 001, 002, 003, 005, 006 | IPC 핸들러 추가, 트레이 메뉴 수정, 포트 파일 관리, read-file-for-tab 검증 |
| `src/main/window-manager.js` | 001, 003, 005 | watcher 관리 (rename 이벤트 포함), PDF 내보내기 (숨겨진 BrowserWindow 관리), 최근 파일 콜백, `collectMdPaths(tree)` 함수 추가 (배치 PDF 내보내기용 — §2.3.3-C 참조). **`entry.meta.tree` 보장**: `createWindow()`에서 `filePath` 기반 창 생성 시 `buildDirectoryTree()`가 항상 호출되어 `entry.meta.tree`를 설정한다. MCP `content`-only 모드에서는 `entry.meta.tree`가 `null`이며, 이 경우 배치 PDF 옵션이 비활성화됨 (AC-003-3). |
| `src/main/mcp-http.mjs` | 002 | `startMcpHttpServer(windowManager, store, userDataPath)` 시그니처 변경, 포트 파일 기록. **동시 변경 필수**: `index.js`의 호출부에서 세 번째 인자(`app.getPath('userData')`)를 함께 전달해야 함. **stdio 서버 영향 없음**: `mcp-server.mjs`는 별도 프로세스로 IPC 소켓을 통해 Electron에 접속하므로, HTTP 서버 시그니처 변경의 영향을 받지 않는다. |
| `src/main/preload.js` | 003, 006 | exportPdf, readFileForTab, checkFileMtime, openFileDialog, onExportProgress, pdfRenderComplete |
| `src/renderer/viewer.html` | 003, 004, 006, 007 | PDF 모달, 검색 필드, 탭 바, 모듈 스크립트 태그. **스크립트 로드 순서는 §6.1.1 참조** (순서 변경 시 `window.__docuLightModules` 초기화 실패 위험) |
| `src/renderer/viewer.js` | 001, 003, 004, 006, 007 | 스크롤 보존, 초기화 코드. 핵심 로직은 4개 신규 모듈로 필수 분리 (위 참조) |
| `src/renderer/tab-manager.js` | 006 | (신규, 필수) 탭 관리 로직 분리 |
| `src/renderer/sidebar-search.js` | 004 | (신규, 필수) 사이드바 검색 로직 분리 |
| `src/renderer/pdf-export-ui.js` | 003 | (신규, 필수) PDF 내보내기 UI 로직 분리 |
| `src/renderer/image-resolver.js` | 007 | (신규, 필수) 이미지 경로 해석 로직 분리 |
| `src/renderer/viewer.css` | 003, 004, 006 | 모달, 검색, 탭 스타일 |
| `src/renderer/settings.html` | 001, 006 | autoRefresh, enableTabs 체크박스 |
| `src/renderer/settings.js` | 001, 006 | 설정 저장/로드 |
| `src/locales/*.json` (4개) | 전체 | i18n 문자열 추가 |
| `CLAUDE.md` | 001, 002, 003, 004, 005, 006, 007 | Step 18 완료 후 갱신 필요: Settings 테이블 (autoRefresh, enableTabs, `recentFiles` (max 7 items) 추가), Preload API 목록 (exportPdf, readFileForTab, checkFileMtime, openFileDialog, onExportProgress, pdfRenderComplete 추가), Keyboard Shortcuts (Ctrl+T 추가), Known Limitations (File Watching, Search, Export 항목 해결 반영) |
