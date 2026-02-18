
# Nano-SRS — MD 파일 뷰어 웹 서버 (Node.js + Express + EJS)

## 1. 목적/범위

* **목적**: 사내에서 Markdown 문서 트리(옵시디언 좌측 메뉴 유사)를 브라우저로 탐색·열람하고, REST API로 업/다운로드·삭제를 수행한다.
* **범위**: 단일 인스턴스 서비스, 하나의 문서 루트만 지원. 브라우저 내 DB에 접힘/펼침 UI 상태 저장.

## 2. 용어

* **문서 루트**: 설정된 단 하나의 최상위 디렉터리.
* **인덱스 DB**: 브라우저 내장 DB(IndexedDB)로, 디렉토리 접힘/펼침 상태 저장소.
* **설정 파일**: JSON5 형식. 서비스 동작과 제한(최대 업로드 크기, 제외 규칙 등)을 정의.

## 3. 이해관계자/사용자

* **Viewer(사내 사용자)**: 문서 트리 탐색·열람·다운로드.
* **Admin(운영자)**: API 키 소유. 업로드/삭제/다운로드 가능. (역할 분리 없이 **단일 API 키**로 제어)

## 4. 상위 요구사항

4.1 **트리 UI**

* 문서 루트 하위 디렉터리를 **사전식**으로 정렬해 좌측 패널에 표시.
* 디렉터리는 굵게 표시, 하단에 `.md` 파일 목록 표시.
* 숨김파일(`.` 시작)은 **표시하지 않음**.
* `excludes`(gitignore 규칙과 동일 로직)로 지정된 항목은 표시·API 대상에서 제외.
* 디렉터리 **접힘/펼침 상태를 IndexedDB에 저장**하고, 재방문 시 그대로 복원.

4.2 **렌더링**

* 프론트엔드에서 **marked**로 렌더링(GitHub Wiki와 동일 스타일 목표), 모든 코드 블록, **Mermaid** 다이어그램 지원.

4.3 **보안/인증**

* 모든 쓰기·삭제·다운로드·업로드 API는 `X-API-Key` 단일 키로 인증.
* **경로 탈출(Path Traversal) 방지**: 문서 루트 밖 접근 불가. 심볼릭 링크는 기본 **따라가지 않음**.

4.4 **파일 작업**

* **목록 조회**, **파일 업로드**(단일 파일 및 ZIP), **파일/디렉터리 삭제(재귀)**, **디렉터리 ZIP 다운로드**, **파일 다운로드** 지원.
* 업로드·ZIP 해제는 충돌 시 **항상 덮어쓰기**.
* ZIP 업로드 해제 위치는 **요청 경로 기준의 상대 경로**.
* **대용량 스트리밍**으로 ZIP 다운로드 제공.

4.5 **국제화/인코딩**

* 파일명은 시스템 파일시스템 규칙을 따른다.
* URL 인코딩은 **항상 UTF-8**.

4.6 **운영/성능/비기능**

* 비기능 목표 **명시적 미설정(느려도 무방)**.
* **단일 인스턴스**, PM2로 구동.
* **파일 로그**를 log 디렉터리에 기록.

4.7 **동시성**

* 동일 경로에 대한 동시 업로드/삭제 충돌을 막기 위한 **경로 단위 임계영역(락)** 제공.

## 5. 제약/비범위

* 다중 루트 미지원, 복수 API 키·권한 스코프 미지원, 서버측 캐시 미사용(MVP).
* CORS 개방/Rate-Limit, 별도 모니터링 대시보드 **미구현**.

## 6. 구성/설정(요약)

* **JSON5 설정 스키마(요약)**

    * `docsRoot: string` (필수)
    * `apiKey: string` (필수)
    * `maxUploadMB: number` (기본 10)
    * `excludes: string[]` (gitignore 패턴)
    * `logDir: string` (기본 `./log`)

## 7. 핵심 성공 기준

* 트리 접힘/펼침 상태가 **브라우저 재접속 후에도 유지**.
* 업로드/삭제/다운로드가 설정과 정책(덮어쓰기/제외/경로안전)에 **일관되게** 동작.

---

# Nano-SDS — 설계 개요

## 1. 아키텍처

* **Express(EJS)**: SSR로 기본 쉘(좌측 트리 + 우측 뷰 영역) 제공, 본문은 클라이언트에서 marked로 렌더.
* **Static/FS 레이어**: Node `fs` + `path`, `archiver`(ZIP 생성), `unzipper` 또는 `adm-zip`(해제), `multer`(업로드), `encoding` 처리.
* **Auth 미들웨어**: `X-API-Key` 검사(쓰기/삭제/다운로드 경로에 적용).
* **로깅**: `winston` 또는 `pino` + 일일 롤링(파일 사이즈/일자 기반) → `${logDir}`.
* **동시성 제어**: in-process **경로 단위 Mutex 맵**(예: `async-mutex`/`async-lock`)로 업/삭/해제/압축 시 임계영역 보호.

## 2. 데이터 모델

### 2.1 설정( JSON5 )

```json5
{
  docsRoot: "/data/docs",
  apiKey: "REDACTED",
  maxUploadMB: 10,
  excludes: [
    "node_modules/",
    "**/.git/",
    "**/.DS_Store",
    "*.tmp"
  ],
  logDir: "./log"
}
```

* `excludes`는 **.gitignore 호환 패턴**(예: `ignore` 라이브러리)으로 구현.

### 2.2 브라우저 인덱스 DB(IndexedDB)

* DB: `mdviewer`, Store: `treeState`, Key: `dirPath`, Value: `{ expanded: boolean, ts: number }`.
* 추가: `lastOpenedFile`(최근 열람 파일 경로, 선택).

## 3. REST API 설계 (요약)

> 모든 요청 경로는 **문서 루트 상대 경로**를 대상으로 하며, 서버는 루트 밖 접근을 차단.

* `GET  /api/tree?path=<dir>`: 디렉터리/파일 목록.

    * 반환: `{ path, dirs:[{name}], files:[{name, ext, size}], excludesApplied:true }`
* `POST /api/upload?path=<dir>` *(Auth)*: `multipart/form-data` 업로드.

    * 파일 필드: `file` (단일), ZIP도 허용.
    * 동작: ZIP이면 상대 경로 기준 **해제 후 충돌 덮어쓰기**.
* `DELETE /api/entry?path=<fileOrDir>` *(Auth)*: 파일/디렉터리 **재귀 삭제**.
* `GET  /api/download/file?path=<file>`: 단일 파일 다운로드(스트리밍).
* `GET  /api/download/dir?path=<dir>`: 디렉터리 **ZIP 스트리밍** 다운로드, 파일명은 **디렉터리명.zip**.
* 공통 헤더: 쓰기·삭제·다운로드는 `X-API-Key: <key>` 필수.
* 오류 코드(예):

    * `400` 잘못된 파라미터/금지된 경로, `401` 인증 실패, `403` 접근 금지(제외 대상), `404` 없음, `409` 동시성 충돌, `413` 업로드 크기 초과, `500` 기타.

## 4. 서버 라우팅 & 뷰

* `GET /` → EJS `index.ejs` 렌더: 좌측 트리 패널(초기 루트 로드) + 우측 Content 영역(파일 클릭 시 fetch 후 클라 렌더).
* 정적 자원: `/static/*`(CSS/JS). Mermaid, marked, highlight.js 로딩.

## 5. 클라이언트(브라우저) 로직

* **트리 로딩**: `GET /api/tree`로 현재 디렉터리의 `dirs`/`files` 수신 → 사전식 정렬은 서버 보장, 클라는 그대로 표시.
* **상태 저장**: 트리 토글 시 IndexedDB에 `{expanded}` 저장, 초기 진입 시 복원.
* **렌더링**: `.md` 클릭 → `GET /raw?path=<file>` or `GET /api/download/file?inline=true`로 원문 수신 → `marked.parse` → Mermaid 초기화.
* **제외 규칙**: 서버에서 필터링된 목록을 사용(클라에서는 신뢰).

## 6. 보안/검증

* **경로 검증**: `path.resolve(docsRoot, requestPath)`가 `docsRoot` prefix인지 확인. 심볼릭 링크는 `lstat`로 식별 후 **무시**(또는 링크 자체만 파일로 취급, 콘텐츠 추적 금지).
* **입력 검증**: 허용 확장자 제한(서버 측 렌더는 하지 않지만, 업로드 허용 폭은 설정으로 관리).
* **업로드 제한**: `multer`의 `limits.fileSize = maxUploadMB * 1024 * 1024`.
* **XSS**: MD 렌더는 **클라이언트에서 수행**하므로 `marked`의 sanitize/DOMPurify를 적용(스크립트 삽입 차단). GitHub Wiki 유사 스타일만 허용.

## 7. 동시성/락 전략

* **경로별 Mutex**: 업로드/삭제/ZIP 해제/ZIP 생성 시 진입.

    * 키: 절대경로.
    * 크리티컬 섹션: FS 변경 작업 전후.
    * 타임아웃 시 `409 Conflict`.

## 8. 로깅/관측

* **요청 로그**: method, path, status, ms, reqId.
* **파일 작업 로그**: op(upload|delete|zip|unzip), absPath, size, result.
* **오류 로그**: stack 포함.
* log rotation: 일자/사이즈 기준, `${logDir}`에 저장.

## 9. 에러 처리(메시지 규약)

```json
{ "error": { "code": "PATH_TRAVERSAL", "message": "Outside docsRoot" } }
```

* 대표 코드: `PATH_TRAVERSAL`, `NOT_FOUND`, `EXCLUDED`, `UNAUTHORIZED`, `PAYLOAD_TOO_LARGE`, `CONFLICT`, `INTERNAL`.

## 10. 테스트(핵심 시나리오)

1. **트리 유지**: 디렉터리 3단계 펼침 → 새로고침 → 동일 상태 복원.
2. **업로드 충돌**: 동일 파일 업로드 2회 → 2회차가 덮어쓰기.
3. **ZIP 업로드**: 중첩 디렉터리 포함 ZIP 업로드 → 상대경로로 해제되고, 기존과 충돌 시 덮어쓰기.
4. **제외 규칙**: `.git/`, `.hidden` 파일들이 목록/다운로드 대상에서 제외.
5. **경로 안전**: `../` 포함 요청은 400/403.
6. **대용량 ZIP 다운로드**: 큰 디렉터리 스트리밍 다운로드 정상.
7. **동시성**: 같은 경로에 업로드와 삭제 병행 → 한쪽 대기/충돌 처리.

---

## 부록 A. 디렉터리/파일 트리 필터링 규칙

* 서버: `ignore`(gitignore 호환) 라이브러리로 `excludes` 적용 → **목록 조회/재귀 삭제/ZIP 생성 모두 동일 규칙** 재사용.

## 부록 B. 주요 라이브러리 제안

* 서버: `express`, `ejs`, `multer`, `archiver`, `unzipper`(또는 `adm-zip`), `ignore`, `winston`/`pino`, `async-lock`.
* 클라: `marked`, `mermaid`, `highlight.js`, IndexedDB 어댑터(`idb` 또는 직접 구현).

---

원하시면 다음 단계로,

1. **모듈 사양서(1-pager)**: 각 모듈(트리 인덱서, 파일오퍼레이션, 인증, 로깅, 클라 상태저장)별 인터페이스/의사코드,
2. **라우트 스펙 + 샘플 응답**, **설정 파일 JSON5 스키마 정식 정의**, **EJS 뼈대 코드**
   까지 바로 확장해드리겠습니다.
