# Phase 5 검증: Append 모드

## 완료 체크리스트

### 구현 완료 확인
- [ ] `appendMode: true` + content 기반 창 → 콘텐츠 이어 붙이기
- [ ] `meta.lastRenderedContent` 갱신
- [ ] 기본 separator `"\n\n"` 동작
- [ ] 커스텀 separator 동작
- [ ] filePath 기반 창 → isError 반환
- [ ] 누적 10MB 초과 → isError, 기존 콘텐츠 보존
- [ ] lastRenderedContent 없음 (첫 append) → 정상 처리
- [ ] `appendMode: false` (기본) → 기존 전체 교체 동작 유지
- [ ] content 기반 updateWindow 시 lastRenderedContent 갱신 (appendMode: false도)

### 기능 테스트 결과
- [ ] append 기본 동작 ("항목 1" + "\n\n" + "항목 2"): PASS
- [ ] 커스텀 separator: PASS
- [ ] 첫 번째 append (기존 내용 없음): PASS
- [ ] filePath 창 append → isError: PASS
- [ ] 10MB 초과 → isError, 기존 보존: PASS
- [ ] content 없음 + appendMode: true → isError: PASS
- [ ] 응답 "Appended to window X.": PASS

### 코드 품질 기준

| 기준 | 결과 | 비고 |
|------|------|------|
| Plan-Code 정합성 | | FR-19-002 100% 구현 여부 |
| 신뢰성 | | lastRenderedContent in-memory 관리 |
| 에러 처리 | | filePath 체크, 크기 한도, content 필수 |
| 하위 호환성 | | appendMode: false 기존 동작 유지 |

### 회귀테스트 결과
- [ ] Phase 1~4 기능 정상
- [ ] `update_markdown` appendMode 미지정 → 전체 교체 (기존 동작)
- [ ] filePath 기반 창 `update_markdown` (appendMode: false) 정상 동작

## 이슈 및 메모

_Phase 5 완료 후 기록_
