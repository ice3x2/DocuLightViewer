# 완료 보고서 — step29 사이드바 트리 전체 접기/펼치기

**완료일**: 2026-04-17
**파이프라인**: snoworca-tiny-srs-incremental-qna → snoworca-tiny-implementation-planner → **snoworca-tiny-smart-coder**

## 요약

사이드바 헤더에 **모두 접기 / 모두 펼치기** 버튼 2개를 추가하여 사용자가 트리 구조의 모든 디렉토리를 한 번의 클릭으로 일괄 토글할 수 있도록 구현 완료.

## Phase 별 결과

| Phase | 심각도 판정 | 회귀 테스트 |
|-------|-----------|-----------|
| Phase 1: DOM · CSS · i18n 토대 | ZT PASS / CRITICAL 0 / HIGH 0 / MEDIUM 1→0 / LOW 8 | 4/4 PASS |
| Phase 2: JS 동작 로직 + 상태 통합 | ZT PASS / CRITICAL 0 / HIGH 0 / MEDIUM 0 / LOW 2 | 4/4 PASS |
| Phase 3: 테스트 + 회귀 | — (검증 단계) | 78/78 PASS |

## 핵심 구현 요소

### HTML (`viewer.html`)
- `#btn-sidebar-collapse-all`, `#btn-sidebar-expand-all` 2개 버튼
- 인라인 SVG chevron (∨∧ 접기 / ∧∨ 펼치기, SRS §5.1 좌표 엄수)
- `disabled` 기본값 + `data-i18n-*` 속성

### CSS (`viewer.css`)
- 기존 `#btn-sidebar-search`와 공통 그룹 셀렉터
- `hover:not(:disabled)`로 비활성 상태 hover 차단
- `:disabled` 상태 opacity 0.3 + cursor default

### JS (`viewer.js`)
- **3 함수**: `collapseAllSidebarDirs`, `expandAllSidebarDirs`, `updateSidebarToggleButtons`
- **6 경로 disabled 동기화**: 초기화 + searchmode 이벤트 + onSidebarTreeStart/Done/Error + onSidebarTree 호환 핸들러 양쪽 분기
- **OR 논리 우선순위** (AC-012): `검색모드 || 로딩 || 트리부재`
- **클릭 + disabled 방어**: HTML `disabled` + JS `if (btn.disabled) return;` 이중 안전
- **ADR-5 준수**: 기존 IPC 리스너 내부 주입, 별도 리스너 추가 없음
- **`window.DocuLight.fn`** 3 함수 export

### i18n (4 × 4 = 16 항목)
- `sidebar.collapseAll` / `sidebar.expandAll`
- `sidebar.collapseAllTitle` / `sidebar.expandAllTitle`
- ko / en / ja / es 동시 추가

## 테스트 결과

| 테스트 | 결과 |
|--------|------|
| test-link-tree | PASS |
| test-link-tree-build | 6/6 PASS |
| test-sidebar-tree | 9/9 PASS |
| test-batch-streaming | 8/8 PASS |
| test-link-extraction | 4/4 PASS |
| test-frontmatter | 51/51 PASS |
| **합계** | **78/78 PASS** |
| Mock 사용 regex | 0건 |
| i18n 키 유효성 | 16/16 PASS |
| node --check viewer.js | SYNTAX OK |

## 요구사항-코드 일치

- **ZERO TOLERANCE 게이트**: Phase 1, Phase 2 모두 PASS
- **스펙 대조**: FR-001 ~ FR-007 및 NFR-001 ~ NFR-005 모두 반영
- **QNA 확정사항**: Q1~Q9 AUTO 결과 모두 적용

## 변경 파일 수

- 렌더러: 3 파일 (viewer.html, viewer.css, viewer.js)
- 로케일: 4 파일 (ko/en/ja/es)
- 계획 문서: step29 디렉토리 전체 (신규)
- SRS/request: 2 파일 (신규)
- **총 9개 코드/로케일 파일 + 문서**

## 보류

- 수동 UI 체감 검증: DocuLight 실행 필요 (앱 종료 후 `npm start`)
- Playwright E2E 자동화: 선택사항, 시간 여유 시

## 다음 단계 권장

1. DocuLight 종료 후 `npm start`로 부팅하여 수동 AC-001~013 체크
2. 필요 시 `test/sidebar-toggle-all.e2e.js` 작성 → `npx playwright test`
3. 사용자 승인 후 커밋/릴리스 노트 작성
