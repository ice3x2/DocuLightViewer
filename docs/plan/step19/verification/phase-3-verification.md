# Phase 3 검증: Window 태그

## 완료 체크리스트

### 구현 완료 확인
- [ ] `open_markdown { tags: [...] }` → `meta.tags` 저장
- [ ] `update_markdown { tags: [...] }` → meta.tags 전체 교체
- [ ] `list_viewers { tag: "X" }` → 해당 태그 창만 반환
- [ ] `list_viewers` (tag 없음) → 전체 창 반환 (기존 동작)
- [ ] `close_viewer { tag: "X" }` → 해당 태그 모든 창 닫힘
- [ ] `close_viewer { tag: "X" }` 해당 창 없음 → 에러 아닌 정상 응답
- [ ] tags 10개 초과 → isError
- [ ] 태그 항목 64자 초과 → isError
- [ ] `list_viewers` 응답에 tags 포함

### 기능 테스트 결과
- [ ] tags 할당 + list 필터링: PASS
- [ ] tags 전체 교체: PASS
- [ ] tags 일괄 닫기 (3개): PASS
- [ ] tags 일괄 닫기 (없음): PASS (에러 아님)
- [ ] tags 10개 초과 → isError: PASS
- [ ] tags 항목 64자 초과 → isError: PASS
- [ ] close_viewer { windowId: X } 기존 단일 닫기: PASS

### 코드 품질 기준

| 기준 | 결과 | 비고 |
|------|------|------|
| Plan-Code 정합성 | | FR-19-005 100% 구현 여부 |
| 에러 처리 | | tags 검증 완전 |
| 하위 호환성 | | close_viewer, list_viewers 기존 동작 유지 |

### 회귀테스트 결과
- [ ] Phase 1, 2 기능 정상
- [ ] close_viewer { windowId: X } 기존 동작 유지
- [ ] list_viewers (tag 없음) 기존 동작 유지

## 이슈 및 메모

_Phase 3 완료 후 기록_
