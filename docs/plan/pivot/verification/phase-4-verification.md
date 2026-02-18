# Phase 4 검증: Markdown 뷰어 창

검증일: ____-__-__
검증자: ________________

## 참조 문서

- 구현 계획: [04.phase-4-viewer.md](../04.phase-4-viewer.md)
- SRS: [srs.pivot.md](../../srs.pivot.md) (FR-P-003)
- 아키텍처: [00-1.architecture.md](../00-1.architecture.md) Section 2.2

---

## 1. viewer.html 기본 구조 검증

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 1 | [ ] `src/renderer/viewer.html` 파일 존재 | 파일 확인 | 존재 | |
| 2 | [ ] CSP meta 태그 포함 | HTML 소스 검사 | `<meta http-equiv="Content-Security-Policy" ...>` | |
| 3 | [ ] CSP에서 `script-src 'self'` 설정 | CSP 내용 확인 | 외부 스크립트 차단 | |
| 4 | [ ] CSP에서 `style-src 'self' 'unsafe-inline'` | CSP 내용 확인 | Mermaid 인라인 스타일 허용 | |
| 5 | [ ] lib 스크립트 로딩 순서 | `<script>` 태그 순서 확인 | marked → purify → viewer.js (mermaid, hljs는 별도) | |
| 6 | [ ] `src/renderer/viewer.js` 파일 존재 | 파일 확인 | 존재 | |
| 7 | [ ] `src/renderer/viewer.css` 파일 존재 | 파일 확인 | 존재 | |
| 8 | [ ] 사이드바 + 본문 레이아웃 구조 | HTML 구조 확인 | sidebar + main-content 영역 분리 | |

---

## 2. Markdown 렌더링 파이프라인 검증

### 2.1 기본 Markdown 요소

| # | 검증 항목 | 테스트 입력 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 9 | [ ] H1 ~ H6 헤딩 | `# H1` ~ `###### H6` | 6단계 헤딩 정상 렌더링 | |
| 10 | [ ] 코드 블록 (fenced) | ` ```js\nconsole.log('hi')\n``` ` | 구문 강조 적용된 코드 블록 | |
| 11 | [ ] 인라인 코드 | `` `code` `` | 모노스페이스 인라인 표시 | |
| 12 | [ ] 순서 있는 목록 | `1. item` | 번호 목록 렌더링 | |
| 13 | [ ] 순서 없는 목록 | `- item` | 불릿 목록 렌더링 | |
| 14 | [ ] 테이블 | `| col1 | col2 |` | 표 렌더링 | |
| 15 | [ ] 볼드/이탤릭 | `**bold** *italic*` | 서식 적용 | |
| 16 | [ ] 블록인용 | `> quote` | 인용 블록 렌더링 | |
| 17 | [ ] 이미지 | `![alt](url)` | 이미지 표시 (src 유효 시) | |
| 18 | [ ] 수평선 | `---` | 구분선 렌더링 | |

### SRS 매핑: T-18 (코드 블록)

---

## 3. DOMPurify 보안 검증

| # | 검증 항목 | 테스트 입력 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 19 | [ ] `<script>` 태그 제거 | `<script>alert('xss')</script>` | script 태그 완전 제거 | |
| 20 | [ ] `<iframe>` 태그 제거 | `<iframe src="evil.com"></iframe>` | iframe 제거 | |
| 21 | [ ] `on*` 이벤트 속성 제거 | `<div onclick="alert(1)">text</div>` | onclick 속성 제거, div 유지 | |
| 22 | [ ] `javascript:` URL 제거 | `<a href="javascript:void(0)">link</a>` | href 제거 또는 무효화 | |
| 23 | [ ] `USE_PROFILES: { html: true }` 설정 | 코드 검사 | DOMPurify 기본 프로필 사용 | |
| 24 | [ ] 정상 HTML 유지 | `<strong>bold</strong>` | 태그 유지 | |

### SRS 매핑: T-20 (XSS 시도)

---

## 4. Mermaid 다이어그램 검증

| # | 검증 항목 | 테스트 입력 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 25 | [ ] flowchart 렌더링 | ` ```mermaid\nflowchart LR\nA-->B\n``` ` | SVG 다이어그램 표시 | |
| 26 | [ ] sequence diagram 렌더링 | ` ```mermaid\nsequenceDiagram\nA->>B: Hello\n``` ` | 시퀀스 다이어그램 표시 | |
| 27 | [ ] 잘못된 Mermaid 구문 | ` ```mermaid\ninvalid syntax\n``` ` | 에러 메시지로 대체, 나머지 정상 | |
| 28 | [ ] `mermaid.run()` 호출 시점 | 코드 검사 | DOM 삽입 후 실행 | |

### SRS 매핑: T-19 (Mermaid 다이어그램)

---

## 5. highlight.js 코드 하이라이팅 검증

| # | 검증 항목 | 테스트 입력 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 29 | [ ] JavaScript 코드 하이라이팅 | ` ```javascript\nconst x = 1;\n``` ` | 키워드 색상 적용 | |
| 30 | [ ] Python 코드 하이라이팅 | ` ```python\ndef foo():\n  pass\n``` ` | 키워드 색상 적용 | |
| 31 | [ ] 언어 미지정 시 자동 감지 | ` ```\nconst x = 1;\n``` ` | 자동 감지 또는 일반 코드 | |
| 32 | [ ] `hljs.highlightAll()` 호출 시점 | 코드 검사 | mermaid.run() 이후 실행 | |
| 33 | [ ] highlight-github.min.css 적용 | 스타일 확인 | GitHub 테마 코드 스타일 | |

### SRS 매핑: T-18 (코드 블록 하이라이팅)

---

## 6. 외부 링크 처리 검증

| # | 검증 항목 | 테스트 입력 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 34 | [ ] http:// 링크 클릭 | `[외부](https://example.com)` | 시스템 기본 브라우저에서 열림 | |
| 35 | [ ] https:// 링크 클릭 | `[외부](https://google.com)` | 시스템 기본 브라우저에서 열림 | |
| 36 | [ ] `shell.openExternal` URL 화이트리스트 | `javascript:alert(1)` 링크 | 차단됨 (http/https만 허용) | |
| 37 | [ ] mailto: 링크 클릭 | `[메일](mailto:test@example.com)` | 이메일 클라이언트 열림 또는 무시 | |

### SRS 매핑: T-23 (외부 링크), T-37 (URL 화이트리스트)

---

## 7. 키보드 단축키 검증

| # | 검증 항목 | 단축키 | 기대 결과 | 결과 |
|---|-----------|--------|-----------|------|
| 38 | [ ] 문서 내 검색 | `Ctrl+F` | findInPage 검색 바 표시 | |
| 39 | [ ] 현재 창 닫기 | `Ctrl+W` | 뷰어 창 닫힘 | |
| 40 | [ ] 확대 | `Ctrl++` | zoomLevel 증가 | |
| 41 | [ ] 축소 | `Ctrl+-` | zoomLevel 감소 | |
| 42 | [ ] 확대/축소 초기화 | `Ctrl+0` | zoomLevel 기본값 복원 | |
| 43 | [ ] 사이드바 토글 | `Ctrl+B` | 사이드바 숨김/표시 전환 | |
| 44 | [ ] 뒤로가기 | `Ctrl+Left` 또는 `Alt+Left` | 이전 문서로 이동 | |
| 45 | [ ] 앞으로가기 | `Ctrl+Right` 또는 `Alt+Right` | 다음 문서로 이동 | |
| 46 | [ ] always-on-top 해제 | `Esc` | foreground 창 → 일반 창 | |

### SRS 매핑: T-32 (Ctrl+F), T-33 (Ctrl+W), T-34 (Ctrl+Left/Right), T-49 (Esc), T-50 (Ctrl+B), T-51 (Ctrl++/-)

---

## 8. IPC 렌더링 흐름 검증

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 47 | [ ] 렌더러 → `window-ready` IPC 전송 | 코드 검사 + 로그 | viewer.js 로드 완료 후 전송 | |
| 48 | [ ] 메인 → `render-markdown` IPC 수신 | 코드 검사 + 로그 | markdown + meta 데이터 수신 | |
| 49 | [ ] 렌더링 파이프라인 순서 | 코드 검사 | marked → purify → DOM → mermaid → hljs | |
| 50 | [ ] update_markdown 시 렌더링 갱신 | update 호출 후 확인 | 기존 내용 교체, 스크롤 상단 리셋 | |

---

## 9. 대형 문서 및 경계 케이스

| # | 검증 항목 | 확인 방법 | 기대 결과 | 결과 |
|---|-----------|-----------|-----------|------|
| 51 | [ ] 1MB 문서 렌더링 | 1MB Markdown 파일 | 정상 렌더링 | |
| 52 | [ ] 5MB+ 문서 렌더링 | 5MB 이상 Markdown | 성능 경고 표시, 렌더링 시도 | |
| 53 | [ ] 빈 문서 렌더링 | 빈 content 전달 | 빈 뷰어 (에러 없음) | |
| 54 | [ ] content 정확히 10MB (경계값) | 10,485,760 bytes | 허용됨 | |

### SRS 매핑: T-24 (대형 문서), T-58 (10MB 경계값)

---

## 10. 검증 결과 요약

| 항목 | 전체 | 통과 | 실패 | 미검증 |
|------|------|------|------|--------|
| viewer.html 구조 | 8 | | | |
| Markdown 렌더링 | 10 | | | |
| DOMPurify 보안 | 6 | | | |
| Mermaid 다이어그램 | 4 | | | |
| highlight.js | 5 | | | |
| 외부 링크 처리 | 4 | | | |
| 키보드 단축키 | 9 | | | |
| IPC 렌더링 흐름 | 4 | | | |
| 대형 문서/경계 | 4 | | | |
| **합계** | **54** | | | |

### 최종 판정

- [ ] **PASS**: 모든 검증 항목 통과
- [ ] **FAIL**: 실패 항목 존재 -> 수정 후 재검증 필요

실패 항목 (있을 경우):

| # | 항목 | 실패 사유 | 수정 조치 |
|---|------|-----------|-----------|
| | | | |
