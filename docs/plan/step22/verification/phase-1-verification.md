# Phase 1 검증: MCP 저장 코어 재설계

## 완료 체크리스트

| # | 항목 | 상태 | 비고 |
|---|------|------|------|
| 1 | `resolveSubDir()` 함수 구현 | [ ] | |
| 2 | `buildDestPath()` 공통 로직 추출 | [ ] | |
| 3 | `saveMcpFile()` 포매터 적용 수정 | [ ] | |
| 4 | `mcpManualSave()` 함수 추가 | [ ] | |
| 5 | `mcp-manual-save` IPC 핸들러 | [ ] | |
| 6 | `render-markdown` 이벤트에 `source`, `mcpAutoSave`, `project` 추가 | [ ] | |
| 7 | `mcpSaveSubDir` 설정 스키마 추가 | [ ] | |
| 8 | Preload `mcpManualSave` 브릿지 | [ ] | |
| 9 | `isMcpDocument` 등 상태 변수 추가 | [ ] | |
| 10 | `showViewerToast()` type 파라미터 확장 | [ ] | |
| 11 | `handleMcpSave()` 함수 (buildSaveParams 재활용) | [ ] | |
| 12 | Ctrl+S 단축키 등록 | [ ] | |
| 13 | i18n 키 4개 × 4 로케일 | [ ] | |

## 테스트 결과

| 테스트 | 결과 | 비고 |
|--------|------|------|
| TC-1-01: 수동 저장 성공 | [ ] | |
| TC-1-02: 포매터 적용 자동 저장 | [ ] | |
| TC-1-03: 경로 미설정 에러 | [ ] | |
| TC-1-04: 비-MCP Ctrl+S 무시 | [ ] | |
| TC-1-05: 포매터 빈 문자열 | [ ] | |
| TC-1-06: 미인식 토큰 | [ ] | |

## 회귀 테스트 결과

| 항목 | 결과 | 비고 |
|------|------|------|
| 기존 자동 저장 (mcpAutoSave=true) | [ ] | |
| Save As (Ctrl+Shift+S) | [ ] | |
| Quick Save (Ctrl+Alt+S) | [ ] | |
| 파일 삭제 (Ctrl+Alt+D) | [ ] | |

## 코드 리뷰

- [ ] `buildDestPath()` 추출 후 `saveMcpFile()` 코드량 감소 확인
- [ ] `mcpManualSave()`가 `buildDestPath()` 재활용 확인
- [ ] `handleMcpSave()`가 `buildSaveParams()` 재활용 확인
- [ ] 새 함수 시그니처가 기존 호출부와 호환 확인
