# Phase 3 검증: HTTP MCP 보안 및 안정성

## 완료 체크리스트

| # | 항목 | 상태 | 증거 |
|---|------|------|------|
| 1 | Origin 헤더 차단 구현 | [ ] | curl -H "Origin: http://test" → 403 |
| 2 | CORS `*` 헤더 제거 | [ ] | curl -v 응답에 Access-Control-Allow-Origin 없음 |
| 3 | SSE 최대 5개 연결 제한 | [ ] | 6번째 연결 시 503 |
| 4 | SSE 서버 종료 시 정리 | [ ] | 앱 종료 후 타이머 누수 없음 |
| 5 | body 30초 타임아웃 | [ ] | 느린 요청 시 연결 종료 |
| 6 | 포트 파일 atomic write | [ ] | .tmp → rename 패턴 확인 |

## 테스트 결과

| TC | 테스트 | 결과 | 비고 |
|----|--------|------|------|
| TC-3-001 | 브라우저 요청 차단 | [ ] Pass / [ ] Fail | |
| TC-3-002 | CLI 정상 작동 | [ ] Pass / [ ] Fail | |
| TC-3-003 | SSE 제한 초과 | [ ] Pass / [ ] Fail | |
| TC-3-004 | Slow 요청 타임아웃 | [ ] Pass / [ ] Fail | |
| TC-3-005 | 서버 종료 SSE 정리 | [ ] Pass / [ ] Fail | |

## 회귀테스트 결과

| 항목 | 결과 | 비고 |
|------|------|------|
| curl POST (Origin 없이) | [ ] Pass / [ ] Fail | |
| Claude Code MCP 연결 | [ ] Pass / [ ] Fail | |
| `npx playwright test` | [ ] Pass / [ ] Fail | |

## 트러블슈팅

| TC 실패 | 점검 사항 | 해결 방법 |
|---------|----------|----------|
| TC-3-001 브라우저 차단 안 됨 | Origin 체크 위치 | CORS 헤더 설정보다 앞에서 Origin 체크하는지 확인 |
| TC-3-002 CLI도 차단됨 | Origin 헤더 오탐지 | curl의 기본 요청에 Origin 헤더가 포함되지 않는지 확인 (`-v` 옵션) |
| TC-3-003 SSE 제한 안 됨 | 카운터 스코프 | `sseConnectionCount` 변수가 모듈 레벨에 선언되었는지 확인 |
| TC-3-004 타임아웃 안 됨 | clearTimeout 누락 | 정상 종료 시 타이머가 정리되는지 확인 |

## 승인

- [ ] 모든 체크리스트 완료
- [ ] 모든 테스트 통과
- [ ] 회귀 없음
- **승인자**: _______________
- **승인일**: _______________
