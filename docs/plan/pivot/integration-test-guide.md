# 통합 테스트 가이드 — DocLight Electron + MCP Pivot

작성일: 2026-02-14

## 참조 문서

- SRS: [srs.pivot.md](../srs.pivot.md) (T-01 ~ T-62)
- 아키텍처: [00-1.architecture.md](pivot/00-1.architecture.md)
- Phase 검증: [verification/](pivot/verification/)

---

## 1. 핵심 목적

AI 에이전트 → MCP Bridge (stdio) → IPC Socket (ndjson) → Electron Main Process → WindowManager → Renderer 프로세스까지의 **전체 E2E 파이프라인**이 정상 동작하는지 검증한다.

Phase별 검증은 컴포넌트 단위 확인이고, 본 통합 테스트는 **컴포넌트 간 연결**이 올바른지 확인하는 데 초점을 둔다.

---

## 2. 테스트 환경

### 2.1 필수 런타임

| 항목 | 최소 버전 | 비고 |
|------|-----------|------|
| Node.js | 20.x LTS | MCP Bridge + Electron |
| Electron | 33.x | Chromium 130+ 내장 |
| npm | 10.x | 패키지 관리 |

### 2.2 지원 플랫폼

| 플랫폼 | IPC 경로 | 테스트 우선순위 |
|--------|----------|-----------------|
| Windows 10/11 (64-bit) | `\\.\pipe\doclight-ipc` | P0 (주 개발 환경) |
| macOS 12+ (Monterey) | `/tmp/doclight-ipc.sock` | P1 |
| Linux (Ubuntu 20.04+) | `/tmp/doclight-ipc.sock` | P2 |

### 2.3 테스트 데이터

```
test-fixtures/
├── simple.md           # 기본 Markdown (H1, 코드, 리스트)
├── with-links.md       # 로컬 링크 3개 포함
├── linked-doc-a.md     # with-links.md에서 참조
├── linked-doc-b.md     # with-links.md에서 참조
├── circular-a.md       # circular-b.md 상호 참조
├── circular-b.md       # circular-a.md 상호 참조
├── large-10mb.md       # 10MB 경계 문서
├── xss-test.md         # <script>, onclick 등 XSS 벡터
├── mermaid-test.md     # Mermaid 다이어그램 포함
├── code-block-links.md # 코드 블록 내 링크 포함
└── wiki-links.md       # [[wiki-link]] 문법 포함
```

---

## 3. E2E 시나리오

### 3.1 CRITICAL: MCP open_markdown 전체 플로우

#### E2E-01: content 모드 전체 플로우 (T-03)

```
Given: Electron 앱이 시스템 트레이에 상주하고, MCP Bridge가 IPC 소켓으로 연결된 상태
When: MCP 클라이언트가 open_markdown({content: "# 통합 테스트\n\n본문입니다."})를 호출한다
Then:
  - MCP Bridge가 IPC 소켓으로 open_markdown 요청을 전송한다
  - Electron Main이 요청을 수신하고 WindowManager.createWindow()를 호출한다
  - 새 BrowserWindow가 생성되고 viewer.html이 로드된다
  - 렌더러가 window-ready IPC를 전송한다
  - 메인이 render-markdown IPC로 Markdown 데이터를 전달한다
  - 렌더러가 marked→DOMPurify→DOM→mermaid→hljs 파이프라인을 실행한다
  - MCP 클라이언트에 {windowId, title: "통합 테스트"} 응답이 반환된다
  - 사이드바는 숨김 상태이다
```

#### E2E-02: filePath 모드 전체 플로우 (T-04)

```
Given: Electron 앱 상주, MCP Bridge 연결, test-fixtures/with-links.md 파일 존재
When: MCP 클라이언트가 open_markdown({filePath: "<absolute-path>/with-links.md"})를 호출한다
Then:
  - Electron Main이 파일을 읽고 BrowserWindow를 생성한다
  - 렌더러에 Markdown 콘텐츠가 전달되어 렌더링된다
  - Link Parser가 with-links.md 내 로컬 링크를 파싱한다
  - 재귀 트리 빌드: with-links → linked-doc-a, linked-doc-b
  - 사이드바에 트리가 표시된다
  - MCP 응답 반환
```

#### E2E-03: foreground 모드 (T-05)

```
Given: Electron 앱 상주, MCP Bridge 연결
When: open_markdown({content: "# Always on top", foreground: true})를 호출한다
Then:
  - BrowserWindow가 alwaysOnTop: true로 생성된다
  - 다른 앱을 활성화해도 뷰어 창이 최상위에 유지된다
  - list_viewers 결과에 "(always-on-top)" 표시
```

### 3.2 CRITICAL: 다중 창 동시 열기 (T-11)

#### E2E-04: 다중 창 관리

```
Given: Electron 앱 상주, MCP Bridge 연결, 열린 창 0개
When:
  1. open_markdown({content: "# 문서 1"})
  2. open_markdown({content: "# 문서 2"})
  3. open_markdown({content: "# 문서 3"})
Then:
  - 3개 독립 BrowserWindow 모두 열림
  - 각 창의 windowId가 고유 (UUID v4)
  - 캐스케이딩 위치 적용 (각 +30px 오프셋)
  - list_viewers 결과: "열린 뷰어: 3개"
  - close_viewer() 호출 시 3개 모두 닫힘
```

### 3.3 HIGH: 사이드바 트리 + 네비게이션 (T-12, T-17)

#### E2E-05: 사이드바 트리 표시

```
Given: with-links.md 파일에 linked-doc-a.md, linked-doc-b.md 로컬 링크 존재
When: open_markdown({filePath: "<path>/with-links.md"})
Then:
  - 사이드바가 좌측에 표시된다
  - 트리에 3개 항목: with-links, linked-doc-a, linked-doc-b
  - 현재 문서 (with-links) 항목이 하이라이트
```

#### E2E-06: 사이드바 네비게이션

```
Given: E2E-05 상태 (사이드바 트리 표시 중)
When: 사이드바에서 "linked-doc-a" 항목을 클릭한다
Then:
  - 같은 창에서 linked-doc-a.md 내용으로 렌더링 교체
  - 사이드바 트리 구조 유지 (재빌드 없음)
  - "linked-doc-a" 항목으로 하이라이트 이동
  - 히스토리에 기록 (뒤로가기 가능)
```

### 3.4 HIGH: update_markdown 갱신 (T-25)

#### E2E-07: 기존 창 내용 갱신

```
Given: open_markdown({content: "# 원본"})으로 windowId를 받은 상태
When: update_markdown({windowId: <id>, content: "# 갱신됨"})
Then:
  - 기존 창에서 "원본" → "갱신됨"으로 내용 교체
  - 스크롤 위치 상단으로 리셋
  - 새 창이 열리지 않음
  - MCP 응답에 동일 windowId 반환
```

### 3.5 HIGH: close_viewer 전체/개별 (T-08, T-09)

#### E2E-08: 개별 창 닫기

```
Given: 3개 뷰어 창 열림 (windowId: A, B, C)
When: close_viewer({windowId: "B"})
Then:
  - B 창만 닫힘
  - A, C 창 유지
  - list_viewers: "열린 뷰어: 2개"
```

#### E2E-09: 전체 창 닫기

```
Given: 3개 뷰어 창 열림
When: close_viewer({}) (windowId 미지정)
Then:
  - 모든 창 닫힘
  - 앱은 트레이에 상주 유지
  - list_viewers: "열린 뷰어: 0개"
```

### 3.6 MEDIUM: 키보드 단축키 (T-32, T-33, T-34)

#### E2E-10: 키보드 단축키 통합 테스트

```
Given: 뷰어 창 1개 열림 (filePath 모드, 사이드바 있음)
When/Then:
  - Ctrl+F → findInPage 검색 바 표시
  - Ctrl+B → 사이드바 숨김 (토글)
  - Ctrl+B → 사이드바 다시 표시 (토글)
  - 사이드바 항목 클릭 → 문서 전환
  - Ctrl+Left → 이전 문서로 복귀
  - Ctrl+Right → 다시 전환된 문서로 이동
  - Ctrl+W → 현재 창 닫힘
```

### 3.7 MEDIUM: 설정 변경 반영 (T-40, T-62)

#### E2E-11: 설정 변경 전체 플로우

```
Given: 뷰어 창 2개 열림, 기본 테마 light
When:
  1. 트레이 → "설정" 클릭
  2. 테마를 dark로 변경
  3. 저장 클릭
Then:
  - 설정 창에서 electron-store에 저장
  - 열린 뷰어 2개 모두 dark 테마로 즉시 전환
  - 새로 여는 뷰어도 dark 테마 적용
  - 사이드바 너비 변경 후 재오픈 시 저장된 값 복원
```

---

## 4. 컴포넌트 통합 매트릭스

각 컴포넌트 간 연결 지점과 검증할 인터페이스를 정리한다.

| 연결 | 프로토콜 | 검증 포인트 | 관련 시나리오 |
|------|----------|-------------|---------------|
| MCP Client → MCP Bridge | stdio (JSON-RPC 2.0) | 도구 호출/응답, 에러 형식 | E2E-01~03 |
| MCP Bridge → IPC Socket | Named Pipe / Unix Socket (ndjson) | 메시지 프레이밍, 요청 ID 매칭 | E2E-01~09 |
| IPC Socket → Electron Main | net.Server 이벤트 | 연결 수락, 데이터 파싱 | E2E-01~09 |
| Electron Main → WindowManager | 메서드 호출 | createWindow, closeWindow, updateWindow | E2E-01~09 |
| WindowManager → BrowserWindow | Electron API | loadFile, webContents.send | E2E-01~06 |
| BrowserWindow → preload.js | contextBridge | doclight API 노출 | E2E-05~06 |
| preload.js → Renderer | IPC | render-markdown, sidebar-tree | E2E-01~06 |
| Electron Main → Link Parser | 메서드 호출 | buildLinkTree, parseLocalLinks | E2E-02, E2E-05~06 |
| Renderer → preload.js | IPC | window-ready, navigateTo | E2E-01~06 |
| electron-store → WindowManager | 설정 읽기 | sidebarWidth, theme, fontSize | E2E-11 |
| Settings Window → electron-store | 설정 쓰기 | 저장 후 브로드캐스트 | E2E-11 |

---

## 5. 테스트 코드 템플릿

Electron 앱 테스트를 위한 pseudocode 템플릿이다. Electron의 내장 테스트 유틸리티 또는 `@electron/remote`를 활용한다.

### 5.1 E2E 테스트 (MCP → Renderer)

```javascript
// test/integration/e2e-mcp-flow.test.js (pseudocode)
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

// Electron 앱 시작 헬퍼
async function startElectronApp() {
  const electronPath = require('electron');
  const appProcess = spawn(electronPath, [path.join(__dirname, '../../')], {
    env: { ...process.env, DOCLIGHT_TEST: '1' }
  });
  // IPC 소켓 연결 대기
  await waitForSocket();
  return appProcess;
}

// IPC 소켓 클라이언트 (MCP Bridge 역할 시뮬레이션)
function connectIPC() {
  const PIPE_PATH = process.platform === 'win32'
    ? '\\\\.\\pipe\\doclight-ipc'
    : '/tmp/doclight-ipc.sock';
  return new Promise((resolve, reject) => {
    const socket = net.connect(PIPE_PATH, () => resolve(socket));
    socket.on('error', reject);
  });
}

// ndjson 요청 전송 + 응답 대기
function sendRequest(socket, action, params) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const request = JSON.stringify({ id, action, params }) + '\n';
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            socket.removeListener('data', onData);
            resolve(msg);
          }
        } catch (e) { /* 부분 메시지, 계속 버퍼링 */ }
      }
      buffer = lines[lines.length - 1]; // 불완전 라인 유지
    };
    socket.on('data', onData);
    socket.write(request);
    setTimeout(() => reject(new Error('Timeout')), 15000);
  });
}

describe('E2E: MCP → Electron 전체 플로우', () => {
  let appProcess, socket;

  beforeAll(async () => {
    appProcess = await startElectronApp();
    socket = await connectIPC();
  });

  afterAll(async () => {
    socket.destroy();
    appProcess.kill();
  });

  test('E2E-01: content 모드로 창 열기', async () => {
    const res = await sendRequest(socket, 'open_markdown', {
      content: '# 통합 테스트\n\n본문입니다.'
    });
    expect(res.result).toBeDefined();
    expect(res.result.windowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.result.title).toBe('통합 테스트');
  });

  test('E2E-04: 다중 창 동시 열기', async () => {
    const res1 = await sendRequest(socket, 'open_markdown', { content: '# 문서 1' });
    const res2 = await sendRequest(socket, 'open_markdown', { content: '# 문서 2' });
    const res3 = await sendRequest(socket, 'open_markdown', { content: '# 문서 3' });

    expect(res1.result.windowId).not.toBe(res2.result.windowId);
    expect(res2.result.windowId).not.toBe(res3.result.windowId);

    const listRes = await sendRequest(socket, 'list_viewers', {});
    expect(listRes.result.count).toBeGreaterThanOrEqual(3);
  });

  test('E2E-07: update_markdown 갱신', async () => {
    const openRes = await sendRequest(socket, 'open_markdown', { content: '# 원본' });
    const wId = openRes.result.windowId;

    const updateRes = await sendRequest(socket, 'update_markdown', {
      windowId: wId,
      content: '# 갱신됨'
    });
    expect(updateRes.result).toBeDefined();
    expect(updateRes.error).toBeUndefined();
  });

  test('E2E-08: 개별 창 닫기', async () => {
    const r1 = await sendRequest(socket, 'open_markdown', { content: '# A' });
    const r2 = await sendRequest(socket, 'open_markdown', { content: '# B' });

    await sendRequest(socket, 'close_viewer', { windowId: r1.result.windowId });

    const listRes = await sendRequest(socket, 'list_viewers', {});
    const ids = listRes.result.viewers?.map(v => v.windowId) || [];
    expect(ids).not.toContain(r1.result.windowId);
    expect(ids).toContain(r2.result.windowId);
  });

  test('E2E-09: 전체 창 닫기', async () => {
    await sendRequest(socket, 'open_markdown', { content: '# X' });
    await sendRequest(socket, 'open_markdown', { content: '# Y' });

    await sendRequest(socket, 'close_viewer', {});

    const listRes = await sendRequest(socket, 'list_viewers', {});
    expect(listRes.result.count || 0).toBe(0);
  });
});
```

### 5.2 Link Parser 통합 테스트

```javascript
// test/integration/link-parser.test.js (pseudocode)
const { buildLinkTree } = require('../../src/main/link-parser');
const path = require('path');

describe('Link Parser 통합 테스트', () => {
  const fixtures = path.join(__dirname, '../test-fixtures');

  test('E2E-05: 재귀 트리 빌드', async () => {
    const tree = await buildLinkTree(path.join(fixtures, 'with-links.md'));
    expect(tree).not.toBeNull();
    expect(tree.children.length).toBeGreaterThan(0);
    expect(tree.children.every(c => c.path && c.title)).toBe(true);
  });

  test('순환 참조 무한 루프 방지', async () => {
    const tree = await buildLinkTree(path.join(fixtures, 'circular-a.md'));
    expect(tree).not.toBeNull();
    // 순환이 감지되면 트리가 유한해야 함
    const totalNodes = countNodes(tree);
    expect(totalNodes).toBeLessThan(50);
  });

  test('코드 블록 내 링크 제외', async () => {
    const tree = await buildLinkTree(path.join(fixtures, 'code-block-links.md'));
    const allPaths = collectPaths(tree);
    // 코드 블록 내 링크가 트리에 포함되지 않아야 함
    expect(allPaths).not.toContain(expect.stringContaining('should-not-appear'));
  });
});

function countNodes(node) {
  if (!node) return 0;
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

function collectPaths(node, paths = []) {
  if (!node) return paths;
  paths.push(node.path);
  node.children.forEach(c => collectPaths(c, paths));
  return paths;
}
```

---

## 6. 요구사항 추적 매트릭스 (SRS T-xx → 테스트 시나리오)

| SRS 테스트 ID | 설명 | 우선순위 | 통합 테스트 시나리오 | Phase 검증 |
|---------------|------|----------|---------------------|------------|
| T-01 | 트레이 아이콘 표시 | CRITICAL | (Phase 2 검증) | Phase 2 #1-4 |
| T-02 | 중복 실행 방지 | CRITICAL | (Phase 2 검증) | Phase 2 #5-8 |
| T-03 | open_markdown (content) | CRITICAL | **E2E-01** | Phase 3 #18-21 |
| T-04 | open_markdown (filePath) | CRITICAL | **E2E-02** | Phase 3 #22-24 |
| T-05 | open_markdown (foreground) | CRITICAL | **E2E-03** | Phase 3 #25-26 |
| T-06 | open_markdown (잘못된 경로) | HIGH | (Phase 3 검증) | Phase 3 #28 |
| T-07 | open_markdown (파라미터 없음) | HIGH | (Phase 3 검증) | Phase 3 #27 |
| T-08 | close_viewer (특정 ID) | HIGH | **E2E-08** | Phase 3 #37 |
| T-09 | close_viewer (전체) | HIGH | **E2E-09** | Phase 3 #38 |
| T-10 | list_viewers | HIGH | **E2E-04** (내부) | Phase 3 #41-43 |
| T-11 | 다중 창 동시 열기 | CRITICAL | **E2E-04** | Phase 3 #29 |
| T-12 | 사이드바 — 링크 있는 문서 | HIGH | **E2E-05** | Phase 5 #34 |
| T-13 | 사이드바 — 링크 없는 문서 | HIGH | (Phase 5 검증) | Phase 5 #35 |
| T-14 | 사이드바 — content 모드 | MEDIUM | (Phase 5 검증) | Phase 5 #36 |
| T-15 | 사이드바 — 순환 참조 | HIGH | Link Parser 통합 | Phase 5 #30-33 |
| T-16 | 사이드바 — 존재하지 않는 파일 | MEDIUM | (Phase 5 검증) | Phase 5 #42-44 |
| T-17 | 사이드바 — 트리 항목 클릭 | HIGH | **E2E-06** | Phase 5 #38-41 |
| T-18 | 코드 블록 하이라이팅 | MEDIUM | (Phase 4 검증) | Phase 4 #10, 29-33 |
| T-19 | Mermaid 다이어그램 | MEDIUM | (Phase 4 검증) | Phase 4 #25-28 |
| T-20 | DOMPurify XSS 제거 | HIGH | (Phase 4 검증) | Phase 4 #19-24 |
| T-21 | 트레이 → 모든 창 닫기 | MEDIUM | (Phase 2 검증) | Phase 2 #17 |
| T-22 | 트레이 → 종료 | MEDIUM | (Phase 2 검증) | Phase 2 #41 |
| T-23 | 외부 링크 → 브라우저 | MEDIUM | (Phase 4 검증) | Phase 4 #34-36 |
| T-24 | 대형 문서 (1MB) | MEDIUM | (Phase 4 검증) | Phase 4 #51-52 |
| T-25 | update_markdown | HIGH | **E2E-07** | Phase 3 #32-33 |
| T-26 | update_markdown (잘못된 ID) | MEDIUM | (Phase 3 검증) | Phase 3 #34 |
| T-27 | list_viewers (창 없음) | LOW | (Phase 3 검증) | Phase 3 #43 |
| T-28 | content+filePath 동시 | MEDIUM | (Phase 3 검증) | Phase 3 #35 |
| T-29 | 코드 블록 내 링크 | MEDIUM | Link Parser 통합 | Phase 5 #19-21 |
| T-30 | 앵커/쿼리 파라미터 링크 | LOW | (Phase 5 검증) | Phase 5 #2-3 |
| T-31 | URL 인코딩 경로 | LOW | (Phase 5 검증) | Phase 5 #9 |
| T-32 | Ctrl+F 검색 | MEDIUM | **E2E-10** | Phase 4 #38 |
| T-33 | Ctrl+W 닫기 | MEDIUM | **E2E-10** | Phase 4 #39 |
| T-34 | Ctrl+Left/Right 히스토리 | MEDIUM | **E2E-10** | Phase 4 #44-45 |
| T-35 | IPC 소켓 통신 | CRITICAL | E2E-01~09 전체 | Phase 2 #9-14, Phase 3 #13-17 |
| T-36 | Electron 미실행 시 자동 실행 | HIGH | (Phase 3 검증) | Phase 3 #45 |
| T-37 | URL 화이트리스트 | HIGH | (Phase 4 검증) | Phase 4 #36 |
| T-38 | 창 20개 초과 | MEDIUM | (Phase 3 검증) | Phase 3 #31 |
| T-39 | content 10MB 초과 | MEDIUM | (Phase 3 검증) | Phase 3 #30 |
| T-40 | 사이드바 너비 복원 | MEDIUM | **E2E-11** | Phase 5 #50-52 |
| T-41 | scrollIntoView | LOW | (Phase 5 검증) | Phase 5 #41 |
| T-42 | Wiki 링크 파싱 | MEDIUM | (Phase 5 검증) | Phase 5 #11-12 |
| T-43 | 캐스케이딩 위치 | LOW | E2E-04 (확인) | Phase 2 #28 |
| T-44 | update content+filePath 동시 | MEDIUM | (Phase 3 검증) | Phase 3 #35 |
| T-45 | 사이드바 리사이즈 경계 | LOW | (Phase 5 검증) | Phase 5 #53-54 |
| T-46 | 비-.md filePath | MEDIUM | (Phase 3 검증) | Phase 3 #29 |
| T-47 | 읽기 권한 없는 파일 | MEDIUM | (Phase 3 검증) | Phase 3 #28 |
| T-48 | 소켓 재연결 | HIGH | (Phase 3 검증) | Phase 3 #48 |
| T-49 | Esc always-on-top 해제 | LOW | (Phase 4 검증) | Phase 4 #46 |
| T-50 | Ctrl+B 사이드바 토글 | MEDIUM | **E2E-10** | Phase 4 #43 |
| T-51 | Ctrl+±/0 줌 | LOW | (Phase 4 검증) | Phase 4 #40-42 |
| T-52 | 참조 링크 파싱 | LOW | (Phase 5 검증) | Phase 5 #10 |
| T-53 | 심볼릭 링크 무시 | LOW | (Phase 5 검증) | Phase 5 #56 |
| T-54 | 트레이 창 포커스 | LOW | (Phase 2 검증) | Phase 2 #16 |
| T-55 | 설정 마이그레이션 | MEDIUM | (Phase 6 검증) | Phase 6 #20 |
| T-56 | 히스토리 forward 제거 | LOW | (Phase 5 검증) | Phase 5 #47 |
| T-57 | 대형 트리 200+ 파일 | MEDIUM | (Phase 5 검증) | Phase 5 #24 |
| T-58 | content 10MB 경계값 | LOW | (Phase 4 검증) | Phase 4 #54 |
| T-59 | ndjson 프레이밍 | HIGH | E2E-01~09 전체 | Phase 2 #13 |
| T-60 | 10초 타임아웃 | HIGH | (Phase 3 검증) | Phase 3 #44 |
| T-61 | Stale 소켓 정리 | MEDIUM | (Phase 2 검증) | Phase 2 #12 |
| T-62 | 설정 UI 열기/변경/저장 | MEDIUM | **E2E-11** | Phase 6 #1-10 |

**커버리지 요약:**
- E2E 시나리오에서 직접 검증: 17개 (T-03~05, T-08~12, T-17, T-25, T-32~34, T-40, T-50, T-62)
- Phase 검증에서 커버: 45개 (나머지 모두)
- 전체 62개 테스트 항목 100% 추적 완료

---

## 7. 실행 방법

```bash
# 1. 테스트 환경 준비
npm install

# 2. 테스트 데이터 확인
ls test/test-fixtures/

# 3. 통합 테스트 실행
npm run test:integration

# 4. 결과 확인
# 테스트 결과는 콘솔 + test-results/ 디렉토리에 저장
```
