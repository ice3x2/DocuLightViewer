# 통합 테스트 가이드 — step29

## 테스트 전략 요약

| 레벨 | 위치 | 도구 |
|------|------|------|
| Unit (Node) | 기존 `test/test-*.js` (회귀만) | Node.js 직접 실행 |
| Manual (수동) | 실제 DocuLight 실행 | `npm start` 후 DevTools |
| E2E (선택) | `test/sidebar-toggle-all.e2e.js` (신규, 선택사항) | Playwright |

## 실행 순서

```bash
# 1. 회귀 (Phase 1~3 완료 시마다)
node test/test-link-tree.js
node test/test-link-tree-build.js
node test/test-sidebar-tree.js
node test/test-batch-streaming.js

# 2. 구문 확인
node --check src/renderer/viewer.js

# 3. 수동 체감 (개발 모드)
npm start
# → 사이드바 열고 버튼 동작, disabled 조건, i18n 확인

# 4. (선택) Playwright E2E — DocuLight 종료 후 실행
npx playwright test test/sidebar-toggle-all.e2e.js --reporter=line
```

## 테스트 환경 전제

- Phase 1~3 순차 구현 완료
- step28 Phase 2까지 반영된 최신 main 브랜치
- Node 20 + Electron 33.4.x
- Playwright E2E 실행 시 기존 DocuLight 인스턴스 종료 (시스템 트레이 → 종료)

## 시나리오 인덱스

상세 시나리오는 각 Phase 문서 "테스트 시나리오" 섹션 참조:

1. Phase 1: HTML/CSS/i18n 부팅 정상 + disabled 기본값
2. Phase 2:
   - 정상: AC-001/002/003/007
   - 예외: AC-004/005/006
   - 경계: AC-012, 가상 디렉토리, 500노드 성능
3. Phase 3: 수동 수용조건 AC-001~013 + 회귀 4건

## 테스트 데이터 관리

- 임시 폴더는 `os.tmpdir()` + `fs.mkdtempSync('dl-step29-')` 기반
- 실제 Downloads 디렉토리 의존 금지
- Playwright E2E fixtures로 setup/teardown 공유 가능 (기존 `sidebar-async.e2e.js` 패턴 재사용)

## 알려진 주의사항

- **Mock 금지** (본 프로젝트 테스트 관행): 파일 시스템은 실제 tmpdir 사용, 검색 모드는 실제 `Ctrl+Shift+F` 트리거 또는 CustomEvent 직접 dispatch
- **Windows CRLF**: 테스트 파일 LF로 유지(`.gitattributes` 준수)
- **DocuLight 중복 실행**: IPC 소켓·HTTP 포트 충돌로 Playwright가 실패할 수 있음 → 반드시 종료 후 실행
