좋습니다. 지금까지의
# 🧩 System Design Specification (SDS)

## Project: **DocuLight**

### Subtitle: *Lightweight Markdown Document Viewer & Manager*

---

## 1. 시스템 개요

**MarkLight**는 Markdown 문서를 탐색·열람·관리하기 위한 경량 웹 서버입니다.
`Node.js + Express + EJS` 기반으로, 설정 파일(JSON5)을 통해 문서 루트를 지정하고,
브라우저에서 디렉터리 트리 탐색과 문서 렌더링을 제공합니다.
좌측 트리 UI는 옵시디언(Obsidian)과 동일한 UX를 목표로 하며,
브라우저의 **IndexedDB**에 디렉터리 접힘/펼침 상태를 유지합니다.

---

## 2. 시스템 구성도

```
┌──────────────────────────────┐
│          Web Browser         │
│──────────────────────────────│
│  EJS 렌더링된 UI Shell       │
│  marked.js + mermaid.js      │
│  IndexedDB(treeState)        │
│  Fetch REST API              │
└───────────────┬──────────────┘
                │ HTTP/REST
┌───────────────┴────────────────┐
│        Node.js Express         │
│────────────────────────────────│
│ Auth Middleware (X-API-Key)    │
│ FileOps Controller             │
│  ├─ GET /api/tree              │
│  ├─ POST /api/upload           │
│  ├─ DELETE /api/entry          │
│  ├─ GET /api/download/*        │
│  ├─ GET /raw (md 원문 반환)    │
│ File System Layer (fs/path)    │
│ Exclude Filter (gitignore 규칙)│
│ Concurrency Lock Manager       │
│ Logger (winston/pino)          │
└────────────────────────────────┘
```

---

## 3. 주요 컴포넌트 설계

### 3.1 설정 모듈 (`config-loader`)

* **형식:** JSON5
* **필수 항목:**

  ```json5
  {
    docsRoot: "/data/docs",   // 문서 루트
    apiKey: "REDACTED",       // REST API 인증 키
    maxUploadMB: 10,          // 단일 업로드 파일 크기 제한
    excludes: [               // gitignore 호환 패턴
      "**/.git/",
      "**/.DS_Store",
      "*.tmp"
    ],
    logDir: "./log"           // 로그 출력 경로
  }
  ```
* **유효성 검증**

    * docsRoot가 실제 존재하고 디렉터리인지 확인 (`fs.statSync`).
    * apiKey가 비어있으면 오류로 종료.
    * maxUploadMB가 1~1000 범위 이외면 경고 출력 후 기본값 10으로 대체.
    * excludes 배열 요소가 문자열이 아닌 경우 무시.

---

### 3.2 인증 미들웨어 (`auth-middleware.js`)

* 모든 **쓰기/삭제/다운로드** 관련 라우트는 `X-API-Key` 헤더를 검사한다.
* **검증 로직**

  ```js
  if (req.header("X-API-Key") !== config.apiKey) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
  }
  next();
  ```
* **예외**

    * 헤더 누락 시: `401 Unauthorized`
    * 키 불일치: `401 Unauthorized`
    * GET /api/tree, GET /raw 등 읽기 전용 API는 키 불필요.

---

### 3.3 디렉터리 트리 로직 (`tree-controller.js`)

* **입력 파라미터:** `path` (상대경로, 기본값 `/`)

* **동작**

    1. `path.resolve(config.docsRoot, path)` 계산 후
       `startsWith(config.docsRoot)` 로 루트 밖 접근 차단.
    2. `.gitignore` 호환 필터(`ignore` 라이브러리)로 제외 항목 필터링.
    3. 디렉터리 내 엔트리를 사전식 정렬 후 반환.
    4. 파일명/디렉터리명은 URL-safe 인코딩.

* **응답 예시**

  ```json
  {
    "path": "/docs",
    "dirs": [{ "name": "guide" }, { "name": "reference" }],
    "files": [{ "name": "README.md", "size": 1024 }],
    "excludesApplied": true
  }
  ```

* **예외상황**

  | 상황                  | 상태코드 | code              | 설명       |
    | ------------------- | ---- | ----------------- | -------- |
  | path 파라미터가 루트 밖     | 400  | PATH_TRAVERSAL    | 루트 경로 이탈 |
  | 디렉터리 없음             | 404  | NOT_FOUND         |          |
  | 접근 권한 없음 (파일 권한 문제) | 403  | PERMISSION_DENIED |          |
  | 기타 FS 오류            | 500  | INTERNAL          |          |

---

### 3.4 파일 업로드 (`upload-controller.js`)

* **라우트:** `POST /api/upload?path=<dir>`

* **구현:** `multer` 사용, `limits.fileSize = maxUploadMB * 1024 * 1024`

* **정책**

    * 동일 파일 존재 시 **항상 덮어쓰기**
    * ZIP 파일이면 해당 경로에 **상대경로 기준으로 해제**
    * 경로 충돌 시 **항상 덮어쓰기**
    * 업로드 후 로그 기록 (`op=upload`, `absPath`, `size`)

* **예외상황**

  | 상황             | 상태코드 | code              | 설명               |
    | -------------- | ---- | ----------------- | ---------------- |
  | 인증 실패          | 401  | UNAUTHORIZED      | X-API-Key 누락/불일치 |
  | 경로 이탈          | 400  | PATH_TRAVERSAL    | 루트 밖 접근          |
  | 디렉터리 없음        | 404  | NOT_FOUND         |                  |
  | 파일 크기 초과       | 413  | PAYLOAD_TOO_LARGE | maxUploadMB 초과   |
  | ZIP 해제 중 권한 문제 | 403  | PERMISSION_DENIED |                  |
  | 업로드 중 I/O 오류   | 500  | INTERNAL          |                  |

* **경로 안전성 보장**

    * ZIP 해제 시 내부 파일의 경로에 `../` 포함되면 무시(log.warn).
    * 압축 내부에 빈 디렉터리만 존재하면 skip 처리.

---

### 3.5 파일 삭제 (`delete-controller.js`)

* **라우트:** `DELETE /api/entry?path=<fileOrDir>`
* **기능:** 파일/디렉터리 **재귀 삭제** (`fs.rmSync(target, { recursive: true, force: true })`)
* **락 처리:** `async-lock`으로 경로별 임계영역 확보
* **예외**

  | 상황          | 코드             | 설명            |
    | ----------- | -------------- | ------------- |
  | 인증 실패       | UNAUTHORIZED   |               |
  | 루트 밖 접근     | PATH_TRAVERSAL |               |
  | 존재하지 않음     | NOT_FOUND      |               |
  | 삭제 중 파일 사용중 | FILE_BUSY      | retry 2회 후 실패 |
  | I/O 오류      | INTERNAL       |               |

---

### 3.6 다운로드 (`download-controller.js`)

#### 3.6.1 파일 다운로드

* `GET /api/download/file?path=<file>`

    * 헤더 `X-API-Key` 필수
    * 응답: `Content-Disposition: attachment; filename="<encodedName>"`

#### 3.6.2 디렉터리 ZIP 다운로드

* `GET /api/download/dir?path=<dir>`

    * ZIP 파일명 = `<디렉터리명>.zip`
    * 스트리밍 방식 (`archiver` 이용)
    * 제외 규칙(excludes) 동일 적용

* **예외**

  | 상황             | 코드             | 설명       |
    | -------------- | -------------- | -------- |
  | 인증 실패          | UNAUTHORIZED   |          |
  | 디렉터리 없음        | NOT_FOUND      |          |
  | excludes 대상 포함 | EXCLUDED       | 제외 규칙 적용 |
  | ZIP 생성 중 오류    | INTERNAL       |          |
  | 경로 이탈          | PATH_TRAVERSAL |          |

---

### 3.7 원문 제공 (`GET /raw?path=<file>`)

* **목적:** 클라이언트가 `marked`로 렌더링할 Markdown 원문 획득
* **예외:**

    * 루트 밖 접근 → 400
    * `.md` 확장자 이외 파일 → 415 (Unsupported Type)
    * 존재하지 않음 → 404
    * 파일 권한 오류 → 403

---

### 3.8 브라우저 IndexedDB 구조

```js
database: "marklight"
store: "treeState"
key: dirPath (string)
value: { expanded: boolean, ts: number }

store: "lastOpened"
key: "file"
value: { path: string, ts: number }
```

---

## 4. 동시성 제어

* **Lock Key:** 절대경로
* **대상:** 업로드, 삭제, ZIP 해제/생성
* **전략:**

    * `async-lock` 이용, 경로별 Mutex Map 관리.
    * 동일 경로 요청이 병렬로 들어오면 대기 → 타임아웃(10초) 시 `409 Conflict`.
    * 정상 종료 후 lock 해제.
* **예외처리**

    * Deadlock 방지: lock 획득 실패 시 2초 단위 재시도 최대 5회.
    * 실패 시 로그 `[LOCK_TIMEOUT]`.

---

## 5. 로깅 및 에러 관리

### 5.1 로깅

* **라이브러리:** `winston`
* **로그 레벨:** info, warn, error
* **로그 디렉토리:** `config.logDir`
* **파일명 규칙:**

    * `marklight-YYYYMMDD.log`
    * 10MB 초과 시 롤링 (`marklight-YYYYMMDD-1.log`)
* **형식 예시**

  ```
  [2025-10-23T11:35:10Z] INFO [UPLOAD] path=/docs/guide.md size=10412 user=api
  [2025-10-23T11:36:21Z] ERROR [ZIP] code=PATH_TRAVERSAL file=../../etc/passwd
  ```

### 5.2 에러 응답 표준

```json
{
  "error": {
    "code": "PATH_TRAVERSAL",
    "message": "Access outside docsRoot is not allowed."
  }
}
```

### 5.3 예외 상황별 요약

| 구분         | 코드                | 상태  | 복구 방법       |
| ---------- | ----------------- | --- | ----------- |
| 루트 밖 접근    | PATH_TRAVERSAL    | 400 | 경로 검증 강화    |
| 인증 실패      | UNAUTHORIZED      | 401 | API Key 확인  |
| 권한 거부      | PERMISSION_DENIED | 403 | 파일 권한 조정    |
| 파일 없음      | NOT_FOUND         | 404 | 경로 재확인      |
| 업로드 크기 초과  | PAYLOAD_TOO_LARGE | 413 | 설정값 조정      |
| 경로 충돌      | CONFLICT          | 409 | 재시도         |
| 제외 규칙      | EXCLUDED          | 403 | excludes 수정 |
| ZIP 내부 ../ | PATH_TRAVERSAL    | 400 | 압축 정정       |
| I/O 오류     | INTERNAL          | 500 | 재시도         |
| 락 타임아웃     | LOCK_TIMEOUT      | 409 | 재시도         |
| MIME 불허    | UNSUPPORTED_TYPE  | 415 | 확장자 확인      |

---

## 6. 보안 설계

| 항목        | 내용                                          |
| --------- | ------------------------------------------- |
| 인증        | 단일 API Key (X-API-Key)                      |
| 권한        | 읽기 공개, 쓰기/삭제/다운로드 보호                        |
| 경로 검증     | `startsWith(docsRoot)` 필수, symbolic link 무시 |
| XSS 방지    | marked + DOMPurify                          |
| 파일 확장자 제한 | .md, .zip, .png, .jpg, .pdf 등 설정 기반         |
| 로그 보호     | 로그 내 API 키 마스킹 처리                           |

---

## 7. 운영 및 배포

| 항목    | 내용                                        |
| ----- | ----------------------------------------- |
| 환경    | Node.js 18+, 단일 인스턴스                      |
| 실행    | PM2 (`pm2 start app.js --name marklight`) |
| 로그 위치 | `./log/marklight-YYYYMMDD.log`            |
| 헬스체크  | `GET /healthz` → 200 OK                   |
| 백업    | 설정 파일 및 docsRoot 주기적 백업                   |
| 업데이트  | zip 업로드로 전체 문서 교체 가능                      |
| 장애 복구 | 로그 분석 후 손상 파일 복원 (파일시스템 기반)               |

---

## 8. 확장 고려사항 (후속 버전)

* 다중 루트 지원 (`docsRoots[]`)
* 복수 API 키 / 권한 스코프 분리
* 서버측 캐시 및 Markdown pre-render
* 파일 버저닝/히스토리
* 사용자 인증 (JWT)
* 검색 기능 (全文 search)
* WebSocket 기반 실시간 문서 변경 반영

---

## 9. 테스트 시나리오 (예외 포함)

| 시나리오                                  | 기대 결과                 | 상태          |
| ------------------------------------- | --------------------- | ----------- |
| 루트 밖 경로 요청 `/api/tree?path=../../etc` | 400 PATH_TRAVERSAL    | PASS        |
| 숨김 파일 `.gitignore` 포함 폴더              | 목록에서 제외               | PASS        |
| 업로드 크기 초과(>10MB)                      | 413 PAYLOAD_TOO_LARGE | PASS        |
| ZIP 내부에 `../etc/passwd`               | 무시, log.warn          | PASS        |
| 디렉터리 삭제 중 파일 사용중                      | 409 FILE_BUSY         | 재시도 2회 후 실패 |
| 같은 파일 동시 업로드                          | 첫 번째 완료 후 두 번째 덮어쓰기   | PASS        |
| 업로드 중 디스크 풀                           | 500 INTERNAL          | PASS        |
| API Key 누락                            | 401 UNAUTHORIZED      | PASS        |
| excludes 항목 업로드 시도                    | 403 EXCLUDED          | PASS        |
| ZIP 다운로드 중 네트워크 끊김                    | 스트림 중단, 에러 로그         | PASS        |
| 파일 권한 오류(읽기 불가)                       | 403 PERMISSION_DENIED | PASS        |

---

## 10. 결론

**MarkLight**는 단일 API 키 기반의 간단한 Markdown 문서 관리 서버로,
안전한 파일 접근과 풍부한 예외처리를 포함하여
“비개발자도 쉽게 문서를 업로드·열람할 수 있는” 경량 인프라를 목표로 한다.
