# SRS: DocLight Pivot — Electron Markdown Viewer + MCP Server

## 메타데이터

| 항목 | 내용 |
|------|------|
| 버전 | pivot-v1.0 |
| 생성일 | 2026-02-13 |
| 이전 버전 | docs/plan/srs.md (v0.1, Express 웹 서버) |
| 성격 | **완전 피봇** — 기존 Express 웹 서버 아키텍처를 완전 폐기하고 Electron 데스크톱 앱으로 전환 |
| 평가 라운드 | 3회 (라운드 3에서 만장일치 A+ 달성) |

---

## 1. 개요

### 1.1 목적

**DocLight**는 MCP(Model Context Protocol) 서버를 내장한 경량 Electron 기반 Markdown 뷰어이다. AI 에이전트(Claude Code, Claude Desktop 등)가 MCP 프로토콜을 통해 Markdown 문서를 데스크톱 화면에 즉시 표시할 수 있는 도구로, 개발 워크플로우에서 문서 미리보기·공유·프레젠테이션 용도로 사용한다.

### 1.2 범위

본 SRS가 커버하는 범위:

- Electron 메인/렌더러 프로세스 아키텍처
- stdio 기반 MCP 서버 (백그라운드 상시 실행)
- MCP 도구를 통한 Markdown 뷰어 창 열기/닫기
- 다중 뷰어 창 관리
- 문서 내 로컬 링크 재귀 파싱을 통한 사이드바 네비게이션
- 기존 Express 웹 서버 코드 전면 제거

본 SRS가 커버하지 **않는** 범위:

- 파일 업로드/삭제/다운로드 기능 (제거)
- RAG 챗봇 기능 (제거)
- 어드민 패널 (제거)
- 웹 브라우저 기반 접근 (제거)
- REST API 서버 (제거)

### 1.3 피봇 배경 및 이전 버전 대비 변경사항

**피봇 배경:**

기존 DocLight는 Express 웹 서버 기반으로, 브라우저에서 접근하는 문서 뷰어였다. 그러나 AI 에이전트 워크플로우에서는 에이전트가 생성한 Markdown을 즉시 데스크톱에 표시하는 용도가 더 적합하다. MCP 프로토콜을 통해 AI 에이전트가 직접 뷰어를 제어할 수 있는 네이티브 데스크톱 앱으로 전환한다.

**주요 변경사항:**

| 항목 | 이전 (Express 웹) | 이후 (Electron + MCP) |
|------|-------------------|----------------------|
| 런타임 | Node.js Express 서버 | Electron 데스크톱 앱 |
| 접근 방식 | 브라우저 URL | MCP 프로토콜 (stdio) |
| 문서 소스 | 서버 파일시스템 디렉토리 | MCP로 전달받은 텍스트 또는 파일 경로 |
| 사이드바 | docsRoot 전체 트리 | 문서 내 링크 기반 동적 트리 |
| 인증 | API Key (X-API-Key) | 불필요 (로컬 프로세스) |
| 파일 관리 | CRUD REST API | 읽기 전용 (뷰어 전용) |
| 챗봇 | RAG 기반 챗봇 | 제거 |
| 어드민 | 웹 어드민 패널 | 제거 |
| 배포 | PM2 서버 | 시스템 트레이 상주 앱 |

---

## 2. 시스템 요약

| 구분 | 내용 |
|------|------|
| **시스템 이름** | DocLight |
| **주요 기능** | MCP를 통한 Markdown 뷰어 창 열기, 다중 창 관리, 링크 기반 사이드바 네비게이션 |
| **대상 사용자** | AI 에이전트 (MCP 클라이언트), 개발자 (데스크톱 사용자) |
| **운영 환경** | Electron 33+, Node.js 20+, Windows/macOS/Linux |
| **통신 프로토콜** | MCP (Model Context Protocol) over stdio |
| **저장소** | 로컬 파일시스템 (읽기 전용), electron-store (사용자 설정) |
| **보안 정책** | DOMPurify HTML 새니타이징, 로컬 프로세스 (네트워크 미노출) |
| **성능 목표** | 창 열기 < 500ms, 렌더링 < 200ms |
| **배포 방식** | 시스템 트레이 상주 앱 (electron-builder 패키징) |

---

## 3. 주요 사용자 및 사용 시나리오

### 3.1 사용자 정의

| 사용자 | 설명 | 인터페이스 |
|--------|------|-----------|
| **AI 에이전트** | Claude Code, Claude Desktop 등 MCP 클라이언트. `open_markdown` 도구를 호출하여 뷰어 창을 연다. | MCP stdio |
| **데스크톱 사용자** | 뷰어 창에서 문서를 읽고 사이드바를 통해 링크된 문서를 탐색한다. | Electron GUI |

### 3.2 사용 시나리오

| ID | 시나리오 | 설명 |
|----|----------|------|
| SC-01 | **MCP로 Markdown 텍스트 보기** | AI 에이전트가 `open_markdown` 도구에 `content` 파라미터로 Markdown 원문을 전달하면, 새 뷰어 창이 열리고 렌더링된 문서가 표시된다. |
| SC-02 | **MCP로 파일 경로 보기** | AI 에이전트가 `open_markdown` 도구에 `filePath` 파라미터로 로컬 파일 경로를 전달하면, 해당 파일을 읽어 새 뷰어 창에 표시한다. |
| SC-03 | **항상 위에 뜨는 창** | `foreground: true` 파라미터를 추가하면 always-on-top 창이 열려 다른 앱 위에 항상 표시된다. |
| SC-04 | **다중 창 열기** | 연속 MCP 호출로 여러 뷰어 창을 동시에 열 수 있다. 각 창은 독립적이다. |
| SC-05 | **링크 기반 사이드바 탐색** | 파일 경로로 연 문서에 `[링크](./other.md)` 같은 로컬 링크가 있으면, 좌측 사이드바에 재귀적으로 수집된 문서 트리가 표시된다. 트리 항목 클릭 시 해당 문서로 이동한다. |
| SC-06 | **사이드바 없는 단일 문서** | 링크가 없는 문서를 열면 사이드바가 완전히 숨겨지고, 뷰어 영역이 전체 너비를 차지한다. |
| SC-07 | **뷰어 창 닫기** | AI 에이전트가 `close_viewer` 도구로 특정 창 또는 모든 창을 닫는다. |
| SC-08 | **시스템 트레이 상주** | 앱이 시스템 트레이에 상주하며, 트레이 아이콘 메뉴에서 "모든 창 닫기", "종료" 등을 선택할 수 있다. |

---

## 4. 기능 요구사항

### FR-P-001: Electron 앱 기본 구조

- **설명**: Electron 기반 데스크톱 앱으로, 시스템 트레이에 상주하며 MCP 서버를 백그라운드로 실행한다.
- **입력**: 앱 실행 (시스템 시작 시 또는 수동 실행)
- **처리**:
  1. Electron main process 시작
  2. 시스템 트레이 아이콘 등록 (앱 아이콘 + 컨텍스트 메뉴)
  3. IPC 소켓 서버 초기화 — Named Pipe (Windows: `\\.\pipe\doclight-ipc`) / Unix Domain Socket (macOS/Linux: `/tmp/doclight-ipc.sock`) 리스닝 시작
  4. 메인 윈도우는 생성하지 않음 (트레이 전용)
  5. MCP Bridge Process의 IPC 요청 대기 상태 진입
- **출력**: 시스템 트레이 아이콘 표시, IPC 소켓 서버 리스닝 중
- **예외**:
  - 트레이 아이콘 리소스 없음 → 기본 Electron 아이콘 사용
  - 이미 실행 중인 인스턴스 → `app.requestSingleInstanceLock()` 으로 중복 실행 방지, 기존 인스턴스 포커스

**앱 생명주기:**

| 이벤트 | 동작 |
|--------|------|
| `app.ready` | IPC 소켓 stale 파일 정리(*) → 트레이 아이콘 생성 → IPC 소켓 서버 시작 |
| 창 모두 닫힘 | 앱 종료하지 않음 (트레이 상주) |
| 트레이 → "종료" | MCP 서버 정리 후 `app.quit()` |
| 트레이 → "모든 창 닫기" | 모든 BrowserWindow 닫기 |
| `app.before-quit` | 열린 창 정리, MCP 서버 종료 |

**트레이 컨텍스트 메뉴:**

```
- 열린 창 목록 (동적, 최대 10개 표시)
  - [창 제목 1] → 해당 창 포커스
  - [창 제목 2] → 해당 창 포커스
  - ... 외 N개 (10개 초과 시)
- ─────────────
- 모든 창 닫기
- 설정
- ─────────────
- DocLight 종료
```

---

### FR-P-002: MCP 서버 (백그라운드)

- **설명**: stdio 전송 방식의 MCP 서버로, AI 에이전트가 Markdown 뷰어를 제어할 수 있는 도구를 제공한다.
- **입력**: MCP 클라이언트로부터의 JSON-RPC 2.0 요청 (stdin/stdout)
- **처리**: MCP SDK를 통해 도구 호출을 수신하고, IPC 소켓을 통해 Electron GUI 앱에 창 생성/관리를 요청
- **출력**: MCP 응답 (JSON-RPC 2.0 형식)
- **예외**:
  - stdin 스트림 종료 → MCP 서버 프로세스 정상 종료 (Electron 앱은 영향 없음)
  - Electron 앱 미실행 → 자동 실행 시도 후 연결, 실패 시 에러 반환
  - 잘못된 JSON-RPC 형식 → MCP SDK 기본 에러 응답

#### 2.1 프로세스 분리 아키텍처 (Critical)

MCP stdio 서버와 Electron GUI 앱은 **별도 프로세스**로 실행된다. 이유:
- MCP 클라이언트(Claude Desktop 등)는 MCP 서버를 `child_process.spawn()`으로 실행하고 stdin/stdout 파이프를 연결한다.
- Electron GUI 앱은 시스템 트레이에 상주하며 독립적으로 실행된다.
- 두 프로세스가 stdin/stdout을 공유할 수 없으므로 반드시 분리해야 한다.

**프로세스 구조:**

```
[MCP Client (Claude Desktop)]
    │ spawn + stdin/stdout pipe
    ▼
[MCP Bridge Process (mcp-server.js)]  ← 경량 Node.js 프로세스
    │ Named Pipe (Windows) / Unix Domain Socket (macOS/Linux)
    ▼
[Electron GUI App (index.js)]  ← 시스템 트레이 상주
    │ IPC
    ▼
[Renderer Processes (viewer windows)]
```

**MCP Bridge Process** (`src/main/mcp-server.js`):
- MCP SDK의 `StdioServerTransport`로 stdin/stdout 통신
- 도구 호출 수신 시 Named Pipe/Unix Socket을 통해 Electron 앱에 명령 전달
- Electron 앱의 응답을 받아 MCP 클라이언트에 반환
- 경량 프로세스 (Electron 의존 없음, Node.js만 사용)

**IPC 소켓 경로:**
- Windows: `\\.\pipe\doclight-ipc`
- macOS/Linux: `/tmp/doclight-ipc.sock`

**IPC 소켓 메시지 프레이밍:**

Named Pipe/Unix Socket은 스트림 기반이므로 메시지 경계를 구분하는 프레이밍이 필수이다. **Newline-delimited JSON (ndjson)** 방식을 사용한다:

```
규칙:
- 각 메시지는 한 줄의 JSON + '\n' (0x0A)
- JSON 내부에 개행 문자 불가 (직렬화 시 줄바꿈 없음)
- 파싱: '\n' 기준으로 버퍼를 분할하여 각 줄을 JSON.parse()
```

**IPC 메시지 프로토콜 (Bridge ↔ Electron):**

```json
// 요청 (Bridge → Electron)
{"id":"req-uuid","action":"open_markdown","params":{"content":"...","foreground":true}}\n

// 응답 (Electron → Bridge)
{"id":"req-uuid","result":{"windowId":"abc-123","title":"README"}}\n

// 에러 응답
{"id":"req-uuid","error":{"message":"파일을 찾을 수 없습니다"}}\n
```

**IPC 요청-응답 타임아웃:** Bridge가 Electron에 요청을 보낸 후 **10초** 이내에 응답이 없으면 타임아웃 에러를 MCP 클라이언트에 반환한다: `"DocLight 앱이 응답하지 않습니다. (타임아웃: 10초)"`.

**Electron 앱이 미실행 시 동작:**
1. MCP Bridge가 소켓 연결 시도
2. 연결 실패 → Electron 앱 자동 실행
3. 최대 5초 대기하며 소켓 재연결 시도 (500ms 간격, 10회)
4. 연결 성공 → 정상 동작
5. 연결 실패 → 에러 반환: `"DocLight 앱에 연결할 수 없습니다. 앱을 수동으로 실행해주세요."`

**앱 자동 실행 시 경로 결정:**

| 환경 | 실행 명령 | 결정 방법 |
|------|----------|----------|
| 개발 | `spawn(require('electron'), [path.join(__dirname, '../../')])` | `node_modules/.bin/electron` 존재 여부 확인 |
| 프로덕션 (Windows) | `spawn('DocLight.exe')` | 환경변수 `DOCLIGHT_APP_PATH` 또는 레지스트리 `App Paths` |
| 프로덕션 (macOS) | `spawn('open', ['-a', 'DocLight'])` | `/Applications/DocLight.app` |
| 프로덕션 (Linux) | `spawn('doclight')` | PATH에 등록된 바이너리 |

경로 결정 우선순위: (1) 환경변수 `DOCLIGHT_APP_PATH` → (2) 플랫폼별 기본 경로 → (3) 개발 환경 fallback

**Bridge 프로세스 종료 시퀀스 (Graceful Shutdown):**

```
1. stdin EOF 또는 SIGTERM 수신
2. 진행 중인 IPC 요청이 있으면 최대 5초 대기
3. IPC 소켓 연결 close()
4. process.exit(0)
```

**Bridge 프로세스 로깅:** Bridge의 stdout은 MCP 프로토콜에 사용되므로, 모든 디버그/에러 로그는 **stderr**로 출력한다. `console.error()` 사용. MCP 클라이언트는 일반적으로 stderr를 로그로 캡처한다.

**MCP 서버 구현 상세:**

```javascript
// MCP Bridge Process (mcp-server.js)
// 전송 방식: stdio (MCP SDK 표준)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import net from "net";

// Electron 앱과의 IPC 소켓 연결
const PIPE_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\doclight-ipc"
  : "/tmp/doclight-ipc.sock";
```

**서버 정보:**

```json
{
  "name": "doclight",
  "version": "1.0.0"
}
```

#### 도구 1: `open_markdown`

- **설명**: Markdown 문서를 새 뷰어 창에서 연다.
- **입력 스키마 (JSON Schema)**:

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "string",
      "maxLength": 10485760,
      "description": "렌더링할 Markdown 원문 텍스트 (최대 10MB). filePath와 동시에 제공 시: content를 렌더링하되, filePath를 사이드바 링크 해석의 기준 경로로 사용한다."
    },
    "filePath": {
      "type": "string",
      "description": "렌더링할 Markdown 파일의 절대 경로. 상대 경로 사용 시 MCP 클라이언트의 작업 디렉토리 기준으로 resolve."
    },
    "foreground": {
      "type": "boolean",
      "description": "true이면 항상 화면 최상위에 표시되는 always-on-top 창을 연다.",
      "default": false
    },
    "title": {
      "type": "string",
      "description": "창 제목을 직접 지정. 생략 시 자동 결정 (파일명 또는 첫 H1 헤딩)."
    },
    "size": {
      "type": "string",
      "enum": ["s", "m", "l", "f"],
      "description": "창 크기 프리셋. s=480x680, m=720x1024, l=1080x1440, f=전체화면(maximize). 기본값: m. 화면 크기를 초과할 수 없음 (클램핑). 다중 모니터 시 주 모니터(인덱스 0)에 출력.",
      "default": "m"
    }
  },
  "anyOf": [
    { "required": ["content"] },
    { "required": ["filePath"] }
  ]
}
```

- **처리 로직**:
  1. `content`와 `filePath` 모두 없으면 → `isError: true` 에러 반환
  2. `content` 크기 검증: 10MB (10,485,760 bytes) 초과 시 에러 반환
  3. 열린 창 수 검증: 20개 이상이면 에러 반환
  4. **`content`만 제공** → 텍스트를 직접 렌더링, 사이드바 없음
  5. **`filePath`만 제공** → 파일 존재 확인 → 파일 읽기 → 렌더링, 사이드바 활성화
  6. **`content` + `filePath` 동시 제공** → content를 렌더링하되, filePath의 디렉토리를 사이드바 링크 해석의 기준 경로로 사용
  7. `filePath` 경로 resolve: 상대 경로인 경우 MCP Bridge 프로세스의 `process.cwd()` 기준으로 resolve. MCP 클라이언트가 Bridge를 spawn할 때 `cwd` 옵션으로 설정한 디렉토리가 `process.cwd()`에 반영됨. 별도 CWD 전달 메커니즘 없음
  8. 고유 `windowId` 생성 (UUID v4)
  9. IPC 소켓을 통해 Electron 앱에 창 생성 요청
  10. 다중 창 열기 시 캐스케이딩 위치 적용 (이전 창 대비 x+30, y+30 오프셋). 화면 경계를 넘으면 (0, 0)으로 wrap-around
  11. 창 열림 완료 후 응답 반환

- **출력 (성공)**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "뷰어 창이 열렸습니다. (windowId: <uuid>, title: <title>)"
    }
  ]
}
```

- **출력 (에러)** — `isError: true` 포함:

```json
{
  "content": [
    {
      "type": "text",
      "text": "<에러 메시지>"
    }
  ],
  "isError": true
}
```

- **예외**:

| 상황 | 에러 메시지 |
|------|-----------|
| content와 filePath 모두 없음 | `"content 또는 filePath 중 하나는 필수입니다."` |
| content 크기 10MB 초과 | `"content 크기가 10MB를 초과합니다."` |
| filePath 파일 없음 | `"파일을 찾을 수 없습니다: <path>"` |
| filePath 읽기 권한 없음 | `"파일을 읽을 수 없습니다: <path>"` |
| filePath가 .md 확장자 아님 | `"Markdown 파일만 지원합니다 (.md): <path>"` |
| 열린 창 20개 이상 | `"최대 뷰어 창 수(20개)에 도달했습니다. 기존 창을 닫아주세요."` |
| Electron 앱 미실행/연결 실패 | `"DocLight 앱에 연결할 수 없습니다. 앱을 수동으로 실행해주세요."` |

#### 도구 2: `update_markdown`

- **설명**: 이미 열린 뷰어 창의 내용을 갱신한다. 기존 창을 닫고 새로 열 필요 없이 내용만 교체한다.
- **입력 스키마 (JSON Schema)**:

```json
{
  "type": "object",
  "properties": {
    "windowId": {
      "type": "string",
      "description": "갱신할 창의 고유 ID (필수)"
    },
    "content": {
      "type": "string",
      "maxLength": 10485760,
      "description": "새로운 Markdown 원문 텍스트. filePath와 동시 제공 시: content를 렌더링하되, filePath를 사이드바 링크 해석 기준으로 사용."
    },
    "filePath": {
      "type": "string",
      "description": "새로운 Markdown 파일 경로 (파일을 다시 읽어 렌더링)"
    },
    "title": {
      "type": "string",
      "description": "창 제목 갱신. 생략 시 새 content/filePath 기준으로 자동 결정 (FR-P-003 창 제목 결정 로직 적용)."
    }
  },
  "required": ["windowId"],
  "anyOf": [
    { "required": ["content"] },
    { "required": ["filePath"] }
  ]
}
```

> **스키마 호환성 참고**: `required`와 `anyOf` 동시 사용은 JSON Schema Draft 7 표준에 부합하며, MCP SDK의 zod 기반 검증에서도 정상 동작한다. MCP SDK `server.tool()` 호출 시에는 zod 스키마(`z.object({ windowId: z.string(), ... }).refine(...)`)로 변환하여 등록할 수 있다.

- **처리 로직**:
  1. `windowId`에 해당하는 창 존재 확인
  2. 새 content 또는 filePath로 렌더링 데이터 준비
  3. **`content` + `filePath` 동시 제공** → open_markdown과 동일: content를 렌더링, filePath를 사이드바 링크 기준으로 사용
  4. 기존 창에 IPC로 새 Markdown 데이터 전달
  5. 렌더러가 내용 교체 (스크롤 위치 상단으로 리셋)
  6. 창 제목 갱신: `title` 파라미터 지정 시 그 값 사용, 미지정 시 FR-P-003 창 제목 결정 로직으로 자동 결정
  7. 사이드바 트리 재구성 (filePath 변경 시)

- **출력**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "뷰어 창이 갱신되었습니다. (windowId: <id>, title: <title>)"
    }
  ]
}
```

- **예외**:

| 상황 | 에러 메시지 |
|------|-----------|
| windowId에 해당하는 창 없음 | `"해당 windowId의 창을 찾을 수 없습니다: <id>"` |
| content와 filePath 모두 없음 | `"content 또는 filePath 중 하나는 필수입니다."` |

#### 도구 3: `close_viewer`

- **설명**: 열린 뷰어 창을 닫는다.
- **입력 스키마 (JSON Schema)**:

```json
{
  "type": "object",
  "properties": {
    "windowId": {
      "type": "string",
      "description": "닫을 창의 고유 ID. 생략하면 모든 뷰어 창을 닫는다."
    }
  }
}
```

- **처리 로직**:
  1. `windowId` 지정 → 해당 ID의 BrowserWindow 찾아서 닫기
  2. `windowId` 미지정 → 모든 뷰어 BrowserWindow 닫기
  3. 창 목록에서 제거

- **출력**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "뷰어 창 <n>개를 닫았습니다."
    }
  ]
}
```

- **예외**:

| 상황 | 에러 메시지 |
|------|-----------|
| windowId에 해당하는 창 없음 | `"해당 windowId의 창을 찾을 수 없습니다: <id>"` |
| 열린 창이 없음 | `"닫을 뷰어 창이 없습니다."` |

#### 도구 4: `list_viewers`

- **설명**: 현재 열려 있는 뷰어 창 목록을 반환한다.
- **입력 스키마**: `{ "type": "object", "properties": {} }` (파라미터 없음)
- **출력 (창이 있을 때)**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "열린 뷰어: 2개\n- [abc-123] README.md (always-on-top)\n- [def-456] guide.md"
    }
  ]
}
```

- **출력 (창이 없을 때)**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "열린 뷰어: 0개"
    }
  ]
}
```

**MCP 클라이언트 등록 예시 (claude_desktop_config.json):**

```json
{
  "mcpServers": {
    "doclight": {
      "command": "node",
      "args": ["C:/Work/git/DocLight/src/main/mcp-server.js"],
      "env": {}
    }
  }
}
```

또는 빌드된 앱 설치 후:

```json
{
  "mcpServers": {
    "doclight": {
      "command": "doclight-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

> **참고**: `doclight-mcp`는 MCP Bridge 전용 바이너리이며, Electron GUI 앱(`doclight`)과 별도로 배포된다. `package.json`의 `bin` 필드에 등록한다.

---

### FR-P-003: 마크다운 뷰어 창

- **설명**: MCP 요청에 의해 생성되는 독립적인 Markdown 뷰어 창. GitHub-flavored Markdown 스타일로 렌더링한다.
- **입력**: IPC를 통해 전달받은 Markdown 원문 텍스트 + 메타데이터 (filePath, foreground, windowId)
- **처리**:
  1. BrowserWindow 생성 (옵션은 아래 참조)
  2. 렌더러 HTML 로드 (`viewer.html`)
  3. IPC로 Markdown 데이터 전달
  4. 렌더러에서 렌더링 파이프라인 실행 (`sandbox: true`이므로 `require()` 사용 불가, `viewer.html`에서 `<script src="./lib/marked.min.js">` 순서대로 로드):
     - `marked.parse(markdown)` → HTML 변환
     - `DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })` → XSS 제거 (기본 프로필 사용, `<script>`, `<iframe>`, `on*` 이벤트 속성 제거)
     - DOM에 삽입
     - `mermaid.run()` → 다이어그램 렌더링
     - `hljs.highlightAll()` → 코드 하이라이팅
  5. 사이드바 표시 여부 결정 (FR-P-004 참조)
- **출력**: 렌더링된 Markdown이 표시된 데스크톱 창

**창 크기 프리셋:**

| 프리셋 | 너비 (px) | 높이 (px) | 설명 |
|--------|-----------|-----------|------|
| `s` | 480 | 680 | 소형 (사이드 패널, 보조 뷰어) |
| `m` | 720 | 1024 | 중형 (기본값, 문서 읽기 최적) |
| `l` | 1080 | 1440 | 대형 (넓은 문서, 다이어그램) |
| `f` | 화면 전체 | 화면 전체 | 전체화면 (maximize) |

**크기 제약:**
- 프리셋 값이 화면 작업 영역(`workAreaSize`)을 초과하면 화면 크기로 클램핑
- `f` (fullscreen)는 `BrowserWindow.maximize()` 호출
- 다중 모니터 환경에서는 `screen.getPrimaryDisplay()` (가장 앞 인덱스 = 주 모니터)에 창 출력
- `size` 미지정 시 기본값: `m` (720x1024)

**BrowserWindow 생성 옵션:**

```javascript
{
  width: resolvedWidth,   // resolveWindowSize(size) 결과, 화면 크기 클램핑 적용
  height: resolvedHeight, // resolveWindowSize(size) 결과, 화면 크기 클램핑 적용
  minWidth: 400,
  minHeight: 300,
  alwaysOnTop: foreground === true,  // foreground 파라미터에 따라
  title: resolvedTitle,               // 자동 결정 로직 참조
  icon: path.join(__dirname, '../assets/icon.png'),
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}
// size === 'f'이면 추가로 win.maximize() 호출
```

**창 제목 결정 로직:**

| 우선순위 | 조건 | 제목 |
|----------|------|------|
| 1 | MCP `title` 파라미터 지정 | 지정된 제목 |
| 2 | `filePath`로 열었을 때 | 파일명 (확장자 제외). 예: `README.md` → `README` |
| 3 | `content`로 열었을 때 첫 H1 헤딩 존재 | H1 텍스트. 예: `# 가이드` → `가이드` |
| 4 | 위 모두 해당 없음 | `DocLight` |

**다중 창 관리:**

- 각 창은 `windowId` (UUID v4)로 식별
- 메인 프로세스에서 `Map<string, BrowserWindow>` 으로 관리
- 창 닫힘 이벤트(`closed`) 시 Map에서 자동 제거
- 각 창은 완전히 독립적 (별도 렌더러 프로세스)

**키보드 단축키:**

| 단축키 | 동작 |
|--------|------|
| `Ctrl+F` (macOS: `Cmd+F`) | 문서 내 텍스트 검색 (Electron 내장 findInPage) |
| `Ctrl+W` (macOS: `Cmd+W`) | 현재 뷰어 창 닫기 |
| `Ctrl++` / `Ctrl+-` (macOS: `Cmd`) | 확대/축소 (zoomLevel 조절) |
| `Ctrl+0` (macOS: `Cmd+0`) | 확대/축소 초기화 |
| `Ctrl+B` (macOS: `Cmd+B`) | 사이드바 토글 (사이드바가 있는 경우만) |
| `Ctrl+←` / `Alt+←` | 뒤로가기 (네비게이션 히스토리) |
| `Ctrl+→` / `Alt+→` | 앞으로가기 (네비게이션 히스토리) |
| `Esc` | always-on-top 해제 (foreground 창인 경우) |

- **예외**:
  - 렌더링 중 mermaid 파싱 에러 → 해당 블록만 에러 메시지로 대체, 나머지 정상 표시
  - 매우 큰 문서 (>5MB) → 성능 경고 표시하되 렌더링 시도

---

### FR-P-004: 링크 기반 사이드바 네비게이션

- **설명**: 문서 내 로컬 파일 링크를 재귀적으로 파싱하여 트리 구조를 만들고, 좌측 사이드바에 표시한다. 링크가 없으면 사이드바를 완전히 숨긴다.
- **입력**: 렌더러에서 현재 문서의 Markdown 원문 + 파일 경로 (선택)
- **처리**: 아래의 상세 알고리즘 참조
- **출력**: 사이드바 UI (트리) 또는 사이드바 완전 숨김

#### 4.1 링크 파싱 규칙

> **중요**: 링크 파싱은 반드시 **메인 프로세스**에서 수행한다 (sandbox 렌더러에서는 파일시스템 접근 불가).

**파싱 컨텍스트 제외 (링크를 파싱하지 않는 영역):**

| 영역 | 예시 | 이유 |
|------|------|------|
| 코드 블록 (fenced) | ` ```\n[link](./file.md)\n``` ` | 코드 예시일 뿐 실제 링크가 아님 |
| 인라인 코드 | `` `[link](./file.md)` `` | 코드 예시 |
| HTML 주석 | `<!-- [link](./file.md) -->` | 주석 처리된 내용 |

**파싱 구현**: `marked.lexer()`로 토큰화한 후, `type === 'code'` 또는 `type === 'codespan'` 토큰을 제외하고 나머지 토큰에서 링크를 추출한다. 참조 링크(`[텍스트][ref]` + `[ref]: ./path.md`)는 `marked.lexer()` 결과의 `tokens.links` 객체에서 참조 정의를 lookup하여 해석한다. 동일 참조가 여러 번 정의된 경우 첫 번째 정의를 사용한다 (Markdown 표준).

**파싱 대상 (로컬 파일 링크):**

| 문법 | 예시 | 파싱 결과 |
|------|------|-----------|
| 표준 Markdown 링크 | `[텍스트](./path/to/file.md)` | `./path/to/file.md` |
| 앵커 포함 링크 | `[텍스트](./guide.md#section)` | `./guide.md` (`#` 이후 제거) |
| 쿼리 포함 링크 | `[텍스트](./file.md?v=2)` | `./file.md` (`?` 이후 제거) |
| 확장자 없는 링크 | `[텍스트](./path/to/file)` | 1차: `./path/to/file.md` 존재 확인 → 있으면 사용, 2차: 원본 경로 `./path/to/file` 존재 확인 → 있으면 무시 (비-md 파일), 둘 다 없으면 무시 |
| 절대 경로 링크 | `[텍스트](/absolute/path.md)` | `/absolute/path.md` |
| 절대 경로 (Windows) | `[텍스트](C:/docs/file.md)` | `C:/docs/file.md` |
| Wiki 링크 | `[[path/to/file]]` | `path/to/file.md` (.md 자동 추가), 경로 해석: 현재 문서 디렉토리 기준 |
| Wiki 링크 (확장자 포함) | `[[path/to/file.md]]` | `path/to/file.md`, 경로 해석: 현재 문서 디렉토리 기준 |
| 참조 링크 | `[텍스트][ref]` + `[ref]: ./path.md` | `./path.md` |
| URL 인코딩 경로 | `[텍스트](./my%20file.md)` | `./my file.md` (디코딩 후 사용) |

**파싱 제외 (무시하는 링크):**

| 패턴 | 예시 | 제외 이유 |
|------|------|-----------|
| HTTP/HTTPS URL | `[텍스트](https://example.com)` | 웹 링크 |
| mailto 링크 | `[메일](mailto:a@b.com)` | 이메일 |
| tel 링크 | `[전화](tel:010-1234)` | 전화 |
| ftp 링크 | `[파일](ftp://server/file)` | 원격 파일 |
| 앵커 전용 링크 | `[섹션](#heading)` | 문서 내 앵커 (`#`으로 시작, 파일 경로 없음) |
| 데이터 URI | `[이미지](data:image/png;...)` | 인라인 데이터 |
| javascript/vbscript | `[악성](javascript:alert(1))` | 보안 위협 |
| 비-Markdown 파일 | `[이미지](./photo.png)` | 이미지/PDF 등 비문서 파일 |
| 코드 블록 내 링크 | (위 컨텍스트 제외 참조) | 코드 예시 |

**비-Markdown 파일 확장자 제외 목록:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.bmp`, `.ico`, `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.zip`, `.tar`, `.gz`, `.7z`, `.rar`, `.exe`, `.dmg`, `.mp3`, `.mp4`, `.wav`, `.avi`, `.mov`

**경로 해석 규칙:**

| 경로 유형 | 예시 | 해석 |
|-----------|------|------|
| 상대 경로 (./로 시작) | `./sub/file.md` | 현재 문서 디렉토리 기준 resolve |
| 상대 경로 (../로 시작) | `../other/file.md` | 현재 문서 디렉토리 기준 resolve |
| 상대 경로 (접두사 없음) | `sub/file.md` | 현재 문서 디렉토리 기준 resolve |
| 절대 경로 (/ 시작, Unix) | `/docs/file.md` | 파일시스템 루트 기준 |
| 절대 경로 (드라이브 문자) | `C:/docs/file.md` | 그대로 사용 |

**경로 정규화**: `path.resolve()` 후 `path.normalize()`로 중복 슬래시(`//`), `.`, `..` 처리. 심볼릭 링크는 **따라가지 않음** (`fs.lstat`으로 확인, 심볼릭 링크이면 무시).

#### 4.2 재귀 트리 빌드 알고리즘

```
FUNCTION buildLinkTree(filePath, visited = new Set(), depth = 0):
    IF depth > 10:
        RETURN null  // 최대 재귀 깊이 초과

    IF visited.has(normalize(filePath)):
        RETURN null  // 순환 참조 방지

    visited.add(normalize(filePath))

    content = readFile(filePath)
    IF content === null:
        RETURN { path: filePath, title: basename(filePath), exists: false, children: [] }

    links = parseLocalLinks(content)  // 위 파싱 규칙 적용
    resolvedLinks = links.map(link => resolvePath(link, dirname(filePath)))

    // 중복 제거 (같은 파일을 여러 번 링크한 경우)
    uniqueLinks = deduplicate(resolvedLinks)

    children = []
    FOR EACH linkPath IN uniqueLinks:
        child = buildLinkTree(linkPath, new Set(visited), depth + 1)
        IF child !== null:
            children.push(child)

    RETURN {
        path: filePath,
        title: extractTitle(content) OR basename(filePath, '.md'),
        exists: true,
        children: children
    }
```

**`extractTitle` 로직:**

1. YAML frontmatter의 `title` 필드가 있으면 사용
2. 문서 첫 번째 `# H1 헤딩` 텍스트 사용
3. 위 모두 없으면 파일명 (확장자 제외) 사용

**트리 노드 구조:**

```typescript
interface TreeNode {
  path: string;        // 절대 파일 경로
  title: string;       // 표시 이름
  exists: boolean;     // 파일 존재 여부
  children: TreeNode[];// 하위 링크된 문서들
}
```

#### 4.3 사이드바 네비게이션 모델

**네비게이션 모델: 루트 유지 (Root-Preserving)**

사이드바 트리는 **최초로 연 문서(루트)를 기준으로 한 번 빌드되며, 같은 창 내에서 다른 문서로 이동해도 트리 구조가 유지된다.** 현재 보고 있는 문서의 하이라이트만 변경된다.

| 동작 | 설명 |
|------|------|
| 최초 열기 | `buildLinkTree(rootFile)` 실행, 트리 빌드 |
| 사이드바 클릭 | 해당 문서 렌더링, 트리 유지, 하이라이트 이동 |
| 뒤로가기 | Ctrl+← (또는 Alt+←): 이전 문서로 이동, 트리 유지 |
| 앞으로가기 | Ctrl+→ (또는 Alt+→): 다음 문서로 이동, 트리 유지 |

**네비게이션 히스토리:**
- 각 창마다 독립적인 히스토리 스택 유지 (브라우저와 동일한 모델)
- `history = { stack: [filePath1, filePath2, ...], index: currentPosition }`
- 새 문서 이동 시 현재 index 이후의 forward 항목 제거 후 push, index 증가
- 뒤로가기: index 감소, 해당 문서 렌더링
- 앞으로가기: index 증가, 해당 문서 렌더링
- **최대 크기**: 50개. 초과 시 가장 오래된 항목 제거 (FIFO)

#### 4.4 사이드바 UI

**사이드바 표시 조건:**

| 조건 | 사이드바 |
|------|----------|
| `filePath`로 연 문서 + 트리 children > 0 | **표시** |
| `filePath`로 연 문서 + 트리 children = 0 | **완전 숨김** |
| `content`만으로 연 문서 (filePath 없음) | **완전 숨김** (상대 경로 resolve 불가) |
| `content` + `filePath` 동시 제공 + 링크 있음 | **표시** (filePath 기준으로 링크 해석) |

**"완전 숨김" 정의:**
- 사이드바 DOM 요소의 `display: none`
- 리사이즈 핸들 숨김
- 뷰어 영역이 `width: 100%` 차지
- 사이드바를 여는 버튼이나 토글이 존재하지 않음

**사이드바 표시 시 UI 상세:**

| 항목 | 사양 |
|------|------|
| 위치 | 창 왼쪽 |
| 기본 너비 | 260px (사용자가 드래그로 변경한 값은 electron-store의 `sidebarWidth`에 저장) |
| 최소 너비 | 150px |
| 최대 너비 | 창 너비의 50% |
| 리사이즈 | 오른쪽 경계 드래그로 조절 가능, 변경 시 설정에 자동 저장 |
| 트리 항목 아이콘 | 📄 (파일 존재), 📄❌ (파일 미존재, 회색 처리) |
| 트리 펼침/접힘 | 자식이 있는 노드는 ▶/▼ 토글, 펼침 상태는 창 내에서 유지 |
| 현재 문서 강조 | 배경색으로 하이라이트 + `scrollIntoView`로 자동 스크롤 (렌더링 완료 후). 하이라이트 대상이 접힌 노드 하위인 경우 부모 노드를 자동 펼침 |
| 클릭 동작 | 해당 문서를 같은 창에서 열기 (exists=true인 경우만), 트리 구조 유지 |
| 파일 미존재 항목 | 클릭 불가, 회색 텍스트, 커서 not-allowed |
| 긴 제목 처리 | `text-overflow: ellipsis; overflow: hidden; white-space: nowrap`. 마우스 호버 시 tooltip으로 전체 경로 표시 |
| 로딩 인디케이터 | 트리 빌드 3초 초과 시 사이드바 영역에 스피너 표시 (렌더러 본문은 이미 표시 중) |
| 200파일 초과 메시지 | 깊이 5의 자식이 있는 노드 하단에 `⋯ (N개 더)` 텍스트 노드 추가. 클릭 불가 (정보성 텍스트). 회색 이탤릭 스타일 |
| 사이드바 토글 (Ctrl+B) | 사이드바 show/hide 시 CSS `transition: width 200ms ease` 적용. 숨길 때 너비 0px + `overflow: hidden`. 다시 표시 시 저장된 너비로 복원 |
| 리사이즈 동작 | 드래그 중 `requestAnimationFrame`으로 실시간 너비 변경. 드래그 완료 시 electron-store에 저장 |

- **예외**:
  - 파일 읽기 실패 (권한 등) → 해당 노드를 exists=false로 처리
  - 순환 참조 → visited Set으로 자동 방지, 사용자에게 별도 알림 없음
  - 트리 빌드 시간 > 3초 → 로딩 인디케이터 표시 후 백그라운드 완료
  - 트리의 총 파일 수 > 200개 → 깊이 5로 제한 후 "더 많은 문서가 있습니다" 표시

---

### FR-P-005: 기존 기능 제거 목록

기존 Express 웹 서버 아키텍처의 모든 코드를 제거한다.

#### 5.1 삭제 대상 디렉토리

| 경로 | 설명 |
|------|------|
| `src/controllers/` | 모든 Express 컨트롤러 (12파일) |
| `src/controllers/admin/` | 어드민 컨트롤러 (5파일) |
| `src/middleware/` | Express 미들웨어 (4파일: auth, admin-auth, error-handler, ip-whitelist) |
| `src/routes/` | Express 라우트 (4파일: api, chatbot, mcp, context-mcp) |
| `src/services/chatbot/` | RAG 챗봇 서비스 전체 (46파일) |
| `src/services/mcp/` | 기존 MCP 서비스 (4파일) |
| `src/views/` | EJS 템플릿 전체 |
| `data/vector/` | HNSWLib 벡터 저장소 |
| `test/chatbot/` | 챗봇 테스트 |
| `test/mcp/` | 기존 MCP 테스트 |

#### 5.2 삭제 대상 파일

| 경로 | 설명 |
|------|------|
| `src/app.js` | Express 앱 진입점 |
| `src/services/cache-manager.js` | HTML 캐싱 |
| `src/services/cache-storage.js` | LRU 캐시 |
| `src/services/config-service.js` | 웹 서버 설정 관리 |
| `src/services/context-service.js` | 컨텍스트 관리 |
| `src/services/file-scanner-service.js` | 파일 스캐닝 |
| `src/services/file-service.js` | 파일 CRUD 서비스 |
| `src/services/frontmatter-service.js` | Frontmatter 파싱 |
| `src/services/markdown-renderer.js` | 서버사이드 렌더링 |
| `src/services/search-service.js` | 검색 서비스 |
| `src/services/session-service.js` | 세션 관리 |
| `src/services/tree-service.js` | 트리 생성 서비스 |
| `src/utils/config-loader.js` | JSON5 설정 로더 |
| `src/utils/config-watcher.js` | 설정 핫리로드 |
| `src/utils/path-validator.js` | 경로 검증 |
| `src/utils/backup-utils.js` | 백업 유틸리티 |
| `src/utils/lock-manager.js` | 동시성 락 |
| `src/utils/logger.js` | Winston 로거 |
| `src/utils/embedding-notifier.js` | 임베딩 알림 |
| `src/utils/ip-matcher.js` | IP 화이트리스트 |
| `src/utils/ssl-validator.js` | SSL 검증 |
| `src/utils/jsonrpc-utils.js` | JSON-RPC 유틸리티 |
| `public/js/app.js` | 웹 클라이언트 메인 |
| `public/js/admin.js` | 어드민 JS |
| `public/js/chatbot.js` | 챗봇 JS |
| `public/js/doclight-utils.js` | 웹 유틸리티 |
| `public/css/style.css` | 웹 스타일 |
| `public/css/admin.css` | 어드민 스타일 |
| `public/css/chatbot.css` | 챗봇 스타일 |
| `public/api-doc.md` | API 문서 |
| `public/mcp-doc.md` | MCP 문서 |
| `config.json5` | 웹 서버 설정 (예제 파일은 삭제, 새 설정으로 대체) |
| `config.example.json5` | 웹 서버 설정 예제 |
| `start.bat`, `stop.bat` | 서버 시작/중지 스크립트 |
| `scripts/` | 유틸리티 스크립트 전체 |

#### 5.3 유지 대상

| 경로 | 설명 | 용도 |
|------|------|------|
| `public/images/icon.png` | 앱 아이콘 | 트레이 아이콘, 창 아이콘으로 재활용 |
| `public/lib/marked.min.js` | Markdown 파서 | 렌더러 프로세스에서 사용 (또는 npm으로 대체) |
| `public/lib/mermaid.min.js` | 다이어그램 렌더링 | 렌더러에서 사용 (또는 npm으로 대체) |
| `public/lib/highlight.min.js` | 코드 하이라이팅 | 렌더러에서 사용 (또는 npm으로 대체) |
| `public/lib/purify.min.js` | HTML 새니타이징 | 렌더러에서 사용 (또는 npm으로 대체) |
| `docs/` | 문서 디렉토리 | 프로젝트 문서 보존 |
| `CLAUDE.md` | 프로젝트 가이드 | 업데이트 필요 |
| `README.md` | 프로젝트 README | 전면 재작성 필요 |
| `package.json` | 패키지 정의 | 의존성 전면 변경 |

---

### FR-P-006: 설정 및 구성

- **설명**: Electron 앱 및 MCP 서버의 설정 관리
- **입력**: 사용자 설정 (electron-store를 통한 JSON 저장)
- **처리**: 앱 시작 시 설정 로드, 변경 시 즉시 반영
- **출력**: 설정값 적용

**설정 스키마:**

```json
{
  "theme": "light",
  "fontSize": 16,
  "fontFamily": "system-ui, -apple-system, sans-serif",
  "codeTheme": "github",
  "defaultWindowWidth": 1000,
  "defaultWindowHeight": 750,
  "sidebarWidth": 260,
  "maxRecursionDepth": 10
}
```

| 설정 키 | 타입 | 기본값 | 설명 |
|---------|------|--------|------|
| `theme` | `"light" \| "dark"` | `"light"` | 뷰어 테마 |
| `fontSize` | `number` | `16` | 본문 폰트 크기 (px) |
| `fontFamily` | `string` | `"system-ui, -apple-system, sans-serif"` | 본문 폰트 |
| `codeTheme` | `string` | `"github"` | highlight.js 코드 테마 |
| `defaultWindowWidth` | `number` | `1000` | 새 창 기본 너비 |
| `defaultWindowHeight` | `number` | `750` | 새 창 기본 높이 |
| `sidebarWidth` | `number` | `260` | 사이드바 기본 너비 |
| `maxRecursionDepth` | `number` | `10` | 링크 재귀 탐색 최대 깊이 |

**설정 값 유효 범위:**

| 설정 키 | 유효 범위 | 범위 외 동작 |
|---------|----------|-------------|
| `theme` | `"light"`, `"dark"` | 기본값 `"light"` |
| `fontSize` | 8 ~ 32 | 기본값 16 |
| `fontFamily` | 비어있지 않은 문자열 | 기본값 사용 |
| `codeTheme` | highlight.js 유효 테마명 | 기본값 `"github"` |
| `defaultWindowWidth` | 400 ~ 3840 | 기본값 1000 |
| `defaultWindowHeight` | 300 ~ 2160 | 기본값 750 |
| `sidebarWidth` | 150 ~ 800 | 기본값 260 |
| `maxRecursionDepth` | 1 ~ 20 | 기본값 10 |

**설정 접근 UI:**

사용자는 다음 경로로 설정에 접근한다:
1. **트레이 컨텍스트 메뉴** → "설정" 클릭 → 설정 창(BrowserWindow) 열림
2. 설정 창에서 각 항목을 폼 UI로 변경
3. "저장" 클릭 시 electron-store에 즉시 저장
4. **테마 변경**: 저장 시 열린 모든 뷰어 창에 즉시 반영 (IPC `theme-changed` 브로드캐스트)
5. **폰트/코드테마 변경**: 저장 시 열린 모든 뷰어 창에 즉시 반영
6. **창 크기 변경**: 새로 열리는 창에만 적용 (기존 창 크기 유지)
7. "초기화" 버튼: 모든 설정을 기본값으로 리셋

- **예외**:
  - 설정 파일 손상 → 기본값으로 초기화, stderr에 경고 로그
  - 유효하지 않은 값 → 해당 키만 기본값 사용 (위 유효 범위 표 참조)

---

## 5. 비기능 요구사항

### NFR-P-001: 성능

| 항목 | 목표 | 비고 |
|------|------|------|
| 창 열기 (빈 문서) | < 300ms | BrowserWindow 생성 ~ DOM 준비 |
| 창 열기 (일반 문서) | < 500ms | 렌더링 포함 |
| Markdown 렌더링 (100KB) | < 200ms | marked + DOMPurify |
| Mermaid 다이어그램 렌더링 | < 1,000ms | 복잡도에 따라 변동 |
| 링크 트리 빌드 (10파일) | < 500ms | 재귀 파싱 포함 |
| 링크 트리 빌드 (50파일) | < 2,000ms | 로딩 인디케이터 표시 |
| MCP 요청 → 창 열림 | < 1,000ms | 전체 E2E |

### NFR-P-002: 보안

| 항목 | 요구사항 |
|------|----------|
| HTML 새니타이징 | DOMPurify로 모든 렌더링 HTML 필터링. `<script>`, `<iframe>`, `on*` 이벤트 제거 |
| 컨텍스트 분리 | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| preload 스크립트 | IPC 통신만 노출, 파일시스템 접근 불가 |
| MCP 입력 검증 | filePath의 path traversal 검증 (resolve 후 실제 경로 확인) |
| 외부 링크 처리 | 렌더링된 HTML 내 외부 링크 클릭 시 `shell.openExternal` 호출. **URL 프로토콜 화이트리스트**: `http:`, `https:` 만 허용. `javascript:`, `vbscript:`, `file:`, `data:` 등은 차단. URL 유효성 검증 후 호출 |
| 입력 크기 제한 | MCP `content` 파라미터 최대 10MB (10,485,760 bytes). 이를 초과하면 에러 반환 |
| IPC 소켓 접근 제어 | Unix Socket: 파일 퍼미션 `0o600` (소유자만 읽기/쓰기). Windows Named Pipe: 기본 ACL (현재 사용자 세션만 접근 가능). 외부 프로세스의 무단 접근 방지 |
| IPC 소켓 stale 파일 정리 | macOS/Linux: 앱 시작 시 `/tmp/doclight-ipc.sock`이 이미 존재하면 연결 시도. 연결 실패(ECONNREFUSED) → 파일 삭제 후 새로 생성. 연결 성공 → 이미 실행 중인 인스턴스로 판단 |
| CSP (Content Security Policy) | 렌더러의 `<meta>` 태그로 CSP 정의: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'`. Mermaid SVG 렌더링을 위해 `img-src data: blob:` 허용 |
| 파일 접근 범위 | 로컬 데스크톱 앱이므로 파일시스템 전체 읽기 허용 (OS 레벨 권한 준수). `.md` 확장자 제한과 파일 존재 확인으로 기본 검증. 심볼릭 링크는 `fs.lstat`으로 감지 후 무시 |

### NFR-P-003: 호환성

| 플랫폼 | 최소 버전 |
|--------|-----------|
| Windows | 10 (64-bit) 이상 |
| macOS | 12 (Monterey) 이상 |
| Linux | Ubuntu 20.04, Fedora 33 이상 |
| Electron | 33.x |
| Node.js | 20.x LTS |

### NFR-P-004: 리소스 사용

| 항목 | 제한 |
|------|------|
| 백그라운드 상주 (창 없음) | RAM < 50MB |
| 뷰어 창 1개 (일반 문서) | RAM < 100MB (추가) |
| 뷰어 창 1개 (대형 문서 + mermaid) | RAM < 200MB (추가) |
| 동시 최대 창 수 | 20개 (초과 시 MCP 에러 반환, FR-P-002 참조) |

---

## 6. 데이터 요구사항

### DR-P-001: 설정 데이터

| 항목 | 내용 |
|------|------|
| 저장 방식 | electron-store (JSON 파일, 플랫폼별 기본 경로) |
| 파일 위치 | `%APPDATA%/DocLight/config.json` (Windows), `~/Library/Application Support/DocLight/config.json` (macOS), `~/.config/DocLight/config.json` (Linux) |
| 스키마 | FR-P-006의 설정 스키마 참조 |
| 마이그레이션 | 버전 업그레이드 시 누락된 키는 기본값으로 보완 |

### DR-P-002: 윈도우 상태 관리

| 항목 | 내용 |
|------|------|
| 저장 방식 | 메인 프로세스 인메모리 `Map<string, WindowState>` |
| 영속성 | 앱 종료 시 소멸 (영구 저장 불필요) |
| 데이터 구조 | `{ windowId, filePath?, title, alwaysOnTop, bounds: {x,y,w,h} }` |

---

## 7. 인터페이스 요구사항

### IR-P-001: MCP 도구 스키마

**서버 capabilities:**

```json
{
  "capabilities": {
    "tools": {}
  }
}
```

**open_markdown 도구 전체 정의:**

```json
{
  "name": "open_markdown",
  "description": "Markdown 문서를 DocLight 뷰어 창에서 엽니다. Markdown 원문 텍스트 또는 파일 경로를 전달할 수 있습니다.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "content": {
        "type": "string",
        "description": "렌더링할 Markdown 원문 텍스트"
      },
      "filePath": {
        "type": "string",
        "description": "렌더링할 Markdown 파일의 경로 (절대 또는 상대)"
      },
      "foreground": {
        "type": "boolean",
        "description": "true이면 항상 최상위에 표시되는 always-on-top 창",
        "default": false
      },
      "title": {
        "type": "string",
        "description": "창 제목 (생략 시 자동 결정)"
      }
    },
    "anyOf": [
      { "required": ["content"] },
      { "required": ["filePath"] }
    ]
  }
}
```

**update_markdown 도구 전체 정의:**

```json
{
  "name": "update_markdown",
  "description": "이미 열린 DocLight 뷰어 창의 내용을 갱신합니다. 기존 창을 닫지 않고 Markdown을 교체합니다.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "windowId": {
        "type": "string",
        "description": "갱신할 창의 고유 ID (필수)"
      },
      "content": {
        "type": "string",
        "description": "새로운 Markdown 원문 텍스트"
      },
      "filePath": {
        "type": "string",
        "description": "새로운 Markdown 파일 경로"
      },
      "title": {
        "type": "string",
        "description": "창 제목 갱신 (생략 시 자동 결정)"
      }
    },
    "required": ["windowId"],
    "anyOf": [
      { "required": ["content"] },
      { "required": ["filePath"] }
    ]
  }
}
```

**close_viewer 도구 전체 정의:**

```json
{
  "name": "close_viewer",
  "description": "열린 DocLight 뷰어 창을 닫습니다. windowId를 지정하면 해당 창만, 생략하면 모든 창을 닫습니다.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "windowId": {
        "type": "string",
        "description": "닫을 창의 고유 ID (생략 시 모든 창 닫기)"
      }
    }
  }
}
```

**list_viewers 도구 전체 정의:**

```json
{
  "name": "list_viewers",
  "description": "현재 열려 있는 DocLight 뷰어 창 목록을 반환합니다.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

### IR-P-002: IPC 통신 채널 (Main ↔ Renderer)

| 채널 이름 | 방향 | 페이로드 | 설명 |
|-----------|------|----------|------|
| `render-markdown` | Main → Renderer | `{ markdown: string, filePath?: string, windowId: string }` | Markdown 데이터를 렌더러에 전달 |
| `update-markdown` | Main → Renderer | `{ markdown: string, filePath?: string }` | 기존 창의 내용 갱신 (스크롤 리셋) |
| `sidebar-tree` | Main → Renderer | `{ tree: TreeNode \| null }` | 사이드바 트리 데이터 (null이면 숨김) |
| `navigate-to` | Renderer → Main | `{ filePath: string }` | 사이드바에서 문서 클릭 시 네비게이션 요청. windowId는 메인 프로세스에서 `event.sender`의 `BrowserWindow.fromWebContents()`로 역추적 |
| `navigate-back` | Renderer → Main | `{ windowId: string }` | 뒤로가기 요청 (Ctrl+← 또는 Alt+←) |
| `navigate-forward` | Renderer → Main | `{ windowId: string }` | 앞으로가기 요청 (Ctrl+→ 또는 Alt+→) |
| `open-external` | Renderer → Main | `{ url: string }` | 외부 링크를 시스템 브라우저에서 열기 (http/https만 허용) |
| `window-ready` | Renderer → Main | `{ windowId: string }` | 렌더러 초기화 완료 알림 |
| `theme-changed` | Main → Renderer | `{ theme: "light" \| "dark", fontSize: number, ... }` | 설정 변경 시 모든 뷰어 창에 브로드캐스트 |

**preload.js 노출 API:**

```javascript
contextBridge.exposeInMainWorld('doclight', {
  // Main → Renderer 리스너 (cleanup 함수 반환)
  onRenderMarkdown: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('render-markdown', handler);
    return () => ipcRenderer.removeListener('render-markdown', handler);
  },
  onUpdateMarkdown: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('update-markdown', handler);
    return () => ipcRenderer.removeListener('update-markdown', handler);
  },
  onSidebarTree: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('sidebar-tree', handler);
    return () => ipcRenderer.removeListener('sidebar-tree', handler);
  },
  // Renderer → Main 전송
  navigateTo: (filePath) => ipcRenderer.send('navigate-to', { filePath }),
  navigateBack: () => ipcRenderer.send('navigate-back'),
  navigateForward: () => ipcRenderer.send('navigate-forward'),
  openExternal: (url) => ipcRenderer.send('open-external', { url }),
  notifyReady: () => ipcRenderer.send('window-ready')
});
```

> **메모리 누수 방지**: 모든 `on*` 리스너는 cleanup 함수를 반환한다. 렌더러에서 `window.addEventListener('beforeunload', cleanup)`으로 리스너를 정리해야 한다.

---

## 8. 아키텍처 개요

### 8.1 프로세스 구조

```
┌───────────────────────┐
│   MCP Client          │  (Claude Desktop, Claude Code 등)
│   (AI 에이전트)        │
└──────────┬────────────┘
           │ spawn + stdin/stdout pipe
           ▼
┌───────────────────────┐
│  MCP Bridge Process   │  ← 경량 Node.js (Electron 의존 없음)
│  (mcp-server.js)      │
│                       │
│  - StdioServerTransport│
│  - 4개 도구 등록       │
│    open_markdown       │
│    update_markdown     │
│    close_viewer        │
│    list_viewers        │
└──────────┬────────────┘
           │ Named Pipe (Win) / Unix Socket (macOS/Linux)
           ▼
┌─────────────────────────────────────────────────────────┐
│                    Electron Main Process                 │
│                                                          │
│  ┌──────────────┐  ┌─────────────────┐  ┌────────────┐  │
│  │ IPC Socket    │  │ Window Manager  │  │ System Tray│  │
│  │ Server        │  │ (Map<id,BW>)    │  │            │  │
│  │              │──▶│                 │  │            │  │
│  │ 요청 수신     │  │ createWindow()  │  │ [메뉴]     │  │
│  │ 응답 반환     │  │ closeWindow()   │  │  - 창목록  │  │
│  │              │  │ navigateTo()    │  │  - 종료    │  │
│  └──────────────┘  └────────┬────────┘  └────────────┘  │
│                             │ IPC                         │
└─────────────────────────────┼───────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Renderer Process │ │ Renderer Process │ │ Renderer Process │
│   (Window 1)     │ │   (Window 2)     │ │   (Window N)     │
│                  │ │                  │ │                  │
│ ┌──────┬───────┐ │ │ ┌──────────────┐ │ │ ┌──────────────┐ │
│ │Sidebar│Viewer │ │ │ │  Viewer Only │ │ │ │  Viewer Only │ │
│ │(Tree) │(MD)   │ │ │ │  (no links)  │ │ │ │  (foreground) │ │
│ └──────┴───────┘ │ │ └──────────────┘ │ │ └──────────────┘ │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### 8.2 디렉토리 구조 (새 구조)

```
DocLight/
├── src/
│   ├── main/                    # Electron 메인 프로세스
│   │   ├── index.js             # 앱 진입점 (app.ready, 트레이, 생명주기)
│   │   ├── mcp-server.js        # MCP 서버 (stdio, @modelcontextprotocol/sdk)
│   │   ├── window-manager.js    # BrowserWindow 생성/관리
│   │   ├── link-parser.js       # Markdown 링크 파싱 + 트리 빌드
│   │   └── preload.js           # contextBridge (IPC 노출)
│   └── renderer/                # Electron 렌더러 프로세스
│       ├── viewer.html          # 뷰어 HTML (사이드바 + 본문)
│       ├── viewer.js            # 뷰어 로직 (렌더링, 사이드바 UI)
│       ├── viewer.css           # 뷰어 스타일 (GitHub-flavored MD)
│       └── lib/                 # 클라이언트 라이브러리
│           ├── marked.min.js
│           ├── mermaid.min.js
│           ├── highlight.min.js
│           └── purify.min.js
├── assets/                      # 정적 리소스
│   ├── icon.png                 # 앱 아이콘 (256x256)
│   ├── icon.ico                 # Windows 아이콘
│   └── icon.icns                # macOS 아이콘
├── docs/                        # 프로젝트 문서 (유지)
├── package.json                 # 의존성 (전면 변경)
├── electron-builder.yml         # 빌드 설정
├── CLAUDE.md                    # 프로젝트 가이드 (재작성)
└── README.md                    # 사용자 가이드 (재작성)
```

### 8.3 데이터 흐름: MCP 호출 → 창 열림 → 렌더링

```
AI Agent (MCP Client)
    │
    │  stdin: {"jsonrpc":"2.0","method":"tools/call","params":{"name":"open_markdown","arguments":{"filePath":"C:/docs/README.md","foreground":true}}}
    ▼
MCP Bridge Process (mcp-server.js)  ← 경량 Node.js
    │
    │  1. MCP SDK가 JSON-RPC 파싱, open_markdown 도구 핸들러 호출
    │  2. 기본 입력 검증 (content/filePath 필수 체크)
    │  3. Named Pipe/Unix Socket으로 Electron 앱에 명령 전달:
    │     { "id": "req-uuid", "action": "open_markdown", "params": { "filePath": "C:/docs/README.md", "foreground": true } }
    ▼
Electron Main Process (index.js) — IPC Socket Server
    │
    │  4. 소켓 메시지 수신 → action 별 라우팅
    │  5. filePath 존재 확인 + 파일 읽기 (fs.readFile)
    │  6. windowManager.createWindow({ markdown, filePath, foreground: true })
    ▼
Window Manager (window-manager.js)
    │
    │  7. new BrowserWindow({ alwaysOnTop: true, ... })
    │  8. win.loadFile('viewer.html')
    │  9. 렌더러에서 'window-ready' IPC 수신 대기
    │  10. window-ready 수신 후 → IPC: win.webContents.send('render-markdown', { markdown, filePath, windowId })
    │  11. linkParser.buildLinkTree(filePath) → tree
    │  12. IPC: win.webContents.send('sidebar-tree', { tree })
    ▼
Renderer (viewer.js)
    │
    │  13. onRenderMarkdown: marked.parse(markdown)
    │  14. DOMPurify.sanitize(html)
    │  15. document.getElementById('content').innerHTML = sanitized
    │  16. mermaid.run()
    │  17. hljs.highlightAll()
    │  18. onSidebarTree: tree가 있으면 사이드바 렌더링, 없으면 숨김
    ▼
Electron Main → Socket 응답:
    { "id": "req-uuid", "result": { "windowId": "abc-123", "title": "README" } }
    ▼
MCP Bridge → stdout:
    {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"뷰어 창이 열렸습니다. (windowId: abc-123, title: README)"}]}}
```

---

## 9. 제약사항

| 구분 | 제약 내용 |
|------|-----------|
| 문서 형식 | Markdown (.md) 파일만 지원 |
| 문서 접근 | 읽기 전용 (편집 기능 없음) |
| MCP 전송 | stdio만 지원 (SSE, WebSocket 미지원) |
| 네트워크 | 앱이 네트워크를 노출하지 않음 (순수 로컬 프로세스) |
| 인증 | 없음 (로컬 프로세스이므로 불필요) |
| 데이터베이스 | 사용하지 않음 |
| 링크 파싱 깊이 | 최대 10단계 재귀 |
| 사이드바 | 링크 기반 동적 구성만 지원 (정적 트리 미지원) |
| 운영 | 단일 인스턴스 (중복 실행 방지) |

---

## 10. 인수 조건 (Acceptance Criteria)

### AC-P-001: Electron 앱 기본 구조

```
Given: DocLight가 설치되어 있고 실행되지 않은 상태
When: DocLight를 실행한다
Then: 시스템 트레이에 DocLight 아이콘이 나타나고, MCP 서버가 stdin/stdout으로 요청을 대기한다
  And: 메인 윈도우는 열리지 않는다 (트레이 전용)
```

```
Given: DocLight가 이미 실행 중인 상태
When: DocLight를 다시 실행 시도한다
Then: 새 인스턴스가 시작되지 않고, 기존 인스턴스가 유지된다
```

```
Given: DocLight가 트레이에 상주 중이고 뷰어 창이 2개 열린 상태
When: 트레이 메뉴에서 "모든 창 닫기"를 클릭한다
Then: 모든 뷰어 창이 닫히고, DocLight는 트레이에 계속 상주한다
```

```
Given: DocLight가 트레이에 상주 중인 상태
When: 트레이 메뉴에서 "DocLight 종료"를 클릭한다
Then: 모든 창이 닫히고 MCP 서버가 종료되며 앱이 완전히 종료된다
```

### AC-P-002: MCP 서버 — open_markdown

```
Given: MCP 서버가 실행 중인 상태
When: open_markdown 도구를 content="# Hello\nWorld" 파라미터로 호출한다
Then: 새 뷰어 창이 열리고 "Hello" 제목의 H1과 "World" 텍스트가 렌더링된다
  And: windowId가 포함된 성공 응답이 반환된다
  And: 사이드바는 표시되지 않는다 (content 모드)
```

```
Given: MCP 서버가 실행 중인 상태
When: open_markdown 도구를 filePath="C:/docs/README.md" 파라미터로 호출한다 (파일이 존재)
Then: 해당 파일의 내용이 렌더링된 새 뷰어 창이 열린다
  And: 창 제목은 "README"이다
```

```
Given: MCP 서버가 실행 중인 상태
When: open_markdown 도구를 filePath="C:/nonexistent.md" 파라미터로 호출한다 (파일 미존재)
Then: 에러 응답 "파일을 찾을 수 없습니다: C:/nonexistent.md"가 반환된다
  And: 뷰어 창은 열리지 않는다
```

```
Given: MCP 서버가 실행 중인 상태
When: open_markdown 도구를 foreground=true 파라미터와 함께 호출한다
Then: always-on-top 속성이 설정된 뷰어 창이 열린다
  And: 다른 앱 창 위에 항상 표시된다
```

```
Given: 이미 뷰어 창이 1개 열린 상태
When: open_markdown 도구를 다시 호출한다
Then: 기존 창은 유지되고 새로운 뷰어 창이 추가로 열린다
```

```
Given: MCP 서버가 실행 중인 상태
When: open_markdown 도구를 content와 filePath 모두 없이 호출한다
Then: 에러 응답 "content 또는 filePath 중 하나는 필수입니다."가 반환된다
```

### AC-P-003: MCP 서버 — close_viewer

```
Given: windowId "abc-123"인 뷰어 창이 열린 상태
When: close_viewer 도구를 windowId="abc-123"으로 호출한다
Then: 해당 창이 닫히고 "뷰어 창 1개를 닫았습니다." 응답이 반환된다
```

```
Given: 뷰어 창이 3개 열린 상태
When: close_viewer 도구를 windowId 없이 호출한다
Then: 모든 뷰어 창이 닫히고 "뷰어 창 3개를 닫았습니다." 응답이 반환된다
```

### AC-P-004: 링크 기반 사이드바

```
Given: README.md 파일에 [가이드](./guide.md)와 [API](./api/reference.md) 링크가 있고, guide.md에 [FAQ](./faq.md) 링크가 있는 상태
When: open_markdown으로 README.md를 파일 경로로 연다
Then: 좌측 사이드바에 다음 트리가 표시된다:
  - README (현재 문서, 하이라이트)
    - 가이드
      - FAQ
    - API Reference
  And: 사이드바 너비는 260px이다
  And: 리사이즈 핸들이 표시된다
```

```
Given: single.md 파일에 로컬 파일 링크가 없고 https://example.com 링크만 있는 상태
When: open_markdown으로 single.md를 파일 경로로 연다
Then: 사이드바가 완전히 숨겨지고 뷰어가 전체 너비를 차지한다
  And: 사이드바를 여는 UI 요소가 존재하지 않는다
```

```
Given: a.md → b.md → a.md (순환 참조) 구조의 파일들
When: open_markdown으로 a.md를 연다
Then: 사이드바에 a → b 트리가 표시되고 무한 루프 없이 정상 동작한다
```

```
Given: 사이드바 트리에 guide.md 항목이 표시된 상태 (Root-Preserving 모델)
When: 사이드바에서 guide.md 항목을 클릭한다
Then: 같은 뷰어 창에서 guide.md의 내용으로 교체되고, 사이드바 트리 구조는 유지되며 guide.md 항목이 하이라이트된다
  And: 네비게이션 히스토리에 guide.md가 추가된다
```

```
Given: content 파라미터로 Markdown 텍스트를 전달하여 창을 열었고, 텍스트 내에 [링크](./file.md)가 있는 상태
When: 창이 렌더링된다
Then: 사이드바는 숨겨진다 (파일 경로 없이 상대 경로 resolve 불가)
```

```
Given: 문서에 존재하지 않는 파일 [없는문서](./missing.md) 링크가 있는 상태
When: open_markdown으로 해당 문서를 연다
Then: 사이드바 트리에 "없는문서" 항목이 회색으로 표시되고 클릭 불가능하다
```

### AC-P-005: MCP 서버 — update_markdown

```
Given: windowId "abc-123"인 뷰어 창이 "Hello" 내용으로 열려 있는 상태
When: update_markdown 도구를 windowId="abc-123", content="# Updated\nNew content"로 호출한다
Then: 해당 창의 내용이 "Updated" 제목과 "New content"로 교체된다
  And: 스크롤 위치가 상단으로 리셋된다
  And: 창 위치/크기는 유지된다
```

```
Given: windowId "abc-123"인 뷰어 창이 열려 있는 상태
When: update_markdown 도구를 windowId="nonexistent"로 호출한다
Then: 에러 응답 "해당 windowId의 창을 찾을 수 없습니다: nonexistent"가 반환된다
```

### AC-P-006: MCP 서버 — list_viewers

```
Given: 뷰어 창이 2개 열려 있는 상태 (abc-123: README.md always-on-top, def-456: guide.md)
When: list_viewers 도구를 호출한다
Then: "열린 뷰어: 2개\n- [abc-123] README.md (always-on-top)\n- [def-456] guide.md" 응답이 반환된다
```

```
Given: 뷰어 창이 하나도 열려 있지 않은 상태
When: list_viewers 도구를 호출한다
Then: "열린 뷰어: 0개" 응답이 반환된다
```

### AC-P-007: 설정 관리

```
Given: 사용자가 사이드바 너비를 300px로 드래그한 후 창을 닫은 상태
When: 새 뷰어 창을 열고 사이드바가 표시되는 문서를 연다
Then: 사이드바 너비가 300px로 복원된다
```

```
Given: electron-store의 설정 파일이 손상된 상태
When: DocLight 앱을 실행한다
Then: 모든 설정이 기본값으로 초기화되고 앱이 정상 실행된다
```

### AC-P-008: 외부 링크 및 보안

```
Given: 뷰어에 [Google](https://google.com) 링크가 렌더링된 상태
When: 해당 링크를 클릭한다
Then: 시스템 기본 브라우저에서 https://google.com 이 열린다
  And: 뷰어 창은 영향 없이 유지된다
```

```
Given: 뷰어에 [악성](javascript:alert(1)) 링크가 있는 Markdown이 렌더링되는 상태
When: DOMPurify가 HTML을 새니타이징한다
Then: javascript: 프로토콜 링크가 제거되고 클릭 불가능하다
```

### AC-P-009: 창 제목 및 content+filePath 동시 제공

```
Given: MCP 서버가 실행 중인 상태
When: open_markdown 도구를 title="My Custom Title", content="# Hello"로 호출한다
Then: 뷰어 창의 제목이 "My Custom Title"이다 (H1 "Hello"가 아님)
```

```
Given: /docs/README.md 파일에 [가이드](./guide.md) 링크가 있고, guide.md가 존재하는 상태
When: open_markdown 도구를 content="# Dynamic Content\n[가이드](./guide.md)", filePath="/docs/README.md"로 호출한다
Then: "Dynamic Content"와 링크가 렌더링되고, 사이드바에 guide.md가 트리에 표시된다
  And: 사이드바 링크 해석은 /docs/ 디렉토리 기준으로 수행된다
```

### AC-P-010: 키보드 단축키

```
Given: 뷰어 창이 열려 있고 문서가 렌더링된 상태
When: Ctrl+F를 누른다
Then: 문서 내 텍스트 검색 바가 표시된다
```

```
Given: 사이드바에서 guide.md를 클릭하여 이동한 상태 (히스토리: [README.md, guide.md])
When: Ctrl+← (또는 Alt+←)를 누른다
Then: README.md 내용으로 돌아가고 사이드바에서 README.md가 하이라이트된다
```

---

## 11. 테스트 항목

| ID | 테스트 시나리오 | 기대 결과 |
|----|----------------|-----------|
| T-01 | 앱 실행 시 트레이 아이콘 표시 | 시스템 트레이에 DocLight 아이콘 나타남 |
| T-02 | 중복 실행 방지 | 두 번째 인스턴스 실행 시 기존 인스턴스 유지 |
| T-03 | MCP open_markdown (content) | 새 뷰어 창에 Markdown 렌더링 |
| T-04 | MCP open_markdown (filePath) | 파일 내용을 새 창에 표시 |
| T-05 | MCP open_markdown (foreground=true) | always-on-top 창 생성 |
| T-06 | MCP open_markdown (잘못된 경로) | 에러 응답, 창 안 열림 |
| T-07 | MCP open_markdown (content+filePath 없음) | 에러 응답 |
| T-08 | MCP close_viewer (특정 ID) | 해당 창만 닫힘 |
| T-09 | MCP close_viewer (ID 없음) | 모든 창 닫힘 |
| T-10 | MCP list_viewers | 열린 창 목록 반환 |
| T-11 | 다중 창 동시 열기 (3개) | 3개 독립 창 모두 열림 |
| T-12 | 사이드바 — 링크 있는 문서 | 좌측 사이드바에 트리 표시 |
| T-13 | 사이드바 — 링크 없는 문서 | 사이드바 완전 숨김 |
| T-14 | 사이드바 — content 모드 | 사이드바 완전 숨김 |
| T-15 | 사이드바 — 순환 참조 | 무한 루프 없이 트리 표시 |
| T-16 | 사이드바 — 존재하지 않는 파일 링크 | 회색 처리, 클릭 불가 |
| T-17 | 사이드바 — 트리 항목 클릭 | 같은 창에서 문서 전환 |
| T-18 | Markdown 렌더링 — 코드 블록 | highlight.js 하이라이팅 적용 |
| T-19 | Markdown 렌더링 — Mermaid 다이어그램 | 다이어그램 정상 렌더링 |
| T-20 | Markdown 렌더링 — XSS 시도 | DOMPurify로 script 태그 제거 |
| T-21 | 트레이 메뉴 — 모든 창 닫기 | 열린 창 전부 닫힘, 앱 상주 |
| T-22 | 트레이 메뉴 — 종료 | 앱 완전 종료 |
| T-23 | 외부 링크 클릭 | 시스템 브라우저에서 열림 |
| T-24 | 대형 문서 렌더링 (1MB) | 정상 렌더링 (성능 경고 가능) |
| T-25 | MCP update_markdown (유효한 windowId) | 기존 창 내용 갱신, 스크롤 리셋 |
| T-26 | MCP update_markdown (잘못된 windowId) | 에러 응답, 기존 창 영향 없음 |
| T-27 | list_viewers (창 없음) | "열린 뷰어: 0개" 응답 |
| T-28 | content + filePath 동시 제공 | content 렌더링 + filePath 기준 사이드바 |
| T-29 | 코드 블록 내 링크 | 사이드바 트리에 포함되지 않음 |
| T-30 | 앵커/쿼리 파라미터 포함 링크 | # 이후, ? 이후 제거하여 파일 경로만 사용 |
| T-31 | URL 인코딩 파일 경로 | 디코딩 후 정상 파일 접근 |
| T-32 | 키보드 단축키 — Ctrl+F | 검색 바 표시 |
| T-33 | 키보드 단축키 — Ctrl+W | 현재 창 닫힘 |
| T-34 | 키보드 단축키 — Ctrl+←/→ | 네비게이션 히스토리 뒤로/앞으로 |
| T-35 | MCP Bridge → Electron IPC 소켓 통신 | 정상 요청/응답 주고받기 |
| T-36 | Electron 앱 미실행 시 Bridge 자동 실행 | 앱 자동 시작 후 소켓 연결 |
| T-37 | shell.openExternal URL 화이트리스트 | http/https만 허용, javascript: 차단 |
| T-38 | 창 20개 초과 시 open_markdown | 에러 응답 반환 |
| T-39 | content 10MB 초과 | 에러 응답 반환 |
| T-40 | 사이드바 너비 변경 후 재오픈 | electron-store에서 복원 |
| T-41 | 사이드바 scrollIntoView | 현재 문서가 보이는 위치로 자동 스크롤 |
| T-42 | Wiki 링크 파싱 `[[path/to/file]]` | .md 자동 추가, 트리에 포함 |
| T-43 | 창 캐스케이딩 위치 | 두 번째 창이 x+30, y+30 오프셋 |
| T-44 | update_markdown에서 content+filePath 동시 제공 | content 렌더링 + filePath 기준 사이드바 재구성 |
| T-45 | 사이드바 리사이즈 최소/최대 경계 | 150px 미만 드래그 시 150px 고정, 창 50% 초과 시 클램프 |
| T-46 | .md가 아닌 filePath 제공 | 에러 응답 "Markdown 파일만 지원합니다" |
| T-47 | filePath 읽기 권한 없는 파일 | 에러 응답 "파일을 읽을 수 없습니다" |
| T-48 | IPC 소켓 연결 끊김 후 재연결 | Bridge 재시작 시 Electron과 소켓 재연결 |
| T-49 | Esc 키로 always-on-top 해제 | foreground 창이 일반 창으로 전환 |
| T-50 | Ctrl+B 사이드바 토글 | 사이드바 숨김/표시 전환 (애니메이션 200ms) |
| T-51 | Ctrl++/- 확대/축소 및 Ctrl+0 초기화 | zoomLevel 변경 확인 |
| T-52 | 참조 링크 [ref]: ./path.md 파싱 | 트리에 해당 경로 포함 |
| T-53 | 심볼릭 링크 파일 무시 | fs.lstat 감지, 트리에서 제외 |
| T-54 | 트레이 메뉴 창 포커스 | "열린 창 목록"에서 클릭 시 해당 창 활성화 |
| T-55 | 설정 마이그레이션 (누락 키 기본값) | 버전 업그레이드 후 누락 키가 기본값으로 보충됨 |
| T-56 | 히스토리 뒤로가기 후 새 이동 시 forward 제거 | 브라우저 표준 동작 검증 |
| T-57 | 대형 트리 200+ 파일 깊이 제한 | 깊이 5 제한 + "⋯ (N개 더)" 표시 |
| T-58 | content 정확히 10MB 경계값 | 10,485,760 bytes 허용, +1 byte 거부 |
| T-59 | IPC 소켓 메시지 프레이밍 (ndjson) | 여러 메시지 연속 전송 시 정상 파싱 |
| T-60 | Bridge 요청 10초 타임아웃 | Electron 미응답 시 타임아웃 에러 반환 |
| T-61 | Unix socket stale 파일 정리 | 비정상 종료 후 재시작 시 정상 동작 |
| T-62 | 설정 UI 열기/변경/저장 | 트레이 → 설정 → 테마 변경 → 저장 → 즉시 반영 |

---

## 12. 의존성 변경

### 12.1 제거할 패키지

| 패키지 | 이유 |
|--------|------|
| `express` | 웹 서버 제거 |
| `ejs` | 서버 템플릿 제거 |
| `multer` | 파일 업로드 제거 |
| `archiver` | ZIP 생성 제거 |
| `adm-zip` | ZIP 처리 제거 |
| `ignore` | excludes 필터 제거 |
| `winston` | 웹 서버 로깅 제거 |
| `winston-daily-rotate-file` | 로그 로테이션 제거 |
| `json5` | JSON5 설정 제거 |
| `async-lock` | 동시성 제어 제거 |
| `puppeteer` | 브라우저 자동화 제거 |
| `cookie-parser` | 쿠키 처리 제거 |
| `jsdom` | DOM 조작 (서버) 제거 |
| `chokidar` | 파일 감시 제거 |
| `@langchain/community` | RAG 챗봇 제거 |
| `@langchain/core` | RAG 챗봇 제거 |
| `@langchain/langgraph` | RAG 워크플로우 제거 |
| `@langchain/ollama` | LLM 연동 제거 |
| `@langchain/openai` | LLM 연동 제거 |
| `@langchain/textsplitters` | 텍스트 분할 제거 |
| `langchain` | RAG 프레임워크 제거 |
| `hnswlib-node` | 벡터 DB 제거 |
| `zod` | 스키마 검증 제거 |
| `nodemon` (dev) | 서버 개발 도구 제거 |
| `@playwright/test` (dev) | 브라우저 테스트 제거 |
| `playwright` (dev) | 브라우저 테스트 제거 |
| `cross-env` (dev) | 환경변수 도구 제거 |

### 12.2 추가할 패키지

| 패키지 | 용도 |
|--------|------|
| `electron` (dev) | Electron 런타임 |
| `electron-builder` (dev) | 앱 패키징 및 배포 |
| `@modelcontextprotocol/sdk` | MCP 서버 SDK (stdio 전송) |
| `electron-store` | 사용자 설정 영구 저장 |
| `uuid` | 창 ID 생성 |

### 12.3 유지할 패키지

| 패키지 | 용도 | 비고 |
|--------|------|------|
| `marked` | Markdown → HTML 변환 | 렌더러에서 사용 |
| `highlight.js` | 코드 하이라이팅 | 렌더러에서 사용 |
| `dompurify` | HTML 새니타이징 | 렌더러에서 사용 |

> **참고**: `mermaid`는 기존 `public/lib/mermaid.min.js`를 렌더러에서 직접 로드하거나 npm으로 설치하여 사용. 번들 크기가 크므로 CDN 로컬 카피 방식 유지 권장.

---

## 13. 마이그레이션 계획

### Phase 1: 기존 코드 정리

1. FR-P-005의 삭제 대상 디렉토리/파일 전부 삭제
2. `package.json`에서 제거 대상 패키지 모두 제거
3. `node_modules` 삭제 후 재설치
4. 빌드/실행 확인 (깨끗한 상태)

### Phase 2: Electron 스캐폴딩

1. `electron`, `electron-builder` 설치
2. `src/main/index.js` 작성 (앱 진입점, 트레이, 생명주기)
3. `src/main/preload.js` 작성 (IPC 노출)
4. `src/renderer/viewer.html` + `viewer.css` 작성 (기본 레이아웃)
5. `package.json`의 `main` 필드를 `src/main/index.js`로 변경
6. `npm start`로 Electron 앱 기동 확인

### Phase 3: MCP 서버 구현

1. `@modelcontextprotocol/sdk` 설치
2. `src/main/mcp-server.js` 작성 (stdio 서버, 3개 도구)
3. `src/main/window-manager.js` 작성 (창 생성/관리)
4. MCP 서버와 Electron 메인 프로세스 통합
5. Claude Desktop에서 MCP 도구 호출 테스트

### Phase 4: 뷰어 + 사이드바 구현

1. `src/renderer/viewer.js` 작성 (Markdown 렌더링 파이프라인)
2. `src/main/link-parser.js` 작성 (링크 파싱 + 트리 빌드)
3. 사이드바 UI 구현 (트리 렌더링, 숨김 로직)
4. 사이드바 네비게이션 (클릭 → 문서 전환)
5. 전체 통합 테스트

---

## 부록: 평가 결과

### 라운드 1 (초안 대상, 피드백 반영 전)

| 기준 | 기술 아키텍트 | QA 전문가 | UX/제품 분석가 | 만장일치 A+ |
|------|-------------|---------|---------------|:---------:|
| 요구사항 완전성 | B+ (85) | A (90) | B+ (88) | ❌ |
| 구현 명확성 | A (92) | B+ (85) | A (91) | ❌ |
| 이전 버전 일관성 | A+ (96) | A+ (95) | A+ (97) | ✅ |
| Electron 아키텍처 적합성 | B (78) | A (90) | A (91) | ❌ |
| MCP 프로토콜 정합성 | B+ (88) | A (92) | B+ (85) | ❌ |
| 사이드바 UX 완성도 | A (90) | B+ (82) | B+ (86) | ❌ |
| 보안 및 리소스 관리 | B+ (85) | B+ (88) | B (80) | ❌ |

**만장일치 A+ 달성: 1/7 기준**

**주요 지적 사항 (라운드 1에서 반영 완료):**
- MCP stdio 서버와 Electron GUI 프로세스 분리 (Named Pipe/Unix Socket IPC)
- `update_markdown` 도구 추가
- 코드 블록 내 링크 파싱 제외 규칙
- 사이드바 네비게이션 모델 명확화 (Root-Preserving)
- `shell.openExternal` URL 프로토콜 화이트리스트
- 창 수 제한 (20개), content 크기 제한 (10MB)
- 키보드 단축키 정의
- IPC 채널 확장 (네비게이션 히스토리, update-markdown)
- preload.js 리스너 cleanup 패턴
- 추가 인수 조건 및 테스트 항목

### 라운드 2 (라운드 1 피드백 반영 후)

| 기준 | 기술 아키텍트 | QA 전문가 | UX/제품 분석가 | 만장일치 A+ |
|------|-------------|---------|---------------|:---------:|
| 요구사항 완전성 | A (93) | A (93) | A (93) | ❌ |
| 구현 명확성 | A (91) | A (92) | A+ (95) | ❌ |
| 이전 버전 일관성 | A+ (97) | A+ (96) | A+ (97) | ✅ |
| Electron 아키텍처 적합성 | A (90) | A (93) | A (93) | ❌ |
| MCP 프로토콜 정합성 | A (92) | A (91) | A (92) | ❌ |
| 사이드바 UX 완성도 | A (91) | A (91) | A (91) | ❌ |
| 보안 및 리소스 관리 | A (90) | A (90) | A (91) | ❌ |

**만장일치 A+ 달성: 1/7 기준**

**주요 지적 사항 (라운드 2에서 반영 완료):**
- IPC 소켓 메시지 프레이밍 프로토콜 (ndjson) 정의
- IPC 요청-응답 타임아웃 (10초) 정의
- Bridge 프로세스 자동 실행 경로 결정 로직 (개발/프로덕션 분기)
- Bridge graceful shutdown 시퀀스
- Bridge 로깅 전략 (stderr)
- filePath 상대경로 CWD 결정 로직 명확화
- update_markdown의 title 파라미터 및 content+filePath 동시 제공 처리
- update_markdown 도구 정의를 IR-P-001에 추가
- 설정 UI 접근 경로 (트레이 → 설정 창)
- 설정 값 유효 범위 정의
- 테마 변경 시 열린 창 즉시 반영 (theme-changed IPC)
- Unix socket stale 파일 정리 로직
- IPC 소켓 접근 제어 (파일 퍼미션/ACL)
- CSP (Content Security Policy) 정의
- 파일 접근 범위 정책 명시
- DOMPurify 설정 상세 (USE_PROFILES)
- 렌더러 라이브러리 로딩 전략 (script 태그)
- 네비게이션 히스토리 최대 50개 + forward 스택 제거 로직
- 캐스케이딩 위치 화면 경계 처리 (wrap-around)
- 사이드바 토글 애니메이션 (200ms transition)
- 트리 로딩 인디케이터 (스피너)
- 200파일 초과 "⋯ (N개 더)" UI 명세
- 사이드바 텍스트 ellipsis + tooltip
- 자동 펼침 (하이라이트 대상 부모 노드)
- 리사이즈 requestAnimationFrame
- 참조 링크 파싱 (tokens.links) 구현 힌트
- window-ready → render-markdown 전송 순서 명시
- navigate-to에서 windowId를 sender 기반 역추적
- 트레이 메뉴 열린 창 최대 10개 표시
- 추가 테스트 항목 19개 (T-44 ~ T-62)

### 라운드 3 (라운드 2 피드백 반영 후) — 최종

| 기준 | 기술 아키텍트 | QA 전문가 | UX/제품 분석가 | 만장일치 A+ |
|------|-------------|---------|---------------|:---------:|
| 요구사항 완전성 | A+ (96) | A+ (95+) | A+ (96) | ✅ |
| 구현 명확성 | A+ (95) | A+ (95+) | A+ (97) | ✅ |
| 이전 버전 일관성 | A+ (97) | A+ (95+) | A+ (97) | ✅ |
| Electron 아키텍처 적합성 | A+ (95) | A+ (95+) | A+ (95) | ✅ |
| MCP 프로토콜 정합성 | A+ (96) | A+ (95+) | A+ (95) | ✅ |
| 사이드바 UX 완성도 | A+ (95) | A+ (95+) | A+ (95) | ✅ |
| 보안 및 리소스 관리 | A+ (95) | A+ (95+) | A+ (95) | ✅ |

**만장일치 A+ 달성: 7/7 기준 — 평가 완료**

**비차단 향후 고려사항 (1.0 이후):**
- 접근성: 사이드바 키보드 탐색(Arrow Up/Down), ARIA 속성
- 다크 모드 시 Mermaid 테마 연동
- 트레이 아이콘 더블클릭 동작 (플랫폼별)
- AI 에이전트 연속 update_markdown 호출 시 rate limiting/debounce
- auto-updater 전략
- macOS 코드 서명/공증
