# Step 22 최종 검증 보고서

## 요약

| 항목 | 내용 |
|------|------|
| 입력 문서 | `docs/plan/srs.step22.md` |
| 총 Phase | 4 |
| 변경 파일 | 10개 |
| 신규 함수 | 7개 |
| 재활용 함수 | 7개 |
| 신규 i18n 키 | ~8개 (기존 키 재활용으로 최소화) |

## 요구사항 추적 매트릭스

| 요구사항 ID | 설명 | Phase | 구현 상태 | 테스트 |
|------------|------|-------|----------|--------|
| FR-22-001 | MCP 저장 설정 재설계 | 1, 2 | [ ] | TC-1-01~06, TC-2-01~04 |
| FR-22-002 | 사이드바 컨텍스트 메뉴 | 3 | [ ] | TC-3-01~02, TC-3-06 |
| FR-22-003 | 뷰어 경로 복사 확장 | 3 | [ ] | TC-3-03~05 |
| FR-22-004 | MD 텍스트 붙여넣기 | 4 | [ ] | TC-4-01~07 |

## Phase별 완료 체크리스트

### Phase 1: MCP 저장 코어
- [ ] `resolveSubDir()` 구현 및 테스트
- [ ] `buildDestPath()` 공통 로직 추출
- [ ] `mcpManualSave()` 구현
- [ ] `handleMcpSave()` 구현 (buildSaveParams 재활용)
- [ ] Ctrl+S 단축키 등록
- [ ] `showViewerToast()` type 파라미터 확장
- [ ] i18n 키 4개 추가 (4 로케일)
- [ ] 회귀 테스트 통과

### Phase 2: 설정 UI
- [ ] 레이블 변경 (i18n 값만)
- [ ] `updateAutoSavePathState()` 수정 (항상 활성)
- [ ] 포매터 입력창 추가
- [ ] (?) 도움말 팝업 구현
- [ ] `DEFAULTS`, `populateForm()`, `collectFormValues()` 확장
- [ ] i18n 키 변경 2 + 신규 4 (4 로케일)
- [ ] 회귀 테스트 통과

### Phase 3: 컨텍스트 메뉴 · 경로 복사
- [ ] `positionAndBindContextMenu()` 추출 + `showContextMenu()` 리팩터링
- [ ] `showSidebarContextMenu()` 구현
- [ ] `renderTreeNode()` contextmenu 리스너 추가
- [ ] `show-in-explorer` 디렉토리 분기 추가
- [ ] `getCopyablePath()` + `saveAsFilePath` 상태 추가
- [ ] 뷰어 메뉴에 "저장" 항목 추가 (조건부)
- [ ] Ctrl+Shift+C 단축키 등록
- [ ] `.viewer-toast.error` CSS 추가
- [ ] i18n 키 2개 추가 (4 로케일)
- [ ] 회귀 테스트 통과

### Phase 4: MD 붙여넣기
- [ ] `paste` 이벤트 리스너 추가
- [ ] `render-pasted-content` IPC 핸들러 추가
- [ ] Preload 브릿지 추가
- [ ] 회귀 테스트 통과

## 코드 품질 체크

- [ ] 코드 중복 없음 확인 (reuse-guide 준수)
- [ ] 새 함수 7개 이내 유지
- [ ] 기존 함수 시그니처 변경 시 호출부 영향 없음 확인
- [ ] i18n 키 4개 로케일 동기화 확인
- [ ] CSS 클래스 명명 기존 패턴 준수

## 승인

| 항목 | 상태 |
|------|------|
| 모든 Phase 구현 완료 | [ ] |
| 통합 테스트 전 시나리오 통과 | [ ] |
| 회귀 테스트 전 항목 통과 | [ ] |
| 코드 리뷰 완료 | [ ] |
