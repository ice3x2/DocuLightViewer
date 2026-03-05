# 통합 테스트 가이드

**실행 시점**: 모든 Phase 완료 후
**목적**: Phase 간 교차 영향 검증 및 전체 시스템 E2E 동작 확인

---

## 1. 핵심 비즈니스 플로우 (CRITICAL)

### E2E-001: MCP stdio → 문서 열기 → 검색 전체 흐름

**우선순위**: CRITICAL

**Given**:
- DocuLight Electron 앱 실행 중
- MCP stdio 서버(번들 버전) 별도 프로세스로 실행

**When**:
1. stdio MCP로 `open_markdown(windowName: "test", content: "# Integration Test\nHello World", project: "test-project")` 호출
2. stdio MCP로 `update_markdown(windowId: <위 결과>, content: "# Updated\nHello Universe", appendMode: false)` 호출
3. stdio MCP로 `search_documents(query: "Universe")` 호출
4. stdio MCP로 `close_viewer(windowId: <위 결과>)` 호출

**Then**:
- Step 1: 창 1개 생성, windowId 반환, 자동 저장 파일 생성
- Step 2: 내용 업데이트, 자동 저장 파일 갱신 (Phase 2 반영)
- Step 3: "Universe" 검색 시 해당 문서 반환
- Step 4: 창 정상 닫힘, `list_viewers` 빈 목록

### E2E-002: HTTP MCP → 보안 + 기능 통합

**우선순위**: CRITICAL

**Given**:
- DocuLight Electron 앱 실행 중 (HTTP MCP 서버 :52580 활성)

**When**:
1. `curl -H "Origin: http://evil.com" POST http://localhost:52580/mcp` → 브라우저 차단 확인
2. `curl POST http://localhost:52580/mcp` (Origin 없이) → `open_markdown` 호출
3. `curl POST http://localhost:52580/mcp` → `list_viewers` 호출
4. `curl POST http://localhost:52580/mcp` → `close_viewer` 호출

**Then**:
- Step 1: 403 응답 (Phase 3 반영)
- Step 2: 200 응답, windowId 반환
- Step 3: 200 응답, 열린 창 목록
- Step 4: 200 응답, 창 닫힘

---

## 2. Named Window + 동시성 (HIGH)

### E2E-003: 동일 이름 동시 요청 + IPC 재연결

**우선순위**: HIGH

**Given**:
- DocuLight 실행 중
- MCP stdio 서버 연결 상태

**When**:
1. 동시에 2개의 `open_markdown(windowName: "status")` 요청 전송
2. Electron 앱 재시작 (IPC 소켓 끊김 시뮬레이션)
3. 재시작 후 `open_markdown(windowName: "status")` 호출

**Then**:
- Step 1: 창 1개만 생성 (Phase 4 반영), 두 번째는 upsert
- Step 2: IPC 소켓 끊김 감지, pending 요청 reject
- Step 3: 자동 재연결 후 기존 "status" 창 upsert (Phase 4 반영)

---

## 3. 패키징 + 번들 통합 (HIGH)

### E2E-004: 패키징된 앱 MCP stdio 서버 실행

**우선순위**: HIGH

**Given**:
- `npm run build:win` 완료
- 설치된 앱에서 DocuLight 실행 중

**When**:
1. `node <설치경로>/resources/app.asar.unpacked/src/main/mcp-server.bundle.cjs` 실행
2. Claude Desktop config에 위 경로 설정 후 MCP tool 호출

**Then**:
- Step 1: 번들이 단독 실행, IPC 연결 성공
- Step 2: Claude Desktop에서 `open_markdown` 정상 작동
- 인스톨러에 `node_modules` unpack 없음 (Phase 1 반영)

---

## 4. 검색 엔진 + 인덱스 복구 통합 (MEDIUM)

### E2E-005: 인덱스 손상 → 자동 복구 → 검색

**우선순위**: MEDIUM

**Given**:
- mcpAutoSave 활성화, 기존 문서 저장됨
- 인덱스 파일을 의도적으로 손상 (잘못된 JSON 기록)

**When**:
1. DocuLight 앱 재시작
2. `search_documents(query: "test")` 호출

**Then**:
- Step 1: 인덱스 로드 실패 → `dirty = true` 설정 (Phase 2 반영)
- Step 2: `ensureFresh()` → 자동 `rebuild()` → 검색 결과 정상 반환

---

## 5. 코드 품질 통합 (MEDIUM)

### E2E-006: 공유 모듈 양방향 동작

**우선순위**: MEDIUM

**Given**:
- `mcp-save.js` 공유 모듈 적용 완료

**When**:
1. stdio MCP로 `open_markdown` 호출 → 자동 저장
2. HTTP MCP로 `open_markdown` 호출 → 자동 저장
3. 두 저장 파일의 경로/형식 비교

**Then**:
- 양쪽 저장 파일이 동일한 경로 패턴 (`{date}/{timestamp}_{title}.md`)
- 동일한 frontmatter 형식
- `mcp-save.js`의 단일 구현에서 처리

---

## 컴포넌트 통합 매트릭스

| 컴포넌트 A | 컴포넌트 B | 통합 포인트 | 검증 방법 |
|-----------|-----------|-----------|----------|
| mcp-server.bundle.cjs | index.js (IPC) | IPC 소켓 ndjson | E2E-001, E2E-004 |
| mcp-http.mjs | index.js | 직접 함수 호출 | E2E-002 |
| mcp-save.js | index.js | require import | E2E-006 |
| mcp-save.js | mcp-http.mjs | createRequire import | E2E-006 |
| search-engine.js | index.js (IPC) | ensureFresh + search | E2E-001, E2E-005 |
| window-manager.js | index.js (IPC) | createWindow + nameToId | E2E-003 |
| electron-builder.yml | mcp-server.bundle.cjs | asarUnpack | E2E-004 |

---

## 요구사항 추적 매트릭스

| 이슈 # | 검증 E2E 시나리오 |
|--------|------------------|
| 1 | E2E-004 (패키징 후 번들 경로) |
| 2 | E2E-004 (번들 내 zod 포함) |
| 3 | E2E-002 (Origin 차단) |
| 4 | README 직접 확인 |
| 5 | E2E-001 Step 3 (동시 검색) |
| 6 | E2E-001 Step 2-3 (update 후 검색) |
| 7 | E2E-003 (동시 named window) |
| 8 | E2E-005 (인덱스 복구) |
| 9 | E2E (Linux 빌드 아이콘) — CI/수동 |
| 10 | E2E-002 (SSE 제한 — 수동) |
| 11 | E2E (macOS 빌드) — CI/수동 |
| 12 | E2E-003 (IPC 재연결) |
| 13 | E2E-006 (공유 모듈) |
| 14 | E2E-004 (shebang) |
| 15 | 수동 검증 (dev 환경) |
| 16-20 | 수동/단위 검증 |
