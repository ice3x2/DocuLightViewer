# SRS — 사이드바 트리 전체 접기/펼치기

| 항목 | 값 |
|------|----|
| 문서 ID | SRS-Step29 |
| 작성일 | 2026-04-17 |
| 작성자 | snoworca-tiny-srs-incremental-qna |
| 요구사항 정리 | `docs/srs/request/2026-04-17.request.srs.사이드바트리전체열고닫기.md` |
| 관련 코드 | `src/renderer/viewer.{html,css,js}`, `src/renderer/sidebar-search.js`, `src/locales/*.json` |
| 관련 이전 SRS | — (신규) |

---

## 1. 개요

### 1.1 목적

DocuLight Viewer 사이드바 트리에서 **디렉토리 노드의 접힘/펼침을 일괄 조작하는 두 개의 헤더 버튼**을 추가한다. 사용자는 깊게 중첩된 트리에서 개별 디렉토리를 하나씩 토글하지 않고 한 번의 클릭으로 전체를 일관된 상태로 만들 수 있다.

### 1.2 범위

- **포함**: 사이드바 헤더 내 "모두 접기"/"모두 펼치기" 버튼 추가, 모든 `.tree-children`(가상 디렉토리 포함) 일괄 토글, 검색 모드·로딩 중 비활성화, 4개 로케일 i18n.
- **제외**: 개별 디렉토리만 선택 접기/펼치기, 저장된 접힘 상태의 영구 저장(세션 내 유지만), 키보드 단축키.

### 1.3 용어

| 용어 | 정의 |
|------|------|
| 트리 노드 | `src/renderer/viewer.js::buildSidebarNodeElement`로 생성되는 `.tree-item` DOM 엘리먼트 |
| 디렉토리 노드 | `.tree-item` 직후 형제로 존재하는 `.tree-children` div를 가진 노드 |
| 접기(Collapse) | `.tree-children`의 `display='none'` + 토글 문자 `▶` |
| 펼치기(Expand) | `.tree-children`의 `display='block'` + 토글 문자 `▼` |
| 가상 디렉토리 | `isVirtual:true`이고 `title='__external_links__'`인 트리 노드 |

### 1.4 비즈니스 목표

깊게 중첩된 문서 폴더(예: `docs/plan/step28.../`)를 열람할 때 디렉토리를 수동으로 토글하는 불편을 제거하여 **작업 흐름 효율을 높인다**.

---

## 2. 기능 요구사항

### FR-001 — "모두 접기" 버튼 추가

- **ID**: FR-001
- **우선순위**: P1
- **입력**: 사용자가 사이드바 헤더의 "모두 접기" 버튼을 클릭한다.
- **처리**:
  1. 렌더러는 `#sidebar-tree` 내 모든 `.tree-children` 엘리먼트를 DOM 쿼리로 수집한다.
  2. 각 엘리먼트의 `style.display = 'none'`으로 설정한다.
  3. 각 엘리먼트의 이전 형제(디렉토리 `.tree-item`) 내 `.tree-toggle` 텍스트를 `▶`로 업데이트한다.
  4. 가상 디렉토리(`__external_links__`) 노드의 `.tree-children`도 동일하게 처리한다.
- **출력**: 사이드바 내 모든 디렉토리(중첩 포함, MAX_DEPTH=10)가 접힌 상태가 된다.
- **버튼 표현**:
  - 아이콘: 인라인 SVG. 상단에 오른쪽-화살표 형태(`▼`처럼 중앙을 향해 모이는 2개의 chevron, `∨∧` 세로 배치).
  - `aria-label`: "모두 접기" / "Collapse all" / "すべて折りたたむ" / "Contraer todo"
  - `title`: 동일
  - 버튼 ID: `btn-sidebar-collapse-all`

### FR-002 — "모두 펼치기" 버튼 추가

- **ID**: FR-002
- **우선순위**: P1
- **입력**: 사용자가 사이드바 헤더의 "모두 펼치기" 버튼을 클릭한다.
- **처리**:
  1. `#sidebar-tree` 내 모든 `.tree-children` 엘리먼트를 수집한다.
  2. 각 엘리먼트의 `style.display = 'block'`으로 설정한다.
  3. 각 디렉토리 `.tree-item`의 `.tree-toggle` 텍스트를 `▼`로 업데이트한다.
  4. 가상 디렉토리(`__external_links__`)도 포함한다.
- **출력**: 사이드바 내 모든 디렉토리가 펼쳐진 상태가 된다.
- **버튼 표현**:
  - 아이콘: 인라인 SVG. 상단에 바깥 방향으로 벌어지는 2개의 chevron(`∧∨` 세로 배치).
  - `aria-label`: "모두 펼치기" / "Expand all" / "すべて展開する" / "Expandir todo"
  - `title`: 동일
  - 버튼 ID: `btn-sidebar-expand-all`

### FR-003 — 검색 모드 활성 시 비활성화

- **ID**: FR-003
- **우선순위**: P1
- **트리거**: `sidebar-search.js::enterSearchMode()` 호출 시 또는 `doculight:searchmode` 이벤트 수신 시.
- **처리**:
  - `btn-sidebar-collapse-all.disabled = true`
  - `btn-sidebar-expand-all.disabled = true`
- **종료**: `exitSearchMode()` / `doculight:searchmode` `detail.active === false` 수신 시 비활성 해제(트리 존재 조건 충족한 경우).

### FR-004 — 로딩 중 비활성화

- **ID**: FR-004
- **우선순위**: P1
- **트리거**: `onSidebarTreeStart` 이벤트 수신 또는 `_currentTreeLoadId !== 0` 상태.
- **처리**: 두 버튼을 `disabled = true`로 설정.
- **종료 조건**: `onSidebarTreeDone` 또는 `onSidebarTreeError` 수신 후, 현재 트리 루트가 비어있지 않고 검색 모드가 아니면 `disabled = false`.

### FR-005 — 트리 부재 시 비활성화

- **ID**: FR-005
- **우선순위**: P1
- **트리거**: `window.DocuLight.state.sidebarTree === null` 또는 `tree.children.length === 0`.
- **처리**: 기존 `btn-sidebar-name-toggle`과 동일한 패턴으로 두 버튼 `disabled = true`.

### FR-006 — i18n 문자열 추가 (4개 로케일)

- **ID**: FR-006
- **우선순위**: P2
- **파일**: `src/locales/{ko,en,ja,es}.json`
- **키**:
  - `sidebar.collapseAll` / `sidebar.expandAll`
  - `sidebar.collapseAllTitle` / `sidebar.expandAllTitle`
- **값**:
  | 로케일 | collapseAll | expandAll |
  |--------|-------------|-----------|
  | ko | 모두 접기 | 모두 펼치기 |
  | en | Collapse all | Expand all |
  | ja | すべて折りたたむ | すべて展開する |
  | es | Contraer todo | Expandir todo |

### FR-007 — 버튼 배치 순서

- **ID**: FR-007
- **우선순위**: P2
- **배치**: `#sidebar-header` 내 `[Navigation 레이블] [🏷️] [🔍] [접기] [펼치기]` 순서. 기존 버튼 오른쪽 끝에 추가.
- **스타일**: 기존 헤더 버튼과 동일한 크기·폰트·패딩(`#btn-sidebar-search` CSS 패턴 따름).

---

## 3. 비기능 요구사항

### NFR-001 — 성능

- 일반 트리(≤ 2000 노드)에서 전체 토글 연산은 **50ms 이내 완료**되어야 한다.
- 최악 상한(MAX_TREE_FILES=65535)에서도 **200ms 이내 완료**되어야 한다(AC-013).
- DOM 쿼리는 `#sidebar-tree`로 스코프 제한된 `querySelectorAll('.tree-children')` 단일 호출.

### NFR-002 — 접근성

- 두 버튼은 `aria-label` 및 `title` 속성을 보유한다.
- 버튼 비활성 상태는 `disabled` 속성으로 명시된다(별도 `aria-disabled` 중복 불필요).
- 탭 포커스 순서는 기존 헤더 버튼 다음으로 자연 배치된다.

### NFR-003 — 일관성

- 버튼 스타일은 `#btn-sidebar-search`, `#btn-sidebar-name-toggle`과 시각적으로 동등한 크기·여백을 가진다.
- SVG 아이콘은 `viewer.html`의 FAB 버튼들이 사용하는 `viewBox`·`stroke` 패턴을 따른다(예: `<line>`/`<polyline>` 요소).

### NFR-004 — 보안

- 순수 렌더러 측 DOM 조작으로 구현한다. IPC 채널 추가 없음, `contextBridge` 확장 없음.
- DOMPurify 영향 없음(트리는 sanitization 대상 아님).

### NFR-005 — 상태 수명

- 접기/펼치기 상태는 **세션 내에서만** 유지된다. 파일 전환 시 `_startSidebarTreeLoad`가 호출되어 트리가 재렌더되면 초기 기본 상태(모두 펼침)로 복원된다. `electron-store` 저장 없음.

---

## 4. 데이터 요구사항

### 4.1 런타임 상태 (메모리)

- **소스**: 기존 `window.DocuLight.state.sidebarTree` (변경 없음).
- **신규 런타임 상태**: 없음. 버튼 disabled 상태는 기존 상태 3종(`_currentTreeLoadId`, 검색 모드 active, tree 존재 여부)의 파생값으로 계산.

### 4.2 DOM 상태

- 접힘/펼침 상태는 `.tree-children` 엘리먼트의 `style.display` 인라인 속성에 저장(기존 패턴 그대로 재사용).

### 4.3 영속 저장소

- 없음(NFR-005 참조).

---

## 5. 인터페이스 요구사항

### 5.1 DOM 인터페이스

`viewer.html` 수정:

```html
<div id="sidebar-header">
  <span data-i18n="viewer.navigation">Navigation</span>
  <button id="btn-sidebar-name-toggle" ...>🏷️</button>
  <button id="btn-sidebar-search" ...>🔍</button>
  <button id="btn-sidebar-collapse-all"
          aria-label="Collapse all"
          data-i18n-aria-label="sidebar.collapseAll"
          data-i18n-title="sidebar.collapseAllTitle"
          title="모두 접기"
          disabled>
    <svg viewBox="0 0 24 24" width="14" height="14">
      <!-- ∨∧ 세로 배치 chevron (중앙으로 모임 = 접기) -->
      <!-- 상단 v: 양끝 y=5 → 중앙 y=9 (중앙이 아래) -->
      <polyline points="6 5 12 9 18 5" fill="none" stroke="currentColor" stroke-width="2"/>
      <!-- 하단 ^: 양끝 y=19 → 중앙 y=15 (중앙이 위) -->
      <polyline points="6 19 12 15 18 19" fill="none" stroke="currentColor" stroke-width="2"/>
    </svg>
  </button>
  <button id="btn-sidebar-expand-all"
          aria-label="Expand all"
          data-i18n-aria-label="sidebar.expandAll"
          data-i18n-title="sidebar.expandAllTitle"
          title="모두 펼치기"
          disabled>
    <svg viewBox="0 0 24 24" width="14" height="14">
      <!-- ∧∨ 세로 배치 chevron (바깥으로 벌어짐 = 펼치기) -->
      <!-- 상단 ^: 양끝 y=9 → 중앙 y=5 (중앙이 위) -->
      <polyline points="6 9 12 5 18 9" fill="none" stroke="currentColor" stroke-width="2"/>
      <!-- 하단 v: 양끝 y=15 → 중앙 y=19 (중앙이 아래) -->
      <polyline points="6 15 12 19 18 15" fill="none" stroke="currentColor" stroke-width="2"/>
    </svg>
  </button>
</div>
```

### 5.2 JS 인터페이스 (렌더러 내부)

```js
// viewer.js (신규 함수 추가)
function collapseAllSidebarDirs() { /* FR-001 로직 */ }
function expandAllSidebarDirs()   { /* FR-002 로직 */ }
function updateSidebarToggleButtons() {
  // FR-003/004/005 — 상태 변경 시 호출되는 단일 진입점
}
```

- `updateSidebarToggleButtons()`는 다음 시점에서 호출된다:
  - `onSidebarTreeStart/Done/Error` 핸들러 내부
  - `doculight:searchmode` 이벤트 리스너 내부
  - 초기화(`cleanups.push` 구역) 직후

### 5.3 IPC 인터페이스

- **변경 없음.** 본 기능은 순수 렌더러 측 기능이며 IPC 추가·변경이 없다.

---

## 6. 제약사항

### 6.1 기술 스택

- Electron 33.4.x, Vanilla JS 렌더러(모듈 번들러 없음), CSP 준수.
- 기존 `viewer.js` IIFE 패턴 내부에 구현.

### 6.2 아키텍처 결정

- **ADR-1**: 순수 DOM 조작 방식 선택. 이유: 트리 렌더링이 이미 직접 DOM 빌드 기반이며, 가상 상태 동기화 복잡성을 피한다.
- **ADR-2**: SVG 아이콘 채택(이모지 대신). 이유: 플랫폼별 이모지 렌더링 차이 회피 + 기존 FAB 버튼과 시각 언어 일관성.
- **ADR-3**: 접힘 상태 영속 저장 미도입. 이유: 파일 전환 시 트리가 재렌더되어 저장된 상태가 자연 무효화되며, 저장 키 설계 복잡도가 이 기능 가치 대비 과함.
- **ADR-4**: 가상 디렉토리(`__external_links__`) 포함. 이유: 사용자에게 보이는 모든 접힘 가능 노드를 일관 처리.

### 6.3 코드 작성 제약

- `renderTreeNode`/`buildSidebarNodeElement`의 기존 동작을 변경하지 않는다.
- `sidebar-search.js`에 새 DOM 핸들러를 주입하지 않는다(이벤트 리스너만 추가).
- step28의 `_currentTreeLoadId` 상태와 경합하지 않도록 `updateSidebarToggleButtons()`는 기존 Phase 2 IPC 리스너 내부에서 호출.

---

## 7. 인수 조건

### AC-001 — 기본 동작

- **Given**: 3단계 중첩 디렉토리를 포함한 폴더의 `.md` 파일이 열려있다.
- **When**: 사용자가 "모두 접기" 버튼을 클릭한다.
- **Then**: 최상위·중간·말단 모든 디렉토리의 `.tree-children`이 `display:none`이고 모든 디렉토리 `.tree-toggle`이 `▶`로 표시된다.

### AC-002 — 펼치기 동작

- **Given**: 모든 디렉토리가 접힌 상태이다.
- **When**: 사용자가 "모두 펼치기" 버튼을 클릭한다.
- **Then**: 모든 디렉토리가 펼쳐지고 `.tree-toggle`이 `▼`로 표시된다.

### AC-003 — 혼합 상태 해소

- **Given**: 디렉토리 일부만 펼쳐진 혼합 상태이다.
- **When**: 사용자가 "모두 접기" 또는 "모두 펼치기" 버튼을 클릭한다.
- **Then**: 1회 클릭으로 전체가 요청한 상태로 정렬된다.

### AC-004 — 검색 모드 비활성화

- **Given**: 검색 패널(`Ctrl+Shift+F`)이 활성화되었다.
- **When**: 사용자가 두 버튼에 접근하려 한다.
- **Then**: 두 버튼이 `disabled` 상태이며 클릭해도 반응이 없다.
- **And**: 검색 패널을 닫으면 버튼이 다시 활성화된다(트리 존재 조건 충족 시).

### AC-005 — 로딩 중 비활성화

- **Given**: 대용량 폴더의 배치 스트리밍 로딩이 진행 중이고 스피너가 표시된다.
- **When**: 버튼 상태를 확인한다.
- **Then**: 두 버튼이 `disabled` 상태이며, `sidebar-tree-done` 수신 직후 활성화된다.

### AC-006 — 트리 부재 비활성화

- **Given**: 어떤 파일도 열려있지 않아 사이드바가 숨겨진 상태이거나 트리가 비어있다.
- **When**: 버튼 상태를 확인한다.
- **Then**: 두 버튼이 `disabled` 상태다.

### AC-007 — 가상 디렉토리 포함

- **Given**: 트리에 `__external_links__` 가상 디렉토리가 존재한다.
- **When**: 사용자가 "모두 접기"를 클릭한다.
- **Then**: 가상 디렉토리의 `.tree-children`도 함께 접힌다.

### AC-008 — 세션 내 유지·재렌더 시 초기화

- **Given**: 모든 디렉토리를 접은 상태다.
- **When**: 다른 `.md` 파일을 열어 트리가 재렌더된다(`_startSidebarTreeLoad` 경유).
- **Then**: 새로 렌더된 트리는 기본 펼침 상태로 표시된다(이전 접힘 상태 영속 없음).

### AC-009 — i18n

- **Given**: 로케일을 각각 ko/en/ja/es로 설정한다.
- **When**: 두 버튼에 마우스를 올리거나 스크린 리더로 접근한다.
- **Then**: 해당 로케일의 `aria-label`/`title` 텍스트가 노출된다.

### AC-010 — 성능

- **Given**: 500개 파일 + 20개 디렉토리 트리가 렌더된 상태이다.
- **When**: "모두 접기" 또는 "모두 펼치기"를 클릭한다.
- **Then**: 연산 완료까지 50ms 이내(`performance.now()` 측정).

### AC-011 — 접근성

- **Given**: 키보드 탭 이동으로 버튼에 포커스한다.
- **When**: 스크린 리더로 버튼을 읽는다.
- **Then**: `aria-label` 문자열이 정확히 낭독된다. `disabled` 상태는 스크린 리더가 비활성으로 안내한다.

### AC-012 — 복합 상태 우선순위 (검색 + 로딩)

- **Given**: 사이드바 트리가 로딩 중이고 동시에 검색 패널이 활성화된다.
- **When**: `sidebar-tree-done` 이벤트가 수신된다(로딩 완료).
- **Then**: 검색 모드가 활성이므로 두 버튼은 여전히 `disabled` 상태를 유지한다.
- **우선순위 규칙**: `updateSidebarToggleButtons()` 내부에서 `disabled = 검색 모드 || 로딩 중 || 트리 부재`로 평가한다(OR 논리).

### AC-013 — 최악 성능 상한

- **Given**: 트리 노드 수가 `MAX_TREE_FILES=65535`에 근접한다(대용량 폴더).
- **When**: "모두 접기" 또는 "모두 펼치기"를 클릭한다.
- **Then**: 연산 완료까지 200ms 이내(`performance.now()` 측정). 200ms 초과 시 NFR 위반으로 간주.

---

## 후속 파이프라인

- 다음 단계: `snoworca-tiny-implementation-planner` 또는 `snoworca-implementation-planner`
- 입력 인자:
  - SPEC_PATH: `docs/srs/step29.srs.사이드바트리전체열고닫기.2026-04-17.md`
  - CODE_PATH: `src/renderer/`
  - LANGUAGE: JavaScript (Vanilla, IIFE 패턴)
  - FRAMEWORK: Electron 33.4.x 렌더러

## 변경 예상 파일

| 파일 | 변경 유형 | 주요 작업 |
|------|----------|---------|
| `src/renderer/viewer.html` | 수정 | 버튼 2개 추가 (`btn-sidebar-collapse-all`, `btn-sidebar-expand-all`) + SVG 아이콘 |
| `src/renderer/viewer.css` | 수정 | 신규 버튼 스타일 또는 기존 버튼 스타일 공유 선택자 확장 |
| `src/renderer/viewer.js` | 수정 | `collapseAllSidebarDirs`, `expandAllSidebarDirs`, `updateSidebarToggleButtons` 함수 추가 + 기존 IPC 리스너·searchmode 이벤트 리스너에서 호출 |
| `src/renderer/sidebar-search.js` | 변경 없음 | 기존 `doculight:searchmode` 이벤트 디스패치만 재사용 |
| `src/locales/ko.json` | 수정 | `sidebar.collapseAll`, `sidebar.expandAll`, `...Title` 키 추가 |
| `src/locales/en.json` | 수정 | 동일 |
| `src/locales/ja.json` | 수정 | 동일 |
| `src/locales/es.json` | 수정 | 동일 |
