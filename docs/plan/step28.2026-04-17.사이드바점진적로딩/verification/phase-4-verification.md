# Phase 4 검증 문서

## 검증 항목

- [ ] 메인에서 `done` 전송 직전 `_currentLoadIds[windowId].loadId === loadId` 재확인
- [ ] 렌더러의 batch/done/error 핸들러 모두 `_currentTreeLoadId` 가드 보유
- [ ] 파일 열기/탭 전환 진입 직전 `cancelCurrentTreeLoadIfAny()` 호출
- [ ] `sidebarTreeCache: Map<string, {tree, timestamp}>` 존재
- [ ] `SIDEBAR_CACHE_TTL_MS = 5 * 60 * 1000` 상수
- [ ] `path.resolve(path.dirname(filePath))` 로 캐시 키 정규화
- [ ] 캐시 히트 시 `fromCache: true`로 start/done 즉시 전송, 스피너 비표시
- [ ] 캐시 크기 상한 32 + LRU 유사 정리
- [ ] aborted 시 renderer DOM 초기화 금지 (다음 start에 위임)

## 증거 수집 명령

```bash
# 캐시 관련
grep -n "sidebarTreeCache\|SIDEBAR_CACHE_TTL_MS\|fromCache" src/main/window-manager.js

# 렌더러 가드
grep -n "_currentTreeLoadId\|cancelCurrentTreeLoadIfAny" src/renderer/viewer.js
```

## 합격 기준

- 연속 폴더 전환 시 UI 깨짐/잔여 DOM 없음
- 같은 폴더 재방문 시 100ms 이하 표시, 스피너 비표시
- 5분 TTL 만료 후 재스캔 경로 정상 동작
