# Phase 2 검증 문서

## 검증 항목

- [ ] `src/renderer/viewer.js` 에 `collapseAllSidebarDirs` 함수 정의 존재
- [ ] `src/renderer/viewer.js` 에 `expandAllSidebarDirs` 함수 정의 존재
- [ ] `src/renderer/viewer.js` 에 `updateSidebarToggleButtons` 함수 정의 존재
- [ ] `_sidebarSearchModeActive` 전역 상태 변수 존재 (또는 동등 메커니즘)
- [ ] `onSidebarTreeStart/Done/Error` 핸들러 본문 끝에 `updateSidebarToggleButtons()` 호출 주입
- [ ] 기존 `onSidebarTree` 호환 핸들러 끝에도 호출 주입
- [ ] `document.addEventListener('doculight:searchmode', ...)` 리스너 추가
- [ ] 기존 `onSidebarTree` 호환 핸들러 이름이 실제 존재하는지 확인: `grep -n "onSidebarTree\b" src/renderer/viewer.js`
- [ ] `#btn-sidebar-collapse-all`, `#btn-sidebar-expand-all` 에 click 이벤트 바인딩
- [ ] `window.DocuLight.fn`에 3함수 export
- [ ] disabled 판정이 OR 논리: `검색모드 || 로딩 || 트리부재`
- [ ] 가상 디렉토리 `__external_links__` 도 `.tree-children` 쿼리에 포함되어 처리됨
- [ ] 초기화 종료 시점(notifyReady 직후)에 `updateSidebarToggleButtons()` 1회 호출 존재 (초기 disabled 상태 명시 확정)
- [ ] `_sidebarSearchModeActive` 가 IIFE 내부에 선언되었는지(전역 누출 없음) 확인

## 증거 수집 명령

```bash
# 3함수 존재 확인
grep -n "function collapseAllSidebarDirs\|function expandAllSidebarDirs\|function updateSidebarToggleButtons" src/renderer/viewer.js

# IPC 리스너 내부 호출 주입 확인
grep -n "updateSidebarToggleButtons()" src/renderer/viewer.js

# searchmode 이벤트 수신 확인
grep -n "doculight:searchmode" src/renderer/viewer.js

# window.DocuLight.fn export 확인
grep -n "collapseAllSidebarDirs\|expandAllSidebarDirs" src/renderer/viewer.js | grep "fn\."

# 구문 검증
node --check src/renderer/viewer.js && echo "SYNTAX OK"

# 회귀 테스트
node test/test-link-tree.js && node test/test-link-tree-build.js && node test/test-sidebar-tree.js && node test/test-batch-streaming.js
```

## 합격 기준

- 3함수 모두 구현되고 IIFE 내부에서 선언
- 기존 step28 Phase 2 IPC 리스너와 searchmode 이벤트에서 자동 disabled 갱신
- 버튼 클릭으로 실제 전체 접기/펼치기 동작 확인 (수동)
- 기존 단위 테스트 4건 PASS
