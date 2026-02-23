# Phase 4 검증: Auto-close 타이머

## 완료 체크리스트

### 구현 완료 확인
- [ ] `autoCloseSeconds` 수신 시 `setTimeout()` 등록
- [ ] `meta.autoCloseTimer` 저장
- [ ] `_onWindowClosed()` 에서 `clearTimeout()` 호출
- [ ] `auto-close-start` IPC 이벤트 렌더러 전송
- [ ] 렌더러 카운트다운 바 표시 (`#auto-close-bar`)
- [ ] 카운트다운 1초마다 감소
- [ ] 5초 이하 강조(주황 배경)
- [ ] `update_markdown { autoCloseSeconds }` 기존 타이머 해제 후 재등록
- [ ] 비정수 → `Math.floor()` 처리
- [ ] `autoCloseSeconds < 1` → isError
- [ ] `autoCloseSeconds > 3600` → isError
- [ ] 4개 로케일 `viewer.autoCloseLabel` 키 추가

### 기능 테스트 결과
- [ ] autoCloseSeconds: 5 → 5초 후 창 닫힘: PASS
- [ ] 수동 닫기 → clearTimeout 호출: PASS
- [ ] update_markdown 타이머 재설정: PASS
- [ ] 5초 이하 강조: PASS
- [ ] ko 로케일 "자동 종료: 5초": PASS
- [ ] en 로케일 "Auto-close in 5s": PASS
- [ ] ja 로케일 "自動終了: 5秒": PASS
- [ ] es 로케일 "Cierre automático: 5s": PASS
- [ ] autoCloseSeconds: 0 → isError: PASS
- [ ] autoCloseSeconds: 3601 → isError: PASS
- [ ] autoCloseSeconds: 5.7 → Math.floor → 5: PASS

### 코드 품질 기준

| 기준 | 결과 | 비고 |
|------|------|------|
| Plan-Code 정합성 | | FR-19-004 100% 구현 여부 |
| 신뢰성 | | 타이머 누수 없음 확인 |
| 에러 처리 | | 범위 검증, 비정수 처리 |
| i18n | | 4개 로케일 모두 정상 |

### 회귀테스트 결과
- [ ] Phase 1~3 기능 정상
- [ ] autoCloseSeconds 없는 창 → auto-close-bar 미표시
- [ ] 기존 창 닫기 동작 (타이머 없는 창) 정상

## 이슈 및 메모

_Phase 4 완료 후 기록_
