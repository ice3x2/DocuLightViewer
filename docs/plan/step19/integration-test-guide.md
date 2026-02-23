# 통합 테스트 가이드: DocLight Step 19

## 목적

7개 신규 기능(Named Window, Append 모드, Severity 테마, Auto-close 타이머, Window 태그, Taskbar 플래시, Progress Bar)의 통합 동작과 기존 기능과의 하위 호환성을 검증한다.

## 1. MCP HTTP 서버 통합 테스트

### 1.1 사전 준비

```bash
# DocLight 앱 실행
npm start

# MCP 포트 확인
cat "%APPDATA%\doclight\mcp-port"  # Windows
# 또는 기본값: 52580
```

### 1.2 Named Window 통합 테스트 (FR-19-001)

```bash
# 신규 창 생성
curl -X POST http://localhost:52580/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"open_markdown","arguments":{"windowName":"test-win","content":"# 초기 내용"}}}'
# 예상: windowId 반환, "Opened viewer window." 포함

# 동일 이름으로 upsert
curl -X POST http://localhost:52580/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"open_markdown","arguments":{"windowName":"test-win","content":"# 갱신된 내용"}}}'
# 예상: 동일 windowId, "Updated existing window (named: test-win)." 포함
```

### 1.3 Severity + Tags 통합 테스트 (FR-19-003, FR-19-005)

```bash
# severity + tags 조합 창 생성
curl -X POST http://localhost:52580/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"open_markdown","arguments":{"content":"# 오류","severity":"error","tags":["alarm","critical"]}}}'

# tag 필터 조회
curl -X POST http://localhost:52580/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_viewers","arguments":{"tag":"alarm"}}}'
# 예상: alarm 태그 창만 반환, "(severity: error) [tags: alarm, critical]" 포함
```

### 1.4 Progress Bar 통합 테스트 (FR-19-007)

```bash
# 50% 진행률 설정
curl -X POST http://localhost:52580/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"open_markdown","arguments":{"content":"# 다운로드","progress":0.5}}}'

# 진행률 갱신 → 완료
curl -X POST http://localhost:52580/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"update_markdown","arguments":{"windowId":"<ID>","progress":1.0,"severity":"success","content":"# 완료!"}}}'

# 진행률 바 제거
curl -X POST http://localhost:52580/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"update_markdown","arguments":{"windowId":"<ID>","progress":-1}}}'
```

### 1.5 Auto-close 타이머 통합 테스트 (FR-19-004)

```bash
# 5초 후 자동 닫기
curl -X POST http://localhost:52580/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"open_markdown","arguments":{"content":"# 5초 후 닫힘","autoCloseSeconds":5}}}'
# 예상: 창 하단 카운트다운 표시 → 5초 후 창 자동 닫힘
```

### 1.6 Append 모드 통합 테스트 (FR-19-002)

```bash
# 초기 창 열기
curl -X POST http://localhost:52580/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"open_markdown","arguments":{"windowName":"log","content":"# 로그\n항목 1"}}}'

# append
curl -X POST http://localhost:52580/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"update_markdown","arguments":{"windowId":"<ID>","content":"항목 2","appendMode":true}}}'
# 예상: 창에 "# 로그\n항목 1\n\n항목 2" 렌더링됨
```

### 1.7 Tags 일괄 닫기 통합 테스트 (FR-19-005)

```bash
# temp 태그 창 2개 생성
curl -X POST http://localhost:52580/mcp ... '{"arguments":{"content":"창1","tags":["temp"]}}'
curl -X POST http://localhost:52580/mcp ... '{"arguments":{"content":"창2","tags":["temp"]}}'

# 일괄 닫기
curl -X POST http://localhost:52580/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"close_viewer","arguments":{"tag":"temp"}}}'
# 예상: "Closed 2 window(s) with tag: temp."
```

## 2. IPC 소켓 통합 테스트

stdio MCP 서버 테스트는 `npm run mcp` 로 별도 프로세스 실행 후 동일 시나리오 검증.

## 3. 병렬 알람·보고 환경 E2E 시나리오

**시나리오**: AI 에이전트가 2개 병렬 작업을 실시간 보고하며 오류 발생 시 알람 표시

```
1. open_markdown { windowName: "task-a", severity: "info", tags: ["parallel"], progress: 0.0, content: "# 작업 A: 시작" }
2. open_markdown { windowName: "task-b", severity: "info", tags: ["parallel"], progress: 0.0, content: "# 작업 B: 시작" }
3. update_markdown { windowId: A, progress: 0.5, content: "# 작업 A: 50%" }
4. update_markdown { windowId: B, progress: 0.3, content: "# 작업 B: 30%" }
5. update_markdown { windowId: B, severity: "error", flash: true, content: "# 작업 B: 오류 발생!", autoCloseSeconds: 30 }
6. update_markdown { windowId: A, progress: 1.0, severity: "success", content: "# 작업 A: 완료!" }
7. list_viewers { tag: "parallel" } → 2개 창 확인
8. close_viewer { tag: "parallel" } → 2개 창 닫힘
```

**기대 결과**: 각 단계 정상 수행, 오류 없음, 최종 창 0개

## 4. 요구사항 추적 매트릭스

| FR | 담당 Phase | 테스트 항목 | 상태 |
|----|-----------|------------|------|
| FR-19-001 Named Window | Phase 1 | upsert, 신규생성, 닫힘 정리 | [ ] |
| FR-19-002 Append 모드 | Phase 5 | 기본, 커스텀 separator, filePath 에러, 10MB | [ ] |
| FR-19-003 Severity | Phase 1 | 4종 색상, null 제거, 유효성 | [ ] |
| FR-19-004 Auto-close | Phase 4 | 타이머, 카운트다운, 재설정, 누수 없음 | [ ] |
| FR-19-005 Window Tags | Phase 3 | 필터, 일괄닫기, 검증 | [ ] |
| FR-19-006 Flash | Phase 2 | 비포그라운드, 포그라운드, Linux | [ ] |
| FR-19-007 Progress Bar | Phase 2 | 0~1, -1, 범위초과, NaN | [ ] |
