# Phase 2 검증: 검색 엔진 안정성

## 완료 체크리스트

| # | 항목 | 상태 | 증거 |
|---|------|------|------|
| 1 | `_rebuildPromise` mutex 구현 | [ ] | search-engine.js 코드 확인 |
| 2 | 동시 ensureFresh 시 단일 rebuild | [ ] | 로그에서 rebuild 1회만 확인 |
| 3 | rebuild 중 dirty 재설정 방지 | [ ] | 코드 리뷰 확인 |
| 4 | 인덱스 손상 시 dirty=true 설정 | [ ] | 손상 파일로 테스트 |
| 5 | update_markdown 자동 저장 | [ ] | 저장 파일 생성 확인 |
| 6 | update 후 searchEngine.markDirty() | [ ] | 검색 결과에 반영 확인 |
| 7 | _scanMarkdownFiles 깊이 제한 | [ ] | 11단계 디렉토리 테스트 |
| 8 | rebuild 병렬 파일 읽기 | [ ] | BATCH_SIZE=20 확인 |

## 테스트 결과

| TC | 테스트 | 결과 | 비고 |
|----|--------|------|------|
| TC-2-001 | 동시 검색 중복 rebuild 방지 | [ ] Pass / [ ] Fail | |
| TC-2-002 | rebuild 중 markDirty | [ ] Pass / [ ] Fail | |
| TC-2-003 | 손상 인덱스 자동 복구 | [ ] Pass / [ ] Fail | |
| TC-2-004 | update 후 검색 반영 | [ ] Pass / [ ] Fail | |
| TC-2-005 | 깊은 디렉토리 스캔 | [ ] Pass / [ ] Fail | |

## 회귀테스트 결과

| 항목 | 결과 | 비고 |
|------|------|------|
| `npx playwright test` | [ ] Pass / [ ] Fail | |
| `search_documents` MCP 호출 | [ ] Pass / [ ] Fail | |
| `search_projects` MCP 호출 | [ ] Pass / [ ] Fail | |
| `open_markdown` + `update_markdown` | [ ] Pass / [ ] Fail | |

## 트러블슈팅

| TC 실패 | 점검 사항 | 해결 방법 |
|---------|----------|----------|
| TC-2-001 중복 rebuild | `_rebuildPromise` 할당 시점 | `ensureFresh()` 진입 시 즉시 Promise 저장하는지 확인 |
| TC-2-003 손상 복구 안 됨 | `dirty = true` 누락 | `initialize()` catch 블록에 `this.dirty = true` 확인 |
| TC-2-004 update 저장 안 됨 | `saveMcpFile` 호출 누락 | `index.js` `update_markdown` 핸들러에 저장 로직 존재 확인 |
| TC-2-005 깊이 제한 안 됨 | `depth` 매개변수 전달 누락 | 재귀 호출 시 `depth + 1` 전달 확인 |

## 승인

- [ ] 모든 체크리스트 완료
- [ ] 모든 테스트 통과
- [ ] 회귀 없음
- **승인자**: _______________
- **승인일**: _______________
