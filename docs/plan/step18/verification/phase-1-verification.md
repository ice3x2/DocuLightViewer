# Phase 1 검증: 모듈 인프라 + 이미지 경로 + 포트 디스커버리

## 완료 체크리스트

- [ ] electron-store 스키마에 autoRefresh, enableTabs, recentFiles 추가됨
- [ ] 4개 로케일 파일에 Step 18 전체 i18n 키 추가됨
- [ ] settings.html에 autoRefresh, enableTabs 체크박스 표시됨
- [ ] settings.js에서 두 키의 저장/로드 정상
- [ ] window.DocuLight 네임스페이스 생성 확인 (DevTools 콘솔)
- [ ] image-resolver.js가 로드되고 init() 호출됨
- [ ] 빈 스텁 모듈 3개 (sidebar-search, pdf-export-ui, tab-manager) 에러 없이 로드
- [ ] marked.use() 마이그레이션 완료 (marked.setOptions 호출 제거)
- [ ] 상대 경로 이미지가 file:// URL로 올바르게 변환
- [ ] 절대 URL, data: URL 이미지가 변환 없이 유지
- [ ] 경로 트래버설 시 이미지 차단 (빈 src)
- [ ] mcp-port 파일이 앱 시작 시 생성, 종료 시 삭제
- [ ] mcp-port 파일 내용이 실제 바인딩된 포트 번호와 일치

## 테스트 결과

| # | 테스트 항목 | 결과 | 비고 |
|---|-----------|------|------|
| 1 | 상대 경로 이미지 표시 (AC-007-1) | | |
| 2 | 절대 URL 이미지 유지 (AC-007-2) | | |
| 3 | data: URL 이미지 유지 (AC-007-3) | | |
| 4 | content-only 상대 경로 (AC-007-4) | | |
| 5 | 경로 트래버설 차단 (AC-007-5) | | |
| 6 | Windows 백슬래시 정규화 (AC-007-7) | | |
| 7 | 포트 파일 생성 (AC-002-1) | | |
| 8 | 포트 파일 삭제 (AC-002-2) | | |
| 9 | 포트 파일 쓰기 실패 시 앱 계속 (AC-002-3) | | |

## 품질 평가

| # | 기준 | 등급 | 비고 |
|---|------|------|------|
| 1 | Plan-Code 정합성 | | |
| 2 | SOLID 원칙 | | |
| 3 | 코드 가독성 | | |
| 4 | 에러 처리 | | |
| 5 | 문서화 | | |

## 이슈

(구현 후 기록)

## 승인

- [ ] 모든 테스트 통과
- [ ] 회귀테스트 통과 (기존 마크다운 렌더링, Mermaid, 코드 하이라이팅, MCP)
