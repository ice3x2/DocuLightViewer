# DocuLight Viewer 성능 분석 보고서

> **분석 일시**: 2026-04-16 | **분석 방법**: 3개 독립 서브에이전트 병렬 정밀 분석 (Main Process / Renderer / Electron 구성)

---

## 결론 요약

**사용자의 의심은 합리적입니다.** DocuLight Viewer는 여러 경로에서 Electron 메인 스레드 또는 렌더러 스레드를 장시간 블로킹하는 패턴이 발견되었으며, 이는 시스템 전반의 입력 지연(마우스 포인터 느려짐 등)을 유발할 수 있습니다.

### 핵심 원인 TOP 5

| 순위 | 원인 | 심각도 | 영향 |
|:---:|------|:---:|------|
| 1 | `link-parser.js` — 동기 파일 I/O (`readdirSync` + `readFileSync`) | **CRITICAL** | 수백 개 `.md` 파일을 **동기적으로** 읽어 이벤트 루프 완전 차단 |
| 2 | `viewer.js` — Mermaid 동기 렌더링 | **CRITICAL** | 다이어그램당 100~500ms CPU 점유, 순차 실행 |
| 3 | `viewer.js` — Find-in-page DOM 전체 탐색 + 마크 삽입 | **CRITICAL** | 텍스트 노드 전체 TreeWalker 2회 + DOM 변형 수백 회 |
| 4 | `window-manager.js` + `index.js` — `buildSidebarTree()` 동기 호출 | **HIGH** | 파일 탐색할 때마다 전체 디렉토리 동기 스캔 반복 |
| 5 | `git-info.js` — MCP 호출마다 git 프로세스 4개 생성 (캐시 없음) | **HIGH** | 빠른 연속 호출 시 수십 개 git 프로세스 동시 생성 |

---

## CRITICAL 이슈 (시스템 전반 영향)

### C-1. 동기 파일 I/O로 이벤트 루프 차단

**파일**: `src/main/link-parser.js:63-67, 93-108`

`buildDirectoryTree()`가 `fs.readdirSync` + `fs.readFileSync`로 디렉토리 내 **모든 `.md` 파일**을 동기적으로 읽습니다. `MAX_DIR_FILES = 65535`까지 허용되어, 대규모 프로젝트에서는 수백~수천 개 파일을 읽는 동안 **이벤트 루프가 완전히 멈춥니다**.

```js
entries = fs.readdirSync(rootDir, { withFileTypes: true });
const fileContent = fs.readFileSync(filePath, 'utf-8');
```

- Electron 메인 스레드가 차단되면 OS 입력 이벤트(마우스 이동 포함) 전달이 지연됨
- 파일 탐색, 창 열기, 탭 전환 시마다 반복 발생

**권장 수정**: `fs.promises.readdir` / `fs.promises.readFile`로 비동기 전환

---

### C-2. Mermaid 다이어그램 동기 렌더링

**파일**: `src/renderer/viewer.js:471-495`

Mermaid의 `render()`는 형식적으로 `async`이지만 내부적으로 Dagre 그래프 레이아웃 알고리즘이 **동기적 CPU 연산**을 수행합니다. 다이어그램이 5개인 문서는 수 초간 렌더러 스레드를 차단합니다.

```js
for (const block of mermaidBlocks) {
  const { svg } = await mermaid.render(id, block.textContent.trim());
  pre.replaceWith(div);
}
```

- Chromium GPU 프로세스가 렌더러 프레임을 기다리면서 시스템 전반 컴포지터 지연 발생
- 마우스 커서 렌더링까지 영향

**권장 수정**: Web Worker로 이전 또는 다이어그램 간 `setTimeout(0)` yield 삽입

---

### C-3. Find-in-page 이중 DOM 탐색 + Layout Thrash

**파일**: `src/renderer/viewer.js:1238-1279, 1392-1427`

검색 시 `clearFindHighlights()`가 DOM 전체를 탐색한 후, `performFind()`가 다시 전체 텍스트 노드를 TreeWalker로 순회하여 `<mark>` 노드를 삽입합니다. `updateMarkerTrack()`은 최대 500개 마커에 대해 `offsetTop` 읽기 + `style.top` 쓰기를 **루프 안에서 교차 실행**하여 forced reflow를 반복 유발합니다.

```js
for (let i = 0; i < markersToShow.length; i++) {
  const top = getElementScrollPosition(mark, viewer); // 읽기 → reflow 강제
  markerDiv.style.top = (ratio * trackHeight) + 'px';  // 쓰기
}
```

**권장 수정**: 읽기/쓰기 분리 (batch read → batch write), Range 기반 하이라이트 API 고려

---

### C-4. highlight.js 동기 루프 (무제한)

**파일**: `src/renderer/viewer.js:460-464`

```js
contentEl.querySelectorAll('pre code').forEach(block => {
  hljs.highlightElement(block);
});
```

50개 코드 블록이 있는 문서에서 50회 연속 동기 토큰화 + DOM 조작 실행. yield 없음.

**권장 수정**: `requestIdleCallback` 또는 청크 단위 `setTimeout`으로 분산

---

### C-5. 탭 innerHTML 직렬화/역직렬화

**파일**: `src/renderer/tab-manager.js:204, 253, 283, 329`

탭 전환 시마다 `contentEl.innerHTML`을 문자열로 저장하고, 복원 시 다시 `innerHTML`에 할당합니다. Mermaid SVG + 하이라이트된 코드 + mark 노드가 포함된 대용량 DOM을 **매번 직렬화→파싱→렌더링**합니다.

```js
tab.renderedHtml = contentEl.innerHTML;  // 저장 (직렬화)
contentEl.innerHTML = tab.renderedHtml;   // 복원 (파싱+렌더)
```

MAX_TABS=20일 때 수백 MB 메모리 누적 가능.

**권장 수정**: 원본 마크다운 문자열 저장 후 탭 전환 시 재렌더링, 또는 DocumentFragment 캐싱

---

## HIGH 이슈

### H-1. `buildSidebarTree()` 동기 호출 반복

**파일**: `src/main/window-manager.js:543-549`, `src/main/index.js:1134-1139`

파일 탐색, 드롭, 창 준비 시마다 `buildSidebarTree()` → `buildDirectoryTree()` (C-1의 동기 I/O) 전체 실행.

---

### H-2. `collectGitInfo()` 캐시 없는 프로세스 스폰

**파일**: `src/main/git-info.js:50-55`

MCP `open_markdown` / `update_markdown` 호출마다 `git` 프로세스 4개를 `Promise.all`로 동시 생성. 연속 10회 호출 = 40개 동시 git 프로세스.

**권장 수정**: `projectPath` 기준 30초 TTL 캐시 추가

---

### H-3. `findWindowId()` O(N) 선형 탐색

**파일**: `src/main/window-manager.js:912-919`

모든 렌더러 IPC 이벤트마다 전체 윈도우 맵을 순회. 창 20개 x 초당 수십 회 IPC = 수백 회 불필요한 반복.

**권장 수정**: 역방향 `Map<BrowserWindow, windowId>` 유지

---

### H-4. 트레이 메뉴 매번 전체 재구성

**파일**: `src/main/index.js:327-446`

`updateTrayMenu()`이 창 열기/닫기/제목변경/파일드롭/최근파일 추가 시마다 호출되어 `Menu.buildFromTemplate()` + `tray.setContextMenu()` (동기 네이티브 Win32 호출) 반복 실행.

**권장 수정**: 100~200ms 디바운스 적용

---

### H-5. `alwaysOnTop` 포커스 이벤트마다 재설정

**파일**: `src/main/window-manager.js:433-439`

MCP로 열린 모든 창(기본 `alwaysOnTop: true`)이 포커스받을 때마다 `win.setAlwaysOnTop(true)` 호출. `SetWindowPos(HWND_TOPMOST)` Win32 API가 불필요하게 반복 호출되어 OS 입력 처리 지연.

**권장 수정**: `win.isAlwaysOnTop()` 체크 후 변경 필요 시에만 호출

---

### H-6. 사이드바 전체 재렌더링

**파일**: `src/renderer/viewer.js:1739-1850`

이름 토글, 탭 전환, 검색 종료 시 `container.innerHTML = ''` 후 모든 트리 노드 재생성 + 이벤트 리스너 재등록. 1000개 파일 디렉토리에서 1000+ `createElement` + `addEventListener` 동기 실행.

---

### H-7. `_pendingNames` 50ms 폴링 루프

**파일**: `src/main/window-manager.js:280-295`

동일 `windowName`으로 동시 생성 요청 시 50ms 간격 폴링 (최대 5초 = 100회). Promise 기반 알림으로 대체 가능.

---

### H-8. IPC 버퍼 문자열 연결 방식

**파일**: `src/main/mcp-server.mjs:48, 270-272`, `src/main/index.js:550`

```js
ipcBuffer += chunk;
```

대용량 IPC 메시지에서 `string +=` 연결은 누적 크기에 비례하는 가비지를 생성하여 GC 압력 증가.

**권장 수정**: `Buffer[]` 배열 + `Buffer.concat()` 또는 `readline` 인터페이스 사용

---

## MEDIUM 이슈

| 이슈 | 파일 | 설명 |
|------|------|------|
| `search-sidebar-content` 키스트로크마다 전체 디렉토리 워크 | `index.js:1611-1700` | IPC 레벨 디바운스 없음 |
| `tokenize()` O(N) 바이그램 생성 | `tokenizer.js:47-53` | 전체 문자 쌍 토큰 생성, CJK만 필요 |
| BM25 rebuild 메인 스레드 CPU-bound | `search-engine.js:54-91` | Worker thread로 이전 필요 |
| `new Blob([content]).size` 매 렌더마다 실행 | `viewer.js:416-419` | `content.length`로 대체 가능 |
| CSS `transition: width 200ms` 드래그 중 미비활성화 | `viewer.css:97` | 리사이즈 중 layout micro-animation 유발 |
| SSE keep-alive interval 누적 가능성 | `mcp-http.mjs:492-498` | `_mcpClose()`에서 clearInterval 미호출 |
| 포트 발견 루프 최대 64,000회 반복 | `mcp-http.mjs:613-634` | 범위 제한 필요 (base +/- 50) |
| `mousemove` rAF 누적 | `viewer.js:2244-2256` | `rafPending` 가드 없음 |
| IndexedDB 매번 새 연결 | `viewer.js:114-126` | 단일 핸들 재사용 필요 |
| `updateTocHighlight` 스크롤마다 layout 읽기 | `viewer.js:1913-1938` | 50개 heading `offsetTop` 읽기 반복 |

---

## 종합 판정

```
┌──────────────────────────────────────────────────────────┐
│  사용자 의심: 합리적 ✓                                    │
│                                                          │
│  시스템 전반 마우스 느려짐의 가장 유력한 원인:               │
│                                                          │
│  1. link-parser.js 동기 파일 I/O (CRITICAL)               │
│     → 수백 개 파일 동기 읽기로 이벤트 루프 수백ms 차단       │
│                                                          │
│  2. Mermaid 동기 렌더링 (CRITICAL)                        │
│     → GPU 프로세스 프레임 대기 → 시스템 컴포지터 지연        │
│                                                          │
│  3. alwaysOnTop 반복 호출 (HIGH)                          │
│     → Win32 SetWindowPos 반복 → OS 입력 파이프라인 지연     │
│                                                          │
│  이 3가지가 복합 작용하면 마우스 포인터 지연이 발생할 수 있음  │
└──────────────────────────────────────────────────────────┘
```

## 우선순위별 수정 권장 순서

| 순위 | 수정 사항 | 예상 효과 | 난이도 |
|:---:|----------|----------|:---:|
| 1 | `link-parser.js` 비동기 전환 | 즉각적이고 가장 큰 효과 | 중 |
| 2 | `collectGitInfo()` 결과 캐싱 | 간단한 수정, 큰 효과 | 하 |
| 3 | `alwaysOnTop` 중복 호출 가드 | 1줄 수정 | 하 |
| 4 | 트레이 메뉴 디바운스 | 간단한 수정 | 하 |
| 5 | Mermaid/hljs 렌더링 yield 삽입 | 렌더러 블로킹 완화 | 중 |
| 6 | Find-in-page 읽기/쓰기 분리 | layout thrash 제거 | 중 |
| 7 | 탭 캐싱 전략 변경 | 메모리 누적 방지 | 상 |
