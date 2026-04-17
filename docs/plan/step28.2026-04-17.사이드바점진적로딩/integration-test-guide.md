# 통합 테스트 가이드 — step28

## 테스트 전략 요약

| 레벨 | 위치 | 도구 |
|------|------|------|
| Unit (link-parser) | `test/test-link-tree.js` | Node.js 직접 실행 |
| E2E (Electron) | `test/sidebar-async.e2e.js` (신규) | Playwright |
| 수동 탐색 테스트 | — | 실제 Downloads 폴더 |

## 실행 순서

```bash
# 1. Unit smoke
node test/test-link-tree.js

# 2. E2E 신규
npx playwright test test/sidebar-async.e2e.js

# 3. 회귀 전체
npx playwright test
```

## 테스트 환경 전제

- **step27 Phase 2 (IMPL-001) 완료** 상태에서 시작
- 각 테스트 실행 전 DocuLight 앱 완전 종료 (EADDRINUSE 회피)
- Playwright `workers: 1` 직렬 유지

## 시나리오 인덱스

상세 시나리오는 `05.phase-5-통합검증.md`를 참조.

1. 대용량 폴더 스피너 표시 (500 파일)
2. 연속 폴더 전환 (abort 반영)
3. 캐시 히트 (5분 이내)
4. 캐시 TTL 만료 (6분 후)
5. 회귀 - 소규모 폴더
6. 회귀 - 링크 기반 트리

## 테스트 데이터 관리

- tmp 디렉토리 기반 자동 생성/정리
- 실제 Downloads 디렉토리에 의존하는 테스트 금지
- Playwright fixtures로 setup/teardown 공유 가능

## 알려진 주의사항

- Electron 테스트는 macOS에서 sandbox 설정에 따라 파일 권한 다름 → CI에서 tmpdir 사용 권장
- Windows에서 경로 구분자는 `path.join` 사용 (직접 `/` 금지)
