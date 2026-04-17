# Phase 3 검증 문서

## 검증 항목

- [ ] `viewer.html`에 `#sidebar-loading-spinner` DOM 존재 (초기 `display:none`)
- [ ] `viewer.css`에 `@keyframes spinner-pulse` 정의
- [ ] 3개 `.spinner-dot`이 `animation-delay` 0/0.2/0.4s로 순차 펄스
- [ ] `showSidebarSpinner` / `hideSidebarSpinner` / `forceHideSidebarSpinner` 함수 존재
- [ ] `_spinnerRefCount` 중첩 안전 (2회 show / 1회 hide → 여전히 표시)
- [ ] 4종 IPC 이벤트 리스너가 렌더러에 등록됨
- [ ] 배치 수신 시 DocumentFragment 기반 `appendChild` 동작
- [ ] `done` 수신 시 `renderSidebarTree(tree)` 로 완성 트리 재렌더
- [ ] 기존 `onSidebarTree` 이벤트와 `onSidebarTreeDone`의 이중 렌더 방지(`_currentTreeLoadId` 가드)
- [ ] `data-path` 속성이 증분 노드에도 부여됨 (step27 Phase 7 IMPL-010 호환)

## 증거 수집 명령

```bash
# DOM 요소 확인
grep -n "sidebar-loading-spinner\|spinner-dot" src/renderer/viewer.html src/renderer/viewer.css

# 리스너 등록 확인
grep -n "onSidebarTreeStart\|onSidebarTreeBatch\|onSidebarTreeDone\|onSidebarTreeError" src/renderer/viewer.js

# DocumentFragment 사용 확인
grep -n "DocumentFragment\|appendPartialNodesToSidebar" src/renderer/viewer.js
```

## 합격 기준

- 실행 중 대용량 폴더 열기 시 스피너가 즉시 보이고 배치별로 리스트가 점진적으로 채워짐
- 라이트/다크 테마 모두에서 회색 펄스 애니메이션 정상
- 소규모 폴더에서 사이드바 회귀 없음
