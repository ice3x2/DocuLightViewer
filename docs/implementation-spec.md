# DocuLight Viewer — 구현 스펙 (Implementation Spec)

> **생성일**: 2026-04-16  
> **기반 보고서**: `performance-analysis-report.md`, `supplementary-analysis-report.md`  
> **사용자 결정 사항**:
> - C-5 (탭 캐싱): innerHTML 직렬화 제거 → 원본 마크다운 재렌더링 + 탭별 스크롤/검색 상태 복원
> - H-5 (alwaysOnTop): `isAlwaysOnTop()` 가드 추가
> - C-1 (link-parser 동기 I/O): 전체 async 전환
> - S-1 ~ S-8: **제외** (보안/경로 탈출 항목 전체 — 사용자 결정)

---

## 제외 항목

| 원본 ID | 제외 사유 |
|---------|-----------|
| S-1 | 사용자 제외 (경로 탈출 검증) |
| S-2 | 사용자 제외 (경로 탈출 검증) |
| S-3 | 사용자 제외 (환경변수 검증) |
| S-4 | 사용자 제외 (URL 디코딩 경로 탈출) |
| S-5 | 사용자 제외 (projectPath 검증) |
| S-6 | 사용자 제외 (save-as 경로 검증) |
| S-7 | 사용자 제외 (TOCTOU 경쟁) |
| S-8 | 사용자 제외 (navigate-to IPC XSS) |

---

## 전체 구현 항목 목록 (IMPL-001 ~ IMPL-058)

---

### IMPL-001

| 항목 | 내용 |
|------|------|
| **원본 ID** | C-1 + H-1 + E-10 (통합) |
| **설명** | `link-parser.js`의 `buildDirectoryTree()`를 `fs.promises` 기반 완전 비동기 함수로 전환하여 메인 스레드 이벤트 루프 차단을 제거한다. |
| **심각도** | CRITICAL |
| **영향 파일** | `src/main/link-parser.js`, `src/main/window-manager.js`, `src/main/index.js` |
| **의존성** | 없음 (최우선 독립 항목) |
| **수용 기준** | `readdirSync`/`readFileSync` 호출이 코드베이스에서 완전히 제거됨; 1000개 `.md` 파일 디렉토리에서 사이드바 로딩 시 메인 스레드 블로킹 없음; 비동기 에러 발생 시 로그 출력 후 해당 파일 건너뜀 (E-10 포함 처리) |

---

### IMPL-002

| 항목 | 내용 |
|------|------|
| **원본 ID** | C-2 |
| **설명** | Mermaid 다이어그램 렌더링 루프에 `setTimeout(0)` yield를 삽입하여 렌더러 스레드 장시간 블로킹을 방지한다. |
| **심각도** | CRITICAL |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | 없음 |
| **수용 기준** | 다이어그램 5개 이상 문서에서 각 다이어그램 렌더링 사이에 이벤트 루프가 양보됨; 렌더러 스레드 단일 블로킹 시간이 16ms 이하로 유지됨 |

---

### IMPL-003

| 항목 | 내용 |
|------|------|
| **원본 ID** | C-3 |
| **설명** | Find-in-page의 `updateMarkerTrack()`에서 `offsetTop` 읽기와 `style.top` 쓰기를 분리(batch read → batch write)하여 forced reflow 반복을 제거한다. |
| **심각도** | CRITICAL |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | 없음 |
| **수용 기준** | `updateMarkerTrack()` 실행 중 reflow 횟수가 1회로 감소함; 500개 마커 기준 실행 시간이 기존 대비 50% 이상 단축됨 |

---

### IMPL-004

| 항목 | 내용 |
|------|------|
| **원본 ID** | C-4 |
| **설명** | `hljs.highlightElement()` 루프를 `requestIdleCallback` 또는 청크 단위 `setTimeout`으로 분산하여 코드 블록 대량 렌더링 시 렌더러 블로킹을 방지한다. |
| **심각도** | CRITICAL |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | 없음 |
| **수용 기준** | 코드 블록 50개 문서 로딩 시 렌더러 스레드 단일 블로킹이 16ms 이하; 모든 코드 블록에 하이라이팅이 적용됨 |

---

### IMPL-005

| 항목 | 내용 |
|------|------|
| **원본 ID** | C-5 (사용자 결정 적용) |
| **설명** | 탭 전환 시 `innerHTML` 직렬화/역직렬화 대신 탭별 원본 마크다운을 저장하고, 탭 전환 시 재렌더링하되 스크롤 위치와 검색 상태를 탭 ID 기준으로 복원한다. |
| **심각도** | CRITICAL |
| **영향 파일** | `src/renderer/tab-manager.js`, `src/renderer/viewer.js` |
| **의존성** | IMPL-002, IMPL-004 (재렌더링 시 Mermaid/hljs 블로킹 해소 필요) |
| **수용 기준** | `tab.renderedHtml` 저장/복원 코드가 제거됨; 탭 전환 후 이전 스크롤 위치와 검색어가 복원됨; 탭 20개 유지 시 메모리 사용량이 innerHTML 직렬화 방식 대비 감소함 |

---

### IMPL-006

| 항목 | 내용 |
|------|------|
| **원본 ID** | H-2 |
| **설명** | `collectGitInfo()`에 `projectPath` 기준 30초 TTL 캐시를 추가하여 MCP 연속 호출 시 git 프로세스가 폭발적으로 생성되는 것을 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/git-info.js` |
| **의존성** | 없음 |
| **수용 기준** | 동일 `projectPath`로 30초 내 10회 연속 `open_markdown` 호출 시 git 프로세스가 1회만 생성됨; 30초 경과 후 재호출 시 새 프로세스 생성됨 |

---

### IMPL-007

| 항목 | 내용 |
|------|------|
| **원본 ID** | H-3 |
| **설명** | `findWindowId()`의 O(N) 선형 탐색을 `Map<BrowserWindow, windowId>` 역방향 맵으로 대체하여 IPC 이벤트마다 발생하는 불필요한 순회를 제거한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/window-manager.js` |
| **의존성** | 없음 |
| **수용 기준** | `findWindowId()` 시간 복잡도가 O(1)로 개선됨; 창 생성/소멸 시 역방향 맵이 정확히 동기화됨 |

---

### IMPL-008

| 항목 | 내용 |
|------|------|
| **원본 ID** | H-4 |
| **설명** | `updateTrayMenu()`에 100~200ms 디바운스를 적용하여 창 열기/닫기/제목변경/파일드롭 연속 이벤트 시 네이티브 Win32 메뉴 재구성 호출을 최소화한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/index.js` |
| **의존성** | 없음 |
| **수용 기준** | 100ms 내에 연속 5회 트리거 시 `Menu.buildFromTemplate()` 호출이 1회로 합쳐짐; 마지막 상태가 정확히 반영됨 |

---

### IMPL-009

| 항목 | 내용 |
|------|------|
| **원본 ID** | H-5 (사용자 결정 적용) |
| **설명** | `win.focus()` 핸들러에서 `win.setAlwaysOnTop(true)` 호출 전 `win.isAlwaysOnTop()` 가드를 추가하여 이미 topmost 상태인 창에 대한 Win32 `SetWindowPos` 중복 호출을 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/window-manager.js` |
| **의존성** | 없음 |
| **수용 기준** | 이미 `alwaysOnTop` 상태인 창이 포커스를 받을 때 `setAlwaysOnTop()` 호출이 발생하지 않음; 상태 전환은 정상 작동함 |

---

### IMPL-010

| 항목 | 내용 |
|------|------|
| **원본 ID** | H-6 |
| **설명** | 사이드바 트리 재렌더링 시 `container.innerHTML = ''` 후 전체 재생성 대신 변경된 노드만 업데이트하는 증분 렌더링 또는 DOM 재사용 패턴을 도입한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | IMPL-001 (비동기 트리 데이터 흐름 변경과 연동) |
| **수용 기준** | 이름 토글, 탭 전환, 검색 종료 시 전체 `createElement` + `addEventListener` 재실행이 없음; 1000개 파일 디렉토리에서 사이드바 재렌더링 시간이 기존 대비 50% 이상 단축됨 |

---

### IMPL-011

| 항목 | 내용 |
|------|------|
| **원본 ID** | H-7 |
| **설명** | `_pendingNames` 50ms 폴링 루프를 Promise/resolve 기반 대기 메커니즘으로 교체하여 불필요한 반복 호출을 제거한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/window-manager.js` |
| **의존성** | 없음 |
| **수용 기준** | 동일 `windowName` 동시 생성 요청 시 폴링 없이 Promise resolve로 대기가 해소됨; 최대 5초 타임아웃 동작은 유지됨 |

---

### IMPL-012

| 항목 | 내용 |
|------|------|
| **원본 ID** | H-8 |
| **설명** | IPC 버퍼 누적에서 `string +=` 패턴을 `Buffer[]` 배열 + `Buffer.concat()` 또는 `readline` 인터페이스로 교체하여 GC 압력을 감소시킨다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/mcp-server.mjs`, `src/main/index.js` |
| **의존성** | 없음 |
| **수용 기준** | 대용량 IPC 메시지(1MB 이상) 수신 시 중간 문자열 객체 생성이 없음; ndjson 파싱 결과는 동일함 |

---

### IMPL-013

| 항목 | 내용 |
|------|------|
| **원본 ID** | MEDIUM — `search-sidebar-content` 디바운스 누락 |
| **설명** | `search-sidebar-content` IPC 핸들러에 키스트로크 단위 디바운스를 추가하여 매 입력마다 전체 디렉토리 워크가 실행되는 것을 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/index.js` |
| **의존성** | IMPL-001 |
| **수용 기준** | 빠른 타이핑 시 디바운스 기간(예: 150ms) 내 마지막 키스트로크만 검색을 실행함; 검색 결과는 동일함 |

---

### IMPL-014

| 항목 | 내용 |
|------|------|
| **원본 ID** | MEDIUM — `tokenize()` O(N) 바이그램 최적화 |
| **설명** | `tokenizer.js`의 `tokenize()`에서 전체 문자 쌍 바이그램 생성을 CJK 문자에만 적용하도록 제한하여 불필요한 토큰 생성 오버헤드를 줄인다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/tokenizer.js` |
| **의존성** | 없음 |
| **수용 기준** | 영문만 있는 문서 토큰화 시 바이그램이 생성되지 않음; 한국어/일본어/중국어 문서의 검색 품질이 동일하게 유지됨 |

---

### IMPL-015

| 항목 | 내용 |
|------|------|
| **원본 ID** | MEDIUM — BM25 rebuild Worker thread 이전 |
| **설명** | `search-engine.js`의 `rebuild()` CPU-bound 작업을 Worker thread로 이전하여 메인 스레드 블로킹을 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/search-engine.js` |
| **의존성** | IMPL-023 (R-4 레이스 컨디션 해결과 연동) |
| **수용 기준** | `rebuild()` 실행 중 메인 스레드 IPC 응답이 지연되지 않음; 재빌드 완료 후 검색 결과가 업데이트됨 |

---

### IMPL-016

| 항목 | 내용 |
|------|------|
| **원본 ID** | MEDIUM — `new Blob([content]).size` |
| **설명** | `viewer.js`에서 `new Blob([content]).size`를 `content.length`로 교체하여 매 렌더링마다 불필요한 Blob 객체 생성을 제거한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | 없음 |
| **수용 기준** | `new Blob(...)` 호출이 해당 컨텍스트에서 제거됨; 크기 판별 로직이 동일하게 작동함 |

---

### IMPL-017

| 항목 | 내용 |
|------|------|
| **원본 ID** | MEDIUM — CSS transition 드래그 중 비활성화 |
| **설명** | 사이드바 리사이즈 드래그 중 `transition: width 200ms`를 비활성화하여 드래그 중 layout micro-animation 유발을 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/renderer/viewer.css`, `src/renderer/viewer.js` |
| **의존성** | 없음 |
| **수용 기준** | 드래그 시작 시 transition 제거, 드래그 종료 시 복원; 드래그 중 레이아웃 재계산이 줄어듦 |

---

### IMPL-018

| 항목 | 내용 |
|------|------|
| **원본 ID** | MEDIUM — SSE keep-alive interval 정리 (CL-9와 통합) |
| **설명** | `mcp-http.mjs`의 SSE keep-alive `setInterval`을 `res.on('close')` 핸들러에서 명시적으로 `clearInterval`하여 누적 실행을 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/mcp-http.mjs` |
| **의존성** | 없음 |
| **수용 기준** | SSE 클라이언트 연결 종료 시 해당 interval이 즉시 정리됨; 연결 10회 반복 후 GC 정상 수행됨 |

---

### IMPL-019

| 항목 | 내용 |
|------|------|
| **원본 ID** | MEDIUM — 포트 발견 루프 제한 |
| **설명** | `mcp-http.mjs`의 포트 발견 루프를 기본 포트 ± 50 범위(최대 100회)로 제한하여 이론적으로 64,000회 반복 가능한 무제한 루프를 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/mcp-http.mjs` |
| **의존성** | 없음 |
| **수용 기준** | 포트 범위 내 바인딩 성공 시 정상 동작; 범위 초과 시 명확한 에러 메시지로 실패함 |

---

### IMPL-020

| 항목 | 내용 |
|------|------|
| **원본 ID** | MEDIUM — `mousemove` rAF 누적 가드 |
| **설명** | `viewer.js`의 `mousemove` 리스너에 `rafPending` 가드를 추가하여 `requestAnimationFrame` 콜백이 누적 호출되는 것을 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | 없음 |
| **수용 기준** | `mousemove` 이벤트 연속 발생 시 rAF 콜백이 한 프레임에 1회만 실행됨 |

---

### IMPL-021

| 항목 | 내용 |
|------|------|
| **원본 ID** | MEDIUM — IndexedDB 단일 핸들 재사용 |
| **설명** | `viewer.js`에서 매번 새 IndexedDB 연결을 여는 패턴을 단일 핸들 재사용 패턴으로 교체하여 불필요한 연결 오버헤드를 제거한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | 없음 |
| **수용 기준** | IndexedDB `open()` 호출이 앱 초기화 시 1회만 발생함; 이후 작업은 기존 핸들을 재사용함 |

---

### IMPL-022

| 항목 | 내용 |
|------|------|
| **원본 ID** | MEDIUM — `updateTocHighlight` 스크롤 layout 읽기 최적화 |
| **설명** | `updateTocHighlight()`에서 스크롤마다 50개 heading의 `offsetTop`을 반복 읽는 것을 IntersectionObserver 기반으로 교체하거나 캐싱하여 forced layout을 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | 없음 |
| **수용 기준** | 스크롤 이벤트 처리 중 layout 읽기 횟수가 1회 이하로 감소함; TOC 하이라이트 정확도가 유지됨 |

---

### IMPL-023

| 항목 | 내용 |
|------|------|
| **원본 ID** | M-1 + CL-6 (통합) |
| **설명** | PDF Export의 `window-ready` one-shot IPC 리스너를 `ipcMain.once()`로 교체하거나 정상 완료 시 즉시 `removeListener`를 호출하여 좀비 리스너 누적을 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/index.js` |
| **의존성** | 없음 |
| **수용 기준** | PDF 내보내기 완료 후 `window-ready` 리스너가 남지 않음; 10회 반복 내보내기 후 리스너 수가 동일함 |

---

### IMPL-024

| 항목 | 내용 |
|------|------|
| **원본 ID** | M-2 |
| **설명** | PDF Export의 `pdf-render-complete` IPC 리스너를 정상 완료 시 즉시 제거하여 좀비 리스너를 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/index.js` |
| **의존성** | IMPL-023 |
| **수용 기준** | PDF 내보내기 완료 후 `pdf-render-complete` 리스너가 남지 않음 |

---

### IMPL-025

| 항목 | 내용 |
|------|------|
| **원본 ID** | M-3 + M-4 |
| **설명** | 배치 PDF 반복문 내에서 반복 등록되는 `window-ready` 및 `pdf-render-complete` 리스너를 반복문 외부로 이동하거나 반복마다 이전 리스너를 정리하여 20파일 = 40개 좀비 리스너 누적을 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/index.js` |
| **의존성** | IMPL-023, IMPL-024 |
| **수용 기준** | 20개 파일 배치 PDF 내보내기 완료 후 IPC 리스너 수가 증가하지 않음 |

---

### IMPL-026

| 항목 | 내용 |
|------|------|
| **원본 ID** | M-5 |
| **설명** | `viewer.js`의 `cleanups` 배열에 등록된 IPC unsubscribe 함수들을 `beforeunload` 이벤트에서 순회 호출하여 창 닫힘 시 IPC 구독이 정리되도록 한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | 없음 |
| **수용 기준** | 창 닫힘 시 `cleanups` 배열의 모든 함수가 호출됨; 창 20개 열고 닫기 반복 후 메모리 증가 없음 |

---

### IMPL-027

| 항목 | 내용 |
|------|------|
| **원본 ID** | M-6 |
| **설명** | `window-manager.js`의 `debounceTimer` 덮어쓰기 전에 `clearTimeout(this.debounceTimer)`를 선행 호출하여 타이머 누적을 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/window-manager.js` |
| **의존성** | 없음 |
| **수용 기준** | 디바운스 기간 내 다중 트리거 시 타이머가 1개만 유지됨 |

---

### IMPL-028

| 항목 | 내용 |
|------|------|
| **원본 ID** | M-7 |
| **설명** | `tab-manager.js`의 `renderTabBar()`에서 탭 요소를 재생성할 때 이전 클릭 리스너를 제거하거나 요소를 재사용하여 중복 리스너 등록을 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/renderer/tab-manager.js` |
| **의존성** | IMPL-005 (탭 매니저 리팩토링과 연동) |
| **수용 기준** | 탭 100회 전환 후 각 탭 요소의 이벤트 리스너 수가 1개를 유지함 |

---

### IMPL-029

| 항목 | 내용 |
|------|------|
| **원본 ID** | M-8 |
| **설명** | `sidebar-search.js`에서 `addEventListener`로 등록된 리스너를 `exitSearchMode()` 호출 시 모두 제거하는 정리 경로를 추가한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/renderer/sidebar-search.js` |
| **의존성** | 없음 |
| **수용 기준** | `exitSearchMode()` 호출 후 등록된 모든 이벤트 리스너가 제거됨; 반복 진입/종료 시 리스너가 누적되지 않음 |

---

### IMPL-030

| 항목 | 내용 |
|------|------|
| **원본 ID** | E-1 |
| **설명** | `update_markdown` IPC 핸들러에서 `entry`가 null인 경우 명확한 에러 응답을 반환하는 null 체크를 추가하여 런타임 크래시를 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/index.js` |
| **의존성** | 없음 |
| **수용 기준** | 존재하지 않는 windowId로 `update_markdown` 호출 시 앱이 크래시하지 않고 에러 응답을 반환함 |

---

### IMPL-031

| 항목 | 내용 |
|------|------|
| **원본 ID** | E-2 |
| **설명** | `export-pdf` IPC 핸들러에서 `senderEntry` 검증 로직을 추가하여 창 조회 실패 시 크래시를 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/index.js` |
| **의존성** | 없음 |
| **수용 기준** | PDF 내보내기 요청 창이 이미 닫혔을 때 크래시하지 않고 에러를 반환함 |

---

### IMPL-032

| 항목 | 내용 |
|------|------|
| **원본 ID** | E-3 |
| **설명** | `saveMcpFile` 완료 후 entry 재조회 시 `entry.win.isDestroyed()` 확인을 추가하여 창이 이미 소멸된 경우 크래시를 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/index.js` |
| **의존성** | 없음 |
| **수용 기준** | 파일 저장 완료 전 창이 닫히는 시나리오에서 크래시하지 않음 |

---

### IMPL-033

| 항목 | 내용 |
|------|------|
| **원본 ID** | E-4 |
| **설명** | `search-engine.js`의 `_loadIndex()`에서 `JSON.parse()` 호출을 try-catch로 감싸 손상된 인덱스 파일로 인한 앱 초기화 실패를 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/search-engine.js` |
| **의존성** | 없음 |
| **수용 기준** | 인덱스 파일이 손상되어 있어도 앱이 정상 시작됨; 손상된 인덱스는 빈 상태로 초기화됨; 경고 로그가 출력됨 |

---

### IMPL-034

| 항목 | 내용 |
|------|------|
| **원본 ID** | E-5 |
| **설명** | `git-info.js`의 `Promise.all` 에러를 조용히 무시하는 대신 WARNING 레벨 로그를 출력하여 git 필드 누락 원인 디버깅을 용이하게 한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/git-info.js` |
| **의존성** | IMPL-006 (캐시 도입과 함께 에러 처리 개선) |
| **수용 기준** | git 명령 실패 시 콘솔에 WARNING 로그가 출력됨; 실패한 필드는 `null`로 처리되고 앱은 계속 동작함 |

---

### IMPL-035

| 항목 | 내용 |
|------|------|
| **원본 ID** | E-6 |
| **설명** | `window-manager.js`의 파일 워처 에러 핸들러를 올바른 등록 시기에 추가하여 중복 처리를 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/window-manager.js` |
| **의존성** | 없음 |
| **수용 기준** | 파일 워처 에러 이벤트가 정확히 1회만 처리됨; 중복 에러 핸들러가 없음 |

---

### IMPL-036

| 항목 | 내용 |
|------|------|
| **원본 ID** | E-7 |
| **설명** | `buildSidebarTree` 에러 발생 시 단순 로깅을 넘어 UI에 에러 상태를 표시하거나 사이드바 빈 상태로 graceful fallback하도록 에러 처리를 강화한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/index.js` |
| **의존성** | IMPL-001 |
| **수용 기준** | `buildSidebarTree` 실패 시 사이드바가 빈 상태로 표시되고 에러 로그가 출력됨; 앱이 계속 동작함 |

---

### IMPL-037

| 항목 | 내용 |
|------|------|
| **원본 ID** | E-8 |
| **설명** | `mcp-http.mjs`의 `readBody` 에러 발생 시 로깅을 추가하여 HTTP 요청 중단 시 무음 실패를 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/mcp-http.mjs` |
| **의존성** | 없음 |
| **수용 기준** | HTTP 요청 중단 시 에러 로그가 출력됨; 클라이언트에 적절한 HTTP 에러 응답이 반환됨 |

---

### IMPL-038

| 항목 | 내용 |
|------|------|
| **원본 ID** | E-9 |
| **설명** | `search-engine.js`의 `Promise.all + catch(null)` 패턴을 개선하여 개별 문서 인덱싱 실패 시 해당 문서만 건너뛰고 나머지는 정상 인덱싱되도록 한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/search-engine.js` |
| **의존성** | IMPL-033 |
| **수용 기준** | 일부 문서 인덱싱 실패 시 나머지 문서는 정상 인덱싱됨; 실패 문서 목록이 로그에 출력됨 |

---

### IMPL-039

| 항목 | 내용 |
|------|------|
| **원본 ID** | R-1 |
| **설명** | `window-manager.js`의 `createWindow()`에서 동일 `windowName` 동시 요청 시 중복 윈도우 또는 교착 상태를 방지하는 뮤텍스 또는 Promise 직렬화 패턴을 구현한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/window-manager.js` |
| **의존성** | IMPL-011 (폴링 제거와 연동) |
| **수용 기준** | 동일 `windowName`으로 10ms 내 3회 동시 `createWindow()` 호출 시 창이 1개만 생성됨; 교착 상태 없음 |

---

### IMPL-040

| 항목 | 내용 |
|------|------|
| **원본 ID** | R-2 |
| **설명** | `index.js`에서 병렬 `open_markdown` + `update_markdown` 동일 `windowId` 요청 시 메타데이터 불일치를 방지하는 직렬화 큐 또는 낙관적 잠금을 구현한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/index.js` |
| **의존성** | IMPL-039 |
| **수용 기준** | 동일 windowId에 병렬 open/update 요청 시 최종 상태가 마지막 요청의 메타데이터와 일치함 |

---

### IMPL-041

| 항목 | 내용 |
|------|------|
| **원본 ID** | R-3 |
| **설명** | `window-manager.js`의 파일 워처 콜백과 IPC `lastRenderedContent` 업데이트 간 경쟁 상태를 방지하는 상태 업데이트 직렬화를 구현한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/window-manager.js` |
| **의존성** | 없음 |
| **수용 기준** | 파일 변경과 동시 MCP 업데이트 시 `lastRenderedContent`가 항상 일관된 상태를 유지함 |

---

### IMPL-042

| 항목 | 내용 |
|------|------|
| **원본 ID** | R-4 |
| **설명** | `search-engine.js`의 `rebuild()` 실행 중 `search()` 동시 읽기 시 불완전한 결과를 방지하는 읽기/쓰기 분리 패턴을 구현한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/search-engine.js` |
| **의존성** | IMPL-015 |
| **수용 기준** | `rebuild()` 중 `search()` 호출 시 재빌드 이전 완전한 인덱스 또는 재빌드 완료 후 인덱스 중 하나를 일관되게 반환함 |

---

### IMPL-043

| 항목 | 내용 |
|------|------|
| **원본 ID** | R-5 |
| **설명** | `mcp-save.js`의 `mkdir` 후 `writeFile` 사이 동일 경로 동시 쓰기 시 파일 손상을 방지하는 원자적 쓰기(임시 파일 → rename) 패턴을 구현한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/mcp-save.js` |
| **의존성** | 없음 |
| **수용 기준** | 동일 경로에 동시 쓰기 요청 시 파일이 완전한 내용을 유지함; 부분 쓰기로 인한 파일 손상이 없음 |

---

### IMPL-044

| 항목 | 내용 |
|------|------|
| **원본 ID** | R-6 |
| **설명** | `index.js`의 `isExporting` 플래그 체크-설정 간격에서 발생할 수 있는 동시 내보내기를 방지하는 원자적 플래그 설정 패턴을 구현한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/index.js` |
| **의존성** | 없음 |
| **수용 기준** | 동시 PDF 내보내기 요청 시 첫 번째 요청만 실행되고 나머지는 "내보내기 중" 에러를 반환함 |

---

### IMPL-045

| 항목 | 내용 |
|------|------|
| **원본 ID** | R-7 |
| **설명** | `tab-manager.js`에서 탭 배열 수정 중 다른 탭 작업이 인덱스 불일치를 유발하지 않도록 배열 조작을 단일 동기 블록으로 처리한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/renderer/tab-manager.js` |
| **의존성** | IMPL-005, IMPL-028 |
| **수용 기준** | 탭 추가/제거와 탭 전환 동시 발생 시 탭 인덱스가 올바르게 유지됨 |

---

### IMPL-046

| 항목 | 내용 |
|------|------|
| **원본 ID** | R-8 |
| **설명** | `search-engine.js`의 `initialize()` 완료 전 검색 요청이 들어오는 경우를 처리하는 초기화 완료 대기 패턴을 구현한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/search-engine.js` |
| **의존성** | IMPL-033 |
| **수용 기준** | 앱 시작 직후 검색 요청 시 초기화 완료 후 결과를 반환하거나 "초기화 중" 상태를 반환함; 불완전 인덱스로 검색되지 않음 |

---

### IMPL-047

| 항목 | 내용 |
|------|------|
| **원본 ID** | CL-1 |
| **설명** | `viewer.js`의 컨텍스트 메뉴 리스너를 `cleanups` 배열에 추가하여 `beforeunload` 시 정리되도록 한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | IMPL-026 |
| **수용 기준** | 창 닫힘 시 컨텍스트 메뉴 IPC 리스너가 제거됨 |

---

### IMPL-048

| 항목 | 내용 |
|------|------|
| **원본 ID** | CL-2 |
| **설명** | `viewer.js`의 `window.resize` 리스너를 `cleanups` 배열에 추가하여 `beforeunload` 시 정리되도록 한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | IMPL-026 |
| **수용 기준** | 창 닫힘 시 resize 리스너가 제거됨 |

---

### IMPL-049

| 항목 | 내용 |
|------|------|
| **원본 ID** | CL-3 |
| **설명** | `viewer.js`의 `findDebounceTimer`를 `beforeunload` 핸들러에서 `clearTimeout`으로 정리하여 창 닫힘 시 타이머 잔존을 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | IMPL-026 |
| **수용 기준** | 창 닫힘 시 진행 중인 find 디바운스 타이머가 취소됨 |

---

### IMPL-050

| 항목 | 내용 |
|------|------|
| **원본 ID** | CL-4 |
| **설명** | `mcp-http.mjs`의 SSE 커넥션 비정상 종료 시 `res.on('close')`와 `res.on('finish')` 이중 정리를 구현하여 연결 정리 불완전을 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/mcp-http.mjs` |
| **의존성** | IMPL-018 |
| **수용 기준** | SSE 연결 정상/비정상 종료 모두에서 클라이언트가 정리 맵에서 제거됨; 연결 100회 반복 후 메모리 누수 없음 |

---

### IMPL-051

| 항목 | 내용 |
|------|------|
| **원본 ID** | CL-5 |
| **설명** | `window-manager.js`에서 파일 워처 에러 후 맵에 잔존하는 null 엔트리를 `.delete(windowId)`로 정리하여 맵 오염을 방지한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/main/window-manager.js` |
| **의존성** | IMPL-035 |
| **수용 기준** | 파일 워처 에러 후 윈도우 맵에 null 엔트리가 없음; 이후 맵 순회가 정상 동작함 |

---

### IMPL-052

| 항목 | 내용 |
|------|------|
| **원본 ID** | CL-7 |
| **설명** | `viewer.js`의 `_autoCloseInterval`을 `cleanups` 배열에 `clearInterval`로 추가하여 창 닫힘 시 자동 닫힘 카운트다운 타이머가 정리되도록 한다. |
| **심각도** | HIGH |
| **영향 파일** | `src/renderer/viewer.js` |
| **의존성** | IMPL-026 |
| **수용 기준** | 창 닫힘 시 `_autoCloseInterval`이 취소됨; 닫힌 창의 타이머가 콜백을 실행하지 않음 |

---

### IMPL-053

| 항목 | 내용 |
|------|------|
| **원본 ID** | CL-8 |
| **설명** | `window-manager.js`의 `navigateTo()`에서 새 파일 워처를 시작하기 전 이전 파일 워처를 `stopFileWatcher()`로 정리하여 워처 누적을 방지한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/window-manager.js` |
| **의존성** | IMPL-051 |
| **수용 기준** | 5회 연속 `navigateTo()` 호출 후 활성 파일 워처가 1개만 존재함 |

---

### IMPL-054

| 항목 | 내용 |
|------|------|
| **원본 ID** | CL-9 + CL-10 (통합, IMPL-018과 연동) |
| **설명** | `mcp-http.mjs`의 `_mcpClose()`에서 keep-alive interval을 명시적으로 `clearInterval`하고, interval을 Map으로 관리하여 연결별 정확한 정리가 가능하도록 한다. |
| **심각도** | MEDIUM |
| **영향 파일** | `src/main/mcp-http.mjs` |
| **의존성** | IMPL-018, IMPL-050 |
| **수용 기준** | `_mcpClose()` 호출 시 해당 클라이언트의 keep-alive interval이 정지됨; `_mcpClose()` 후 해당 클라이언트와 관련된 타이머가 없음 |

---

## 통합/중복 처리 요약

| 통합 항목 | 원본 IDs | 사유 |
|----------|----------|------|
| IMPL-001 | C-1 + H-1 + E-10 | H-1은 C-1의 호출 지점, E-10은 C-1의 비동기 에러 처리 |
| IMPL-023 | M-1 + CL-6 | 동일 버그(PDF window-ready 리스너 미정리)의 두 관점 |
| IMPL-018 | MEDIUM SSE interval + CL-9 일부 | 동일 interval 정리 패턴 |
| IMPL-054 | CL-9 + CL-10 | 동일 keep-alive 관리 구조 개선 |

---

## 의존성 클러스터

### 클러스터 A: 비동기 I/O 핵심 (최우선)
```
IMPL-001 (link-parser async)
  └─ IMPL-010 (사이드바 증분 렌더링)
  └─ IMPL-013 (검색 IPC 디바운스)
  └─ IMPL-036 (buildSidebarTree 에러 처리)
```

### 클러스터 B: 렌더러 블로킹 제거
```
IMPL-002 (Mermaid yield)
IMPL-004 (hljs 청크)
  └─ IMPL-005 (탭 재렌더링)
       └─ IMPL-028 (탭 리스너 중복)
       └─ IMPL-045 (탭 배열 레이스)
```

### 클러스터 C: 메인 프로세스 즉시 수정 (독립, 쉬움)
```
IMPL-006 (git 캐시)
  └─ IMPL-034 (git 에러 로깅)
IMPL-007 (windowId O(1))
IMPL-008 (트레이 디바운스)
IMPL-009 (alwaysOnTop 가드)
IMPL-012 (IPC 버퍼)
```

### 클러스터 D: 창/윈도우 레이스 컨디션
```
IMPL-011 (폴링 → Promise)
  └─ IMPL-039 (createWindow 뮤텍스)
       └─ IMPL-040 (open/update 직렬화)
IMPL-041 (워처-IPC 경쟁)
IMPL-044 (isExporting 원자적)
```

### 클러스터 E: 리소스 정리 (viewer.js cleanups)
```
IMPL-026 (cleanups beforeunload 연결)
  └─ IMPL-047 (컨텍스트 메뉴)
  └─ IMPL-048 (resize 리스너)
  └─ IMPL-049 (findDebounceTimer)
  └─ IMPL-052 (autoCloseInterval)
```

### 클러스터 F: PDF 리스너 누수
```
IMPL-023 (window-ready once)
  └─ IMPL-024 (pdf-render-complete)
       └─ IMPL-025 (배치 PDF)
```

### 클러스터 G: SSE/HTTP 정리
```
IMPL-018 (keep-alive interval res.close)
  └─ IMPL-050 (SSE 이중 정리)
       └─ IMPL-054 (mcpClose interval Map)
IMPL-019 (포트 루프 제한)
IMPL-037 (readBody 에러 로깅)
```

### 클러스터 H: 검색 엔진 견고성
```
IMPL-033 (JSON.parse try-catch)
  └─ IMPL-038 (Promise.all 개별 실패)
  └─ IMPL-046 (초기화 전 검색)
IMPL-042 (rebuild 중 search)
  └─ IMPL-015 (Worker thread) [선택적]
IMPL-014 (바이그램 CJK 제한)
```

### 클러스터 I: 기타 독립 항목
```
IMPL-003 (Find-in-page batch read/write)
IMPL-016 (Blob.size → length)
IMPL-017 (CSS transition 드래그)
IMPL-020 (mousemove rAF 가드)
IMPL-021 (IndexedDB 단일 핸들)
IMPL-022 (TOC IntersectionObserver)
IMPL-027 (debounceTimer clearTimeout)
IMPL-029 (sidebar-search 정리)
IMPL-030 (update_markdown null 체크)
IMPL-031 (export-pdf senderEntry 검증)
IMPL-032 (saveMcpFile isDestroyed)
IMPL-035 (워처 에러 핸들러 시기)
IMPL-043 (mcp-save 원자적 쓰기)
IMPL-051 (워처 null 엔트리 정리)
IMPL-053 (navigateTo 워처 정리)
```

---

## 권장 Phase 구성

### Phase 1: 즉각 효과 + 독립 수정 (Critical/High, 쉬움)
> 목표: 마우스 느려짐의 주요 원인 즉시 제거 + 간단한 크래시 방지

| IMPL ID | 원본 ID | 난이도 |
|---------|---------|--------|
| IMPL-009 | H-5 | 하 (1줄) |
| IMPL-008 | H-4 | 하 |
| IMPL-006 | H-2 | 하 |
| IMPL-034 | E-5 | 하 |
| IMPL-007 | H-3 | 하 |
| IMPL-012 | H-8 | 하 |
| IMPL-027 | M-6 | 하 |
| IMPL-016 | MEDIUM | 하 (1줄) |
| IMPL-030 | E-1 | 하 |
| IMPL-031 | E-2 | 하 |
| IMPL-032 | E-3 | 하 |
| IMPL-019 | MEDIUM | 하 |
| IMPL-020 | MEDIUM | 하 |

### Phase 2: 핵심 비동기 전환 (Critical, 중간)
> 목표: 이벤트 루프 차단의 근본 원인 제거

| IMPL ID | 원본 ID | 난이도 |
|---------|---------|--------|
| IMPL-001 | C-1+H-1+E-10 | 중 |
| IMPL-036 | E-7 | 하 (IMPL-001 완료 후) |
| IMPL-013 | MEDIUM | 하 (IMPL-001 완료 후) |

### Phase 3: 렌더러 블로킹 제거 (Critical)
> 목표: Mermaid/hljs CPU 점유 및 탭 메모리 문제 해결

| IMPL ID | 원본 ID | 난이도 |
|---------|---------|--------|
| IMPL-002 | C-2 | 중 |
| IMPL-004 | C-4 | 중 |
| IMPL-003 | C-3 | 중 |
| IMPL-005 | C-5 | 상 |
| IMPL-028 | M-7 | 중 (IMPL-005 후) |
| IMPL-045 | R-7 | 하 (IMPL-005 후) |

### Phase 4: 리소스 정리 클러스터 (High/Medium)
> 목표: 메모리 누수 및 좀비 리소스 일괄 제거

| IMPL ID | 원본 ID | 난이도 |
|---------|---------|--------|
| IMPL-026 | M-5 | 하 |
| IMPL-047 | CL-1 | 하 |
| IMPL-048 | CL-2 | 하 |
| IMPL-049 | CL-3 | 하 |
| IMPL-052 | CL-7 | 하 |
| IMPL-023 | M-1+CL-6 | 하 |
| IMPL-024 | M-2 | 하 |
| IMPL-025 | M-3+M-4 | 중 |
| IMPL-029 | M-8 | 하 |
| IMPL-018 | MEDIUM+CL-9 | 하 |
| IMPL-050 | CL-4 | 하 |
| IMPL-054 | CL-9+CL-10 | 중 |
| IMPL-035 | E-6 | 하 |
| IMPL-051 | CL-5 | 하 |
| IMPL-053 | CL-8 | 하 |

### Phase 5: 검색 엔진 견고성 (High/Medium)
> 목표: 검색 엔진 크래시 방지 및 레이스 컨디션 해결

| IMPL ID | 원본 ID | 난이도 |
|---------|---------|--------|
| IMPL-033 | E-4 | 하 |
| IMPL-038 | E-9 | 하 |
| IMPL-046 | R-8 | 중 |
| IMPL-042 | R-4 | 중 |
| IMPL-014 | MEDIUM | 중 |
| IMPL-037 | E-8 | 하 |

### Phase 6: 레이스 컨디션 강화 (High/Medium, 어려움)
> 목표: 병렬 MCP 호출 및 동시 창 조작 안정화

| IMPL ID | 원본 ID | 난이도 |
|---------|---------|--------|
| IMPL-011 | H-7 | 중 |
| IMPL-039 | R-1 | 중 |
| IMPL-040 | R-2 | 중 |
| IMPL-041 | R-3 | 중 |
| IMPL-043 | R-5 | 중 |
| IMPL-044 | R-6 | 중 |

### Phase 7: 성능 고도화 (Medium, 선택적)
> 목표: 추가 렌더러 성능 개선 및 사이드바 최적화

| IMPL ID | 원본 ID | 난이도 |
|---------|---------|--------|
| IMPL-010 | H-6 | 상 |
| IMPL-017 | MEDIUM | 하 |
| IMPL-021 | MEDIUM | 중 |
| IMPL-022 | MEDIUM | 중 |
| IMPL-015 | MEDIUM | 상 |

---

## 전체 항목 수 요약

| Phase | 항목 수 | 심각도 |
|-------|---------|--------|
| Phase 1 | 13 | HIGH+MEDIUM (독립, 쉬움) |
| Phase 2 | 3 | CRITICAL |
| Phase 3 | 6 | CRITICAL |
| Phase 4 | 15 | HIGH+MEDIUM |
| Phase 5 | 6 | HIGH+MEDIUM |
| Phase 6 | 6 | HIGH+MEDIUM |
| Phase 7 | 5 | MEDIUM |
| **합계** | **54** | — |

> 총 54개 구현 항목 (원본 ~65개 항목에서 S-1~S-8 제외 8개, 통합 4개 반영)
