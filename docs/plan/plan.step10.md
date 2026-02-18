## Step 10: 설정 확대 및 문서 개선 — 다국어 지원, 자동 설정, 로그 관리

작성일: 2025-10-29

### 한 줄 요약
시스템 설정 범위를 확대하고 (1) UI 최대 넓이 제어, (2) 다국어 문서 지원, (3) config.json 자동 생성, (4) 로그 저장 기간 관리, (5) README 간소화를 통해 사용성을 향상시킨다.

---

## 목표 및 요구사항

### 1. UI 최대 넓이 설정

#### 현재 상태
- 뷰 영역이 페이지마다 다양한 크기로 렌더링됨
- 사용자가 최대 넓이를 제어할 수 없음

#### 목표
- UI 최대 넓이를 `config.json`의 `ui.maxWidth`로 설정 가능
- 기본값: `"1024px"`
- 단위 포함 가능: px, %, em 등

#### 구현 전략

**1) config.json5 구조:**
```json5
{
  ui: {
    title: "DocLight",
    icon: "/images/icon.png",
    maxWidth: "1024px"  // 새로 추가
  }
}
```

**2) 적용 위치:**
- `src/views/index.ejs`: 마크다운 콘텐츠 영역 최대 넓이 적용
- CSS 클래스: `.markdown-content { max-width: var(--max-width); }`
- 서버 렌더링: EJS 변수로 `<%= uiMaxWidth %>` 전달

**3) 기본값 설정:**
```javascript
const defaultMaxWidth = config.ui?.maxWidth || "1024px";
```

#### 에지 케이스 처리
- 유효하지 않은 값 → 기본값으로 폴백
- 문자열 검증 필요

---

### 2. 다국어 문서 지원

#### 현재 상태
- API 문서: `/docs/api/api.md`, `/docs/api/api-curl-example.md`
- MCP 문서: `/docs/mcp/mcp.md`
- 모두 한국어로 작성됨

#### 목표
- **기본 문서** (영어): `/docs/api/doc/api.md`, `/docs/mcp/doc/mcp.md`
- **한국어 문서**: `/docs/api/doc/ko/api.md`, `/docs/mcp/doc/ko/mcp.md`
- 기존 한국어 문서를 영어로 번역하여 기본 문서 생성
- 한국어 문서는 `/doc/ko/` 경로에 보관

#### 구현 전략

**1) 디렉토리 구조:**
```
docs/
  api/
    doc/
      api.md                 # 영어 (기본)
      api-curl-example.md    # 영어 (기본)
      ko/
        api.md              # 한국어
        api-curl-example.md # 한국어
  mcp/
    doc/
      mcp.md                # 영어 (기본)
      ko/
        mcp.md             # 한국어
```

**2) 문서 작성 요구사항:**
- API 분석: 현재 코드의 모든 엔드포인트 검토
  - GET /api/tree
  - GET /api/tree/full
  - GET /api/raw
  - GET /api/search
  - POST /api/upload
  - DELETE /api/entry
  - GET /api/download/file
  - GET /api/download/dir
  - GET /healthz
- MCP 분석: MCP 관련 구현 검토
- 부족한 부분 채우기
- **금지 사항**: 프로젝트 구조, 보안 모델, 제한사항 등 불필요한 내용 제외

**3) 기본 문서 항목:**
- Endpoint 설명
- Request/Response 예시
- Authentication (필요시)
- Error Handling
- Rate Limiting (해당 시)

#### 에지 케이스 처리
- 영어 문서 없을 시 생성
- 한국어 문서 검증

---

### 3. Config.json 자동 생성

#### 현재 상태
- `config.json5` 파일이 없으면 서버 시작 실패
- 사용자가 수동으로 파일을 생성해야 함

#### 목표
- `config.json5` 파일이 없으면 기본값으로 자동 생성
- 생성된 파일은 `config.example.json5`와 동일한 기본값 사용
- 생성 후 서버 정상 시작

#### 구현 전략

**1) config-loader.js 수정:**
```javascript
function loadConfig() {
  const configPath = path.join(process.cwd(), 'config.json5');

  if (!fs.existsSync(configPath)) {
    // config.json5 생성
    const examplePath = path.join(__dirname, '../../config.example.json5');
    const exampleContent = fs.readFileSync(examplePath, 'utf-8');
    fs.writeFileSync(configPath, exampleContent);
    console.log('config.json5 자동 생성됨');
  }

  // 기존 로드 로직
  const content = fs.readFileSync(configPath, 'utf-8');
  return JSON5.parse(content);
}
```

**2) 테스트 방법:**
- config.json5를 config.json5.bak으로 이름 변경
- 서버 재시작
- config.json5 자동 생성 확인

#### 에지 케이스 처리
- 기존 파일이 있으면 덮어쓰지 않음
- 생성 권한 확인

---

### 4. 로그 저장 기간 설정

#### 현재 상태
- 로그는 매일 자동 로테이션됨
- 저장 기간을 제어할 수 없음

#### 목표
- `config.json`의 `log` 섹션에서 로그 설정 가능
- 기본 저장 기간: 30일
- 로그 저장 기간이 지난 파일 자동 삭제

#### 구현 전략

**1) config.json5 구조:**
```json5
{
  log: {
    dir: "./logs",           // 로그 디렉토리
    level: "info",           // 로그 레벨
    maxDays: 30,             // 저장 기간 (일)
    // 향후 확장용
    history: true            // 로그 히스토리 보관 여부
  }
}
```

**2) logger.js 수정:**
```javascript
function createLogger(config) {
  const logDir = config.log?.dir || './logs';
  const maxDays = config.log?.maxDays || 30;

  // Winston 설정 시 maxDays 적용
  // 오래된 로그 파일 삭제 로직 추가

  setupLogCleanup(logDir, maxDays);
}

function setupLogCleanup(logDir, maxDays) {
  // 정기적으로 maxDays 이상 된 로그 파일 삭제
  setInterval(() => {
    deleteOldLogs(logDir, maxDays);
  }, 1000 * 60 * 60); // 1시간마다 확인
}
```

**3) 로그 정리 함수:**
```javascript
function deleteOldLogs(logDir, maxDays) {
  const files = fs.readdirSync(logDir);
  const now = Date.now();
  const maxAgeMs = maxDays * 24 * 60 * 60 * 1000;

  files.forEach(file => {
    const filePath = path.join(logDir, file);
    const stats = fs.statSync(filePath);

    if (now - stats.mtime.getTime() > maxAgeMs) {
      fs.unlinkSync(filePath);
    }
  });
}
```

**4) config.example.json5에 추가:**
```json5
log: {
  dir: "./logs",
  level: "info",
  maxDays: 30,
  history: true
}
```

#### 에지 케이스 처리
- maxDays가 0 이하일 경우 처리
- 로그 디렉토리 없을 시 생성

---

### 5. README.md 개선

#### 현재 상태
- 프로젝트 구조에 대한 복잡한 설명 포함
- 사용자 입장에서의 필수 정보 부족

#### 목표
- **제거 대상**: 프로젝트 구조, 보안 모델, 제한사항 등 기술적 상세 내용
- **추가 대상**:
  1. 빠른 시작 (Quick Start)
  2. 기동 방법 (Running the Application)
  3. API 문서 위치
  4. 설정 방법 (Configuration)
  5. MCP 추가 방법 (Claude Code, Copilot)
  6. API 호출 방법 (API Usage Examples)

#### 구현 전략

**1) README.md 구조:**
```markdown
# DocLight

한 줄 설명

## Features (주요 기능 간단히)

## Quick Start

### Prerequisites
- Node.js 14+

### Installation
```bash
npm install
```

### Running the Application
```bash
# Development
npm run dev

# Production
npm start
```

## Configuration

### Basic Setup

#### config.json5 설정
```bash
# 설정 파일 복사
cp config.example.json5 config.json5

# 설정 파일 편집
vi config.json5
```

#### 필수 설정 항목

**1) docsRoot - 문서 디렉토리 경로 (필수)**
```json5
{
  docsRoot: "/path/to/your/documents"  // 절대 경로 권장
}
```

에러 처리:
- 경로가 존재하지 않음 → 에러: `docsRoot directory does not exist: ...`
- 경로가 디렉토리가 아님 → 에러: `docsRoot is not a directory: ...`
- 경로 접근 불가 → 에러: `Cannot access docsRoot: ...`

**2) apiKey - API 인증 키 (필수)**
```json5
{
  apiKey: "your-secure-random-key"  // 반드시 변경 필요
}
```

에러 처리:
- 기본값 그대로 사용 → 에러: `apiKey must be set to a secure value`

**3) maxWidth - UI 최대 넓이 (선택, 기본값: 1024px)**
```json5
{
  ui: {
    maxWidth: "1024px"  // 단위 포함 가능: px, %, em 등
  }
}
```

**4) Log 관련 설정 (선택)**
```json5
{
  log: {
    dir: "./logs",      // 로그 디렉토리
    level: "info",      // 로그 레벨: error, warn, info, debug
    maxDays: 30         // 로그 보관 기간 (일)
  }
}
```

## Documentation

- API 문서: `/docs/api/doc/` (웹: `http://localhost:3000/api/doc`)
- API 한국어 문서: `/docs/api/doc/ko/` (웹: `http://localhost:3000/api/doc/ko`)
- MCP 문서: `/docs/mcp/doc/` (웹: `http://localhost:3000/mcp/doc`)
- MCP 한국어 문서: `/docs/mcp/doc/ko/` (웹: `http://localhost:3000/mcp/doc/ko`)

## MCP Integration

### Claude Code
1. Claude Code에서 MCP 추가
2. [링크/설명]

### GitHub Copilot
1. Copilot에서 MCP 추가
2. [링크/설명]

## API Usage Examples

### Search Documents
```bash
curl 'http://localhost:3000/api/search?query=test'
```

### Get File Tree
```bash
curl 'http://localhost:3000/api/tree?path=/'
```

### Upload File
```bash
curl -X POST \
  -H "X-API-Key: your-api-key" \
  -F "file=@file.md" \
  'http://localhost:3000/api/upload?path=/docs'
```

## Support

- Issue: GitHub Issues
- Documentation:
  - `/docs/api/doc/` (API)
  - `/docs/api/doc/ko/` (API 한국어)
  - `/docs/mcp/doc/` (MCP)
  - `/docs/mcp/doc/ko/` (MCP 한국어)
```

**2) 작성 원칙:**
- 명령어와 예시 중심
- 간결하고 직관적
- 사용자 입장 우선

#### 에지 케이스 처리
- 문서 링크 정확성 확인

---

## 구현 순서

1. **UI 최대 넓이 설정** (수준: 쉬움)
   - config 추가
   - 렌더링 적용
   - 테스트

2. **다국어 문서** (수준: 중간)
   - 영어 문서 작성 (API, MCP)
   - 한국어 문서 이동
   - 문서 경로 정리

3. **Config 자동 생성** (수준: 쉬움)
   - config-loader 수정
   - 테스트

4. **로그 관리** (수준: 중간)
   - 설정 구조 추가
   - 로그 정리 로직 구현
   - 테스트

5. **README 개선** (수준: 쉬움)
   - 기존 내용 제거
   - 새 구조 작성
   - 검증

---

## 예상 시간

- UI 설정: 1-2시간
- 문서 국제화: 3-4시간
- Config 자동 생성: 1시간
- 로그 관리: 2시간
- README: 1시간
- **총: 8-10시간**

---

## 성공 기준

- ✅ config.json 자동 생성 및 복구
- ✅ UI maxWidth 설정 적용 및 렌더링
- ✅ 다국어 문서 구조 완성
- ✅ 로그 30일 자동 정리
- ✅ README 간결화 및 사용성 향상
- ✅ 모든 기능 테스트 완료
