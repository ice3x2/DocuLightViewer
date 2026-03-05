# Phase 5 검증: 코드 품질 + 문서 정비

## 완료 체크리스트

| # | 항목 | 상태 | 증거 |
|---|------|------|------|
| 1 | `mcp-save.js` 모듈 생성 | [ ] | 파일 존재 확인 |
| 2 | `index.js` 중복 코드 제거 | [ ] | saveMcpFile/sanitize 함수 삭제, require 추가 |
| 3 | `mcp-http.mjs` 중복 코드 제거 | [ ] | 3개 함수 삭제, createRequire 추가 |
| 4 | README Linux 경로 수정 | [ ] | AppImage 주의사항 추가 확인 |
| 5 | README 번들 확장자 반영 | [ ] | `.bundle.cjs` 경로 확인 |
| 6 | Dev auto-launch 타임아웃 증가 | [ ] | MAX_RETRIES=20 확인 |

## 테스트 결과

| TC | 테스트 | 결과 | 비고 |
|----|--------|------|------|
| TC-5-001 | 공유 모듈 저장 동작 | [ ] Pass / [ ] Fail | |
| TC-5-002 | mcp-http에서 공유 모듈 | [ ] Pass / [ ] Fail | |
| TC-5-003 | noSave 파라미터 | [ ] Pass / [ ] Fail | |
| TC-5-004 | AppImage HTTP 연결 | [ ] Pass / [ ] Fail | |
| TC-5-005 | Dev auto-launch 10초 대기 | [ ] Pass / [ ] Fail | |

## 회귀테스트 결과

| 항목 | 결과 | 비고 |
|------|------|------|
| `npx playwright test` | [ ] Pass / [ ] Fail | |
| stdio + HTTP 자동 저장 | [ ] Pass / [ ] Fail | |
| `search_documents` | [ ] Pass / [ ] Fail | |
| `npm run mcp` | [ ] Pass / [ ] Fail | |

## 트러블슈팅

| TC 실패 | 점검 사항 | 해결 방법 |
|---------|----------|----------|
| TC-5-001 저장 실패 | `mcp-save.js` require 경로 | `index.js`의 `require('./mcp-save')` 경로가 올바른지 확인 |
| TC-5-002 HTTP 저장 실패 | `createRequire` import 경로 | `mcp-http.mjs`의 `_require('./mcp-save')` 경로 확인 |
| TC-5-003 noSave 무시됨 | `saveMcpFile` 내 noSave 분기 | 함수 첫 줄의 `if (opts.noSave) return null` 확인 |
| TC-5-005 auto-launch 타임아웃 | MAX_RETRIES 값 | `mcp-server.mjs`의 `MAX_RETRIES = 20` 확인 |

## 승인

- [ ] 모든 체크리스트 완료
- [ ] 모든 테스트 통과
- [ ] 회귀 없음
- **승인자**: _______________
- **승인일**: _______________
