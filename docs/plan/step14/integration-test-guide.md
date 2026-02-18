# Admin Mode 통합 테스트 가이드

| 항목 | 내용 |
|------|------|
| **문서 버전** | 1.0.0 |
| **작성일** | 2026-01-06 |
| **대상** | Step 14: Admin Mode |

---

## 1. 통합 테스트 목적

### 1.1 원래 의도

> "API 키를 입력하고 일치하면, 관리자 모드로 들어갑니다. 좌측 파일 리스트에서 파일 하나를 선택하고 오른쪽 버튼을 누르면 컨텍스트 메뉴가 열립니다. 관리자 모드에서는 md 파일뿐만 아니라 다른 형식들도 좌측 리스트에 표시됩니다."

### 1.2 검증 목표

1. **인증**: API 키 기반 로그인/로그아웃이 정상 동작
2. **파일 관리**: CRUD 작업이 정상 동작
3. **편집**: 마크다운 파일 편집/저장이 정상 동작
4. **드래그앤드롭**: 파일/폴더 이동이 정상 동작
5. **권한**: 권한에 따른 작업 제한이 정상 동작

---

## 2. End-to-End 시나리오

### 시나리오 1: 관리자 전체 워크플로우

**목표**: 로그인부터 파일 생성/편집/이동/삭제까지 전체 플로우 검증

```
Given:
  - 서버 실행 중
  - config.json5에 apiKey 설정됨
  - docsRoot에 기존 파일 존재

When:
  1. /admin 접속
  2. API 키 입력 → 로그인
  3. 파일 트리 확인 (모든 파일 표시)
  4. 폴더 우클릭 → New File → "test-doc.md" 생성
  5. 생성된 파일 우클릭 → Edit
  6. 내용 입력 → Ctrl+S 저장
  7. Preview 모드로 전환 → 렌더링 확인
  8. 파일을 다른 폴더로 드래그앤드롭
  9. 파일 우클릭 → Rename → "renamed-doc.md"
  10. 파일 우클릭 → Delete → 확인
  11. Logout

Then:
  - 모든 작업 성공
  - 파일 시스템에 변경 반영됨
  - 세션 종료됨
```

### 시나리오 2: 다중 파일 관리

**목표**: 다중 선택 및 일괄 작업 검증

```
Given:
  - 로그인 상태
  - folder1에 file1.md, file2.md, file3.md 존재

When:
  1. file1.md 클릭 (단일 선택)
  2. Shift + file3.md 클릭 (범위 선택)
  3. 선택된 3개 파일을 folder2로 드래그앤드롭

Then:
  - 3개 파일 모두 folder2로 이동됨
  - folder1 비어있음
```

### 시나리오 3: 권한 제한 검증

**목표**: read-only 사용자 권한 검증

```
Given:
  - config.json5에 read-only 키 설정됨:
    { key: "reader-key", permissions: ["read"] }

When:
  1. /admin 접속
  2. reader-key로 로그인
  3. 파일 트리 조회 시도
  4. 파일 편집 시도
  5. 파일 삭제 시도

Then:
  - 파일 트리 조회 성공
  - 파일 편집 403 에러
  - 파일 삭제 403 에러
  - 컨텍스트 메뉴에서 Edit, Delete 비활성화
```

### 시나리오 4: 미저장 경고 플로우

**목표**: 편집 중 다른 작업 시 경고 검증

```
Given:
  - 로그인 상태
  - file1.md 편집 중 (isDirty=true)

When:
  1. file2.md 클릭 시도

Then:
  - "Unsaved Changes" 모달 표시
  - Cancel: 모달 닫힘, file1.md 유지
  - Discard: 변경 버림, file2.md 열림
  - Save: file1.md 저장 후 file2.md 열림
```

### 시나리오 5: 동시 편집 충돌

**목표**: 두 세션에서 같은 파일 편집 시 충돌 처리 검증

```
Given:
  - 세션 A: file.md 편집 중
  - 세션 B: 같은 file.md 수정 후 저장 완료

When:
  - 세션 A: 저장 시도

Then:
  - 409 Conflict 응답
  - "File Conflict" 모달 표시
  - Reload: 서버 버전으로 새로고침
  - Overwrite: 강제 저장
```

### 시나리오 6: 세션 만료

**목표**: 세션 타임아웃 후 동작 검증

```
Given:
  - 로그인 상태
  - sessionTimeout: 5000ms (테스트용)

When:
  1. 6초 대기
  2. API 요청 시도

Then:
  - 401 Unauthorized 응답
  - 인증 모달 자동 표시
```

---

## 3. 컴포넌트 통합 검증

| 컴포넌트 A | 컴포넌트 B | 통합 포인트 | 검증 방법 |
|-----------|-----------|------------|----------|
| admin-auth.js | session-service.js | 세션 검증 | 토큰으로 인증 후 API 호출 |
| admin-api.js | file-service.js | 파일 CRUD | API 호출 후 파일 시스템 확인 |
| admin.js | admin-api.js | UI-API 연동 | 버튼 클릭 후 API 호출 확인 |
| TreeModule | SelectionModule | 선택 상태 | Shift 선택 후 selectedPaths 확인 |
| EditorModule | ModalModule | 미저장 경고 | isDirty 상태에서 파일 전환 |
| DragDropModule | admin-api.js | 이동 API | 드롭 후 move API 호출 확인 |

---

## 4. 통합 테스트 코드

### 4.1 테스트 파일 구조

```
test/
├── integration/
│   ├── admin-full-workflow.spec.js    # 시나리오 1
│   ├── admin-multi-select.spec.js     # 시나리오 2
│   ├── admin-permissions.spec.js      # 시나리오 3
│   ├── admin-unsaved-warning.spec.js  # 시나리오 4
│   ├── admin-conflict.spec.js         # 시나리오 5
│   └── admin-session-expiry.spec.js   # 시나리오 6
└── helpers/
    ├── admin-test-utils.js            # 공통 유틸
    └── test-fixtures.js               # 테스트 데이터
```

### 4.2 테스트 헬퍼

```javascript
// test/helpers/admin-test-utils.js
const { test, expect } = require('@playwright/test');

async function loginAsAdmin(page, apiKey) {
  await page.goto('/admin');
  await page.fill('#api-key-input', apiKey);
  await page.click('#auth-login');
  await expect(page.locator('#admin-app')).toBeVisible();
}

async function createTestFile(page, parentPath, fileName, content = '') {
  // 폴더 우클릭 → New File
  await page.locator(`[data-path="${parentPath}"]`).click({ button: 'right' });
  await page.locator('.context-menu-item:has-text("New File")').click();

  // 모달에서 이름 입력
  await page.fill('#create-name-input', fileName);
  if (content) {
    await page.fill('#create-content-input', content);
  }
  await page.click('#create-confirm');

  // 생성 확인
  await expect(page.locator(`[data-path="${parentPath}/${fileName}"]`)).toBeVisible();
}

async function deleteTestFile(page, filePath) {
  await page.locator(`[data-path="${filePath}"]`).click({ button: 'right' });
  await page.locator('.context-menu-item:has-text("Delete")').click();
  await page.click('#delete-confirm');
}

module.exports = { loginAsAdmin, createTestFile, deleteTestFile };
```

### 4.3 통합 테스트 예시

```javascript
// test/integration/admin-full-workflow.spec.js
const { test, expect } = require('@playwright/test');
const { loginAsAdmin, createTestFile, deleteTestFile } = require('../helpers/admin-test-utils');

test.describe('Admin Full Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page, process.env.TEST_API_KEY);
  });

  test('complete file lifecycle', async ({ page }) => {
    // 1. 파일 생성
    await createTestFile(page, '/test-folder', 'new-doc.md', '# Test');

    // 2. 편집
    await page.locator('[data-path="/test-folder/new-doc.md"]').click({ button: 'right' });
    await page.locator('.context-menu-item:has-text("Edit")').click();

    const editor = page.locator('#editor-textarea');
    await editor.fill('# Updated Content\n\nNew text.');

    // 3. 저장
    await page.keyboard.press('Control+s');
    await expect(page.locator('.dirty-indicator')).toBeEmpty();

    // 4. 미리보기
    await page.click('.mode-preview');
    await expect(page.locator('#editor-preview h1')).toHaveText('Updated Content');

    // 5. 이동
    await page.click('.mode-edit');  // 편집 모드로 복귀 (에디터 닫기)
    // ... 드래그앤드롭 테스트

    // 6. 삭제
    await deleteTestFile(page, '/test-folder/new-doc.md');
    await expect(page.locator('[data-path="/test-folder/new-doc.md"]')).not.toBeVisible();
  });
});
```

---

## 5. 성능/부하 테스트

### 5.1 성능 목표

| 항목 | 목표 | 측정 방법 |
|------|------|----------|
| 로그인 응답 시간 | < 200ms | API 응답 시간 |
| 파일 트리 로드 | < 2초 (1000 파일) | 페이지 로드 시간 |
| 파일 저장 | < 500ms | API 응답 시간 |
| 파일 이동 | < 500ms | API 응답 시간 |

### 5.2 부하 테스트 시나리오

```javascript
// test/load/admin-load-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,  // 동시 사용자
  duration: '1m'
};

export default function() {
  // 로그인
  const loginRes = http.post('http://localhost:3000/api/admin/auth', {
    apiKey: __ENV.TEST_API_KEY
  });
  check(loginRes, { 'login success': (r) => r.status === 200 });

  const token = loginRes.json().session.token;
  const headers = { Cookie: `doclight_admin_session=${token}` };

  // 트리 조회
  const treeRes = http.get('http://localhost:3000/api/admin/tree', { headers });
  check(treeRes, { 'tree < 2s': (r) => r.timings.duration < 2000 });

  sleep(1);
}
```

---

## 6. 원래 목적 달성 검증

| 요구사항 ID | 설명 | 검증 방법 | 결과 |
|------------|------|----------|------|
| REQ-AUTH-001 | 다중 API 키 지원 | apiKeys 배열 설정 테스트 | ⬜ |
| REQ-AUTH-002 | API 키 인증 | 로그인 테스트 | ⬜ |
| REQ-TREE-001 | 모든 파일 타입 표시 | 트리 UI 확인 | ⬜ |
| REQ-SEL-002 | Shift 다중 선택 | 범위 선택 테스트 | ⬜ |
| REQ-CTX-001 | 우클릭 메뉴 | 컨텍스트 메뉴 테스트 | ⬜ |
| REQ-EDIT-003 | 저장 기능 | Ctrl+S 테스트 | ⬜ |
| REQ-EDIT-006 | 미저장 경고 | 모달 테스트 | ⬜ |
| REQ-DND-001 | 파일 드래그 | 드래그앤드롭 테스트 | ⬜ |
| REQ-DND-005 | 자기 하위 이동 방지 | 이동 제한 테스트 | ⬜ |
| REQ-URL-001 | /admin 진입점 | URL 라우팅 테스트 | ⬜ |

---

## 7. 테스트 환경 설정

### 7.1 환경 변수

```bash
# .env.test
TEST_API_KEY=test-admin-key-12345
TEST_DOCS_ROOT=/tmp/doclight-test
```

### 7.2 테스트 실행 명령

```bash
# 통합 테스트
npm run test:integration

# 특정 시나리오
npm run test:integration -- --grep "Full Workflow"

# 부하 테스트 (k6 필요)
k6 run test/load/admin-load-test.js
```

### 7.3 테스트 데이터 설정

```javascript
// test/helpers/setup-test-data.js
const fs = require('fs').promises;
const path = require('path');

async function setupTestData(docsRoot) {
  await fs.mkdir(path.join(docsRoot, 'test-folder'), { recursive: true });
  await fs.writeFile(path.join(docsRoot, 'test-folder', 'sample.md'), '# Sample');
  await fs.writeFile(path.join(docsRoot, 'image.png'), Buffer.from('PNG...'));
}

async function cleanupTestData(docsRoot) {
  await fs.rm(docsRoot, { recursive: true, force: true });
}

module.exports = { setupTestData, cleanupTestData };
```

---

*통합 테스트 가이드 끝*
