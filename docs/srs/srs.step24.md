# SRS: DocuLight — Step 24 (projectPath 기반 Git 메타데이터 자동 수집)

## 메타데이터

| 항목 | 내용 |
|------|------|
| 버전 | Step 24 |
| 생성일 | 2026-04-01 |
| 이전 버전 | Step 22 (MCP 문서 저장 개선) |
| 성격 | **증분 확장** — MCP 프론트매터에 Git 컨텍스트 자동 주입 |
| 평가 라운드 | 3인 전문가 (기술 아키텍트, QA 전문가, 비즈니스 분석가) 1라운드 |

---

## 1. 개요

### 1.1 목적

MCP `open_markdown`/`update_markdown` 도구에 `projectPath` 파라미터를 추가하여, DocuLight가 내부적으로 git 명령을 실행하고 프로젝트 정보(리모트 URL, 브랜치, 마지막 커밋, 프로젝트명)를 YAML 프론트매터에 자동 삽입한다.

**핵심 가치:**
- **토큰 절약**: AI 에이전트가 파라미터 1개만 전달하면 프론트매터 필드 최대 5개 자동 생성
- **문서 추적성**: 모든 MCP 문서에 출처(repo, branch, commit) 메타데이터 자동 부여
- **검색성 향상**: Git 메타데이터가 BM25 인덱스에 포함되어 브랜치명·커밋 메시지로 검색 가능

### 1.2 범위

| 범위 내 | 범위 밖 |
|---------|---------|
| `projectPath` MCP 파라미터 추가 | git hook 연동 |
| `git-info.js` 모듈 신규 생성 | git 인증 처리 |
| `mcpGitInfo` 설정 토글 | git 상태 변경 (commit, push 등) |
| 프론트매터 필드 확장 | filePath에서 projectPath 자동 유추 |
| 메타박스 렌더링 확장 | git diff/status 정보 수집 |
| BM25 인덱싱 필드 확장 | |

> **참고**: `filePath`만 제공하고 `projectPath`가 없는 경우, filePath의 디렉토리에서 git 정보를 자동 유추하는 기능은 Step 24 범위 밖이다. 향후 별도 Step에서 검토한다.

### 1.3 이전 버전 대비 변경사항

| 영역 | Step 22 (현재) | Step 24 (변경) |
|------|---------------|----------------|
| `open_markdown` 파라미터 수 | 14 (stdio) / 15 (HTTP) | +1 (`projectPath`) |
| `update_markdown` 파라미터 수 | 14 | +1 (`projectPath`) |
| 프론트매터 필드 수 | 5 (project, docName, description, docType, date) | +4 (projectPath, gitRemote, gitBranch, gitLastCommit) |
| `src/main/` 모듈 수 | 10 | +1 (`git-info.js`) |
| electron-store 설정 수 | 18 | +1 (`mcpGitInfo`) |

### 1.4 현재 시스템 상태

- `frontmatter.js`: `injectFrontmatter(content, { project, docName, description, docType })` — 4개 메타 필드 + 자동 date
- `mcp-server.mjs`: open_markdown Zod 스키마 14개 필드
- `mcp-http.mjs`: open_markdown TOOLS 스키마 15개 필드 (alwaysOnTop 포함)
- `viewer.js`: `renderMetabox` fieldLabels 5개 키 (project, docName, docType, description, date)
- `search-engine.js`: BM25 `ovFldNames`에 `project`, `docName`, `docType` 인덱싱
- `child_process` 사용: `file-association.js`에서 `execFileSync`만 사용 중

### 1.5 구현 우선순위

| 우선순위 | 기능 | FR |
|----------|------|-----|
| P0 | git-info.js 모듈 및 MCP 파라미터 추가 | FR-24-001, FR-24-002 |
| P0 | 프론트매터 확장 | FR-24-003 |
| P1 | 설정 토글 (mcpGitInfo) | FR-24-004 |
| P1 | 메타박스 렌더링 및 i18n | FR-24-005 |
| P2 | BM25 인덱싱 확장 | FR-24-006 |

### 1.6 설계 결정 사항

| 결정 | 선택 | 근거 |
|------|------|------|
| git 실행 방식 | `execFile` (비동기) | 메인 프로세스 블로킹 방지. `execFileSync`는 최악 5초간 UI 정지 유발 |
| 병렬 vs 순차 | `Promise.all` 병렬 | 4개 독립 명령, 순차 시 최악 20초 → 병렬 시 최악 5초 |
| shell 사용 여부 | shell 미사용 (`execFile`) | shell injection 방지. `execFile`은 인자를 배열로 전달하여 안전 |
| 실패 정책 | 개별 필드 독립 실패 | 4개 명령이 각각 독립적으로 catch. 일부 실패 시 성공한 필드만 포함 |
| `project` 우선순위 | 명시적 `project` > git 유래 | 에이전트가 직접 지정한 이름이 자동 추출보다 우선 |
| remote URL 저장 | 원본 그대로 (credential 제거) | SSH/HTTPS 정규화 시 동일 repo 판별 어려움. credential만 보안상 제거 |
| 커밋 메시지 길이 | 최대 200자 truncation | 프론트매터/메타박스 UI 깨짐 방지 |
| 상대 경로 처리 | 무시 (null 반환) | 상대 경로의 기준점이 불명확. 절대 경로만 유효 |

### 1.7 이전 SRS와의 모순 해결

| 항목 | 기존 동작 | Step 24 변경 | 모순 여부 |
|------|----------|-------------|----------|
| appendMode + frontmatter | frontmatter 인젝션 스킵 (Step 19) | 동일 — appendMode에서는 projectPath 있어도 git 수집/주입 안 함 | 모순 없음 |
| `project` 파라미터 | 명시적 전달만 가능 | `projectPath`에서 자동 유추 가능 (명시적 값 우선) | 모순 없음 |
| noSave + frontmatter | noSave 시 저장만 스킵, frontmatter는 주입 | 동일 — noSave와 git 수집은 독립. noSave 시에도 frontmatter에 git 정보 포함 | 모순 없음 |

---

## 2. 기능 요구사항

### 2.1 FR-24-001: `projectPath` MCP 파라미터 추가

#### 2.1.1 설명

`open_markdown`과 `update_markdown` MCP 도구에 `projectPath` 파라미터(string, optional)를 추가한다. 이 파라미터는 프로젝트 디렉토리의 절대 경로를 받는다.

#### 2.1.2 입력

| 입력 | 출처 | 타입 | 기본값 | 필수 |
|------|------|------|--------|------|
| `projectPath` | MCP 호출자 | `string` | — | 아니오 |

#### 2.1.3 처리

1. `projectPath`가 제공되지 않으면 아무 동작 없음 (기존 동작 유지)
2. `projectPath`가 제공되면:
   a. 절대 경로인지 확인 (`path.isAbsolute()`). 상대 경로면 무시하고 `projectPath`를 null로 처리
   b. `mcpGitInfo` 설정이 `true`이면 FR-24-002의 `collectGitInfo(projectPath)` 호출
   c. `mcpGitInfo` 설정이 `false`이면 git 명령 실행 없이 `{ projectPath }` 객체만 반환
3. 수집된 git 정보 객체를 FR-24-003의 프론트매터 확장으로 전달
4. `appendMode: true`일 때는 `projectPath`가 있어도 git 수집 및 프론트매터 인젝션을 **스킵** (기존 appendMode 동작과 일관)

#### 2.1.4 출력

| 출력 | 타입 | 설명 |
|------|------|------|
| git 정보 객체 | `object` | `{ project?, projectPath, gitRemote?, gitBranch?, gitLastCommit? }` |

#### 2.1.5 예외

| 조건 | 처리 |
|------|------|
| `projectPath`가 상대 경로 | 무시. git 수집 안 함. `projectPath` 필드도 프론트매터에 포함하지 않음 |
| `projectPath`가 존재하지 않는 디렉토리 | `collectGitInfo`가 null 반환 → `projectPath`만 프론트매터에 기록 |
| `projectPath`가 파일 경로 (디렉토리가 아님) | `execFile`의 cwd 오류 → 동일하게 graceful 실패 |

---

### 2.2 FR-24-002: Git 정보 자동 수집 모듈 (`git-info.js`)

#### 2.2.1 설명

새 CJS 모듈 `src/main/git-info.js`를 생성한다. 비동기 함수 `collectGitInfo(projectPath)`는 지정된 경로에서 4개의 git 명령을 병렬 실행하여 프로젝트 메타데이터를 수집한다.

#### 2.2.2 입력

| 입력 | 출처 | 타입 | 기본값 | 필수 |
|------|------|------|--------|------|
| `projectPath` | FR-24-001 | `string` (절대 경로) | — | 예 |

#### 2.2.3 처리

1. 내부 헬퍼 `execGit(args, cwd)` 정의:
   - `child_process.execFile('git', args, { cwd, timeout: 5000, windowsHide: true })`
   - 성공 시 `stdout.trim()` 반환, 빈 문자열이면 `null`
   - 에러(ENOENT, 타임아웃, 비정상 종료) 시 `null` 반환 (throw 없음)

2. 4개 git 명령을 `Promise.all`로 병렬 실행:

   | # | 명령 | args 배열 | 수집 대상 |
   |---|------|-----------|----------|
   | 1 | `git remote get-url origin` | `['remote', 'get-url', 'origin']` | `gitRemote` |
   | 2 | `git branch --show-current` | `['branch', '--show-current']` | `gitBranch` |
   | 3 | `git log -1 --format=%s` | `['log', '-1', '--format=%s']` | `gitLastCommit` |
   | 4 | `git rev-parse --show-toplevel` | `['rev-parse', '--show-toplevel']` | repo 루트 → `project` (basename) |

3. 결과 객체 조립:
   - `result.projectPath` = 입력 `projectPath` (항상 포함)
   - `result.project` = `path.basename(repoRoot)` (성공 시) 또는 `path.basename(projectPath)` (fallback)
   - `result.gitRemote` = remote URL 원본에서 credential 제거 후 저장
   - `result.gitBranch` = 브랜치명 (detached HEAD 시 null → 생략)
   - `result.gitLastCommit` = 커밋 subject, 최대 200자 truncation

4. Remote URL credential sanitization:
   - 패턴: `https://user:pass@host/...` 또는 `https://token@host/...`
   - 처리: `url.replace(/\/\/[^@]+@/, '//')` — `//` 와 `@` 사이의 모든 문자 제거
   - 예: `https://user:pass@github.com/repo.git` → `https://github.com/repo.git`
   - SSH URL (`git@github.com:...`)은 credential이 아니므로 변환하지 않음

5. 커밋 메시지 truncation:
   - `gitLastCommit`이 200자 초과 시 `subject.substring(0, 200) + '…'`

6. 반환: truthy 필드만 포함된 객체. null/undefined 필드는 제외

#### 2.2.4 출력

| 출력 | 타입 | 설명 |
|------|------|------|
| git 정보 객체 | `object` | `{ project, projectPath, gitRemote?, gitBranch?, gitLastCommit? }` |

#### 2.2.5 예외

| 조건 | 처리 |
|------|------|
| git 미설치 (`ENOENT`) | 4개 명령 모두 null → `{ project: basename(projectPath), projectPath }` 반환 |
| `.git` 없는 디렉토리 | 동일. git 명령이 비정상 종료 → null |
| detached HEAD | `branch --show-current`가 빈 문자열 → `gitBranch` 생략 |
| origin remote 미설정 | `remote get-url origin` 실패 → `gitRemote` 생략 |
| 커밋 없는 빈 저장소 | `git log` 실패 → `gitLastCommit` 생략 |
| 5초 타임아웃 | 해당 명령만 null, 나머지 정상 반환 |
| remote URL에 credential 포함 | sanitize 후 저장 (2.2.3 #4 참조) |
| 커밋 subject 200자 초과 | truncation 후 저장 (2.2.3 #5 참조) |
| 경로에 공백/특수문자 | `execFile`의 `cwd` 옵션은 OS 네이티브 경로 처리. 문제 없음 |
| Windows `rev-parse --show-toplevel` POSIX 경로 | `path.basename()`만 사용하므로 `/c/Users/...` 형태여도 마지막 segment 추출 정상 |

---

### 2.3 FR-24-003: 프론트매터 확장

#### 2.3.1 설명

`frontmatter.js`의 `injectFrontmatter` 함수 시그니처를 확장하여 git 관련 필드를 수용한다.

#### 2.3.2 입력

| 입력 | 출처 | 타입 | 기본값 | 필수 |
|------|------|------|--------|------|
| `projectPath` | FR-24-002 | `string` | — | 아니오 |
| `gitRemote` | FR-24-002 | `string` | — | 아니오 |
| `gitBranch` | FR-24-002 | `string` | — | 아니오 |
| `gitLastCommit` | FR-24-002 | `string` | — | 아니오 |

#### 2.3.3 처리

1. `injectFrontmatter` 시그니처 확장:
   ```
   injectFrontmatter(content, { project, docName, description, docType,
                                projectPath, gitRemote, gitBranch, gitLastCommit })
   ```

2. `newFields` 객체에 truthy 값만 추가. YAML 출력 순서:
   ```yaml
   ---
   project: DocuLightViewer
   projectPath: C:/Work/git/_Snoworca/DocuLightViewer
   gitRemote: https://github.com/ice3x2/DocuLightViewer.git
   gitBranch: main
   gitLastCommit: "docs: README에 HTTP URL 방식 MCP 설정 JSON 예시 추가"
   docName: Research Report
   description: Git 메타데이터 자동 수집 연구
   docType: report
   date: 2026-04-01T12:00:00
   ---
   ```

3. `project` 우선순위 규칙:
   - MCP 호출에서 명시적 `project` 전달 → 해당 값 사용 (git 유래 무시)
   - `project` 미전달 + `projectPath` 전달 → git 유래 `project` 사용
   - 둘 다 미전달 → `project` 필드 없음 (기존 동작)

4. 기존 프론트매터가 있는 콘텐츠: 기존 merge 로직 그대로 적용 (신규 필드가 기존 필드 덮어씀)

#### 2.3.4 출력

| 출력 | 타입 | 설명 |
|------|------|------|
| 프론트매터 주입된 content | `string` | YAML 블록이 prepend된 마크다운 |

#### 2.3.5 예외

| 조건 | 처리 |
|------|------|
| 모든 git 필드가 null | projectPath만 있으면 projectPath만 기록. 아무 메타도 없으면 기존 동작 |
| YAML 특수문자 포함 커밋 메시지 | `buildYamlBlock`의 기존 인용부호 처리로 안전 |

---

### 2.4 FR-24-004: 설정 토글 (`mcpGitInfo`)

#### 2.4.1 설명

새 설정 `mcpGitInfo` (boolean, 기본값 `true`)를 추가한다. 이 설정이 `false`이면 `projectPath`가 전달되어도 git 명령을 실행하지 않는다.

#### 2.4.2 입력

| 입력 | 출처 | 타입 | 기본값 | 필수 |
|------|------|------|--------|------|
| `mcpGitInfo` | electron-store | `boolean` | `true` | — |

#### 2.4.3 처리

1. `index.js` electron-store 스키마에 추가:
   ```javascript
   mcpGitInfo: { type: 'boolean', default: true }
   ```

2. Settings UI: MCP 섹션에 체크박스 추가 (`mcpAutoSave` 블록 아래, 기존 `div.form-group` 패턴 준수):
   ```html
   <div class="form-group">
     <div class="checkbox-group">
       <label class="checkbox-label">
         <input type="checkbox" id="mcpGitInfo-checkbox">
         <span data-i18n="settings.mcpGitInfo">Git 정보 자동 수집</span>
       </label>
       <small class="hint" data-i18n="settings.mcpGitInfoHint">
         MCP 문서에 프로젝트 경로가 제공되면 git 정보를 자동으로 프론트매터에 추가합니다.
       </small>
     </div>
   </div>
   ```

3. `settings.js`:
   - `DEFAULTS`에 `mcpGitInfo: true` 추가
   - `populateForm`에서 체크박스 상태 설정
   - `collectFormValues`에서 체크박스 값 수집

4. 설정 읽기 시점: MCP 핸들러에서 `projectPath` 처리 직전에 `store.get('mcpGitInfo')` 호출. 호출 시작 시점의 값 사용 (in-flight 변경 무시)

#### 2.4.4 출력

없음 (설정 저장)

#### 2.4.5 예외

| 조건 | 처리 |
|------|------|
| 설정값이 누락/손상 | electron-store 기본값 `true` 적용 |
| 호출 중 설정 변경 | 호출 시작 시점 값 사용. race condition 없음 |

---

### 2.5 FR-24-005: 메타박스 렌더링 확장

#### 2.5.1 설명

`viewer.js`의 `renderMetabox` 함수에 새 프론트매터 필드의 i18n 레이블을 추가한다.

#### 2.5.2 입력

| 입력 | 출처 | 타입 | 기본값 | 필수 |
|------|------|------|--------|------|
| frontmatter meta 객체 | `parseFrontmatter()` | `object` | — | — |

#### 2.5.3 처리

1. `viewer.js` `renderMetabox` 내 `fieldLabels`에 4개 키 추가:
   ```javascript
   const fieldLabels = {
     project:       t('viewer.metaProject'),
     projectPath:   t('viewer.metaProjectPath'),
     gitRemote:     t('viewer.metaGitRemote'),
     gitBranch:     t('viewer.metaGitBranch'),
     gitLastCommit: t('viewer.metaGitLastCommit'),
     docName:       t('viewer.metaDocName'),
     docType:       t('viewer.metaDocType'),
     description:   t('viewer.metaDescription'),
     date:          t('viewer.metaDate')
   };
   ```

2. 4개 로케일 파일에 i18n 키 추가:

   **ko.json:**
   ```json
   "viewer.metaProjectPath": "프로젝트 경로",
   "viewer.metaGitRemote": "Git Remote",
   "viewer.metaGitBranch": "브랜치",
   "viewer.metaGitLastCommit": "마지막 커밋",
   "settings.mcpGitInfo": "Git 정보 자동 수집",
   "settings.mcpGitInfoHint": "MCP 문서에 프로젝트 경로가 제공되면 git 정보를 프론트매터에 자동 추가"
   ```

   **en.json:**
   ```json
   "viewer.metaProjectPath": "Project Path",
   "viewer.metaGitRemote": "Git Remote",
   "viewer.metaGitBranch": "Branch",
   "viewer.metaGitLastCommit": "Last Commit",
   "settings.mcpGitInfo": "Auto-collect Git info",
   "settings.mcpGitInfoHint": "Automatically add git info to frontmatter when project path is provided via MCP"
   ```

   **ja.json:**
   ```json
   "viewer.metaProjectPath": "プロジェクトパス",
   "viewer.metaGitRemote": "Git Remote",
   "viewer.metaGitBranch": "ブランチ",
   "viewer.metaGitLastCommit": "最後のコミット",
   "settings.mcpGitInfo": "Git情報の自動収集",
   "settings.mcpGitInfoHint": "MCPドキュメントにプロジェクトパスが指定された場合、git情報をフロントマターに自動追加"
   ```

   **es.json:**
   ```json
   "viewer.metaProjectPath": "Ruta del proyecto",
   "viewer.metaGitRemote": "Git Remote",
   "viewer.metaGitBranch": "Rama",
   "viewer.metaGitLastCommit": "Último commit",
   "settings.mcpGitInfo": "Recopilar info Git automáticamente",
   "settings.mcpGitInfoHint": "Agregar automáticamente info git al frontmatter cuando se proporciona la ruta del proyecto vía MCP"
   ```

#### 2.5.4 출력

메타박스 HTML 테이블에 새 행 추가 (해당 필드가 존재하는 경우에만)

#### 2.5.5 예외

| 조건 | 처리 |
|------|------|
| git 필드 없음 | 해당 행 미표시 (기존 동작 — fieldLabels에 없는 키는 raw key fallback) |
| i18n 키 누락 | 영어 fallback (기존 strings.js 동작) |

---

### 2.6 FR-24-006: BM25 검색 인덱싱 확장

#### 2.6.1 설명

`search-engine.js`의 BM25 인덱싱에 git 프론트매터 필드를 추가하여 브랜치명, 커밋 메시지, 리모트 URL로 문서 검색이 가능하도록 한다.

#### 2.6.2 입력

| 입력 | 출처 | 타입 | 기본값 | 필수 |
|------|------|------|--------|------|
| frontmatter 필드 | 저장된 마크다운 파일 | `object` | — | — |

#### 2.6.3 처리

1. `search-engine.js`의 `ovFldNames` (Over Field Names) 배열에 git 관련 필드 추가:
   ```javascript
   // 기존: ['project', 'docName', 'docType']
   // 변경: ['project', 'docName', 'docType', 'gitBranch', 'gitLastCommit']
   ```

2. `gitRemote`와 `projectPath`는 URL/경로이므로 검색 인덱싱에서 **제외** (검색 노이즈 방지)

#### 2.6.4 출력

BM25 검색 결과에 git 메타데이터가 매칭 대상으로 포함됨

#### 2.6.5 예외

| 조건 | 처리 |
|------|------|
| git 필드 없는 기존 저장 문서 | 해당 필드 인덱싱 스킵 (기존 문서 호환성 유지) |

---

## 3. MCP API 변경 사항

### 3.1 `open_markdown` 파라미터 추가

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `projectPath` | `string` | 아니오 | 프로젝트 디렉토리 절대 경로. `mcpGitInfo` 설정이 켜져 있으면 git 메타데이터를 자동 수집하여 프론트매터에 삽입 |

**Zod 스키마 (mcp-server.mjs):**
```javascript
projectPath: z.string().optional()
  .describe('Absolute path to project directory. Auto-collects git metadata when mcpGitInfo setting is enabled.')
```

**JSON 스키마 (mcp-http.mjs):**
```javascript
projectPath: {
  type: 'string',
  description: 'Absolute path to project directory. Auto-collects git metadata when mcpGitInfo setting is enabled.'
}
```

### 3.2 `update_markdown` 파라미터 추가

동일한 `projectPath` 파라미터 추가. `appendMode: true`일 때는 무시됨.

### 3.3 MCP 핸들러 변경 (양쪽 서버 동일 로직)

```
// 기존 frontmatter 인젝션 조건:
if (content && (project || docName || description || docType))

// 변경 후:
if (content && (project || docName || description || docType || gitInfo))
```

여기서 `gitInfo`는 FR-24-001에서 수집된 결과 객체.

---

## 4. 데이터 요구사항

### 4.1 프론트매터 YAML 필드

| 필드 | 타입 | 최대 길이 | 예시 |
|------|------|----------|------|
| `projectPath` | string | OS 경로 제한 | `C:/Work/git/_Snoworca/DocuLightViewer` |
| `gitRemote` | string | 2048자 (URL 제한) | `https://github.com/ice3x2/DocuLightViewer.git` |
| `gitBranch` | string | 250자 (git 제한) | `main`, `feature/step-24` |
| `gitLastCommit` | string | 200자 (truncation) | `docs: README에 HTTP URL 방식 MCP 설정 JSON 예시 추가` |

### 4.2 electron-store 설정

| 키 | 타입 | 기본값 | 설명 |
|-----|------|--------|------|
| `mcpGitInfo` | boolean | `true` | Git 정보 자동 수집 활성화 여부 |

---

## 5. 비기능 요구사항

| 항목 | 요구사항 |
|------|----------|
| **성능** | git 정보 수집으로 인한 MCP 응답 지연: 정상 시 100ms 이내, 최악(타임아웃) 시 5초 이내 |
| **보안** | `execFile` 사용 (shell 미사용), credential sanitization, 절대 경로만 허용 |
| **안정성** | git 실패 시 MCP 도구 정상 응답 보장 (에러 전파 없음) |
| **호환성** | Windows, macOS, Linux 모두 동작. git 미설치 시 graceful 실패 |
| **하위 호환성** | 기존 MCP 호출에 영향 없음. 모든 새 파라미터 optional |

---

## 6. 제약사항

| 제약 | 설명 |
|------|------|
| Node.js `child_process.execFile` | shell 미사용으로 injection 방지. 인자는 배열로 전달 |
| CJS 모듈 | `git-info.js`는 메인 프로세스 CJS 규칙 준수 |
| git PATH 의존 | 시스템 PATH에 `git`이 있어야 동작. 없으면 `ENOENT` → graceful 실패 |
| 타임아웃 5초 | 네트워크 의존 git 명령(remote) 포함하여 일괄 5초 |
| `appendMode` 제한 | appendMode에서는 프론트매터 인젝션 자체가 스킵되므로 git 정보도 미포함 |

---

## 7. 구현 가이드

### 7.1 수정 파일 목록

| # | 파일 | 변경 유형 | 주요 내용 |
|---|------|----------|----------|
| 1 | `src/main/git-info.js` | **신규** | `collectGitInfo(projectPath)` — 비동기 git 정보 수집 |
| 2 | `src/main/frontmatter.js` | 수정 | `injectFrontmatter` 시그니처에 git 필드 4개 추가 |
| 3 | `src/main/mcp-server.mjs` | 수정 | Zod 스키마 `projectPath` 추가, 핸들러에서 git 수집 호출 |
| 4 | `src/main/mcp-http.mjs` | 수정 | TOOLS 스키마 `projectPath` 추가, 핸들러에서 git 수집 호출 |
| 5 | `src/main/window-manager.js` | 수정 | `createWindow`/`updateWindow` destructure에 git 필드 추가 |
| 6 | `src/main/index.js` | 수정 | store 스키마에 `mcpGitInfo`, IPC 핸들러에서 설정 전달 |
| 7 | `src/main/search-engine.js` | 수정 | `ovFldNames`에 `gitBranch`, `gitLastCommit` 추가 |
| 8 | `src/renderer/viewer.js` | 수정 | `renderMetabox` fieldLabels에 4개 키 추가 |
| 9 | `src/renderer/settings.html` | 수정 | MCP 섹션에 `mcpGitInfo` 체크박스 추가 |
| 10 | `src/renderer/settings.js` | 수정 | DEFAULTS/populate/collect에 `mcpGitInfo` 추가 |
| 11 | `src/locales/ko.json` | 수정 | viewer.meta*, settings.mcpGitInfo* 키 추가 |
| 12 | `src/locales/en.json` | 수정 | 동일 |
| 13 | `src/locales/ja.json` | 수정 | 동일 |
| 14 | `src/locales/es.json` | 수정 | 동일 |

### 7.2 MCP 핸들러 처리 순서 (mcp-server.mjs / mcp-http.mjs)

```javascript
// 1. projectPath + 설정 확인 → git 정보 수집
let gitInfo = {};
if (projectPath && path.isAbsolute(projectPath)) {
  const mcpGitInfo = store.get('mcpGitInfo', true);
  if (mcpGitInfo) {
    gitInfo = await collectGitInfo(projectPath);
  } else {
    gitInfo = { projectPath };
  }
}

// 2. project 우선순위 적용
if (project) {
  gitInfo.project = project;  // 명시적 값 우선
} else if (gitInfo.project) {
  project = gitInfo.project;  // git 유래 값 사용
}

// 3. 프론트매터 인젝션 (appendMode 아닐 때만)
if (content && !appendMode && (project || docName || description || docType || gitInfo.projectPath)) {
  content = injectFrontmatter(content, {
    project, docName, description, docType,
    ...gitInfo  // projectPath, gitRemote, gitBranch, gitLastCommit
  });
}
```

### 7.3 `git-info.js` 모듈 구조

```javascript
'use strict';
const { execFile } = require('child_process');
const path = require('path');

const GIT_TIMEOUT_MS = 5000;
const MAX_COMMIT_LENGTH = 200;

function execGit(args, cwd) { /* ... Promise wrapping execFile ... */ }
function sanitizeRemoteUrl(url) { /* ... credential 제거 ... */ }
async function collectGitInfo(projectPath) { /* ... Promise.all 4개 ... */ }

module.exports = { collectGitInfo };
```

---

## 8. 인수 조건

### AC-24-001: projectPath 기본 동작

- **Given**: DocuLight 실행 중, `mcpGitInfo` 설정 `true`
- **When**: `open_markdown({ content: "# Test", projectPath: "<git-repo-path>" })` 호출
- **Then**: 프론트매터에 `project`, `projectPath`, `gitRemote`, `gitBranch`, `gitLastCommit` 필드가 포함됨

### AC-24-002: projectPath 미제공 시 회귀 없음

- **Given**: DocuLight 실행 중
- **When**: `open_markdown({ content: "# Test", project: "MyApp" })` 호출 (`projectPath` 없음)
- **Then**: 기존 동작과 동일. 프론트매터에 git 관련 필드 없음

### AC-24-003: 명시적 project 우선순위

- **Given**: DocuLight 실행 중, `mcpGitInfo` 설정 `true`
- **When**: `open_markdown({ content: "...", project: "CustomName", projectPath: "<git-repo>" })` 호출
- **Then**: 프론트매터의 `project` 필드 값이 `"CustomName"` (git 유래 값이 아님)

### AC-24-004: mcpGitInfo 비활성화

- **Given**: `mcpGitInfo` 설정 `false`
- **When**: `open_markdown({ content: "...", projectPath: "<git-repo>" })` 호출
- **Then**: 프론트매터에 `projectPath`만 포함. `gitRemote`, `gitBranch`, `gitLastCommit` 없음. git 명령 실행되지 않음

### AC-24-005: git 미설치 환경

- **Given**: 시스템에 git 미설치
- **When**: `open_markdown({ content: "...", projectPath: "/some/path" })` 호출
- **Then**: 에러 없이 정상 응답. 프론트매터에 `projectPath`와 `project` (디렉토리명)만 포함

### AC-24-006: 비-git 디렉토리

- **Given**: `projectPath`가 `.git` 없는 일반 디렉토리
- **When**: `open_markdown({ content: "...", projectPath: "<non-git-dir>" })` 호출
- **Then**: 에러 없이 정상 응답. git 필드 없음. `projectPath`와 `project` (디렉토리명)만 포함

### AC-24-007: 타임아웃 처리

- **Given**: git 명령 중 하나가 5초 이상 소요
- **When**: `open_markdown` 호출
- **Then**: 타임아웃된 명령의 필드만 누락. 나머지 성공한 필드는 정상 포함

### AC-24-008: detached HEAD

- **Given**: `projectPath`의 git repo가 detached HEAD 상태
- **When**: `open_markdown({ content: "...", projectPath: "<detached-repo>" })` 호출
- **Then**: `gitBranch` 필드 없음. 나머지 필드 (`gitRemote`, `gitLastCommit`) 정상

### AC-24-009: remote URL credential sanitization

- **Given**: origin remote URL이 `https://user:token@github.com/repo.git`
- **When**: `open_markdown({ content: "...", projectPath: "<repo>" })` 호출
- **Then**: 프론트매터의 `gitRemote` 값이 `https://github.com/repo.git` (credential 제거됨)

### AC-24-010: appendMode에서 projectPath 무시

- **Given**: 기존 창이 열려 있음
- **When**: `update_markdown({ windowId: "...", content: "추가", appendMode: true, projectPath: "<repo>" })` 호출
- **Then**: 프론트매터 인젝션 스킵. content가 기존 내용에 이어붙기됨. git 정보 미포함

### AC-24-011: 상대 경로 거부

- **Given**: DocuLight 실행 중
- **When**: `open_markdown({ content: "...", projectPath: "./relative/path" })` 호출
- **Then**: `projectPath`가 무시됨. git 수집 안 함. 프론트매터에 `projectPath` 필드 없음

### AC-24-012: 메타박스 표시

- **Given**: git 정보가 포함된 프론트매터가 있는 마크다운
- **When**: 뷰어에서 렌더링
- **Then**: 메타박스에 "프로젝트 경로", "Git Remote", "브랜치", "마지막 커밋" 행이 올바른 i18n 레이블로 표시

### AC-24-013: 설정 UI 토글

- **Given**: Settings 화면 열림
- **When**: MCP 섹션 확인
- **Then**: "Git 정보 자동 수집" 체크박스 존재. 체크/해제 시 `mcpGitInfo` 설정값 변경됨

### AC-24-014: BM25 검색

- **Given**: git 메타데이터가 포함된 문서가 저장됨
- **When**: `search_documents({ query: "<branch-name>" })` 호출
- **Then**: 해당 브랜치명이 포함된 문서가 검색 결과에 나타남

### AC-24-015: 커밋 메시지 truncation

- **Given**: 마지막 커밋 subject가 300자
- **When**: `open_markdown({ content: "...", projectPath: "<repo>" })` 호출
- **Then**: 프론트매터의 `gitLastCommit`이 200자 + `…`로 잘림

### AC-24-016: HTTP/stdio 양쪽 동작

- **Given**: DocuLight 실행 중
- **When**: mcp-http.mjs (HTTP)와 mcp-server.mjs (stdio) 양쪽에서 동일한 `projectPath` 호출
- **Then**: 양쪽 모두 동일한 프론트매터 결과 생성

---

## 부록: 전문가 평가 요약

### 평가 라운드 1

| 기준 | 기술 아키텍트 | QA 전문가 | 비즈니스 분석가 |
|------|-------------|----------|---------------|
| 요구사항 완전성 | A | B+ | A |
| 구현 명확성 | A+ | A | B+ |
| 이전 버전 일관성 | A+ | A | A+ |
| 하위 호환성 | A+ | A+ | A+ |
| 에러 처리 완전성 | A | B+ | A |
| API 단순성 | A+ | A+ | A |
| 인수 조건 커버리지 | B+ | B | B+ |

### 라운드 1 주요 피드백 및 반영

| # | 전문가 | 피드백 | 반영 결과 |
|---|--------|--------|----------|
| 1 | QA | Remote URL credential 노출 보안 결함 | FR-24-002 §2.2.3 #4에 sanitization 로직 추가 |
| 2 | QA | appendMode + projectPath 상호작용 미정의 | §1.7 모순 해결 + FR-24-001 §2.1.3 #4에 명시 |
| 3 | 아키텍트 | update_markdown 병합 정책 미명시 | FR-24-003 §2.3.3 #4에 기존 merge 로직 적용 명시 |
| 4 | QA | 긴 커밋 메시지 truncation 필요 | FR-24-002 §2.2.3 #5에 200자 truncation 추가 |
| 5 | QA | 상대 경로 처리 미명시 | FR-24-001 §2.1.3 #2a에 절대 경로 검증 추가, AC-24-011 추가 |
| 6 | QA | i18n 키 목록 미제공 | FR-24-005 §2.5.3 #2에 4개 로케일 전문 추가 |
| 7 | 아키텍트 | detached HEAD 처리 | FR-24-002 §2.2.5에 명시, AC-24-008 추가 |
| 8 | 아키텍트+QA | 인수 조건 미작성 | 섹션 8에 AC-24-001~016 (16개) 추가 |
| 9 | 비즈니스 | BM25 인덱싱 미반영 | FR-24-006 추가, AC-24-014 추가 |
| 10 | 비즈니스 | filePath↔projectPath 관계 | §1.2 범위에 "범위 밖" 명시 |
| 11 | 비즈니스 | 부분 실패 정책 | §1.6 설계 결정에 "개별 필드 독립 실패" 명시 |
| 12 | QA | Windows POSIX 경로 | FR-24-002 §2.2.5에 `path.basename()` 사용으로 문제 없음 명시 |
| 13 | 비즈니스 | projectPath 의미론 | FR-24-001 §2.1.1에 "프로젝트 디렉토리의 절대 경로" 명확화 |
