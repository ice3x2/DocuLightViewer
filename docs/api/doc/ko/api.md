# DocuLight REST API 문서

## 개요

DocuLight는 마크다운 문서 관리를 위한 RESTful API를 제공합니다. API는 공개 엔드포인트와 보호된 엔드포인트로 구성되어 있습니다.

### 기본 정보

- **Base URL**: `http(s)://your-domain/api`
- **Content-Type**: `application/json` (기본)
- **인증 방식**: API Key (X-API-Key 헤더)

---

## 인증

### 보호된 엔드포인트

일부 API 엔드포인트는 인증이 필요합니다. 인증은 HTTP 헤더를 통해 이루어집니다.

**헤더**
```
X-API-Key: your-api-key-here
```

**인증 실패 응답**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "X-API-Key header is required"
  }
}
```

또는

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API key"
  }
}
```

---

## API 엔드포인트

### 1. 트리 구조 조회 (공개)

#### 1.1 단일 디렉토리 트리 조회

특정 디렉토리의 바로 하위 항목(파일 및 디렉토리)을 조회합니다.

**요청**
```http
GET /api/tree?path={path}
```

**Query Parameters**
| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|------|--------|------|
| path | string | No | `/` | 조회할 디렉토리 경로 |

**응답 예시**
```json
{
  "path": "/guide",
  "dirs": [
    { "name": "chapter1" },
    { "name": "chapter2" }
  ],
  "files": [
    { "name": "intro.md", "size": 1024 },
    { "name": "setup.md", "size": 2048 }
  ],
  "excludesApplied": true
}
```

**응답 필드**
- `path`: 조회된 경로
- `dirs`: 하위 디렉토리 배열
  - `name`: 디렉토리 이름
- `files`: 파일 배열
  - `name`: 파일 이름
  - `size`: 파일 크기 (바이트)
- `excludesApplied`: 제외 규칙 적용 여부

**특징**
- 숨김 파일(`.`로 시작)은 자동 제외
- `config.json5`의 `excludes` 설정에 따라 필터링
- 디렉토리와 파일 모두 알파벳순 정렬

**에러 응답**
- `NOT_FOUND`: 경로가 디렉토리가 아님
- `PATH_TRAVERSAL`: 잘못된 경로

---

#### 1.2 전체 재귀 트리 조회

문서 루트부터 모든 하위 디렉토리를 재귀적으로 조회합니다.

**요청**
```http
GET /api/tree/full
```

**Query Parameters**
없음

**응답 예시**
```json
{
  "root": {
    "dirs": [
      {
        "name": "guide",
        "path": "/guide",
        "type": "directory",
        "dirs": [
          {
            "name": "chapter1",
            "path": "/guide/chapter1",
            "type": "directory",
            "dirs": [],
            "files": [
              {
                "name": "lesson1.md",
                "path": "/guide/chapter1/lesson1.md",
                "type": "file",
                "size": 1536
              }
            ]
          }
        ],
        "files": [
          {
            "name": "intro.md",
            "path": "/guide/intro.md",
            "type": "file",
            "size": 1024
          }
        ]
      }
    ],
    "files": [
      {
        "name": "README.md",
        "path": "/README.md",
        "type": "file",
        "size": 512
      }
    ]
  },
  "docsRoot": "/path/to/docs",
  "excludesApplied": true,
  "stats": {
    "totalFiles": 123,
    "totalDirs": 45
  }
}
```

**응답 필드**
- `root`: 루트 트리 구조
  - `dirs`: 하위 디렉토리 배열 (재귀)
    - `name`: 디렉토리 이름
    - `path`: 상대 경로
    - `type`: "directory"
    - `dirs`: 재귀적 하위 디렉토리
    - `files`: 디렉토리 내 파일
  - `files`: 파일 배열
    - `name`: 파일 이름
    - `path`: 상대 경로
    - `type`: "file"
    - `size`: 파일 크기 (바이트)
- `docsRoot`: 문서 루트 절대 경로
- `excludesApplied`: 제외 규칙 적용 여부
- `stats`: 통계 정보
  - `totalFiles`: 전체 파일 수
  - `totalDirs`: 전체 디렉토리 수

**특징**
- 전체 문서 트리를 한 번에 조회
- 숨김 파일 및 제외 규칙 적용
- 모든 경로는 `/`로 시작하는 Unix 스타일

---

### 2. 원본 파일 조회 (공개)

마크다운 파일의 원본 텍스트 내용을 조회합니다.

**요청**
```http
GET /api/raw?path={path}
```

**Query Parameters**
| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| path | string | Yes | 파일 경로 (예: `/guide/intro.md`) |

**응답**
```
Content-Type: text/plain

# Introduction

This is a markdown file...
```

**특징**
- 마크다운 파일(`.md`)만 지원
- 원본 텍스트를 그대로 반환
- Content-Type: `text/plain`

**에러 응답**
- `PATH_TRAVERSAL`: path 파라미터 누락
- `NOT_FOUND`: 파일이 존재하지 않거나 디렉토리임
- `UNSUPPORTED_TYPE`: `.md` 파일이 아님

---

#### 2.1 Clean URL을 통한 원본 다운로드 (신규)

브라우저에서 문서 URL에 `.md` 확장자를 추가하면 원본 파일이 다운로드됩니다.

**요청**
```http
GET /doc/{path}.md
```

**예시**
```
렌더링 URL: http://localhost:3000/doc/guide/intro
다운로드 URL: http://localhost:3000/doc/guide/intro.md
```

**동작**
- `.md` 확장자가 있는 URL → 원본 파일 다운로드
- `.md` 확장자가 없는 URL → 마크다운 뷰어로 렌더링

**응답 헤더**
```
HTTP/1.1 200 OK
Content-Disposition: attachment; filename="intro.md"
Content-Type: text/markdown; charset=UTF-8
Content-Length: 2048
```

**cURL 예시**
```bash
# 원본 다운로드
curl "http://localhost:3000/doc/guide/intro.md" -o intro.md

# 여러 파일 다운로드
for doc in intro setup advanced; do
  curl "http://localhost:3000/doc/guide/$doc.md" -o "$doc.md"
done
```

**vs REST API (`/api/raw`)**

| 측면 | Clean URL (`/doc/*.md`) | REST API (`/api/raw`) |
|------|------------------------|----------------------|
| **용도** | 브라우저 다운로드 | API 호출 |
| **응답 헤더** | Content-Disposition: attachment | Content-Type: text/plain |
| **브라우저 동작** | 다운로드 다이얼로그 | 텍스트 표시 |
| **파일명** | 자동 설정 | 사용자가 직접 저장 |
| **인증** | 불필요 | 불필요 |

**사용 시나리오**
- **Clean URL**: 최종 사용자가 브라우저에서 파일 다운로드
- **REST API**: 프로그램이 파일 내용을 읽어서 처리

---

### 3. 파일 업로드 (보호됨)

파일 또는 ZIP 아카이브를 업로드합니다.

**요청**
```http
POST /api/upload?path={path}
Content-Type: multipart/form-data
X-API-Key: your-api-key
```

**Headers**
| 헤더 | 필수 | 설명 |
|------|------|------|
| X-API-Key | Yes | API 인증 키 |

**Query Parameters**
| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---------|------|------|--------|------|
| path | string | No | `/` | 업로드 대상 디렉토리 경로 |

**Form Data**
| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| file | File | Yes | 업로드할 파일 |

**업로드 제한**
- 최대 파일 크기: `config.json5`의 `maxUploadMB` 설정 (기본: 10MB)

**응답 예시 - 일반 파일**
```json
{
  "success": true,
  "type": "file",
  "filename": "document.md",
  "size": 2048,
  "path": "/guide"
}
```

**응답 예시 - ZIP 파일**
```json
{
  "success": true,
  "type": "zip",
  "filename": "archive.zip",
  "size": 10240,
  "path": "/guide",
  "extraction": {
    "extracted": 5,
    "skipped": 0,
    "errors": 0,
    "details": {
      "extracted": [
        { "name": "doc1.md", "size": 1024 },
        { "name": "doc2.md", "size": 2048 }
      ],
      "skipped": [],
      "errors": []
    }
  }
}
```

**ZIP 파일 처리**
- `.zip` 확장자 파일은 자동으로 압축 해제
- 경로 보안 검사 수행 (path traversal 방지)
- `..` 또는 절대 경로가 포함된 항목은 건너뜀
- 대상 디렉토리 외부로의 추출 차단

**ZIP 추출 보안**
- Path traversal 시도 차단 (`../` 포함)
- 절대 경로 차단
- 대상 디렉토리 외부 추출 방지
- 디렉토리 엔트리 자동 생성

**동작 방식**
- 기존 파일이 있으면 덮어쓰기
- 대상 디렉토리가 없으면 자동 생성
- 디렉토리 단위 잠금으로 동시 수정 방지

**에러 응답**
- `PAYLOAD_TOO_LARGE`: 파일 크기 초과 또는 파일 없음
- `UNAUTHORIZED`: 인증 실패

---

### 4. 파일/디렉토리 삭제 (보호됨)

파일 또는 디렉토리를 삭제합니다.

**요청**
```http
DELETE /api/entry?path={path}
X-API-Key: your-api-key
```

**Headers**
| 헤더 | 필수 | 설명 |
|------|------|------|
| X-API-Key | Yes | API 인증 키 |

**Query Parameters**
| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| path | string | Yes | 삭제할 파일/디렉토리 경로 |

**응답 예시**
```json
{
  "success": true,
  "path": "/guide/old-doc.md",
  "message": "Entry deleted successfully"
}
```

**특징**
- 파일과 디렉토리 모두 삭제 가능
- 디렉토리는 재귀적으로 삭제 (하위 항목 포함)
- 파일이 사용 중일 경우 최대 2회 재시도 (1초 간격)
- 경로 잠금으로 동시 삭제 방지

**에러 응답**
- `PATH_TRAVERSAL`: path 파라미터 누락
- `NOT_FOUND`: 경로가 존재하지 않음
- `FILE_BUSY`: 파일이 사용 중이어서 삭제 불가
- `UNAUTHORIZED`: 인증 실패

---

### 5. 파일 다운로드 (보호됨)

단일 파일을 다운로드합니다.

**요청**
```http
GET /api/download/file?path={path}
X-API-Key: your-api-key
```

**Headers**
| 헤더 | 필수 | 설명 |
|------|------|------|
| X-API-Key | Yes | API 인증 키 |

**Query Parameters**
| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| path | string | Yes | 다운로드할 파일 경로 |

**응답**
- Content-Type: `application/octet-stream`
- Content-Disposition: `attachment; filename="filename.ext"`
- Content-Length: 파일 크기
- Body: 파일 바이너리 스트림

**특징**
- 파일 스트리밍 방식으로 메모리 효율적
- 모든 파일 타입 지원

**에러 응답**
- `PATH_TRAVERSAL`: path 파라미터 누락
- `NOT_FOUND`: 파일이 존재하지 않거나 디렉토리임
- `UNAUTHORIZED`: 인증 실패

---

### 6. 디렉토리 다운로드 (보호됨)

디렉토리를 ZIP 파일로 압축하여 다운로드합니다.

**요청**
```http
GET /api/download/dir?path={path}
X-API-Key: your-api-key
```

**Headers**
| 헤더 | 필수 | 설명 |
|------|------|------|
| X-API-Key | Yes | API 인증 키 |

**Query Parameters**
| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|------|------|
| path | string | Yes | 다운로드할 디렉토리 경로 |

**응답**
- Content-Type: `application/zip`
- Content-Disposition: `attachment; filename="dirname.zip"`
- Body: ZIP 파일 스트림

**특징**
- 디렉토리 전체를 ZIP으로 압축
- `config.json5`의 `excludes` 규칙 적용
- 압축 레벨: 9 (최대 압축)
- 스트리밍 방식으로 대용량 디렉토리 지원

**에러 응답**
- `PATH_TRAVERSAL`: path 파라미터 누락
- `NOT_FOUND`: 디렉토리가 존재하지 않거나 파일임
- `UNAUTHORIZED`: 인증 실패

---

## 에러 코드

모든 에러 응답은 다음 형식을 따릅니다:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message"
  }
}
```

### 에러 코드 목록

| 코드 | HTTP 상태 | 설명 |
|------|-----------|------|
| `UNAUTHORIZED` | 401 | API 키 누락 또는 잘못됨 |
| `PATH_TRAVERSAL` | 400 | 잘못된 경로 또는 필수 파라미터 누락 |
| `NOT_FOUND` | 404 | 요청한 파일/디렉토리가 존재하지 않음 |
| `UNSUPPORTED_TYPE` | 400 | 지원하지 않는 파일 형식 |
| `PAYLOAD_TOO_LARGE` | 413 | 업로드 파일 크기 초과 |
| `FILE_BUSY` | 500 | 파일이 사용 중이어서 작업 불가 |
| `INTERNAL_ERROR` | 500 | 서버 내부 오류 |

---

## 보안 기능

### 1. 경로 검증
- 모든 경로는 `path-validator` 유틸리티로 검증
- Path traversal 공격 방지 (`../` 차단)
- 문서 루트 외부 접근 차단

### 2. 인증
- 보호된 엔드포인트는 API 키 필수
- API 키는 HTTP 헤더(`X-API-Key`)로 전송
- 키 불일치 시 401 응답

### 3. 파일 업로드 보안
- 파일 크기 제한 (설정 가능)
- ZIP 파일 추출 시 path traversal 차단
- 안전한 경로만 추출 허용

### 4. 동시성 제어
- Lock Manager를 통한 파일/디렉토리 단위 잠금
- 동시 수정/삭제 방지
- 데이터 무결성 보장

### 5. 파일 필터링
- 숨김 파일 자동 제외 (`.`로 시작)
- 사용자 정의 제외 패턴 지원 (`excludes`)
- ignore 라이브러리 기반 필터링

---

## 사용 예시

### cURL 예시

#### 1. 트리 조회
```bash
curl "http://localhost:3000/api/tree?path=/guide"
```

#### 2. 파일 내용 조회
```bash
curl "http://localhost:3000/api/raw?path=/README.md"
```

#### 3. 파일 업로드
```bash
curl -X POST "http://localhost:3000/api/upload?path=/guide" \
  -H "X-API-Key: your-api-key" \
  -F "file=@document.md"
```

#### 4. ZIP 파일 업로드 (자동 압축 해제)
```bash
curl -X POST "http://localhost:3000/api/upload?path=/guide" \
  -H "X-API-Key: your-api-key" \
  -F "file=@archive.zip"
```

#### 5. 파일 삭제
```bash
curl -X DELETE "http://localhost:3000/api/entry?path=/guide/old.md" \
  -H "X-API-Key: your-api-key"
```

#### 6. 파일 다운로드
```bash
curl "http://localhost:3000/api/download/file?path=/guide/doc.md" \
  -H "X-API-Key: your-api-key" \
  -o doc.md
```

#### 7. 디렉토리 ZIP 다운로드
```bash
curl "http://localhost:3000/api/download/dir?path=/guide" \
  -H "X-API-Key: your-api-key" \
  -o guide.zip
```

### JavaScript/Fetch 예시

```javascript
// 트리 조회
const tree = await fetch('/api/tree?path=/guide').then(r => r.json());

// 파일 업로드
const formData = new FormData();
formData.append('file', fileInput.files[0]);

const uploadResult = await fetch('/api/upload?path=/guide', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your-api-key'
  },
  body: formData
}).then(r => r.json());

// 파일 삭제
const deleteResult = await fetch('/api/entry?path=/guide/old.md', {
  method: 'DELETE',
  headers: {
    'X-API-Key': 'your-api-key'
  }
}).then(r => r.json());
```


