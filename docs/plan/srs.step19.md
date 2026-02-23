# SRS: DocLight — Step 19 (병렬 알람·보고 환경 지원)

## 메타데이터

| 항목 | 내용 |
|------|------|
| 버전 | step19 |
| 생성일 | 2026-02-23 |
| 이전 버전 | docs/plan/srs.step18.md (step18) |
| 성격 | **증분 확장** — 병렬 알람·보고 환경에서의 사용성을 높이는 7개 신규 기능 추가 |
| 평가 라운드 | 17 |

---

## 1. 개요

### 1.1 목적

본 SRS는 DocLight Electron Markdown 뷰어의 Step 19 기능 확장을 정의한다.
DocLight를 AI 에이전트가 알람·보고서·진행 상황을 병렬로 표시하는 환경에 최적화하기 위해
Named Window(upsert), Append 모드, Severity 테마, Auto-close 타이머, Window 태그,
Taskbar 플래시, Progress Bar 등 7개 기능을 추가한다.

### 1.2 범위

**본 SRS가 커버하는 범위:**

- FR-19-001: Named Window — 이름 기반 창 관리 (upsert 패턴)
- FR-19-002: Append 모드 — 기존 콘텐츠에 내용 추가
- FR-19-003: Severity 테마 — 창 상단 색상 바로 심각도 표시
- FR-19-004: Auto-close 타이머 — 지정 시간 후 자동 창 닫기
- FR-19-005: Window 태그 — 창 그룹화 및 일괄 조작
- FR-19-006: Taskbar 플래시 — 비포그라운드 창 주의 유도
- FR-19-007: Progress Bar — 창 타이틀바/태스크바 진행률 표시

**본 SRS가 커버하지 않는 범위:**

- 기존 MCP 도구의 기본 동작 변경
- 알림음(소리) 출력
- 운영체제 네이티브 토스트 알림
- 창 간 메시지 릴레이

### 1.3 이전 버전 대비 변경사항

| 항목 | step18 (이전) | step19 (현재) |
|------|---------------|---------------|
| 창 식별 | windowId(숫자) 만 지원 | windowName(문자열) 추가 — upsert 가능 |
| 콘텐츠 갱신 | 전체 교체만 | append 모드 추가 |
| 창 상태 표현 | 없음 | severity(error/warning/info/success) 색상 바 |
| 수명 관리 | 수동 닫기 | autoCloseSeconds 타이머 |
| 창 그룹화 | 없음 | tags 배열 + tag 기반 일괄 조작 |
| 주의 유도 | 없음 | flashFrame (비포그라운드 시) |
| 진행률 표시 | 없음 | win.setProgressBar() |

### 1.4 현재 시스템 상태

Step 19 시작 시점의 DocLight 시스템 상태:

| 구성요소 | 현재 상태 |
|----------|----------|
| Electron 메인 프로세스 | `src/main/index.js` — CJS, 시스템 트레이 상주, IPC 소켓 서버 |
| 윈도우 매니저 | `src/main/window-manager.js` — 다중 창 관리, 네비게이션 히스토리 |
| WindowEntry.meta | windowId, title, filePath, alwaysOnTop, tabs 등 |
| MCP 서버 (stdio) | `src/main/mcp-server.mjs` — ESM, IPC 소켓 브릿지 |
| MCP 서버 (HTTP) | `src/main/mcp-http.mjs` — ESM, JSON-RPC 2.0 |
| 렌더러 | `src/renderer/viewer.js` — marked + DOMPurify + highlight.js + Mermaid |
| i18n | 4개 로케일 (en, ko, ja, es) |
| 설정 | electron-store: mcpAutoSave, mcpAutoSavePath 포함 |

### 1.5 구현 우선순위

| 순서 | 기능 | 난이도 | 이유 |
|------|------|--------|------|
| 1 | FR-19-001 Named Window | 낮음 | WindowManager Map 추가, 다른 기능의 기반 |
| 2 | FR-19-003 Severity 테마 | 낮음 | CSS + data-attribute, 독립적 |
| 3 | FR-19-006 Taskbar 플래시 | 낮음 | win.flashFrame() 단순 래핑 |
| 4 | FR-19-007 Progress Bar | 낮음 | win.setProgressBar() 단순 래핑 |
| 5 | FR-19-005 Window 태그 | 중간 | Named Window 완료 후 구현 |
| 6 | FR-19-004 Auto-close 타이머 | 중간 | setTimeout 관리, 렌더러 카운트다운 |
| 7 | FR-19-002 Append 모드 | 중간 | lastRenderedContent 상태 관리 복잡 |

---

## 2. 기능 요구사항

---

### FR-19-001: Named Window (이름 기반 창 관리)

#### 2.1.1 설명

`open_markdown` 호출 시 `windowName` 파라미터를 지정하면, 동일 이름의 창이 이미 열려 있을 경우 새 창을 열지 않고 기존 창을 업데이트(upsert)한다. 이름이 없거나 기존 창이 없으면 새 창을 생성한다.

#### 2.1.2 입력

| 입력 | 출처 | 타입 | 필수 |
|------|------|------|------|
| windowName | MCP 파라미터 / IPC 파라미터 | string | 선택 |
| 나머지 파라미터 | 기존 open_markdown 동일 | — | 기존과 동일 |

#### 2.1.3 처리

1. `WindowManager`에 `nameToId: Map<string, number>` 추가
2. `open_markdown` 호출 시:
   - `windowName` 없음 → 기존 로직(항상 새 창 생성)
   - `windowName` 있음:
     - `nameToId.get(windowName)` 조회
     - 창이 존재하고 소멸되지 않았으면 → `updateWindow()` 호출 (upsert)
     - 창이 없거나 소멸됨 → 새 창 생성 후 `nameToId.set(windowName, windowId)`
3. 창이 닫힐 때 해당 `windowName` 매핑 제거
4. `entry.meta.windowName` 에 이름 저장

#### 2.1.4 출력

| 경우 | 응답 내용 |
|------|----------|
| 신규 생성 | `"Opened viewer window.\n  windowId: X\n  windowName: <name>\n  title: ..."` |
| 기존 창 업데이트 | `"Updated existing window (named: <name>).\n  windowId: X\n  title: ..."` |

#### 2.1.5 예외

| 조건 | 처리 |
|------|------|
| windowName 빈 문자열 | 이름 없는 것으로 간주, 새 창 생성 |
| windowName 최대 길이 초과 (256자) | isError 응답 반환 |

---

### FR-19-002: Append 모드

#### 2.2.1 설명

`update_markdown` 호출 시 `appendMode: true`를 지정하면 창의 기존 콘텐츠 뒤에 새 콘텐츠를 이어 붙인다. 로그 스트리밍·보고서 누적 시나리오에 사용한다.

#### 2.2.2 입력

| 입력 | 출처 | 타입 | 필수 |
|------|------|------|------|
| windowId | MCP 파라미터 | string/number | 필수 |
| content | MCP 파라미터 | string | 필수 (appendMode 사용 시) |
| appendMode | MCP 파라미터 | boolean | 선택 (기본 false) |
| separator | MCP 파라미터 | string | 선택 (기본 `"\n\n"`) |

#### 2.2.3 처리

1. `entry.meta.lastRenderedContent` 에 현재 창의 원시 Markdown 콘텐츠를 저장
2. `appendMode: true` 이고 `content` 가 제공된 경우:
   - `newContent = (lastRenderedContent || '') + separator + content`
   - `updateWindow(windowId, { content: newContent })` 호출
3. `appendMode: true` 이고 `filePath` 가 제공된 경우 → isError 반환 (filePath 창은 append 불가)
4. `appendMode: false` (기본) → 기존 전체 교체 동작 유지

#### 2.2.4 출력

| 경우 | 응답 내용 |
|------|----------|
| 성공 | `"Appended to window X.\n  title: ..."` |
| filePath 창에 append 시도 | `isError: true`, `"appendMode is not supported for file-based windows."` |
| 창 없음 | 기존 windowNotFound 에러와 동일 |

#### 2.2.5 예외

| 조건 | 처리 |
|------|------|
| lastRenderedContent 없음 | 빈 문자열로 간주 (첫 append = content 자체) |
| 누적 콘텐츠 10MB 초과 | isError 반환, 기존 콘텐츠 보존 |

---

### FR-19-003: Severity 테마

#### 2.3.1 설명

`open_markdown` 또는 `update_markdown` 시 `severity` 파라미터를 지정하면 창 상단에 4px 색상 바를 표시하여 심각도를 시각적으로 나타낸다.

#### 2.3.2 입력

| 입력 | 출처 | 타입 | 값 | 필수 |
|------|------|------|-----|------|
| severity | MCP 파라미터 | string enum | `error`, `warning`, `info`, `success` | 선택 |

#### 2.3.3 처리

1. IPC / HTTP 핸들러에서 `severity` 수신
2. `entry.win.webContents.send('set-severity', { severity })` 전송
3. 렌더러에서 `<body>` 또는 최상위 컨테이너에 `data-severity="<value>"` 속성 설정
4. CSS에서 `[data-severity]` 선택자로 상단 바 색상 적용:
   - `error` → `#ef4444` (빨강)
   - `warning` → `#f59e0b` (주황)
   - `info` → `#3b82f6` (파랑)``
   - `success` → `#22c55e` (초록)
5. `entry.meta.severity` 에 저장

#### 2.3.4 출력

- 창 콘텐츠 영역 상단에 4px 높이 가로 색상 바 표시
- `list_viewers` 결과에 severity 포함: `[win-id] "title" (severity: error)`

#### 2.3.5 예외

| 조건 | 처리 |
|------|------|
| 유효하지 않은 severity 값 | isError 반환 |
| severity 미지정 또는 null | 색상 바 숨김 (data-severity 속성 제거) |

---

### FR-19-004: Auto-close 타이머

#### 2.4.1 설명

`open_markdown` 시 `autoCloseSeconds` 파라미터를 지정하면 지정 시간(초) 후 해당 창을 자동으로 닫는다. 창 하단에 남은 시간 카운트다운을 표시한다.

#### 2.4.2 입력

| 입력 | 출처 | 타입 | 범위 | 필수 |
|------|------|------|------|------|
| autoCloseSeconds | MCP 파라미터 | number (정수) | 1 ~ 3600 | 선택 |

#### 2.4.3 처리

1. `autoCloseSeconds` 수신 시 `setTimeout(() => closeWindow(windowId), autoCloseSeconds * 1000)` 등록
2. 타이머 핸들을 `entry.meta.autoCloseTimer`에 저장
3. 창이 수동으로 닫힐 경우 `clearTimeout(entry.meta.autoCloseTimer)` 실행 (타이머 누수 방지)
4. 렌더러에 `auto-close-start` IPC 이벤트 전송 (`{ seconds: autoCloseSeconds }`)
5. 렌더러는 1초마다 카운트다운을 업데이트하여 하단 상태 바에 `"자동 종료: N초"` 표시
6. 남은 시간 5초 이내 시 상태 바 배경색을 주황으로 강조

#### 2.4.4 출력

- 창 하단 상태 바에 `"자동 종료: N초"` 텍스트 표시
- 타이머 만료 시 창 자동 닫힘

#### 2.4.5 예외

| 조건 | 처리 |
|------|------|
| autoCloseSeconds < 1 또는 > 3600 | isError 반환 |
| autoCloseSeconds 비정수 | 소수점 버림(Math.floor) |
| update_markdown으로 타이머 갱신 | 기존 타이머 clear 후 새 타이머 등록 |

---

### FR-19-005: Window 태그

#### 2.5.1 설명

창에 태그 목록을 부여하여 그룹화하고, 태그 기반으로 창 목록 조회 및 일괄 닫기를 지원한다.

#### 2.5.2 입력

| 입력 | 출처 | 타입 | 범위 | 필수 |
|------|------|------|------|------|
| tags | open_markdown / update_markdown 파라미터 | string[] | 최대 10개, 각 64자 이내 | 선택 |
| tag | list_viewers / close_viewer 파라미터 | string | — | 선택 |

#### 2.5.3 처리

1. `open_markdown` 시 `tags` 수신 → `entry.meta.tags = tags`
2. `update_markdown` 시 `tags` 수신 → 기존 태그 교체(전체 교체 방식)
3. `list_viewers` 시 `tag` 필터 파라미터 지원:
   - `tag` 없음 → 전체 창 목록 반환 (기존 동작)
   - `tag` 있음 → 해당 태그를 포함하는 창만 반환
4. `close_viewer` 시 `tag` 파라미터 지원:
   - `tag` 있고 `windowId` 없음 → 해당 태그를 가진 모든 창 닫기
   - `windowId` 있음 → 기존 단일 창 닫기 동작 유지


#### 2.5.4 출력

`list_viewers` 응답 예시:
```
Open viewer windows (2):
  1. [win-42] "오류 보고서" (severity: error) [tags: alarm, critical]
  2. [win-43] "진행 상황" (severity: info) [tags: progress]
```

#### 2.5.5 예외

| 조건 | 처리 |
|------|------|
| tags 10개 초과 | isError 반환 |
| 태그 항목 64자 초과 | isError 반환 |
| close_viewer 시 해당 tag를 가진 창이 없음 | `closed: 0` 정상 반환 |

---

### FR-19-006: Taskbar 플래시

#### 2.6.1 설명

`open_markdown` 또는 `update_markdown` 시 `flash: true`를 지정하면 해당 창이 포그라운드가 아닐 경우 태스크바/독 아이콘을 깜빡여 사용자 주의를 유도한다.

#### 2.6.2 입력

| 입력 | 출처 | 타입 | 필수 |
|------|------|------|------|
| flash | MCP 파라미터 | boolean | 선택 (기본 false) |

#### 2.6.3 처리

1. `flash: true` 수신 시:
   - `entry.win.isFocused()` 확인
   - 포그라운드(focused) 상태면 플래시 생략
   - 비포그라운드 상태면 `entry.win.flashFrame(true)` 호출
2. 창이 포커스를 얻으면 플래시 자동 중지 (Electron 기본 동작)
3. `flash: false` 또는 미지정 → 플래시 없음

#### 2.6.4 출력

- 비포그라운드 시 태스크바/독 아이콘 깜빡임 (OS 기본 동작)
- 이미 포그라운드이면 아무 동작 없음

#### 2.6.5 예외

| 조건 | 처리 |
|------|------|
| Linux에서 지원하지 않는 경우 | 에러 발생 시 catch 후 console.warn만 출력, MCP 응답은 정상 |

---

### FR-19-007: Progress Bar

#### 2.7.1 설명

`open_markdown` 또는 `update_markdown` 시 `progress` 파라미터를 지정하면 해당 창의 타이틀바 및 태스크바 아이콘에 진행률 바를 표시한다.

#### 2.7.2 입력

| 입력 | 출처 | 타입 | 범위 | 필수 |
|------|------|------|------|------|
| progress | MCP 파라미터 | number | 0.0 ~ 1.0, 또는 -1(제거) | 선택 |

#### 2.7.3 처리

1. `progress` 수신 시 `entry.win.setProgressBar(progress)` 호출
2. `progress === -1` → `setProgressBar(-1)` 호출하여 진행률 바 제거
3. `entry.meta.progress = progress` 저장

#### 2.7.4 출력

- `0.0 ~ 1.0`: 태스크바 아이콘에 진행률 바 표시 (0 = 0%, 1.0 = 100%)
- `-1`: 진행률 바 제거
- `list_viewers` 응답에 progress 포함 (0 이상인 경우):
  `[win-42] "다운로드 중" (progress: 75%)`

#### 2.7.5 예외

| 조건 | 처리 |
|------|------|
| 범위 초과 (< -1 또는 > 1.0) | isError 반환 |
| NaN / null | isError 반환 |

---

## 3. MCP API 변경 사항

### 3.1 open_markdown — 신규 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|----------|------|--------|------|
| windowName | string | — | 이름 기반 upsert |
| severity | `error` \| `warning` \| `info` \| `success` | — | 창 상단 색상 바 |
| autoCloseSeconds | integer (1~3600) | — | 자동 닫기 타이머 |
| tags | string[] (max 10) | — | 창 태그 |
| flash | boolean | false | 비포그라운드 시 태스크바 깜빡임 |
| progress | number (-1 or 0.0~1.0) | — | 진행률 바 |

### 3.2 update_markdown — 신규 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|----------|------|--------|------|
| appendMode | boolean | false | 기존 콘텐츠에 내용 추가 |
| separator | string | `"\n\n"` | append 시 구분자 |
| severity | `error` \| `warning` \| `info` \| `success` | — | severity 갱신 |
| tags | string[] (max 10) | — | 태그 전체 교체 |
| flash | boolean | false | 비포그라운드 시 깜빡임 |
| progress | number (-1 or 0.0~1.0) | — | 진행률 바 갱신 |
| autoCloseSeconds | integer (1~3600) | — | 타이머 재설정 |

### 3.3 close_viewer — 신규 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|----------|------|--------|------|
| tag | string | — | 해당 태그를 가진 모든 창 닫기 |

### 3.4 list_viewers — 신규 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|----------|------|--------|------|
| tag | string | — | 태그로 필터링 |

---

## 4. 데이터 요구사항

### 4.1 WindowEntry.meta 신규 필드

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `windowName` | string \| undefined | undefined | Named Window 식별자 |
| `tags` | string[] | `[]` | 창 태그 목록 |
| `severity` | string \| undefined | undefined | 현재 severity 값 |
| `autoCloseTimer` | ReturnType\<typeof setTimeout\> \| undefined | undefined | 자동 닫기 타이머 핸들 |
| `progress` | number \| undefined | undefined | 현재 진행률 (-1 ~ 1.0) |
| `lastRenderedContent` | string \| undefined | undefined | append 모드용 최신 콘텐츠 |

### 4.2 WindowManager 신규 상태

| 속성 | 타입 | 설명 |
|------|------|------|
| `nameToId` | `Map<string, number>` | windowName → BrowserWindow ID 매핑 |

---

## 5. 비기능 요구사항

### 5.1 성능

| 요구사항 | 기준 |
|----------|------|
| Named Window upsert 응답 | 기존 open_markdown 대비 추가 지연 < 5ms |
| Append 모드 (1MB 누적) | 렌더링 완료 < 2s |
| Progress Bar 갱신 | setProgressBar() 호출 후 태스크바 반영 < 100ms |

### 5.2 신뢰성

| 요구사항 | 기준 |
|----------|------|
| autoCloseTimer 누수 | 창 닫힘 시 반드시 clearTimeout 실행 |
| nameToId 일관성 | 창 소멸 이벤트 시 Map에서 즉시 제거 |
| Append 콘텐츠 보존 | 앱 비정상 종료 시 lastRenderedContent 손실 허용 (in-memory) |

### 5.3 보안

- `tags`, `windowName`, `severity`, `separator`는 렌더러로 직접 전달 전 DOMPurify/IPC 검증 통과
- `separator`에 `<script>` 등 HTML 인젝션 방지 — 렌더러에서 DOMPurify 통해 처리

---

## 6. 제약사항

| 제약 | 내용 |
|------|------|
| `flashFrame` | Windows / macOS 지원. Linux는 지원 여부 환경에 따라 상이 — 실패 시 무시 |
| `setProgressBar` | Windows(태스크바 오버레이), macOS(독 배지), Linux(일부 데스크톱 환경) |
| `lastRenderedContent` | in-memory 저장 — 앱 재시작 시 초기화 |
| `autoCloseSeconds` 최대값 | 3600초(1시간) — 장기 실행 창은 수동 관리 권장 |
| Append 최대 누적 크기 | 10MB — 초과 시 append 거부 |
| `windowName` 최대 길이 | 256자 |

---

## 7. 구현 가이드

### 7.1 변경 파일 목록

| 파일 | 변경 유형 | 주요 내용 |
|------|----------|----------|
| `src/main/window-manager.js` | 수정 | `nameToId` Map, `getWindowByName()`, 창 닫힘 시 Map 정리 |
| `src/main/index.js` | 수정 | open/update IPC 핸들러에 신규 파라미터 처리 |
| `src/main/mcp-http.mjs` | 수정 | TOOLS 스키마 업데이트, 핸들러 파라미터 추가 |
| `src/main/mcp-server.mjs` | 수정 | Zod 스키마 업데이트 |
| `src/renderer/viewer.js` | 수정 | `set-severity`, `auto-close-start` IPC 이벤트 처리 |
| `src/renderer/viewer.css` | 수정 | severity 색상 바, 카운트다운 상태 바 스타일 |
| `src/locales/*.json` | 수정 | 카운트다운 텍스트 i18n 키 추가 |

### 7.2 WindowManager 핵심 변경

```javascript
// window-manager.js 추가
class WindowManager {
  constructor() {
    // ... 기존 필드
    this.nameToId = new Map(); // windowName → windowId
  }

  getWindowByName(windowName) {
    const id = this.nameToId.get(windowName);
    if (id === undefined) return null;
    const entry = this.windows.get(id);
    if (!entry || entry.win.isDestroyed()) {
      this.nameToId.delete(windowName);
      return null;
    }
    return entry;
  }

  // createWindow() 수정: windowName 있으면 upsert
  async createWindow({ windowName, ...rest }) {
    if (windowName) {
      const existing = this.getWindowByName(windowName);
      if (existing) {
        const result = await this.updateWindow(existing.meta.windowId, rest);
        return { windowId: existing.meta.windowId, title: result.title, upserted: true };
      }
    }
    const result = await this._createNewWindow(rest);
    if (windowName) {
      this.nameToId.set(windowName, result.windowId);
      this.windows.get(result.windowId).meta.windowName = windowName;
    }
    return result;
  }

  // closeWindow() 수정: nameToId 정리
  _onWindowClosed(windowId) {
    const entry = this.windows.get(windowId);
    if (entry) {
      if (entry.meta.windowName) this.nameToId.delete(entry.meta.windowName);
      if (entry.meta.autoCloseTimer) clearTimeout(entry.meta.autoCloseTimer);
    }
    // ... 기존 정리 로직
  }
}
```

### 7.3 severity CSS

```css
/* viewer.css 추가 */
.severity-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  z-index: 9999;
  display: none;
}
[data-severity="error"]   .severity-bar { display: block; background: #ef4444; }
[data-severity="warning"] .severity-bar { display: block; background: #f59e0b; }
[data-severity="info"]    .severity-bar { display: block; background: #3b82f6; }
[data-severity="success"] .severity-bar { display: block; background: #22c55e; }
```

### 7.4 i18n 신규 키

| 키 | ko | en | ja | es |
|----|----|----|----|----|
| `viewer.autoCloseLabel` | `"자동 종료: {seconds}초"` | `"Auto-close in {seconds}s"` | `"自動終了: {seconds}秒"` | `"Cierre automático: {seconds}s"` |

---

## 8. 인수 조건

### AC-001: Named Window upsert

- **Given**: windowName `"alarm-001"` 인 창이 열려 있음
- **When**: `open_markdown { windowName: "alarm-001", content: "갱신된 내용" }` 호출
- **Then**: 새 창이 생성되지 않고 기존 창의 콘텐츠가 교체됨, 응답에 `windowId` 동일

### AC-001-2: Named Window 신규 생성

- **Given**: windowName `"new-alarm"` 인 창이 없음
- **When**: `open_markdown { windowName: "new-alarm", content: "새 알람" }` 호출
- **Then**: 새 창 생성, `nameToId`에 매핑 추가

### AC-002: Append 모드

- **Given**: windowId 42인 창에 `"# 보고서\n항목 1"` 내용이 있음
- **When**: `update_markdown { windowId: 42, content: "항목 2", appendMode: true }` 호출
- **Then**: 창에 `"# 보고서\n항목 1\n\n항목 2"` 렌더링됨

### AC-002-2: filePath 창에 append 금지

- **Given**: filePath 기반으로 열린 창(windowId 43)
- **When**: `update_markdown { windowId: 43, content: "추가", appendMode: true }` 호출
- **Then**: `isError: true`, `"appendMode is not supported for file-based windows."` 반환

### AC-003: Severity 색상 바

- **Given**: 창이 정상 상태
- **When**: `open_markdown { severity: "error", content: "..." }` 호출
- **Then**: 창 상단 4px 빨간 바 표시됨

### AC-003-2: severity null 제거

- **Given**: severity: "error" 인 창
- **When**: `update_markdown { windowId: X, severity: null }` 호출
- **Then**: 상단 색상 바 사라짐

### AC-004: Auto-close 타이머

- **Given**: 없음
- **When**: `open_markdown { autoCloseSeconds: 5, content: "..." }` 호출
- **Then**: 창 하단에 "자동 종료: 5초" 카운트다운 표시, 5초 후 창 자동 닫힘

### AC-004-2: 수동 닫기 시 타이머 해제

- **Given**: autoCloseSeconds: 60 으로 열린 창
- **When**: 사용자가 창을 수동으로 닫음
- **Then**: 타이머가 정상 해제됨 (clearTimeout 호출, 이후 에러 없음)

### AC-005: 태그 필터링

- **Given**: tags: ["alarm"] 인 창 2개, tags: ["report"] 인 창 1개
- **When**: `list_viewers { tag: "alarm" }` 호출
- **Then**: alarm 태그를 가진 2개 창만 반환

### AC-005-2: 태그 일괄 닫기

- **Given**: tags: ["temp"] 인 창 3개
- **When**: `close_viewer { tag: "temp" }` 호출
- **Then**: 3개 창 모두 닫힘, `closed: 3` 반환

### AC-006: Taskbar 플래시 (비포그라운드)

- **Given**: 창이 백그라운드 상태
- **When**: `open_markdown { flash: true, content: "..." }` 호출
- **Then**: 태스크바/독 아이콘이 깜빡임

### AC-006-2: 포그라운드 시 플래시 생략

- **Given**: 창이 포그라운드(focused) 상태
- **When**: `open_markdown { flash: true, content: "..." }` 호출
- **Then**: flashFrame 호출 없음

### AC-007: Progress Bar 표시

- **Given**: 없음
- **When**: `open_markdown { progress: 0.5, content: "..." }` 호출
- **Then**: 태스크바 아이콘에 50% 진행률 바 표시됨

### AC-007-2: Progress Bar 제거

- **Given**: progress: 0.75 인 창
- **When**: `update_markdown { windowId: X, progress: -1 }` 호출
- **Then**: 진행률 바 제거됨

---

## 부록: 전문가 평가 요약

| 기준 | 기술 아키텍트 | QA 전문가 | 비즈니스 분석가 |
|------|-------------|-----------|----------------|
| 요구사항 완전성 | A+ | A+ | A+ |
| 구현 명확성 | A+ | A+ | A+ |
| 이전 버전 일관성 | A+ | A+ | A+ |
| 병렬 환경 실용성 | A+ | A+ | A+ |
| 에러 처리 완전성 | A+ | A+ | A+ |
| API 하위 호환성 | A+ | A+ | A+ |
| 인수 조건 명확성 | A+ | A+ | A+ |
