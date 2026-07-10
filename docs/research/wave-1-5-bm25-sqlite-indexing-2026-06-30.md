---
title: DocuLightViewer Wave 1.5 BM25 SQLite Keyword Index Research
name: DocuLightViewer Wave 1.5 BM25 SQLite Keyword Index Research
description: Wave 2 embedding/HNSW 전에 현재 wink-bm25 단일 JSON 인덱스 한계를 줄이기 위한 SQLite FTS5 기반 keyword/BM25 derived cache 연구입니다.
docType: report
category: keyword-indexing-research
project: DocuLightViewer
target: 0.11.0-w1.5
audience: maintainer
status: researched
date: 2026-06-30
documentTags: bm25, sqlite, fts5, wave-1-5, keyword-search, electron-builder, native-packaging
relatedRequirements: FR-DOC-018, IR-APP-010, DR-DOC-006, OPS-ARCH-005, OPS-ARCH-006
visibility: internal
---

# DocuLightViewer Wave 1.5 BM25 SQLite Keyword Index Research

## Executive Decision

Wave 1.5의 채택안은 **`better-sqlite3 + SQLite FTS5 external-content + 기존 tokenizer 선처리 + Electron main process lazy load`** 다.

SQLite는 Wave 1.5에서 **source of truth가 아니다**. Markdown 원본에서 언제든 재생성 가능한 **keyword/BM25 derived cache**로만 사용한다. `search_documents`와 `search_projects`의 기존 keyword 계약은 유지하고, embedding, HNSW, persistent link graph, `smart_search`는 Wave 2로 남긴다.

`0.11.0-w1.5`는 이 문서의 연구 라벨이다. 현재 SRS target map에는 아직 별도 Wave 1.5 target이 없으므로, 구현 전에 SpecKiwi 요구사항과 target map을 별도로 갱신해야 한다.

이 결론은 실제 대용량 데이터셋 `C:\Work\0.관리\work-report` 테스트 결과에 근거한다.

| Metric | Observed |
|---|---:|
| Markdown files | 3,223 |
| Markdown body total | about 40 MB |
| Existing JSON index | 164.2 MB |
| Existing indexed documents | 1,438 / 3,223 |
| Missing documents from existing index | 1,785 |
| wink `exportJSON()` size after full rebuild | about 525.6 MB |
| Full rebuild save result | `RangeError: Invalid string length` |
| Rebuild peak memory | about RSS 1.87 GB / heap 1.52 GB |

The failure is not BM25 as a ranking idea. The direct failure is the current persistence shape: `SearchEngine._saveIndex()` calls `engine.exportJSON()`, stringifies metadata, then wraps both into one huge JSON string.

Code evidence:

- [src/main/search-engine.js](/C:/Work/git/_Snoworca/DocuLightViewer/src/main/search-engine.js:442): `engine.exportJSON()`
- [src/main/search-engine.js](/C:/Work/git/_Snoworca/DocuLightViewer/src/main/search-engine.js:445): combined `JSON.stringify({ index, meta })`
- [src/main/tokenizer.js](/C:/Work/git/_Snoworca/DocuLightViewer/src/main/tokenizer.js:18): current Korean/English tokenizer compatibility reference
- [electron-builder.yml](/C:/Work/git/_Snoworca/DocuLightViewer/electron-builder.yml:18): current `asarUnpack` only includes the MCP bundle

## Adopted Architecture

Wave 1.5 should keep the current public search API and replace only the internal keyword persistence backend.

```text
MCP/renderer save
  -> existing save path writes Markdown
  -> markDirty / enqueue compatibility point
  -> main-process SQLite keyword index service
  -> better-sqlite3 lazy load
  -> documents / keyword_segments / FTS5 external-content update
  -> SearchEngine.search() returns existing search_documents shape
```

### Components

| Component | Role |
|---|---|
| `SearchEngine` facade | Preserve `search`, `searchProjects`, `getStatus`, rebuild/cancel/retry/compact/clear API. |
| SQLite keyword index service | Own the derived keyword cache in app `userData`, not under `mcpAutoSavePath`. |
| Native dependency loader | Lazy-load `better-sqlite3` only in Electron main process. |
| Tokenizer adapter | Use the current JS tokenizer before writing/searching FTS content. |
| FTS5 external-content cache | Store searchable rows without a giant JS export string. |
| Settings IPC/UI | Continue to own rebuild, cancel, retry, compact, clear, and open data dir. |

### Boundary Rules

- Do not expose indexing controls as MCP tools.
- Do not import native SQLite from renderer, preload, stdio MCP server, or bundled MCP server.
- Do not change `search_documents` into semantic/hybrid search.
- Do not migrate the legacy `.doculight-search-index.json` as a required path. Rebuild the SQLite cache from Markdown source.
- Do not implement Wave 2 tables for embeddings, HNSW memberships, link graph, or `smart_search` in Wave 1.5.

## Requirement Boundary Map

| Requirement | Wave 1.5 relation | Boundary |
|---|---|---|
| `FR-DOC-018` | Covered | Preserve keyword search contract, project/docType filters, stale/degraded diagnostics, and no search-time long rebuild. |
| `IR-APP-010` | Covered | Keep rebuild, cancel, retry, compact, clear, and open data dir in Settings IPC/UI only. |
| `DR-DOC-006` | Explicitly deferred/downscoped | Do not implement the Wave 2 SQLite source-of-truth ledger. Wave 1.5 uses a derived keyword cache only. |
| `OPS-ARCH-005` | Gate | Native SQLite must be lazy-loaded in main process and must not be imported by renderer or stdio MCP bundle. |
| `OPS-ARCH-006` | Gate | Package smoke must prove native load, FTS5 availability, unpacked native file scope, fallback behavior, and bundle non-import. |

## SQLite FTS Design

The minimum Wave 1.5 database should be intentionally smaller than `DR-DOC-006`.

Recommended minimum:

```sql
CREATE TABLE keyword_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE keyword_documents (
  id INTEGER PRIMARY KEY,
  file_path_internal TEXT NOT NULL UNIQUE,
  source_relative_path TEXT,
  title TEXT,
  project TEXT,
  doc_name TEXT,
  doc_type TEXT,
  description TEXT,
  date TEXT,
  content_hash TEXT NOT NULL,
  mtime_ms INTEGER,
  size_bytes INTEGER,
  path_status TEXT NOT NULL DEFAULT 'active',
  indexed_at TEXT
);

CREATE TABLE keyword_segments (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES keyword_documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  heading TEXT,
  snippet TEXT,
  search_title TEXT,
  search_project TEXT,
  search_doc_name TEXT,
  search_doc_type TEXT,
  search_description TEXT,
  search_body TEXT NOT NULL,
  UNIQUE(document_id, ordinal)
);

CREATE VIRTUAL TABLE keyword_fts USING fts5(
  search_title,
  search_project,
  search_doc_name,
  search_doc_type,
  search_description,
  search_body,
  content='keyword_segments',
  content_rowid='id'
);
```

This is a cache schema, not the final smart-search source-of-truth schema. Wave 2 may migrate or replace it with the richer `sources/documents/chunks/links/embedding_models/chunk_embeddings/ann_indexes/index_jobs` design.

### Tokenizer Strategy

Do not rely on SQLite `unicode61` alone for DocuLightViewer search quality. The current tokenizer:

- lowercases and normalizes mixed English/Korean/CJK text,
- strips common Korean suffixes,
- adds character bigrams across whitespace.

Wave 1.5 should store tokenizer-produced canonical strings in FTS columns and apply the same tokenizer to queries before generating `MATCH` expressions. SQLite `unicode61` remains useful as the FTS tokenizer over those canonical token strings, but it should not replace the existing tokenizer without golden-query evidence.

### Segment Strategy

A single 40 MB Markdown file should not become one FTS row. Wave 1.5 may introduce **keyword segments** as internal cache rows. These are not Wave 2 semantic chunks.

Recommended first rule:

- split by heading when available,
- cap segment body text by size/token threshold,
- keep document-level metadata on every segment row,
- store snippet source separately enough to return the existing `snippet` field.

The exact threshold remains an implementation decision and must be benchmarked against the `work-report` corpus.

### Score Strategy

SQLite FTS5 `bm25()` returns lower values for better matches and supports per-column weights. Existing DocuLight search returns higher scores as better scores. Wave 1.5 must normalize or map score direction at the adapter boundary.

Column-weight intent should mirror the current wink configuration:

| Existing field | Current weight intent | FTS5 note |
|---|---:|---|
| title | 5 | highest text field weight |
| project | 4 | metadata filter and boost |
| docName | 3 | metadata/title-like signal |
| docType | 3 | mostly filter/metadata signal |
| description | 2 | summary signal |
| body | 1 | base content signal |

The exact score formula should be fixed by golden-query tests, not by intuition.

### MATCH Query Safety

The query adapter must not pass raw user text directly into `MATCH`. It should:

- run the existing JS tokenizer over the query,
- escape or quote FTS5 special syntax,
- handle `"`, `-`, `*`, parentheses, path separators, and punctuation deterministically,
- avoid accidental interpretation of user text as `AND`, `OR`, `NOT`, or `NEAR`,
- include Korean/CJK fixtures where token spacing differs from source text.

This is part of search quality, not only security. A malformed `MATCH` expression must degrade to safe keyword fallback or return a controlled empty result, not break MCP search responses.

### External-Content Consistency

FTS5 external-content tables require the content table and FTS index to stay consistent. Wave 1.5 must choose one of these patterns before implementation:

- application-managed dual write in one SQLite transaction, or
- SQLite triggers plus deterministic initial rebuild.

Required verification:

- simulate transaction failure after content write but before FTS update,
- simulate FTS update failure after content mutation,
- compare `keyword_segments` row count against `keyword_fts` row count,
- support deterministic `rebuild keyword_fts` from content rows,
- quarantine or rebuild cache on detected drift.

## Packaging Plan

SQLite must ship with the installable app packages and macOS app package.

Primary dependency candidate:

- `better-sqlite3` latest observed: `12.11.1`
- engines: Node `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`
- dependency profile: native addon with `bindings` and `prebuild-install`

Packaging requirements:

1. Add the dependency only after package smoke is specified.
2. Lazy-load it in main process service code.
3. Keep it external to `mcp-server.bundle.mjs`.
4. Extend `electron-builder.yml` `asarUnpack` for native files:

```yaml
asarUnpack:
  - "src/main/mcp-server.bundle.mjs"
  - "node_modules/better-sqlite3/**"
```

Use `**/*.node` only as a diagnostic fallback while investigating packaging. The release configuration should prefer an allowlist such as `node_modules/better-sqlite3/**` and verify that only expected native files are unpacked.

5. Verify packaged artifacts contain `better_sqlite3.node` under `app.asar.unpacked`; on macOS, verify the `.app/Contents/Resources/app.asar.unpacked` path explicitly.
6. Verify packaged app can open `:memory:`, create an FTS5 virtual table, and execute a simple query.

Open build decision:

- `@electron/rebuild` latest observed `4.0.6` requires build-host Node `>=22.12.0`.
- If CI/dev remains on Node 20, either pin `@electron/rebuild` 3.x or use electron-builder's native rebuild flow.
- Electron 33.4.0 runtime is Node 20.18.1 with Node module ABI 130, so rebuild must target Electron, not system Node.

Because `better-sqlite3` is synchronous, lazy load alone is not enough. The implementation plan must define:

- maximum batch size before yielding back to the event loop,
- maximum acceptable Settings UI/MCP latency during rebuild,
- cancellation check interval,
- worker thread or child process promotion threshold if the `work-report` corpus exceeds the latency budget.

## Rejected Options

| Option | Decision | Reason |
|---|---|---|
| Keep wink and optimize JSON | Reject as Wave 1.5 primary | It keeps the large `exportJSON()` and giant string problem. |
| Store wink export in SQLite BLOB/chunks | Reject | It moves the persistence container but keeps the large export/import memory cost. |
| Required migration from legacy JSON index | Reject | The observed legacy index is stale; Markdown source rebuild is simpler and safer. |
| `node:sqlite` | Reject for Electron 33 | `node:sqlite` starts in Node v22.5.0; Electron 33.4.0 uses Node 20.18.1. |
| WASM SQLite / sql.js | Reject as primary | It avoids native packaging but reintroduces large export/persistence and WASM heap concerns. |
| Direct postings/BM25 tables | Defer | Too much search-engine work for Wave 1.5 unless FTS5 quality fails. |
| Wave 2 direct implementation | Defer | Too broad: embedding, HNSW, link graph, smart_search, redaction, and governance would arrive together. |

## Validation Plan

Wave 1.5 should not be considered implementable until these gates are explicit.

### Corpus Gate

Run against the actual `work-report` corpus or a synthetic equivalent:

- at least 3,223 Markdown files,
- total body size around or above 40 MB,
- at least one large Markdown file near 1 MB or above,
- include files created after the existing stale index date.

Required evidence:

- no `Invalid string length`,
- no wink `exportJSON()` path during SQLite rebuild,
- peak RSS meaningfully below the observed 1.87 GB baseline,
- search calls do not start long rebuilds,
- stale diagnostics are explicit.

### Search Quality Gate

Build a golden-query suite from observed examples:

- `TypeCaster`
- `FormFileExplorerLayout`
- `SRS`
- `배포`
- `OnRootHook`
- `인덱싱`
- `getOutputStream`
- `builtin-node-options`
- `trial-license`
- `서브에이전트`

Compare:

- top-k overlap with current wink search where the current index is complete,
- Korean suffix/bigram behavior,
- safe FTS5 `MATCH` escaping for quotes, hyphens, operators, parentheses, CJK, and punctuation,
- metadata filter correctness for `project` and `docType`,
- title/file-name handling when H1/frontmatter exists or does not exist.

### Lifecycle Gate

Extend current Wave 1 tests to cover SQLite behavior:

- fallback when SQLite native load fails,
- corrupt DB quarantine and rebuild,
- transaction rollback on partial read/index failure,
- external-content FTS/content drift detection and deterministic rebuild,
- committed index preserved on failed rebuild,
- stale search uses last committed cache,
- Settings-only rebuild/cancel/retry/compact/clear remains true,
- MCP tool lists remain unchanged.

### Package Smoke Gate

Release-gating targets:

- Windows x64
- macOS arm64
- Linux x64

Smoke assertions:

- packaged app starts,
- `better-sqlite3` lazy load succeeds,
- FTS5 table creation succeeds,
- native load failure injection produces keyword degraded diagnostics instead of app startup failure,
- `app.asar.unpacked` contains only expected native files,
- `mcp-server.bundle.mjs` does not include direct native SQLite imports.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Wave 1.5 becomes Wave 2 | Critical | Keep SQLite as derived keyword cache only. |
| Native module package failure | High | Package smoke before implementation acceptance. |
| Main process blocking | High | Batch work and yield/cancel; consider worker only if benchmarks require it. |
| Search quality regression | High | Golden-query suite and current tokenizer preprocessing. |
| FTS/content table drift | High | Single transaction update path or deterministic rebuild. |
| Score direction bug | Medium | Tests for lower-is-better `bm25()` mapping. |
| Stale cache hidden as ready | High | File count/hash/mtime freshness diagnostics. |

## Open Questions

1. What exact keyword segment size should be used for large Markdown files?
2. Should FTS updates use application-managed dual writes or SQLite triggers?
3. What score normalization formula best preserves current `score` expectations?
4. What golden-query top-k threshold is acceptable?
5. Should WAL `synchronous` be `NORMAL` for speed or `FULL` for stronger durability?
6. Should CI move to Node 22 for `@electron/rebuild` 4.x, pin rebuild 3.x, or rely on electron-builder install-app-deps?
7. Should `search_projects` use FTS or stay metadata-only over `keyword_documents`?

## Source Notes

- SQLite FTS5 official documentation: https://www.sqlite.org/fts5.html
- SQLite WAL documentation: https://www.sqlite.org/wal.html
- SQLite synchronous PRAGMA: https://www.sqlite.org/pragma.html#pragma_synchronous
- better-sqlite3 API and performance documentation: https://github.com/WiseLibs/better-sqlite3/tree/master/docs
- Electron Builder ASAR/unpack documentation: https://www.electron.build/contents
- Electron native modules documentation: https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- Node SQLite documentation: https://nodejs.org/api/sqlite.html

## Sub-Agent Research Summary

Five-agent topology was used:

1. Triage: scoped Wave 1.5 boundaries and decision axes.
2. Code archaeology: mapped current SearchEngine, tokenizer, MCP, Settings, and packaging surfaces.
3. External knowledge: checked SQLite FTS5, better-sqlite3, electron-builder, Electron native module, Node sqlite, and rebuild constraints.
4. Risk and alternatives: compared wink JSON, wink SQLite BLOB, SQLite FTS5, custom postings, WASM SQLite, and Wave 2 direct path.
5. Synthesis: adopted SQLite FTS5 derived keyword cache and rejected over-broad options.

The consensus recommendation is to proceed with Wave 1.5 only after a package smoke spike proves native SQLite can ship safely with DocuLightViewer packages.
