# 통합 테스트 가이드

## 목적

i18n 시스템이 Main ↔ Renderer 간 올바르게 연동되고, 두 locale(ko, en) 모두에서 전체 기능이 정상 동작하는지 검증한다.

## E2E 시나리오

### E2E-1: 전체 한국어 플로우 (CRITICAL)

```
Given: OS 시스템 언어 = ko-KR
When:
  1. 앱 시작
  2. 트레이 메뉴 확인 → 한국어 메뉴 항목
  3. 트레이 → 설정 클릭
  4. 설정 창 → 모든 라벨이 한국어
  5. 설정 저장 → "설정이 저장되었습니다" 메시지
  6. 트레이 → 새 뷰어 클릭
  7. 빈 창 → "Markdown 파일을 여기에 드래그하세요"
  8. .md 파일 드래그앤드롭
  9. 뷰어 툴팁 확인 → 한국어
  10. 창 닫기
Then: 모든 사용자 노출 텍스트가 한국어
```

### E2E-2: 전체 영어 플로우 (CRITICAL)

```
Given: OS 시스템 언어 = en-US
When: (E2E-1과 동일 절차)
Then: 모든 사용자 노출 텍스트가 영어
```

### E2E-3: MCP 도구 영어 고정 (HIGH)

```
Given: OS 시스템 언어 = ko-KR
When:
  1. 앱 시작
  2. MCP open_markdown 호출 (content: "# Test")
  3. MCP list_viewers 호출
  4. MCP close_viewer 호출
Then:
  - MCP 응답 메시지가 항상 영어
  - "Opened viewer window." (not "뷰어 창이 열렸습니다")
```

### E2E-4: 미지원 언어 폴백 (HIGH)

```
Given: OS 시스템 언어 = ja (일본어)
When: 앱 시작 → 트레이 메뉴 + 설정 창 확인
Then: 모든 텍스트가 영어 (기본값)
```

### E2E-5: i18n + 기존 기능 호환 (MEDIUM)

```
Given: 정상 앱 실행
When:
  1. 파일 열기 → 네비게이션 (뒤로/앞으로)
  2. 줌 인/아웃/리셋
  3. 사이드바 토글
  4. 항상 위 토글
  5. 설정 변경 (테마, 폰트 등)
Then: 모든 기능이 i18n 교체 후에도 정상 동작
```

## 컴포넌트 통합 매트릭스

| Main Component | Renderer Component | 통합 포인트 | 검증 항목 |
|---------------|-------------------|------------|----------|
| strings.js | viewer.js | IPC get-strings | locale 데이터 전달 |
| strings.js | settings.js | IPC get-strings | locale 데이터 전달 |
| index.js (tray) | - | t() 직접 호출 | 메뉴 텍스트 |
| file-association.js | settings.js | IPC result.message | 결과 메시지 언어 일치 |
| window-manager.js | - | throw Error | 에러 메시지 언어 |

## 수동 검증 체크리스트

- [ ] ko locale: 트레이 메뉴 5개 항목 한국어
- [ ] ko locale: 설정 UI 모든 텍스트 한국어
- [ ] ko locale: 뷰어 빈 상태 텍스트 한국어
- [ ] ko locale: 뷰어 툴팁 3개 한국어
- [ ] en locale: 위 항목 모두 영어
- [ ] MCP 응답: locale 무관 영어 고정
- [ ] 콘솔 로그: locale 무관 영어 고정
- [ ] 앱 재시작: locale 유지
