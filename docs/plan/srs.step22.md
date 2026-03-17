# SRS: DocLight — Step 22 (MCP 문서 저장 개선 · 경로 복사 · MD 붙여넣기)

## 메타데이터

| 항목 | 내용 |
|------|------|
| 버전 | step22 |
| 생성일 | 2026-03-17 |
| 이전 버전 | docs/plan/srs.step21.md (step21) |
| 성격 | **증분 확장** — MCP 저장 설정 재설계, 경로 복사/탐색기 열기, MD 텍스트 붙여넣기 |
| 평가 라운드 | 2 |

---

## 1. 개요

### 1.1 목적

본 SRS는 DocLight Electron Markdown 뷰어의 Step 22 기능 확장을 정의한다.
MCP 문서 저장 설정의 대대적 개선(명칭 변경, 수동 저장, 디렉토리 포매터), 사이드바/뷰어의 경로 복사 및 파일 탐색기 열기, 빈 페이지 MD 텍스트 붙여넣기 기능을 추가한다.

### 1.2 범위

**본 SRS가 커버하는 범위:**

- FR-22-001: MCP 문서 저장 설정 재설계 (명칭 변경, 수동 저장, 디렉토리 포매터)
- FR-22-002: 사이드바 파일 항목 컨텍스트 메뉴 (경로 복사, 파일 탐색기 열기)
- FR-22-003: 뷰어 컨텍스트 메뉴 경로 복사 확장 (MCP 저장 파일)
- FR-22-004: MD 텍스트 붙여넣기 (빈 페이지)

**본 SRS가 커버하지 않는 범위:**

- MCP 도구(open_markdown, update_markdown 등)의 파라미터 변경
- 파일 편집(콘텐츠 수정) 기능
- 자동 저장 파일의 검색 인덱싱 로직 변경
- 탭 간 붙여넣기 상태 동기화

### 1.3 이전 버전 대비 변경사항

| 항목 | step21 (이전) | step22 (현재) |
|------|---------------|---------------|
| MCP 저장 설정 레이블 | "MCP 자동 저장" | "MCP로 불러온 문서 저장" |
| 자동 저장 OFF 시 수동 저장 | 불가 (경로 변경/저장 모두 차단) | 컨텍스트 메뉴 "저장" + Ctrl+S로 수동 저장 가능 |
| 날짜 서브디렉토리 | 항상 `YYYY-MM-DD/` 하위에 저장 | 기본 동작 변경: 서브디렉토리 없음. 디렉토리 포매터로 설정 가능 |
| 사이드바 컨텍스트 메뉴 | 없음 | 파일/디렉토리에서 우클릭 → 경로 복사, 파일 탐색기 열기 |
| 뷰어 경로 복사 (MCP) | `currentFilePath` 있을 때만 활성 | MCP 저장 파일도 경로 복사 가능 (Ctrl+Shift+C) |
| 빈 페이지 기능 | 드래그앤드롭만 가능 | MD 텍스트 붙여넣기(Ctrl+V)로 즉시 렌더링 |

### 1.4 현재 시스템 상태

Step 22 시작 시점의 DocLight 시스템 상태:

| 구성요소 | 현재 상태 |
|----------|----------|
| MCP 저장 | `src/main/mcp-save.js` — `saveMcpFile()` 함수, `mcpAutoSave=false`이면 `null` 반환 (저장 차단). 항상 `YYYY-MM-DD/` 서브디렉토리에 `HHMMSS_파일명.md` 형식으로 저장 |
| 설정 UI | `settings.html` — "MCP 자동 저장" 체크박스 + 경로 입력 + 찾아보기 버튼 |
| 컨텍스트 메뉴 | `viewer.js` — 뷰어 영역 우클릭 전용. Copy Path는 `currentFilePath` 존재 시에만 활성. 사이드바에는 컨텍스트 메뉴 없음 |
| 사이드바 트리 | `viewer.js` — `renderTreeNode()`으로 `.tree-item` DOM 생성. 클릭은 파일 열기/디렉토리 토글만 처리 |
| 토스트 | `showViewerToast(message)` — 텍스트 메시지만 지원, HTML 미지원 |
| 키보드 단축키 | Ctrl+S 미사용, Ctrl+Shift+C 미사용 |
| 클립보드 | `navigator.clipboard.writeText()` 쓰기만 사용. 읽기(`readText()`) 미사용 |
| 빈 페이지 | `.empty-state` 드래그앤드롭 힌트 표시. paste 이벤트 리스너 없음 |
| 렌더러 상태 | `savedFilePath` — auto-save 경로 추적, `originalContent` — MCP content 원본 추적 |

### 1.5 구현 우선순위

| 순서 | 기능 | 난이도 | 이유 |
|------|------|--------|------|
| 1 | FR-22-001: MCP 문서 저장 설정 재설계 | 높음 | 설정 UI 변경 + mcp-save.js 로직 재설계 + 수동 저장 IPC 추가 |
| 2 | FR-22-002: 사이드바 컨텍스트 메뉴 | 중간 | 새 컨텍스트 메뉴 시스템 + IPC 연동 |
| 3 | FR-22-003: 뷰어 경로 복사 확장 | 낮음 | 기존 컨텍스트 메뉴 + 단축키 확장 |
| 4 | FR-22-004: MD 텍스트 붙여넣기 | 낮음 | paste 이벤트 리스너 + 렌더링 호출 |

### 1.6 설계 결정 사항

| 결정 | 이유 |
|------|------|
| 자동 저장 OFF에서도 저장 경로 설정 허용 | 자동 저장과 수동 저장은 별개 기능. 자동 저장을 원하지 않는 사용자도 수동으로 파일을 저장할 수 있어야 함 |
| 수동 저장 시 토스트로 결과 알림 (에러 시 분홍색) | 저장 다이얼로그 없이 백그라운드 저장이므로 사용자 피드백 필수. 에러 시 시각적 구분 필요 |
| 기본 날짜 서브디렉토리 제거 | 기존 `YYYY-MM-DD` 강제 생성은 사용자 선택권 제한. 포매터로 선택적 설정 가능하도록 변경 |
| 디렉토리 포매터 토큰을 `{yyyy-mm-dd}`, `{project}` 등 제한적으로 지원 | 확장성보다 단순성 우선. 지원 토큰을 명확히 한정하여 오류 가능성 최소화 |
| OS별 디렉토리 세퍼레이터 자동 변환 | 사용자가 `/`와 `\` 중 어떤 것을 입력해도 동작해야 함. 크로스 플랫폼 호환성 보장 |
| 사이드바 컨텍스트 메뉴는 뷰어 컨텍스트 메뉴와 동일한 HTML 기반 구현 | Electron Menu API가 아닌 커스텀 HTML 컨텍스트 메뉴를 사용하는 기존 패턴과 일관성 유지 |
| 빈 페이지 붙여넣기는 빈 페이지에서만 동작 | 기존 콘텐츠가 있는 페이지에서 paste는 텍스트 선택 등 기존 동작과 충돌. 빈 페이지 한정으로 안전하게 제한 |
| 붙여넣기된 MD는 MCP content와 동일하게 취급 | MCP content 기반 창과 동일한 저장/복사 경로 활용. 별도 상태 관리 불필요 |
| 부모 디렉토리 자동 생성 (`recursive: true`) | 포매터로 중첩 디렉토리를 설정할 수 있으므로 `mkdir -p` 동작 필수 |

### 1.7 이전 SRS와의 모순 해결

| 모순 사항 | 이전 동작 (step21) | 해결 방안 (step22) |
|-----------|-------------------|-------------------|
| `mcpAutoSave=false`이면 `saveMcpFile()` 즉시 `null` 반환 | 저장 경로 설정/사용 전면 차단 | `saveMcpFile()`의 자동 저장 로직은 유지하되, 별도 `mcpManualSave()` 함수 추가. 자동 저장 체크박스는 자동 저장만 제어 |
| `mcp-save.js`에서 `YYYY-MM-DD` 서브디렉토리 하드코딩 | 항상 날짜 서브폴더 생성 | 포매터 설정값을 읽어 동적 경로 생성. 기존 `saveMcpFile()`도 포매터 적용 |
| Copy Path (`viewer.copyPath`)는 `currentFilePath` 전용 | MCP content 문서에서 disabled | `savedFilePath` 또는 `saveAs` 경로가 있으면 해당 경로로 복사 가능 |

---

## 2. 기능 요구사항

---

### FR-22-001: MCP 문서 저장 설정 재설계

#### 2.1.1 설명

MCP 자동 저장 설정을 전면 개편한다.

1. **명칭 변경**: "MCP 자동 저장" → "MCP로 불러온 문서 저장"
2. **자동 저장 OFF에서도 수동 저장 허용**: 체크박스 OFF 시에도 경로 설정 가능, 수동 저장(컨텍스트 메뉴 "저장" + Ctrl+S) 지원
3. **디렉토리 포매터**: 저장 경로 입력 아래에 서브디렉토리 포맷 입력창 추가. `{yyyy-mm-dd}`, `{HH}`, `{project}` 등 토큰 지원
4. **기본 날짜 서브디렉토리 제거**: 기존 하드코딩된 `YYYY-MM-DD` 서브폴더 자동 생성 제거
5. **부모 디렉토리 자동 생성**: 포매터로 지정된 경로의 부모 디렉토리를 자동 생성

#### 2.1.2 입력

| 입력 | 출처 | 타입 | 설명 |
|------|------|------|------|
| 설정 변경 | Settings UI | 이벤트 | 체크박스, 경로, 포매터 변경 |
| 컨텍스트 메뉴 "저장" 클릭 | 사용자 UI 조작 | 이벤트 | MCP 문서 수동 저장 |
| Ctrl+S / Cmd+S | 키보드 단축키 | 이벤트 | MCP 문서 수동 저장 |

#### 2.1.3 처리

**A. 설정 UI 변경 (settings.html, settings.js)**

**A-1: 레이블 변경**

- `settings.mcpAutoSave` i18n 키: "MCP 자동 저장" → "MCP로 불러온 문서 저장"
- `settings.mcpAutoSaveHint` i18n 키: "MCP로 열린 파일을 자동으로 저장" → "MCP로 열린 파일을 자동으로 디스크에 저장"
- 체크박스 레이블은 자동 저장 ON/OFF만 제어함을 명확히 표현

**A-2: 경로 입력 그룹 분리**

기존 `mcpAutoSavePath-group`은 체크박스 상태와 무관하게 항상 표시한다.

- 기존: `mcpAutoSave-checkbox` OFF → `mcpAutoSavePath-group` 숨김 (settings.js에서 display:none)
- 변경: 체크박스 OFF에서도 경로 그룹 항상 표시. 경로 입력 가능.

**A-3: 디렉토리 포매터 입력창 추가**

저장 경로 입력(`mcpAutoSavePath-input`) 바로 아래에 새 입력창을 추가한다.

```html
<div class="path-input-group" id="mcpSaveSubDir-group">
  <input type="text" id="mcpSaveSubDir-input"
         data-i18n-placeholder="settings.mcpSaveSubDirPlaceholder">
  <button type="button" id="mcpSaveSubDir-help-btn" class="help-btn"
          data-i18n-title="settings.mcpSaveSubDirHelp">?</button>
</div>
```

**A-4: 포매터 (?) 도움말 팝업**

`mcpSaveSubDir-help-btn` 클릭 시 모달/팝업으로 포매터 사용법 표시.

팝업 내용 (i18n 키: `settings.mcpSaveSubDirHelpContent`):

```
서브디렉토리 포맷

지원 토큰:
  {yyyy}       → 연도 (예: 2026)
  {mm}         → 월 (예: 03)
  {dd}         → 일 (예: 17)
  {yyyy-mm-dd} → 날짜 (예: 2026-03-17)
  {HH}         → 시 (24시간, 예: 14)
  {MM}         → 분 (예: 05)
  {ss}         → 초 (예: 30)
  {project}    → 프로젝트 이름

예시:
  {yyyy-mm-dd}           → 2026-03-17/파일명.md
  {project}/{yyyy-mm-dd} → MyProject/2026-03-17/파일명.md
  {yyyy}/{mm}            → 2026/03/파일명.md

/ 와 \ 모두 사용 가능하며, OS에 맞게 자동 변환됩니다.
```

팝업 구현: 기존 PDF export 모달과 유사한 CSS 모달. Escape 키 또는 외부 클릭으로 닫기.

**A-5: 새 설정 키**

| 설정 키 | 타입 | 기본값 | 설명 |
|---------|------|--------|------|
| `mcpSaveSubDir` | string | `''` | 서브디렉토리 포맷 문자열. 빈 문자열이면 서브디렉토리 없이 저장 |

**B. mcp-save.js 로직 변경**

**B-1: 포매터 해석 함수 추가**

```javascript
function resolveSubDir(format, { project }) {
  if (!format) return '';
  const now = new Date();
  const tokens = {
    '{yyyy}': String(now.getFullYear()),
    '{mm}': String(now.getMonth() + 1).padStart(2, '0'),
    '{dd}': String(now.getDate()).padStart(2, '0'),
    '{yyyy-mm-dd}': [
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-'),
    '{HH}': String(now.getHours()).padStart(2, '0'),
    '{MM}': String(now.getMinutes()).padStart(2, '0'),
    '{ss}': String(now.getSeconds()).padStart(2, '0'),
    '{project}': sanitizeFilenameWithUrlEncode(project || 'default')
  };
  let result = format;
  for (const [token, value] of Object.entries(tokens)) {
    result = result.split(token).join(value);
  }
  // OS별 세퍼레이터 변환
  result = result.replace(/[/\\]+/g, path.sep);
  // 선행/후행 세퍼레이터 제거
  result = result.replace(new RegExp(`^\\${path.sep}+|\\${path.sep}+$`, 'g'), '');
  return result;
}
```

**B-2: `saveMcpFile()` 수정**

기존 하드코딩된 `dateFolder` 생성 로직을 `resolveSubDir()`로 교체:

```javascript
async function saveMcpFile(store, { content, filePath, title, noSave, project }) {
  if (noSave === true) return null;
  const enabled = store.get('mcpAutoSave', false);
  const savePath = store.get('mcpAutoSavePath', '');
  if (!enabled || !savePath) return null;

  const subDirFormat = store.get('mcpSaveSubDir', '');
  const subDir = resolveSubDir(subDirFormat, { project });

  // 타임스탬프 접두어
  const now = new Date();
  const ts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');

  // 파일명 결정 (기존 로직 유지)
  let fileName;
  if (filePath) {
    fileName = `${ts}_${path.basename(filePath)}`;
  } else {
    let nameCore = null;
    if (title) {
      nameCore = sanitizeFilenameWithUrlEncode(title.trim());
    } else {
      const extracted = extractTitleFromContent(content);
      if (extracted) nameCore = sanitizeFilenameWithUrlEncode(extracted);
    }
    fileName = nameCore ? `${ts}_${nameCore}.md` : `${ts}.md`;
  }

  // 최종 경로: basePath / subDir / fileName
  const destDir = subDir ? path.join(savePath, subDir) : savePath;
  const destPath = path.join(destDir, fileName);
  try {
    await fs.promises.mkdir(destDir, { recursive: true });
    if (filePath) {
      await fs.promises.copyFile(filePath, destPath);
    } else {
      await fs.promises.writeFile(destPath, content || '', 'utf-8');
    }
    console.log(`[doculight] MCP auto-save: ${destPath}`);
    return destPath;
  } catch (err) {
    console.error(`[doculight] MCP auto-save failed: ${err.message}`);
    return null;
  }
}
```

**B-3: `mcpManualSave()` 함수 추가**

자동 저장 OFF일 때 수동 저장을 처리하는 새 함수:

```javascript
async function mcpManualSave(store, { content, filePath, title, project }) {
  const savePath = store.get('mcpAutoSavePath', '');
  if (!savePath) {
    return { success: false, errorKey: 'viewer.saveErrorNoDir' };
  }

  const subDirFormat = store.get('mcpSaveSubDir', '');
  const subDir = resolveSubDir(subDirFormat, { project });

  const now = new Date();
  const ts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');

  let fileName;
  if (filePath) {
    fileName = `${ts}_${path.basename(filePath)}`;
  } else {
    let nameCore = null;
    if (title) {
      nameCore = sanitizeFilenameWithUrlEncode(title.trim());
    } else {
      const extracted = extractTitleFromContent(content);
      if (extracted) nameCore = sanitizeFilenameWithUrlEncode(extracted);
    }
    fileName = nameCore ? `${ts}_${nameCore}.md` : `${ts}.md`;
  }

  const destDir = subDir ? path.join(savePath, subDir) : savePath;
  const destPath = path.join(destDir, fileName);
  try {
    await fs.promises.mkdir(destDir, { recursive: true });
    if (filePath) {
      await fs.promises.copyFile(filePath, destPath);
    } else {
      await fs.promises.writeFile(destPath, content || '', 'utf-8');
    }
    console.log(`[doculight] MCP manual save: ${destPath}`);
    return { success: true, filePath: destPath };
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return { success: false, errorKey: 'viewer.saveErrorPermission' };
    }
    return { success: false, errorKey: 'viewer.saveErrorGeneric', errorDetail: err.message };
  }
}
```

**C. 수동 저장 — IPC 핸들러 (index.js)**

**C-1: `mcp-manual-save` IPC invoke 핸들러**

```javascript
ipcMain.handle('mcp-manual-save', async (event, params) => {
  // params: { content?, filePath?, title?, project? }
  const result = await mcpManualSave(store, params);
  if (result.success) {
    // WindowEntry.meta에도 savedFilePath 업데이트
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      const entry = windowManager.getEntryByWindow(win);
      if (entry) entry.meta.savedFilePath = result.filePath;
    }
    // 검색 엔진 인덱스 갱신
    if (searchEngine) searchEngine.markDirty();
  }
  return result;
});
```

**C-2: Preload 브릿지**

```javascript
mcpManualSave: (params) => ipcRenderer.invoke('mcp-manual-save', params)
```

**D. 수동 저장 — 렌더러 (viewer.js)**

**D-1: `handleMcpSave()` 함수**

```javascript
async function handleMcpSave() {
  // MCP로 열린 문서가 아니면 무시
  if (!isMcpDocument) return;
  // 빈 페이지 무시
  var contentEl = document.getElementById('content');
  var isEmpty = !currentFilePath && (!contentEl || !contentEl.hasChildNodes() ||
                !!contentEl.querySelector('.empty-state'));
  if (isEmpty) return;

  var params = {};
  if (currentFilePath) {
    params.filePath = currentFilePath;
  } else {
    params.content = originalContent || '';
  }
  params.title = document.title || '';
  params.project = currentProject || '';

  var result = await window.doclight.mcpManualSave(params);
  if (result.success) {
    savedFilePath = result.filePath;
    showViewerToast(t('viewer.savedToast') + ': ' + result.filePath);
  } else {
    showViewerToastError(t(result.errorKey) + (result.errorDetail ? ': ' + result.errorDetail : ''));
  }
}
```

**D-2: `isMcpDocument` 상태 변수**

MCP를 통해 열린 문서인지 추적하는 불리언 변수. `render-markdown` 이벤트 수신 시 `data.source === 'mcp'` 여부로 설정.

> **참고**: 현재 `render-markdown` 이벤트 데이터에 `source` 필드가 없으므로, `open_markdown` IPC 핸들러에서 `render-markdown` 전송 시 `{ source: 'mcp' }` 필드를 추가해야 한다.

**D-3: `showViewerToastError()` 함수**

에러 토스트를 분홍색 글씨로 표시하는 새 함수:

```javascript
function showViewerToastError(message) {
  var existing = document.querySelector('.viewer-toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.className = 'viewer-toast viewer-toast-error';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(function () {
    toast.classList.add('visible');
  });
  setTimeout(function () {
    toast.classList.remove('visible');
    setTimeout(function () { toast.remove(); }, 200);
  }, 3500);  // 에러는 3.5초 (일반 2.5초보다 길게)
}
```

CSS 추가:

```css
.viewer-toast-error {
  color: #e91e63;  /* Material Design Pink 500 */
}
```

**D-4: 컨텍스트 메뉴 "저장" 항목**

MCP 문서이고 자동 저장이 OFF인 경우 컨텍스트 메뉴에 "저장" 항목을 추가한다.

표시 조건:
- `isMcpDocument === true`
- `mcpAutoSaveEnabled === false` (자동 저장 OFF)
- 빈 페이지가 아닌 상태

메뉴 위치: "다른 이름으로 저장..." 위에 삽입.

```
8.  저장 (Ctrl+S)              ← 신규 (MCP 문서 + 자동 저장 OFF일 때만)
9.  다른 이름으로 저장... (Ctrl+Shift+S)
```

**D-5: Ctrl+S / Cmd+S 키보드 단축키**

```javascript
// Ctrl+S / Cmd+S: MCP manual save
if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === 's') {
  e.preventDefault();
  handleMcpSave();
  return;
}
```

> **충돌 검사**: `Ctrl+S`는 기존 코드베이스에서 사용되지 않음. `Ctrl+Shift+S` (Save As)와 키 조합 상이 — 충돌 없음.

**D-6: `mcpAutoSaveEnabled` 상태 변수**

설정의 `mcpAutoSave` 값을 렌더러에서 참조하기 위한 변수. `render-markdown` 이벤트에서 `data.mcpAutoSave` 필드로 전달받거나, 별도 IPC로 조회.

#### 2.1.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| 설정 UI 변경 | Settings 윈도우 | 레이블 변경, 포매터 입력창, 도움말 팝업 |
| .md 파일 | 파일 시스템 | 수동 저장 시 MCP 저장 경로에 파일 생성 |
| 토스트 | 렌더러 UI | 저장 성공(일반) 또는 실패(분홍색) 메시지 |
| 설정 업데이트 | electron-store | `mcpSaveSubDir` 신규 키 |

#### 2.1.5 예외

| 조건 | 처리 |
|------|------|
| 저장 경로 미설정 (`mcpAutoSavePath` 빈 문자열) | `{ errorKey: 'viewer.saveErrorNoDir' }` → 에러 토스트: "저장 경로가 설정되지 않았습니다" (분홍색) |
| 저장 경로 권한 없음 (EACCES/EPERM) | `{ errorKey: 'viewer.saveErrorPermission' }` → 에러 토스트: "저장 경로에 대한 쓰기 권한이 없습니다" (분홍색) |
| 포매터에 지원하지 않는 토큰 사용 | 미해석 토큰은 그대로 디렉토리 이름으로 사용 (예: `{unknown}` → 리터럴 `{unknown}` 디렉토리). 에러 없음 |
| 포매터 결과 디렉토리가 OS에서 허용하지 않는 문자 포함 | `mkdir` 에러 → 에러 토스트 표시 |
| 비-MCP 문서에서 Ctrl+S | `isMcpDocument === false` → 무시 (아무 동작 없음) |
| MCP 문서이지만 빈 페이지에서 Ctrl+S | `isEmpty` 체크 → 무시 |
| 디스크 공간 부족 | `writeFile` 에러 → 에러 토스트 (분홍색, 시스템 에러 메시지 포함) |
| `project` 값이 없는 MCP 호출에서 `{project}` 토큰 사용 | `'default'`로 대체 |

---

### FR-22-002: 사이드바 파일 항목 컨텍스트 메뉴

#### 2.2.1 설명

사이드바의 파일/디렉토리 항목에서 우클릭 시 컨텍스트 메뉴를 표시한다.

메뉴 항목:
1. **경로 복사** — 절대 경로를 클립보드에 복사. 토스트로 알림.
2. **파일 탐색기에서 열기** — OS 파일 탐색기에서 해당 파일/디렉토리를 표시.

파일과 디렉토리 모두 지원한다.

#### 2.2.2 입력

| 입력 | 출처 | 타입 | 설명 |
|------|------|------|------|
| 사이드바 항목 우클릭 | 사용자 UI 조작 | contextmenu 이벤트 | `.tree-item` 요소에서 발생 |

#### 2.2.3 처리

**1단계: 사이드바 컨텍스트 메뉴 함수 (viewer.js)**

`showSidebarContextMenu(e, itemPath, isDirectory)` 함수를 새로 추가:

```javascript
function showSidebarContextMenu(e, itemPath, isDirectory) {
  // 기존 메뉴 제거
  var old = document.querySelector('.ctx-menu');
  if (old) old.remove();

  var menu = document.createElement('div');
  menu.className = 'ctx-menu';

  // 경로 복사
  var copyPathItem = document.createElement('div');
  copyPathItem.className = 'ctx-menu-item';
  copyPathItem.textContent = t('viewer.copyPath');
  copyPathItem.addEventListener('click', function () {
    menu.remove();
    navigator.clipboard.writeText(itemPath).then(function () {
      showViewerToast(t('viewer.pathCopied'));
    }).catch(function (err) {
      console.error('Failed to copy path:', err);
    });
  });
  menu.appendChild(copyPathItem);

  // 파일 탐색기에서 열기
  var showExplorerItem = document.createElement('div');
  showExplorerItem.className = 'ctx-menu-item';
  showExplorerItem.textContent = t('viewer.showInExplorer');
  showExplorerItem.addEventListener('click', function () {
    menu.remove();
    if (isDirectory) {
      window.doclight.openDirectory(itemPath);
    } else {
      window.doclight.showFileInExplorer(itemPath);
    }
  });
  menu.appendChild(showExplorerItem);

  document.body.appendChild(menu);
  // 위치 조정 (기존 showContextMenu와 동일한 뷰포트 보정 로직)
  var rect = menu.getBoundingClientRect();
  var x = e.clientX;
  var y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  // 닫기 핸들러 (기존 패턴)
  function closeMenu(ev) {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', escHandler);
    }
  }
  function escHandler(ev) {
    if (ev.key === 'Escape') {
      menu.remove();
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', escHandler);
    }
  }
  setTimeout(function () {
    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('keydown', escHandler);
  }, 0);
}
```

**2단계: 사이드바 트리 항목에 contextmenu 이벤트 리스너 추가 (viewer.js)**

`renderTreeNode()` 함수에서 `.tree-item` 생성 시 contextmenu 이벤트를 등록:

```javascript
item.addEventListener('contextmenu', function (e) {
  e.preventDefault();
  e.stopPropagation();  // 부모 sidebar로의 이벤트 버블링 방지
  showSidebarContextMenu(e, node.path, !!node.isDirectory);
});
```

**3단계: Preload 브릿지 — `openDirectory()` 추가**

디렉토리용 파일 탐색기 열기:

```javascript
openDirectory: (dirPath) => ipcRenderer.invoke('open-directory', dirPath)
```

**4단계: IPC 핸들러 — `open-directory` (index.js)**

```javascript
ipcMain.handle('open-directory', async (event, dirPath) => {
  const { shell } = require('electron');
  shell.openPath(dirPath);
});
```

> **참고**: 기존 `showFileInExplorer`는 `shell.showItemInFolder()`를 사용하여 파일을 선택한 상태로 탐색기를 연다. 디렉토리의 경우 `shell.openPath()`로 해당 디렉토리를 직접 연다.

#### 2.2.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| 컨텍스트 메뉴 | 렌더러 UI | 2개 항목: 경로 복사, 파일 탐색기 열기 |
| 클립보드 | 시스템 | 절대 경로 텍스트 복사 |
| 토스트 | 렌더러 UI | "경로가 복사되었습니다" |
| 파일 탐색기 | OS | 파일/디렉토리 위치로 탐색기 열기 |

#### 2.2.5 예외

| 조건 | 처리 |
|------|------|
| `node.path`가 없는 항목 (렌더링 오류 등) | 컨텍스트 메뉴 미표시 |
| `node.exists === false` 항목 | 컨텍스트 메뉴 표시하되, "파일 탐색기에서 열기"는 `disabled`. 경로 복사는 허용 |
| 클립보드 접근 실패 (권한 거부) | `catch` → `console.error`, 사용자에게 피드백 없음 (브라우저 제한) |
| 디렉토리가 외부에서 삭제된 상태에서 "파일 탐색기 열기" | OS가 기본 위치(홈 등)로 폴백. OS 동작에 위임 |

---

### FR-22-003: 뷰어 컨텍스트 메뉴 경로 복사 확장 (MCP 저장 파일)

#### 2.3.1 설명

뷰어의 기존 "경로 복사" 기능을 확장한다.

**기존 동작**: `currentFilePath`가 있을 때만 "경로 복사" 활성.
**변경 동작**: `currentFilePath` 없는 MCP 문서에서도, `savedFilePath` (auto-save 또는 manual-save) 또는 Save As로 저장한 경로가 있으면 "경로 복사" 활성.

추가로 `Ctrl+Shift+C` / `Cmd+Shift+C` 단축키를 등록한다.

#### 2.3.2 입력

| 입력 | 출처 | 타입 | 설명 |
|------|------|------|------|
| 컨텍스트 메뉴 "경로 복사" 클릭 | 사용자 UI 조작 | 이벤트 | 확장된 경로 복사 |
| Ctrl+Shift+C / Cmd+Shift+C | 키보드 단축키 | 이벤트 | 경로 복사 단축키 |

#### 2.3.3 처리

**1단계: 복사 대상 경로 결정 로직**

```javascript
function getCopyablePath() {
  // 1순위: currentFilePath (로컬 파일)
  if (currentFilePath) return currentFilePath;
  // 2순위: saveAsFilePath (다른 이름으로 저장한 경로)
  if (saveAsFilePath) return saveAsFilePath;
  // 3순위: savedFilePath (MCP auto-save 또는 manual-save 경로)
  if (savedFilePath) return savedFilePath;
  return null;
}
```

**2단계: `saveAsFilePath` 상태 변수 추가**

Save As(`handleSaveAs()`)로 저장 성공 시 반환된 `result.filePath`를 `saveAsFilePath` 변수에 저장.

```javascript
// handleSaveAs() 성공 시 추가
if (result.success) {
  saveAsFilePath = result.filePath;  // 추가
  showViewerToast(t('viewer.savedToast') + ': ' + result.filePath);
}
```

**3단계: 컨텍스트 메뉴 "경로 복사" 조건 변경**

기존:
```javascript
copyPathItem.className = 'ctx-menu-item' + (currentFilePath ? '' : ' disabled');
```

변경:
```javascript
var copyPath = getCopyablePath();
copyPathItem.className = 'ctx-menu-item' + (copyPath ? '' : ' disabled');
```

클릭 핸들러도 `copyPath` 변수를 사용하도록 변경.

**4단계: Ctrl+Shift+C 단축키 등록**

```javascript
// Ctrl+Shift+C / Cmd+Shift+C: Copy path
if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
  e.preventDefault();
  var pathToCopy = getCopyablePath();
  if (pathToCopy) {
    navigator.clipboard.writeText(pathToCopy).then(function () {
      showViewerToast(t('viewer.pathCopied'));
    });
  } else if (isMcpDocument) {
    // MCP 문서이지만 저장되지 않은 상태
    showViewerToast(t('viewer.saveFirstToCopyPath'));
  }
  return;
}
```

> **충돌 검사**: `Ctrl+Shift+C`는 기존 코드베이스에서 사용되지 않음. `Ctrl+C` (텍스트 복사)와 키 조합 상이 (Shift 추가) — 충돌 없음.

#### 2.3.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| 클립보드 | 시스템 | 파일 절대 경로 복사 |
| 토스트 | 렌더러 UI | "경로가 복사되었습니다" 또는 "먼저 문서를 저장해주세요" |

#### 2.3.5 예외

| 조건 | 처리 |
|------|------|
| 경로 없음 (저장 안 됨) + 단축키 | MCP 문서: "먼저 문서를 저장해주세요" 토스트. 비-MCP: 무시 |
| 경로 없음 + 컨텍스트 메뉴 | `disabled` 상태 (클릭 불가) |
| Save As 후 Auto-save도 있는 경우 | `saveAsFilePath` 우선 (사용자가 직접 선택한 경로) |

---

### FR-22-004: MD 텍스트 붙여넣기 (빈 페이지)

#### 2.4.1 설명

빈 페이지(empty state)에서 클립보드의 마크다운 텍스트를 Ctrl+V로 붙여넣으면, 해당 텍스트를 즉시 마크다운으로 렌더링하여 표시한다. 빈 페이지가 아닌 경우에는 동작하지 않는다(기존 브라우저 기본 동작 유지).

#### 2.4.2 입력

| 입력 | 출처 | 타입 | 설명 |
|------|------|------|------|
| Ctrl+V / Cmd+V | 키보드 단축키 | paste 이벤트 | 클립보드 텍스트 붙여넣기 |

#### 2.4.3 처리

**1단계: paste 이벤트 리스너 등록 (viewer.js)**

```javascript
document.addEventListener('paste', async function (e) {
  // 빈 페이지가 아니면 무시 (기본 동작 유지)
  var contentEl = document.getElementById('content');
  var isEmpty = !currentFilePath && (!contentEl || !contentEl.hasChildNodes() ||
                !!contentEl.querySelector('.empty-state'));
  if (!isEmpty) return;

  // 포커스가 input/textarea에 있으면 무시 (검색바 등)
  var active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

  // Find bar가 열려 있으면 무시
  if (findBarVisible) return;

  // 클립보드에서 텍스트 가져오기
  var text = null;
  if (e.clipboardData) {
    text = e.clipboardData.getData('text/plain');
  }
  if (!text || !text.trim()) return;

  e.preventDefault();

  // MD 텍스트를 현재 창에 렌더링
  originalContent = text;
  currentFilePath = null;
  isMcpDocument = false;  // 붙여넣기는 MCP 문서가 아님
  saveAsFilePath = null;
  savedFilePath = null;

  // 메인 프로세스에 렌더링 요청
  window.doclight.renderPastedContent(text);
});
```

**2단계: Preload 브릿지**

```javascript
renderPastedContent: (content) => ipcRenderer.invoke('render-pasted-content', content)
```

**3단계: IPC 핸들러 (index.js)**

```javascript
ipcMain.handle('render-pasted-content', async (event, content) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  // 콘텐츠를 렌더러로 전송 (기존 render-markdown 이벤트 재사용)
  win.webContents.send('render-markdown', {
    content: content,
    filePath: null,
    title: extractTitleFromContent(content) || 'Pasted',
    source: 'paste'
  });
});
```

> **대안 검토**: 렌더러 내에서 직접 마크다운 렌더링을 처리할 수도 있으나, `render-markdown` 이벤트 핸들러에는 마크다운 파싱, 사이드바 업데이트, 탭 관리, 제목 설정 등 다양한 부수 효과가 포함되어 있으므로, 기존 이벤트 플로우를 재사용하는 것이 안전하다.

**4단계: 렌더러 `onRenderMarkdown` 핸들러 수정**

`source === 'paste'`인 경우 `isMcpDocument = false`로 설정. 나머지 처리는 MCP content와 동일.

#### 2.4.4 출력

| 출력 | 대상 | 설명 |
|------|------|------|
| 렌더링된 마크다운 | 렌더러 UI | 빈 페이지 → 렌더링된 콘텐츠로 교체 |
| 상태 변수 설정 | 렌더러 | `originalContent`, `currentFilePath`, `isMcpDocument` 설정 |

#### 2.4.5 예외

| 조건 | 처리 |
|------|------|
| 빈 페이지가 아닌 상태에서 Ctrl+V | `isEmpty` 체크로 무시. 기존 브라우저 동작 유지 |
| 클립보드가 비어있거나 공백만 있는 경우 | `!text.trim()` → 무시 |
| 클립보드에 이미지/파일만 있는 경우 | `getData('text/plain')` → `null` 또는 빈 문자열 → 무시 |
| `input`/`textarea`에 포커스 중 | activeElement 체크 → 무시 (검색바에서의 붙여넣기 보호) |
| 탭 모드에서 빈 탭 | 빈 탭도 `.empty-state`를 가지므로 정상 동작 |
| 아주 큰 텍스트 붙여넣기 (수 MB) | 기존 `render-markdown` 핸들러의 대용량 문서 경고(`largeDocWarning`) 로직에 위임 |

---

## 3. 데이터 요구사항

### 3.1 electron-store 설정 변경

| 설정 | 타입 | 기본값 | 변경사항 | 설명 |
|------|------|--------|----------|------|
| `mcpAutoSave` | boolean | `false` | **의미 변경**: 자동 저장만 제어 (수동 저장과 무관) | MCP 문서 자동 저장 ON/OFF |
| `mcpAutoSavePath` | string | `''` | **역할 확장**: 자동 저장과 수동 저장 모두의 기본 경로 | MCP 문서 저장 기본 디렉토리 |
| `mcpSaveSubDir` | string | `''` | **신규** | 서브디렉토리 포맷 문자열 |

### 3.2 렌더러 상태 변수 (신규/변경)

| 변수 | 타입 | 설명 | 변경사항 |
|------|------|------|----------|
| `isMcpDocument` | boolean | MCP를 통해 열린 문서 여부 | **신규** |
| `saveAsFilePath` | `string\|null` | Save As로 저장한 파일 경로 | **신규** |
| `mcpAutoSaveEnabled` | boolean | 설정의 `mcpAutoSave` 값 | **신규** |
| `currentProject` | `string\|null` | 현재 문서의 프로젝트 이름 | **신규** (MCP 호출 시 전달받은 project 값) |

### 3.3 `render-markdown` 이벤트 데이터 확장

| 필드 | 타입 | 설명 | 변경사항 |
|------|------|------|----------|
| `source` | `string\|undefined` | 문서 출처 (`'mcp'`, `'paste'`, `undefined`) | **신규** |
| `mcpAutoSave` | `boolean\|undefined` | 현재 자동 저장 설정 | **신규** |
| `project` | `string\|undefined` | 프로젝트 이름 (MCP 호출 시) | **신규** |

---

## 4. 인터페이스 요구사항

### 4.1 IPC 핸들러 (신규)

| 채널 | 방식 | 파라미터 | 반환 | 설명 |
|------|------|----------|------|------|
| `mcp-manual-save` | invoke | `{ content?, filePath?, title?, project? }` | `{ success, filePath? }` 또는 `{ success: false, errorKey, errorDetail? }` | MCP 문서 수동 저장 |
| `open-directory` | invoke | `dirPath: string` | void | 디렉토리를 파일 탐색기에서 열기 |
| `render-pasted-content` | invoke | `content: string` | void | 붙여넣기 텍스트 렌더링 요청 |

### 4.2 Preload API (신규)

| API | 시그니처 | 설명 |
|-----|----------|------|
| `mcpManualSave(params)` | `({content?, filePath?, title?, project?}) => Promise<{success, filePath?, errorKey?}>` | MCP 문서 수동 저장 |
| `openDirectory(dirPath)` | `(string) => Promise<void>` | 디렉토리를 파일 탐색기에서 열기 |
| `renderPastedContent(content)` | `(string) => Promise<void>` | 붙여넣기 텍스트 렌더링 |

### 4.3 컨텍스트 메뉴 변경

**뷰어 컨텍스트 메뉴 변경 후 순서** (MCP 문서 + 자동 저장 OFF 기준):

1. Copy (선택 텍스트 있을 때)
2. New Tab (탭 활성 시)
3. Select All
4. Select Block Text (코드 블록 내)
5. ── 구분선 ──
6. 경로 복사 (Ctrl+Shift+C)  ← **조건 확장**: `getCopyablePath()` 결과 있으면 활성
7. 파일 탐색기 열기
8. ── 구분선 ──
9. **저장 (Ctrl+S)** ← 신규 (MCP + 자동 저장 OFF일 때만)
10. 다른 이름으로 저장... (Ctrl+Shift+S)
11. ── 구분선 ── (savedFilePath 있을 때만)
12. 저장된 파일 삭제 (Ctrl+Alt+D) (savedFilePath 있을 때만)
13. ── 구분선 ──
14. PDF 내보내기 (Ctrl+P)
15. 닫기 (Ctrl+W)

**사이드바 컨텍스트 메뉴 (신규):**

1. 경로 복사
2. 파일 탐색기에서 열기

### 4.4 키보드 단축키 (신규)

| 단축키 | macOS | 동작 | 충돌 검사 |
|--------|-------|------|----------|
| `Ctrl+S` | `Cmd+S` | MCP 문서 수동 저장 | 기존에 사용되지 않음 — 충돌 없음 |
| `Ctrl+Shift+C` | `Cmd+Shift+C` | 경로 복사 | 기존에 사용되지 않음 — 충돌 없음. `Ctrl+C`(텍스트 복사)와 키 조합 상이 |

> **참고**: `Ctrl+V` (붙여넣기)는 기존 브라우저 기본 동작이므로 별도 등록 불필요. `paste` 이벤트 리스너로 처리.

### 4.5 설정 UI 변경

**기존 구조:**

```
[체크박스] MCP 자동 저장
  MCP로 열린 파일을 자동으로 저장
[경로 입력] [찾아보기]
```

**변경 후 구조:**

```
[섹션 레이블] MCP로 불러온 문서 저장
[체크박스] 자동 저장
  MCP로 열린 파일을 자동으로 디스크에 저장
[경로 입력] [찾아보기]
[서브디렉토리 포맷 입력] [?]
```

- 체크박스 OFF 시에도 경로 입력과 포맷 입력은 활성 상태 유지
- `[?]` 버튼 클릭 시 포매터 설명 팝업 표시

---

## 5. 비기능 요구사항

### 5.1 성능

| 요구사항 | 기준 |
|----------|------|
| 수동 저장 지연시간 | < 200ms (로컬 디스크 쓰기 기준) |
| 사이드바 컨텍스트 메뉴 표시 | < 50ms |
| MD 붙여넣기 렌더링 | 기존 `render-markdown` 성능과 동일 |
| 포매터 토큰 해석 | < 1ms (문자열 치환) |

### 5.2 하위 호환성

| 요구사항 | 기준 |
|----------|------|
| 기존 `mcpAutoSave=true` 사용자 | `mcpSaveSubDir` 기본값 `''` → 서브디렉토리 없이 저장. **주의**: 기존과 다르게 `YYYY-MM-DD` 폴더가 생성되지 않음 |
| 기존 자동 저장 파일 | 이미 저장된 파일은 영향 없음. 향후 저장분부터 새 경로 규칙 적용 |
| `saveMcpFile()` API | 기존 파라미터 호환 유지. `project` 파라미터 추가 (선택적, undefined 허용) |
| 기존 Ctrl+V 동작 | 빈 페이지가 아닌 경우 기존 브라우저 동작 유지 |

> **마이그레이션 안내**: 기존에 `YYYY-MM-DD` 서브디렉토리를 사용하던 사용자는 포매터에 `{yyyy-mm-dd}`를 입력하면 동일한 동작을 복원할 수 있다. 최초 설정 화면에 마이그레이션 힌트 표시를 고려할 수 있으나, 본 SRS 범위에는 포함하지 않는다.

### 5.3 에러 처리

| 요구사항 | 기준 |
|----------|------|
| 수동 저장 에러 | 에러 토스트 분홍색 텍스트 + 다국어 에러 메시지 |
| 클립보드 접근 에러 | `catch`로 로깅, 사용자 피드백 없음 (브라우저 보안 정책) |
| 포매터 파싱 에러 | 발생하지 않음 (미인식 토큰은 리터럴로 처리) |

---

## 6. 제약사항

| 제약 | 내용 |
|------|------|
| Main process CJS | `mcp-save.js`, `index.js`, `preload.js`는 CommonJS |
| Renderer sandbox | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — `path.sep` 등 Node.js API 사용 불가 |
| 클립보드 읽기 권한 | `paste` 이벤트의 `clipboardData`는 이벤트 핸들러 내에서만 접근 가능 (비동기 `navigator.clipboard.readText()` 불필요) |
| i18n 동기화 | 4개 로케일(ko, en, ja, es) 모두 동일 키 추가 필요 |
| 커스텀 컨텍스트 메뉴 | Electron Menu API 미사용, HTML 기반 구현 |
| 기존 단축키 충돌 방지 | Ctrl+B, Ctrl+F, Ctrl+P, Ctrl+W, Ctrl+Shift+F, Ctrl+T, Ctrl+Shift+S, Ctrl+Alt+S, Ctrl+Alt+D 등과 충돌 없어야 함 |

---

## 7. 구현 가이드

### 7.1 변경 파일 목록

| 파일 | 변경 유형 | 주요 내용 |
|------|----------|----------|
| `src/main/mcp-save.js` | 수정(대폭) | `resolveSubDir()` 함수 추가; `saveMcpFile()` 날짜 서브폴더 로직 제거 → 포매터 기반으로 교체; `mcpManualSave()` 함수 추가; `project` 파라미터 지원 |
| `src/main/index.js` | 수정 | `mcp-manual-save`, `open-directory`, `render-pasted-content` IPC 핸들러 추가; `open_markdown` 핸들러에서 `render-markdown` 이벤트에 `source: 'mcp'`, `mcpAutoSave`, `project` 필드 추가; `mcpSaveSubDir` 설정 스키마 추가 |
| `src/main/preload.js` | 수정 | `mcpManualSave()`, `openDirectory()`, `renderPastedContent()` IPC 브릿지 추가 |
| `src/renderer/viewer.js` | 수정(대폭) | `isMcpDocument`, `saveAsFilePath`, `mcpAutoSaveEnabled`, `currentProject` 상태 변수 추가; `handleMcpSave()`, `showViewerToastError()`, `showSidebarContextMenu()`, `getCopyablePath()` 함수 추가; `showContextMenu()` 경로 복사 조건 확장 + "저장" 항목 추가; `Ctrl+S`, `Ctrl+Shift+C` 단축키 등록; `paste` 이벤트 리스너 추가; `renderTreeNode()` contextmenu 리스너 추가 |
| `src/renderer/viewer.css` | 수정 | `.viewer-toast-error` 스타일 추가 |
| `src/renderer/settings.html` | 수정 | 레이블 변경; 서브디렉토리 포맷 입력창 + (?) 버튼 추가; 도움말 팝업 마크업 |
| `src/renderer/settings.js` | 수정 | `mcpSaveSubDir` 설정 로드/저장; 도움말 팝업 열기/닫기; 경로 그룹 항상 표시 |
| `src/locales/ko.json` | 수정 | 15개 i18n 키 추가/변경 |
| `src/locales/en.json` | 수정 | 15개 i18n 키 추가/변경 |
| `src/locales/ja.json` | 수정 | 15개 i18n 키 추가/변경 |
| `src/locales/es.json` | 수정 | 15개 i18n 키 추가/변경 |

### 7.2 i18n 키

**변경 키:**

| 키 | ko | en | ja | es |
|----|----|----|----|----|
| `settings.mcpAutoSave` | MCP로 불러온 문서 저장 | Save Documents from MCP | MCPから読み込んだ文書の保存 | Guardar documentos de MCP |
| `settings.mcpAutoSaveHint` | MCP로 열린 파일을 자동으로 디스크에 저장 | Auto-save files opened via MCP to disk | MCPで開いたファイルを自動的にディスクに保存 | Guardar automáticamente archivos abiertos por MCP |

**신규 키:**

| 키 | ko | en | ja | es | 용도 |
|----|----|----|----|----|------|
| `settings.mcpSaveSubDirPlaceholder` | 서브디렉토리 포맷 (예: {yyyy-mm-dd}) | Subdirectory format (e.g. {yyyy-mm-dd}) | サブディレクトリ形式 (例: {yyyy-mm-dd}) | Formato de subdirectorio (ej: {yyyy-mm-dd}) | 포매터 입력 플레이스홀더 |
| `settings.mcpSaveSubDirHelp` | 포맷 도움말 | Format help | フォーマットヘルプ | Ayuda de formato | (?) 버튼 title |
| `settings.mcpSaveSubDirHelpContent` | *(긴 도움말 텍스트 — A-4 섹션 참조)* | *(영문 번역)* | *(일본어 번역)* | *(스페인어 번역)* | 도움말 팝업 본문 |
| `viewer.save` | 저장 | Save | 保存 | Guardar | 컨텍스트 메뉴 항목 |
| `viewer.saveErrorNoDir` | 저장 경로가 설정되지 않았습니다 | Save directory is not configured | 保存先が設定されていません | El directorio de guardado no está configurado | 에러 토스트 |
| `viewer.saveErrorPermission` | 저장 경로에 대한 쓰기 권한이 없습니다 | No write permission for the save directory | 保存先への書き込み権限がありません | No tiene permiso de escritura en el directorio | 에러 토스트 |
| `viewer.saveErrorGeneric` | 저장 실패 | Save failed | 保存に失敗しました | Error al guardar | 에러 토스트 접두사 |
| `viewer.pathCopied` | 경로가 복사되었습니다 | Path copied | パスがコピーされました | Ruta copiada | 토스트 |
| `viewer.saveFirstToCopyPath` | 먼저 문서를 저장해주세요 | Please save the document first | 先にドキュメントを保存してください | Guarde el documento primero | 토스트 |
| `viewer.pastedContent` | 붙여넣기됨 | Pasted | 貼り付けました | Pegado | 토스트 (선택적) |
| `settings.mcpSaveSubDirHelpTitle` | 서브디렉토리 포맷 도움말 | Subdirectory Format Help | サブディレクトリフォーマットヘルプ | Ayuda de formato de subdirectorio | 도움말 팝업 제목 |
| `settings.mcpAutoSaveCheckbox` | 자동 저장 | Auto-save | 自動保存 | Guardado automático | 체크박스 레이블 (명확화) |

---

## 8. 인수 조건

### AC-22-001: 설정 UI 레이블 변경

- **Given**: DocLight 설정 창 열기
- **When**: MCP 저장 섹션 확인
- **Then**: 섹션 레이블이 "MCP로 불러온 문서 저장"으로 표시됨

### AC-22-002: 자동 저장 OFF에서 경로 설정 가능

- **Given**: 설정 창에서 자동 저장 체크박스 OFF
- **When**: 저장 경로 입력란과 찾아보기 버튼 확인
- **Then**: 경로 입력란과 찾아보기 버튼이 활성 상태 (기존: 숨김 → 변경: 항상 표시)

### AC-22-003: 수동 저장 (Ctrl+S) 성공

- **Given**: `mcpAutoSave = false`, `mcpAutoSavePath = "D:\docs"`, MCP `open_markdown { content: "# Test" }` 호출
- **When**: 뷰어에서 Ctrl+S 누르기
- **Then**: `D:\docs\HHMMSS_Test.md` 파일 생성됨; "저장되었습니다: D:\docs\HHMMSS_Test.md" 토스트 표시

### AC-22-004: 수동 저장 컨텍스트 메뉴

- **Given**: `mcpAutoSave = false`, MCP 문서 열림
- **When**: 뷰어 우클릭
- **Then**: "저장 (Ctrl+S)" 메뉴 항목 표시됨

### AC-22-005: 수동 저장 — 경로 미설정 에러

- **Given**: `mcpAutoSavePath = ''` (빈 문자열), MCP 문서 열림
- **When**: Ctrl+S
- **Then**: 분홍색 에러 토스트: "저장 경로가 설정되지 않았습니다"

### AC-22-006: 수동 저장 — 권한 에러

- **Given**: `mcpAutoSavePath = "C:\Windows\System32\test"` (쓰기 불가), MCP 문서 열림
- **When**: Ctrl+S
- **Then**: 분홍색 에러 토스트: "저장 경로에 대한 쓰기 권한이 없습니다"

### AC-22-007: 디렉토리 포매터 적용

- **Given**: `mcpAutoSave = true`, `mcpAutoSavePath = "D:\docs"`, `mcpSaveSubDir = "{yyyy-mm-dd}"`
- **When**: MCP `open_markdown { content: "# Test" }` 호출 (날짜: 2026-03-17)
- **Then**: `D:\docs\2026-03-17\HHMMSS_Test.md` 파일 생성됨

### AC-22-008: 포매터 — project 토큰

- **Given**: `mcpSaveSubDir = "{project}/{yyyy-mm-dd}"`, MCP 호출 시 project = "MyApp"
- **When**: 자동 저장 실행
- **Then**: `{basePath}\MyApp\2026-03-17\HHMMSS_파일명.md` 생성됨

### AC-22-009: 포매터 빈 문자열 — 서브디렉토리 없음

- **Given**: `mcpSaveSubDir = ''` (기본값)
- **When**: 자동 저장 실행
- **Then**: `{basePath}\HHMMSS_파일명.md` 생성됨 (기존 `YYYY-MM-DD` 서브폴더 없음)

### AC-22-010: 포매터 (?) 도움말 팝업

- **Given**: 설정 창의 서브디렉토리 포맷 입력란
- **When**: (?) 버튼 클릭
- **Then**: 포매터 토큰 설명과 예시가 포함된 팝업 표시됨; Escape 또는 외부 클릭으로 닫힘

### AC-22-011: 사이드바 파일 항목 경로 복사

- **Given**: 사이드바에 파일 목록이 표시된 상태
- **When**: 파일 항목 우클릭 → "경로 복사" 클릭
- **Then**: 해당 파일의 절대 경로가 클립보드에 복사됨; "경로가 복사되었습니다" 토스트

### AC-22-012: 사이드바 디렉토리 파일 탐색기 열기

- **Given**: 사이드바에 디렉토리 항목이 표시된 상태
- **When**: 디렉토리 항목 우클릭 → "파일 탐색기에서 열기" 클릭
- **Then**: OS 파일 탐색기가 해당 디렉토리를 열림

### AC-22-013: 뷰어 경로 복사 — MCP 저장 파일

- **Given**: MCP 문서가 수동/자동 저장된 상태 (`savedFilePath` 존재)
- **When**: Ctrl+Shift+C
- **Then**: `savedFilePath`가 클립보드에 복사됨; "경로가 복사되었습니다" 토스트

### AC-22-014: 뷰어 경로 복사 — 미저장 MCP 문서

- **Given**: MCP 문서가 열렸으나 저장되지 않은 상태
- **When**: Ctrl+Shift+C
- **Then**: "먼저 문서를 저장해주세요" 토스트

### AC-22-015: 뷰어 경로 복사 — Save As 후

- **Given**: MCP 문서를 Save As로 `D:\export\report.md`에 저장
- **When**: Ctrl+Shift+C
- **Then**: `D:\export\report.md` (Save As 경로)가 클립보드에 복사됨

### AC-22-016: MD 텍스트 붙여넣기 — 빈 페이지

- **Given**: 빈 뷰어 (drop zone 표시)
- **When**: 클립보드에 `"# Hello\n\nWorld"` 텍스트가 있는 상태에서 Ctrl+V
- **Then**: 마크다운이 렌더링됨 (H1 "Hello", p "World"); drop zone 사라짐

### AC-22-017: MD 텍스트 붙여넣기 — 기존 콘텐츠 있는 페이지

- **Given**: 뷰어에 마크다운이 이미 렌더링된 상태
- **When**: Ctrl+V
- **Then**: 아무 동작 없음 (기존 브라우저 기본 동작 유지)

### AC-22-018: 포매터 세퍼레이터 OS 변환

- **Given**: Windows OS, `mcpSaveSubDir = "{project}/{yyyy-mm-dd}"`
- **When**: 저장 실행
- **Then**: 실제 경로에서 `\`(백슬래시)가 사용됨: `basePath\MyApp\2026-03-17\file.md`

### AC-22-019: 비-MCP 문서에서 Ctrl+S 무시

- **Given**: 로컬 `.md` 파일을 드래그앤드롭으로 열기
- **When**: Ctrl+S
- **Then**: 아무 동작 없음 (MCP 문서가 아니므로 무시)

### AC-22-020: 토스트 에러 메시지 다국어

- **Given**: 로케일 = `en`, 저장 경로 미설정
- **When**: MCP 문서에서 Ctrl+S
- **Then**: 분홍색 토스트: "Save directory is not configured"

### AC-22-021: 부모 디렉토리 자동 생성

- **Given**: `mcpAutoSavePath = "D:\docs"`, `mcpSaveSubDir = "{yyyy}/{mm}/{dd}"`
- **When**: 저장 실행 (2026-03-17, `D:\docs\2026\03\17\` 미존재)
- **Then**: `D:\docs\2026\03\17\` 디렉토리가 자동 생성되고 파일 저장됨

### AC-22-022: 빈 페이지 검색바에서 붙여넣기

- **Given**: 빈 페이지, 검색바(Find bar)가 열린 상태, 검색 입력란에 포커스
- **When**: Ctrl+V
- **Then**: 검색 입력란에 텍스트가 붙여넣기됨 (빈 페이지 렌더링 아님)

---

## 부록: 전문가 평가 요약

### 라운드 1 평가 결과 (개선 전)

| 기준 | 기술 아키텍트 | QA 전문가 | 비즈니스 분석가 |
|------|-------------|-----------|----------------|
| 요구사항 완전성 | B+ | B+ | B+ |
| 구현 명확성 | A | B | A |
| 이전 버전 일관성 | B+ | A | B+ |
| IPC/API 설계 일관성 | A | B+ | B+ |
| 에러 처리 완전성 | B+ | B | B |
| UX 일관성 | A | B+ | B+ |
| 인수 조건 커버리지 | B+ | B | B+ |

### 라운드 1 주요 지적 사항 및 반영 내역

| 지적 사항 | 지적자 | 반영 내역 |
|----------|--------|----------|
| `isMcpDocument` 설정 시점 불명확 — `render-markdown` 이벤트에 `source` 필드 없음 | 아키텍트 | `open_markdown` 핸들러에서 `source: 'mcp'` 추가 명시 (FR-22-001 D-2) |
| 기존 `YYYY-MM-DD` 서브폴더 사용자 마이그레이션 경로 없음 | BA | 섹션 5.2에 마이그레이션 안내 추가 |
| `Ctrl+S`가 비-MCP 문서에서도 동작하면 혼란 | QA | FR-22-001 D-5에서 `isMcpDocument` 체크 명시, AC-22-019 추가 |
| `paste` 이벤트에서 `input`/`textarea` 포커스 시 동작하면 검색바 방해 | QA | FR-22-004에 activeElement 체크 추가, AC-22-022 추가 |
| `mcpManualSave()` 에러 시 시스템 에러 메시지를 직접 표시하면 사용자 혼란 | BA | 에러 키 기반 다국어 메시지 + 선택적 `errorDetail` 조합으로 변경 |
| 사이드바 `node.exists === false` 항목에서 "파일 탐색기 열기" 동작 불명 | QA | FR-22-002 예외에 `disabled` 처리 명시 |
| `showViewerToastError()` CSS 분홍색 정확한 컬러값 미명시 | 아키텍트 | `#e91e63` (Material Design Pink 500) 명시 |
| 포매터 `{MM}`과 `{mm}` 혼동 가능성 (분 vs 월) | BA | 토큰 정의에서 `{mm}` = 월, `{MM}` = 분으로 명확히 구분. 도움말 팝업에 명시 |
| `render-pasted-content` IPC가 불필요하게 왕복 — 렌더러에서 직접 처리 가능 | 아키텍트 | 기존 `render-markdown` 이벤트 핸들러의 부수 효과(사이드바, 탭, 제목) 재사용을 위해 IPC 유지. 대안 검토 결과 기록 추가 |
| `saveAsFilePath` 우선순위와 `savedFilePath` 관계 모호 | QA | FR-22-003에 `getCopyablePath()` 우선순위 명시: currentFilePath > saveAsFilePath > savedFilePath |
| 빈 페이지 붙여넣기 후 `isMcpDocument = false` — 수동 저장(Ctrl+S) 불가 | BA | 설계 결정에 "붙여넣기는 MCP 문서가 아님" 명시. Save As(Ctrl+Shift+S)로 저장 가능 |

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
