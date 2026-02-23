# Phase 1 검증: Named Window + Severity 테마

## 완료 체크리스트

### 구현 완료 확인
- [ ] `WindowManager.nameToId: Map<string, number>` 추가됨
- [ ] `WindowManager.getWindowByName()` 구현됨
- [ ] `createWindow()` upsert 로직 동작
- [ ] `_onWindowClosed()` nameToId 정리 동작
- [ ] `windowName` 길이 검증 (256자) 동작
- [ ] `set-severity` IPC 이벤트 렌더러 수신 처리
- [ ] `.severity-bar` CSS 4종 색상 표시
- [ ] `viewer.html` severity-bar 요소 추가

### 기능 테스트 결과
- [ ] Named Window 신규 생성: PASS
- [ ] Named Window upsert (기존 창 업데이트): PASS
- [ ] Named Window 닫힘 후 재생성: PASS
- [ ] windowName 빈 문자열 → 새 창 생성: PASS
- [ ] windowName 256자 초과 → isError: PASS
- [ ] severity "error" → 빨간 바 표시: PASS
- [ ] severity "warning" → 주황 바 표시: PASS
- [ ] severity "info" → 파란 바 표시: PASS
- [ ] severity "success" → 초록 바 표시: PASS
- [ ] severity null → 바 숨김: PASS
- [ ] 잘못된 severity 값 → isError: PASS

### 코드 품질 기준

| 기준 | 결과 | 비고 |
|------|------|------|
| Plan-Code 정합성 | | FR-19-001, FR-19-003 100% 구현 여부 |
| SOLID 원칙 | | WindowManager 책임 분리 |
| 에러 처리 | | 모든 예외 케이스 처리됨 |
| 하위 호환성 | | 기존 open/update/close 동작 유지 |

### 회귀테스트 결과
- [ ] 기존 open_markdown (windowName 없음) 정상
- [ ] 기존 update_markdown 정상
- [ ] 기존 list_viewers 정상
- [ ] 기존 close_viewer 정상

## 이슈 및 메모

_Phase 1 완료 후 기록_
