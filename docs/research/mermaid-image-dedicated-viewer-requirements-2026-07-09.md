# Mermaid and Image Dedicated Viewer Requirements Analysis

Date: 2026-07-09
Target repository: DocuLightViewer
Document type: research / requirements analysis
Language: Korean

## Scope

이 문서는 Mermaid 그래프 전용 확대 창과 이미지 전용 확대 창 요구사항을 현재 코드와 SRS에 대조한 분석 문서이다. 이 문서는 `docs/spec`를 대체하는 요구사항 원천이 아니다. 구현 전에 `docs/spec/80.renderer-pipeline.srs.md`, `docs/spec/20.app-shell.srs.md`, 필요 시 `docs/spec/30.window-management.srs.md`에 새 요구사항 또는 기존 요구사항 확장을 추가해야 한다.

## User Decisions

사용자가 확정한 요구사항은 다음과 같다.

- Mermaid 노드 텍스트가 박스 밖으로 나가는 문제는 전용 확대 창에서만 잘 보이면 된다. 인라인 문서 뷰어의 Mermaid 렌더링은 기존 동작을 유지할 수 있다.
- 전용 확대 창에서는 텍스트 줄임이나 단순 축소보다 노드 박스 확장을 우선한다.
- Mermaid 전용 확대 창은 Electron 새 창으로 연다.
- 부모 뷰어 창을 닫아도 전용 확대 창은 닫히지 않는다.
- 전용 확대 창에는 가로/세로 스크롤바가 화면상에 보여야 한다.
- 마우스 휠 확대/축소 기준점은 마우스 커서 위치이다.
- Mermaid 다운로드 형식은 SVG이다.
- 원격 이미지도 이미지 전용 뷰어와 다운로드 대상에 포함한다.
- 부모 뷰어의 always-on-top 상태가 바뀌면 전용 창도 따라가야 한다.
- 이미지 뷰어는 Mermaid 뷰어와 같은 외형과 동작을 가진다. 즉 좌측 상단 확장 버튼, 전용 창의 `+`/`-`, 마우스 휠 확대/축소, 좌클릭 드래그 팬, 우클릭 다운로드가 동일하게 적용된다.

## Existing SRS Coverage

기존 SRS가 이미 커버하는 범위는 다음과 같다.

- `FR-RENDER-003`: 렌더된 콘텐츠의 `file:` 또는 상대 경로 이미지를 main IPC로 읽어 `data:` URI로 교체한다.
- `FR-RENDER-004`: `mermaid` 언어 코드 블록을 SVG 다이어그램으로 렌더링하고, 실패 시 오류 요소로 대체한다.
- `FR-RENDER-008`: 상대 이미지 경로를 기준 경로 내부로만 해석하고 경로 탈출을 차단한다.
- `FR-RENDER-021`: 기존 문서 뷰어 영역의 컨텍스트 메뉴를 제공한다.
- `IR-APP-006`: 현재 뷰어 `webContents`의 전체 zoom level을 제어한다.
- `IR-APP-007`: 현재 창의 always-on-top 상태를 toggle/set/release하고 렌더러에 알린다.
- `FR-APP-006`: CLI/env 로케일 override 우선순위를 정의한다.
- `FR-APP-007`: `ko`, `en`, `ja`, `es` 로케일 로딩과 영어 fallback을 정의한다.
- `IR-APP-005`: renderer가 main process의 strings payload를 받아 UI 문자열을 표시하는 인터페이스를 정의한다.
- `SEC-ARCH-001`: BrowserWindow는 `contextIsolation=true`, `nodeIntegration=false`, `sandbox=true`와 preload만 사용해야 한다.
- `SEC-ARCH-002`: renderer HTML은 제한적인 CSP를 유지해야 한다.

기존 SRS가 커버하지 않는 범위는 다음과 같다.

- Mermaid 및 이미지 전용 확대 창 생성과 생명주기.
- 인라인 Mermaid가 아닌 전용 창에서의 노드 박스 확장 기준.
- 전용 창 내부 콘텐츠 전용 pan/zoom 모델.
- 마우스 커서 위치 기준 휠 zoom.
- 좌클릭 드래그 pan과 가로/세로 스크롤바의 공존 규칙.
- Mermaid SVG 다운로드 계약.
- 로컬/원격 이미지 다운로드 계약.
- 부모 viewer always-on-top 상태를 독립 전용 창에 계속 동기화하는 계약.
- 전용 뷰어 UI 문자열의 `ko`, `en`, `ja`, `es` i18n 키.

## Current Code Findings

### Mermaid Rendering

현재 Mermaid는 `src/renderer/viewer.js`에서 `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })`로 초기화된다. `renderMermaidDiagrams`는 `code.language-mermaid` 블록마다 `mermaid.render`를 호출하고, 결과 SVG를 `.mermaid` div에 넣어 기존 `pre`를 대체한다.

관련 코드:

- `src/renderer/viewer.js:167`: Mermaid 초기화.
- `src/renderer/viewer.js:472`: `renderMermaidDiagrams` 진입점.
- `src/renderer/viewer.js:484`: `mermaid.render` 호출.
- `src/renderer/viewer.css:422`: `.mermaid`는 `text-align`과 `margin`만 지정한다.

현재 구현에는 Mermaid 노드 텍스트 overflow 보정, 전용 창, 확대 버튼, pan/zoom, 다운로드 기능이 없다. 따라서 전용 확대 창 요구사항은 새 기능이다.

### Image Rendering

현재 로컬 이미지는 sandbox renderer가 직접 파일을 읽지 않고 main IPC `read-image-as-data-url`을 통해 `data:` URI로 치환한다.

관련 코드:

- `src/renderer/image-resolver.js:14`: marked image renderer hook.
- `src/renderer/image-resolver.js:25`: 이미지 경로 해석.
- `src/renderer/image-resolver.js:114`: 기준 경로 containment 검사.
- `src/renderer/viewer.js:261`: `resolveLocalImages`.
- `src/renderer/viewer.js:294`: `readImageAsDataUrl` 호출.
- `src/main/index.js:4060`: `read-image-as-data-url` IPC.
- `src/renderer/viewer.css:296`: `.markdown-body img { max-width: 100%; height: auto; }`.

현재 `resolveLocalImages`는 `http://`와 `https://` 이미지를 건너뛰지만, `viewer.html`의 CSP는 `img-src 'self' data: blob: file:` 형태라 원격 이미지를 직접 표시하지 못할 수 있다. 사용자가 원격 이미지 포함을 확정했으므로 전용 이미지 뷰어는 main process를 통한 안전한 remote fetch 또는 별도 CSP/프록시 정책이 필요하다.

### Existing Zoom

현재 zoom IPC는 `webContents` 전체 zoom level을 0.5 단위로 조정한다.

관련 코드:

- `src/main/index.js:3250`: `zoom-in`.
- `src/main/index.js:3259`: `zoom-out`.
- `src/main/index.js:3268`: `zoom-reset`.

전용 뷰어의 요구사항은 콘텐츠 하나에 대한 pan/zoom이다. 기존 `webContents` zoom을 재사용하면 버튼, 스크롤바, 커서 기준 zoom, drag pan을 정밀하게 제어하기 어렵다. 전용 창 안에서는 DOM transform 기반의 독립 zoom model을 두는 편이 맞다.

### Context Menu

현재 문서 뷰어의 우클릭 메뉴는 viewer container 전체 이벤트를 잡아 custom context menu를 렌더링한다.

관련 코드:

- `src/renderer/viewer.js:1250`: `showContextMenu`.
- `src/renderer/viewer.js:1473`: `contextmenu` 이벤트 바인딩.

Mermaid와 이미지의 우클릭 다운로드는 기존 문서 컨텍스트 메뉴와 충돌할 수 있다. 인라인 문서에서는 확장 버튼으로 전용 창을 열고, 전용 창 내부에서 media 전용 context menu를 별도로 제공하는 구조가 가장 충돌이 적다.

### Window and Always-on-Top

현재 일반 Markdown viewer 창은 `WindowManager.createWindow`에서 생성되고, 메타 `alwaysOnTop`은 `false`로 시작한다.

관련 코드:

- `src/main/window-manager.js:527`: 일반 viewer `BrowserWindow` 생성.
- `src/main/window-manager.js:570`: window meta `alwaysOnTop: false`.
- `src/main/window-manager.js:606`: focus 시 meta가 pinned이면 `setAlwaysOnTop(true)`.
- `src/main/index.js:3358`: `toggle-always-on-top`.
- `src/main/index.js:3372`: `set-always-on-top`.
- `src/main/index.js:3385`: `release-always-on-top`.

부모 viewer가 닫혀도 전용 창이 닫히지 않아야 하므로 Electron `parent` child window로 묶지 않는 편이 안전하다. 다만 부모의 pin 상태 변경을 따라가야 하므로 main process에 parent viewer window id와 media viewer window들의 동기화 registry가 필요하다. 부모가 닫힌 뒤에는 더 이상 상태 변경 source가 없으므로 media viewer는 마지막 상속 상태를 유지하는 것이 자연스럽다.

## Requirement Interpretation

### Inline Viewer Behavior

인라인 문서 뷰어에서는 Mermaid와 이미지 위에 hover 시 좌측 상단 확장 버튼을 표시한다. 버튼은 전용 창을 여는 역할만 한다. 인라인 Mermaid 자체의 노드 박스 보정은 이번 요구사항의 필수 범위가 아니다.

인라인 버튼은 다음 조건을 만족해야 한다.

- Mermaid `.mermaid` block과 markdown image 위에 hover 시 보인다.
- 버튼은 좌측 상단에 나타난다.
- 버튼은 아이콘 중심 UI로 제공하고 tooltip/i18n label을 가진다.
- PDF export mode, empty state, settings view에는 표시되지 않는다.

### Dedicated Media Viewer Window

전용 창은 Mermaid와 이미지를 공통 media viewer shell로 표시한다.

공통 동작:

- 좌측 상단 toolbar에 확대 `+`, 축소 `-`, 원본 크기 또는 맞춤 reset 버튼을 둔다.
- 마우스 휠은 커서 위치 기준 zoom을 수행한다.
- 좌클릭 드래그는 pan을 수행한다.
- 화면에 가로/세로 스크롤바를 표시한다. 구현은 `overflow: scroll` 또는 동등한 방식으로 스크롤바 affordance를 유지해야 한다.
- 스크롤바와 drag pan은 같은 viewport offset을 반영해야 한다.
- 우클릭 context menu에는 다운로드 항목을 제공한다.
- 부모 viewer가 always-on-top이면 전용 창도 always-on-top으로 열린다.
- 부모 viewer의 pin 상태가 바뀌면 열린 전용 창들의 always-on-top 상태도 바뀐다.
- 부모 viewer가 닫혀도 전용 창은 독립적으로 남는다.

### Mermaid-Specific Behavior

Mermaid 전용 창은 Mermaid source text를 받아 전용 renderer에서 다시 SVG로 렌더링하는 방식이 적합하다. 인라인 viewer에서 이미 렌더된 SVG만 넘기면, 노드 박스 확장 요구사항을 전용 창에서만 안정적으로 적용하기 어렵다.

전용 창 Mermaid 요구사항:

- source text 기준으로 다시 렌더링한다.
- 보안 기준은 기존 `securityLevel: 'strict'`를 유지한다.
- 노드 텍스트가 박스 밖으로 나가지 않아야 한다.
- 문제 해결 우선순위는 노드 박스 확장이다.
- 단순히 SVG 전체를 축소해서 텍스트를 맞추는 방식은 요구사항을 만족하지 않는다.
- 박스 확장이 Mermaid native layout 설정으로 해결되지 않으면 렌더 후 SVG 측정 기반 보정 또는 source normalization 전략을 사용해야 한다.
- 다운로드는 SVG 파일로 저장한다.

Mermaid 박스 확장 리스크:

- 현재 vendored `mermaid.min.js`에는 `htmlLabels` 관련 코드가 있으나, 현재 앱에서 노드 텍스트 overflow를 제어하는 별도 설정은 사용하지 않는다.
- Mermaid 내부 layout이 label 크기와 edge routing을 함께 계산하므로, 렌더 후 박스만 키우면 edge와 box 간 시각적 겹침이 남을 수 있다.
- SRS acceptance criteria는 구현 기법보다 결과 기준으로 잡아야 한다. 예: "전용 Mermaid 창에서 각 노드 label bounding box가 표시 node shape 내부에 포함된다."

### Image-Specific Behavior

이미지 전용 창은 로컬, data URL, blob, 원격 http/https 이미지를 대상으로 한다.

이미지 요구사항:

- 로컬/상대 이미지는 기존 containment 정책을 보존한다.
- 원격 이미지는 포함한다. 단, renderer가 임의 원격 fetch를 직접 수행하지 않도록 main process에서 protocol allowlist, size cap, timeout, MIME 검증을 적용해 가져오는 방식이 바람직하다.
- 원격 이미지 fetch는 redirect 대상 URL도 매 hop 재검증해야 한다.
- 원격 이미지 fetch는 URL credential, cookie, referrer, Authorization header를 전송하지 않아야 한다.
- 원격 이미지 fetch는 localhost, loopback, link-local, private IP 대역 접근 정책을 SRS에 명시해야 한다. 보수적인 기본값은 차단이며, 허용이 필요하면 별도 acceptance criteria와 테스트가 필요하다.
- 이미지 다운로드는 원본 포맷을 우선한다. Mermaid와 달리 이미지 다운로드를 SVG로 변환하지 않는다. 사용자가 명시한 SVG 형식은 Mermaid 다운로드 형식으로 해석한다.
- 원격 이미지의 파일명은 URL basename, `Content-Disposition`, MIME-derived extension, fallback 이름을 사용하되 path traversal, 제어 문자, 예약 이름, 확장자 위장을 sanitization해야 한다.
- 실패 시 사용자에게 로컬라이즈된 오류 메시지를 보여준다.

## Proposed SRS Additions

구현 전에 다음 요구사항을 추가하거나 확장해야 한다.

### New Renderer Requirement

권장 위치: `docs/spec/80.renderer-pipeline.srs.md`

권장 임시 제목: `Mermaid and image dedicated media viewer`

주의: Requirement ID는 이 문서에서 수동 확정하지 않는다. 구현 전 SpecKiwi로 신규 `FR-RENDER-*` 요구사항을 발급하거나 기존 요구사항을 안전하게 확장해야 한다.

핵심 acceptance criteria:

- 인라인 Mermaid block과 markdown image hover 시 좌측 상단 확장 버튼을 표시한다.
- 확장 버튼은 media viewer 전용 BrowserWindow를 연다.
- media viewer는 `+`, `-`, wheel zoom, cursor-centered zoom, drag pan, visible horizontal/vertical scrollbars를 제공한다.
- media viewer 우클릭 context menu는 다운로드를 제공한다.
- Mermaid media viewer는 source text를 다시 렌더링하고 전용 창에서 노드 텍스트가 node shape 밖으로 나가지 않게 한다.
- Mermaid 다운로드는 SVG 파일을 저장한다.
- image media viewer는 로컬, data URL, remote http/https 이미지를 표시한다.
- image download는 원본 이미지 포맷을 저장한다.
- 모든 user-visible text는 `src/locales/{ko,en,ja,es}.json`에 존재하고, 기존 strings payload/API를 통해 toolbar, tooltip/title, aria-label, context menu, native save dialog label, 오류/status 메시지에 실제 사용된다.

### New App Shell / Window Requirement

권장 위치: `docs/spec/20.app-shell.srs.md` 또는 `docs/spec/30.window-management.srs.md`

권장 임시 제목: `Dedicated media viewer window and pin synchronization`

주의: Requirement ID는 이 문서에서 수동 확정하지 않는다. 구현 전 SpecKiwi로 신규 `IR-APP-*` 또는 `FR-WIN-*` 요구사항을 발급하거나 기존 요구사항을 안전하게 확장해야 한다.

핵심 acceptance criteria:

- renderer는 preload IPC를 통해 media viewer open 요청을 보낼 수 있다.
- main process는 sandboxed, context-isolated BrowserWindow로 media viewer를 연다.
- media viewer는 일반 Markdown viewer와 독립적으로 닫힌다.
- 부모 viewer가 닫혀도 media viewer는 닫히지 않는다.
- 부모 viewer의 always-on-top 상태가 바뀌면 연결된 media viewer의 always-on-top도 같은 값으로 갱신된다.
- 부모 viewer가 없는 상태가 되면 media viewer는 마지막 inherited pin state를 유지한다.

### Security / Remote Image Requirement

권장 위치: `docs/spec/10.product-architecture.srs.md` 또는 `docs/spec/80.renderer-pipeline.srs.md`

핵심 acceptance criteria:

- remote image fetch는 `http:`와 `https:`만 허용한다.
- redirect follow 시 최종 URL과 각 redirect hop도 동일한 protocol 및 private-network 정책으로 재검증한다.
- URL에 포함된 username/password credential은 거부하거나 제거하고, fetch에는 cookie, referrer, Authorization header를 보내지 않는다.
- localhost, loopback, link-local, private IP 대역 접근은 기본 차단한다. 제품상 허용이 필요하면 명시적 SRS 예외와 별도 보안 테스트를 요구한다.
- response content type은 image MIME만 허용한다.
- fetch timeout과 maximum byte size를 둔다.
- `Content-Disposition`과 URL basename에서 얻은 다운로드 파일명은 path traversal, 제어 문자, OS 예약 이름, 확장자 위장을 제거하도록 sanitization한다.
- renderer에 raw remote credentials, absolute local paths, unsafe error details를 노출하지 않는다.
- media viewer HTML CSP는 원격 script/style/font를 허용하지 않는다.

## Implementation Direction

권장 파일 구조:

- Create `src/renderer/media-viewer.html`: 전용 media viewer shell.
- Create `src/renderer/media-viewer.css`: toolbar, scroll viewport, pan/zoom surface, context menu.
- Create `src/renderer/media-viewer.js`: media payload render, transform model, wheel cursor zoom, drag pan, download request.
- Extend `src/main/preload.js`: `openMediaViewer`, `onMediaViewerPayload`, `downloadMediaAsset` IPC bridge.
- Extend `src/main/index.js`: media viewer open/download IPC, remote image fetch, always-on-top propagation.
- Extend `src/renderer/viewer.js`: Mermaid/image hover affordance, payload extraction, source metadata preservation.
- Extend `src/renderer/viewer.css`: inline hover button styles.
- Update `src/locales/ko.json`, `en.json`, `ja.json`, `es.json`: toolbar labels, download label, errors.
- Add tests under `test/` for renderer contract and main IPC/window contract.

권장 implementation notes:

- Mermaid source text should be preserved when replacing `pre` with `.mermaid`, for example as a sanitized dataset or in an in-memory registry keyed by a generated id.
- Image elements should preserve source metadata needed for media viewer and download before `src` is replaced with `data:` URI.
- Existing document context menu should not be overloaded with media-specific behavior. Dedicated media viewer should own its own context menu.
- Do not reuse global `webContents` zoom IPC for media zoom. Use local transform state in the media viewer renderer.
- Do not use Electron `parent` option if it risks closing media viewer when parent viewer closes.
- Always-on-top sync should be main-process authoritative because renderer state can become stale.

## Test Strategy

TDD should start from automated contract tests before implementation.

Recommended tests:

- Static contract: `viewer.js` keeps Mermaid source available after render and adds media expand affordance to Mermaid and image elements.
- Static contract: `media-viewer.html` uses CSP and local scripts only.
- Renderer unit-style contract: media viewer zoom changes around cursor point and preserves scroll offset consistency.
- Renderer unit-style contract: drag pan updates scroll positions.
- Visual/geometry contract: a Mermaid fixture with long Korean and mixed-language node labels renders in the dedicated Mermaid viewer with each label bounding box inside its visible node shape.
- Visual/geometry contract: dedicated media viewer exposes visible horizontal and vertical scrollbars when content is larger than the viewport after zoom.
- Interaction parity contract: Mermaid and image viewers both support the same toolbar zoom, wheel zoom, drag pan, visible scrollbars, and download context menu paths.
- Main contract: `open-media-viewer` creates sandboxed BrowserWindow with preload and without `nodeIntegration`.
- Main contract: media viewer does not close when parent viewer closes.
- Main contract: parent always-on-top toggle/set/release propagates to linked media viewers.
- Download contract: Mermaid download saves SVG.
- Download contract: local image download preserves original or current image bytes.
- Remote image contract: only `http:` and `https:` are fetched; redirect hops are revalidated; localhost/private IP policy is enforced; URL credentials and cookie/referrer/Authorization headers are not sent; non-image MIME is rejected; oversized responses fail safely.
- Download filename contract: URL basename and `Content-Disposition` filenames are sanitized before save dialogs or file writes.
- i18n contract: every new locale key exists in `ko`, `en`, `ja`, `es`, and toolbar buttons, tooltip/title, aria-label, context menu, native save dialog text, and errors/status messages consume those keys through the existing strings payload/API.

## Risks

- Mermaid node expansion may require more than CSS. If Mermaid layout computes a small node shape before text measurement, post-render box expansion may not fully fix edge routing.
- Remote image support conflicts with the current CSP/direct renderer load model. Main-process mediation is safer and more consistent with existing local image handling.
- Wheel zoom and visible scrollbars can conflict if wheel is also expected to scroll. The resolved requirement is that wheel performs zoom, while scrollbars and drag pan provide navigation.
- Always-on-top sync must not accidentally re-parent media windows or close them with the parent viewer.
- Downloading remote images introduces network, timeout, MIME, size, and error-redaction requirements that existing local image IPC does not cover.

## Recommended Next Step

Before code changes, add SRS requirements for the dedicated media viewer, window lifecycle/pin synchronization, and remote image security contract. After SRS update, implement with TDD in small slices: inline affordance, media viewer shell, pan/zoom, downloads, always-on-top sync, remote image mediation, and i18n/test hardening.

## Requirement IDs Referenced

- `FR-RENDER-003`
- `FR-RENDER-004`
- `FR-RENDER-008`
- `FR-RENDER-021`
- `IR-APP-006`
- `IR-APP-007`
- `FR-APP-006`
- `FR-APP-007`
- `IR-APP-005`
- `SEC-ARCH-001`
- `SEC-ARCH-002`
