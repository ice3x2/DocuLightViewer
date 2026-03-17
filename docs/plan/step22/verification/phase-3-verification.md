# Phase 3 검증: 컨텍스트 메뉴 · 경로 복사

## 완료 체크리스트

| # | 항목 | 상태 | 비고 |
|---|------|------|------|
| 1 | `positionAndBindContextMenu()` 추출 | [ ] | |
| 2 | `showContextMenu()` 리팩터링 (추출 함수 사용) | [ ] | |
| 3 | `showSidebarContextMenu()` 구현 | [ ] | |
| 4 | `renderTreeNode()` contextmenu 리스너 | [ ] | |
| 5 | `show-in-explorer` 디렉토리 분기 | [ ] | |
| 6 | `getCopyablePath()` 함수 | [ ] | |
| 7 | `saveAsFilePath` 상태 변수 + handleSaveAs 수정 | [ ] | |
| 8 | 뷰어 Copy Path 조건 확장 | [ ] | |
| 9 | 뷰어 "저장" 메뉴 항목 (조건부) | [ ] | |
| 10 | Ctrl+Shift+C 단축키 | [ ] | |
| 11 | `.viewer-toast.error` CSS | [ ] | |
| 12 | i18n 키 2개 × 4 로케일 | [ ] | |

## 테스트 결과

| 테스트 | 결과 | 비고 |
|--------|------|------|
| TC-3-01: 사이드바 파일 경로 복사 | [ ] | |
| TC-3-02: 사이드바 디렉토리 탐색기 열기 | [ ] | |
| TC-3-03: 뷰어 Ctrl+Shift+C MCP 저장 | [ ] | |
| TC-3-04: 미저장 MCP Ctrl+Shift+C | [ ] | |
| TC-3-05: Save As 후 경로 복사 우선순위 | [ ] | |
| TC-3-06: node.exists === false 항목 | [ ] | |

## 회귀 테스트 결과

| 항목 | 결과 | 비고 |
|------|------|------|
| 기존 뷰어 컨텍스트 메뉴 | [ ] | |
| 기존 Copy Path (로컬 파일) | [ ] | |
| 기존 Show in Explorer (파일) | [ ] | |
| 사이드바 클릭 네비게이션 | [ ] | |

## 코드 리뷰

- [ ] `positionAndBindContextMenu()` 추출로 `showContextMenu()` 코드 줄 수 감소 확인
- [ ] 사이드바 메뉴가 기존 `.ctx-menu` CSS를 100% 재활용 확인
- [ ] `showFileInExplorer()` IPC 하나로 파일/디렉토리 모두 처리 확인 (별도 IPC 없음)
