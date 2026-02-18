# DocuLight Phase 2: 코드 하이라이팅 및 UX 개선

**작성일**: 2025-10-23
**우선순위**: P0
**예상 소요 시간**: 6-8시간

---

## 📋 목표

Phase 1에서 구현한 기본 기능에 다음 개선사항을 추가합니다:

1. ✅ 신택스 하이라이팅 (거의 모든 프로그래밍 언어)
2. ✅ 코드 블록 복사 기능
3. ✅ 마지막 열람 문서 자동 로드
4. ✅ 코드 블록 스타일 개선

---

## 🎯 요구사항 상세

### 1. 신택스 하이라이팅 라이브러리

**선택된 라이브러리**: Highlight.js
- **이유**:
  - 190+ 언어 지원
  - 자동 언어 감지
  - 가벼운 번들 크기
  - CDN 지원
  - Markdown과 쉬운 통합

**지원 언어** (필수):
- Python, JavaScript, Java, C, C++, C#
- Bash, Shell, PowerShell
- SQL (MySQL, PostgreSQL, SQLite)
- HTML, CSS, JSON, YAML, XML
- TypeScript, PHP, Ruby, Go, Rust
- Kotlin, Swift, Dart

**구현 방법**:
```javascript
// Marked.js 렌더링 후 Highlight.js 적용
marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  }
});
```

---

### 2. 코드 블록 스타일 개선

**모서리 둥글게**:
```css
.markdown-content pre {
  border-radius: 3px;
}

.markdown-content pre code {
  border-radius: 3px;
}
```

**색상 테마**: GitHub Dark 또는 Monokai

---

### 3. 코드 복사 기능

**UI 요소**:
- 코드 블록 우측 상단에 복사 아이콘 (📋)
- 호버 시: 배경색 변경, 커서 포인터
- 클릭 시:
  1. 클립보드에 코드 복사
  2. 아이콘 왼쪽에 "Copied!" 메시지 표시
  3. 3초 후 페이드아웃 애니메이션

**HTML 구조**:
```html
<div class="code-block-wrapper">
  <button class="copy-btn">
    <span class="copy-icon">📋</span>
    <span class="copy-message">Copied!</span>
  </button>
  <pre><code>...</code></pre>
</div>
```

**CSS 스타일**:
```css
.code-block-wrapper {
  position: relative;
}

.copy-btn {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.copy-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.copy-message {
  opacity: 0;
  transition: opacity 0.3s ease;
}

.copy-message.show {
  opacity: 1;
}

.copy-message.fade-out {
  opacity: 0;
}
```

**JavaScript 로직**:
```javascript
async function copyCode(codeElement, messageElement) {
  const code = codeElement.textContent;
  await navigator.clipboard.writeText(code);

  // Show "Copied!" message
  messageElement.classList.add('show');

  // Fade out after 3 seconds
  setTimeout(() => {
    messageElement.classList.add('fade-out');
    messageElement.classList.remove('show');

    // Reset after animation
    setTimeout(() => {
      messageElement.classList.remove('fade-out');
    }, 300);
  }, 3000);
}
```

---

### 4. 마지막 열람 문서 자동 로드

**현재 상태**:
- IndexedDB에 lastOpened 저장 로직은 구현되어 있음
- 초기화 시 로드하는 로직도 구현되어 있음

**확인 필요**:
- 실제 저장 및 로드가 정상 작동하는지 테스트
- 파일 클릭 시 saveLastOpened() 호출 확인
- init() 함수에서 getLastOpened() 및 loadFile() 호출 확인

**개선사항**:
- 존재하지 않는 파일 처리 (삭제된 경우)
- 에러 발생 시 기본 화면으로 복귀

---

## 📝 구현 체크리스트

### Step 1: Highlight.js 통합
- [ ] CDN 링크 추가 (views/index.ejs)
- [ ] CSS 테마 추가 (github-dark 또는 monokai)
- [ ] Marked.js와 통합
- [ ] 코드 블록 렌더링 테스트

### Step 2: 코드 블록 스타일
- [ ] border-radius: 3px 적용
- [ ] 코드 블록 배경색 조정
- [ ] 패딩 및 마진 조정
- [ ] 스크롤바 스타일링

### Step 3: 복사 버튼 구현
- [ ] 코드 블록 래퍼 생성
- [ ] 복사 버튼 HTML 생성
- [ ] 복사 버튼 CSS 스타일
- [ ] 클립보드 복사 로직
- [ ] "Copied!" 메시지 애니메이션
- [ ] 호버 효과

### Step 4: 마지막 문서 자동 로드
- [ ] saveLastOpened() 호출 확인
- [ ] getLastOpened() 및 복원 로직 확인
- [ ] 에러 처리 (파일 없을 때)
- [ ] 브라우저 테스트

---

## 🧪 테스트 시나리오

### 신택스 하이라이팅
1. `/guide/programming-samples.md` 열람
2. Python, JavaScript, Java, C, C++, C#, Bash 코드 확인
3. 색상 하이라이팅 적용 여부 확인
4. 키워드, 문자열, 주석 구분 확인

### 코드 복사
1. 임의의 코드 블록 찾기
2. 우측 상단 복사 아이콘 확인
3. 마우스 호버 시 배경색 변경 확인
4. 클릭 시:
   - 클립보드 복사 확인 (Ctrl+V로 붙여넣기)
   - "Copied!" 메시지 표시 확인
   - 3초 후 페이드아웃 확인

### 마지막 문서 로드
1. 문서 A 열람
2. 페이지 새로고침 (F5)
3. 문서 A가 자동으로 열리는지 확인
4. Breadcrumb 경로 확인
5. 트리에서 active 상태 확인

### 에러 케이스
1. 마지막 문서가 삭제된 경우
2. 권한이 없는 파일인 경우
3. 잘못된 경로인 경우

---

## 🔧 파일 변경 사항

### 수정할 파일
1. **views/index.ejs**
   - Highlight.js CDN 추가
   - CSS 테마 링크 추가

2. **public/css/style.css**
   - 코드 블록 스타일 개선
   - 복사 버튼 스타일 추가
   - 애니메이션 정의

3. **public/js/app.js**
   - Highlight.js 통합
   - 코드 블록 래퍼 생성 로직
   - 복사 버튼 생성 및 이벤트
   - 마지막 문서 로드 로직 검증

---

## 📊 예상 소요 시간

| 작업 | 예상 시간 |
|------|-----------|
| Highlight.js 통합 | 1시간 |
| 코드 블록 스타일 | 1시간 |
| 복사 버튼 구현 | 2시간 |
| 마지막 문서 로드 확인 | 1시간 |
| 테스트 및 디버깅 | 2시간 |
| **총계** | **6-8시간** |

---

## 🎯 완료 기준

### 기능 완료
- [ ] 모든 코드 블록에 신택스 하이라이팅 적용
- [ ] 190+ 언어 지원 (자동 감지 포함)
- [ ] 복사 버튼이 모든 코드 블록에 표시
- [ ] 복사 기능 정상 작동
- [ ] "Copied!" 메시지 애니메이션
- [ ] 마지막 문서 자동 로드

### 품질 기준
- [ ] 브라우저 호환성 (Chrome, Firefox, Edge)
- [ ] 모바일 반응형 (복사 버튼)
- [ ] 접근성 (키보드 네비게이션)
- [ ] 성능 (렌더링 시간 < 1초)

### 테스트 통과
- [ ] 7개 언어 코드 샘플 하이라이팅
- [ ] 복사 버튼 클릭 테스트
- [ ] 새로고침 후 문서 복원 테스트
- [ ] 에러 케이스 처리

---

## 🚀 다음 단계

Phase 2 완료 후:
1. **Option A**: Phase 3 (검색 기능 등 UX 개선)
2. **Option B**: Phase 4 (Docker 배포 준비)
3. **Option C**: 트리 상태 복원 버그 수정

---

## 📚 참고 자료

### Highlight.js
- 공식 문서: https://highlightjs.org/
- CDN: https://cdnjs.com/libraries/highlight.js
- 언어 지원: https://github.com/highlightjs/highlight.js/blob/main/SUPPORTED_LANGUAGES.md
- 테마: https://highlightjs.org/static/demo/

### Clipboard API
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API

### CSS 애니메이션
- Fade in/out: opacity transition
- Keyframes for smooth animation

---

**작성자**: Claude Code
**버전**: 1.0
