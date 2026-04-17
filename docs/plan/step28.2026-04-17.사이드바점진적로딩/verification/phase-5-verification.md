# Phase 5 검증 문서

## 검증 항목

- [ ] `test/sidebar-async.e2e.js` 신규 파일 존재
- [ ] 시나리오 1~6 (대용량/전환/캐시/TTL/회귀) 모두 통과
- [ ] 기존 `npx playwright test` 전체 스위트 통과
- [ ] DevTools Performance에서 메인 스레드 Long Task(>50ms) 수가 기존 대비 대폭 감소
- [ ] 수동 체감 UX: 스피너 즉시 표시, 리스트 점진적 채움

## 성능 지표 체크

| 지표 | 목표 | 실측 | 통과 |
|------|------|------|------|
| 스피너 표시까지 | ≤ 200ms | | |
| 첫 배치 DOM 추가 | ≤ 2초 | | |
| 폴더 전환 → abort 반영 | ≤ 300ms | | |
| 캐시 히트 렌더 | ≤ 150ms | | |

## 증거 수집 명령

```bash
npx playwright test test/sidebar-async.e2e.js --reporter=line
npx playwright test  # 전체 회귀
```

## 합격 기준

- 신규 E2E 6/6 통과
- 기존 E2E 회귀 없음
- 성능 지표 4/4 달성
