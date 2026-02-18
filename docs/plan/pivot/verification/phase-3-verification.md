# Phase 3 검증: MCP Bridge Process

검증일: ____-__-__
검증자: ________________

## 참조 문서

- 구현 계획: [03.phase-3-mcp-bridge.md](../03.phase-3-mcp-bridge.md)
- SRS: [srs.pivot.md](../../srs.pivot.md) (FR-P-002)
- 아키텍처: [00-1.architecture.md](../00-1.architecture.md) Section 3.3, 4.1

---

## 1. MCP 서버 시작 검증

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 1 | [ ] `node src/main/mcp-server.js` 실행 성공 | 프로세스 시작, stderr 확인 | 에러 없이 시작 | |
| 2 | [ ] StdioServerTransport 초기화 | stdin/stdout 파이프 확인 | stdin 읽기 대기 상태 | |
| 3 | [ ] 서버 이름: `"doclight"` | MCP initialize 응답 확인 | `name: "doclight"` | |
| 4 | [ ] 서버 버전: `"1.0.0"` | MCP initialize 응답 확인 | `version: "1.0.0"` | |
| 5 | [ ] 디버그 로그가 stderr로 출력 | stderr 캡처 | console.error로 로깅 (stdout 오염 없음) | |

---

## 2. MCP 도구 등록 및 발견 검증

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 6 | [ ] `open_markdown` 도구 등록 | `tools/list` JSON-RPC 요청 | 도구 목록에 포함 | |
| 7 | [ ] `update_markdown` 도구 등록 | `tools/list` JSON-RPC 요청 | 도구 목록에 포함 | |
| 8 | [ ] `close_viewer` 도구 등록 | `tools/list` JSON-RPC 요청 | 도구 목록에 포함 | |
| 9 | [ ] `list_viewers` 도구 등록 | `tools/list` JSON-RPC 요청 | 도구 목록에 포함 | |
| 10 | [ ] 도구 스키마가 SRS와 일치 | 각 도구의 inputSchema 확인 | JSON Schema 구조 일치 | |
| 11 | [ ] `open_markdown` — `anyOf: [content, filePath]` | 스키마 확인 | 필수 조건 존재 | |
| 12 | [ ] `update_markdown` — `required: [windowId]` | 스키마 확인 | windowId 필수 | |

---

## 3. IPC 소켓 연결 검증

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 13 | [ ] Electron 앱 실행 중 Bridge → 소켓 연결 성공 | 양쪽 프로세스 실행 후 로그 | "Connected to Electron" 로그 | |
| 14 | [ ] ndjson 프레이밍으로 요청 전송 | 네트워크 트래픽 확인 | `JSON + \n` 형식 | |
| 15 | [ ] ndjson 프레이밍으로 응답 수신 | 네트워크 트래픽 확인 | `JSON + \n` 형식 파싱 | |
| 16 | [ ] 요청 ID (UUID) 기반 응답 매칭 | 코드 검사 + 테스트 | `pendingRequests` Map 사용 | |
| 17 | [ ] 여러 요청 동시 전송 시 정상 매칭 | 3개 요청 빠르게 전송 | 각각 올바른 응답 수신 | |

### SRS 매핑: T-35 (IPC 소켓 통신), T-59 (ndjson 프레이밍)

---

## 4. open_markdown 도구 검증

### 4.1 content 모드

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 18 | [ ] `open_markdown({content: "# Hello"})` | MCP tools/call | 새 뷰어 창 열림, Markdown 렌더링 | |
| 19 | [ ] 반환값에 `windowId` 포함 | 응답 확인 | UUID v4 형식 | |
| 20 | [ ] 반환값에 `title` 포함 | 응답 확인 | "Hello" (H1 텍스트) | |
| 21 | [ ] content 모드에서 사이드바 없음 | 창 UI 확인 | 사이드바 완전 숨김 | |

### SRS 매핑: T-03 (content 모드)

### 4.2 filePath 모드

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 22 | [ ] `open_markdown({filePath: "/path/to/doc.md"})` | MCP tools/call | 파일 내용을 새 창에 표시 | |
| 23 | [ ] 파일 읽기 및 렌더링 | 창 내용 확인 | Markdown 정상 렌더링 | |
| 24 | [ ] filePath 기준 사이드바 활성화 | 링크 있는 문서 열기 | 사이드바 트리 표시 | |

### SRS 매핑: T-04 (filePath 모드)

### 4.3 foreground 모드

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 25 | [ ] `open_markdown({content: "...", foreground: true})` | MCP tools/call | always-on-top 창 | |
| 26 | [ ] 다른 창 위에 항상 표시 | 다른 앱 활성화 후 확인 | 뷰어 창이 최상위 유지 | |

### SRS 매핑: T-05 (foreground=true)

### 4.4 에러 케이스

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 27 | [ ] content+filePath 모두 없음 | 빈 params 전송 | `isError: true`, "content 또는 filePath 중 하나는 필수" | |
| 28 | [ ] 존재하지 않는 filePath | 잘못된 경로 전송 | `isError: true`, "파일을 찾을 수 없습니다" | |
| 29 | [ ] .md가 아닌 filePath | `.txt` 파일 경로 전송 | `isError: true`, "Markdown 파일만 지원합니다" | |
| 30 | [ ] content 10MB 초과 | 10MB+1byte 전송 | `isError: true`, "content 크기가 10MB를 초과" | |
| 31 | [ ] 창 20개 초과 | 21번째 open_markdown | `isError: true`, "최대 뷰어 창 수(20개)" | |

### SRS 매핑: T-06, T-07, T-38, T-39, T-46

---

## 5. update_markdown 도구 검증

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 32 | [ ] 유효한 windowId로 content 갱신 | 기존 창 windowId + 새 content | 기존 창 내용 교체, 스크롤 리셋 | |
| 33 | [ ] 유효한 windowId로 filePath 갱신 | 기존 창 windowId + 새 filePath | 새 파일 내용으로 교체 | |
| 34 | [ ] 잘못된 windowId | 존재하지 않는 ID 전송 | `isError: true`, "해당 windowId의 창을 찾을 수 없습니다" | |
| 35 | [ ] content+filePath 동시 제공 | 두 파라미터 모두 전송 | content 렌더링 + filePath 기준 사이드바 | |
| 36 | [ ] 창 제목 갱신 | title 파라미터 포함 | 창 제목 변경 확인 | |

### SRS 매핑: T-25, T-26, T-44

---

## 6. close_viewer 도구 검증

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 37 | [ ] 특정 windowId로 닫기 | 유효한 ID 전송 | 해당 창만 닫힘 | |
| 38 | [ ] windowId 없이 전체 닫기 | 빈 params 전송 | 모든 뷰어 창 닫힘 | |
| 39 | [ ] 잘못된 windowId | 존재하지 않는 ID | `isError: true` | |
| 40 | [ ] 열린 창 없을 때 전체 닫기 | 창 0개 상태에서 호출 | "닫을 뷰어 창이 없습니다" | |

### SRS 매핑: T-08, T-09

---

## 7. list_viewers 도구 검증

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 41 | [ ] 창 2개 열린 상태에서 목록 조회 | list_viewers 호출 | "열린 뷰어: 2개" + 상세 목록 | |
| 42 | [ ] always-on-top 표시 | foreground 창 포함 시 | "(always-on-top)" 태그 표시 | |
| 43 | [ ] 창 없을 때 조회 | 창 0개 상태에서 호출 | "열린 뷰어: 0개" | |

### SRS 매핑: T-10, T-27

---

## 8. 타임아웃 및 연결 복구 검증

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 44 | [ ] 10초 타임아웃 (Electron 미응답) | Electron 앱 의도적 지연 | "DocLight 앱이 응답하지 않습니다. (타임아웃: 10초)" | |
| 45 | [ ] Electron 미실행 시 자동 실행 시도 | Electron 종료 후 MCP 호출 | 앱 자동 시작 시도 | |
| 46 | [ ] 소켓 재연결 (500ms 간격, 최대 10회) | 코드 검사 + 테스트 | RECONNECT_INTERVAL, MAX_RETRIES 준수 | |
| 47 | [ ] 연결 실패 시 에러 반환 | Electron 없이 11회 시도 | "DocLight 앱에 연결할 수 없습니다" | |
| 48 | [ ] IPC 소켓 연결 끊김 후 재연결 | Electron 재시작 후 Bridge 재시작 | 소켓 재연결 성공 | |

### SRS 매핑: T-36, T-48, T-60

---

## 9. Graceful Shutdown 검증

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 49 | [ ] stdin EOF 시 프로세스 종료 | stdin 파이프 닫기 | MCP 서버 프로세스 정상 종료 | |
| 50 | [ ] 진행 중 IPC 요청 최대 5초 대기 | 요청 중 stdin EOF | 대기 후 종료 | |
| 51 | [ ] IPC 소켓 연결 close() 호출 | 종료 시퀀스 확인 | 소켓 정리 완료 | |
| 52 | [ ] process.exit(0) 반환 | 종료 코드 확인 | exit code 0 | |

---

## 10. 검증 결과 요약

| 항목 | 전체 | 통과 | 실패 | 미검증 |
|------|------|------|------|--------|
| MCP 서버 시작 | 5 | | | |
| 도구 등록/발견 | 7 | | | |
| IPC 소켓 연결 | 5 | | | |
| open_markdown | 14 | | | |
| update_markdown | 5 | | | |
| close_viewer | 4 | | | |
| list_viewers | 3 | | | |
| 타임아웃/연결 복구 | 5 | | | |
| Graceful Shutdown | 4 | | | |
| **합계** | **52** | | | |

### 최종 판정

- [ ] **PASS**: 모든 검증 항목 통과
- [ ] **FAIL**: 실패 항목 존재 -> 수정 후 재검증 필요

실패 항목 (있을 경우):

| # | 항목 | 실패 사유 | 수정 조치 |
|---|------|-----------|-----------|
| | | | |
