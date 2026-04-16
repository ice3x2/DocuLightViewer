# DocuLight Viewer 부수적 문제 분석 보고서

> **분석 일시**: 2026-04-16 | **분석 방법**: 5개 Haiku 서브에이전트 병렬 정밀 분석
> **분석 영역**: 메모리 누수 / 에러 처리 / 레이스 컨디션 / 리소스 정리 / 보안

---

## 종합 요약

| 분석 영역 | HIGH | MEDIUM | LOW | 합계 |
|-----------|:----:|:------:|:---:|:----:|
| 메모리 누수 | 4 | 4 | 1 | 9 |
| 에러 처리 | 5 | 5 | 3 | 13 |
| 레이스 컨디션 | 2 | 6 | 2 | 10 |
| 리소스 정리 | 7 | 3 | 2 | 12 |
| 보안 | 3 | 5 | 4 | 12 |
| **합계** | **21** | **23** | **12** | **56** |

---

## 1. 메모리 누수 패턴

### HIGH (4건)

| # | 파일 | 문제 | 수정안 |
|---|------|------|--------|
| M-1 | `index.js:1321` | PDF Export의 `window-ready` 리스너가 정상 완료 시 미정리 | `readyHandler` 내부에서 즉시 `removeListener` 호출 |
| M-2 | `index.js:1360` | `pdf-render-complete` 리스너도 동일한 패턴으로 미정리 | `completeHandler` 내부에서 `removeListener` 호출 |
| M-3 | `index.js:1458` | 배치 PDF 반복문 내에서 `window-ready` 리스너 반복 등록 — 20파일 = 40개 좀비 리스너 | 반복문 외부에서 등록 또는 반복마다 이전 리스너 정리 |
| M-4 | `index.js:1497` | 배치 PDF 반복문 내 `pdf-render-complete`도 동일 누적 | 위와 동일 |

### MEDIUM (4건)

| # | 파일 | 문제 | 수정안 |
|---|------|------|--------|
| M-5 | `viewer.js:515-738` | `cleanups` 배열에 IPC unsubscribe 함수가 push되지만 어디서도 호출되지 않음 | `beforeunload`에서 cleanups 순회 호출 |
| M-6 | `window-manager.js:149` | `debounceTimer`가 `clearTimeout` 없이 새 타이머로 덮어쓰기 | 기존 타이머 `clearTimeout` 후 새 타이머 할당 |
| M-7 | `tab-manager.js:361-371` | `renderTabBar()` 호출마다 탭 요소에 클릭 리스너 중복 등록 | 렌더링 전 이전 리스너 제거 또는 요소 재사용 |
| M-8 | `sidebar-search.js:29-62` | `addEventListener` 등록 후 정리 경로 없음 | `exitSearchMode()`에서 모든 리스너 제거 |

---

## 2. 에러 처리 공백

### HIGH (5건)

| # | 파일 | 문제 | 결과 |
|---|------|------|------|
| E-1 | `index.js:697-699` | `update_markdown` — entry null 체크 누락 | 런타임 크래시 |
| E-2 | `index.js:1243-1252` | `export-pdf` — senderEntry 검증 없이 접근 | 창 조회 실패 시 크래시 |
| E-3 | `index.js:643-661` | `saveMcpFile` 후 entry 재조회 시 소멸 확인 없음 | `entry.win.isDestroyed()` 호출 시 크래시 |
| E-4 | `search-engine.js:354-366` | `JSON.parse()` 에러 미처리 (`_loadIndex`) | 손상된 인덱스로 앱 초기화 실패 |
| E-5 | `git-info.js:50-55` | `Promise.all` 에러 조용히 무시 | 모든 git 필드 누락, 디버깅 어려움 |

### MEDIUM (5건)

| # | 파일 | 문제 | 결과 |
|---|------|------|------|
| E-6 | `window-manager.js:184-189` | 워처 에러 핸들러 등록 시기 오류 | 중복 처리 |
| E-7 | `index.js:1134-1142` | `buildSidebarTree` 에러 로깅만 | 사이드바 무음 실패 |
| E-8 | `mcp-http.mjs:358-366` | `readBody` 에러 로깅 없음 | HTTP 요청 중단 시 무음 실패 |
| E-9 | `search-engine.js:68-70` | `Promise.all + catch(null)` 패턴 | 인덱스 불완전 |
| E-10 | `link-parser.js:94-108` | `readFileSync` 실패 시 에러 로깅 없음 | frontmatter 파싱 건너뜀 (무음) |

---

## 3. 레이스 컨디션

### HIGH (2건)

| # | 파일 | 시나리오 | 결과 |
|---|------|----------|------|
| R-1 | `window-manager.js:273-295` | 동일 `windowName`으로 동시 `createWindow()` | 중복 윈도우 또는 교착 |
| R-2 | `index.js:612-662` | 병렬 `open_markdown` + `update_markdown` 동일 `windowId` | 불일치 메타데이터 |

### MEDIUM (6건)

| # | 파일 | 시나리오 | 결과 |
|---|------|----------|------|
| R-3 | `window-manager.js:149-182` | 파일 워처 콜백 중 IPC가 `lastRenderedContent` 덮어쓰기 | 상태 불일치 |
| R-4 | `search-engine.js:202-212` | `rebuild()` 중 `search()` 동시 읽기 | 불완전한 검색 결과 |
| R-5 | `mcp-save.js:99-107` | `mkdir` 후 `writeFile` 사이 동일 경로 쓰기 | 파일 손상 |
| R-6 | `index.js:1225-1245` | `isExporting` 플래그 체크-설정 간격 | 동시 내보내기 |
| R-7 | `tab-manager.js:61-72` | 탭 배열 수정 중 다른 탭 작업 | 인덱스 불일치 |
| R-8 | `search-engine.js:29-47` | `initialize()` 완료 전 검색 요청 | 불완전 인덱스 |

---

## 4. 리소스 정리 누락

### HIGH (7건)

| # | 파일 | 누수 자원 | 수정안 |
|---|------|----------|--------|
| CL-1 | `viewer.js:880-888` | 컨텍스트 메뉴 리스너 `beforeunload` 미포함 | cleanup 배열에 추가 |
| CL-2 | `viewer.js:1487` | `window.resize` 리스너 cleanup 미포함 | cleanup 배열에 추가 |
| CL-3 | `viewer.js:77` | `findDebounceTimer` `beforeunload` 미정리 | cleanup에 `clearTimeout` 추가 |
| CL-4 | `mcp-http.mjs:443` | SSE 커넥션 비정상 종료 시 정리 불완전 | `res.on('close')` + `res.on('finish')` 이중 정리 |
| CL-5 | `window-manager.js:192` | 파일 워처 에러 후 맵에 null 엔트리 잔존 | `.delete(windowId)` |
| CL-6 | `index.js:1307-1321` | PDF `window-ready` 리스너 정상 완료 시 미제거 | `ipcMain.once()` 사용 |
| CL-7 | `viewer.js:706-735` | `_autoCloseInterval` `beforeunload` 미정리 | cleanup에 `clearInterval` 추가 |

### MEDIUM (3건)

| # | 파일 | 누수 자원 | 수정안 |
|---|------|----------|--------|
| CL-8 | `window-manager.js:965-997` | `navigateTo` 이전 파일 워처 미정리 | `stopFileWatcher()` 선행 호출 |
| CL-9 | `mcp-http.mjs:491-494` | keep-alive interval disconnect 없이 GC 시 무한 실행 | `res.on('close')` 정리 추가 |
| CL-10 | `mcp-http.mjs:657-663` | `_mcpClose()`에서 keep-alive interval `clearInterval` 미호출 | interval Map으로 변경 후 명시적 정리 |

---

## 5. 보안 및 입력 검증

### HIGH (3건)

| # | 파일 | 취약점 | 공격 시나리오 |
|---|------|--------|-------------|
| S-1 | `index.js:1842-1877` | `read-image-as-data-url` 경로 통과 미검증 | `../../../etc/passwd` → 민감 파일 접근 |
| S-2 | `window-manager.js:945-998` | `navigateTo` 경로 탈출 미검증 | `../../sensitive.md` → 의도하지 않은 파일 접근 |
| S-3 | `mcp-server.mjs:201` | `DOCLIGHT_APP_PATH` 환경변수 검증 없이 `spawn()` | 환경변수 조작 → 임의 명령 실행 |

### MEDIUM (5건)

| # | 파일 | 취약점 | 공격 시나리오 |
|---|------|--------|-------------|
| S-4 | `link-parser.js:169-204` | URL 디코딩 후 `../` 경로 탈출 미검증 | `%2e%2e%2f` 인코딩 우회 |
| S-5 | `git-info.js:16-24` | `projectPath` 추가 검증 부족 | 악의적 경로로 git 명령 오류 유도 |
| S-6 | `index.js:1715-1744` | `save-as` 반환 경로 검증 없이 `copyFile()` | 심볼릭 링크 → 보호 파일 덮어쓰기 |
| S-7 | `index.js:704` | 자동 저장 TOCTOU 경쟁 | 검증-쓰기 간 심볼릭 링크 삽입 |
| S-8 | `index.js:953-957` | `navigate-to` IPC 렌더러 XSS 시 악용 | XSS → 임의 파일 네비게이션 |
