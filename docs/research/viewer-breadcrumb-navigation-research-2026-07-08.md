# 뷰어 링크 이동 경로 바 연구

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-07-08 |
| 대상 | DocuLight Viewer |
| 요청 | 링크 이동 시 상단에 `A > C > X > A` 형태의 이동 경로를 표시하고, 중간 항목 클릭 시 해당 문서로 이동하며 그 지점까지만 경로를 남긴다 |
| 조사 방식 | 5개 서브에이전트 병렬 조사 + 로컬 코드 확인 |
| 결론 | 구현 전 SRS 신규 요구사항 또는 기존 RENDER/WIN 요구사항 확장이 필요하다 |

## 1. 요구사항 이해

사용자가 원하는 기능은 파일 시스템 경로 표시가 아니라, 뷰어 안에서 사용자가 링크를 따라 이동한 방문 경로를 보여주는 상단 breadcrumb navigation bar이다.

예시는 다음과 같다.

1. `A` 문서를 연다.
2. `A` 안의 링크를 눌러 `C` 문서로 이동한다.
3. `C` 안의 링크를 눌러 `X` 문서로 이동한다.
4. `X` 안의 링크를 눌러 다시 `A` 문서로 이동한다.
5. 상단에는 `A > C > X > A`가 표시된다.
6. 이 상태에서 `C` 항목을 누르면 `C` 문서를 보여주고, 표시 경로는 `A > C`만 남는다.

UI 요구사항은 다음과 같이 해석한다.

- 위치: 뷰어 상단, 본문 위.
- 형태: 얇은 높이의 옅은 회색 배경 navigation bar.
- 표시: 문서 항목 사이에 `>` 구분자를 사용한다.
- 동작: 과거 항목 클릭 시 해당 문서로 이동하고, 클릭한 항목 이후 trail은 제거한다.
- 길이: 항목이 많아지면 줄바꿈하지 않고 bar 하단에 가로 스크롤이 생긴다.
- 반복 방문: `A > C > X > A`처럼 같은 문서가 여러 번 나타날 수 있다.

## 2. SRS 조사 결과

현재 SRS는 링크 이동과 history stack은 다루지만, 상단 breadcrumb bar 자체를 직접 정의하지 않는다.

관련 Requirement ID는 다음과 같다.

| Requirement ID | 파일 | 관련성 |
| --- | --- | --- |
| `FR-WIN-014` | `docs/spec/30.window-management.srs.md` | linked markdown file로 window를 이동하고 history에 push하는 요구 |
| `FR-WIN-015` | `docs/spec/30.window-management.srs.md` | 뒤로/앞으로 history navigation 요구 |
| `DR-WIN-002` | `docs/spec/30.window-management.srs.md` | per-window navigation history stack 구조와 불변식 |
| `FR-RENDER-014` | `docs/spec/80.renderer-pipeline.srs.md` | 탭 모드 navigation 처리 |
| `FR-RENDER-019` | `docs/spec/80.renderer-pipeline.srs.md` | 기존 하단 문서 navigation box |
| `FR-RENDER-024` | `docs/spec/80.renderer-pipeline.srs.md` | 콘텐츠 링크 클릭 종류별 navigation 처리 |
| `IR-APP-002` | `docs/spec/20.app-shell.srs.md` | preload navigation IPC 표면 |

간접 관련 범위도 있다. `FR-TREE-001`, `FR-TREE-002`, `FR-TREE-005`, `DR-TREE-001`은 sidebar link tree와 Markdown link parsing을 다루지만, breadcrumb trail의 표시와 클릭 동작의 source of truth는 아니다. 따라서 이 요구사항은 TREE가 아니라 RENDER/WIN 범위에서 다루는 것이 적합하다.

gap은 명확하다.

- `breadcrumb`, `path bar`, `top navigation bar` 요구가 없다.
- `A > C > X > A`처럼 반복 방문을 표시하는 요구가 없다.
- 항목 클릭 시 해당 지점까지 trail을 truncate하는 요구가 없다.
- 얇은 회색 bar, 하단 가로 스크롤, 접근성, i18n 요구가 없다.
- 탭 모드에서 trail을 탭별로 분리할지 정의되어 있지 않다.

따라서 구현 전 `docs/spec/80.renderer-pipeline.srs.md`에 신규 `FR-RENDER-*` 요구사항을 추가하는 것이 필요하다. history source of truth와 IPC가 바뀐다면 `docs/spec/30.window-management.srs.md`의 WIN 요구사항 또는 `IR-APP-002`도 함께 갱신해야 한다.

## 3. 현재 코드 구조

### 3.1 메인 프로세스 history

`src/main/window-manager.js`에는 `NavigationHistory`가 있다.

- `stack`: 파일 경로 배열
- `index`: 현재 위치
- `MAX_SIZE`: 50
- `push(filePath)`: 현재 index 뒤의 forward history를 버리고 새 경로를 추가
- `back()`: index를 하나 줄이고 해당 파일 경로 반환
- `forward()`: index를 하나 늘리고 해당 파일 경로 반환

링크 이동 흐름은 다음과 같다.

1. 렌더러에서 링크 클릭.
2. `window.doclight.navigateTo(filePath)`가 `navigate-to` IPC를 보낸다.
3. `src/main/index.js`가 sender BrowserWindow를 찾아 windowId를 얻는다.
4. `windowManager.navigateTo(windowId, filePath)`가 실행된다.
5. 상대 경로는 현재 파일 디렉터리 기준으로 resolve된다.
6. `.md` 또는 `.markdown` 확장자를 보정한다.
7. 파일을 읽은 뒤 `entry.meta.history.push(filePath)`를 수행한다.
8. renderer에 `render-markdown`과 `sidebar-highlight` 이벤트를 보낸다.

현재 구조는 breadcrumb의 source of truth로 재사용하기 좋다. 다만 `NavigationHistory`에는 특정 index로 이동하면서 trail을 자르는 메서드가 없다.

필요한 확장 후보:

- `NavigationHistory.snapshot()` 또는 `toJSON()`으로 `stack`, `index`, 현재까지의 trail을 직렬화.
- `NavigationHistory.jumpTo(index, { truncateForward: true })`로 breadcrumb 항목 클릭을 표현.
- `WindowManager.navigateToHistoryIndex(windowId, index)` 또는 `navigateBreadcrumb(windowId, index)` 추가.
- 파일 navigation으로 발생한 `render-markdown` payload에는 `navigationTrail`을 포함하고, content-only/PDF/empty window 경로에는 empty trail 또는 숨김 상태를 명확히 보낸다.

### 3.2 렌더러 링크 클릭

`src/renderer/viewer.js`의 전역 click handler는 모든 `<a>` 클릭을 가로챈다.

- `http://`, `https://`: 외부 브라우저로 전달.
- 로컬 Markdown 링크: 탭 모드가 있으면 `navigateToForTab(href)`, 아니면 `window.doclight.navigateTo(href)`.
- `#anchor`: 현재 문서 내 id로 scroll.
- 그 외 스킴: 차단.

breadcrumb는 이 판단 로직을 우회하지 않아야 한다. 외부 URL, anchor-only link, `javascript:`, `data:` 등은 breadcrumb trail에 들어가면 안 된다.

### 3.3 렌더링 위치

`src/renderer/viewer.html` 구조상 `#content`는 Markdown 렌더링 때 `innerHTML`이 교체된다. 따라서 breadcrumb DOM을 `#content` 안에 넣으면 매번 사라진다.

후보 위치는 두 가지다.

| 후보 | 장점 | 단점 |
| --- | --- | --- |
| `#viewer-container` 첫 자식, `#frontmatter-metabox` 앞 | 변경 범위가 작고 본문 렌더에 지워지지 않는다 | `#viewer-container`가 세로 스크롤 컨테이너라 bar 고정/가로 스크롤 처리를 신중히 해야 한다 |
| `#app-container`의 별도 grid row | 탭바 아래, 본문 위에 독립 bar를 만들 수 있어 요구사항과 가장 잘 맞는다 | `grid-template-rows`와 `#viewer-container` row 조정이 필요하다 |

권장안은 별도 grid row이다.

```text
row 1: tab bar
row 2: breadcrumb bar
row 3: viewer content
```

이 방식은 “뷰어 상단의 navigation bar”라는 요구와 잘 맞고, `overflow-x: auto`를 bar 자체에 줄 수 있다.

## 4. 탭 모드 고려

탭 모드는 별도 결정이 필요하다.

현재 `src/renderer/tab-manager.js`의 `navigateToForTab()`은 main process의 `WindowManager.navigateTo()`를 거치지 않는다.

- 상대 경로를 renderer에서 계산한다.
- `readFileForTab()`으로 파일을 읽는다.
- 이미 열린 파일이면 해당 탭으로 전환한다.
- 새 파일이면 새 탭을 만든다.
- main의 `NavigationHistory`는 갱신되지 않는다.

따라서 breadcrumb를 main history만으로 구현하면 탭 모드에서 trail이 비어 있거나 틀어진다.

권장 정책:

1. 기본 창 navigation은 main process `NavigationHistory`를 source of truth로 사용한다.
2. 탭 모드는 탭 객체에 `breadcrumbTrail`을 별도로 둔다.
3. 탭 전환 시 해당 탭의 trail을 복원한다.
4. 탭의 breadcrumb 항목 클릭은 `readFileForTab()` 성공 후 해당 탭 trail을 클릭 지점까지 truncate한다.
5. 같은 파일이 반복 방문되더라도 trail entry는 제거하지 않는다.

구현을 단순화하려면 1차 구현에서 탭 모드는 “현재 파일 단일 항목만 표시”로 제한할 수 있지만, 기존 앱이 탭 기능을 갖고 있으므로 최종 요구사항에는 탭별 trail을 포함하는 편이 낫다.

## 5. UI, CSS, 접근성

### 5.1 시각 디자인

기존 뷰어 CSS 변수와 맞추는 것이 좋다.

- 배경: `var(--sidebar-bg)` 또는 `#f6f8fa`
- border: `1px solid var(--border-color)`
- 텍스트: `var(--muted-text)`
- 활성/hover: `var(--link-color)` 또는 `var(--sidebar-hover)`
- 높이: 28-32px
- 글자 크기: 12-13px
- 그림자, 카드 스타일, 큰 둥근 모서리는 사용하지 않는다.

긴 trail 처리:

```css
overflow-x: auto;
overflow-y: hidden;
white-space: nowrap;
min-width: 0;
```

세그먼트 자체는 길면 ellipsis를 줄 수 있지만, 전체 trail은 줄바꿈하지 않는다.

### 5.2 접근성

권장 DOM 의미:

```html
<nav id="breadcrumb-bar" aria-label="문서 이동 경로">
  <button type="button">A</button>
  <span aria-hidden="true">&gt;</span>
  <button type="button">C</button>
  <span aria-hidden="true">&gt;</span>
  <span aria-current="page">X</span>
</nav>
```

접근성 요구:

- 클릭 가능한 항목은 `button type="button"` 사용.
- 구분자 `>`는 `aria-hidden="true"`.
- 마지막 항목에는 `aria-current="page"` 또는 `aria-current="location"`.
- Enter/Space 키로 클릭과 동일하게 동작.
- 반복 이름이 가능하므로 aria-label은 단일 파일명만 쓰지 말고 prefix를 포함한다.
  - 예: `A > C까지 이동 경로 표시`
- 파일 전체 경로는 `title` 속성으로 제공하되, 화면에는 basename 중심으로 표시한다.

### 5.3 i18n

동적 DOM은 `data-i18n` 자동 스캔만으로 충분하지 않다. JS의 `t()` 함수로 문자열을 만들어야 한다.

추가 후보 locale key:

- `viewer.breadcrumbAriaLabel`
- `viewer.breadcrumbSegmentAriaLabel`
- `viewer.breadcrumbCurrentAriaLabel`

ko/en/ja/es 네 locale 파일을 동시에 갱신해야 한다.

### 5.4 PDF와 찾기 바

PDF export mode에서는 기존 UI가 숨겨진다. breadcrumb도 PDF에 섞이지 않도록 숨기는 것이 맞다.

찾기 바는 현재 `position: fixed; top: 0` 패턴을 쓰므로, 새 top bar와 시각적으로 겹치지 않는지 확인해야 한다.

## 6. 추천 구현 방향

### 6.1 SRS 먼저 추가

신규 요구사항은 `RENDER` 범위가 주가 된다.

권장 Requirement 초안:

```text
시스템은 사용자가 뷰어 안에서 로컬 Markdown 링크를 따라 이동한 경로를 뷰어 상단의 얇은 breadcrumb navigation bar로 표시해야 한다. 같은 문서를 반복 방문한 경우도 방문 순서대로 보존해야 하며, breadcrumb의 이전 항목을 클릭하면 해당 문서를 렌더링하고 표시 trail은 선택 항목까지 truncate해야 한다. 긴 trail은 줄바꿈하지 않고 bar 내부에서 가로 스크롤로 탐색할 수 있어야 한다.
```

권장 Acceptance Criteria:

- 로컬 Markdown 링크 이동 시 trail에 새 문서를 append한다.
- 반복 방문을 제거하지 않는다. 예: `A > C > X > A`.
- trail 길이가 2 이상이면 상단 breadcrumb bar를 표시한다.
- 마지막 항목은 현재 문서로 표시하고 클릭 대상에서 제외하거나 current state로 처리한다.
- 이전 항목 클릭 시 해당 문서를 렌더링하고 trail을 클릭 항목까지 truncate한다. 예: `A > C > X > A`에서 `C` 클릭 후 `A > C`.
- 외부 URL, anchor-only link, 위험 스킴은 trail에 추가하지 않는다.
- missing file, non-Markdown target, 권한 오류 등 실패한 navigation은 trail을 변경하지 않는다.
- 긴 trail은 줄바꿈 없이 bar 내부에서 가로 스크롤된다.
- 탭 모드에서는 탭별 trail을 분리하거나, 제한 범위를 SRS에 명확히 적는다.
- PDF export mode에서는 breadcrumb UI가 출력물에 포함되지 않는다.

### 6.2 메인 프로세스 변경

권장 변경:

- `NavigationHistory`에 snapshot/jump/truncate 기능 추가.
- `WindowManager`의 `navigateTo`, `navigateBack`, `navigateForward`가 공통 렌더 함수로 `navigationTrail`을 함께 보낸다.
- breadcrumb 항목 클릭용 IPC 추가.
  - 예: preload `navigateToHistoryIndex(index)`
  - main IPC `navigate-to-history-index`
- `file-dropped`, `file-opened-in-tab`, `read-file-for-tab` 등 별도 진입점의 초기화 정책을 정리한다.

주의:

- `navigate-to`는 현재 fire-and-forget이라 실패가 renderer로 돌아가지 않는다.
- breadcrumb 클릭은 파일 읽기 성공 후 trail을 truncate해야 한다.
- missing link 클릭 실패 시 trail을 낙관적으로 먼저 바꾸면 안 된다.

### 6.3 렌더러 변경

권장 변경:

- `viewer.html`에 `#breadcrumb-bar` 또는 `#viewer-breadcrumb` 추가.
- `viewer.css`에서 별도 grid row 또는 `#viewer-container` 상단 bar 스타일 정의.
- `viewer.js`에 `renderBreadcrumbTrail(trail)` 함수 추가.
- `onRenderMarkdown`, `onUpdateMarkdown`, tab restore/switch 지점에서 bar를 갱신한다.
- 항목 클릭은 `data-index` 기반으로 처리하고 raw href 판별 로직과 분리한다.

### 6.4 탭 모드 변경

권장 변경:

- tab 객체에 `breadcrumbTrail` 추가.
- `createTab`, `switchTab`, `restoreTabContent`에서 trail 저장/복원.
- `navigateToForTab()`은 파일 읽기 성공 후 active tab trail을 append한다.
- 기존 탭으로 전환되는 경우 trail을 어떻게 합칠지 정책 필요.
  - 추천: 현재 active tab의 trail에 대상 파일을 append하고, 대상 파일 탭으로 전환할 때 그 탭의 trail도 동일하게 갱신한다.
  - 단순 대안: 탭마다 독립 trail을 유지하고 기존 탭 전환은 기존 탭 trail을 그대로 사용한다.

## 7. TDD 및 검증 계획

먼저 실패 테스트를 추가해야 한다.

### 7.1 계약 테스트

신규 후보:

- `test/test-window-navigation-history-contract.js`

검증 내용:

- `NavigationHistory`가 `A, C, X, A`를 순서대로 보존한다.
- `jumpTo(1, truncateForward=true)` 후 stack이 `A, C`가 된다.
- back 후 새 link를 누르면 forward history가 폐기된다.
- 50개 초과 시 오래된 entry가 trim된다.

### 7.2 E2E 테스트

기존 `test/doclight.e2e.js`에 추가하거나 `test/breadcrumb-navigation.e2e.js`를 새로 만든다.

검증 시나리오:

1. fixture 문서 `A.md`, `C.md`, `X.md`를 만든다.
2. `A`에서 `C`, `C`에서 `X`, `X`에서 `A`로 링크 이동한다.
3. breadcrumb 텍스트가 `A > C > X > A`인지 확인한다.
4. `C` 항목을 클릭한다.
5. 현재 문서가 `C`이고 breadcrumb가 `A > C`인지 확인한다.
6. 긴 trail fixture로 horizontal scroll이 생기는지 확인한다.

링크 종류 회귀:

- 외부 URL은 trail에 추가되지 않는다.
- anchor-only link는 trail에 추가되지 않는다.
- `javascript:`/`data:` 등 위험 스킴은 trail에 추가되지 않는다.
- missing link 실패 시 trail이 바뀌지 않는다.

탭 모드 회귀:

- 탭별 trail 분리.
- 탭 전환 시 breadcrumb 복원.
- 이미 열린 파일로 이동할 때 trail 정책이 테스트와 일치.

권장 검증 명령:

```powershell
node test/test-window-navigation-history-contract.js
npx playwright test test/doclight.e2e.js -g "breadcrumb|link traversal|history"
npx playwright test test/breadcrumb-navigation.e2e.js
npx playwright test test/sidebar-async.e2e.js
```

기존 navigation 회귀도 함께 확인한다.

```powershell
node test/test-link-extraction.js
npm run test:wave2
```

## 8. 단계별 실행 계획

1. SRS 추가
   - `docs/spec/80.renderer-pipeline.srs.md`에 breadcrumb navigation bar 요구사항 추가.
   - 필요 시 `docs/spec/30.window-management.srs.md`에 history jump/truncate 요구사항 추가.

2. RED 테스트 작성
   - `NavigationHistory` jump/truncate 계약 테스트.
   - Playwright breadcrumb E2E 테스트.

3. main history 확장
   - snapshot/jump/truncate 구현.
   - render payload에 trail 포함.
   - breadcrumb click IPC 추가.

4. renderer UI 구현
   - 상단 bar DOM/CSS 추가.
   - trail 렌더링과 클릭 처리.
   - i18n key 추가.

5. 탭 모드 정리
   - 탭별 trail 저장/복원.
   - 기존 탭 전환 정책 확정.

6. 회귀 검증
   - 단위/계약 테스트.
   - Playwright E2E.
   - 기존 link/sidebar/tab navigation 회귀.

## 9. 서브에이전트 조사 취합

| 에이전트 | 조사 축 | 핵심 결론 |
| --- | --- | --- |
| 1 | SRS | 기존 SRS는 링크 이동/history는 다루지만 breadcrumb bar는 다루지 않는다. 신규 RENDER 요구사항 필요. |
| 2 | main history | `NavigationHistory`가 source of truth로 적합하지만 jump/truncate 메서드가 필요하다. 탭 모드는 main history를 우회한다. |
| 3 | renderer integration | `#content` 안이 아니라 본문 밖 상단 DOM이 필요하다. 링크 클릭은 `viewer.js`의 기존 handler 정책을 보존해야 한다. |
| 4 | UI/CSS/accessibility | 기존 CSS 변수 기반의 28-32px light-gray bar, `nav`, `button`, `aria-current`, i18n key가 필요하다. |
| 5 | test strategy | history contract test와 Playwright breadcrumb E2E를 먼저 추가해야 한다. missing/external/anchor/tab edge case가 중요하다. |

## 10. 최종 권고

이 기능은 단순 UI 표시가 아니라 navigation history semantics를 사용자에게 노출하는 기능이다. 따라서 renderer-only 상태로 구현하지 말고, 기본 창 navigation은 main process `NavigationHistory`를 확장해 source of truth로 삼는 것이 맞다.

다만 탭 모드는 이미 main history를 우회하므로 별도 설계가 필요하다. 구현 범위를 정확히 하려면 SRS에서 “탭 모드도 지원”을 명시하거나, 1차 구현 범위에서 제외한다고 분명히 적어야 한다.

추천 최종 방향:

- 신규 SRS: `FR-RENDER-*` breadcrumb navigation bar.
- main: `NavigationHistory` snapshot/jump/truncate.
- preload/main IPC: breadcrumb index navigation.
- renderer: `#app-container` 별도 row의 thin gray scrollable nav bar.
- tabs: 탭별 trail 저장/복원.
- tests: history contract + Playwright E2E를 RED로 먼저 작성.
