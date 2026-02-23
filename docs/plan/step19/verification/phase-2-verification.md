# Phase 2 검증: Taskbar 플래시 + Progress Bar

## 완료 체크리스트

### 구현 완료 확인
- [ ] `flash: true` 시 비포그라운드 창 `win.flashFrame(true)` 호출
- [ ] `flash: true` 시 포그라운드 창 flashFrame 미호출
- [ ] Linux flashFrame 실패 시 `console.warn` + 정상 응답
- [ ] `progress: 0.0~1.0` 시 `win.setProgressBar()` 호출
- [ ] `progress: -1` 시 `win.setProgressBar(-1)` 호출 (제거)
- [ ] `meta.progress` 저장
- [ ] progress 범위 초과 → isError
- [ ] progress NaN/null → isError
- [ ] `list_viewers` 응답에 progress 포함 (0 이상)

### 기능 테스트 결과
- [ ] progress: 0.5 → 태스크바 50% 바: PASS
- [ ] progress: -1 → 태스크바 바 제거: PASS
- [ ] progress: 0.0 → 정상 처리: PASS
- [ ] progress: 1.0 → 100% 표시: PASS
- [ ] progress: 1.5 → isError: PASS
- [ ] flash: true + 비포그라운드 → flashFrame 호출: PASS
- [ ] flash: true + 포그라운드 → flashFrame 미호출: PASS
- [ ] flash 미지정 → flashFrame 미호출: PASS

### 코드 품질 기준

| 기준 | 결과 | 비고 |
|------|------|------|
| Plan-Code 정합성 | | FR-19-006, FR-19-007 100% 구현 여부 |
| 에러 처리 | | progress 범위 검증, Linux 예외 처리 |
| 하위 호환성 | | flash/progress 미지정 시 기존 동작 유지 |

### 회귀테스트 결과
- [ ] Phase 1 기능 (Named Window, Severity) 정상
- [ ] 기존 MCP 도구 동작 유지

## 이슈 및 메모

_Phase 2 완료 후 기록_
