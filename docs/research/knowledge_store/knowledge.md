---
title: DocuLightViewer HNSW SQLite Smart Search Research
name: DocuLightViewer HNSW SQLite Smart Search Research
description: DocuLightViewer의 현재 BM25 중심 검색/인덱싱 구조를 기준으로, SQLite 메타데이터 원장, HNSW 벡터 인덱스, 임베딩 백그라운드 작업, 링크 그래프, smart_search MCP 도구를 도입하기 위한 연구 보고서입니다.
docType: report
category: knowledge-store-smart-search
project: DocuLightViewer
target: 0.11.0-w1, 0.11.0-w2
audience: maintainer
status: researched
date: 2026-06-29
documentTags: hnsw, sqlite, embedding, smart-search, mcp, indexing, link-graph
sourcePath: docs/research/knowledge_store/knowledge.md
supersedes: docs/research/knowledge_store/doclight-reindexing-search-follow-up-2026-06-29.md
relatedRequirements: FR-DOC-001, FR-DOC-004, FR-DOC-009, FR-DOC-010, FR-DOC-011, FR-DOC-012, FR-DOC-013, FR-DOC-015, DR-DOC-001, DR-DOC-002, DR-DOC-003, DR-DOC-004, REL-DOC-002, IR-MCP-001, IR-MCP-002, IR-MCP-005, IR-MCP-006, CON-MCP-001, CON-MCP-002, OPS-MCP-001, FR-TREE-001, FR-TREE-002, FR-TREE-005, DR-APP-001, IR-APP-008, IR-APP-009, OPS-ARCH-001, OPS-ARCH-002, CON-ARCH-001, CON-ARCH-003, CON-ARCH-007, FR-DOC-033, DR-DOC-013, CON-DOC-007, FR-DOC-034, CON-DOC-006
visibility: internal
---

# DocuLightViewer HNSW SQLite Smart Search Research

## 결론

기존 `knowledge_store` 연구 문서는 서버형 DocLight 프로젝트를 전제로 작성되어 DocuLightViewer에 그대로 적용할 수 없다. DocuLightViewer의 실제 기준선은 Electron main process, `electron-store` 설정, MCP 6개 도구, `wink-bm25-text-search` 기반 JSON 인덱스, 런타임 Markdown 링크 파서다.

최종 목표는 다음으로 바꾼다.

1. DocuLightViewer에 HNSW를 빌트인 벡터 인덱스로 넣는다.
2. SQLite를 문서/청크/메타데이터/링크/작업 상태의 영속 원장으로 사용한다.
3. MCP가 문서를 저장하면 백그라운드에서 메타데이터 추출, 카테고리 분류, 링크 그래프 저장, 청킹, 임베딩, HNSW 갱신이 진행된다.
4. `smart_search`는 read-only MCP 검색 도구로 추가한다. `search_documents`는 기존 BM25/keyword 호환 계층으로 유지한다.
5. 전체 재인덱싱, 장기 인덱싱, 취소, 재시도, 모델 변경 재빌드는 MCP 도구로 만들지 않는다. 이 기능은 설정 다이얼로그의 Indexing 패널과 Electron IPC에서만 다룬다.

따라서 최종 목표 아키텍처는 "MCP write -> background indexing queue -> SQLite source of truth -> HNSW derived index -> hybrid smart search"다. 다만 현재 `0.10.16` SRS와 코드는 이 목표를 구현하지 않았다. 이 연구는 현재 구현 사실과 후속 SRS 후보를 분리해서 다루며, 구현은 두 개 Wave로 진행한다.

## 2-Wave 적용 방침

| Wave | 목표 | 포함 | 명시적 제외 | 진입 조건 | 종료 조건 |
|---|---|---|---|---|---|
| Wave 1: 인덱싱 기반 안정화 | 현행 BM25/JSON 검색과 MCP 저장 흐름을 믿을 수 있게 만든다. | P0: transport별 저장/dirty parity, stale bundle 정리, 검색 시점 장기 rebuild 부담 완화. P1: 최소 status/rebuild/cancel/retry UI. | SQLite 전체 schema, HNSW, embedding provider, persistent link graph, `smart_search`, MCP rebuild/cancel/retry tool | `0.10.16` as-built SRS 확인, 현재 `search_documents` 계약 보존, MCP stdio/HTTP/bundle parity 기준선 확보 | `search_documents`/`search_projects`가 기존 계약을 깨지 않고 동작하고, 저장 성공 후 인덱스 갱신 경로와 실패 진단이 일관된다. |
| Wave 2: 스마트 검색 고도화 | SQLite 원장, HNSW 파생 인덱스, embedding, document-only `save_document`, bounded local linked-Markdown import, read-only `smart_search`로 지식 저장소와 검색 품질을 고도화한다. | SQLite documents/chunks/links/jobs/import identity schema, FTS5, heading-aware chunking, embedding fingerprint, HNSW atomic swap, path redaction, degraded response, stdio/HTTP typed 8-tool `save_document` + `smart_search` parity, duplicate-safe linked local import | `search_documents` semantic 치환, 검색 호출에서 장기 인덱싱 시작, MCP indexing/import control tool, 자동 파괴적 model rebuild, 무제한 로컬 파일 크롤링 | Wave 1/Wave 1.5 완료, 후속 SRS `stable`, `IR-MCP-018`/`CON-MCP-007`의 typed 8-tool parity 확정, native packaging 전략 확정 | `save_document`는 no-viewer 저장을 제공하고, linked local import는 Settings/local import에서 bounded traversal로 동작하며, `smart_search`는 read-only로 동작하고 embedding/native/model 장애 시 keyword-only degraded 검색과 진단이 검증된다. |

Wave 1은 “스마트 검색” 구현이 아니라 현재 인덱싱 수명주기 문제를 제거하는 작업이다. Wave 2는 Wave 1의 저장/검색/상태 기반이 검증된 뒤 진행해야 한다.

## 현재 DocuLightViewer 기준선

| 영역 | 현재 구현 | 판단 |
|---|---|---|
| 검색 엔진 | `src/main/search-engine.js`의 `SearchEngine` 단일 클래스 | 문서 단위 BM25 JSON 인덱스와 simple token fallback을 사용한다. chunk, embedding, 링크 그래프, job 상태가 없다. |
| 인덱스 파일 | `mcpAutoSavePath/.doculight-search-index.json` | 저장 경로 안의 단일 JSON 파일이다. schema migration, job resume, 원자 교체가 없다. |
| 갱신 방식 | stdio/manual save 중심으로 `markDirty()`가 호출되고, 첫 검색에서 `ensureFresh()`가 전체 `rebuild()`를 실행할 수 있다. | 검색 요청이 전체 재빌드를 떠안을 수 있다. transport별 저장/dirty 부작용이 완전히 같지 않다. |
| MCP 도구 | `open_markdown`, `update_markdown`, `close_viewer`, `list_viewers`, `search_documents`, `search_projects` | stdio/HTTP 모두 6개 도구 이름 parity가 현재 `CON-MCP-002` 계약이다. 단, schema와 저장 부작용 parity는 별도 검증이 필요하다. |
| 설정 UI | MCP 포트, auto-save, 저장 경로, subdir, git metadata | 인덱싱 상태, rebuild, cancel, retry, embedding provider/model 설정이 없다. |
| frontmatter | `project`, `docName`, `description`, `docType`, git metadata 주입 | `docType` enum은 `note/plan/report/completion/issue/review/log/reference/guide/spec` 중심이다. `research`는 현재 enum에 없다. |
| 링크 처리 | `src/main/link-parser.js`가 Markdown/Wiki 링크와 sidebar tree를 런타임 계산 | 링크 edge/backlink를 DB에 저장하지 않는다. |
| 패키징 | Electron 33, electron-builder 25, production dependency는 BM25 중심 | HNSW/SQLite native addon 추가 시 rebuild와 `asarUnpack` 대응이 필요하다. |

현재 문제의 핵심은 BM25 자체가 아니라 인덱싱 수명주기다. dirty flag 후 전체 재빌드, 단일 JSON 파일, 절대 경로 중심 identity, 진행률 부재, 검색 시점 rebuild, transport별 save/dirty parity 차이, 링크/카테고리/임베딩 상태 부재가 누적되어 "현재 인덱싱도 제대로 안 되는" 상황을 만든다.

### transport별 현재 차이

| 항목 | 현재 사실 | Wave 1 보완 방향 |
|---|---|---|
| HTTP `update_markdown` | HTTP handler는 `windowManager.updateWindow()` 후 응답하며 auto-save와 `SearchEngine.markDirty()` 후처리를 수행하지 않는다. stdio update는 main IPC 경로에서 기존 `savedFilePath` 덮어쓰기 또는 신규 `saveMcpFile()` 후 `markDirty()`까지 이어진다. | stdio/HTTP/manual update가 동일한 persistence 함수와 post-save indexing enqueue를 사용하도록 통합한다. |
| HTTP `open_markdown`의 `{project}` subdir | HTTP open은 frontmatter/window metadata에는 `project`를 쓰지만 `saveMcpFile()` 호출에는 `project`를 전달하지 않는다. `mcpSaveSubDir`에 `{project}`가 있으면 `resolveSubDir()` 기본값인 `default`로 저장될 수 있다. | HTTP open도 stdio open처럼 `project`를 save path resolution에 전달한다. |
| `search_documents` fallback | MCP 설명은 BM25 검색이지만 구현은 BM25 중심 검색에 simple token fallback을 포함한다. 문서 수 3개 미만, BM25 엔진 부재, BM25 예외 시 `_fallbackSearch()`가 `docMeta`를 토큰 부분일치로 검색한다. | degraded 표현은 `BM25-only`가 아니라 `keyword-only(BM25 또는 simple token fallback)`로 통일한다. |
| `rebuild_index` | Electron main IPC action으로는 존재하지만 MCP `tools/list`에는 노출되지 않는다. | full rebuild/cancel/retry/status는 MCP tool이 아니라 Settings IPC 전용 제어면으로 유지한다. |
| stdio/HTTP/bundle parity | stdio MCP는 SDK/Zod 기반 별도 프로세스이고 HTTP MCP는 Electron main의 수동 JSON-RPC 서버다. 현재 `mcp-server.bundle.mjs`는 원본 `mcp-server.mjs`보다 stale하다. 예를 들어 원본 stdio `search_documents`는 `docType` 필터를 받지만 번들 산출물은 `query/limit/project` 중심으로 남아 packaged stdio parity 위험이 있다. | Wave 1 P0에서 `npm run bundle:mcp` 재생성과 원본/HTTP/번들 tool list, schema, 저장 부작용 parity를 회귀 검증한다. |
| append update 저장 내용 | stdio append update 저장은 append 조각과 post-update canonical content를 혼동할 수 있다. | 공통 persistence 함수는 update 이후의 canonical content를 저장 기준으로 사용한다. |

## 적용 가능한 목표 아키텍처

### 구성 요소

| 모듈 | 책임 |
|---|---|
| `IndexingService` | 저장/수정/삭제 이벤트의 단일 진입점, latest-wins queue, full rebuild job, cancel/retry 상태 관리 |
| `SearchDatabase` | SQLite 연결, schema migration, WAL/foreign key/transaction 관리 |
| `DocumentScanner` | `mcpAutoSavePath` 또는 설정된 docs root 하위 `.md` 탐색, exclude 적용, content hash 계산 |
| `MetadataExtractor` | frontmatter, H1, 파일명, 경로, git metadata, docType/category/documentTags 정규화 |
| `CategoryClassifier` | `frontmatter.category` -> `docType/path` -> H1/body hint -> filename fallback 순으로 카테고리 추론 |
| `MarkdownLinkGraphIndexer` | 기존 링크 파서 규칙을 보존하면서 raw link, normalized target, anchor, resolved/missing 상태 저장 |
| `Chunker` | heading-aware chunking, line/offset/heading path, search_text 생성 |
| `EmbeddingService` | provider/model/baseURL/dimensions/batch/retry/fingerprint 관리 |
| `VectorIndexStore` | HNSW 파일 read/write, label mapping, tombstone, capacity/compaction 관리 |
| `SmartSearchService` | FTS/BM25 후보, HNSW 후보, metadata/link/freshness boost, degraded 응답 합성 |
| Settings Indexing Panel | rebuild/cancel/retry/status/model validation/storage diagnostics 담당. MCP 도구가 아니다. |

### 목표 저장 후 이벤트 흐름

다음 흐름은 현재 구현이 아니라 Wave 2까지 도달했을 때의 목표 상태다. Wave 1에서는 이 중 저장 이벤트 통합, dirty/rebuild 분리, status 진단만 먼저 구현한다.

```text
MCP open_markdown/update_markdown 또는 renderer manual save
  -> saveMcpFile/mcpManualSave 공통 저장 성공
  -> IndexingService.enqueueDocumentSaved({ path, source, contentHash, metadata })
  -> queue debounce/latest-wins coalescing
  -> SQLite documents upsert
  -> frontmatter/docType/category/documentTags 추출
  -> Markdown/Wiki 링크 edge 저장
  -> heading-aware chunk 생성
  -> SQLite FTS content 갱신
  -> embedding enabled이면 chunk embedding batch 생성
  -> HNSW label upsert 또는 tombstone
  -> SQLite `index_jobs`와 in-memory job status 갱신
```

MCP 응답은 문서 저장 성공을 기준으로 즉시 반환한다. 임베딩과 HNSW 갱신 실패는 저장 실패가 아니며, 검색은 keyword-only degraded mode(BM25 또는 simple token fallback)로 계속 동작해야 한다.

현재 HTTP `update_markdown` 경로와 stdio IPC 경로는 저장/dirty 처리 방식이 다르므로, Wave 1 첫 단계에서 persistence 함수를 공통화해야 한다.

## SQLite 사용 방안

`better-sqlite3 + SQLite FTS5`를 기본 후보로 둔다. API가 단순하고 transaction/PRAGMA/extension loading이 명확하다. 단, Electron native addon이므로 rebuild/asar unpack/OS별 CI 확인이 필요하다. `sqlite3`는 유지보수성과 API 복잡도 측면에서 기본 후보로 두지 않는다. `sqlite-vec`는 KNN 대안으로는 볼 수 있지만 HNSW가 아니므로 이번 목표의 기본 벡터 엔진으로 채택하지 않는다.

SQLite는 벡터 검색 엔진이 아니라 source of truth다. HNSW는 파생 인덱스이며, SQLite에는 HNSW 파일, label, model fingerprint, chunk 상태를 저장한다.

권장 DB 위치:

```text
app.getPath('userData')/index/doculight.db
app.getPath('userData')/index/hnsw/<modelFingerprint>/index.bin
app.getPath('userData')/index/jobs/
```

`mcpAutoSavePath` 아래에 큰 native/vector state를 무조건 섞지 않는다. 문서 저장 루트와 앱 내부 인덱스 저장 루트를 분리해야 portable/update/권한 문제를 줄일 수 있다.

### 핵심 schema 초안

```sql
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  root_path TEXT NOT NULL,
  display_name TEXT,
  root_fingerprint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  include_globs TEXT,
  exclude_globs TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  absolute_path_internal TEXT NOT NULL,
  canonical_path_internal TEXT,
  title TEXT,
  project TEXT,
  doc_name TEXT,
  doc_type TEXT,
  category TEXT,
  description TEXT,
  document_tags_json TEXT,
  frontmatter_json TEXT,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER,
  mtime_ms INTEGER,
  path_status TEXT NOT NULL DEFAULT 'active',
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parse_error TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  indexed_at TEXT,
  index_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source_id, path_key)
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  chunk_id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  heading_path TEXT,
  heading_level INTEGER,
  start_line INTEGER,
  end_line INTEGER,
  start_offset INTEGER,
  end_offset INTEGER,
  text TEXT NOT NULL,
  search_text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  token_count INTEGER,
  metadata_json TEXT,
  UNIQUE(document_id, ordinal)
);

CREATE TABLE chunk_search_content (
  rowid INTEGER PRIMARY KEY,
  chunk_id TEXT NOT NULL UNIQUE REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  title TEXT,
  project TEXT,
  doc_type TEXT,
  category TEXT,
  document_tags TEXT,
  heading_path TEXT,
  body TEXT
);

CREATE VIRTUAL TABLE chunk_fts USING fts5(
  title, project, doc_type, category, document_tags, heading_path, body,
  content='chunk_search_content',
  content_rowid='rowid'
);

CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  edge_id TEXT NOT NULL UNIQUE,
  from_document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  from_chunk_id TEXT REFERENCES chunks(chunk_id) ON DELETE SET NULL,
  to_document_id TEXT REFERENCES documents(document_id) ON DELETE SET NULL,
  href_original TEXT NOT NULL,
  href_normalized TEXT,
  link_text TEXT,
  target_path_key TEXT,
  target_anchor TEXT,
  link_type TEXT NOT NULL,
  status TEXT NOT NULL,
  line INTEGER,
  ordinal INTEGER NOT NULL
);

CREATE TABLE local_import_identities (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  source_relative_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  canonical_path_hash TEXT,
  canonical_path_internal TEXT,
  content_hash TEXT,
  source_mtime_or_revision TEXT,
  import_state TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_import_job_id TEXT,
  UNIQUE(source_id, path_key)
);

CREATE TABLE import_job_edges (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL,
  from_document_id TEXT,
  parent_source_identity_id INTEGER,
  target_source_identity_id INTEGER,
  depth INTEGER NOT NULL,
  href_original TEXT NOT NULL,
  href_normalized TEXT,
  href_rewritten TEXT,
  target_anchor TEXT,
  edge_status TEXT NOT NULL,
  target_document_id TEXT,
  diagnostic_code TEXT
);

CREATE TABLE embedding_models (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  base_url_hash TEXT,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  distance_metric TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE chunk_embeddings (
  chunk_id TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  model_fingerprint TEXT NOT NULL REFERENCES embedding_models(fingerprint),
  vector_hash TEXT,
  vector_blob BLOB,
  state TEXT NOT NULL DEFAULT 'missing',
  error TEXT,
  embedded_at TEXT,
  PRIMARY KEY(chunk_id, model_fingerprint)
);

CREATE TABLE ann_indexes (
  id INTEGER PRIMARY KEY,
  model_fingerprint TEXT NOT NULL REFERENCES embedding_models(fingerprint),
  kind TEXT NOT NULL,
  file_path_internal TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL,
  chunk_count INTEGER DEFAULT 0,
  checksum TEXT,
  built_at TEXT
);

CREATE TABLE ann_memberships (
  ann_index_id INTEGER NOT NULL REFERENCES ann_indexes(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  label INTEGER NOT NULL,
  vector_hash TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(ann_index_id, chunk_id),
  UNIQUE(ann_index_id, label)
);

CREATE TABLE index_jobs (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  progress_current INTEGER DEFAULT 0,
  progress_total INTEGER DEFAULT 0,
  current_path TEXT,
  phase TEXT,
  error_message TEXT,
  cancel_requested INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  heartbeat_at TEXT
);
```

SQLite 기본 PRAGMA 후보:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

FTS5 `bm25()`는 낮은 값이 더 좋은 점수이므로 smart ranking에서 0..1 정규화 규칙을 별도로 둬야 한다. 한국어/혼합 텍스트는 SQLite tokenizer만 믿지 말고, 현재 JS tokenizer와 호환되는 `search_text`를 저장하는 방식을 우선 검토한다.

## HNSW와 embedding 설계

HNSW는 `hnswlib-node`를 직접 사용하는 방향이 가장 단순하다. LangChain wrapper는 의존면이 크고 native 리스크를 제거하지 못한다. HNSW native addon은 Electron main process 전용으로 두고, stdio MCP bundle에는 직접 import하지 않는다.

Embedding provider는 얇은 abstraction을 둔다.

```json
{
  "semanticSearch": {
    "enabled": false,
    "provider": "openai-compatible",
    "baseURL": "https://api.openai.com/v1",
    "apiKeyStorage": "env|encryptedStore",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "text-embedding-3-small",
    "dimensions": 1536,
    "encodingFormat": "float",
    "chunkSize": 900,
    "chunkOverlap": 120,
    "batchSize": 64,
    "maxConcurrency": 2,
    "hnsw": {
      "space": "cosine",
      "m": 16,
      "efConstruction": 200,
      "efSearch": 64
    },
    "retry": {
      "maxAttempts": 5,
      "initialDelayMs": 1000,
      "maxDelayMs": 60000,
      "jitter": true
    }
  }
}
```

`modelFingerprint`는 `provider + normalizedBaseURL + model + dimensions + encodingFormat + chunkerVersion + normalization + hnsw.space`의 hash로 만든다. API key는 fingerprint, 로그, 검색 응답에 포함하지 않는다.

모델 또는 차원 또는 chunker가 바뀌면 기존 semantic index는 `stale`로 표시한다. 사용자가 설정 다이얼로그에서 재빌드를 확인하기 전까지 자동 파괴적 재빌드를 하지 않는다. 이 동안 검색은 keyword-only degraded mode(BM25 또는 simple token fallback)로 동작한다.

HNSW 운영 정책:

| 주제 | 정책 |
|---|---|
| 추가/수정 | chunk별 label을 SQLite `ann_memberships`에 저장하고 HNSW에 upsert한다. |
| 삭제 | 즉시 물리 삭제보다 tombstone + `path_status`/`deleted_at` 필터를 기본으로 둔다. |
| compaction | tombstone 비율이 임계치를 넘으면 설정 다이얼로그에서 rebuild/compact를 실행한다. MCP 도구가 아니다. |
| 저장 | temp 파일에 빌드하고 성공 시 atomic swap한다. 실패하면 마지막 committed index 유지. |
| 로드 | 저장된 `efSearch` 등 runtime parameter를 load 후 재설정한다. |
| 패키징 | `electron-builder.yml`의 `asarUnpack`에 `**/*.node` 또는 HNSW/SQLite native module 경로를 추가한다. |

## 링크 그래프와 카테고리 분류

현재 링크 파서는 sidebar tree용 런타임 자료만 만든다. smart search에는 persistent graph가 필요하다.

링크 저장 원칙:

1. 원문 Markdown 기준으로 `[text](target.md)`, `[[target]]`, anchor link를 추출한다.
2. query/anchor를 버리지 않고 `target_anchor`와 raw href를 저장한다.
3. target 문서가 없으면 edge를 삭제하지 말고 `status = 'missing'`으로 둔다.
4. resolve candidate discovery는 `documentId`, `path_key`, `docName`, basename 후보 순으로 확장하되 1차 구현은 기존 parser 규칙과 동일하게 시작한다. 이 순서는 winner-selection 우선순위가 아니며, 복수 후보가 있으면 `ambiguous` edge로 남기고 stable identity evidence 없이 자동 선택, 병합, overwrite하지 않는다.
5. search ranking에서는 direct link, backlink, reciprocal link, same cluster를 작은 boost로만 사용한다.

### 로컬 linked Markdown import 정책

사용자가 로컬 Markdown 문서를 지식 저장소로 가져올 때 링크 대상 문서가 저장되지 않으면 `links` edge는 `missing`으로 남고 `linkedTo`/`linkedFrom` 검색과 link boost가 기대대로 동작하지 않는다. 따라서 별도 local import workflow는 root 문서뿐 아니라 연결된 local Markdown closure를 bounded traversal로 가져올 수 있어야 한다.

이 기능은 MCP `save_document`에 넣지 않는다. `save_document` v1은 content-only no-viewer 도구이며 caller source path와 destination path를 거부한다. 로컬 linked import는 Settings/import dialog 또는 source-path-backed local import action의 내부 workflow로 두고, MCP에는 `recursive`, `forceIndex`, `rebuild`, `import_local_markdown` 같은 control field/tool을 추가하지 않는다.

Traversal 정책:

1. inline Markdown links와 wikilinks를 root 문서 디렉터리 기준으로 해석한다.
2. `.md`/`.markdown` local target만 import 후보로 삼고, remote URL, protocol URL, anchor-only link, image/binary/non-Markdown target은 edge diagnostic으로만 기록한다.
3. 기본 depth는 링크의 링크까지 포함할 수 있도록 2 이상이어야 하며, max depth, max file count, max total bytes, cancellation boundary를 둔다.
4. visited set은 canonical realpath hash 또는 canonical source identity를 사용해 self-link, A->B->C->A, symlink alias loop를 차단한다.
5. missing file, excluded file, outside-root path, symlink/junction escape는 문서 row를 만들지 않고 `edge_status`와 diagnostic code로 남긴다.

중복 방지 identity:

| 목적 | 키 |
|---|---|
| 외부/public identity | stable `documentId` |
| 같은 source의 update lookup | `(source_id, path_key)` |
| 같은 run의 loop/alias 방지 | canonical realpath hash 또는 canonical source identity |
| root 이동/renamed root 판단 | `root_fingerprint` + source-relative path |
| no-op update/stale job/vector reuse | `content_hash` |

절대경로는 내부 canonicalization과 containment 판단에는 필요하지만 단독 primary identity로 쓰지 않는다. raw absolute path와 canonical path 원문은 internal-only field이며 MCP/search/log/export에는 `documentId`, source-relative path, redacted path token, status counts만 노출한다.

중복 저장 방지 보강 결정:

1. linked local import는 Settings/import dialog 또는 source-path-backed local import action에서 사용자가 명시적으로 승인한 경우에만 시작한다.
2. MCP `open_markdown`, `update_markdown`, `save_document`, `search_documents`, `search_projects`, `smart_search`는 linked import나 recursive import를 직접 또는 암묵적으로 시작하지 않는다.
3. same-run cycle/duplicate 판단은 canonical realpath hash 또는 canonical source identity를 사용하고, persistent duplicate/update lookup은 SQLite `UNIQUE(source_id, path_key)` 또는 동등한 transaction/upsert boundary를 사용한다.
4. content hash는 no-op update, stale vector reuse, move/copy 후보 판단용 보조 값이며 primary identity가 아니다.
5. destination path는 source identity 결정 이후의 derived value이며, destination collision이나 legacy file 존재만으로 identity를 병합하지 않는다.
6. encoded traversal, symlink/junction TOCTOU, concurrent duplicate import, legacy adoption ambiguity는 `CON-DOC-007` release-gating fixture에서 검증한다.

기존 knowledge-store 문서 채택 정책:

1. 사용자가 DocuLightViewer를 거치지 않고 configured knowledge-store root에 Markdown 파일을 직접 넣은 경우에도 scanner는 이를 legacy knowledge-store document로 채택해 인덱싱한다.
2. legacy adoption은 파일을 rewrite/copy/move하지 않고 `source_kind=knowledge_store`, stable `documentId`, source-relative `path_key`, content hash, freshness evidence를 SQLite 원장에 기록한다.
3. 기존 파일에 trusted DocuLight `documentId`가 있으면 uniqueness 검증 후 재사용할 수 있지만, 없거나 충돌하면 DB ledger insert에서 새 stable `documentId`를 생성하고 파일 본문은 수정하지 않는다.
4. legacy document와 local source-path import identity는 자동 병합하지 않는다. content hash, basename, title/docName만 같다는 이유로 동일 문서로 취급하지 않는다.
5. legacy document도 metadata extraction, category/documentTags classification, persistent link graph, chunking, keyword FTS, optional embedding, HNSW update lifecycle에 enqueue된다.

Broken link 정책:

1. target이 없거나 제외되거나 root 밖으로 나간 링크는 indexing 실패가 아니라 `missing`, `external`, `path_policy_violation`, `ambiguous` 같은 edge status로 남긴다.
2. broken edge는 원본 href, normalized href, target anchor, source documentId, source location, diagnostic code를 보존한다.
3. broken edge는 resolved-link ranking boost에는 넣지 않지만 Settings diagnostics와 `smart_search` diagnostics에서 canonical non-resolved status counts로 노출할 수 있다. `unresolved`는 storage/wire status나 `diagnostic_code`로 쓰지 않는다.
4. 나중에 target 문서가 저장되거나 legacy-adopt/local-import되면 다음 reconciliation에서 기존 edge를 `resolved`로 갱신한다.

Broken link 상태 머신:

| Status | 의미 | 저장/인덱싱 부작용 | 검색/랭킹 | 전이 |
|---|---|---|---|---|
| `resolved` | active target `documentId/path_key`가 유일하게 확인됨 | target documentId 연결 | link boost와 `linkedTo`/`linkedFrom` 허용 | target 삭제/제외 시 `stale` 또는 `missing` |
| `missing` | 정책 범위 안의 local Markdown target이나 active target 문서가 없음 | document row/write 생성 금지 | ranking-neutral, diagnostics only | target 추가 시 `resolved` |
| `external` | remote/protocol URL 또는 외부 문서 링크 | import/write 생성 금지 | ranking-neutral, diagnostics only | source text 변경 전까지 terminal |
| `path_policy_violation` | outside-root, traversal, encoded slash/backslash, absolute/UNC segment, symlink/junction escape | document row/write/import 생성 금지 | ranking-neutral, diagnostics only | source text 또는 policy 변경 전까지 terminal |
| `skipped` | depth/file/byte limit, excluded target, non-Markdown/image/binary, cycle 등 의도적 skip | document row/write 생성 금지 | ranking-neutral, diagnostics only | source text 또는 limits 변경 시 재평가 |
| `ambiguous` | 여러 active candidate 또는 identity evidence 부족 | 자동 merge/overwrite 금지 | ranking-neutral, diagnostics only | unique identity 확보 시 `resolved` |
| `stale` | 과거 resolved target이 삭제, 제외, tombstone, 불확실 move 상태가 됨 | source document indexing은 유지 | ranking-neutral, diagnostics only | target 복원/재채택 시 `resolved`, 증거 소멸 시 `missing` |

운영 정책:

1. Link extraction/resolution failure는 source document read/parse failure가 아닌 한 문서 indexing 실패로 승격하지 않는다.
2. `resolved` edge만 link ranking boost, reciprocal link, same-cluster scoring, `linkedTo`/`linkedFrom` filter에 사용한다.
3. `missing`, `external`, `path_policy_violation`, `skipped`, `ambiguous`, `stale`는 ranking-neutral diagnostic edge다. BM25/FTS에는 `broken`, `missing` 같은 synthetic diagnostic token을 주입하지 않는다.
4. 원문 link text/href는 문서 본문 검색으로 매칭될 수 있지만, broken-edge metadata는 link graph diagnostics 경로로만 노출한다.
5. raw href, normalized href, canonical path, source root, destination path, app data path, credential-bearing provider value는 internal-only다. MCP response, Settings diagnostics, logs, export/backup manifest에는 redacted href/path token, edge status, diagnostic code, counts만 노출한다.
6. MCP `open_markdown`, `update_markdown`, `save_document`, `search_documents`, `search_projects`, `smart_search`는 Markdown links나 MCP-supplied path field를 승인된 import root로 취급하지 않고 recursive import, bulk scan, rebuild, retry, cancel, reconciliation control을 노출하거나 동기 시작하지 않는다.
7. `save_document` 또는 viewer save가 일반 post-save indexing을 enqueue할 수는 있지만, broken-link resolution은 background indexing/link graph reconciliation phase에서 나중에 일어나며 MCP tool response는 현재 redacted diagnostics만 보여준다.

카테고리 분류 우선순위:

1. `frontmatter.category`
2. `frontmatter.docType`
3. 경로 prefix: `docs/spec`, `docs/research`, `docs/analysis`, `docs/guide`, `docs/plan`
4. H1/title/filename keyword
5. 본문 상단 metadata table
6. fallback: `general`

분류 결과는 `assigned_by`, `confidence`, `reason`을 기록한다. 자동 분류가 사용자가 명시한 frontmatter를 덮어쓰면 안 된다.

## smart_search 계약

`search_documents`를 semantic 검색으로 바꾸지 않는다. 기존 MCP 사용자와 `FR-DOC-009~013`, `CON-MCP-002`의 기대를 지키려면 별도 read-only 도구 `smart_search`를 추가하는 편이 안전하다.

중요한 계약:

- `smart_search`는 검색만 수행한다.
- `smart_search`는 전체 재인덱싱, 장기 인덱싱, 취소, 재시도, 모델 변경 빌드를 시작하지 않는다.
- stdio MCP와 HTTP MCP는 동일한 도구 목록과 schema를 가져야 한다.
- 새 도구를 추가하더라도 `CON-MCP-002`는 현재 6개 도구 baseline parity로 유지한다. 0.11.0-w2 save/search parity는 `IR-MCP-018`과 `CON-MCP-007`이 정의하는 typed 8-tool 계약으로 관리한다.

확정 v1 입력 계약:

```json
{
  "query": "string",
  "mode": "auto | hybrid | keyword",
  "limit": 20,
  "filters": {
    "project": "string",
    "docType": "note|plan|report|completion|issue|review|log|reference|guide|spec",
    "category": "string|string[]",
    "documentTags": ["string"],
    "tagMode": "any | all",
    "pathPrefix": "string",
    "linkedTo": "documentId",
    "linkedFrom": "documentId",
    "includeStale": false
  },
  "includeSnippets": true,
  "includeScores": false,
  "includeTrace": false,
  "includeDiagnostics": false,
  "allowDegraded": true
}
```

Hard filters는 ranking 전에 적용한다. 기본은 `path_status = active`, `includeStale = false`다.

권장 ranking v1:

```text
finalScore = clamp(
  0.48 * semanticNorm +
  0.32 * keywordNorm +
  0.10 * metadataScore +
  0.05 * linkScore +
  0.05 * freshnessScore -
  stalePenalty,
  0, 1
)
```

semantic이 unavailable이면 다음 fallback weight를 사용한다.

```text
finalScore = clamp(
  0.75 * keywordNorm +
  0.15 * metadataScore +
  0.05 * linkScore +
  0.05 * freshnessScore -
  stalePenalty,
  0, 1
)
```

확정 v1 응답 envelope:

```json
{
  "schemaVersion": "smart-search-v1",
  "mode": { "requested": "auto", "used": "hybrid" },
  "degraded": false,
  "degradationReasons": [],
  "indexFreshness": {
    "semantic": "ready",
    "keyword": "ready",
    "linkGraph": "ready",
    "revision": "idx_123",
    "indexedAt": "2026-06-29T00:00:00Z"
  },
  "staleFilteredCount": 0,
  "diagnostics": {
    "indexStatus": {
      "keyword": "ready",
      "semantic": "ready",
      "linkGraph": "ready",
      "schemaVersion": 1,
      "indexRevision": "idx_123",
      "indexedAt": "2026-06-29T00:00:00Z",
      "stale": false
    },
    "provider": {
      "configured": true,
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "policyHash": "sha256:..."
    },
    "policyHash": "sha256:...",
    "warnings": []
  },
  "results": [
    {
      "rank": 1,
      "documentId": "doc_...",
      "title": "Knowledge Store Research",
      "sourceRelativePath": "docs/research/knowledge_store/knowledge.md",
      "docType": "report",
      "category": "knowledge-store-smart-search",
      "documentTags": ["embedding", "search"],
      "snippet": {
        "text": "...",
        "headingPath": ["smart_search 계약", "확정 v1 응답 envelope"],
        "lineRange": { "start": 438, "end": 480 }
      },
      "scoreDetails": {
        "total": 0.872,
        "semantic": 0.91,
        "keyword": 0.72,
        "metadata": 0.60,
        "link": 0.40,
        "freshness": 0.80,
        "stalePenalty": 0
      }
    }
  ]
}
```

오류 또는 degraded 응답도 같은 envelope를 유지하고 필요하면 `error: { "code": "index_unavailable", "message": "search index unavailable", "retryable": true }`를 추가한다. `degradationReasons` enum은 `embedding_disabled`, `semantic_stale`, `native_unavailable`, `provider_unavailable`, `policy_blocked`, `index_unavailable`, `keyword_only`로 제한한다.

MCP 응답은 현재 패턴에 맞춰 canonical JSON을 `content: [{ type: "text", text: "..." }]` 안에 넣고, UI IPC는 같은 객체를 직접 반환한다. `includeTrace=false`일 때는 chunk label, edge id, normalization detail을 생략한다. canonical JSON은 conformance diff를 위해 object key를 결정적으로 정렬한다.

경로 보안:

- 기존 `search_documents`의 절대경로 응답은 호환성상 당장 깨지 않는다.
- `smart_search`는 기본적으로 절대경로를 반환하지 않는다.
- `absolute_path_internal`, `canonical_path_internal`, app data index path, API key, endpoint credential은 internal-only다.
- `gitRemote`는 기존 sanitize 정책을 유지한다.
- symlink/junction이 docs root 밖으로 나가면 기본 인덱싱 제외 또는 diagnostic 상태로만 둔다.

## 설정 다이얼로그 책임

인덱싱 제어는 MCP가 아니라 설정 다이얼로그가 담당한다.

추가할 Indexing 패널:

| 영역 | 표시/입력 |
|---|---|
| 상태 | `idle/queued/indexing/saving/failed/cancelled`, indexed count, pending count, failed count, current file, last indexed time |
| 저장소 | SQLite DB path, HNSW path, total size, index revision, schema version |
| 작업 | Build/Rebuild, Cancel, Retry failed, Compact index, Clear index, Open data directory |
| Embedding | enabled, provider, baseURL, model, dimensions, batch size, concurrency, validate button |
| Link graph | enabled, broken link count, canonical non-resolved status counts |
| Degraded 상태 | semantic unavailable, model mismatch, stale index, native module load failure |

preload/IPC 후보:

```text
getIndexingStatus
startIndexingRebuild
cancelIndexingJob
retryIndexingFailures
compactSearchIndex
clearSearchIndex
validateEmbeddingSettings
previewEmbeddingChange
saveEmbeddingSettings
onIndexingStatusChanged
openIndexDataDir
```

이 API들은 Electron IPC 전용이다. MCP `tools/list`에는 넣지 않는다.

## Wave별 구현 제안

### Wave 1: 인덱싱 기반 안정화

Baseline `0.10.16`에는 BM25 검색, MCP 저장, 링크 트리, 설정 IPC 관련 요구사항이 있고, 현재 active target `0.11.0-w1`은 후속 고도화 전에 검색/저장 흐름을 안정화하는 Wave 1 MVP다. HNSW/SQLite/smart_search/background indexing 전체는 등록된 `0.11.0-w2` Wave 2 요구사항으로 다룬다.

| 구분 | 내용 |
|---|---|
| 목표 | 현행 BM25/JSON 검색과 MCP 저장 흐름을 예측 가능하게 만든다. |
| 포함 | SRS 갱신 또는 후보화, stdio/HTTP/manual save 후처리 공통화, HTTP `update_markdown` 저장/dirty 누락 보정, HTTP `open_markdown` `{project}` subdir parity 보정, append update canonical content 저장, `SearchEngine` JSON 인덱스 안정화, simple token fallback 명시, 최소 indexing status, 설정 다이얼로그의 status/rebuild/cancel/retry |
| 제외 | SQLite 전체 원장, HNSW, embedding provider, persistent link graph, `smart_search`, MCP rebuild/cancel/retry/status/model-change 도구 |
| 선행조건 | 현재 `search_documents` 텍스트 응답 계약 유지, stdio/HTTP/bundle tool list와 schema 기준선 확보, `mcpAutoSavePath` 저장 루트 기준 확정 |
| 종료조건 | `search_documents`/`search_projects`가 기존 계약을 깨지 않고 동작하고, 저장 성공 후 인덱스 갱신 경로가 transport별로 일관되며, 검색 시점 장기 rebuild와 실패 상태를 사용자가 진단할 수 있다. |
| 관련 Requirement ID | `FR-DOC-001`, `FR-DOC-004`, `FR-DOC-009`~`FR-DOC-015`, `DR-DOC-001`~`DR-DOC-004`, `REL-DOC-002`, `IR-MCP-001`, `IR-MCP-002`, `IR-MCP-005`, `IR-MCP-006`, `CON-MCP-002`, `DR-APP-001`, `IR-APP-008`, `IR-APP-009` |

Wave 1 P0/P1 절단면:

| 단계 | 범위 | 실패해야 할 테스트/관측 | 완료 조건 | 롤백 단위 |
|---|---|---|---|---|
| P0-1 | HTTP `update_markdown` 저장/dirty parity | HTTP update 후 저장 파일과 검색 결과가 갱신되지 않는 fixture | HTTP/stdio/manual update가 동일 persistence 후처리를 타고 저장 후 dirty/enqueue가 관측된다. | HTTP update handler와 공통 persistence wrapper |
| P0-2 | HTTP `open_markdown` `{project}` subdir parity | `{project}` subdir 설정에서 HTTP 저장본이 `default` 아래 생성되는 fixture | HTTP open 저장본이 stdio open과 같은 project path에 저장된다. | HTTP open save argument 변경 |
| P0-3 | append canonical content 저장 | append update 후 저장 파일이 append 조각만 포함하는 fixture | 저장 파일이 post-update canonical content 전체를 포함한다. | update persistence content selection |
| P0-4 | stale bundle 정리 | 원본 stdio와 bundle의 `search_documents.docType` schema 차이 | `npm run bundle:mcp` 후 원본 stdio, HTTP, bundle tool schema parity가 검증된다. | generated bundle regeneration |
| P0-5 | 검색 시점 long rebuild 완화 | `ensureFresh()`가 검색 호출에서 장기 rebuild를 유발하는 fixture | 검색은 기존 계약을 유지하면서 committed keyword index 또는 명시 상태로 응답한다. | `SearchEngine` freshness policy |
| P1-1 | 최소 settings status | 인덱싱 상태/실패 파일을 사용자가 확인할 수 없는 상태 | status, rebuild, cancel, retry는 Settings IPC/UI에서만 보인다. | settings IPC/UI |

Wave 1의 핵심 작업 순서:

1. `docs/spec/`에서 indexing lifecycle, transport parity, 최소 settings status를 후속 요구사항으로 분리한다.
2. stdio MCP, HTTP MCP, `mcp-server.bundle.mjs`의 도구 이름, schema, 저장 부작용 parity를 검증한다.
3. HTTP `update_markdown`과 stdio `update_markdown`이 같은 persistence 후처리를 타도록 공통 함수를 만든다.
4. HTTP `open_markdown`이 `saveMcpFile()`에 `project`를 넘기도록 설계한다.
5. append update 저장은 append 조각이 아니라 update 이후 canonical content를 기준으로 삼는다.
6. `SearchEngine`의 BM25 + simple token fallback을 “keyword search” 계층으로 명명하고, 검색 시점 전체 rebuild 부담을 줄인다.
7. `rebuild_index`는 내부 IPC action으로 남기고, 외부 MCP tool로 승격하지 않는다.

### Wave 2: 스마트 검색 고도화

Wave 2는 Wave 1이 검증된 뒤 진행한다. 여기서부터 SQLite, HNSW, embedding, `smart_search`는 후속 SRS가 `stable`이 된 뒤 구현해야 한다.

| 구분 | 내용 |
|---|---|
| 목표 | SQLite 원장 + HNSW 파생 인덱스 + embedding 백그라운드 작업 + no-viewer `save_document` + bounded local linked-Markdown import + read-only `smart_search`로 지식 저장소와 검색 품질을 고도화한다. |
| 포함 | SQLite documents/chunks/links/jobs/import identity schema, FTS5, heading-aware chunking, embedding provider/fingerprint/stale 처리, HNSW atomic swap/tombstone/compaction, persistent link graph, `save_document`/`smart_search` MCP 도구, duplicate-safe local linked import, degraded 응답과 path redaction, native packaging 검증 |
| 제외 | `search_documents` semantic 치환, 검색 호출에서 장기 인덱싱 시작, MCP rebuild/cancel/retry/status/model-change/import 도구, 자동 파괴적 model rebuild, API key/log/absolute path 노출, 무제한 로컬 파일 크롤링 |
| 선행조건 | Wave 1/Wave 1.5 완료, `CON-MCP-002` baseline parity 유지, `IR-MCP-018`/`CON-MCP-007` typed 8-tool save/search interface and parity 확정, Wave 2 SRS `stable`, native addon packaging/CI 전략 확정 |
| 종료조건 | `search_documents`는 BM25/simple fallback 호환을 유지하고, `save_document`와 `smart_search`는 stdio/HTTP 모두 동일 schema로 노출되며, linked local import는 중복/루프 없이 graph connectivity를 보존하고, embedding disabled/native failure/model mismatch에서도 keyword-only degraded 검색이 동작한다. |
| 관련 Requirement ID | 현행 baseline 연계와 등록된 Wave 2 요구사항은 아래 목록을 기준으로 한다. |

Baseline 연계 요구사항:

- `FR-DOC-009`~`FR-DOC-015`, `DR-DOC-001`~`DR-DOC-004`, `REL-DOC-002`
- `IR-MCP-005`, `IR-MCP-006`, `CON-MCP-002`
- `FR-TREE-001`, `FR-TREE-002`, `FR-TREE-005`
- `OPS-ARCH-001`, `OPS-ARCH-002`, `CON-ARCH-001`, `CON-ARCH-003`

등록된 Wave 2 요구사항:

- `OPS-ARCH-009`, `OPS-ARCH-010`, `CON-ARCH-007`
- `DR-APP-002`, `SEC-APP-003`, `FR-APP-011`
- `FR-TREE-008`
- `IR-MCP-018`, `CON-MCP-007`
- `DR-DOC-006`, `FR-DOC-019`, `DR-DOC-007`, `FR-DOC-020`, `FR-DOC-021`, `DR-DOC-008`, `FR-DOC-022`, `DR-DOC-009`, `REL-DOC-004`, `FR-DOC-023`, `FR-DOC-024`, `FR-DOC-025`, `SEC-DOC-003`, `FR-DOC-028`, `DR-DOC-013`, `CON-DOC-006`, `FR-DOC-033`, `CON-DOC-007`, `FR-DOC-034`

Wave 2 운영 보강:

| 영역 | 필수 정책 |
|---|---|
| 원격 embedding opt-in | 기본 disabled. 사용자가 provider, endpoint, model, 전송 데이터 범위, 비용/쿼터, retention 가능성을 확인한 뒤에만 활성화한다. |
| 민감정보/본문 전송 | embedding 요청은 문서 본문/청크를 외부 provider로 보낼 수 있으므로 project별 allow/deny, offline-only 모드, proxy/corporate endpoint를 설정할 수 있어야 한다. |
| API key 저장 | `electron-store` 평문 저장 금지. Electron `safeStorage` 또는 OS credential store를 사용하고, `safeStorage.isEncryptionAvailable()` 실패 시 env var 방식으로 degrade한다. |
| rate limit/timeout | batch size, max concurrency, request timeout, retry/backoff, quota exceeded 상태를 job error와 degraded reason에 기록한다. |
| path redaction | `smart_search`뿐 아니라 diagnostics, indexing status, error message, trace, logs, SQLite export/backup에도 absolute path와 internal app data path redaction 정책을 적용한다. 기존 `search_documents` 절대경로 응답은 호환성상 별도 SRS에서 다룬다. |
| native lazy load | HNSW/SQLite native module은 main process에서 lazy import하고, load 실패 시 앱 시작을 막지 않고 keyword-only mode로 degrade한다. |
| packaged smoke test | Windows x64, macOS arm64, Linux x64는 release-gating으로 앱 시작, native `.node` load, `app.asar.unpacked` 포함 범위, stdio bundle native import 부재를 검증한다. Windows arm64, macOS x64, Linux arm64는 best-effort 또는 skipped reason artifact로 기록한다. |

Wave 2의 핵심 작업 순서:

1. SQLite를 source of truth로 도입하되, HNSW는 파생 인덱스로만 둔다.
2. `better-sqlite3`와 `hnswlib-node`는 Electron main process 전용 경계 안에서 import한다.
3. stdio MCP bundle은 native module을 직접 import하지 않는다.
4. `smart_search`는 read-only 검색 도구로 추가하고, indexing control은 Settings IPC 전용으로 유지한다.
5. embedding provider는 기본 disabled와 명시적 opt-in을 전제로 둔다.
6. model fingerprint mismatch, native load failure, endpoint 장애는 keyword-only degraded mode로 처리한다.
7. Windows x64, macOS arm64, Linux x64 packaged app에서 native `.node` load와 `app.asar.unpacked` 산출물을 release-gating으로 검증하고, Windows arm64, macOS x64, Linux arm64는 best-effort 또는 skipped reason artifact로 기록한다.

## 후속 SRS 후보

| Wave | 우선순위 | 후보 | 핵심 내용 |
|---|---|---|---|
| Wave 1 | P0 | `mcp-transport-save-parity-v1` | stdio/HTTP/manual save 후처리 parity, HTTP `update_markdown` 저장/dirty 보정, HTTP `{project}` subdir 보정, append canonical content 저장 |
| Wave 1 | P0 | `keyword-index-lifecycle-v1` | 현행 BM25 + simple token fallback을 keyword 계층으로 명명, 검색 시점 장기 rebuild 분리, committed index와 실패 진단 |
| Wave 1 | P0 | `indexing-settings-minimal-v1` | status/rebuild/cancel/retry는 Settings IPC 전용, MCP indexing control tool 금지 |
| Wave 1 | P1 | `mcp-bundle-parity-v1` | stdio 원본, HTTP MCP, `mcp-server.bundle.mjs`의 tool list/schema/save side effect 회귀 검증 |
| Wave 2 | P0 | `save-search-mcp-contract` | `save_document` no-viewer 저장 도구 + `smart_search` read-only 도구, stdio/HTTP typed 8-tool parity, indexing/import MCP control tool 금지 |
| Wave 2 | P0 | `sqlite-search-store-v1` | documents/chunks/FTS/link/jobs schema, migration, WAL, keyword fallback |
| Wave 2 | P1 | `hnsw-embedding-index-v1` | built-in HNSW, embedding provider, fingerprint, stale semantic state |
| Wave 2 | P1 | `frontmatter-category-document-tags-v1` | category/documentTags schema, docType와 MCP/window tags 역할 분리, classifier confidence |
| Wave 2 | P1 | `markdown-link-graph-v1` | persistent outgoing/backlink/broken link edge store |
| Wave 2 | P1 | `linked-local-import-v1` | Settings/local import에서 bounded Markdown link closure 저장, duplicate source identity, cycle/limit diagnostics |
| Wave 2 | P1 | `legacy-knowledge-store-adoption-v1` | 기존 knowledge-store Markdown을 rewrite 없이 stable documentId로 채택, indexing enqueue, broken/missing link reconciliation, redaction |
| Wave 2 | P1 | `hybrid-ranking-v1` | semantic/BM25/metadata/link/freshness ranking 공식과 normalization |
| Wave 2 | P2 | `document-identity-path-v1` | stable `documentId`, path history, absolute path redaction, symlink policy |
| Wave 2 | P2 | `search-degraded-observability-v1` | degraded reason, staleFilteredCount, indexFreshness, failed file diagnostics |
| Wave 2 | P2 | `native-packaging-v1` | HNSW/SQLite native rebuild, asarUnpack, Windows x64/macOS arm64/Linux x64 release-gating smoke, other OS/arch best-effort artifact |

## 리스크와 대응

| 리스크 | 영향 | 대응 |
|---|---|---|
| native addon packaging 실패 | 앱 시작 또는 검색 기능 실패 | main process 전용 import, `asarUnpack`, electron rebuild, Windows x64/macOS arm64/Linux x64 release-gating smoke와 기타 OS/arch best-effort/skipped artifact |
| main process blocking | Electron UI/MCP 응답 지연 | indexing worker thread/child process, main은 status/IPC만 담당 |
| HNSW tombstone 증가 | 검색 품질/성능 저하 | tombstone ratio 기반 compaction, 설정 다이얼로그 rebuild |
| 모델 변경 후 old vector 사용 | 잘못된 semantic 결과 | fingerprint mismatch 시 semantic stale, keyword-only fallback(BM25 또는 simple token fallback) |
| SQLite/FTS 불일치 | 검색 누락/중복 | transaction, external content trigger 또는 앱 레벨 일괄 갱신, integrity check |
| 한국어 tokenization 차이 | keyword ranking 품질 저하 | JS tokenizer 결과를 `search_text`로 저장하고 FTS query도 동일 normalize |
| 절대경로 노출 | MCP/LLM 응답에 내부 경로 유출 | `smart_search`는 relative path만 반환, internal path redaction |
| docs root 변경 | 다른 문서 집합과 index 혼동 | source/root fingerprint, index compatibility check, full rebuild 요구 |
| symlink outside root | 의도치 않은 파일 인덱싱 | lexical/canonical root 검증, 기본 제외 |
| embedding endpoint 장애 | smart search 전체 실패 | keyword-only degraded response, backoff/retry, failed files 기록 |
| 장기 인덱싱 중 앱 종료 | partial index 손상 | temp output + atomic swap + job heartbeat/resume or restart policy |

## 검증 시나리오

검증 시나리오는 `Wave`, `실행 방법`, `관측 증거`, `기대 결과`를 포함해야 한다. Wave 1은 stdio/HTTP/manual 저장 fixture와 `npm run bundle:mcp` 후 bundle schema 비교로 검증하고, Wave 2는 embedding disabled/native failure/model mismatch fixture에서 degraded response와 path redaction을 검증한다.

| Wave | 시나리오 | 실행 방법 | 관측 증거 | 기대 결과 |
|---|---|---|---|---|
| Wave 1 | HTTP `update_markdown` 저장 parity | HTTP MCP로 window 생성 후 `update_markdown` 호출, 동일 fixture를 stdio update로 반복 | 저장 파일 내용, dirty/enqueue 상태, `search_documents` 결과 | HTTP update도 stdio update처럼 저장 또는 post-save indexing enqueue까지 이어진다. |
| Wave 1 | HTTP `open_markdown` `{project}` subdir | `mcpSaveSubDir={project}` 설정 후 HTTP/stdio open에 같은 `project` 전달 | 생성된 상대 경로 | HTTP open 저장본도 `{project}` token을 `default`가 아니라 명시 project로 해석한다. |
| Wave 1 | append canonical content | 기존 문서에 append update를 호출하고 저장 파일을 다시 읽음 | 저장 파일 전체 내용과 window canonical content | 저장본은 append 조각이 아니라 post-update canonical content 전체다. |
| Wave 1 | simple token fallback | 문서 1~2개 fixture 또는 BM25 engine failure fixture로 검색 | `SearchEngine.search()` 결과, degraded/status | 문서 수 3개 미만 또는 BM25 오류 시 keyword fallback 결과와 상태가 예측 가능하다. |
| Wave 1 | 내부 `rebuild_index` 구분 | HTTP/stdio `tools/list`와 main IPC action 목록을 별도 확인 | MCP tools list, main IPC handler | `rebuild_index`는 Electron IPC action으로만 남고 MCP `tools/list`에는 노출되지 않는다. |
| Wave 1 | stdio/HTTP/bundle parity | `npm run bundle:mcp` 실행 후 원본 stdio, HTTP, bundle schema를 비교 | tool list, input schema, save side effect test 결과 | 원본 stdio, HTTP, `mcp-server.bundle.mjs`의 tool list/schema/save side effect가 일치한다. |
| Wave 1 | 최소 settings status | 인덱싱 실패 fixture와 rebuild fixture 실행 | settings UI 또는 IPC status payload | status/rebuild/cancel/retry는 Settings IPC/UI에서만 보이고 MCP tool은 추가되지 않는다. |
| Wave 2 | embedding disabled | semantic disabled 설정으로 `smart_search` 호출 | `mode.used`, `degraded`, `degradationReasons` | keyword-only degraded 검색이 동작한다. |
| Wave 2 | embedding model 변경 | model fingerprint 변경 후 rebuild 전 `smart_search` 호출 | semantic stale status, search response | semantic index는 stale로 표시되고 keyword-only로 검색된다. |
| Wave 2 | HNSW native load 실패 | packaged/dev fixture에서 native module load 실패를 주입 | 앱 시작 여부, diagnostics, search result | 앱은 시작되고 keyword search가 동작하며 diagnostics에 native failure가 표시된다. |
| Wave 2 | 문서 삭제/이동 | indexed 문서를 삭제 또는 이동 후 검색 | `path_status`, filtered count, documentId/path history | 삭제 문서는 기본 검색에서 제외되고, 이동 문서는 가능한 경우 동일 `documentId`로 승격한다. |
| Wave 2 | Markdown 링크 그래프 | 링크와 broken link fixture를 인덱싱 | `links` edge, `status=missing`, backlink query | 링크 edge와 broken link 상태가 저장되고 검색 boost/진단에 사용할 수 있다. |
| Wave 2 | Legacy knowledge-store adoption | source identity ledger row 없이 knowledge-store root에 이미 존재하는 Markdown을 scanner가 발견 | generated/trusted `documentId`, source-relative `path_key`, no rewrite evidence, indexing job, redacted diagnostics | 기존 파일은 rewrite 없이 인덱싱되고 local source-path import와 자동 병합되지 않는다. |
| Wave 2 | Legacy broken-link reconciliation | legacy 문서의 broken relative link/wikilink, excluded target, outside-root link, symlink/junction escape, target added later, target removed later fixture를 인덱싱 | `links` edge status, missing/resolved 전환, broken count, redacted diagnostics | broken link는 indexing failure가 아니라 missing/diagnostic edge로 남고 target 변화에 따라 reconciliation된다. |
| Wave 2 | `smart_search` redaction | absolute path가 있는 문서에서 `smart_search` 호출 | response JSON, trace, diagnostics, logs snapshot | 응답과 trace에 internal absolute path, app data path, API key, endpoint credential이 없다. |
| Wave 2 | packaged native smoke | Windows x64, macOS arm64, Linux x64 packaged app release-gating 실행 및 Windows arm64, macOS x64, Linux arm64 best-effort/skipped artifact 확인 | app start, `.node` 위치, `app.asar.unpacked`, stdio bundle import trace, skipped reason artifact | native `.node`는 필요한 범위만 unpack되고, stdio bundle은 native module을 직접 import하지 않는다. |

## 서브에이전트 연구 요약

### 3개 Wave 보강 연구

| 서브에이전트 | 조사 초점 | 반영 결과 |
|---|---|---|
| Wave 분리 연구 | 현재 `0.10.16` SRS와 후속 목표를 기준으로 2-Wave 경계 검토 | Wave 1은 BM25/JSON 인덱싱 안정화, Wave 2는 SQLite/HNSW/embedding/`smart_search` 고도화로 확정 |
| transport parity 연구 | HTTP/stdio update/open 저장 흐름, fallback 검색, 내부 IPC, bundle parity | HTTP `update_markdown` 저장/dirty 누락, HTTP `{project}` subdir 누락, simple token fallback, 내부 `rebuild_index` 구분을 기준선에 반영 |
| A+ 평가 기준 연구 | 현재 구현 사실과 후속 SRS 후보의 구분, MCP 도구 경계, 검증 가능성 | 현재 구현/후속 후보 분리, MCP indexing tool 금지, Wave 진입/종료 조건, 검증 시나리오 강화 |

### 5개 초기 후속 연구

| 서브에이전트 | 조사 초점 | 반영 결과 |
|---|---|---|
| 현재 구조 감사 | `SearchEngine`, MCP 6개 도구, 설정 UI, 링크 파서 | BM25 JSON/dirty rebuild 한계와 확장 접점을 기준선으로 확정 |
| HNSW/embedding/Electron | `hnswlib-node`, embedding provider, native packaging | HNSW direct 사용, main process 전용, native rebuild/asarUnpack 리스크 반영 |
| SQLite/링크 DB | DB 후보, FTS5, schema, link graph | `better-sqlite3 + FTS5` 원장, HNSW label mapping, links/headings schema 반영 |
| 백그라운드 작업/설정 UX | save event, job policy, failure/cancel/retry | MCP indexing tool 금지, settings IPC 전용 제어, latest-wins queue 반영 |
| smart_search 계약 | MCP schema, ranking, path redaction | 별도 read-only `smart_search`, hybrid ranking, canonical response 반영 |

## 근거 파일

| 영역 | 파일 |
|---|---|
| BM25 검색 | `src/main/search-engine.js` |
| MCP stdio 도구 | `src/main/mcp-server.mjs` |
| MCP HTTP 도구 | `src/main/mcp-http.mjs` |
| 저장 공통 함수 | `src/main/mcp-save.js` |
| main IPC/save/search 연결 | `src/main/index.js` |
| frontmatter/docType enum | `src/main/frontmatter.js` |
| 링크 파서/sidebar tree | `src/main/link-parser.js` |
| 설정 UI | `src/renderer/settings.html`, `src/renderer/settings.js` |
| preload IPC surface | `src/main/preload.js` |
| dependency 기준 | `package.json` |
| packaging 기준 | `electron-builder.yml` |

## 외부 기술 근거

| 기술 | 판단 |
|---|---|
| HNSW | `hnswlib-node`는 HNSW persistence, `markDelete`, capacity/efSearch 관리가 가능하지만 Electron native packaging이 필요하다. |
| SQLite FTS5 | BM25 keyword 후보, snippet/highlight, metadata filter와 transaction 원장에 적합하다. |
| better-sqlite3 | Electron native addon rebuild가 필요하지만 transaction 중심 metadata store에는 단순하고 실용적이다. |
| sqlite-vec | SQLite 안의 KNN 대안으로는 검토 가능하지만 HNSW가 아니므로 이번 목표의 기본 엔진은 아니다. |
| OpenAI-compatible embeddings | provider abstraction 뒤에 둔다. 기본 preset은 `text-embedding-3-small`, 1536 dimensions, cosine distance가 무난하다. |
