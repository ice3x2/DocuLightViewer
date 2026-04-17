# Phase 3 검증 문서

## 검증 항목

### 수동 수용조건 (AC-001 ~ AC-013)

- [ ] AC-001 기본 접기
- [ ] AC-002 기본 펼치기
- [ ] AC-003 혼합 상태 1회 해소
- [ ] AC-004 검색 모드 disabled + 해제 시 재활성
- [ ] AC-005 로딩 중 disabled + 완료 시 재활성
- [ ] AC-006 트리 부재 disabled
- [ ] AC-007 가상 디렉토리 포함
- [ ] AC-008 세션 내 유지 (파일 전환 시 초기화)
- [ ] AC-009 i18n 4개 로케일 표시 확인
- [ ] AC-010 500노드에서 50ms 이내
- [ ] AC-011 접근성 (tab 포커스 + 스크린 리더 낭독)
- [ ] AC-012 복합 상태(검색+로딩) 우선순위
- [ ] AC-013 최악 성능 200ms 이내 (측정 가능 시)

### 회귀 (MANDATORY)

- [ ] `node test/test-link-tree.js` PASS
- [ ] `node test/test-link-tree-build.js` PASS
- [ ] `node test/test-sidebar-tree.js` PASS
- [ ] `node test/test-batch-streaming.js` PASS (8/8)
- [ ] `node --check src/renderer/viewer.js` OK
- [ ] `npm start` 부팅 후 DevTools Console 에러 0건

### 선택 (Playwright E2E)

- [ ] `test/sidebar-toggle-all.e2e.js` 작성 여부
- [ ] `npx playwright test test/sidebar-toggle-all.e2e.js` PASS
- [ ] `npx playwright test` 전체 회귀 없음

## 증거 수집 명령

```bash
# 전체 회귀
node test/test-link-tree.js && \
node test/test-link-tree-build.js && \
node test/test-sidebar-tree.js && \
node test/test-batch-streaming.js && \
echo "REGRESSION ALL PASS"

# 선택 E2E (DocuLight 종료 필요)
npx playwright test test/sidebar-toggle-all.e2e.js --reporter=line
```

## 합격 기준

- 필수: 회귀 4건 PASS + AC-001/002/003/004/005/006/009 수동 통과
- 권장: AC-007/008/010/011/012 수동 확인
- 선택: AC-013 측정, Playwright E2E 자동화
