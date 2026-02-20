# 통합 테스트 가이드: DocLight Step 18

## 핵심 목적

DocLight Markdown 뷰어에 추가된 7개 신규 기능이 기존 기능 및 서로 간에 올바르게 작동하는지 검증한다.

## E2E 시나리오

### Scenario 1: 핵심 비즈니스 플로우 (CRITICAL)

```
Given: DocLight 앱이 시작되고, autoRefresh: true, enableTabs: true 설정
When:
  1. 사이드바에서 README.md 클릭 → 탭 1 생성
  2. 사이드바에서 guide.md 클릭 → 탭 2 생성
  3. 탭 1 클릭 (README.md)
  4. 외부 에디터에서 README.md 수정 후 저장
  5. PDF FAB 클릭 → "현재 파일" → A4 → Save
Then:
  - Step 2: 탭 바에 2개 탭 표시
  - Step 3: 탭 1 활성, README.md 내용 표시
  - Step 4: 300ms 후 자동 새로고침, 스크롤 위치 보존
  - Step 5: README.pdf 생성 (파일 크기 > 0)
```

### Scenario 2: 대안 플로우 — 탭 비활성화 (HIGH)

```
Given: enableTabs: false, autoRefresh: true
When:
  1. 파일 열기 → 사이드바 표시
  2. Ctrl+Shift+F → 검색 모드 → "api" 입력
  3. 검색 결과 클릭
  4. PDF FAB → "사이드바 전체" → Save
Then:
  - Step 2: 파일 필터링, 하이라이트
  - Step 3: navigateTo 동작 (탭 생성 없이 페이지 교체)
  - Step 4: 사이드바 전체 PDF 배치 내보내기
```

### Scenario 3: 예외 플로우 — 파일 삭제 및 복구 (HIGH)

```
Given: README.md가 열려 있고 파일 감시 중
When:
  1. 외부에서 README.md 삭제
  2. 트레이 → 최근 문서 → README.md 클릭
  3. 외부에서 README.md 재생성
Then:
  - Step 1: watcher 해제, 기존 렌더링 유지, 콘솔 에러
  - Step 2: 파일 미존재 → 목록에서 자동 제거
  - Step 3: (기존 뷰어에 영향 없음, 새 창에서 열어야 반영)
```

### Scenario 4: 경계값 — 최대 리소스 사용 (MEDIUM)

```
Given: enableTabs: true
When:
  1. 20개 탭 생성
  2. 21번째 파일 클릭
  3. 1번 탭 닫기
  4. 새 파일 클릭
Then:
  - Step 2: 토스트 메시지 "최대 탭 수(20)에 도달했습니다"
  - Step 3: 19개 탭 잔여
  - Step 4: 새 탭 정상 생성 (20개)
```

## 컴포넌트 통합 매트릭스

| | File Watcher | Port Disc. | PDF Export | Sidebar Search | Recent Files | Tabs | Image Resolver |
|-|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **index.js** | ● | ● | ● | | ● | ● | |
| **window-manager.js** | ● | | ● | | ● | | ● |
| **mcp-http.mjs** | | ● | | | | | |
| **preload.js** | | | ● | | | ● | |
| **viewer.js** | ● | | | | | ● | ● |
| **image-resolver.js** | | | | | | | ● |
| **sidebar-search.js** | | | | ● | | | |
| **pdf-export-ui.js** | | | ● | | | | |
| **tab-manager.js** | | | | | | ● | |

## 요구사항 추적 매트릭스

| 요구사항 ID | 기능 | AC 번호 | 검증 시나리오 |
|------------|------|---------|-------------|
| FR-18-001 | 파일 감시 | AC-001-1~7 | Scenario 1 (Step 4), Scenario 3 |
| FR-18-002 | 포트 디스커버리 | AC-002-1~3 | 앱 시작/종료 확인 |
| FR-18-003 | PDF 내보내기 | AC-003-1~9 | Scenario 1 (Step 5), Scenario 2 (Step 4) |
| FR-18-004 | 사이드바 검색 | AC-004-1~6 | Scenario 2 (Step 2-3) |
| FR-18-005 | 최근 파일 | AC-005-1~8 | Scenario 3 (Step 2) |
| FR-18-006 | 탭 뷰 | AC-006-1~12 | Scenario 1 (Step 1-3), Scenario 4 |
| FR-18-007 | 이미지 경로 | AC-007-1~7 | 이미지 포함 문서 열기 |

## 단위 테스트 대상 함수

| 함수 | 모듈 | 테스트 파일 |
|------|------|-----------|
| `resolveRelativePath()` | image-resolver.js | `test/unit/image-resolver.test.js` |
| `isPathWithin()` | image-resolver.js | `test/unit/image-resolver.test.js` |
| `pathToFileUrl()` | image-resolver.js | `test/unit/image-resolver.test.js` |
| `collectMdPaths()` | window-manager.js | `test/unit/collect-md-paths.test.js` |
| `addRecentFile()` | index.js | 통합 테스트로 검증 |

## 테스트 환경

| 항목 | 요구사항 |
|------|---------|
| OS | Windows 11 (1차), macOS (선택), Linux (선택) |
| Node.js | >= 20.0.0 |
| Electron | >= 33.0.0 |
| 테스트 프레임워크 | Playwright (E2E), Node.js assert (단위) |
