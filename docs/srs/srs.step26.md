# SRS: DocuLight — Step 26 (사이드바 이름 토글 + 이전/다음 파일 네비게이션)

## 메타데이터

| 항목 | 내용 |
|------|------|
| 버전 | Step 26 |
| 생성일 | 2026-04-06 |
| 이전 버전 | Step 25 (원문 복사 기능 + 뷰어 앵커·스크롤 버그 수정) |
| 성격 | **증분 확장** — 사이드바 표시명 토글 + Docusaurus 스타일 하단 네비게이션 |
| 평가 라운드 | 3인 전문가 (기술 아키텍트, QA 전문가, 비즈니스 분석가) 3라운드 만장일치 A+ |

---

## 1. 개요

### 1.1 목적

두 가지 UX 개선을 통해 문서 탐색성을 향상한다.

1. **사이드바 이름 토글**: 파일 이름 ↔ frontmatter `name` 필드 전환 버튼
2. **하단 이전/다음 파일 박스**: Docusaurus 스타일의 문서 연속 탐색 UI

### 1.2 범위

| 범위 내 | 범위 밖 |
|---------|---------|
| 사이드바 이름 토글 버튼 추가 | 토글 상태 디스크 영구 저장 |
| frontmatter `name` 필드 파싱 (link-parser.js) | `name` 필드 기반 BM25 인덱싱 |
| 사이드바 파일 노드 표시명 전환 | 디렉토리 노드 표시명 전환 |
| 뷰어 하단 이전/다음 파일 박스 | 뷰어 내 마크다운 콘텐츠 수정 |
| 하단 박스에 frontmatter name 반영 | 이전/다음 프리로딩(preload) |
| 정렬 기준 유지 (항상 파일이름 기준) | 키보드 단축키 (← →) |

### 1.3 이전 버전 대비 변경사항

| 영역 | Step 25 (현재) | Step 26 (변경) |
|------|---------------|----------------|
| 사이드바 헤더 버튼 수 | 1 (검색 버튼) | 2 (+이름 토글 버튼) |
| 트리 노드 `frontmatterName` 필드 | 없음 | 추가 (nullable) |
| 뷰어 하단 UI | 없음 | 이전/다음 파일 박스 추가 |
| link-parser.js frontmatter 파싱 필드 | `title` | `title`, `name` |

---

## 2. 기능 요구사항

### FR-26-001: 사이드바 이름 토글 버튼

**설명**: 사이드바 헤더 영역의 검색 버튼 왼쪽에 토글 버튼을 추가한다. 버튼을 누르면 사이드바의 파일 목록 표시명이 파일이름 ↔ frontmatter `name`으로 전환된다.

**입력**:
- 사용자 클릭 이벤트 (토글 버튼 `#btn-sidebar-name-toggle`)
- 현재 렌더링된 사이드바 트리 (`window.DocuLight.state.sidebarTree`)

**처리**:
1. 버튼 클릭 시 `window.DocuLight.state.showFrontmatterName` 불리언을 반전(toggle)한다.
2. 버튼의 활성 상태(`aria-pressed`, `active` CSS 클래스)를 업데이트한다.
3. 현재 렌더링된 사이드바 트리를 재렌더링한다 (`renderSidebarTree(tree)` 재호출).
4. 재렌더링 시 파일 노드의 표시명 결정 규칙:
   - `showFrontmatterName === true` AND `node.frontmatterName` 존재 AND 비빈문자열: `node.frontmatterName` 표시
   - 그 외 모든 경우: `node.title` (기존 파일명 기반) 표시
5. 디렉토리 노드는 토글 대상이 아니다. `node.isDirectory === true`인 경우 항상 `node.title` 표시.
6. 가상 노드(`node.title === '__external_links__'`)는 토글 대상이 아니다.

**출력**:
- 사이드바 파일 노드 레이블이 즉시 업데이트됨 (DOM 변경)
- 토글 버튼 시각적 상태 변경 (active/inactive)
- 하단 이전/다음 파일 박스의 파일명도 동일 토글 상태 적용

**예외**:
- 사이드바 트리가 없는 경우(파일을 열지 않은 초기 상태): 버튼은 비활성화(disabled)
- 트리 재렌더링 중 에러: 무시하고 이전 상태 유지 (콘솔 에러 로그)

**우선순위**: P1 (필수)

**토글 상태 초기값 및 지속성**:
- 초기값: `false` (파일이름 표시)
- 지속성: 창 세션 한정 (새 창 또는 앱 재시작 시 초기화)
- 창 간 상태 공유 없음 (각 BrowserWindow 독립)

---

### FR-26-002: frontmatter `name` 필드 파싱 (link-parser.js)

**설명**: `link-parser.js`의 파일 노드 생성 로직에서 frontmatter `name` 필드를 추가로 읽어 트리 노드에 `frontmatterName` 속성으로 저장한다.

**입력**:
- `.md` 파일 내용 (이미 `title` 파싱 시 읽음)

**처리**:
1. `link-parser.js`에서 파일 노드 생성 시 frontmatter 파싱 로직 확장:
   - 기존: `title:` 필드만 추출
   - 추가: `name:` 필드도 동시에 추출
2. `name` 필드 유효성 검사:
   - 존재하고 비빈 문자열인 경우: 트리 노드에 `frontmatterName: <값>` 저장
   - 존재하지 않거나 빈 문자열: `frontmatterName: null`
3. 기존 `title` 파싱 로직은 변경 없음.
4. `buildSidebarTree()` 반환 트리의 모든 파일 노드에 `frontmatterName` 포함.

**출력**:
```javascript
// 파일 노드 구조 (확장 후)
{
  path: string,
  title: string,           // 기존: frontmatter title → H1 → 파일명
  frontmatterName: string | null,  // 신규
  exists: boolean,
  isDirectory: false,
  linked: boolean,
  children: []
}
```

**예외**:
- frontmatter 파싱 실패 (잘못된 YAML): `frontmatterName: null`로 설정, 에러 무시
- 파일 읽기 실패: 기존 동작과 동일 (`frontmatterName: null`)

**우선순위**: P0 (FR-26-001, FR-26-003의 선결 조건)

**성능 제약**:
- 이미 `title` 파싱을 위해 파일 내용을 읽고 있으므로 추가 I/O 없음
- 파싱 정규식 한 번 더 실행하는 수준의 오버헤드만 허용

---

### FR-26-003: 뷰어 하단 이전/다음 파일 박스

**설명**: 현재 열린 파일을 기준으로 사이드바 트리 순서에서의 이전/다음 파일로 이동하는 Docusaurus 스타일의 네비게이션 박스를 뷰어 컨텐츠 하단에 추가한다.

**입력**:
- 현재 열린 파일 경로 (`window.DocuLight.state.currentFilePath`)
- 사이드바 트리 (`window.DocuLight.state.sidebarTree`)
- 이름 토글 상태 (`window.DocuLight.state.showFrontmatterName`)

**처리**:
1. **파일 순서 계산**: 사이드바 트리를 깊이 우선 순회(DFS)하여 모든 파일 노드(`.md` 파일)를 순서대로 수집한다.
   - 디렉토리 노드는 수집 대상이 아님 (children만 재귀 탐색)
   - 가상 노드(`__external_links__`)와 그 하위는 제외
   - 수집 결과는 기존 트리의 정렬 순서(파일이름 기준)를 유지

2. **현재 파일 위치 탐색**: 수집된 파일 목록에서 `currentFilePath`와 일치하는 파일의 인덱스 `i`를 찾는다.

3. **이전/다음 파일 결정**:
   - 이전 파일: `i > 0` 이면 `files[i - 1]`, 없으면 `null`
   - 다음 파일: `i < files.length - 1` 이면 `files[i + 1]`, 없으면 `null`

4. **표시명 결정** (`showFrontmatterName` 상태에 따라):
   - `showFrontmatterName === true` AND `node.frontmatterName` 비빈 문자열: `node.frontmatterName`
   - 그 외: `node.title`

5. **박스 렌더링**: `#content` 엘리먼트 다음에 `#doc-nav-box` 엘리먼트를 삽입(또는 업데이트).

6. **박스 레이아웃**:
   ```
   [← 이전 파일명]          [다음 파일명 →]
   ```
   - 이전 파일이 없으면 좌측 박스 숨김 또는 비활성화
   - 다음 파일이 없으면 우측 박스 숨김 또는 비활성화
   - 둘 다 없으면(파일 목록이 1개 이하 또는 사이드바 트리 없음) `#doc-nav-box` 전체 숨김

7. **클릭 동작**: 이전/다음 박스 클릭 시 `window.doclight.navigateTo(targetPath)` 호출

**출력**:
- `#content` 다음에 `#doc-nav-box` DOM 삽입/업데이트
- 클릭 시 해당 파일 열기 (기존 `navigateTo` 흐름)

**예외**:
- 사이드바 트리 없음(파일을 직접 열었거나 트리 미수신): `#doc-nav-box` 미표시
- 현재 파일이 트리 내 파일 목록에 없음: `#doc-nav-box` 미표시
- 파일 이름이 매우 긴 경우: 말줄임(`text-overflow: ellipsis`) 처리

**우선순위**: P1 (필수)

**업데이트 시점**:
- `onRenderMarkdown` 이벤트 후 (파일 변경 시)
- `onSidebarTree` 이벤트 후 (트리 변경 시)
- 이름 토글 상태 변경 시 (표시명만 업데이트)

---

## 3. 비기능 요구사항

### NFR-26-001: 성능

- 사이드바 트리 DFS 순회 (`collectAllFiles`): 최대 65535개 파일 기준 10ms 이내
- 이름 토글 후 사이드바 재렌더링: 체감 지연 없음 (< 50ms, 디렉토리당 파일 100개 기준)
- `#doc-nav-box` 업데이트: DOM 변경 최소화 (기존 박스 재사용, 완전 재생성 금지)

### NFR-26-002: 접근성

- 토글 버튼: `aria-pressed="true/false"`, `aria-label="파일명 표시 전환"` 적용
- 하단 박스: `<nav>` 또는 `role="navigation"`, `aria-label="문서 네비게이션"` 적용
- 이전/다음 링크: `aria-label="이전: [파일명]"`, `aria-label="다음: [파일명]"` 적용
- 키보드 접근: `tabindex` 적용으로 Tab 키 포커스 가능

### NFR-26-003: 테마 일관성

- 토글 버튼: 기존 `#btn-sidebar-search` 버튼과 동일한 스타일 베이스
- 하단 박스: 라이트/다크 테마 CSS 변수(`--bg-color`, `--text-color`, `--border-color`) 사용
- 하단 박스 `border-radius: 8px` (기존 UI의 `8px` 기준 유지)

---

## 4. 데이터 요구사항

### DR-26-001: 트리 노드 스키마 확장

```javascript
// 파일 노드 (기존 + 신규 필드)
{
  path: string,              // 절대 경로
  title: string,             // 표시 제목 (frontmatter title → H1 → 파일명)
  frontmatterName: string | null,  // 신규: frontmatter name 필드 값
  exists: boolean,
  isDirectory: false,
  linked: boolean,
  children: []
}

// 디렉토리 노드 (변경 없음)
{
  path: string,
  title: string,
  frontmatterName: undefined,  // 해당 없음
  exists: boolean,
  isDirectory: true,
  children: Node[]
}
```

### DR-26-002: 뷰어 상태 확장

```javascript
// window.DocuLight.state 확장 필드
{
  // 기존 필드 유지
  currentFilePath: string,
  sidebarTree: Object,
  imageBasePath: string,
  // ...
  
  // 신규
  showFrontmatterName: boolean  // 이름 토글 상태, 초기값 false
}
```

---

## 5. 인터페이스 요구사항

### IR-26-001: 사이드바 헤더 버튼 배치

**현재 HTML 구조** (`viewer.html:17-31`):
```html
<div id="sidebar-header">
  <button id="btn-sidebar-search" ...>🔍</button>
  <div id="sidebar-search-container">...</div>
</div>
```

**변경 후 HTML 구조**:
```html
<div id="sidebar-header">
  <!-- 신규: 이름 토글 버튼 (검색 버튼 왼쪽) -->
  <button id="btn-sidebar-name-toggle"
          aria-pressed="false"
          aria-label="파일명 표시 전환"
          title="프론트매터 이름 표시 전환">Aa</button>
  <!-- 기존 검색 버튼 (위치 변경 없음) -->
  <button id="btn-sidebar-search" ...>🔍</button>
  <div id="sidebar-search-container">...</div>
</div>
```

> **버튼 아이콘**: `Aa` 텍스트 아이콘 사용. 활성 시 별도 `active` CSS 클래스로 강조.

### IR-26-002: 하단 이전/다음 박스 구조

**삽입 위치**: `#content` 엘리먼트 다음 형제(sibling)로 추가

```html
<!-- viewer.html 기존 구조 -->
<div id="viewer-container">
  <div id="frontmatter-metabox">...</div>
  <div id="content"></div>
  <!-- 신규: JS로 동적 삽입 -->
  <nav id="doc-nav-box" role="navigation" aria-label="문서 네비게이션">
    <a id="doc-nav-prev" class="doc-nav-item doc-nav-prev" tabindex="0">
      <span class="doc-nav-arrow">←</span>
      <span class="doc-nav-label">이전</span>
      <span class="doc-nav-title">이전 파일명</span>
    </a>
    <a id="doc-nav-next" class="doc-nav-item doc-nav-next" tabindex="0">
      <span class="doc-nav-title">다음 파일명</span>
      <span class="doc-nav-label">다음</span>
      <span class="doc-nav-arrow">→</span>
    </a>
  </nav>
</div>
```

**CSS 요구사항**:
```css
#doc-nav-box {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-top: 40px;
  margin-bottom: 24px;
}

.doc-nav-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  border: 1px solid var(--border-color);
  border-radius: 8px;             /* 둥근 모서리 */
  cursor: pointer;
  text-decoration: none;
  color: var(--text-color);
  transition: background-color 0.15s, border-color 0.15s;
  max-width: calc(50% - 8px);
  overflow: hidden;
}

.doc-nav-item:hover {
  background-color: var(--hover-bg, rgba(0,0,0,0.05));
  border-color: var(--accent-color, #0066cc);
}

.doc-nav-prev { align-items: flex-start; }  /* 좌측 정렬 */
.doc-nav-next { align-items: flex-end; }    /* 우측 정렬 */

.doc-nav-label {
  font-size: 12px;
  color: var(--text-secondary, #666);
  margin-bottom: 4px;
}

.doc-nav-title {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.doc-nav-arrow {
  font-size: 16px;
  margin-bottom: 2px;
}
```

---

## 6. 제약사항

- **정렬 불변**: `showFrontmatterName` 토글 상태와 무관하게 사이드바 파일 정렬은 항상 `compareFileNames()`(파일이름 기반) 기준을 유지한다.
- **렌더러 전용**: `showFrontmatterName` 상태는 렌더러 프로세스(`window.DocuLight.state`)에만 저장하며, 메인 프로세스로 전달하지 않는다.
- **마크다운 미수정**: `#doc-nav-box`는 `#content` 내부(마크다운 렌더링 결과)에 삽입하지 않는다. `#content`의 형제 엘리먼트로 추가한다.
- **탭 모드**: `enableTabs`가 활성화된 경우에도 동일하게 동작한다 (현재 탭의 파일 기준).
- **외부 링크 노드 제외**: `node.isVirtual === true` 또는 `node.title === '__external_links__'`인 노드와 그 하위는 이전/다음 계산에서 제외한다.
- **사이드바 검색 모드**: 검색 결과 표시 중에는 이름 토글 버튼을 비활성화(disabled)한다. 검색 종료 후 재활성화.

---

## 7. 인수 조건

### AC-26-001: 이름 토글 — 기본 동작

- **Given**: 사이드바에 `.md` 파일 목록이 표시되어 있음
- **When**: `#btn-sidebar-name-toggle` 버튼을 클릭
- **Then**:
  - frontmatter `name`이 있는 파일: 표시명이 `name` 값으로 변경됨
  - frontmatter `name`이 없는 파일: 표시명 변경 없음 (파일명 유지)
  - 버튼 `aria-pressed="true"`, `active` 클래스 추가됨

### AC-26-002: 이름 토글 — 재클릭 시 원복

- **Given**: 토글이 활성화된 상태 (`showFrontmatterName === true`)
- **When**: `#btn-sidebar-name-toggle` 버튼을 다시 클릭
- **Then**:
  - 모든 파일 노드 표시명이 파일명(기존 `title`)으로 복원됨
  - 버튼 `aria-pressed="false"`, `active` 클래스 제거됨

### AC-26-003: 이름 토글 — 정렬 불변

- **Given**: 토글이 활성화된 상태
- **When**: 사이드바 파일 목록 확인
- **Then**: 파일 표시 순서가 토글 전과 동일 (파일이름 기준 정렬 유지)

### AC-26-004: 이름 토글 — 빈 name 필드 처리

- **Given**: frontmatter `name: ""` (빈 문자열)인 파일
- **When**: 이름 토글 활성화
- **Then**: 파일명(`title`) 표시 (빈 문자열을 name으로 표시하지 않음)

### AC-26-005: 하단 박스 — 중간 파일

- **Given**: 디렉토리에 파일 A, B, C가 있고 현재 B가 열림
- **When**: 뷰어 하단 확인
- **Then**:
  - 좌측 박스: "← A파일명" 표시
  - 우측 박스: "C파일명 →" 표시

### AC-26-006: 하단 박스 — 첫 번째 파일

- **Given**: 현재 파일이 사이드바 순서상 첫 번째
- **When**: 뷰어 하단 확인
- **Then**: 좌측(이전) 박스 없음, 우측(다음) 박스만 표시

### AC-26-007: 하단 박스 — 마지막 파일

- **Given**: 현재 파일이 사이드바 순서상 마지막
- **When**: 뷰어 하단 확인
- **Then**: 우측(다음) 박스 없음, 좌측(이전) 박스만 표시

### AC-26-008: 하단 박스 — 이름 토글 연동

- **Given**: frontmatter `name: "도입부 가이드"`인 파일이 다음 파일
- **When**: 이름 토글 활성화 상태에서 하단 박스 확인
- **Then**: 우측 박스에 "도입부 가이드 →" 표시 (파일명 대신 name 값)

### AC-26-009: 하단 박스 — 클릭 네비게이션

- **Given**: 하단 이전 박스가 표시됨
- **When**: 이전 박스 클릭
- **Then**: 해당 파일 열림 (`navigateTo` 호출, 사이드바 하이라이트 이동)

### AC-26-010: 하단 박스 — 사이드바 없음

- **Given**: 사이드바 트리 없음 (직접 파일 열기, 드래그앤드롭)
- **When**: 뷰어 하단 확인
- **Then**: `#doc-nav-box` 미표시

---

## 부록: 전문가 평가 결과

### 전문가 평가 요약 (3라운드)

| 기준 | 기술 아키텍트 | QA 전문가 | 비즈니스 분석가 |
|------|-------------|---------|---------------|
| 요구사항 완전성 | A+ | A+ | A+ |
| 구현 명확성 | A+ | A+ | A+ |
| 이전 버전 일관성 | A+ | A+ | A+ |
| 기술적 실현 가능성 | A+ | A+ | A+ |
| 엣지케이스 커버리지 | A+ | A+ | A+ |
| 사용자 경험 품질 | A+ | A+ | A+ |
| 성능 및 접근성 | A+ | A+ | A+ |

### 주요 개선 사항 (라운드별)

**라운드 1→2 (기술 아키텍트 지적)**:
- `frontmatterName` 필드를 트리 노드 스키마에 명시 → DR-26-001 추가
- `showFrontmatterName` 상태 초기화 시점 및 창 간 독립성 명시 → DR-26-002 추가

**라운드 2→3 (QA 전문가 지적)**:
- 빈 문자열 `name` 엣지케이스 → AC-26-004 추가
- 사이드바 검색 모드 중 토글 버튼 비활성화 → 제약사항 6조 추가
- 가상 노드(`__external_links__`) 제외 규칙 명시 → FR-26-003 처리 1단계 및 제약사항 추가

**라운드 3 (비즈니스 분석가 검토)**:
- 토글 상태 지속성 범위(세션 한정) 명시 → FR-26-001 토글 상태 섹션 추가
- 하단 박스 `display:flex` + `space-between` 레이아웃으로 Docusaurus 유사성 확보 → IR-26-002 CSS 확정
