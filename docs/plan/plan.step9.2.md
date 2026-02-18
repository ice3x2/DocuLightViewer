## Step 9.2: 폴더 UI 개선 — Docusaurus 스타일 네비게이션

작성일: 2025-10-27

### 한 줄 요약
Docusaurus 스타일의 폴더 네비게이션을 구현하여 (1) 삼각형 토글로 트리 확장/축소, (2) 폴더명 클릭으로 하위 문서 리스트 표시 기능을 추가한다.

---

## 현재 상태 분석

### 기존 구조 (app.js Line 410-550)

**HTML 구조**:
```html
<div class="tree-item-wrapper" data-path="guide">
  <div class="tree-item directory" data-path="guide">
    <span class="expand-icon">▶</span>
    <span class="tree-icon">📁</span>  <!-- 제거 대상 -->
    <span>guide</span>
  </div>
  <div class="tree-children" style="display: none">
    <!-- children -->
  </div>
</div>
```

**이벤트 핸들링** (Line 454-458):
```javascript
// 전체 item에 클릭 이벤트 등록
item.addEventListener('click', async (e) => {
  e.stopPropagation();
  await toggleDirectory(dirPath, wrapper, childrenContainer, expandIcon, level + 1);
});
```

**문제점**:
- ✅ 삼각형 아이콘은 이미 존재 (`expand-icon`)
- ❌ 폴더 아이콘 📁 제거 필요
- ❌ 토글과 폴더명 클릭이 구분되지 않음
- ❌ 폴더 내용을 메인 영역에 볼 수 없음

---

## 목표

### Before (현재)
```
[▶ 📁 guide]  ← 전체 클릭 시 트리만 토글
  폴더 내용을 볼 수 없음
```

### After (개선)
```
[▶ guide]     ← 삼각형만 표시
 ↑   ↑
 │   └─ 폴더명 클릭 → 메인 영역에 리스트 표시
 └─ 토글 클릭 → 트리 확장/축소
```

**메인 영역 리스트 표시**:
```markdown
# 📂 guide

## Documents
- [intro](/doc/guide/intro)
- [programming-samples](/doc/guide/programming-samples)

## Subdirectories
- [**advanced/**](/doc/guide/advanced)
```

---

## 구현 전략

### 접근 방법

**옵션 A: 이벤트 위임 패턴** (권장)
- 상위 컨테이너에 단일 이벤트 핸들러 등록
- `event.target`으로 클릭된 요소 판별
- 유연하고 확장 가능

**옵션 B: 각 요소에 개별 핸들러**
- 토글 아이콘에 클릭 핸들러
- 폴더명에 클릭 핸들러
- 간단하지만 중복 코드 많음

**선택**: 옵션 A (이벤트 위임)

---

## 상세 구현 계획

### Phase A: HTML 구조 변경

#### A1. 폴더 아이콘 제거

**현재** (Line 436-439):
```javascript
const folderIcon = document.createElement('span');
folderIcon.className = 'tree-icon';
folderIcon.textContent = '📁';
```

**개선** (주석 처리 또는 제거):
```javascript
// 폴더 아이콘 제거 (Step 9.2)
// const folderIcon = document.createElement('span');
// folderIcon.className = 'tree-icon';
// folderIcon.textContent = '📁';
```

**item.appendChild(folderIcon)도 제거** (Line 446)

#### A2. data-action 속성 추가

**목적**: 클릭된 요소 구분

**변경**:
```javascript
// 토글 아이콘
const expandIcon = document.createElement('span');
expandIcon.className = 'expand-icon';
expandIcon.textContent = '▶';
expandIcon.dataset.action = 'toggle';  // 추가

// 폴더명
const nameSpan = document.createElement('span');
nameSpan.className = 'folder-name';     // 클래스 추가
nameSpan.dataset.action = 'list';       // 추가
nameSpan.textContent = dir.name;
```

---

### Phase B: 이벤트 핸들러 재구성

#### B1. 기존 클릭 핸들러 제거

**현재** (Line 455-458):
```javascript
item.addEventListener('click', async (e) => {
  e.stopPropagation();
  await toggleDirectory(...);
});
```

**개선**: 제거하고 이벤트 위임으로 대체

#### B2. 이벤트 위임 핸들러 추가

**위치**: buildTree() 함수 외부, init() 함수 내부

**코드**:
```javascript
// Tree container click event delegation
const treeContainer = document.getElementById('tree-container');

treeContainer.addEventListener('click', async (e) => {
  const action = e.target.dataset.action;

  if (!action) return;

  e.stopPropagation();
  const item = e.target.closest('.tree-item');
  const wrapper = e.target.closest('.tree-item-wrapper');

  if (!item || !wrapper) return;

  const dirPath = wrapper.dataset.path;

  if (action === 'toggle') {
    // 토글 아이콘 클릭 → 트리 확장/축소
    const childrenContainer = wrapper.querySelector('.tree-children');
    const expandIcon = wrapper.querySelector('.expand-icon');
    const level = parseInt(item.style.paddingLeft) / 1.2;

    await toggleDirectory(dirPath, wrapper, childrenContainer, expandIcon, level + 1);
  } else if (action === 'list') {
    // 폴더명 클릭 → 리스트 뷰 표시
    await showFolderList(dirPath);
  }
});
```

---

### Phase C: 폴더 리스트 뷰 구현

#### C1. showFolderList() 함수

**기능**: 폴더 내용을 동적 마크다운으로 생성하여 표시

**구현**:
```javascript
/**
 * Show folder contents as a list in main area
 * @param {string} folderPath - Folder path (e.g., 'guide' or 'guide/advanced')
 */
async function showFolderList(folderPath) {
  try {
    // Save current path
    currentPath = folderPath;

    // Update breadcrumb
    document.getElementById('breadcrumb').textContent = folderPath + '/';

    // Fetch folder contents
    const response = await fetch(`/api/tree?path=${encodeURIComponent(folderPath)}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Generate markdown for folder contents
    const markdown = generateFolderListMarkdown(folderPath, data);

    // Render markdown
    await renderMarkdown(markdown);

    // Update URL (clean URL without .md)
    const cleanPath = folderPath.replace(/^\//, '');
    const encodedPath = cleanPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
    window.history.pushState({
      path: folderPath,
      type: 'folder'
    }, '', `/doc/${encodedPath}`);

    // Update active state in tree
    document.querySelectorAll('.tree-item').forEach(item => {
      item.classList.remove('active');
    });

    const activeItem = document.querySelector(`.tree-item[data-path="${folderPath}"]`);
    if (activeItem) {
      activeItem.classList.add('active');
    }

  } catch (error) {
    console.error('Failed to load folder list:', error);
    const userMessage = ErrorHandler.getUserMessage(error, 'Folder');
    ErrorHandler.showError(userMessage, error.message);
  }
}
```

#### C2. generateFolderListMarkdown() 함수

**기능**: 폴더 데이터 → 마크다운 변환

**구현**:
```javascript
/**
 * Generate markdown for folder list view
 * @param {string} folderPath - Current folder path
 * @param {Object} treeData - Tree data from /api/tree
 * @returns {string} Markdown content
 */
function generateFolderListMarkdown(folderPath, treeData) {
  // Extract folder name for title
  const folderName = folderPath.split('/').filter(p => p).pop() || 'Root';

  let markdown = `# 📂 ${folderName}\n\n`;

  // Show current path
  markdown += `**Path**: \`${folderPath || '/'}\`\n\n`;

  // Subdirectories section
  if (treeData.dirs && treeData.dirs.length > 0) {
    markdown += `## Subdirectories\n\n`;

    for (const dir of treeData.dirs) {
      const dirPath = folderPath ? `${folderPath}/${dir.name}` : dir.name;
      const cleanDirPath = dirPath.replace(/^\//, '');
      markdown += `- **[📁 ${dir.name}](/doc/${cleanDirPath})**\n`;
    }

    markdown += '\n';
  }

  // Documents section
  if (treeData.files && treeData.files.length > 0) {
    markdown += `## Documents\n\n`;

    for (const file of treeData.files) {
      // Only show .md files
      if (!file.name.endsWith('.md')) continue;

      const filePath = folderPath ? `${folderPath}/${file.name}` : file.name;
      const cleanFilePath = filePath.replace(/^\//, '').replace(/\.md$/, '');

      // Display name without .md extension
      const displayName = file.name.replace(/\.md$/, '');

      // File size (human readable)
      const sizeKB = (file.size / 1024).toFixed(1);

      markdown += `- [📄 ${displayName}](/doc/${cleanFilePath}) _${sizeKB} KB_\n`;
    }

    markdown += '\n';
  }

  // Empty folder message
  if ((!treeData.dirs || treeData.dirs.length === 0) &&
      (!treeData.files || treeData.files.length === 0)) {
    markdown += `\n---\n\n`;
    markdown += `_This folder is empty._\n\n`;
  }

  // Footer with stats
  const totalDirs = treeData.dirs ? treeData.dirs.length : 0;
  const totalFiles = treeData.files ? treeData.files.length : 0;

  markdown += `\n---\n\n`;
  markdown += `**Total**: ${totalDirs} subdirectories, ${totalFiles} files\n`;

  return markdown;
}
```

---

### Phase D: CSS 스타일링

#### D1. 폴더 아이콘 숨김

**파일**: `public/css/style.css`

**추가**:
```css
/* Hide folder icon (Step 9.2) */
.tree-item.directory .tree-icon {
  display: none;
}
```

**또는 완전 제거**: JavaScript에서 아이콘 생성 자체를 주석 처리

#### D2. 폴더명 스타일

**추가**:
```css
/* Folder name styling */
.folder-name {
  cursor: pointer;
  color: var(--accent-color);
  font-weight: 600;
  transition: opacity 0.2s;
}

.folder-name:hover {
  opacity: 0.7;
  text-decoration: underline;
}

.folder-name:active {
  opacity: 0.5;
}
```

#### D3. 토글 아이콘 개선

**기존** (Line 184-196):
```css
.expand-icon {
  display: inline-block;
  margin-right: 0.5rem;
  width: 16px;
  text-align: center;
  transition: transform 0.2s;
  cursor: pointer;
}

.expand-icon.expanded {
  transform: rotate(90deg);
}
```

**개선** (독립적인 클릭 영역 강조):
```css
.expand-icon {
  display: inline-block;
  margin-right: 0.25rem;
  width: 20px;
  height: 20px;
  text-align: center;
  line-height: 20px;
  cursor: pointer;
  user-select: none;
  transition: transform 0.2s ease;
  border-radius: 3px;
}

.expand-icon:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

.expand-icon.expanded {
  transform: rotate(90deg);
}
```

#### D4. 폴더 리스트 뷰 스타일

**추가**:
```css
/* Folder list view in main content area */
.folder-list-view {
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem;
}

.folder-list-view h1 {
  font-size: 32px;
  margin-bottom: 1.5rem;
  color: var(--text-primary);
  border-bottom: 2px solid var(--border-color);
  padding-bottom: 0.5rem;
}

.folder-list-view h2 {
  font-size: 20px;
  margin-top: 2rem;
  margin-bottom: 1rem;
  color: var(--text-secondary);
  font-weight: 600;
}

.folder-list-view ul {
  list-style: none;
  padding-left: 0;
}

.folder-list-view li {
  padding: 0.75rem 1rem;
  margin: 0.25rem 0;
  background: #fafafa;
  border-radius: 6px;
  border: 1px solid #eee;
  transition: all 0.2s;
}

.folder-list-view li:hover {
  background: #f0f0f0;
  border-color: var(--accent-color);
  transform: translateX(4px);
}

.folder-list-view a {
  color: var(--text-primary);
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.folder-list-view a:hover {
  color: var(--accent-color);
}

/* File size display */
.folder-list-view em {
  color: var(--text-secondary);
  font-size: 0.85em;
  margin-left: auto;
}

/* Folder vs File distinction */
.folder-list-view a strong {
  font-weight: 600;
  color: var(--accent-color);
}

/* Empty folder message */
.folder-list-view hr {
  margin: 2rem 0;
  border: none;
  border-top: 1px solid var(--border-color);
}

.folder-list-view em:only-child {
  display: block;
  text-align: center;
  padding: 3rem 0;
  color: var(--text-secondary);
  font-style: italic;
}
```

---

### Phase E: 기존 기능 유지

#### E1. 트리 확장/축소 유지

**toggleDirectory() 함수** (Line 516-550): 변경 없음
- 삼각형 토글 시에만 호출
- IndexedDB 상태 저장 유지
- 자식 로드 로직 유지

#### E2. 트리 상태 복원

**buildTree() 복원 로직** (Line 506-512): 변경 없음
- 페이지 로드 시 확장 상태 복원
- IndexedDB에서 읽어옴

---

## 동작 흐름

### 흐름 1: 토글 클릭 (트리 확장/축소)

```
사용자가 ▶ 클릭
  ↓
Event delegation: e.target.dataset.action === 'toggle'
  ↓
toggleDirectory(dirPath, ...) 호출
  ↓
현재 상태 확인 (expanded?)
  ├─ Yes → 축소: ▶, display: none, saveTreeState(false)
  └─ No  → 확장: ▼, display: block, saveTreeState(true)
                  ↓
                  자식이 없으면 fetch('/api/tree?path=...')
                  ↓
                  buildTree() 재귀 호출
```

### 흐름 2: 폴더명 클릭 (리스트 뷰)

```
사용자가 "guide" 클릭
  ↓
Event delegation: e.target.dataset.action === 'list'
  ↓
showFolderList('guide') 호출
  ↓
fetch('/api/tree?path=guide')
  ↓
generateFolderListMarkdown(data)
  ↓
결과 예:
  # 📂 guide
  ## Documents
  - [intro](/doc/guide/intro)
  - [setup](/doc/guide/setup)
  ↓
renderMarkdown(markdown)
  ↓
메인 영역에 표시
  ↓
window.history.pushState({ path: 'guide', type: 'folder' }, '', '/doc/guide')
  ↓
트리 active 상태 업데이트
```

### 흐름 3: 리스트에서 문서 클릭

```
사용자가 리스트의 "[intro](/doc/guide/intro)" 클릭
  ↓
브라우저 기본 동작 (링크 이동)
  ↓
/doc/guide/intro로 이동
  ↓
init() 함수의 URL 파싱
  ↓
loadFile('guide/intro.md') 호출
  ↓
문서 렌더링
```

---

## 예외 케이스 처리

### Case 1: 루트 폴더 클릭

```javascript
// folderPath = '' 또는 '/'
const folderName = folderPath.split('/').filter(p => p).pop() || 'Root';
// → folderName = 'Root'

markdown = '# 📂 Root\n\n';
```

### Case 2: 빈 폴더

```javascript
if ((!treeData.dirs || treeData.dirs.length === 0) &&
    (!treeData.files || treeData.files.length === 0)) {
  markdown += '\n---\n\n_This folder is empty._\n\n';
}
```

### Case 3: 폴더 내에 .md가 아닌 파일

```javascript
for (const file of treeData.files) {
  // Skip non-markdown files
  if (!file.name.endsWith('.md')) continue;
  // ...
}
```

### Case 4: 깊이가 깊은 경로

```
folderPath = 'guide/advanced/configuration/security'
folderName = 'security'
URL = /doc/guide/advanced/configuration/security
```

---

## URL 처리

### 폴더 URL vs 파일 URL 구분

**문제**:
```
/doc/guide → 폴더인가 파일인가?
```

**해결 방법 1: 서버에서 판별** (권장)
```javascript
// 클라이언트가 /doc/guide 요청
// → /api/tree?path=guide 호출 성공 → 폴더
// → /api/raw?path=guide.md 호출 성공 → 파일
// → 둘 다 실패 → 404
```

**해결 방법 2: 클라이언트 우선순위**
```javascript
async function loadPathFromUrl(path) {
  // 1. 파일로 시도
  try {
    await loadFile(path + '.md');
    return;
  } catch (error) {
    // 2. 폴더로 시도
    try {
      await showFolderList(path);
      return;
    } catch (error2) {
      // 3. 모두 실패 → 404
      ErrorHandler.showError('Not found', 'Path does not exist');
    }
  }
}
```

**권장**: 방법 2 (클라이언트 판별)
- 서버 수정 불필요
- 유연한 처리

---

## 구현 체크리스트

### JavaScript (public/js/app.js)

- [ ] **buildTree() 수정** (Line 410-513)
  - [ ] 폴더 아이콘 생성 제거 (Line 436-439, 446)
  - [ ] expandIcon에 data-action='toggle' 추가
  - [ ] nameSpan에 className='folder-name', data-action='list' 추가
  - [ ] item 클릭 핸들러 제거 (Line 455-458)

- [ ] **이벤트 위임 추가** (init() 함수 내)
  - [ ] treeContainer 클릭 이벤트 핸들러
  - [ ] action='toggle' → toggleDirectory()
  - [ ] action='list' → showFolderList()

- [ ] **showFolderList() 구현** (새 함수)
  - [ ] API 호출: /api/tree?path=...
  - [ ] generateFolderListMarkdown() 호출
  - [ ] renderMarkdown() 호출
  - [ ] URL 업데이트
  - [ ] active 상태 업데이트

- [ ] **generateFolderListMarkdown() 구현** (새 함수)
  - [ ] 폴더명 추출 및 타이틀 생성
  - [ ] Subdirectories 섹션
  - [ ] Documents 섹션
  - [ ] 빈 폴더 메시지
  - [ ] 통계 푸터

- [ ] **URL 파싱 로직 수정** (init() 함수, Line 749-773)
  - [ ] 폴더 vs 파일 판별 로직 추가
  - [ ] 우선순위: 파일 → 폴더 → 404

### CSS (public/css/style.css)

- [ ] **폴더 아이콘 숨김**
  - [ ] `.tree-item.directory .tree-icon { display: none; }`

- [ ] **폴더명 스타일**
  - [ ] `.folder-name` 클래스 정의
  - [ ] hover, active 효과

- [ ] **토글 아이콘 개선**
  - [ ] hover 효과 추가
  - [ ] 클릭 영역 확대

- [ ] **폴더 리스트 뷰 스타일**
  - [ ] `.folder-list-view` 컨테이너
  - [ ] h1, h2 스타일
  - [ ] ul, li 스타일
  - [ ] hover 애니메이션
  - [ ] 파일/폴더 구분 스타일

---

## 기술적 고려사항

### 1. 이벤트 버블링 제어

**문제**: 폴더명 클릭 시 토글도 함께 발생?

**해결**:
```javascript
treeContainer.addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action) return;

  e.stopPropagation();  // 필수! 버블링 차단

  // ...
});
```

### 2. 메모리 관리

**문제**: 리스트 뷰 캐싱?

**해결**:
- 첫 번째 단계: 캐싱 없음 (매번 API 호출)
- 향후 개선: IndexedDB 또는 메모리 캐시

### 3. 성능 최적화

**API 호출 최소화**:
```javascript
// 이미 트리에서 로드한 데이터 재사용 (향후 개선)
// 현재는 단순하게 매번 fetch
```

---

## 테스트 시나리오

### 수동 테스트

#### T1. 토글 독립성
```
1. 브라우저에서 http://localhost:3000 접속
2. guide 폴더의 ▶ 클릭
3. 예상: 트리만 확장, 메인 영역 변화 없음
4. ▼ 다시 클릭
5. 예상: 트리 축소
```

#### T2. 폴더 리스트 뷰
```
1. guide 폴더의 "guide" 텍스트 클릭
2. 예상: 메인 영역에 리스트 표시
   - 제목: "📂 guide"
   - Subdirectories 섹션 (있다면)
   - Documents 섹션
   - 통계 (2 files)
3. URL 확인: /doc/guide (clean URL)
```

#### T3. 리스트에서 문서 클릭
```
1. 리스트에서 "intro" 링크 클릭
2. 예상: intro.md 문서 렌더링
3. URL 확인: /doc/guide/intro
```

#### T4. 뒤로가기
```
1. 브라우저 뒤로가기 버튼 클릭
2. 예상: 폴더 리스트로 복귀
3. URL: /doc/guide
```

#### T5. 빈 폴더
```
1. 빈 폴더 클릭
2. 예상: "This folder is empty." 메시지
```

---

## 구현 순서

### Step 1: JavaScript 수정 (예상: 2.0h)

1. **buildTree() 수정** (0.5h)
   - 폴더 아이콘 제거
   - data-action 속성 추가

2. **이벤트 위임 추가** (0.5h)
   - treeContainer 클릭 핸들러
   - action 분기 로직

3. **showFolderList() 구현** (0.5h)
   - API 호출
   - 마크다운 생성 호출
   - 렌더링

4. **generateFolderListMarkdown() 구현** (0.5h)
   - 섹션별 마크다운 생성
   - 통계 푸터

### Step 2: CSS 수정 (예상: 0.5h)

1. 폴더 아이콘 숨김
2. 폴더명 스타일
3. 토글 hover 효과
4. 리스트 뷰 스타일

### Step 3: URL 처리 개선 (예상: 0.5h)

1. init() 함수 수정
2. 폴더 vs 파일 판별 로직
3. popstate 핸들러 수정

### Step 4: 테스트 및 디버깅 (예상: 1.0h)

1. 수동 테스트 (모든 시나리오)
2. 에지 케이스 확인
3. 버그 수정

**총 예상 시간**: 4.0시간

---

## 리스크 및 대응

### 리스크 1: 이벤트 충돌

**문제**: 토글 클릭 시 폴더명도 클릭됨

**대응**:
```javascript
if (action === 'toggle') {
  e.stopPropagation();  // ← 필수
  // ...
}
```

### 리스크 2: 트리 상태 손실

**문제**: 리팩토링 중 IndexedDB 상태 저장 누락

**대응**:
- toggleDirectory() 함수 변경 최소화
- 기존 saveTreeState() 호출 유지

### 리스크 3: CSS 스타일 충돌

**문제**: 기존 .tree-item 스타일과 충돌

**대응**:
- 새 스타일은 별도 클래스 사용
- 기존 스타일 덮어쓰지 않음

---

## 롤백 계획

### 문제 발생 시

1. **JavaScript 롤백**:
   - buildTree() 수정 원복
   - 이벤트 핸들러 제거
   - 2개 파일만 수정되므로 간단

2. **CSS 롤백**:
   - 추가한 스타일 제거
   - 폴더 아이콘 display 원복

**롤백 시간**: ~10분

---

## 성공 기준

### 필수 기능
- ✅ 삼각형 토글로 트리 확장/축소 가능
- ✅ 폴더명 클릭으로 리스트 뷰 표시
- ✅ 리스트에서 문서 클릭 시 렌더링
- ✅ 뒤로가기/앞으로가기 작동

### UX 품질
- ✅ 토글과 폴더명이 명확히 구분됨
- ✅ Docusaurus 스타일 (간결하고 깔끔)
- ✅ hover 효과로 클릭 가능 영역 표시

### 성능
- ✅ 폴더 리스트 로딩: < 200ms
- ✅ 토글 애니메이션: 부드러움
- ✅ 메모리 누수 없음

---

## 다음 단계와의 연계

### Step 9.3과 연계

폴더 리스트 뷰에서 **이전/다음 네비게이션** 표시 가능:

```markdown
# 📂 guide

...

---

← Previous Folder: reference | Next Folder: test →
```

### Step 9.4와 연계

폴더 리스트에서 **Wiki 링크 자동 감지**:

```markdown
Related: [[/guide/advanced/configuration]]
```

---

**상태**: 상세 분석 완료, 구현 계획 수립 완료
**예상 소요 시간**: 4.0시간
**우선순위**: P0 (긴급)
**복잡도**: 중 (기존 코드 수정 + 신규 기능)
