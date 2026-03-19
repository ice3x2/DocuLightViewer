# MCP Tool 파라미터 정리 및 docType 개선 계획

## 개요

MCP `open_markdown` / `update_markdown` tool에서 AI가 활용하기 어려운 파라미터를 MCP 스키마에서 제거하고, docType과 severity의 description을 개선하여 AI 활용률을 높인다.

## 변경 범위

### Phase A: 불필요 파라미터 MCP 스키마에서 제거

**제거 대상** (AI가 판단할 수 없는 파라미터):

| 파라미터 | 대상 tool | 제거 이유 |
|----------|-----------|----------|
| `flash` | open, update | AI가 taskbar 깜빡임 필요 여부를 판단할 맥락 없음 |
| `autoCloseSeconds` | open, update | AI가 자동닫기 시간을 판단하기 어려움 |
| `separator` | update | 기본값 `\n\n`이면 충분 |

**잔류 파라미터** (사용자 요청):
- `noSave` — 사용자가 저장 제어 필요
- `foreground` — 백그라운드 오픈 케이스 존재

**수정 파일 및 상세**:

#### `src/main/mcp-server.mjs`

**open_markdown** Zod 스키마에서 제거:
```javascript
// 삭제
flash:            z.boolean().optional().describe('...'),
autoCloseSeconds: z.number().int().min(1).max(3600).optional().describe('...'),
```

핸들러 디스트럭처링에서 제거:
```javascript
// Before
async ({ content, filePath, title, foreground, size,
         windowName, severity, tags, flash, progress, autoCloseSeconds, ... })
// After
async ({ content, filePath, title, foreground, size,
         windowName, severity, tags, progress, ... })
```

`sendIpcRequest` 호출에서 `flash`, `autoCloseSeconds` 제거.

**update_markdown** Zod 스키마에서 제거:
```javascript
// 삭제
separator:        z.string().default('\n\n').describe('...'),
flash:            z.boolean().optional().describe('...'),
autoCloseSeconds: z.number().int().min(1).max(3600).optional().describe('...'),
```

핸들러 디스트럭처링에서 제거. `sendIpcRequest` 호출에서 제거.

#### `src/main/mcp-http.mjs`

**TOOLS 배열** open_markdown `inputSchema.properties`에서 제거:
```javascript
// 삭제
flash:            { type: 'boolean', ... },
autoCloseSeconds: { type: 'integer', ... },
```

**TOOLS 배열** update_markdown `inputSchema.properties`에서 제거:
```javascript
// 삭제
separator:        { type: 'string', ... },
flash:            { type: 'boolean', ... },
autoCloseSeconds: { type: 'integer', ... },
```

**createToolHandlers** 내 핸들러 디스트럭처링에서 제거.

> **주의**: `window-manager.js`, `index.js`의 내부 코드는 변경하지 않는다.
> IPC 프로토콜은 그대로 유지하여 향후 직접 IPC 호출 시 사용 가능.

### Phase B: docType / severity description 개선

#### B-1. Tool description (최상위 설명) 수정

**현재**:
```
IMPORTANT: Always provide project, docName, and description when the context is known.
```

**변경**:
```
IMPORTANT: Always provide project, docName, description, and docType when the context is known.
```

**적용 대상**: `mcp-server.mjs` (open_markdown), `mcp-http.mjs` (open_markdown)

#### B-2. docType 파라미터 description 개선

**현재**:
```
Document type classification (default: note)
```

**변경 (mcp-server.mjs, Zod describe)**:
```
[Recommended] Document type. Match to content: plan (plans/designs), report (analysis/status),
completion (finished work), issue (bugs/problems), review (code/doc review), log (progress/changelog),
reference (API/config docs), guide (tutorials/howto), spec (specifications/SRS), note (default/general)
```

**변경 (mcp-http.mjs, JSON Schema description)**:
```
동일 텍스트
```

#### B-3. severity 파라미터 description 개선

**현재** (open_markdown):
```
Severity color bar at window top
```

**변경**:
```
Document urgency indicator. info (informational/neutral), success (completed/positive),
warning (needs attention), error (critical/failed)
```

**적용 대상**: open_markdown / update_markdown 양쪽, stdio / HTTP 양쪽

#### B-4. update_markdown severity 버그 수정

**현재** (`mcp-server.mjs` update_markdown):
```javascript
severity: z.string().optional().describe('...')
```

**변경**:
```javascript
severity: z.enum(['info', 'success', 'warning', 'error', '']).optional().describe('...')
```

빈 문자열 `''`은 severity clear 기능 유지를 위해 포함.

## 수정 파일 요약

| 파일 | Phase A | Phase B |
|------|---------|---------|
| `src/main/mcp-server.mjs` | flash/autoClose/separator 제거 | tool desc, docType desc, severity desc 개선 + severity 버그 수정 |
| `src/main/mcp-http.mjs` | flash/autoClose/separator 제거 | tool desc, docType desc, severity desc 개선 |

**총 2개 파일, 로직 변경 없음 (스키마/텍스트만 수정)**

## 검증 방법

1. `node src/main/mcp-server.mjs` 실행 → Zod 스키마 파싱 에러 없음 확인
2. HTTP MCP `tools/list` 응답에서 flash/autoClose/separator 사라짐 확인
3. docType, severity description이 개선된 텍스트로 반환됨 확인
4. update_markdown severity에 잘못된 값 전달 시 enum 검증 에러 확인
5. 기존 IPC 직접 호출(`\\.\pipe\doculight-ipc`)로 flash/autoClose 여전히 동작 확인
