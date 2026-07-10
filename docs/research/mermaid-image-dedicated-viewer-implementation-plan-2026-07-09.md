# Mermaid and Image Dedicated Viewer Implementation Plan

Date: 2026-07-09
Target repository: DocuLightViewer
Document type: implementation planning research
Language: Korean

## 1. 목적

이 문서는 `docs/research/mermaid-image-dedicated-viewer-requirements-2026-07-09.md`를 바탕으로 Mermaid 그래프 전용 확대 창과 이미지 전용 확대 창을 구현하기 위한 실행 계획을 정리한다. 세 개의 독립 서브에이전트가 main/window/security, renderer/UI, TDD/e2e 관점으로 조사한 결과를 취합했으며, 서로 일치하고 현재 코드와 맞는 판단만 반영한다.

이 문서는 `docs/spec`를 대체하지 않는다. 구현은 SpecKiwi로 발급된 `FR-RENDER-028`, `IR-APP-012`, `SEC-ARCH-005`를 기준으로 진행한다.

## 2. 관련 기존 요구사항

기존 요구사항은 기반 기능만 제공하며, 전용 미디어 뷰어 자체를 직접 커버하지 않는다.

- `FR-RENDER-003`: 로컬 이미지 data URI 변환.
- `FR-RENDER-004`: Mermaid strict SVG 렌더링.
- `FR-RENDER-008`: 상대 이미지 경로 containment.
- `FR-RENDER-021`: 기존 문서 뷰어 컨텍스트 메뉴.
- `IR-APP-005`: renderer strings payload.
- `IR-APP-006`: 기존 `webContents` zoom IPC.
- `IR-APP-007`: viewer always-on-top 상태 변경 IPC.
- `FR-APP-006`: CLI/env locale override.
- `FR-APP-007`: `ko`, `en`, `ja`, `es` locale loading and fallback.
- `SEC-ARCH-001`: sandboxed, context-isolated BrowserWindow baseline.
- `SEC-ARCH-002`: renderer CSP baseline.

이번 구현을 위해 신규 SRS가 발급된 영역은 다음과 같다.

- `FR-RENDER-028`: Mermaid/image 인라인 hover 확장 버튼과 전용 media viewer UI.
- `FR-RENDER-028`: 전용 media viewer의 cursor-centered zoom, drag pan, visible scrollbars, dedicated context menu.
- `FR-RENDER-028`: Mermaid source 재렌더링과 전용 창 안의 node label overflow 방지.
- `IR-APP-012`: 독립 BrowserWindow 생명주기와 부모 viewer always-on-top 동기화.
- `SEC-ARCH-005`: 원격 이미지 fetch/download 보안 정책.

## 3. 서브에이전트 연구 취합

### 3.1 Main, Window, Security

main-process 연구는 전용 뷰어를 부모에 종속된 child window로 만들지 말고, 독립 BrowserWindow로 열되 parent viewer window id와 media window id를 registry로 연결하는 방식을 권장했다. 이 방식은 부모 창을 닫아도 media viewer가 닫히지 않는 요구사항과 맞고, always-on-top 동기화도 main process가 authoritative source가 될 수 있다.

주요 코드 위치:

- `src/main/window-manager.js`: 기존 viewer BrowserWindow 생성과 window meta 관리.
- `src/main/index.js`: IPC handler, save dialog, zoom, always-on-top toggle/set/release.
- `src/main/preload.js`: renderer bridge.

원격 이미지는 renderer가 직접 fetch하지 않는다. main process가 `http:`와 `https:`만 허용하고, redirect hop 재검증, private network 차단, credential/header 제거, MIME 검증, timeout, byte cap, filename sanitization을 수행한다.

### 3.2 Renderer and UI

renderer 연구는 기존 `viewer.js`가 Mermaid SVG를 삽입할 때 source text를 버리고, 이미지 resolve 후에는 원본 `src`와 표시용 `data:` URI가 분리되어 있지 않다는 점을 지적했다. 전용 뷰어 payload를 만들려면 렌더 후에도 다음 metadata가 남아야 한다.

- Mermaid: 원본 Mermaid source text, 제목 후보, 렌더된 SVG fallback.
- Image: 원본 source, 표시 source, alt/title, base path, local/remote/data 구분.

전용 viewer shell은 새 파일로 분리한다.

- `src/renderer/media-viewer.html`
- `src/renderer/media-viewer.css`
- `src/renderer/media-viewer.js`

전용 viewer zoom은 기존 `webContents` zoom IPC를 재사용하지 않는다. toolbar, scrollbars, hit target까지 확대되는 문제가 있으므로 media content DOM transform과 scroll container offset을 직접 관리한다.

### 3.3 TDD and E2E

테스트 연구는 정적 계약 테스트를 먼저 만들고, 그 다음 Electron E2E를 붙이는 순서를 권장했다. RED 단계에서 현재 결함이 명확히 드러나는 테스트는 다음 세 가지다.

- `test/test-media-viewer-contract.js`: renderer/preload/i18n/static contract.
- `test/test-media-viewer-window-contract.js`: BrowserWindow, IPC, always-on-top registry contract.
- `test/test-media-viewer-remote-image-contract.js`: remote image security and filename contract.

E2E는 generated temp fixture로 진행한다.

- 긴 한글/혼합언어 Mermaid label.
- 큰 로컬 SVG 또는 PNG.
- 원격 이미지 테스트용 local HTTP server.

## 4. 발급된 SRS 요구사항

SpecKiwi MCP로 다음 요구사항을 발급했다.

### 4.1 `FR-RENDER-028` Renderer Functional Requirement

Scope: `RENDER`

Title: `Dedicated Mermaid and image media viewer`

핵심 acceptance criteria:

- 인라인 Mermaid block과 markdown image hover 시 좌측 상단 확장 버튼을 표시한다.
- 확장 버튼은 media viewer 전용 BrowserWindow를 연다.
- media viewer는 toolbar `+`, `-`, reset, wheel zoom, cursor-centered zoom, drag pan, visible horizontal/vertical scrollbars를 제공한다.
- media viewer 우클릭 context menu는 download action을 제공한다.
- Mermaid media viewer는 source text를 다시 렌더링하고, 전용 창에서 node label bounding box가 visible node shape 내부에 들어오게 한다.
- Mermaid download는 SVG 파일을 저장한다.
- image media viewer는 local, data URL, remote http/https 이미지를 표시한다.
- image download는 원본 이미지 포맷을 저장한다.
- 모든 user-visible string은 기존 strings payload/API와 `src/locales/{ko,en,ja,es}.json`을 사용한다.

### 4.2 `IR-APP-012` App Interface Requirement

Scope: `APP`

Title: `Dedicated media viewer window lifecycle and pin synchronization`

핵심 acceptance criteria:

- preload는 renderer가 media viewer open/download를 요청할 수 있는 제한된 IPC bridge를 제공한다.
- main process는 sandboxed, context-isolated BrowserWindow로 media viewer를 연다.
- media viewer는 일반 Markdown viewer와 독립적으로 닫힌다.
- 부모 viewer가 닫혀도 media viewer는 닫히지 않는다.
- 부모 viewer always-on-top 상태가 toggle/set/release로 바뀌면 연결된 media viewer도 같은 값으로 갱신된다.
- 부모 viewer가 사라진 뒤 media viewer는 마지막 inherited pin state를 유지한다.

### 4.3 `SEC-ARCH-005` Architecture Security Requirement

Scope: `ARCH`

Title: `Remote image mediation and safe media download`

핵심 acceptance criteria:

- remote image fetch는 `http:`와 `https:`만 허용한다.
- redirect follow 시 각 hop과 최종 URL에 같은 protocol/private-network 정책을 적용한다.
- URL credential은 거부하거나 제거하고, request에는 cookie, referrer, Authorization header를 보내지 않는다.
- localhost, loopback, link-local, private IP 대역은 기본 차단한다.
- response MIME은 image type만 허용한다.
- timeout과 maximum byte size를 적용한다.
- `Content-Disposition`과 URL basename 기반 파일명은 traversal, control char, reserved name, extension spoofing을 제거한다.
- renderer에는 raw credential, absolute local path, unsafe network error detail을 노출하지 않는다.

## 5. 구현 단계

### Phase 1: SRS and RED Tests

1. SpecKiwi MCP로 `FR-RENDER-028`, `IR-APP-012`, `SEC-ARCH-005`를 발급한다.
2. `test/test-media-viewer-contract.js`를 추가하고 RED를 확인한다.
3. `test/test-media-viewer-window-contract.js`를 추가하고 RED를 확인한다.
4. `test/test-media-viewer-remote-image-contract.js`를 추가하고 RED를 확인한다.

### Phase 2: Renderer Metadata and Inline Expand

1. `viewer.js`의 Mermaid render path에서 source text를 `data-mermaid-source` 또는 registry id로 보존한다.
2. `resolveLocalImages`에서 원본 `src`를 `data-original-src`로 보존하고 표시용 `src`와 분리한다.
3. Mermaid block과 image wrapper에 hover expand button을 추가한다.
4. `viewer.css`에 compact icon button 스타일을 추가한다.
5. 기존 PDF export, empty state, settings UI와 섞이지 않게 scope를 `#content` 내부 rendered media로 제한한다.

### Phase 3: Dedicated Media Viewer Shell

1. `media-viewer.html`에 local CSS/JS와 strict CSP를 둔다.
2. `media-viewer.css`에 top-left toolbar, scroll viewport, transform surface, context menu를 둔다.
3. `media-viewer.js`에 payload render, cursor-centered wheel zoom, toolbar zoom, reset, drag pan, visible scrollbar behavior, download request를 구현한다.
4. Mermaid viewer는 vendored `mermaid.min.js`를 사용해 source text를 strict mode로 다시 렌더링한다.
5. 긴 Mermaid label은 전용 창에서 wrapping 또는 SVG 측정 기반 보정으로 node shape 내부에 표시되게 한다.

### Phase 4: Main IPC, Window Registry, Download

1. `preload.js`에 `openMediaViewer`, `onMediaViewerPayload`, `downloadMediaAsset`를 노출한다.
2. `index.js`에 `media-viewer:open`, `media-viewer:download`, remote image fetch helper, filename sanitizer를 추가한다.
3. media viewer BrowserWindow는 `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, 기존 preload를 사용한다.
4. media window registry를 추가하고, parent viewer pin 변경 시 연결 media viewer에 `setAlwaysOnTop`을 적용한다.
5. 부모 viewer close 시 media viewer를 닫지 않고 registry source만 제거한다.

### Phase 5: i18n and UX Polish

1. `src/locales/en.json`, `ko.json`, `ja.json`, `es.json`에 동일 key set을 추가한다.
2. toolbar title, aria-label, context menu label, download dialog label, error/status text를 모두 locale key로 연결한다.
3. 버튼은 기존 floating action button과 같은 회색 계열을 따르고, 문서 본문을 가리지 않도록 hover 시에만 노출한다.

### Phase 6: E2E Regression

1. `test/media-viewer.e2e.js`를 추가한다.
2. temp directory에 Markdown fixture, local image fixture를 생성한다.
3. local HTTP server로 remote image success, non-image MIME, redirect, private-address blocked case를 만든다.
4. Electron을 dev profile로 띄우고 open_markdown IPC로 fixture를 연다.
5. Mermaid hover expand, image hover expand, new window, zoom, pan, scrollbar, download context menu, parent close independence, pin sync를 확인한다.

## 6. 검증 명령

RED/GREEN 반복에 사용할 명령:

```powershell
node test/test-media-viewer-contract.js
node test/test-media-viewer-window-contract.js
node test/test-media-viewer-remote-image-contract.js
npx playwright test test/media-viewer.e2e.js --reporter=line
```

관련 회귀:

```powershell
node test/test-window-navigation-history-contract.js
node test/test-settings-indexing-contract.js
npm run test:wave2
```

전체 release smoke가 필요한 시점:

```powershell
npm run smoke:package
```

## 7. 리스크와 대응

- Mermaid overflow는 CSS만으로 해결되지 않을 수 있다. acceptance criteria는 구현 기법이 아니라 label bounding box가 node shape 내부에 포함되는 결과로 둔다.
- 원격 이미지 지원은 현재 viewer CSP와 충돌하므로 main-process mediation을 사용한다.
- 기존 `webContents` zoom을 재사용하면 toolbar와 scrollbar까지 확대되어 요구사항과 어긋난다. 전용 viewer transform model을 사용한다.
- 기존 문서 viewer context menu에 media action을 섞으면 회귀 위험이 크다. 전용 media viewer 내부 context menu로 분리한다.
- 작업트리에 기존 변경이 많으므로 구현은 위 파일들에만 제한하고 unrelated diff를 되돌리지 않는다.

## 8. 연구 결론

전용 Mermaid/image viewer는 기존 렌더링 파이프라인 위에 얹는 단일 UI 변경이 아니라, renderer metadata 보존, 독립 BrowserWindow, main-process 다운로드/remote fetch, i18n, e2e 검증이 함께 필요한 기능이다. 따라서 신규 SRS를 먼저 추가하고, 정적 계약 테스트 RED 확인 뒤 작은 구현 단계로 진행하는 것이 타당하다.
