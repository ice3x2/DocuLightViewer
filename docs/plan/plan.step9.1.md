## Step 9.1: Clean URLs 구현 — .md 확장자 제거 및 원본 다운로드

작성일: 2025-10-27

### 한 줄 요약
사용자 경험 향상을 위해 URL에서 .md 확장자를 제거하고, .md 확장자로 접근 시 원본 파일을 다운로드하도록 구현한다.

---

## 목표

### Before (현재)
```
URL: http://localhost:3000/doc/guide/programming-samples.md
- .md 확장자가 노출됨
- 원본 다운로드와 렌더링 구분 없음
- URL이 직관적이지 않음
```

### After (개선)
```
렌더링: http://localhost:3000/doc/guide/programming-samples
다운로드: http://localhost:3000/doc/guide/programming-samples.md

- 깔끔한 URL
- 명확한 의도 구분
- 북마크/공유 친화적
```

---

## 구현 전략

### 전체 흐름도

```
사용자가 트리에서 "intro.md" 클릭
  ↓
[클라이언트] loadFile('/guide/intro.md') 호출
  ↓
[클라이언트] Clean URL 생성: /doc/guide/intro
  ↓
[클라이언트] history.pushState({ path: '/guide/intro.md' }, '', '/doc/guide/intro')
  ↓
[클라이언트] fetch('/api/raw?path=/guide/intro.md')
  ↓
[서버] 파일 내용 반환
  ↓
[클라이언트] 마크다운 렌더링


사용자가 브라우저에서 /doc/guide/intro.md 직접 입력
  ↓
[서버] GET /doc/*.md 라우트 매칭
  ↓
[서버] validatePath('/guide/intro.md')
  ↓
[서버] res.download(absolutePath)
  ↓
브라우저 다운로드 다이얼로그
```

---

## 상세 구현 계획

### Phase A: 클라이언트 수정 (public/js/app.js)

#### A1. URL 생성 로직 수정

**현재 코드 (Line 612 근처)**:
```javascript
async function loadFile(path) {
  const encodedPath = encodeURIComponent(path);
  window.history.pushState({ path }, '', `/doc/${encodedPath}`);
  // ...
}
```

**개선 코드**:
```javascript
async function loadFile(path) {
  // Clean URL 생성: .md 확장자 제거
  const cleanPath = path.replace(/\.md$/, '');
  const encodedCleanPath = encodeURIComponent(cleanPath);

  // History state에는 원본 경로 유지 (내부 처리용)
  window.history.pushState({
    path: path,           // '/guide/intro.md' (실제 파일 경로)
    cleanPath: cleanPath  // '/guide/intro' (URL 표시용)
  }, '', `/doc/${encodedCleanPath}`);

  // 파일 로드는 실제 경로 사용
  const actualPath = path.endsWith('.md') ? path : path + '.md';
  // ...
}
```

**수정 위치**:
- `loadFile()` 함수 (Line 600-620 예상)
- `window.history.pushState()` 호출부 모두

#### A2. URL 파싱 로직 수정

**현재 코드 (Line 741-742 근처)**:
```javascript
window.addEventListener('load', async () => {
  const pathname = window.location.pathname;
  const hash = window.location.hash.substring(1);

  if (pathname.startsWith('/doc/')) {
    const path = decodeURIComponent(pathname.replace('/doc/', ''));
    // ...
  }
});
```

**개선 코드**:
```javascript
window.addEventListener('load', async () => {
  const pathname = window.location.pathname;
  const hash = window.location.hash.substring(1);

  if (pathname.startsWith('/doc/')) {
    let path = decodeURIComponent(pathname.replace('/doc/', ''));

    // Clean URL이면 .md 확장자 추가
    if (path && !path.endsWith('.md')) {
      path = path + '.md';
    }

    // 빈 경로는 홈으로
    if (!path || path === '/') {
      return;
    }

    // 파일 로드
    await loadFile(path, hash);
  }
});
```

**수정 위치**:
- `window.addEventListener('load')` 핸들러
- `window.addEventListener('popstate')` 핸들러 (뒤로가기/앞으로가기)

#### A3. 공유 URL 생성 수정

**현재 코드 (Line 354 근처)**:
```javascript
const fullUrl = `${window.location.origin}/doc/${encodedPath}#${heading.id}`;
```

**개선 코드**:
```javascript
// .md 제거한 clean URL 생성
const cleanPath = currentPath.replace(/\.md$/, '');
const encodedCleanPath = encodeURIComponent(cleanPath);
const fullUrl = `${window.location.origin}/doc/${encodedCleanPath}#${heading.id}`;
```

#### A4. popstate 이벤트 핸들러 수정

**현재 코드**:
```javascript
window.addEventListener('popstate', async (event) => {
  if (event.state && event.state.path) {
    await loadFile(event.state.path, event.state.hash);
  }
});
```

**개선 (변경 없음)**:
- state에 실제 경로가 저장되어 있으므로 그대로 사용 가능
- 단, state가 없을 경우 URL에서 파싱 필요

---

### Phase B: 서버 수정 (src/app.js)

#### B1. 새 라우트 추가 (.md 다운로드)

**추가 위치**: `/doc/*` 라우트 **직전**

**코드**:
```javascript
// .md 확장자 포함 URL → 원본 파일 다운로드
app.get('/doc/*.md', async (req, res, next) => {
  try {
    const { config, logger } = req.app.locals;

    // URL에서 파일 경로 추출
    // 예: /doc/guide/intro.md → /guide/intro.md
    const filePath = req.path.replace('/doc', '');

    // 경로 검증 (path traversal 방지)
    const { validatePath } = require('./utils/path-validator');
    const absolutePath = validatePath(config.docsRoot, filePath);

    // 파일 존재 확인
    const fs = require('fs').promises;
    const stats = await fs.stat(absolutePath);

    if (!stats.isFile()) {
      const error = new Error('NOT_FOUND: Path is not a file');
      error.code = 'NOT_FOUND';
      throw error;
    }

    // 파일 다운로드
    const path = require('path');
    const filename = path.basename(filePath);

    logger.info('Raw file download', {
      path: filePath,
      filename: filename,
      size: stats.size
    });

    res.download(absolutePath, filename);
  } catch (error) {
    next(error);
  }
});

// .md 확장자 없는 URL → 문서 뷰어 렌더링 (기존)
app.get('/doc/*', (req, res) => {
  const cfg = req.app.locals.config || {};
  res.render('index', {
    title: 'DocuLight - Markdown Viewer',
    uiTitle: (cfg.ui && cfg.ui.title) || 'DocuLight',
    uiIcon: (cfg.ui && cfg.ui.icon) || '/images/icon.png'
  });
});
```

**중요**: 라우트 순서!
- Express는 **먼저 정의된 라우트를 우선 매칭**
- `/doc/*.md` (구체적) → `/doc/*` (일반적) 순서로 배치

#### B2. 라우트 위치 확인

**현재 구조** (src/app.js):
```javascript
// Line 91-99 근처
app.get('/doc/*', (req, res) => {
  const cfg = req.app.locals.config || {};
  res.render('index', {
    title: 'DocuLight - Markdown Viewer',
    uiTitle: (cfg.ui && cfg.ui.title) || 'DocuLight',
    uiIcon: (cfg.ui && cfg.ui.icon) || '/images/icon.png'
  });
});
```

**개선 구조**:
```javascript
// 새 라우트 추가 (먼저 정의)
app.get('/doc/*.md', async (req, res, next) => { /* ... */ });

// 기존 라우트 (나중에 매칭)
app.get('/doc/*', (req, res) => { /* ... */ });
```

---

### Phase C: API 문서 업데이트

#### C1. docs/api/api.md 업데이트

**추가 섹션**:
```markdown
### 7. 원본 파일 다운로드 (Clean URL 방식)

#### 브라우저에서 직접 다운로드

문서 URL에 `.md` 확장자를 추가하면 원본 파일이 다운로드됩니다.

**예시:**
- **렌더링**: `http://localhost:3000/doc/guide/setup`
- **다운로드**: `http://localhost:3000/doc/guide/setup.md`

**특징:**
- Content-Disposition: attachment 헤더 자동 설정
- 브라우저 다운로드 다이얼로그 표시
- 원본 파일명 유지

**vs REST API:**
- `/doc/*.md`: 브라우저 친화적 (다운로드 다이얼로그)
- `/api/raw`: 프로그래밍 친화적 (텍스트 응답)
```

#### C2. docs/api/api-curl-example.md 업데이트

**추가 섹션**:
```markdown
## 14. Clean URL 다운로드

### 14.1 브라우저 방식

```bash
# 렌더링 URL
http://localhost:3000/doc/guide/setup

# 다운로드 URL (확장자 추가)
http://localhost:3000/doc/guide/setup.md
```

### 14.2 cURL 다운로드

```bash
# .md 확장자 추가하여 원본 다운로드
curl "http://localhost:3000/doc/guide/setup.md" -o setup.md

# 여러 파일 다운로드
for doc in intro setup advanced; do
  curl "http://localhost:3000/doc/guide/$doc.md" -o "$doc.md"
done
```

### 14.3 vs REST API

| 방식 | URL | 용도 |
|------|-----|------|
| Clean URL | `/doc/path/file.md` | 브라우저 다운로드 |
| REST API | `/api/raw?path=/path/file.md` | API 호출 |

**REST API 장점:**
- 파일 내용을 텍스트로 바로 받음
- 프로그래밍 처리 용이
- 인증 불필요 (공개)

**Clean URL 장점:**
- 다운로드 다이얼로그 자동 표시
- 파일명 자동 설정
- 브라우저 친화적
```
```

---

## 구현 체크리스트

### 클라이언트 (public/js/app.js)

- [ ] **loadFile() 함수 수정**
  - [ ] Clean URL 생성 (.md 제거)
  - [ ] history.pushState에 cleanPath 저장
  - [ ] 실제 API 호출은 .md 포함

- [ ] **URL 파싱 수정**
  - [ ] window.load 이벤트 핸들러
  - [ ] Clean URL → .md 추가 로직
  - [ ] 빈 경로 처리

- [ ] **popstate 핸들러 확인**
  - [ ] 뒤로가기/앞으로가기 작동 확인
  - [ ] state.path 사용 확인

- [ ] **공유 URL 수정**
  - [ ] 헤딩 공유 시 clean URL 생성
  - [ ] 해시 유지

### 서버 (src/app.js)

- [ ] **다운로드 라우트 추가**
  - [ ] `app.get('/doc/*.md')` 구현
  - [ ] 경로 검증 (validatePath)
  - [ ] 파일 존재 확인
  - [ ] res.download() 호출
  - [ ] 에러 처리

- [ ] **라우트 순서 확인**
  - [ ] /doc/*.md가 /doc/* 보다 먼저 정의
  - [ ] start() 함수 내에서 올바른 위치

- [ ] **로깅 추가**
  - [ ] 다운로드 요청 로깅
  - [ ] 파일명, 크기 기록

### 문서

- [ ] **docs/api/api.md**
  - [ ] 원본 다운로드 섹션 추가
  - [ ] vs REST API 비교 추가

- [ ] **docs/api/api-curl-example.md**
  - [ ] Section 14 추가
  - [ ] cURL 예제
  - [ ] 비교 테이블

---

## 코드 변경 상세

### 1. 클라이언트: loadFile() 함수

**파일**: `public/js/app.js`

**현재 코드 찾기**:
```bash
grep -n "async function loadFile" public/js/app.js
grep -n "window.history.pushState.*path.*doc" public/js/app.js
```

**변경 전**:
```javascript
async function loadFile(path, hash = '') {
  try {
    currentPath = path;

    // Update URL
    const encodedPath = encodeURIComponent(path);
    let newUrl = `/doc/${encodedPath}`;
    if (hash) {
      newUrl += `#${hash}`;
    }
    window.history.pushState({ path, hash }, '', newUrl);

    // Fetch content
    const response = await fetch(`/api/raw?path=${encodeURIComponent(path)}`);
    // ...
  }
}
```

**변경 후**:
```javascript
async function loadFile(path, hash = '') {
  try {
    currentPath = path;

    // Clean URL 생성: .md 확장자 제거
    const cleanPath = path.replace(/\.md$/, '');
    const encodedCleanPath = encodeURIComponent(cleanPath);

    // URL 생성
    let newUrl = `/doc/${encodedCleanPath}`;
    if (hash) {
      newUrl += `#${hash}`;
    }

    // History state 업데이트
    window.history.pushState({
      path: path,           // 실제 파일 경로 (내부 사용)
      cleanPath: cleanPath, // Clean URL (표시용)
      hash: hash
    }, '', newUrl);

    // Fetch content (실제 경로 사용)
    const response = await fetch(`/api/raw?path=${encodeURIComponent(path)}`);
    // ...
  }
}
```

#### A2. URL 파싱 로직

**파일**: `public/js/app.js`

**현재 코드 (Line 741 근처)**:
```javascript
window.addEventListener('load', async () => {
  await initDB();
  await TreeManager.loadTree();

  const pathname = window.location.pathname;
  const hash = window.location.hash.substring(1);

  if (pathname.startsWith('/doc/')) {
    const path = decodeURIComponent(pathname.replace('/doc/', ''));
    if (path) {
      await loadFile(path, hash);
      return;
    }
  }

  // Load last opened file
  const lastPath = await getLastOpened();
  if (lastPath) {
    await loadFile(lastPath);
  }
});
```

**변경 후**:
```javascript
window.addEventListener('load', async () => {
  await initDB();
  await TreeManager.loadTree();

  const pathname = window.location.pathname;
  const hash = window.location.hash.substring(1);

  if (pathname.startsWith('/doc/')) {
    let path = decodeURIComponent(pathname.replace('/doc/', ''));

    // Clean URL 처리: .md 확장자 자동 추가
    if (path && !path.endsWith('.md')) {
      path = path + '.md';
    }

    // 빈 경로는 홈으로
    if (!path || path === '/' || path === '.md') {
      return;
    }

    // 파일 로드
    await loadFile(path, hash);
    return;
  }

  // Load last opened file
  const lastPath = await getLastOpened();
  if (lastPath) {
    await loadFile(lastPath);
  }
});
```

#### A3. 공유 링크 수정

**파일**: `public/js/app.js` (Line 354 근처)

**변경 전**:
```javascript
const encodedPath = encodeURIComponent(currentPath);
const fullUrl = `${window.location.origin}/doc/${encodedPath}#${heading.id}`;
```

**변경 후**:
```javascript
const cleanPath = currentPath.replace(/\.md$/, '');
const encodedCleanPath = encodeURIComponent(cleanPath);
const fullUrl = `${window.location.origin}/doc/${encodedCleanPath}#${heading.id}`;
```

---

### 2. 서버: 다운로드 라우트 추가

**파일**: `src/app.js`

**추가 위치**: Line 91 직전 (기존 `/doc/*` 라우트 앞)

**추가 코드**:
```javascript
// Raw file download route (must be before /doc/*)
app.get('/doc/*.md', async (req, res, next) => {
  try {
    const { config, logger } = req.app.locals;

    if (!config) {
      return res.status(503).json({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Server not initialized' }
      });
    }

    // Extract file path from URL
    // Example: /doc/guide/intro.md → /guide/intro.md
    const filePath = req.path.replace('/doc', '');

    if (!filePath || filePath === '/') {
      const error = new Error('INVALID_PATH: File path is required');
      error.code = 'INVALID_PATH';
      throw error;
    }

    // Validate path
    const { validatePath } = require('./utils/path-validator');
    const absolutePath = validatePath(config.docsRoot, filePath);

    // Check if file exists
    const fs = require('fs').promises;
    const path = require('path');

    let stats;
    try {
      stats = await fs.stat(absolutePath);
    } catch (error) {
      const notFoundError = new Error('NOT_FOUND: File does not exist');
      notFoundError.code = 'NOT_FOUND';
      throw notFoundError;
    }

    if (!stats.isFile()) {
      const error = new Error('NOT_FOUND: Path is not a file');
      error.code = 'NOT_FOUND';
      throw error;
    }

    // Log download
    logger.info('Raw file download via /doc/*.md', {
      path: filePath,
      filename: path.basename(filePath),
      size: stats.size
    });

    // Set download headers and send file
    res.download(absolutePath, path.basename(filePath));
  } catch (error) {
    next(error);
  }
});
```

**라우트 최종 순서**:
```javascript
// Line 67-79: Documentation portal routes
app.get('/api/doc', ...);
app.get('/mcp/doc', ...);
app.get('/api/documentation/:docType', ...);
app.get('/api/config/index', ...);

// Line 82-89: Main page
app.get('/', ...);

// 새로 추가 (Line 91 직전)
app.get('/doc/*.md', async (req, res, next) => { /* 다운로드 */ });

// 기존 (Line 92-99)
app.get('/doc/*', (req, res) => { /* 뷰어 렌더링 */ });
```

---

### 3. 에러 처리

#### 클라이언트 에러

**케이스 1**: Clean URL로 존재하지 않는 문서 접근
```javascript
// URL: /doc/nonexistent
// → /nonexistent.md로 변환
// → fetch('/api/raw?path=/nonexistent.md') 실패
// → ErrorHandler.showError() 호출
```

**처리**: 기존 에러 핸들러 활용

#### 서버 에러

**케이스 1**: .md URL로 디렉토리 접근
```javascript
// URL: /doc/guide.md (guide는 디렉토리)
// → validatePath 통과
// → stats.isFile() = false
// → throw NOT_FOUND
// → error-handler.js가 처리
```

**케이스 2**: .md URL로 존재하지 않는 파일 접근
```javascript
// URL: /doc/nonexistent.md
// → fs.stat() 실패
// → throw NOT_FOUND
```

**처리**: 기존 error-handler.js 활용

---

## 테스트 계획

### 수동 테스트

#### T1. Clean URL 렌더링
```bash
# 1. 서버 시작
npm run dev

# 2. 브라우저에서 접속
http://localhost:3000

# 3. 문서 클릭 → URL 확인
# 예상: http://localhost:3000/doc/guide/intro (✓ .md 없음)

# 4. 새로고침 → 문서 유지 확인

# 5. 뒤로가기 → 이전 문서로 이동
```

#### T2. 원본 다운로드
```bash
# 1. 브라우저 주소창에 입력
http://localhost:3000/doc/guide/intro.md

# 2. 다운로드 다이얼로그 확인
# 예상: intro.md 파일 다운로드 제안

# 3. 다운로드된 파일 확인
cat ~/Downloads/intro.md
```

#### T3. cURL 테스트
```bash
# Clean URL 접근 → HTML 응답
curl "http://localhost:3000/doc/guide/intro"

# .md URL 접근 → 원본 마크다운
curl "http://localhost:3000/doc/guide/intro.md"

# 비교
diff <(curl -s "http://localhost:3000/doc/guide/intro.md") \
     <(curl -s "http://localhost:3000/api/raw?path=/guide/intro.md")
# 예상: 동일한 내용
```

### 자동 테스트 (향후)

**파일**: `test/test-clean-urls.js`

```javascript
const app = require('../src/app');
const http = require('http');

describe('Clean URLs', () => {
  test('Clean URL should render viewer', async () => {
    const res = await request(app).get('/doc/guide/intro');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<!DOCTYPE html>');
  });

  test('.md URL should download file', async () => {
    const res = await request(app).get('/doc/guide/intro.md');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('intro.md');
  });

  test('Non-existent .md should return 404', async () => {
    const res = await request(app).get('/doc/nonexistent.md');
    expect(res.status).toBe(404);
  });
});
```

---

## 엣지 케이스 처리

### Case 1: 루트 문서
```
URL: /doc/README
→ /README.md 파일 로드

URL: /doc/README.md
→ README.md 다운로드
```

### Case 2: 중첩 경로
```
URL: /doc/guide/advanced/configuration
→ /guide/advanced/configuration.md 파일 로드

URL: /doc/guide/advanced/configuration.md
→ configuration.md 다운로드
```

### Case 3: 한글 파일명
```
URL: /doc/가이드/설치
→ /가이드/설치.md 파일 로드 (UTF-8 인코딩)

URL: /doc/가이드/설치.md
→ 설치.md 다운로드 (UTF-8 파일명 지원)
```

### Case 4: 특수문자
```
URL: /doc/guide/C%23%20Programming
→ decodeURIComponent → /guide/C# Programming.md

URL: /doc/guide/C%23%20Programming.md
→ C# Programming.md 다운로드
```

### Case 5: 디렉토리 접근
```
URL: /doc/guide
→ 현재는 뷰어 렌더링 (404 표시)
→ 향후 Step 9.2에서 폴더 리스트로 개선
```

---

## 보안 검증

### 1. Path Traversal 방지

**공격 시나리오**:
```
URL: /doc/../../../etc/passwd.md
```

**방어**:
```javascript
const absolutePath = validatePath(config.docsRoot, filePath);
// → Error: PATH_TRAVERSAL (docsRoot 범위 벗어남)
```

### 2. 파일 타입 제한 (선택적)

**옵션**: .md 파일만 다운로드 허용

```javascript
if (!filePath.endsWith('.md')) {
  const error = new Error('UNSUPPORTED_TYPE: Only .md files allowed');
  error.code = 'UNSUPPORTED_TYPE';
  throw error;
}
```

**현재 결정**: 제한하지 않음
- 이유: 이미지 등 다른 파일도 다운로드 가능하게
- validatePath()로 범위 보안 충분

---

## 성능 영향

### 클라이언트
- **URL 처리 오버헤드**: ~1ms (문자열 replace 연산)
- **영향**: 무시할 수 있는 수준

### 서버
- **라우트 매칭**: Express의 경로 패턴 매칭 (~0.1ms)
- **파일 다운로드**: 기존 /api/raw와 동일
- **영향**: 없음

### 네트워크
- **URL 길이**: .md 제거로 3-4 바이트 감소
- **영향**: 무시할 수 있음

---

## 롤백 계획

### 문제 발생 시

**증상**: URL 변경 후 문서 로드 실패

**롤백 절차**:
1. `public/js/app.js`에서 URL 처리 코드 원복
2. `src/app.js`에서 `/doc/*.md` 라우트 제거
3. 서버 재시작
4. 브라우저 캐시 클리어

**롤백 시간**: ~5분

---

## 마무리

### 완료 조건
- [ ] 모든 체크리스트 완료
- [ ] 수동 테스트 통과
- [ ] 문서 업데이트 완료
- [ ] 로그 확인 (에러 없음)

### 다음 단계
- Step 9.1 구현 완료 후 → Step 9.2 (폴더 UI 개선)으로 진행

---

**상태**: 상세 계획 완료, 구현 시작 가능
**예상 소요 시간**: 2.0시간
**우선순위**: P0 (긴급)
