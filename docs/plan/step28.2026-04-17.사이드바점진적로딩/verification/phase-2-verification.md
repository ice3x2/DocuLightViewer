# Phase 2 검증 문서

## 검증 항목

- [ ] `WindowManager._startSidebarTreeLoad(windowId, filePath)` 단일 진입점 존재
- [ ] `window-manager.js` / `index.js` 에서 기존 `buildSidebarTree` 호출부가 모두 `_startSidebarTreeLoad`로 교체됨
- [ ] 4종 IPC 이벤트(`sidebar-tree-start|batch|done|error`) 발송
- [ ] 기존 `sidebar-tree` 이벤트와 `sidebar-tree-done`이 이중 발송되어 호환 유지
- [ ] `cancel-sidebar-tree-load` IPC handle 등록
- [ ] `preload.js`에 4종 리스너 + 1종 invoke 노출
- [ ] 창 닫힘 시 `_currentLoadIds[windowId].controller.abort()` 호출
- [ ] `win.isDestroyed()` 가드가 모든 `webContents.send` 앞에 존재

## 증거 수집 명령

```bash
# IPC 이벤트 등록 확인
grep -n "sidebar-tree-start\|sidebar-tree-batch\|sidebar-tree-done\|sidebar-tree-error" src/main/

# preload 노출 확인
grep -n "onSidebarTree\|cancelSidebarTreeLoad" src/main/preload.js

# handle 등록 확인
grep -n "cancel-sidebar-tree-load" src/main/index.js
```

## 합격 기준

- Electron 앱 부팅 + 파일 열기 시 start/batch/done 이벤트 시퀀스 관찰 (임시 로그)
- 연속 파일 열기 시 이전 loadId에 error(aborted) 발송 확인
- 창 닫힘 시 `webContents.send` 예외 0건
