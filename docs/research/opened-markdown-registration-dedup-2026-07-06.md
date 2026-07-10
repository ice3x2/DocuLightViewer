---
title: DocuLightViewer Opened Markdown Registration and Deduplication Research
name: DocuLightViewer Opened Markdown Registration and Deduplication Research
description: 사용자가 뷰어로 연 로컬 Markdown을 선택적으로 지식 저장소에 등록하고 중복 저장 없이 백그라운드 인덱싱하는 구현 방향 연구입니다.
docType: report
category: knowledge-store-deduplication-research
project: DocuLightViewer
target: 0.11.0-w2
audience: maintainer
status: researched
date: 2026-07-06
documentTags: opened-markdown, knowledge-store, deduplication, sqlite, source-ledger, background-indexing, settings
relatedRequirements: DR-DOC-013, FR-DOC-033, CON-DOC-007, FR-DOC-034, FR-DOC-019
visibility: internal
---

# Opened Markdown Registration and Deduplication Research

## 결론

사용자가 DocuLightViewer로 연 로컬 Markdown을 지식 저장소에 등록해 인덱싱하는 기능은 타당하다. 다만 기본 동작으로 켜면 사생활 침해와 예기치 않은 파일 복사 문제가 크므로, **설정창에서 사용자가 명시적으로 켜는 기본 off 기능**으로 구현해야 한다.

핵심 설계는 다음이다.

1. 뷰어 열기는 즉시 수행하고, 등록/복사/해시/인덱싱은 백그라운드에서 실행한다.
2. 지식 저장소 안에 이미 있는 파일은 복사하지 않고 `FR-DOC-034`의 legacy adoption 방식으로 원장에 채택한다.
3. 지식 저장소 밖의 파일은 원본 경로를 직접 인덱싱하지 않는다. 저장소 안의 결정적 목적지로 복사 또는 등록한 뒤, 그 저장소 내부 경로만 인덱싱 큐에 넣는다.
4. 중복 판정은 `canonical_path_hash`와 `source_id + path_key`를 우선하고, `content_hash + content_byte_length + content_text_length`는 중복 후보 검색용 인덱스로만 사용한다.
5. `content_hash`는 절대 primary identity나 `UNIQUE` 키가 아니다. 같은 내용의 템플릿, 복사본, 배포본은 서로 다른 문서일 수 있다.
6. 일반 열기에서 링크된 Markdown까지 재귀 등록하지 않는다. 링크 재귀 가져오기는 기존 `FR-DOC-033`의 사용자가 명시적으로 시작하는 Settings/import workflow로 유지한다.
7. MCP 도구나 MCP schema는 바꾸지 않는다. 이 기능은 Settings/local viewer workflow다.

따라서 사용자가 제안한 "해싱된 값을 DB에 저장하고 인덱스를 걸어 중복 여부를 검사"하는 방향은 맞다. 단, 해시를 유일 식별자로 쓰는 것이 아니라 **중복 후보를 빠르게 찾는 보조 인덱스**로 써야 기존 SRS와 데이터 모델에 맞다.

## 5개 서브에이전트 상호검증

이번 연구는 4개 독립 관점 분석 뒤 5번째 검증 에이전트가 상호검증하는 방식으로 진행했다.

| Agent | Role | 주요 결론 |
|---|---|---|
| Agent 1 | 요구사항/트리아지 | 대상 진입점은 OS/argv open, recent reopen, drag/drop, tab open, read-file-for-tab, navigateTo까지 포함해야 한다. |
| Agent 2 | 코드 구조 분석 | 현재 원장은 `source_id + path_key`, `canonical_path_hash`, `content_hash`를 이미 갖고 있지만 길이 기반 fingerprint 컬럼과 content fingerprint index가 없다. |
| Agent 3 | 외부 근거 조사 | Node `crypto`, Node `fs.realpath`, SQLite unique/partial index, UPSERT, transaction으로 제안 설계를 구현할 수 있다. |
| Agent 4 | 위험 분석 | 기본 off, MCP-inert, raw path redaction, 원자적 복사, SQLite transaction, content_hash 비고유 정책이 필요하다. |
| Agent 5 | 상호검증 | 현재 SRS는 linked import와 legacy adoption은 충분히 다루지만, 일반 viewer-open flow에 반응하는 새 옵션은 별도 SRS 요구사항이 필요하다. |

## 현재 SRS 적합성

관련 요구사항은 모두 `0.11.0-w2`의 verified/stable 요구사항이다.

| Requirement | 적용 판단 |
|---|---|
| `DR-DOC-013` | source identity ledger의 기준이다. `documentId`가 primary identity이고, `source_id + path_key`와 `canonical_path_hash`가 중복/업데이트 lookup 기준이다. |
| `CON-DOC-007` | 중복 안전성과 MCP-inert 경계의 기준이다. `content_hash` 단독 병합을 금지하고, active previous path는 copy/duplicate candidate로 취급한다. |
| `FR-DOC-034` | 이미 지식 저장소 안에 있는 Markdown은 rewrite 없이 채택하는 근거다. |
| `FR-DOC-019` | 등록 이후 인덱싱은 저장/열기 응답을 막지 않는 background job이어야 한다는 근거다. |
| `FR-DOC-033` | 링크된 Markdown 재귀 가져오기 정책이다. 일반 문서 열기 자동 등록은 이 요구사항과 분리해야 한다. |

현재 SRS는 이 기능의 하위 정책 대부분을 제공하지만, "사용자가 뷰어로 연 문서를 자동/선택적으로 지식 저장소에 등록"하는 제품 요구 자체는 명시하지 않는다. 구현 전에는 새 `FR-DOC-*` 또는 `FR-APP-*` 요구사항을 추가하거나 기존 요구사항을 확장해야 한다.

## 코드 구조 관찰

현재 구현은 이 기능을 붙일 기반이 있다.

| 파일 | 관찰 |
|---|---|
| `src/main/source-ledger-store.js` | `documents` 테이블에 `document_id`, `source_id`, `path_key`, `canonical_path_hash`, `content_hash`가 있고 `UNIQUE(source_id, path_key)` 및 partial unique `canonical_path_hash` 인덱스가 있다. |
| `src/main/linked-import.js` | linked import가 SHA-256 content hash를 계산하고, source path와 canonical path 중복을 먼저 확인한 뒤, 변경된 문서만 index job으로 보낸다. |
| `src/main/legacy-adoption.js` | 지식 저장소 안의 기존 Markdown을 rewrite 없이 채택하고, 변경 여부에 따라 인덱싱을 큐잉한다. |
| `src/main/search-engine.js` | `queueDocumentIndex`는 configured source root 밖의 경로를 거부한다. 외부 원본 파일을 직접 인덱싱하면 안 된다. |
| `src/main/index.js` / `src/main/window-manager.js` | 일반 열기 진입점이 여러 갈래다. 단일 registrar service를 두고 각 진입점에서 중복 호출을 수렴시켜야 한다. |

중요한 코드상 제약은 `queueDocumentIndex`가 지식 저장소 밖 경로를 받아들이지 않는다는 점이다. 따라서 외부에서 열린 파일은 반드시 저장소 내부 목적지로 복사/등록한 뒤 그 목적지 경로를 인덱싱해야 한다.

## 권장 아키텍처

```text
User opens Markdown
  -> viewer opens immediately
  -> OpenedMarkdownRegistrar receives path event
  -> setting enabled? document store configured?
  -> canonicalize source path and compute fingerprint
  -> duplicate/source ledger lookup in SQLite transaction
  -> inside store: adopt without rewrite
  -> outside store: copy/register into deterministic store path
  -> enqueue background indexing for store-contained path
  -> status/diagnostics shown in Settings only
```

### 새 서비스

`OpenedMarkdownRegistrar` 같은 main-process service를 둔다.

책임:

- 설정값 확인: 기능 on/off, 지식 저장소 경로 존재 여부.
- open event dedupe: 같은 파일이 tab/open/read-file 경로에서 중복 신호를 내도 하나의 등록 작업으로 수렴.
- canonical path와 fingerprint 계산.
- source ledger 조회/업서트.
- 외부 파일 복사 목적지 결정.
- `queueDocumentIndex`에는 항상 지식 저장소 내부 경로만 전달.
- raw absolute path를 사용자/MCP/log 진단에 노출하지 않도록 redaction 적용.

### 진입점

최소한 다음 흐름을 검토해야 한다.

| 진입점 | 처리 |
|---|---|
| OS file association / argv open | `openFileFromPath` 뒤 registrar 호출 |
| recent file reopen | 직접 `createWindow`로 갈 수 있으므로 별도 hook 필요 |
| drag/drop | 파일 읽기와 viewer 표시 후 registrar 호출 |
| tab open/read-file-for-tab | `read-file-for-tab`과 `file-opened-in-tab` 중복 신호 수렴 필요 |
| open dialog flow | renderer가 실제 읽기/open을 수행하는 지점과 맞춰 hook 필요 |
| Markdown link navigation | `navigateTo`는 viewer 내부 탐색이지만 사용자가 실제로 연 로컬 문서이므로 정책 대상인지 SRS에서 명확히 해야 한다. 추천은 대상 포함, 단 single-file only다. |

## 중복 판정 정책

중복 판정은 다음 순서로 수행한다.

| 순서 | 기준 | 결과 |
|---:|---|---|
| 1 | canonical realpath 기반 `canonical_path_hash` | 같은 물리 파일 또는 path alias면 기존 `documentId`를 재사용한다. 두 번째 active row를 만들지 않는다. |
| 2 | `source_id + path_key` | 같은 source 상대 경로면 기존 `documentId`를 재사용한다. |
| 3 | 같은 canonical/source identity + 같은 content hash | no-op. 파일 복사, DB row, index job 모두 중복 생성하지 않는다. |
| 4 | 같은 canonical/source identity + 변경된 content hash | 같은 `documentId`의 revision/update로 보고 background reindex를 큐잉한다. |
| 5 | 다른 active path + 같은 content fingerprint | duplicate/copy candidate다. 기본은 skip/report 또는 사용자 확인이며, 자동 merge는 금지한다. |
| 6 | 이전 path가 inactive/missing/deleted + 같은 content fingerprint | file-id/inode 등 플랫폼 증거 또는 사용자 승인이 있을 때만 documentId 보존 후보가 된다. |
| 7 | 기존 destination 파일은 있으나 source identity 없음 | `FR-DOC-034`의 legacy adoption 증거가 충분하지 않으면 ambiguous로 처리하고 overwrite하지 않는다. |

`MD5 + 텍스트 길이` 대신 `SHA-256 + byte length + decoded text length`를 권장한다. MD5도 중복 후보 탐색용으로는 쓸 수 있지만, 새 원장에는 이미 SHA-256 계열이 사용되고 충돌 저항성과 일관성이 더 낫다.

## DB 및 인덱스 제안

기존 unique identity는 유지한다.

```sql
-- existing policy: keep
UNIQUE(source_id, path_key)

-- existing policy: keep partial unique canonical alias
CREATE UNIQUE INDEX ... ON documents(canonical_path_hash)
WHERE canonical_path_hash IS NOT NULL;
```

추가 후보:

```sql
ALTER TABLE documents ADD COLUMN content_byte_length INTEGER;
ALTER TABLE documents ADD COLUMN content_text_length INTEGER;
ALTER TABLE documents ADD COLUMN normalized_text_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_content_fingerprint
ON documents(content_hash, content_byte_length, content_text_length)
WHERE content_hash IS NOT NULL;
```

외부 원본과 저장소 내부 사본의 관계가 필요하면 alias 테이블을 추가한다.

```sql
CREATE TABLE document_source_aliases (
  alias_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  canonical_path_hash TEXT NOT NULL,
  content_hash TEXT,
  content_byte_length INTEGER,
  content_text_length INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(canonical_path_hash),
  FOREIGN KEY(document_id) REFERENCES documents(document_id)
);
```

이 테이블은 raw absolute path를 외부로 내보내기 위한 것이 아니다. 내부 canonical alias와 지식 저장소 문서의 연결을 유지하기 위한 것이다.

## 외부 파일 복사 정책

지식 저장소 밖의 파일을 등록할 때는 원본 경로를 직접 검색 인덱스에 넣지 않는다.

권장 정책:

1. 기능은 기본 off.
2. 처음 외부 경로 등록 시 사용자에게 "열어본 로컬 Markdown을 지식 저장소에 복사하고 인덱싱"한다는 의미를 명확히 보여준다.
3. 목적지는 source root fingerprint 또는 canonical source hash prefix를 포함한 deterministic namespace로 만든다.
4. basename 충돌은 overwrite하지 않고 `destination_collision` 또는 `duplicate_candidate`로 진단한다.
5. 복사는 atomic temp write + rename 또는 exclusive create 방식으로 처리한다.
6. 복사 성공 후에만 저장소 내부 목적지 경로로 `queueDocumentIndex`를 호출한다.

예시 목적지 정책:

```text
<knowledge-store>/.opened/<source-root-hash>/<source-relative-path>
```

이 경로는 연구 제안일 뿐이며, 실제 구현 전 SRS에서 사용자에게 보이는 위치인지 숨김 관리 영역인지 결정해야 한다.

## UX 정책

설정창의 검색 인덱스 관리 영역에 다음 옵션을 추가하는 방향이 적합하다.

| UI 요소 | 권장 동작 |
|---|---|
| "열어본 로컬 Markdown을 지식 저장소에 등록" 체크박스 | 기본 off. 지식 저장소 경로가 없으면 disabled. |
| 설명 문구 | "켜면 DocuLightViewer에서 연 로컬 Markdown을 지식 저장소에 복사/등록하고 백그라운드로 검색 인덱싱합니다." |
| 중복 후보 상태 | 같은 내용의 다른 active path는 자동 병합하지 않고 skipped/duplicate candidate로 표시한다. |
| 링크된 Markdown | 일반 열기 자동 등록에서는 따라가지 않는다. 링크 재귀 가져오기는 별도 버튼/대화상자에서만 수행한다. |
| 진행 상태 | 기존 indexing status에 `opened_document_registration` requested_by 또는 유사 phase를 표시한다. |

## 과한 범위와 제외 사항

이번 기능에 넣지 말아야 할 것:

- MCP `save_document`나 `smart_search` schema 확장.
- MCP indexing/import control tool 추가.
- 일반 문서 열기에서 링크 재귀 import 자동 실행.
- `content_hash`를 unique key로 강제.
- 외부 원본 경로를 직접 HNSW/keyword index source root로 취급.
- 검색 요청 시 누락 문서를 발견했다는 이유로 장기 등록/재빌드 시작.
- raw absolute path, canonical path, destination path를 MCP 응답이나 user-facing 로그에 노출.

추가하면 좋은 것:

- duplicate candidate를 Settings에서 나중에 해소하는 작은 진단 리스트.
- source-root별 "항상 등록/항상 무시" 선택.
- 동일 fingerprint가 여러 active path에 있을 때 별도 문서로 가져오기 승인 UI.

## 테스트 계획

TDD 기준으로 구현 전 실패 테스트를 추가해야 한다.

| 영역 | 테스트 |
|---|---|
| Settings | 옵션 default off, 저장/로드, 지식 저장소 미설정 시 disabled, i18n label |
| MCP boundary | MCP tool list/schema에 import/index/opened-registration control이 생기지 않음 |
| Open entrypoints | argv/openFileFromPath, recent reopen, drag/drop, tab open, navigateTo가 각각 최대 1회 등록 |
| Inside store | 저장소 내부 Markdown은 rewrite/copy 없이 adoption되고 index job 1개 이하 |
| Outside store | 외부 Markdown은 저장소 내부 목적지로 복사 후 그 목적지만 indexing queue에 들어감 |
| Same path unchanged | row/copy/job 중복 없음 |
| Same path changed | 같은 `documentId`로 update/reindex |
| Path alias | symlink/junction, case, Unicode normalization alias가 canonical path로 수렴 |
| Same content different path | duplicate candidate 또는 skipped로 남고 자동 merge 없음 |
| Destination collision | overwrite 없음, ambiguous/collision diagnostic |
| Background behavior | 큰 파일 해시/복사/인덱싱이 UI와 MCP request handling을 block하지 않음 |
| Redaction | diagnostics/log/status에 raw absolute path가 노출되지 않음 |

## 구현 순서

1. 새 SRS 요구사항을 추가하거나 기존 SRS를 확장한다. 권장 제목은 "Opened local Markdown registration is opt-in, duplicate-safe, and MCP-inert"다.
2. source ledger schema migration에 fingerprint length 컬럼과 non-unique candidate index를 추가한다.
3. 필요하면 `document_source_aliases` 같은 alias 테이블을 추가한다.
4. `OpenedMarkdownRegistrar` main-process service를 작성한다.
5. 설정값과 Settings UI/i18n을 추가한다.
6. open entrypoint hook을 연결하되, registrar 내부에서 debounce/dedupe를 보장한다.
7. 외부 파일 목적지 mapping과 atomic copy를 구현한다.
8. 기존 `queueDocumentIndex`에는 저장소 내부 경로만 넘긴다.
9. 테스트와 package smoke 범위를 갱신한다.

## 외부 근거

- Node.js `crypto.createHash('sha256')`: content fingerprint 계산에 적합하다. <https://nodejs.org/api/crypto.html>
- Node.js `fs.realpath`: path alias와 symlink/junction canonicalization의 기반이다. <https://nodejs.org/api/fs.html>
- SQLite `CREATE INDEX`와 partial index: content fingerprint 후보 검색 인덱스에 적합하다. <https://www.sqlite.org/lang_createindex.html>, <https://sqlite.org/partialindex.html>
- SQLite UPSERT와 transaction: 동시 open/register를 하나의 source identity로 수렴시키는 데 필요하다. <https://sqlite.org/lang_upsert.html>, <https://sqlite.org/lang_transaction.html>

## 최종 판단

이 기능은 현재 목표인 Wave 2 knowledge-store lifecycle과 잘 맞는다. 단, 기존 linked import와 legacy adoption 요구사항을 재사용하되 그대로 끼워 넣으면 안 된다. 일반 viewer-open flow는 별도 사용자 기대와 개인정보 리스크가 있으므로, 구현 전에 SRS에서 다음을 명확히 해야 한다.

- 기본 off 설정.
- 단일 파일 등록인지 링크 재귀 등록인지.
- 외부 파일 복사 승인 모델.
- source-root 및 destination mapping.
- 같은 content fingerprint를 가진 active 다른 path의 처리.
- raw path redaction.
- MCP 도구 비확장.

가장 안전한 구현 방향은 **기본 off 설정 + single-file opened Markdown registrar + source identity 우선 중복 판정 + SHA-256/length 기반 후보 인덱스 + 저장소 내부 경로만 indexing queue**다.
