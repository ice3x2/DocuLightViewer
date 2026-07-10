# CLI 기반 MCP 병용 및 빌드 산출물 동작 연구

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-07-08 |
| 대상 | DocuLightViewer MCP transport, build, package smoke |
| 요청 | CLI 기반 MCP 기능을 기존 HTTP 기반 MCP와 병용하고, 빌드된 앱에서도 동작하게 하는 방안 연구 |
| 조사 방식 | 5개 서브에이전트 조사 + 로컬 SRS/코드 확인 + 공식 MCP/Electron/electron-builder/npm 문서 확인 |
| 결론 | 기존 stdio MCP는 CLI 기반 MCP의 핵심 토대가 맞지만, 설치형 빌드 산출물에서 직접 실행할 packaged CLI entrypoint 요구사항은 아직 SRS에 명시되어 있지 않다. 구현 전 SRS 추가가 필요하다. |

## 1. 요구사항 이해

사용자가 말한 "CLI 기반 MCP"는 DocuLight가 이미 제공하는 HTTP MCP와 별도로, MCP 클라이언트가 로컬 프로세스를 실행해 `stdin/stdout`으로 통신하는 MCP stdio transport를 설치형 앱에서도 안정적으로 사용할 수 있게 하려는 요구로 해석한다.

따라서 핵심 목표는 다음과 같다.

- 기존 HTTP MCP 서버는 유지한다.
- CLI 기반 MCP는 기존 8개 MCP 도구 계약과 동일해야 한다.
- 빌드된 설치형 또는 unpacked 앱에서도 MCP 클라이언트가 실행할 수 있는 entrypoint가 있어야 한다.
- CLI MCP는 검색/저장 도메인 로직을 직접 복제하지 않고 기존 Electron main process의 IPC, 저장, 검색, 창 관리 경계를 재사용해야 한다.
- 새 MCP 도구, alias 도구, 인덱싱 제어 도구를 추가하지 않는다.

이 연구는 구현 문서가 아니라 구현 전 설계 조사다. 실제 코드 변경 전에는 SRS에 packaged CLI entrypoint 요구사항을 추가해야 한다.

## 2. 5개 서브에이전트 조사 요약

| 역할 | 조사 초점 | 핵심 결론 |
| --- | --- | --- |
| SRS 매핑 | 관련 요구사항과 금지 경계 | `IR-MCP-018`, `CON-MCP-007`, `CON-MCP-010`, `OPS-ARCH-009`, `OPS-ARCH-010`, `IR-APP-010`이 핵심이다. 새 tool, alias, indexing control은 기존 SRS와 충돌한다. |
| 코드 구조 | stdio/HTTP MCP와 IPC 구조 | 현재 `src/main/mcp-server.mjs`는 stdio MCP bridge이고, `src/main/mcp-http.mjs`는 Electron main 내부 HTTP MCP다. 둘 다 main process 도메인 로직을 재사용해야 한다. |
| 패키징 | electron-builder, bundle, package smoke | `mcp-server.bundle.mjs`는 `asarUnpack`에 포함되지만 설치형 앱용 CLI wrapper나 실행 파일 subcommand는 없다. package smoke도 설치본 CLI MCP 프로세스 직접 실행은 아직 검증하지 않는다. |
| 외부 표준 | MCP transport와 Electron packaging | MCP 표준 transport는 stdio와 Streamable HTTP다. stdio stdout에는 MCP JSON-RPC만 출력해야 한다. npm `bin`은 npm 설치 shim이지 Electron installer의 CLI 등록이 아니다. |
| 종합 리뷰 | 권장안과 blocker | 연구 문서 작성은 가능하다. 구현은 packaged executable CLI stdio entrypoint SRS가 없으므로 blocker가 있다. 권장안은 설치된 `DocuLight` 실행 파일의 `--mcp-stdio` 모드다. |

## 3. SRS 추적성

현재 active target은 `0.11.0-w2`다. 관련 요구사항은 다음과 같다.

| Requirement ID | 상태 | 관련성 |
| --- | --- | --- |
| `IR-MCP-018` | verified / stable | stdio와 HTTP MCP가 `save_document`, `smart_search`를 포함한 정확한 8개 도구를 제공해야 한다. indexing control side effect와 alias 도구를 금지한다. |
| `CON-MCP-007` | verified / stable | source stdio, HTTP, generated `mcp-server.bundle.mjs`가 동일한 8-tool schema, 설명, redaction, forbidden field 정책을 유지해야 한다. |
| `CON-MCP-010` | verified / stable | MCP client-profile conformance를 통해 도구 선택, strict schema, bounded output, no indexing/import/reconciliation control을 검증한다. |
| `OPS-ARCH-002` | implemented / stable | 빌드 전 `bundle:mcp`로 `mcp-server.bundle.mjs`를 생성하고 package에서 unpack해야 한다. |
| `OPS-ARCH-004` | verified / stable | packaged MCP bundle parity를 원본 stdio 및 HTTP MCP와 비교해야 한다. |
| `OPS-ARCH-009` | verified / stable | package smoke가 packaged app, native load, HTTP/source/bundle 8-tool 계약, save/search, redaction을 검증해야 한다. |
| `OPS-ARCH-010` | verified / stable | native module은 main process service 경계에서 lazy load하고 stdio MCP bundle이 직접 import하지 않아야 한다. |
| `IR-APP-010` | verified / stable | indexing status, rebuild, cancel, retry, clear 같은 제어면은 Settings IPC/UI 전용이며 MCP 도구로 노출하지 않는다. |
| `OPS-ARCH-012` | implemented / evolving | dev/default profile은 userData, IPC, MCP port discovery, index path를 분리하며 stdio MCP는 명시된 profile 또는 IPC endpoint를 선택할 수 있어야 한다. |

### SRS gap

기존 SRS는 source stdio MCP, HTTP MCP, generated bundle parity까지 다루지만, 설치형 앱에서 MCP 클라이언트가 직접 실행할 수 있는 "packaged executable CLI stdio entrypoint"를 명시하지 않는다.

따라서 구현 전 새 요구사항 또는 기존 ARCH/MCP 요구사항 확장이 필요하다.

필수 acceptance criteria 후보는 다음과 같다.

- 설치된 `DocuLight` 실행 파일 또는 공식 설치본 CLI entrypoint가 stdio MCP server mode를 제공한다.
- 외부 Node 설치 없이 동작하는 경로를 우선한다.
- stdout에는 MCP JSON-RPC 메시지만 출력하고 로그는 stderr만 사용한다.
- `tools/list`는 기존 8-tool set과 정확히 동일하며 alias, import, indexing, reconciliation control 도구를 추가하지 않는다.
- HTTP MCP와 동시에 사용해도 동일 앱 인스턴스의 동일 저장/검색 상태를 본다.
- default/dev/explicit IPC profile 선택 규칙을 보존한다.
- auto-launch 시 CLI flag 또는 `ELECTRON_RUN_AS_NODE` 같은 환경이 일반 앱 자식 프로세스에 잘못 전파되지 않는다.
- package smoke가 설치본 CLI 프로세스를 실제 MCP client로 실행해 `initialize`, `tools/list`, 대표 `tools/call`을 검증한다.

## 4. 현재 코드 구조

### 4.1 stdio MCP

현재 `package.json`은 npm bin으로 `doculight-mcp -> src/main/mcp-server.mjs`를 선언한다.

`src/main/mcp-server.mjs`는 다음 구조다.

- `@modelcontextprotocol/sdk`의 `McpServer`와 `StdioServerTransport`를 사용한다.
- `resolveMcpIpcPath()`로 default/dev/explicit IPC endpoint를 결정한다.
- tool call은 직접 검색 DB나 WindowManager를 만지지 않고 main process IPC로 위임한다.
- stdout은 MCP transport가 사용하고, 자체 로그는 `console.error('[doculight-mcp]', ...)` 형태로 stderr에 출력한다.

이 구조는 CLI MCP로 적합하다. 다만 npm `bin`은 npm package 설치용이며, Electron installer가 OS PATH에 `doculight-mcp`를 등록한다는 보장은 아니다.

### 4.2 HTTP MCP

`src/main/index.js`는 앱 시작 중 `src/main/mcp-http.mjs`를 동적 import하고 `startMcpHttpServer(windowManager, store, app.getPath('userData'), searchEngine)`를 호출한다.

`src/main/mcp-http.mjs`는 다음을 담당한다.

- `TOOLS` 배열로 HTTP `tools/list` schema를 제공한다.
- `createToolHandlers(windowManager, store, searchEngine)`로 tool handler를 만든다.
- `POST /mcp`, `GET /mcp`, `OPTIONS`, OAuth discovery probe, Origin 차단, loopback binding, `mcp-port` discovery file을 처리한다.

HTTP MCP는 Electron main process 내부에서 동작하므로 WindowManager, Store, SearchEngine 객체를 직접 주입받는다.

### 4.3 main IPC

`src/main/index.js`의 IPC server는 stdio MCP bridge가 연결하는 내부 제어면이다. 주요 action은 다음과 같다.

- `open_markdown`
- `update_markdown`
- `close_viewer`
- `list_viewers`
- `save_document`
- `search_documents`
- `search_projects`
- `smart_search`

이 경로는 stdio MCP와 HTTP MCP의 실제 동작을 맞추는 핵심 경계다.

### 4.4 runtime profile

`src/main/runtime-profile.js`는 default/dev profile을 분리한다.

- default IPC: Windows `\\.\pipe\doculight-ipc`, POSIX `/tmp/doculight-ipc.sock`
- dev IPC: Windows `\\.\pipe\doculight-ipc-dev`, POSIX `/tmp/doculight-ipc-dev.sock`
- default MCP HTTP port: `32580`
- dev MCP HTTP port: `32581`
- `DOCULIGHT_MCP_IPC_PATH`는 명시적 MCP IPC override다.
- `DOCULIGHT_MCP_PROFILE`, `DOCULIGHT_PROFILE`, `DOCULIGHT_RUNTIME_PROFILE`은 profile 기반 endpoint 선택에 사용된다.

CLI MCP 구현은 이 profile resolver를 그대로 재사용해야 한다.

## 5. 현재 빌드와 package smoke

`package.json`의 `bundle:mcp`는 다음 성격을 가진다.

- `src/main/mcp-server.mjs`를 `src/main/mcp-server.bundle.mjs`로 번들한다.
- `--platform=node`, `--target=node20`, `--format=esm`를 사용한다.
- `better-sqlite3`, `hnswlib-node`는 external 처리한다.

`electron-builder.yml`은 다음을 포함한다.

- `files`: `src/**/*`, `assets/**/*`, `package.json`
- `asarUnpack`: `src/main/mcp-server.bundle.mjs`, `node_modules/better-sqlite3/**`, `node_modules/hnswlib-node/**`
- `extraResources`: icon만 포함

현재 package smoke는 다음을 이미 검증한다.

- packaged app start
- native `.node` unpack
- generated bundle의 native import 부재
- HTTP/source/bundle 8-tool schema
- `save_document -> search_documents/smart_search`
- redaction fixture
- worker native runtime

그러나 아직 다음은 직접 검증하지 않는다.

- 설치본 CLI entrypoint 파일 존재
- 설치본 CLI MCP 프로세스를 실제 spawn
- 설치본 CLI MCP와 HTTP MCP의 동시 사용
- 설치본 CLI MCP stdout purity
- packaged bundle self-contained 실행 가능성

특히 `mcp-server.bundle.mjs`가 `createRequire(import.meta.url)`로 `./runtime-profile.js`를 상대 require하는 구조는 실제 packaged bundle 단독 실행 smoke가 필요하다. 단순히 source와 bundle 문자열을 비교하는 것만으로는 실행 시 누락 파일 문제를 잡기 어렵다.

## 6. 외부 표준 조사

공식 MCP transport 사양은 표준 transport로 stdio와 Streamable HTTP를 정의한다.

- stdio: 클라이언트가 MCP server subprocess를 실행하고 `stdin/stdout`으로 newline-delimited JSON-RPC를 주고받는다. 서버는 stdout에 유효한 MCP 메시지 외의 내용을 쓰면 안 되며, 로그는 stderr로 출력해야 한다.
- Streamable HTTP: 단일 `/mcp` endpoint에서 POST/GET을 사용한다. 로컬 서버는 Origin 검증과 loopback bind가 중요하다.
- lifecycle: `initialize`, `notifications/initialized`, operation, shutdown 순서를 따른다.
- tools: `tools/list`로 schema를 제공하고 `tools/call`로 `{ name, arguments }`를 호출한다.

Electron/electron-builder/npm 기준은 다음과 같다.

- npm `bin`은 npm install 시 PATH shim을 만드는 기능이다. Electron installer의 OS-level CLI 등록과는 별개다.
- Electron ASAR 내부 파일은 직접 실행 대상에 제약이 있으므로 실행해야 하는 파일이나 native module은 `asarUnpack`, `extraResources`, `extraFiles` 같은 ASAR 밖 위치가 필요하다.
- electron-builder의 `extraResources`는 `resources/` 아래에 runtime asset이나 CLI 도구를 둘 때 사용할 수 있다.

참고 공식 문서:

- MCP Transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP Lifecycle: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- MCP Tools: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- electron-builder Application Contents: https://www.electron.build/docs/contents/
- electron-builder Configuration: https://www.electron.build/docs/configuration/
- Electron ASAR Archives: https://www.electronjs.org/docs/latest/tutorial/asar-archives
- npm package.json `bin`: https://docs.npmjs.com/cli/v7/configuring-npm/package-json/#bin

## 7. 구현 후보 비교

| 후보 | 설명 | 장점 | 단점 | 판단 |
| --- | --- | --- | --- | --- |
| A. 현행 npm bin/source 실행 | `node src/main/mcp-server.mjs` 또는 `doculight-mcp` npm shim 사용 | 개발/소스 트리에서는 이미 동작한다. | 설치형 Electron 앱의 CLI entrypoint가 아니다. 사용자가 Node와 소스 경로를 알아야 한다. | "빌드했을 때 동작" 요구를 만족하지 못한다. |
| B. 설치본 wrapper가 unpacked bundle 실행 | `doculight-mcp.cmd` 또는 shell wrapper가 `resources/app.asar.unpacked/src/main/mcp-server.bundle.mjs`를 실행 | 현재 bundle 구조를 활용할 수 있다. GUI 앱과 stdio bridge를 분리하기 쉽다. | 외부 Node 20+ 필요 또는 `ELECTRON_RUN_AS_NODE` 사용 필요. wrapper/PATH/installer 정책이 추가된다. auto-launch 환경 오염 위험이 있다. | 보류안. Node 의존을 허용할 때만 단순하다. |
| C. `DocuLight --mcp-stdio` 실행 파일 모드 | 설치된 `DocuLight` 실행 파일이 가장 이른 진입점에서 stdio MCP bridge mode로 전환 | 외부 Node 없이 설치본만으로 MCP client 설정 가능. 공식 설치 경로 하나만 안내하면 된다. | Electron process stdout purity, GUI 초기화 우회, auto-launch recursion 방지 테스트가 필요하다. | 권장안. 단, 새 SRS와 package smoke가 선행되어야 한다. |

권장안은 C다. 이유는 사용자가 "빌드했을 때 동작"한다고 기대하는 설치형 앱 UX와 가장 잘 맞고, 외부 Node 설치를 요구하지 않으며, 기존 HTTP MCP와 같은 앱 인스턴스에 붙는 stdio bridge로 설계할 수 있기 때문이다.

단, 구현 중 Electron executable의 stdout purity를 MCP client로 검증했을 때 실패하면 B를 fallback으로 남겨야 한다.

## 8. 권장 아키텍처

권장 흐름은 다음과 같다.

```text
MCP client (stdio)
  -> DocuLight executable --mcp-stdio
  -> stdio MCP bridge
  -> runtime profile resolver
  -> main process IPC socket
  -> shared MCP/runtime handlers
  -> WindowManager / Store / SearchEngine

MCP client (HTTP)
  -> http://127.0.0.1:<mcp-port>/mcp
  -> mcp-http.mjs
  -> same WindowManager / Store / SearchEngine boundary
```

설계 원칙은 다음과 같다.

- CLI MCP는 transport adapter다. 저장, 검색, 창 관리, 인덱싱 도메인 로직을 직접 구현하지 않는다.
- tool surface는 정확히 8개로 유지한다.
- `save_document`, `smart_search` schema와 response envelope는 `IR-MCP-018`, `CON-MCP-007`, `CON-MCP-010`을 따른다.
- CLI stdio process는 native module을 직접 load하지 않는다. `better-sqlite3`, `hnswlib-node`, worker runtime은 main process/service 계층에 남긴다.
- stdout에는 MCP protocol message만 출력한다.
- 로그, diagnostics, auto-launch 안내는 stderr 또는 MCP error envelope로만 보낸다.
- default/dev/explicit IPC selection은 `runtime-profile.js`와 동일한 규칙을 쓴다.
- HTTP MCP는 계속 앱 내부 server로 유지하고, CLI MCP는 같은 앱 인스턴스에 IPC로 붙는다.

향후 구현에서 중복을 줄이려면 HTTP `createToolHandlers()`, stdio SDK tool 등록, main IPC action 처리의 schema/description/handler 경계를 공통 tool catalog 또는 runtime handler module로 정리하는 것이 좋다. 다만 이 리팩터링은 packaged CLI entrypoint 자체보다 넓은 변경이므로 별도 phase로 분리해야 한다.

## 9. 구현 전 SRS 조치

구현 착수 전 다음 SRS 작업이 필요하다.

1. `docs/spec/10.product-architecture.srs.md` 또는 `docs/spec/50.mcp-integration.srs.md`에 packaged CLI stdio entrypoint 요구사항을 추가한다.
2. 요구사항은 Stability가 `stable` 또는 최소한 구현 가능한 상태여야 한다.
3. 기존 `IR-MCP-018`, `CON-MCP-007`, `CON-MCP-010`, `OPS-ARCH-009`, `OPS-ARCH-010`, `IR-APP-010`과의 trace link를 명시한다.
4. 새 요구사항은 no new MCP tools, no aliases, no indexing controls 정책을 재확인해야 한다.
5. package smoke가 설치본 CLI MCP 프로세스를 실제 실행하도록 acceptance criteria를 둔다.

새 SRS 없이 바로 구현하면 다음 지점에서 SRS 위반 가능성이 있다.

- `package.json bin`을 Electron installer CLI로 오해하고 검증 없이 배포
- wrapper/PATH/installer artifact를 추가하면서 package smoke 범위를 벗어남
- `--mcp-stdio` mode가 stdout purity를 보장하지 못함
- CLI stdio에 `status`, `rebuild`, `cancel` 같은 인덱싱 제어 도구를 추가함
- generated bundle 또는 executable mode가 HTTP/source stdio schema와 drift됨

## 10. 검증 계획

SRS 추가 후 구현은 TDD로 진행해야 한다.

### 10.1 정적 계약 테스트

- `package.json`, `electron-builder.yml`, 새 launcher 또는 executable mode 설정을 검사한다.
- `tools/list`가 source stdio, HTTP, packaged executable mode에서 동일한 8-tool set인지 확인한다.
- forbidden tool name과 forbidden field가 계속 없는지 검사한다.
- `mcp-server.bundle.mjs` 또는 executable mode가 native dependency를 직접 import하지 않는지 검사한다.

### 10.2 stdio runtime 테스트

- MCP SDK `StdioClientTransport`로 source stdio MCP를 실행한다.
- 같은 방식으로 generated bundle을 실행한다.
- 새 packaged executable mode가 생기면 `DocuLight --mcp-stdio`도 같은 fixture로 실행한다.
- `initialize`, `notifications/initialized`, `tools/list`, 대표 `tools/call`을 수행한다.

대표 tool call은 최소 다음을 포함한다.

- `save_document`: marker 저장, canonical JSON envelope 확인
- `smart_search`: read-only, bounded response, degraded envelope 확인
- invalid `save_document`: unknown field, forbidden field, raw path redaction 확인
- invalid `smart_search`: unsafe `pathPrefix`, invalid `mode` redaction 확인

### 10.3 package smoke

패키지 산출물 smoke는 다음을 추가해야 한다.

- `dist/win-unpacked/DocuLight.exe --mcp-stdio` 또는 해당 플랫폼 equivalent를 실제 spawn한다.
- stdout에는 MCP JSON-RPC 외 출력이 없는지 캡처한다.
- stderr 로그가 MCP protocol을 깨지 않는지 확인한다.
- packaged app HTTP MCP와 CLI stdio MCP를 동시에 사용해 `tools/list` parity를 비교한다.
- 한 transport로 저장한 unique marker가 다른 transport의 `search_documents` 또는 `smart_search`로 검색되는지 확인한다.
- dev/default profile 선택과 explicit `DOCULIGHT_MCP_IPC_PATH` override를 검증한다.
- 앱 미실행 상태에서 CLI MCP가 의도한 앱 인스턴스를 auto-launch하는 경우, CLI mode flag/env가 일반 앱 자식 프로세스에 전파되지 않는지 확인한다.

### 10.4 회귀 테스트

- `node test/test-wave2-mcp-contract.js`
- `node test/test-mcp-tool-parity.js`
- `node test/test-mcp-http-save-parity.js`
- `node test/test-wave2-package-contract.js`
- `npm run bundle:mcp`
- `npm run build:win`
- `npm run smoke:package`

전체 빌드 스모크는 변경 리스크가 높으므로 구현 후 Tier 2 또는 Tier 3에 준해 실행해야 한다.

## 11. 주요 위험과 완화책

| 위험 | 설명 | 완화책 |
| --- | --- | --- |
| stdout 오염 | MCP stdio server stdout에 로그가 섞이면 클라이언트가 JSON-RPC를 파싱하지 못한다. | 모든 로그는 stderr로 보내고 package smoke가 stdout purity를 캡처한다. |
| 외부 Node 의존 | unpacked bundle wrapper 방식은 사용자 PC의 Node 20+에 의존할 수 있다. | 권장안 C로 외부 Node 비의존 executable mode를 우선한다. |
| `ELECTRON_RUN_AS_NODE` 오염 | wrapper나 native repair 패턴을 잘못 쓰면 auto-launched 앱도 Node mode로 실행될 수 있다. | CLI mode와 일반 앱 auto-launch env를 분리하고 테스트한다. |
| bundle self-contained 문제 | generated bundle이 상대 require를 남기면 packaged bundle 단독 실행이 실패할 수 있다. | package smoke가 실제 packaged CLI process를 spawn한다. 필요하면 관련 runtime file도 unpack하거나 bundle을 self-contained로 만든다. |
| profile 혼선 | dev와 packaged 앱이 동시에 실행될 때 CLI MCP가 잘못된 IPC에 붙을 수 있다. | `DOCULIGHT_MCP_PROFILE`, `DOCULIGHT_MCP_IPC_PATH` 우선순위를 유지하고 smoke로 검증한다. |
| native ABI 문제 | CLI MCP가 native module을 직접 load하면 Electron/Node ABI mismatch가 재발한다. | CLI는 IPC bridge로 유지하고 native load는 main process/service 계층에 둔다. |
| SRS 위반 tool 추가 | CLI 요구를 핑계로 indexing status/rebuild/cancel tool을 추가할 수 있다. | `IR-APP-010`, `IR-MCP-018`, `CON-MCP-007`, `CON-MCP-010`에 따라 no indexing controls를 고정한다. |
| HTTP session 혼선 | HTTP MCP는 session header를 일부 다루므로 stdio와 병용할 때 상태 모델을 오해할 수 있다. | stdio는 별도 local subprocess transport로 유지하고, shared state는 app IPC/Store/SearchEngine에서만 공유한다. |

## 12. 최종 권고

구현 권장 순서는 다음과 같다.

1. SRS에 packaged CLI stdio entrypoint 요구사항을 추가한다.
2. 설치본 CLI UX를 `DocuLight --mcp-stdio` 우선으로 확정한다.
3. failing package smoke부터 작성한다.
4. 가장 이른 main entrypoint에서 CLI mode를 분기해 GUI 초기화를 우회한다.
5. 기존 stdio MCP bridge 코드를 executable mode에서 재사용한다.
6. HTTP MCP와 stdio CLI가 동일 8-tool 계약을 유지하는 conformance를 강화한다.
7. `npm run build:win && npm run smoke:package`로 설치본 동작을 검증한다.

현재 시점의 결론은 다음 한 문장으로 정리된다.

> DocuLightViewer는 이미 CLI MCP의 기반인 stdio MCP와 HTTP MCP를 모두 갖고 있지만, "빌드된 설치본에서 MCP 클라이언트가 직접 실행할 공식 CLI entrypoint"는 아직 요구사항과 smoke가 부족하므로, 구현 전 SRS를 추가하고 package smoke로 실제 실행을 검증해야 한다.
