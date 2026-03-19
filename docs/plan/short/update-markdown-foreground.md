# update_markdown foreground 지원 계획

## 개요

`update_markdown` 호출 시 백그라운드에 있는 뷰어 창을 포그라운드로 올리는 기능 추가.
현재 `createWindow`에만 있는 foreground 로직을 `updateWindow`에도 적용한다.

## 현황

| 메서드 | foreground 지원 | 동작 |
|--------|:-:|------|
| `createWindow` | ✅ | `foreground !== false` → `win.show()` + `win.focus()` |
| `updateWindow` | ❌ | 창이 백그라운드에 있으면 그대로 뒤에 머뭄 |

## 변경 사항

### 1. window-manager.js — updateWindow에 foreground 로직 추가

- `opts` 디스트럭처링에 `foreground` 추가
- 메서드 끝부분(return 직전)에 foreground 처리:
  ```javascript
  if (foreground !== false) {
    if (entry.win.isMinimized()) entry.win.restore();
    entry.win.show();
    entry.win.focus();
  }
  ```
- `isMinimized()` 체크 추가: createWindow에는 불필요하지만 update 시 최소화 상태일 수 있음

### 2. mcp-server.mjs — update_markdown Zod 스키마에 foreground 추가

```javascript
foreground: z.boolean().optional().describe('Bring window to foreground (default: true)')
```

- 핸들러 디스트럭처링에 `foreground` 추가
- `sendIpcRequest` 호출에 `foreground` 포함

### 3. mcp-http.mjs — update_markdown JSON Schema + 핸들러에 foreground 추가

- TOOLS의 update_markdown `inputSchema.properties`에 foreground 추가
- 핸들러 디스트럭처링에 `foreground` 추가
- `windowManager.updateWindow` 호출에 `foreground` 포함

## 수정 파일 요약

| 파일 | 변경 |
|------|------|
| `src/main/window-manager.js` | updateWindow에 foreground 로직 (3줄) |
| `src/main/mcp-server.mjs` | Zod 스키마 + 핸들러에 foreground 추가 |
| `src/main/mcp-http.mjs` | JSON Schema + 핸들러에 foreground 추가 |

## 검증

1. update_markdown 호출 시 백그라운드 창이 포그라운드로 올라오는지 확인
2. `foreground: false` 전달 시 백그라운드 유지 확인
3. 최소화 상태에서 update 시 복원+포그라운드 확인
4. 기존 createWindow foreground 동작 영향 없음 확인
