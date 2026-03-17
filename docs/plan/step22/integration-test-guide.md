# Step 22 통합 테스트 가이드

## E2E 시나리오

### S-01: MCP 문서 수동 저장 → 경로 복사 → 탐색기 열기 (Critical)

1. 설정에서 자동 저장 OFF, 경로 `D:\test-docs`, 포매터 `{yyyy-mm-dd}` 설정
2. MCP `open_markdown { content: "# Test Doc", title: "MyDoc" }` 호출
3. 뷰어에서 Ctrl+S → 성공 토스트 확인
4. 파일 시스템에서 `D:\test-docs\2026-03-17\HHMMSS_MyDoc.md` 존재 확인
5. Ctrl+Shift+C → "경로가 복사되었습니다" 토스트, 클립보드에 경로 확인
6. 우클릭 → "파일 탐색기에서 열기" → 파일 위치로 탐색기 열림

### S-02: 빈 페이지 붙여넣기 → Save As → 경로 복사 (High)

1. 빈 뷰어 열기
2. 클립보드에 `"# Pasted\n\nContent"` 복사 → Ctrl+V
3. H1 "Pasted" 렌더링 확인
4. Ctrl+Shift+S → `D:\export\pasted.md`로 저장
5. Ctrl+Shift+C → `D:\export\pasted.md` 클립보드 복사 확인

### S-03: 사이드바 컨텍스트 메뉴 + 뷰어 컨텍스트 메뉴 연동 (High)

1. 사이드바 트리에서 파일 우클릭 → "경로 복사" → 토스트
2. 같은 파일 클릭 → 뷰어에 렌더링
3. 뷰어 우클릭 → "경로 복사" 활성 확인 (동일 경로)
4. 사이드바 디렉토리 우클릭 → "파일 탐색기에서 열기" → 디렉토리 내부 열림

### S-04: 자동 저장 → 수동 저장 전환 (Medium)

1. 설정에서 자동 저장 ON, 포매터 `{project}` 설정
2. MCP `open_markdown { content: "...", project: "MyApp" }` → 자동 저장 확인
3. 설정에서 자동 저장 OFF로 변경
4. 새 MCP 문서 열기 → 자동 저장 안 됨 확인
5. Ctrl+S → 수동 저장 성공 확인 (동일 경로 + 포매터 적용)

## 컴포넌트 통합 매트릭스

| 컴포넌트 | mcp-save | viewer | settings | preload | i18n |
|----------|:--------:|:------:|:--------:|:-------:|:----:|
| 수동 저장 | ● | ● | | ● | ● |
| 자동 저장 (포매터) | ● | | ● | | |
| 사이드바 메뉴 | | ● | | ● | ● |
| 뷰어 경로 복사 | | ● | | | ● |
| 붙여넣기 | | ● | | ● | |

## 요구사항 추적

| SRS 요구사항 | Phase | 테스트 커버 |
|-------------|-------|------------|
| FR-22-001: MCP 저장 설정 재설계 | Phase 1, 2 | TC-1-01~06, TC-2-01~04, S-01, S-04 |
| FR-22-002: 사이드바 컨텍스트 메뉴 | Phase 3 | TC-3-01~02, TC-3-06, S-03 |
| FR-22-003: 뷰어 경로 복사 확장 | Phase 3 | TC-3-03~05, S-01, S-02 |
| FR-22-004: MD 붙여넣기 | Phase 4 | TC-4-01~07, S-02 |

## 회귀 체크리스트 (전체)

- [ ] MCP `open_markdown` → 자동 저장 정상
- [ ] MCP `update_markdown` → 콘텐츠 갱신 정상
- [ ] Save As (Ctrl+Shift+S) 정상
- [ ] Quick Save (Ctrl+Alt+S) 정상
- [ ] 저장된 파일 삭제 (Ctrl+Alt+D) 정상
- [ ] PDF Export (Ctrl+P) 정상
- [ ] 드래그앤드롭 파일 열기 정상
- [ ] 사이드바 파일 클릭 네비게이션 정상
- [ ] 사이드바 검색 정상
- [ ] 탭 관리 (Ctrl+T, Ctrl+W) 정상
- [ ] 줌 (Ctrl+=, Ctrl+-, Ctrl+0) 정상
- [ ] 키보드 단축키 전체 충돌 없음 확인
