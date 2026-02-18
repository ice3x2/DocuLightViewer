# DocuLight Phase 3: URL 라우팅 및 UI 개선

**작성일**: 2025-10-23
**우선순위**: P1
**예상 소요 시간**: 4-6시간

---

## 📋 목표

Phase 2에서 구현한 코드 하이라이팅 기능에 더해 URL 기반 네비게이션과 UI 개선을 추가합니다.

---

## 🎯 요구사항 상세

### 1. .md 확장자 숨기기

**현재 상태**: 좌측 트리에 "getting-started.md" 표시

**변경 후**: "getting-started" 표시 (.md 제거)

**구현 위치**: `public/js/app.js` - buildTree() 함수

**구현 방법**:
```javascript
// 파일명에서 .md 확장자 제거
let displayName = file.name;
if (displayName.endsWith('.md')) {
  displayName = displayName.slice(0, -3);
}

const nameSpan = document.createElement('span');
nameSpan.textContent = displayName;
```

**주의사항**:
- 내부적으로는 전체 파일명 유지 (file.name)
- data-path 속성에는 전체 경로 저장
- API 호출 시 전체 경로 사용

---

### 2. URL 주소창 업데이트

**현재 상태**: http://localhost:3000 (고정)

**변경 후**: http://localhost:3000/doc/guide/getting-started (경로 기반, UTF-8 인코딩)

**구현 방법**:

#### 2.1 파일 선택 시 URL 업데이트
```javascript
// loadFile() 함수에서 URL 업데이트
async function loadFile(path) {
  // ... 기존 코드 ...

  // Update URL without reload
  const encodedPath = encodeURIComponent(path);
  const newUrl = `${window.location.pathname}?path=${encodedPath}`;
  window.history.pushState({ path }, '', newUrl);

  // ... 나머지 코드 ...
}
```

#### 2.2 초기 로드 시 URL 파라미터 읽기
```javascript
async function init() {
  // ... IndexedDB 초기화 ...

  // Check URL parameter first
  const urlParams = new URLSearchParams(window.location.search);
  const pathFromUrl = urlParams.get('path');

  if (pathFromUrl) {
    // Load file from URL
    await expandPathToFile(pathFromUrl);
    await loadFile(pathFromUrl);
  } else {
    // Fallback to last opened file
    const lastOpened = await getLastOpened();
    if (lastOpened) {
      await expandPathToFile(lastOpened);
      await loadFile(lastOpened);
    }
  }
}
```

**우선순위**:
1. URL 파라미터 (최우선)
2. IndexedDB 마지막 문서 (fallback)
3. Welcome 화면 (기본값)

---

### 3. 앵커 링크 (#heading) 자동 스크롤

**기능**: http://localhost:3000?path=guide/api#endpoints 접속 시
- `guide/api.md` 파일 로드
- `#endpoints` 헤딩으로 자동 스크롤

**구현 방법**:

#### 3.1 헤딩 ID 생성 (이미 marked.js가 처리)
```javascript
marked.setOptions({
  headerIds: true  // 이미 설정됨
});
```

#### 3.2 앵커로 스크롤
```javascript
async function loadFile(path, hash = '') {
  // ... 파일 로드 및 렌더링 ...

  // Scroll to anchor if provided
  if (hash) {
    // Wait for rendering to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const targetElement = document.getElementById(hash);
    if (targetElement) {
      targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}
```

#### 3.3 URL에서 hash 파싱
```javascript
async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const pathFromUrl = urlParams.get('path');
  const hash = window.location.hash.substring(1); // Remove '#'

  if (pathFromUrl) {
    await expandPathToFile(pathFromUrl);
    await loadFile(pathFromUrl, hash);
  }
}
```

**예시 URL**:
- `?path=guide/getting-started#installation`
- `?path=reference/api#endpoints`
- `?path=README#features`

---

### 4. content-header 스타일 개선

**현재 상태**:
```css
.content-header {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--border-color);
  background-color: var(--bg-secondary);  /* 회색 */
}

.breadcrumb {
  font-size: 0.9rem;
  color: var(--text-secondary);  /* 회색 텍스트 */
}
```

**변경 후**:
```css
.content-header {
  padding: 0.75rem 1.5rem;  /* 높이 낮춤 */
  border-bottom: 1px solid var(--border-color);
  background-color: #ffffff;  /* 흰색 배경 */
}

.breadcrumb {
  font-size: 0.95rem;  /* 약간 크게 */
  color: #24292f;  /* 검은색 */
  font-weight: 600;  /* 굵게 */
}
```

**파일**: `public/css/style.css`

---

## 📝 구현 체크리스트

### Step 1: .md 확장자 숨기기
- [ ] buildTree() 함수에서 displayName 처리
- [ ] .md 파일만 확장자 제거
- [ ] data-path는 전체 경로 유지
- [ ] 테스트: 트리에서 확장자 없이 표시

### Step 2: URL 업데이트
- [ ] loadFile()에서 history.pushState() 추가
- [ ] encodeURIComponent()로 UTF-8 인코딩
- [ ] 브라우저 뒤로가기 지원 (popstate 이벤트)
- [ ] 테스트: 파일 선택 시 URL 변경 확인

### Step 3: URL 파라미터 읽기
- [ ] init()에서 URLSearchParams 파싱
- [ ] URL 파라미터 > IndexedDB 우선순위
- [ ] 잘못된 경로 에러 처리
- [ ] 테스트: URL 직접 입력 시 파일 로드

### Step 4: 앵커 링크 (#heading) 지원
- [ ] URL hash 파싱
- [ ] loadFile()에 hash 파라미터 추가
- [ ] scrollIntoView() 구현
- [ ] 렌더링 완료 대기 (setTimeout)
- [ ] 테스트: #heading URL로 자동 스크롤

### Step 5: popstate 이벤트 처리
- [ ] 브라우저 뒤로/앞으로 버튼 지원
- [ ] popstate 이벤트 리스너 추가
- [ ] 상태 복원 로직
- [ ] 테스트: 뒤로가기 버튼 동작

### Step 6: content-header 스타일
- [ ] 배경색 흰색으로 변경
- [ ] padding 축소 (높이 낮춤)
- [ ] breadcrumb 검은색, 굵게
- [ ] 테스트: 헤더 스타일 확인

---

## 🧪 테스트 시나리오

### 확장자 숨기기
1. 트리에서 파일 확인
2. .md 확장자가 없는지 확인
3. .png, .jpg 등 다른 파일은 확장자 표시 확인

### URL 업데이트
1. guide/getting-started.md 클릭
2. URL이 `?path=guide%2Fgetting-started` 로 변경되는지 확인
3. 다른 파일 클릭 → URL 변경 확인
4. 뒤로가기 버튼 → 이전 파일로 이동 확인

### URL 직접 입력
1. 브라우저에서 `http://localhost:3000?path=guide/getting-started` 입력
2. 파일이 자동으로 로드되는지 확인
3. guide 폴더가 자동으로 확장되는지 확인

### 앵커 링크
1. `http://localhost:3000?path=reference/api#endpoints` 접속
2. api.md 파일 로드 확인
3. "Endpoints" 헤딩으로 자동 스크롤 확인
4. 부드러운 스크롤 효과 확인

### 헤더 스타일
1. 파일 로드 후 상단 헤더 확인
2. 흰색 배경 확인
3. 경로가 검은색 굵은 글씨로 표시되는지 확인
4. 높이가 이전보다 낮은지 확인

---

## 🔧 파일 변경 사항

### 수정할 파일

1. **public/js/app.js**
   - buildTree(): .md 확장자 제거
   - loadFile(): URL 업데이트, hash 처리
   - init(): URL 파라미터 읽기
   - popstate 이벤트 리스너 추가

2. **public/css/style.css**
   - .content-header 스타일 수정
   - .breadcrumb 스타일 수정

---

## 📊 예상 소요 시간

| 작업 | 예상 시간 |
|------|-----------|
| .md 확장자 숨기기 | 0.5시간 |
| URL 업데이트 구현 | 1시간 |
| URL 파라미터 읽기 | 1시간 |
| 앵커 링크 구현 | 1.5시간 |
| popstate 이벤트 | 0.5시간 |
| 헤더 스타일 수정 | 0.5시간 |
| 테스트 및 디버깅 | 1시간 |
| **총계** | **6시간** |

---

## 🎯 완료 기준

### 기능 완료
- [ ] 트리에서 .md 확장자 숨김
- [ ] 파일 선택 시 URL 자동 업데이트
- [ ] URL로 직접 파일 접근 가능
- [ ] 앵커 링크로 헤딩 이동
- [ ] 브라우저 뒤로/앞으로 버튼 지원
- [ ] 헤더 스타일 개선

### 품질 기준
- [ ] UTF-8 인코딩 정상 작동 (한글 경로)
- [ ] 잘못된 경로 에러 처리
- [ ] 부드러운 스크롤 애니메이션
- [ ] 브라우저 히스토리 정상 작동

### 테스트 통과
- [ ] .md 파일 확장자 숨김
- [ ] URL 업데이트 동작
- [ ] 앵커 링크 스크롤
- [ ] 뒤로가기 버튼
- [ ] 헤더 스타일

---

## 🚀 구현 우선순위

### Phase 3.1 (P0 - 필수)
1. .md 확장자 숨기기
2. URL 업데이트 및 파라미터 읽기
3. 헤더 스타일 개선

### Phase 3.2 (P1 - 중요)
4. 앵커 링크 자동 스크롤
5. popstate 이벤트 처리

---

## 💡 추가 개선 아이디어 (선택적)

### URL 단축
- 현재: `?path=guide/getting-started`
- 개선: `/guide/getting-started` (path prefix 활용)
- 장점: 더 깔끔한 URL
- 단점: 서버 라우팅 수정 필요

### 공유 기능
- 현재 페이지 URL 복사 버튼
- 앵커 링크 포함 복사
- SNS 공유 버튼

### 목차 (TOC)
- 우측에 문서 내 헤딩 목차
- 클릭 시 해당 섹션으로 스크롤
- 현재 위치 하이라이트

---

## 🔍 기술적 고려사항

### URL 인코딩
- `encodeURIComponent()`: 파일 경로, 앵커
- `decodeURIComponent()`: URL에서 읽을 때

### 브라우저 히스토리
- `pushState()`: 새 항목 추가
- `replaceState()`: 현재 항목 교체
- `popstate` 이벤트: 뒤로/앞으로 버튼

### 스크롤 타이밍
- Markdown 렌더링 완료 대기
- Mermaid 다이어그램 렌더링 대기
- requestAnimationFrame() 또는 setTimeout() 활용

---

## 📚 참고 자료

### Web APIs
- History API: https://developer.mozilla.org/en-US/docs/Web/API/History_API
- URLSearchParams: https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams
- scrollIntoView: https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollIntoView

### Marked.js
- Header IDs: https://marked.js.org/using_advanced#options

---

## 🎨 UI 변경 사항

### Before (현재)
```
┌─────────────────────────────────┐
│ 문서를 선택하세요          (회색배경) │
├─────────────────────────────────┤
│                                 │
│  문서 내용                       │
│                                 │
```

### After (변경 후)
```
┌─────────────────────────────────┐
│ guide/getting-started    (흰배경) │  ← 검은색 굵게, 높이 낮음
├─────────────────────────────────┤
│                                 │
│  문서 내용                       │
│                                 │
```

---

## 🔧 주요 함수 수정

### buildTree()
- 파일명 표시 시 .md 제거

### loadFile(path, hash = '')
- URL 업데이트 (pushState)
- hash 파라미터 처리
- 앵커 스크롤

### init()
- URL 파라미터 우선 확인
- hash 파싱
- popstate 리스너 등록

---

## 📋 테스트 체크리스트

### 확장자 숨김
- [ ] .md 파일: 확장자 숨김
- [ ] .png 파일: 확장자 표시
- [ ] data-path 속성: 전체 경로 유지

### URL 업데이트
- [ ] 파일 클릭 → URL 변경
- [ ] UTF-8 인코딩 정상
- [ ] 한글 경로 지원
- [ ] 뒤로가기 동작

### 앵커 링크
- [ ] #heading URL 접속
- [ ] 자동 스크롤
- [ ] 부드러운 애니메이션
- [ ] 잘못된 앵커 처리

### 헤더 스타일
- [ ] 흰색 배경
- [ ] 검은색 굵은 텍스트
- [ ] 높이 축소
- [ ] 반응형 지원

---

**작성자**: Claude Code
**버전**: 1.0
