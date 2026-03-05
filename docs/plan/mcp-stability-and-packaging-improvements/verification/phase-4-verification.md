# Phase 4 검증: 윈도우 매니저 동시성 + IPC 복원력

## 완료 체크리스트

| # | 항목 | 상태 | 증거 |
|---|------|------|------|
| 1 | `_pendingNames` Set 구현 | [ ] | window-manager.js 코드 확인 |
| 2 | 동시 named window 잠금 동작 | [ ] | 동일 이름 동시 요청 시 1개만 생성 |
| 3 | finally 블록 잠금 해제 | [ ] | 에러 발생 시에도 잠금 해제 확인 |
| 4 | IPC `_connectPromise` 중복 방지 | [ ] | mcp-server.mjs 코드 확인 |
| 5 | IPC write 실패 시 1회 재시도 | [ ] | 소켓 끊김 후 재연결+재시도 확인 |

## 테스트 결과

| TC | 테스트 | 결과 | 비고 |
|----|--------|------|------|
| TC-4-001 | 동일 windowName 동시 요청 | [ ] Pass / [ ] Fail | |
| TC-4-002 | named window 생성 후 즉시 update | [ ] Pass / [ ] Fail | |
| TC-4-003 | IPC 끊김 후 자동 재연결 | [ ] Pass / [ ] Fail | |
| TC-4-004 | 동시 연결 시도 통합 | [ ] Pass / [ ] Fail | |
| TC-4-005 | _pendingNames 타임아웃 | [ ] Pass / [ ] Fail | |

## 회귀테스트 결과

| 항목 | 결과 | 비고 |
|------|------|------|
| `npx playwright test` | [ ] Pass / [ ] Fail | |
| Named window open/update | [ ] Pass / [ ] Fail | |
| MCP stdio 연결/끊김/재연결 | [ ] Pass / [ ] Fail | |
| `list_viewers` | [ ] Pass / [ ] Fail | |

## 트러블슈팅

| TC 실패 | 점검 사항 | 해결 방법 |
|---------|----------|----------|
| TC-4-001 중복 창 생성 | `_pendingNames.add()` 시점 | `getWindowByName()` 체크 후 즉시 add 하는지 확인 |
| TC-4-003 재연결 실패 | Electron 앱 미실행 | `autoLaunchElectron()` 경로가 올바른지, 앱 시작 로그 확인 |
| TC-4-004 다중 연결 시도 | `_connectPromise` 할당 | connectToElectron 진입 시 즉시 Promise 저장하는지 확인 |
| TC-4-005 잠금 해제 안 됨 | finally 블록 누락 | `createWindow()`의 try/finally 구조 확인 |

## 승인

- [ ] 모든 체크리스트 완료
- [ ] 모든 테스트 통과
- [ ] 회귀 없음
- **승인자**: _______________
- **승인일**: _______________
