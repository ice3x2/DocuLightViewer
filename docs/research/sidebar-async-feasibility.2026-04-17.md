# 파일 리스트 모드 비동기화 연구 보고서

**작성일**: 2026-04-17
**대상 프로젝트**: DocuLight Viewer
**조사 범위**: 사이드바 디렉토리 트리 초기 로딩 시 UI 프리징 해결 가능성

---

## 배경

Downloads 디렉토리처럼 MD 파일이 수천 개 있는 폴더를 열면, 파일 리스트 모드(사이드바 디렉토리 트리)가 동기 파일 I/O 때문에 몇 분간 UI 프리징을 일으킨다. 완전 비동기 처리 + 로딩 스피너(회색 원 3개 번갈아 커졌다 작아지는 애니메이션)로 UX를 개선할 수 있는지 연구한다.

---

## 1. 프리징 원인 가설

### 1.1 Main Process 측 병목 (주 원인)

**`src/main/link-parser.js` — `buildDirectoryTree()` (라인 57–119)**

- `fs.readdirSync()` (라인 64), `fs.readFileSync()` (라인 95) **동기 호출**
- 재귀 함수로 `MAX_DEPTH=10`, `MAX_TREE_FILES=65535` 상한 존재
- **하지만** 각 `.md` 파일마다 frontmatter 파싱을 위해 **전체 파일을 메모리에 로드**(라인 95–107)
- 수천 파일 × 동기 I/O → 이벤트 루프 블로킹 → **main process freeze**

**`src/main/index.js` — `read-file-for-tab` IPC 핸들러 (라인 1548–1591)**

- `buildSidebarTree(filePath)` 동기 호출
- `buildDirectoryTree()` → `buildLinkTree()` 체인이 완료될 때까지 IPC 응답 차단

### 1.2 Renderer Process 측 보조 병목

**`src/renderer/viewer.js` — `renderSidebarTree()` (라인 1739–1850)**

- main에서 받은 트리 데이터를 `renderTreeNode()` 재귀로 한 번에 DOM 생성
- 수만 노드 동기 생성 → DOM 리플로우/리페인트 누적 → **renderer UI freeze**

> **이중 프리징** 구조. main/renderer 양쪽 모두 개선 대상.

---

## 2. 비동기화 접근 방식 비교

### 옵션 A: `fs.promises` + 청크 스트리밍 *(권장)*

```text
main(async scan) ──batch(50 files)──▶ IPC ──▶ renderer(incremental render)
```

| 항목 | 내용 |
|------|------|
| 방식 | `readdirSync` → `fs.promises.readdir`, 50파일 단위 배치로 frontmatter 비동기 파싱 |
| 피드백 | 각 배치 완료 시 `sidebar-tree-batch` IPC 이벤트로 부분 결과 전송 |
| UI | 스피너 + 점진적 DOM 추가 |
| 장점 | main 블로킹 제거, 진행률 시각화, 초기 1~2초 내 응답 |
| 단점 | preload 리스너 추가, 부분 트리에서 검색/필터 고려, 폴더 전환 시 취소 처리 필요 |

### 옵션 B: `worker_threads` 전용 스캔

| 항목 | 내용 |
|------|------|
| 방식 | `buildDirectoryTree()` 전체를 Worker에서 실행 |
| 장점 | main process 100% 반응성 유지 |
| 단점 | **진행률 없음** — 큰 폴더는 여전히 대기, UX 개선 제한 |

### 옵션 C: 상한 강화 + 경고

| 항목 | 내용 |
|------|------|
| 방식 | `MAX_TREE_FILES` 강화, "폴더가 너무 큼" 경고 |
| 장점 | 변경 최소 |
| 단점 | **근본 해결 아님** |

---

## 3. 로딩 스피너 삽입 위치

### 3.1 기존 자원

- `sidebar-search.js` 라인 269~277에 `showLoading()` 텍스트 기반 함수 존재
- CSS `.search-loading` (라인 654~659) — 패딩/중앙 정렬만 정의
- **재사용 가능**. 애니메이션만 추가하면 됨.

### 3.2 DOM 구조 (viewer.html 라인 36 근처)

```html
<div id="sidebar-tree"></div>
<!-- 로딩 시 내부 주입: -->
<div id="sidebar-loading-spinner">
  <div class="spinner-dots">
    <div class="spinner-dot"></div>
    <div class="spinner-dot"></div>
    <div class="spinner-dot"></div>
  </div>
</div>
```

### 3.3 CSS (viewer.css 라인 654 근처)

```css
#sidebar-loading-spinner {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  min-height: 100px;
}

.spinner-dots { display: inline-flex; gap: 6px; }

.spinner-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-muted, #888);
  animation: spinner-pulse 1.4s infinite ease-in-out;
}

.spinner-dot:nth-child(2) { animation-delay: 0.2s; }
.spinner-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes spinner-pulse {
  0%, 100% { transform: scale(0.6); opacity: 0.4; }
  50%      { transform: scale(1.2); opacity: 1; }
}
```

### 3.4 JS 통합

- `renderSidebarTree()` 진입 시 `showLoadingSpinner()` 호출
- 배치 수신 시 스피너 유지 + 부분 DOM 추가
- 완료 이벤트(`sidebar-tree-done`) 수신 시 `hideLoadingSpinner()`

---

## 4. 주요 난제

| 난제 | 상세 | 해결 방향 |
|------|------|-----------|
| 스캔 중 폴더 전환 | 로딩 중 다른 파일 열면 이전 결과가 섞일 수 있음 | `treeLoadId` + `AbortController` 도입, 배치에 ID 포함 |
| 캐시 부재 | 새로고침/탭 전환마다 재스캔 | `Map<rootPath, {tree, timestamp}>` 5분 TTL |
| 메모리 누적 | 65535 노드 × 다중 윈도우 | `MAX_TREE_FILES` 유지, JSON 압축 저장 검토 |
| frontmatter I/O 낭비 | `readFileSync` + regex 반복 | `Promise.all()` 5~10파일 동시 읽기 |
| buildLinkTree 순서 | 현재 순차 구조 | directoryTree 완성 → linkTree 병렬 가능성 검토 |
| renderer 증분 리페인트 | 대량 DOM 추가 | DocumentFragment 사용, 배치 단위 `appendChild` |

---

## 5. 권장 접근 및 구현 순서

### 5.1 권장: **옵션 A — fs.promises 청크 스트리밍**

**선정 이유:**

1. 구현 난이도 중간 — 동기 fs → async + IPC 채널 1개 추가
2. UX 즉각 개선 — 스피너 + 부분 트리로 "반응성 있어 보임"
3. 기존 인프라 활용 — preload 리스너 패턴 완비, showLoading/abortId 패턴 재사용
4. 취소 처리 용이 — abortId 패턴을 트리 로딩에도 확장 가능

### 5.2 구현 순서

1. `link-parser.js` — `buildDirectoryTree()` 비동기화 + 배치 콜백 인터페이스
2. `window-manager.js` — `buildSidebarTreeAsync()` + 배치 루프
3. `index.js` — IPC 핸들러 + `sidebar-tree-batch` / `sidebar-tree-done` 이벤트 전송
4. `preload.js` — `onSidebarTreeBatch()`, `onSidebarTreeDone()` 리스너
5. `viewer.js` — `renderSidebarTree()` 부분 업데이트 + 스피너 토글
6. `viewer.css` — 3점 스피너 애니메이션
7. `sidebar-search.js` — 로딩 스피너 통합, abortId ↔ treeLoadId 조율

### 5.3 기대 효과

| 항목 | 현재 | 개선 후 (예상) |
|------|------|----------------|
| 초기 UI 응답 | 수 분 freeze | **1~2초 내 스피너 + 부분 트리** |
| 전체 스캔 시간 | 동기 I/O 누적 | async 병렬로 20~40% 단축 |
| 폴더 전환 반응성 | 이전 스캔 완료까지 대기 | abort 신호로 즉시 전환 |
| 사용자 체감 | "멈춤" | "로딩 중" |

---

## 6. 선행 조건

- **step27 Phase 2 (`IMPL-001`)** — `link-parser.js` 전면 비동기 전환이 이미 계획됨. 본 계획은 이를 **선행 조건**으로 가정하고 **청크 스트리밍 + UI 레이어**만을 신규 도입한다.
