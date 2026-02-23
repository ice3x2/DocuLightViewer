# Phase 6 검증: 통합 및 마무리

## 완료 체크리스트

### 통합 기능 검증
- [ ] Named Window + Severity + Tags 조합 정상
- [ ] Named Window + Auto-close 조합 (닫힌 후 nameToId 정리 + 재생성) 정상
- [ ] Tags + close_viewer 일괄 닫기 + autoCloseTimer 정리 정상
- [ ] Flash + Progress 조합 정상
- [ ] Append 모드 + Named Window 조합 (windowId로 append) 정상
- [ ] list_viewers 전체 포맷 (severity, tags, progress, named) 올바름

### CLAUDE.md 업데이트 확인
- [ ] `open_markdown` 파라미터 표 업데이트 (7개 신규 파라미터)
- [ ] `update_markdown` 파라미터 표 업데이트 (7개 신규 파라미터)
- [ ] `close_viewer` 파라미터 표 업데이트 (tag)
- [ ] `list_viewers` 파라미터 표 업데이트 (tag)

### E2E 시나리오 결과
- [ ] 병렬 알람·보고 환경 시뮬레이션 (8단계) 정상 완료
- [ ] 오류 없음, 예상 응답 일치

### 코드 품질 기준

| 기준 | 결과 | 비고 |
|------|------|------|
| Plan-Code 정합성 | | 7개 FR 100% 구현 |
| 하위 호환성 | | 모든 기존 기능 동작 |
| 문서 업데이트 | | CLAUDE.md 최신화 |

### 전체 회귀테스트 결과
- [ ] `open_markdown` (기존 방식) 정상
- [ ] `update_markdown` (기존 방식) 정상
- [ ] `close_viewer` (기존 방식) 정상
- [ ] `list_viewers` (기존 방식) 정상
- [ ] 파일 감시 (FR-18-001) 정상
- [ ] PDF 내보내기 (FR-18-003) 정상
- [ ] 탭 기능 (FR-18-006) 정상

## Step 19 완료 승인

- [ ] 7개 FR 모두 구현 완료
- [ ] 모든 인수 조건(AC-001~AC-007-2) 통과
- [ ] CLAUDE.md 문서 최신화
- [ ] 기존 기능 비파괴 확인

## 이슈 및 메모

_Phase 6 완료 후 기록_
