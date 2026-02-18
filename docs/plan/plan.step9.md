## Step 9: UI/UX 개선 — Clean URLs 및 Docusaurus 스타일 네비게이션

작성일: 2025-10-27

### 한 줄 요약
사용자 경험 향상을 위해 (1) Clean URLs (.md 확장자 제거), (2) 개선된 폴더 UI (삼각형 토글 + 리스트 뷰), (3) 문서 네비게이션 (이전/다음), (4) Wiki 링크 [[]] 지원, (5) 이미지 렌더링 검증을 구현한다.

---

## 목표 및 요구사항

### 1. Clean URLs 및 원본 다운로드 구분

#### 현재 상태
- URL 형식: `http://localhost:3000/doc/guide/programming-samples.md`
- .md 확장자가 URL에 그대로 노출됨
- 사용자 경험이 직관적이지 않음

#### 목표
- **Clean URL**: `http://localhost:3000/doc/guide/programming-samples`
- **원본 다운로드**: `http://localhost:3000/doc/guide/programming-samples.md` 접근 시 파일 다운로드
- **API 일관성**: REST API (`/api/raw`) 동작과 구분

#### 구현 전략
1. **클라이언트 URL 변경**:
   - 파일 클릭 시 `.md` 확장자 제거한 URL로 히스토리 푸시
   - `window.history.pushState()` 수정
   - 브라우저 뒤로가기/앞으로가기 지원

2. **서버 라우팅 변경**:
   - `/doc/*` 경로 처리 로직 수정
   - `.md` 확장자 유무로 렌더링/다운로드 구분
   - 새 라우트 추가: `GET /doc/*.md` → 원본 다운로드

3. **파일 해석 로직**:
   ```javascript
   // URL: /doc/guide/programming-samples
   // → 내부적으로 /guide/programming-samples.md 파일 로드하여 렌더링

   // URL: /doc/guide/programming-samples.md
   // → Content-Disposition: attachment로 원본 다운로드
   ```

#### 에지 케이스 처리
- `/doc/README` → `/README.md` 파일 렌더링
- `/doc/guide` → 디렉토리 리스트 표시 (요구사항 2와 연계)
- `/doc/guide/` → 동일하게 디렉토리 리스트
- 존재하지 않는 경로 → 404 페이지

---

### 2. 폴더 UI 개선 (Docusaurus 스타일)

#### 현재 상태
- 폴더에 📁 아이콘 표시
- 클릭 시 트리 확장/축소만 가능
- 폴더 내용물을 직접 볼 수 없음

#### 목표
- **삼각형 토글**: ▶/▼ 아이콘으로 트리 확장/축소
- **폴더 클릭**: 하위 문서 리스트를 메인 영역에 표시
- **동적 리스트**: 폴더 클릭 시 동적으로 마크다운 생성하여 표시
- **UI 분리**:
  - 토글 클릭 → 트리만 확장/축소
  - 폴더명 클릭 → 리스트 뷰 표시

#### 구현 전략

**1) HTML/CSS 변경**:
```html
<!-- 기존 -->
<div class="tree-item">
  <span class="folder-icon">📁</span>
  <span class="folder-name">guide</span>
</div>

<!-- 개선 -->
<div class="tree-item">
  <span class="toggle-icon" onclick="toggleFolder()">▶</span>
  <span class="folder-name" onclick="showFolderList()">guide</span>
  <div class="children collapsed"></div>
</div>
```

**2) 동적 리스트 생성**:
```javascript
async function showFolderList(folderPath) {
  // 1. API로 폴더 내용 조회
  const tree = await fetch(`/api/tree?path=${folderPath}`);

  // 2. 마크다운 형식으로 변환
  const markdown = `
# ${folderName}

## Documents

${files.map(f => `- [${f.name}](${f.path})`).join('\n')}

## Subdirectories

${dirs.map(d => `- [${d.name}/](${d.path})`).join('\n')}
  `;

  // 3. 렌더링
  renderMarkdown(markdown);
}
```

**3) 스타일링**:
- Docusaurus 스타일: 심플한 흰 배경
- 리스트 아이템: 클릭 가능한 링크
- 하위 디렉토리 구분 표시

#### CSS 예시
```css
.toggle-icon {
  display: inline-block;
  width: 20px;
  cursor: pointer;
  transition: transform 0.2s;
}

.toggle-icon.expanded {
  transform: rotate(90deg);
}

.folder-name {
  cursor: pointer;
  color: #0969da;
}

.folder-name:hover {
  text-decoration: underline;
}

.folder-list {
  background: white;
  padding: 20px;
  line-height: 1.6;
}

.folder-list ul {
  list-style: none;
  padding-left: 0;
}

.folder-list li {
  padding: 8px 0;
  border-bottom: 1px solid #eee;
}
```

---

### 3. 문서 네비게이션 (이전/다음)

#### 목표
- 문서 하단에 이전/다음 문서 링크 추가
- Docusaurus 스타일의 네비게이션
- 현재 문서의 위치 기반으로 자동 계산

#### 구현 전략

**1) 네비게이션 계산**:
```javascript
function calculateNavigation(currentPath, treeData) {
  // 1. 전체 파일 리스트를 평면화
  const allFiles = flattenTree(treeData);

  // 2. 현재 파일 인덱스 찾기
  const currentIndex = allFiles.findIndex(f => f.path === currentPath);

  // 3. 이전/다음 파일 결정
  const prev = currentIndex > 0 ? allFiles[currentIndex - 1] : null;
  const next = currentIndex < allFiles.length - 1 ? allFiles[currentIndex + 1] : null;

  return { prev, next };
}
```

**2) HTML 추가**:
```html
<!-- 문서 콘텐츠 하단 -->
<hr class="doc-separator">
<nav class="doc-navigation">
  <div class="nav-prev">
    ${prev ? `<a href="/doc/${prev.path}">← ${prev.name}</a>` : ''}
  </div>
  <div class="nav-next">
    ${next ? `<a href="/doc/${next.path}">${next.name} →</a>` : ''}
  </div>
</nav>
```

**3) CSS 스타일**:
```css
.doc-separator {
  margin: 40px 0 20px 0;
  border: none;
  border-top: 1px solid #ddd;
}

.doc-navigation {
  display: flex;
  justify-content: space-between;
  padding: 20px 0;
  font-size: 16px;
}

.nav-prev, .nav-next {
  flex: 1;
}

.nav-next {
  text-align: right;
}

.doc-navigation a {
  color: #0969da;
  text-decoration: none;
  padding: 10px 16px;
  border: 1px solid #ddd;
  border-radius: 6px;
  display: inline-block;
}

.doc-navigation a:hover {
  background-color: #f6f8fa;
}
```

#### 네비게이션 순서
- **깊이 우선 탐색(DFS)** 순서로 파일 정렬
- 디렉토리 내 파일은 알파벳순
- 하위 디렉토리 재귀

---

### 4. Wiki 링크 [[]] 지원

#### 목표
- Obsidian/Roam 스타일의 `[[문서명]]` 링크 지원
- 렌더링 시 깔끔한 표시 (경로 숨김)
- 클릭 시 해당 문서로 이동

#### 구현 전략

**1) 파싱 규칙**:
```
입력: [[/guide/advanced/configuration]]
출력 (렌더링): <a href="/doc/guide/advanced/configuration">configuration</a>

입력: [[/README]]
출력: <a href="/doc/README">README</a>

입력: [[상대경로도 지원하려면?]]
출력: 현재는 절대 경로만 지원 (향후 개선)
```

**2) 정규식 패턴**:
```javascript
const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;

function parseWikiLinks(markdown) {
  return markdown.replace(wikiLinkPattern, (match, path) => {
    // 경로에서 파일명 추출
    const filename = path.split('/').pop().replace(/\.md$/, '');

    // Clean URL 생성
    const cleanPath = path.replace(/\.md$/, '');

    return `[${filename}](/doc${cleanPath})`;
  });
}
```

**3) 렌더링 파이프라인**:
```
원본 마크다운
  ↓
1. Wiki 링크 파싱 [[]] → []()
  ↓
2. 표준 마크다운 파싱 (marked.js)
  ↓
3. HTML 렌더링
  ↓
4. DOMPurify 정제
  ↓
출력
```

**4) 구현 위치**:
- 클라이언트: `public/js/app.js`의 렌더링 함수에 전처리 추가
- 서버: 필요 없음 (클라이언트 렌더링)

---

### 5. 이미지 렌더링 검증

#### 목표
- 마크다운 이미지 구문 `![alt](path)` 정상 작동 확인
- 상대 경로 및 절대 경로 지원
- 이미지 로딩 에러 처리

#### 검증 케이스

**1) 절대 경로**:
```markdown
![Logo](/images/logo.png)
→ <img src="/images/logo.png" alt="Logo">
```

**2) 상대 경로**:
```markdown
현재 문서: /guide/intro.md
![Screenshot](../images/screenshot.png)
→ <img src="/images/screenshot.png" alt="Screenshot">
```

**3) 외부 URL**:
```markdown
![External](https://example.com/image.png)
→ <img src="https://example.com/image.png" alt="External">
```

#### 이미지 경로 해석

**서버 제공**:
- Static 파일: `/public/images/` → `http://localhost:3000/images/`
- 문서 내 이미지: `/docs/images/` → `/api/raw?path=/images/file.png` (공개)

**경로 변환 로직**:
```javascript
function resolveImagePath(imagePath, currentDocPath) {
  // 절대 경로
  if (imagePath.startsWith('/')) {
    return imagePath;
  }

  // HTTP/HTTPS URL
  if (imagePath.startsWith('http')) {
    return imagePath;
  }

  // 상대 경로 해석
  const docDir = currentDocPath.split('/').slice(0, -1).join('/');
  return path.resolve(docDir, imagePath);
}
```

#### 테스트 전략
- 테스트 문서 생성 (`test-source/test-images.md`)
- 다양한 이미지 경로 패턴 포함
- Playwright MCP로 자동 테스트

---

## 상세 구현 계획

### Phase 1: Clean URLs (우선순위: P0)

#### 1.1 클라이언트 수정
**파일**: `public/js/app.js`

**변경 사항**:
```javascript
// 기존: loadFile() 함수
async function loadFile(path) {
  const encodedPath = encodeURIComponent(path);
  window.history.pushState({ path }, '', `/doc/${encodedPath}`); // .md 포함
  // ...
}

// 개선: loadFile() 함수
async function loadFile(path) {
  // Clean URL: .md 제거
  const cleanPath = path.replace(/\.md$/, '');
  const encodedPath = encodeURIComponent(cleanPath);
  window.history.pushState({ path: cleanPath }, '', `/doc/${encodedPath}`);

  // 실제 파일은 .md 포함하여 요청
  const actualPath = path.endsWith('.md') ? path : path + '.md';
  const response = await fetch(`/api/raw?path=${actualPath}`);
  // ...
}
```

**수정 지점**:
- Line 612: `window.history.pushState()`
- Line 741-742: URL 파싱 로직
- Line 354: 공유 URL 생성

#### 1.2 서버 라우팅 수정
**파일**: `src/app.js`

**새 라우트 추가**:
```javascript
// .md 확장자가 있는 경로 → 원본 다운로드
app.get('/doc/*.md', async (req, res, next) => {
  try {
    const filePath = req.path.replace('/doc', '');
    const { config, logger } = req.app.locals;

    const absolutePath = validatePath(config.docsRoot, filePath);

    // Content-Disposition: attachment 헤더 추가
    res.download(absolutePath, path.basename(filePath));
  } catch (error) {
    next(error);
  }
});

// .md 확장자가 없는 경로 → 렌더링 (기존 동작)
app.get('/doc/*', (req, res) => {
  const cfg = req.app.locals.config || {};
  res.render('index', {
    title: 'DocuLight - Markdown Viewer',
    uiTitle: (cfg.ui && cfg.ui.title) || 'DocuLight',
    uiIcon: (cfg.ui && cfg.ui.icon) || '/images/icon.png'
  });
});
```

**라우트 순서**:
1. `/doc/*.md` (구체적) → 먼저 매칭
2. `/doc/*` (일반적) → 나중에 매칭

#### 1.3 API 문서 업데이트
**파일**: `docs/api/api.md`, `docs/api/api-curl-example.md`

**추가 내용**:
```markdown
### 원본 파일 다운로드

브라우저에서 .md 확장자를 포함한 URL로 접근하면 원본 파일이 다운로드됩니다:

**예시:**
- 렌더링: http://localhost:3000/doc/guide/setup
- 다운로드: http://localhost:3000/doc/guide/setup.md

**cURL:**
```bash
# 원본 마크다운 다운로드
curl "http://localhost:3000/doc/guide/setup.md" -o setup.md
```
```

---

### Phase 2: 폴더 UI 개선 (우선순위: P0)

#### 2.1 트리 아이템 HTML 구조 변경
**파일**: `public/js/app.js` - TreeManager 부분

**기존 구조**:
```javascript
function createTreeItem(item, parentPath, level) {
  if (item.isDirectory) {
    return `
      <div class="tree-item folder" data-path="${fullPath}">
        <span class="folder-icon">📁</span>
        <span class="folder-name">${item.name}</span>
      </div>
    `;
  }
}
```

**개선 구조**:
```javascript
function createTreeItem(item, parentPath, level) {
  if (item.isDirectory) {
    return `
      <div class="tree-item folder" data-path="${fullPath}">
        <span class="toggle-icon" data-action="toggle">▶</span>
        <span class="folder-name" data-action="list">${item.name}</span>
        <div class="children collapsed"></div>
      </div>
    `;
  }
}
```

#### 2.2 이벤트 핸들러 분리
```javascript
// 토글 클릭
document.addEventListener('click', (e) => {
  if (e.target.dataset.action === 'toggle') {
    const item = e.target.closest('.tree-item');
    toggleFolder(item);
  }
});

// 폴더명 클릭
document.addEventListener('click', (e) => {
  if (e.target.dataset.action === 'list') {
    const item = e.target.closest('.tree-item');
    const folderPath = item.dataset.path;
    showFolderList(folderPath);
  }
});

// 토글 함수
function toggleFolder(item) {
  const icon = item.querySelector('.toggle-icon');
  const children = item.querySelector('.children');

  if (children.classList.contains('collapsed')) {
    icon.textContent = '▼';
    children.classList.remove('collapsed');
    saveTreeState(item.dataset.path, true);
  } else {
    icon.textContent = '▶';
    children.classList.add('collapsed');
    saveTreeState(item.dataset.path, false);
  }
}

// 폴더 리스트 표시
async function showFolderList(folderPath) {
  try {
    const response = await fetch(`/api/tree?path=${folderPath}`);
    const data = await response.json();

    // 동적 마크다운 생성
    const markdown = generateFolderListMarkdown(data);

    // 렌더링
    FileViewer.renderContent(markdown, folderPath);

    // URL 업데이트
    const cleanPath = folderPath.replace(/\/$/, '');
    window.history.pushState({ path: cleanPath, type: 'folder' }, '', `/doc${cleanPath}`);
  } catch (error) {
    ErrorHandler.showError('Failed to load folder', error.message);
  }
}

// 마크다운 생성
function generateFolderListMarkdown(treeData) {
  const folderName = treeData.path.split('/').pop() || 'Root';

  let md = `# 📂 ${folderName}\n\n`;

  // 하위 디렉토리
  if (treeData.dirs && treeData.dirs.length > 0) {
    md += `## Subdirectories\n\n`;
    for (const dir of treeData.dirs) {
      md += `- **[${dir.name}/](/doc${treeData.path}/${dir.name})**\n`;
    }
    md += '\n';
  }

  // 문서 파일
  if (treeData.files && treeData.files.length > 0) {
    md += `## Documents\n\n`;
    for (const file of treeData.files) {
      const displayName = file.name.replace(/\.md$/, '');
      md += `- [${displayName}](/doc${treeData.path}/${displayName})\n`;
    }
  }

  // 빈 폴더
  if ((!treeData.dirs || treeData.dirs.length === 0) &&
      (!treeData.files || treeData.files.length === 0)) {
    md += `\n*This folder is empty.*\n`;
  }

  return md;
}
```

#### 2.3 CSS 스타일 추가
**파일**: `public/css/style.css`

```css
/* 토글 아이콘 */
.toggle-icon {
  display: inline-block;
  width: 16px;
  height: 16px;
  margin-right: 4px;
  cursor: pointer;
  user-select: none;
  transition: transform 0.2s ease;
  font-size: 12px;
}

.toggle-icon.expanded {
  transform: rotate(90deg);
}

/* 폴더명 */
.folder-name {
  cursor: pointer;
  color: #0969da;
  font-weight: 500;
}

.folder-name:hover {
  text-decoration: underline;
}

/* 자식 요소 */
.children {
  padding-left: 20px;
  max-height: 10000px;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

.children.collapsed {
  max-height: 0;
  overflow: hidden;
}

/* 폴더 리스트 뷰 */
.folder-list-view h1 {
  font-size: 28px;
  margin-bottom: 20px;
  color: #1a1a1a;
}

.folder-list-view h2 {
  font-size: 20px;
  margin-top: 30px;
  margin-bottom: 15px;
  color: #444;
  border-bottom: 1px solid #eee;
  padding-bottom: 8px;
}

.folder-list-view ul {
  list-style: none;
  padding-left: 0;
}

.folder-list-view li {
  padding: 10px 0;
  border-bottom: 1px solid #f0f0f0;
}

.folder-list-view li:last-child {
  border-bottom: none;
}

.folder-list-view a {
  color: #0969da;
  text-decoration: none;
  font-size: 16px;
}

.folder-list-view a:hover {
  text-decoration: underline;
}
```

---

### Phase 3: 문서 네비게이션 (우선순위: P1)

#### 3.1 전체 파일 리스트 관리
**파일**: `public/js/app.js`

**글로벌 상태 추가**:
```javascript
// 전체 파일 리스트 (평면화)
let flatFileList = [];

// 트리 로드 시 평면화
async function loadTree() {
  const tree = await TreeManager.loadTree();

  // DFS로 평면화
  flatFileList = flattenTreeToDFS(tree);

  TreeManager.render(tree);
}

// DFS 평면화 함수
function flattenTreeToDFS(node, result = []) {
  // 현재 디렉토리의 파일 추가
  if (node.files) {
    for (const file of node.files) {
      result.push({
        path: file.path || `${node.path}/${file.name}`,
        name: file.name
      });
    }
  }

  // 하위 디렉토리 재귀
  if (node.dirs) {
    for (const dir of node.dirs) {
      flattenTreeToDFS(dir, result);
    }
  }

  return result;
}
```

#### 3.2 네비게이션 HTML 추가
**파일**: `public/js/app.js` - FileViewer.renderContent()

```javascript
// 기존 렌더링 후 네비게이션 추가
function renderContent(markdown, currentPath) {
  // 마크다운 렌더링
  const html = marked.parse(markdown);
  const sanitized = DOMPurify.sanitize(html);

  // 네비게이션 계산
  const nav = calculateNavigation(currentPath);

  // 네비게이션 HTML 추가
  const navHtml = `
    <hr class="doc-separator">
    <nav class="doc-navigation">
      <div class="nav-prev">
        ${nav.prev ? `<a href="/doc${nav.prev.path.replace(/\.md$/, '')}">
          <span class="nav-label">← Previous</span>
          <span class="nav-title">${nav.prev.name.replace(/\.md$/, '')}</span>
        </a>` : ''}
      </div>
      <div class="nav-next">
        ${nav.next ? `<a href="/doc${nav.next.path.replace(/\.md$/, '')}">
          <span class="nav-label">Next →</span>
          <span class="nav-title">${nav.next.name.replace(/\.md$/, '')}</span>
        </a>` : ''}
      </div>
    </nav>
  `;

  contentDiv.innerHTML = sanitized + navHtml;

  // Mermaid 재실행
  mermaid.run();
}
```

---

### Phase 4: Wiki 링크 [[]] (우선순위: P1)

#### 4.1 전처리 함수 추가
**파일**: `public/js/app.js`

```javascript
/**
 * Wiki 링크 [[path]] → [name](url) 변환
 */
function preprocessWikiLinks(markdown) {
  const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;

  return markdown.replace(wikiLinkPattern, (match, fullPath) => {
    // 경로 정규화
    let cleanPath = fullPath.trim();

    // .md 제거 (있다면)
    cleanPath = cleanPath.replace(/\.md$/, '');

    // 파일명 추출 (표시용)
    const parts = cleanPath.split('/').filter(p => p);
    const displayName = parts[parts.length - 1] || cleanPath;

    // Clean URL 생성
    const url = `/doc${cleanPath.startsWith('/') ? cleanPath : '/' + cleanPath}`;

    return `[${displayName}](${url})`;
  });
}

// 렌더링 파이프라인에 통합
async function renderMarkdown(rawContent, currentPath) {
  // 1. Wiki 링크 전처리
  const preprocessed = preprocessWikiLinks(rawContent);

  // 2. 마크다운 파싱
  const html = marked.parse(preprocessed);

  // 3. 정제
  const sanitized = DOMPurify.sanitize(html);

  // 4. DOM에 추가
  // ...
}
```

#### 4.2 테스트 케이스
```markdown
# Test Wiki Links

## 절대 경로
- [[/guide/intro]]
- [[/README]]
- [[/guide/advanced/configuration]]

## 확장자 포함 (자동 제거)
- [[/guide/setup.md]]

## 예상 결과
- [intro](/doc/guide/intro)
- [README](/doc/README)
- [configuration](/doc/guide/advanced/configuration)
- [setup](/doc/guide/setup)
```

---

### Phase 5: 이미지 렌더링 검증 (우선순위: P2)

#### 5.1 이미지 경로 처리

**현재 상태 확인**:
- marked.js가 이미지를 파싱하는지 확인
- 상대 경로 처리 여부

**개선 (필요시)**:
```javascript
// marked renderer 커스터마이징
const renderer = new marked.Renderer();

renderer.image = function(href, title, text) {
  // 상대 경로 해석
  if (!href.startsWith('http') && !href.startsWith('/')) {
    const currentDir = getCurrentDocumentPath().split('/').slice(0, -1).join('/');
    href = path.join(currentDir, href);
  }

  return `<img src="${href}" alt="${text}" title="${title || ''}" loading="lazy">`;
};

marked.setOptions({ renderer });
```

#### 5.2 테스트 문서 생성
**파일**: `test-source/test-images.md`

```markdown
# 이미지 렌더링 테스트

## 1. 절대 경로
![Logo](/images/icon.png)

## 2. 상대 경로
![Screenshot](../images/screenshot.png)

## 3. 외부 URL
![Example](https://via.placeholder.com/150)

## 4. 제목 포함
![Alt Text](/images/test.png "Image Title")

## 5. 존재하지 않는 이미지
![Missing](nonexistent.png)
```

#### 5.3 Playwright MCP 테스트
```javascript
// test-images.spec.js
test('이미지 렌더링', async ({ page }) => {
  await page.goto('http://localhost:3000/doc/test-images');

  // 이미지 요소 확인
  const images = await page.locator('img').all();
  expect(images.length).toBeGreaterThan(0);

  // 첫 번째 이미지 로드 확인
  const firstImg = images[0];
  await expect(firstImg).toBeVisible();

  // src 속성 확인
  const src = await firstImg.getAttribute('src');
  expect(src).toBeTruthy();
});
```

---

## 구현 순서 및 일정

### 우선순위 기준
- **P0 (긴급)**: Clean URLs, 폴더 UI
- **P1 (중요)**: 문서 네비게이션, Wiki 링크
- **P2 (일반)**: 이미지 테스트

### 단계별 일정

#### Step 9.1: Clean URLs (예상: 2.0h)
- [X] 클라이언트 URL 처리 수정 (1.0h)
  - loadFile() 함수 수정
  - URL 파싱 로직 수정
  - 공유 URL 수정
- [X] 서버 라우팅 추가 (0.5h)
  - /doc/*.md 라우트 추가
  - 원본 다운로드 로직
- [X] API 문서 업데이트 (0.5h)
  - api.md 업데이트
  - curl 예제 추가

#### Step 9.2: 폴더 UI 개선 (예상: 3.0h)
- [X] HTML 구조 변경 (1.0h)
  - 삼각형 아이콘 추가
  - data-action 속성
- [X] 이벤트 핸들러 구현 (1.0h)
  - 토글 이벤트
  - 폴더 클릭 이벤트
  - 동적 리스트 생성
- [X] CSS 스타일링 (1.0h)
  - Docusaurus 스타일 적용
  - 애니메이션
  - 반응형

#### Step 9.3: 문서 네비게이션 (예상: 2.0h)
- [ ] 평면화 로직 구현 (0.5h)
  - DFS 순회
  - 전역 상태 관리
- [ ] 네비게이션 계산 (0.5h)
  - 이전/다음 찾기
- [ ] HTML/CSS 추가 (1.0h)
  - 네비게이션 바
  - 스타일링

#### Step 9.4: Wiki 링크 [[]] (예상: 1.5h)
- [ ] 파싱 함수 구현 (0.5h)
  - 정규식 패턴
  - 경로 변환
- [ ] 렌더링 파이프라인 통합 (0.5h)
  - 전처리 단계 추가
- [ ] 테스트 (0.5h)
  - 다양한 패턴9

#### Step 9.5: 이미지 테스트 (예상: 1.0h)
- [ ] 테스트 문서 생성 (0.3h)
- [ ] Playwright 테스트 작성 (0.4h)
- [ ] 검증 및 수정 (0.3h)

**총 예상 시간**: 9.5시간

---

## 보안 고려사항

### 1. 경로 검증 강화
- Clean URL → 파일 경로 변환 시 검증 필수
- `.md` 자동 추가 시 path traversal 공격 방지
- `validatePath()` 유틸리티 사용

### 2. XSS 방지
- Wiki 링크 파싱 시 사용자 입력 검증
- DOMPurify로 정제 유지

### 3. 다운로드 보안
- `/doc/*.md` 라우트에서도 경로 검증
- docsRoot 범위 확인

---

## 성능 고려사항

### 1. 폴더 리스트 캐싱
- 동일 폴더 재클릭 시 API 재호출 방지
- IndexedDB에 폴더 트리 캐시

### 2. 네비게이션 계산 최적화
- 평면화된 리스트를 메모리에 유지
- 트리 재로드 시에만 재계산

### 3. 이미지 로딩 최적화
- `loading="lazy"` 속성 추가
- 썸네일 지원 (향후)

---

## 테스트 전략

### 자동화 테스트 (Playwright MCP)

#### 테스트 케이스 1: Clean URLs
```javascript
test('Clean URLs - .md 확장자 제거', async ({ page }) => {
  await page.goto('http://localhost:3000');

  // 문서 클릭
  await page.click('text=programming-samples');

  // URL 확인
  expect(page.url()).toBe('http://localhost:3000/doc/guide/programming-samples');
  expect(page.url()).not.toContain('.md');
});

test('원본 다운로드 - .md 확장자 포함', async ({ page }) => {
  const downloadPromise = page.waitForEvent('download');
  await page.goto('http://localhost:3000/doc/guide/programming-samples.md');

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('programming-samples.md');
});
```

#### 테스트 케이스 2: 폴더 UI
```javascript
test('폴더 토글 - 삼각형 클릭', async ({ page }) => {
  await page.goto('http://localhost:3000');

  // 토글 아이콘 클릭
  const toggle = page.locator('.toggle-icon').first();
  await toggle.click();

  // 확장 확인
  expect(await toggle.textContent()).toBe('▼');

  // 다시 클릭 → 축소
  await toggle.click();
  expect(await toggle.textContent()).toBe('▶');
});

test('폴더 리스트 뷰 - 폴더명 클릭', async ({ page }) => {
  await page.goto('http://localhost:3000');

  // 폴더명 클릭
  await page.click('.folder-name:has-text("guide")');

  // 리스트 뷰 표시 확인
  await expect(page.locator('h1:has-text("guide")')).toBeVisible();
  await expect(page.locator('h2:has-text("Documents")')).toBeVisible();
});
```

#### 테스트 케이스 3: 문서 네비게이션
```javascript
test('이전/다음 문서 네비게이션', async ({ page }) => {
  await page.goto('http://localhost:3000/doc/guide/intro');

  // 다음 버튼 확인
  const nextBtn = page.locator('.nav-next a');
  await expect(nextBtn).toBeVisible();

  // 클릭
  await nextBtn.click();

  // URL 변경 확인
  expect(page.url()).not.toBe('http://localhost:3000/doc/guide/intro');

  // 이전 버튼 확인
  const prevBtn = page.locator('.nav-prev a');
  await expect(prevBtn).toBeVisible();
});
```

#### 테스트 케이스 4: Wiki 링크
```javascript
test('Wiki 링크 [[]] 렌더링', async ({ page }) => {
  // 테스트 문서 생성 (setup 필요)
  await page.goto('http://localhost:3000/doc/test-wiki-links');

  // Wiki 링크가 일반 링크로 변환되었는지 확인
  const link = page.locator('a:has-text("configuration")');
  await expect(link).toBeVisible();

  const href = await link.getAttribute('href');
  expect(href).toBe('/doc/guide/advanced/configuration');
});
```

#### 테스트 케이스 5: 이미지 렌더링
```javascript
test('이미지 렌더링 - 절대 경로', async ({ page }) => {
  await page.goto('http://localhost:3000/doc/test-images');

  // 이미지 로드 확인
  const img = page.locator('img[alt="Logo"]');
  await expect(img).toBeVisible();

  // src 확인
  const src = await img.getAttribute('src');
  expect(src).toBe('/images/icon.png');
});

test('이미지 렌더링 - 상대 경로', async ({ page }) => {
  await page.goto('http://localhost:3000/doc/guide/intro');

  // 상대 경로 이미지
  const img = page.locator('img[alt="Screenshot"]');
  await expect(img).toBeVisible();

  // 경로가 해석되었는지 확인
  const src = await img.getAttribute('src');
  expect(src).not.toContain('../');
});
```

### 수동 테스트 체크리스트

- [X] **Clean URLs**
  - [X] 문서 클릭 → URL에 .md 없음
  - [X] .md 포함 URL → 다운로드 다이얼로그
  - [X] 뒤로가기/앞으로가기 작동
  - [X] 새로고침 시 같은 문서 표시

- [X] **폴더 UI**
  - [X] 삼각형 아이콘 표시
  - [X] 토글 클릭 → 트리 확장/축소
  - [X] 폴더명 클릭 → 리스트 뷰
  - [X] 리스트 뷰에서 문서 클릭 → 문서 렌더링

- [ ] **네비게이션**
  - [ ] 첫 문서 → 이전 버튼 없음
  - [ ] 마지막 문서 → 다음 버튼 없음
  - [ ] 중간 문서 → 양쪽 버튼 표시
  - [ ] 버튼 클릭 → 올바른 문서 이동

- [ ] **Wiki 링크**
  - [ ] [[/path/to/doc]] → [doc](/doc/path/to/doc)
  - [ ] [[/path/to/doc.md]] → [doc](/doc/path/to/doc)
  - [ ] 링크 클릭 → 문서 로드

- [ ] **이미지**
  - [ ] 절대 경로 (`/images/icon.png`)
  - [ ] 상대 경로 (`../images/test.png`)
  - [ ] 외부 URL
  - [ ] 이미지 로딩 실패 시 alt 텍스트

---

## 파일 수정 목록

### 서버 측
- `src/app.js`
  - `/doc/*.md` 라우트 추가 (원본 다운로드)
  - 라우트 순서 조정

### 클라이언트 측
- `public/js/app.js`
  - URL 처리 로직 수정 (Clean URLs)
  - 폴더 토글/리스트 이벤트 핸들러
  - Wiki 링크 전처리 함수
  - 문서 네비게이션 계산
  - 평면화 함수

- `public/css/style.css`
  - 삼각형 토글 스타일
  - 폴더 리스트 뷰 스타일
  - 문서 네비게이션 스타일

### 문서
- `docs/api/api.md`
  - 원본 다운로드 섹션 추가
- `docs/api/api-curl-example.md`
  - .md URL 예제 추가

### 테스트
- `test/playwright-ui.spec.js` (새 파일)
  - Playwright MCP 테스트
- `test-source/test-wiki-links.md` (새 파일)
- `test-source/test-images.md` (새 파일)

---

## 마이그레이션 및 하위 호환성

### URL 변경 영향
- **기존 URL**: `/doc/path/to/file.md`
- **새 URL**: `/doc/path/to/file`
- **호환성**: 기존 URL도 작동 (다운로드로 처리)

### 사용자 마이그레이션
- 북마크: 새 형식 사용 권장
- 공유 링크: 양쪽 모두 지원
- 검색 엔진: 새 형식으로 인덱싱

---

## 향후 개선 사항

### Phase 2 개선
- 폴더 리스트에 파일 미리보기 (첫 문단)
- 드래그 앤 드롭으로 폴더 이동
- 폴더 설명 (README.md 자동 표시)

### Phase 3 개선
- 브레드크럼 네비게이션
- 사이드바 미니맵
- 목차 자동 생성

### Phase 4 개선
- 백링크 (역참조) 지원
- 자동완성 제안
- 존재하지 않는 문서 표시

### Phase 5 개선
- 이미지 최적화 (자동 리사이징)
- 갤러리 뷰
- 라이트박스

---

## 성공 기준

### 기능 검증
- ✅ Clean URL로 문서 접근 가능
- ✅ .md URL로 원본 다운로드 가능
- ✅ 폴더 토글과 리스트 뷰 구분 작동
- ✅ 이전/다음 네비게이션 정확
- ✅ Wiki 링크 올바르게 변환
- ✅ 이미지 정상 표시

### 성능 기준
- 폴더 리스트 로딩: < 200ms
- URL 변경: < 50ms
- Wiki 링크 파싱: < 10ms (문서당)

### UX 기준
- 직관적인 폴더 탐색
- 빠른 문서 간 이동
- 깔끔한 URL

---

## 참고 자료

- Docusaurus UI 패턴: https://docusaurus.io/
- Obsidian Wiki 링크: https://help.obsidian.md/Linking+notes+and+files/Internal+links
- History API: https://developer.mozilla.org/en-US/docs/Web/API/History_API

---

**상태**: 계획 수립 완료, 구현 준비됨
**작성자**: Claude Code
**검토 필요**: UI/UX 최종 승인
