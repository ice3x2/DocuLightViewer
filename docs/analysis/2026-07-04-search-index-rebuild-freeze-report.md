---
title: Search Index Rebuild Freeze Investigation
date: 2026-07-04
target: 0.11.0-w2
requirements:
  - IR-APP-010
  - FR-DOC-019
  - DR-DOC-010
  - REL-DOC-007
  - FR-DOC-022
  - FR-DOC-023
  - FR-DOC-024
  - FR-DOC-025
status: investigation
---

# 검색 인덱스 재빌드 응답 없음 조사 보고서

## 결론

설정 창의 `검색 인덱스 다시 만들기`는 IPC 호출 자체는 빠르게 반환하도록 설계되어 있지만, 실제 재빌드 작업은 별도 worker나 child process가 아니라 Electron main process 안에서 계속 실행된다. 따라서 `better-sqlite3` 트랜잭션, FTS 삽입, tokenizer, HNSW native 작업 같은 동기 구간에 들어가면 창과 트레이 메뉴가 함께 `응답 없음`처럼 보일 수 있다.

즉, 현재 문제는 단순히 SQLite를 사용해서 생긴 문제가 아니라 SQLite, garu-ko, HNSW, source ledger를 main process에서 동기 실행하는 구조가 핵심이다. `async` 함수와 Promise가 있어도 CPU/native 동기 작업이 main process에서 실행되면 Electron UI와 tray event loop는 막힌다.

## 해결책 기록 상태

이 문서에는 `권장 아키텍처`, `해결 방법 상세안`, `안전한 벤치마크 계획`, `우선순위`로 해결 방향이 이미 기록되어 있다. 2026-07-05 기준으로 이 해결 방향은 `REL-DOC-007` 요구사항으로 SRS에 정식 연결되었다.

`REL-DOC-007`에서 특히 구현 기준으로 고정된 내용은 다음이다.

- 검색 인덱스 재빌드, SQLite FTS write, tokenizer enrichment, VACUUM/compact, embedding, HNSW build/compact를 Electron main process 밖의 worker 또는 동등한 실행 경계에서 수행한다.
- Settings status/cancel IPC, tray event, window focus/close, MCP read/search 요청은 인덱싱 작업 중에도 정량 latency 기준을 만족해야 한다.
- SQLite rebuild는 worker-owned write connection과 generation/revision staging swap 또는 동등한 committed-index 보호를 사용한다.
- tokenizer는 bounded analysis, chunk/segment boundary, content-hash cache, tokenizerVersion metadata로 대형 파일 비용을 제한한다.
- smart_search는 검색 요청 중 HNSW를 즉석 build하지 않고 committed artifact, SQLite vector fallback, keyword-only degraded 순서로 처리한다.
- clear/compact/rebuild는 WAL/SHM을 고려한 안전한 backup/checkpoint 안내 또는 명시적 backup-skip 기록을 전제로 한다.
- packaged Electron 환경에서 worker 내부 native module load 또는 degraded state를 검증한다.

## 조사 방식

10개 서브에이전트를 다음 영역으로 나누어 read-only 조사했다.

| # | Agent | 조사 영역 | 핵심 결론 |
|---:|---|---|---|
| 1 | Russell | Settings UI rebuild 버튼 | renderer 자체 동기 freeze는 아니지만 중복 클릭과 status IPC 누적 가능 |
| 2 | Franklin | main IPC handler | IPC는 빠르게 반환하지만 rebuild는 main process에서 계속 실행 |
| 3 | Arendt | SearchEngine rebuild | `background`가 thread 분리가 아니라 main-process Promise임 |
| 4 | Sagan | SQLite keyword cache | `better-sqlite3` rebuild/VACUUM 모두 동기 main-thread 작업 |
| 5 | Schrodinger | garu-ko/tokenizer | garu는 동기이며, basic tokenizer는 전체 본문을 훑음 |
| 6 | Averroes | semantic/HNSW/ledger | HNSW와 ledger도 main process 동기 native/SQLite 작업을 포함 |
| 7 | Nietzsche | SRS/tests gap | SRS의 non-blocking 요구가 실제 이벤트 루프 검증으로 닫혀 있지 않음 |
| 8 | Helmholtz | Electron/native/Windows | ABI mismatch와 freeze는 별도 문제지만 hidden instance가 증상을 혼란스럽게 함 |
| 9 | Turing | large corpus evidence | `work-report` 근거가 stale이며 205 MiB/대형 단일 파일 리스크 미측정 |
| 10 | Boyle | architecture remediation | `worker_threads` 기반 indexing worker + SQLite job queue가 최선 |

## 실제 호출 경로

설정 버튼 클릭 경로:

1. `src/renderer/settings.js`의 rebuild button handler가 `window.doclight.startIndexingRebuild()`를 호출한다.
2. `src/main/preload.js`가 `ipcRenderer.invoke('indexing:start-rebuild')`로 연결한다.
3. `src/main/index.js`의 `indexing:start-rebuild` handler가 `searchEngine.startRebuild()`를 호출한다.
4. `src/main/search-engine.js`의 `startRebuild()`는 `this.rebuild().catch(...)`를 호출하고 즉시 status를 반환한다.
5. 이후 `SearchEngine._performRebuild()`가 같은 Electron main process에서 계속 실행된다.
6. SQLite backend에서는 `_saveIndex()`가 `sqliteIndex.rebuild(searchDocuments)`를 동기 호출한다.
7. `src/main/search-sqlite-store.js`의 `SQLiteKeywordIndex.rebuild()`는 하나의 동기 transaction 안에서 전체 삭제, 전체 문서 loop, tokenizer, FTS insert를 수행한다.

핵심은 4번이다. IPC handler는 `await rebuild()`를 하지 않으므로 겉으로는 background처럼 보이지만, 작업 실행 위치는 여전히 Electron main process다.

## 동기 병목

### P0. SQLite keyword rebuild

`SQLiteKeywordIndex.rebuild()`는 `better-sqlite3` 기반 동기 API다. 다음 작업이 한 transaction에서 실행된다.

- `keyword_fts`, `keyword_segments`, `keyword_documents` 전체 삭제
- 모든 문서에 대해 `keyword_documents` insert
- 모든 문서에 대해 `buildSearchText()` 실행
- 모든 문서에 대해 segment insert
- 모든 문서에 대해 FTS insert
- metadata upsert

WAL, `busy_timeout`, `synchronous=NORMAL`은 DB 잠금과 durability 특성을 조정할 뿐, JavaScript event loop를 양보하지 않는다. SQLite가 lock을 기다리거나 FTS insert를 수행하는 동안 Electron main process는 멈춘다.

### P0. Tokenizer cost

garu-ko 자체는 문서당 분석 입력이 제한되어 있지만 동기 호출이다. 더 큰 문제는 basic tokenizer가 full body를 대상으로 동작한다는 점이다.

- `KeywordTokenizer.tokenize()`는 `basicTokenize(text)`를 먼저 실행한다.
- `buildSearchText()`는 metadata와 full body를 합친 raw text를 tokenizer에 넘긴다.
- `tokenizer.js`는 단어 token과 bigram을 전체 텍스트에서 생성한다.

따라서 garu 입력 cap이 있어도 200 MiB corpus 또는 160 MiB 단일 Markdown 파일은 basic tokenization과 큰 `search_text` 생성만으로도 main process를 오래 점유할 수 있다.

### P0. Full rebuild pipeline이 main process에 있음

파일 read는 `fs.promises.readFile`로 일부 비동기지만, 각 batch의 index loop는 동기 작업이다. SQLite save 단계는 더 큰 동기 구간이다. `setImmediate`나 Promise는 시작 시점만 미룰 뿐, 실행 중인 native/CPU 작업을 worker로 보내지 않는다.

### P1. Cancel/status가 막힌 main process를 공유

Settings status polling, cancel IPC, tray menu event가 모두 Electron main process를 거친다. rebuild가 동기 SQLite/tokenizer 구간에 들어가면 다음 문제가 생긴다.

- status polling이 지연된다.
- cancel 버튼이 눌려도 IPC handler가 실행되지 못한다.
- `_cancelRequested`는 transaction 내부나 tokenizer 내부에서 검사되지 않는다.
- tray 우클릭 이벤트도 처리되지 않는다.

### P1. Compact/VACUUM도 같은 문제

`compact()`는 한 번 `setImmediate`로 예약되지만, 예약된 task 안에서 `VACUUM`을 동기 실행한다. 사용자가 버튼을 누른 직후는 빠르게 반환될 수 있지만, 실제 VACUUM 시점에는 main process가 막힌다.

### P1. Semantic/HNSW도 독립적으로 위험

설정의 keyword rebuild는 semantic indexing을 직접 시작하지 않는다. 그러나 embedding 등록이나 smart_search 경로에는 별도 main-process blocking 위험이 있다.

- `queueSemanticReindexForActiveDocuments()`는 등록 handler 안에서 corpus를 동기 순회/queue할 수 있다.
- `IndexingService.buildAndCommitAnnIndex()`는 일부 `addPoint`에서 yield하지만 native write, checksum, membership commit은 동기다.
- `smart_search`에서 persisted HNSW checksum/read/search 또는 fallback HNSW build가 요청 경로에서 동기 실행될 수 있다.

## ABI 문제와 freeze 문제의 분리

`better-sqlite3` ABI mismatch는 load error를 만들고, rebuild freeze와는 다른 문제다. 다만 개발 환경에서는 `predev`가 Electron ABI로 native module을 rebuild하므로 일반 `node` 기반 벤치/테스트에서 다음과 같은 오류가 날 수 있다.

```text
was compiled against a different Node.js version using NODE_MODULE_VERSION 130.
This version of Node.js requires NODE_MODULE_VERSION 137.
```

이는 측정/테스트 환경을 혼란스럽게 만든다. Electron 실행용 ABI와 Node 벤치용 ABI를 분리하거나, 벤치를 Electron runtime 또는 별도 child process 정책으로 명시해야 한다.

## 대형 코퍼스 현황

현재 로컬 metadata 확인 결과:

- Root: `C:\Work\0.관리\work-report`
- Markdown files: 3,326
- Total size: 205.48 MiB
- 단일 대형 Markdown 파일 약 164 MiB 존재

기존 연구 문서의 수치와 다르며, 현재 SRS의 manual corpus evidence에는 command, artifact, wall time, peak memory, DB size, event-loop latency가 없다. 따라서 “SQLite 전환으로 대형 corpus가 안전하다”고 볼 수 없다.

## SRS와 테스트 격차

`FR-DOC-019 AC-6`은 long indexing, embedding batch, HNSW build, compaction이 UI/MCP request handling을 장시간 block하지 않아야 한다고 되어 있다. 그러나 현재 테스트는 주로 다음을 확인한다.

- Settings IPC surface가 존재한다.
- search/startup 경로가 더 이상 자동 rebuild를 시작하지 않는다.
- compact가 호출자에게 scheduled로 빠르게 반환된다.
- HNSW addPoint loop 일부가 yield hook을 호출한다.

빠져 있는 검증:

- rebuild 중 main process event loop lag
- rebuild 중 `getIndexingStatus` latency
- rebuild 중 cancel IPC latency
- SQLite transaction/VACUUM 중 status polling 가능 여부
- 200 MiB corpus와 160 MiB single-file stress
- packaged Electron runtime에서 native/worker 동작

## 권장 아키텍처

### 1. Indexing worker 도입

가장 현실적인 구조는 단일 long-lived `worker_threads` indexing worker다.

main process 역할:

- Settings/MCP/UI coordinator
- status polling endpoint
- job enqueue/cancel request
- last committed search index read
- renderer/tray responsiveness 유지

worker 역할:

- full keyword rebuild
- source scan/read/index
- SQLite keyword write connection
- semantic reindex
- HNSW build/compact
- SQLite VACUUM/backup

chunked async만으로는 충분하지 않다. `better-sqlite3`와 HNSW native work는 결국 동기이므로 main process 밖에서 실행되어야 한다.

### 2. Source ledger를 durable job queue로 사용

현재 source ledger에는 이미 job status, phase, progress, current path, heartbeat, cancel_requested가 있다. in-memory `_smartIndexQueue`와 `_cancelRequested` 중심 구조를 장기적으로 ledger-backed queue로 통합해야 한다.

권장 job type:

- `keyword_rebuild`
- `semantic_reindex`
- `hnsw_rebuild`
- `hnsw_compact`
- `sqlite_vacuum`
- `linked_import`

### 3. Keyword index rebuild 방식 개선

현재 방식은 전체 삭제 후 전체 insert다. worker 내부에서는 가능하지만, 안정성을 위해 다음을 권장한다.

- worker 전용 SQLite write connection
- WAL reader/writer 분리
- generation/revision 기반 rebuild
- commit 전까지 기존 committed index 유지
- 실패 시 이전 index 유지
- DB file replace 대신 transaction/generation swap 우선
- Windows에서는 열린 handle이 있을 수 있으므로 file-level SQLite 교체를 피함

### 4. Tokenizer 비용 제어

대형 corpus에서 tokenizer를 반드시 제한해야 한다.

- garu 결과를 content hash 기준 cache
- Hangul이 없는 문서는 garu 생략
- basic bigram enrichment를 full body 전체가 아니라 bounded metadata/prefix/chunk로 제한
- 160 MiB 단일 파일은 chunk/segment 단위로 분리
- tokenizer metadata에 `maxAnalysisChars`, tokenizer implementation version/hash를 포함

### 5. Cancel/progress를 worker-safe하게 구현

worker는 다음 지점마다 cancel flag를 확인해야 한다.

- scan batch
- read batch
- document parse/index
- SQLite insert batch
- embedding batch
- HNSW addPoint yield
- HNSW write 전
- commit 전

main process는 status read만 수행하고, worker가 heartbeat/progress를 ledger에 기록해야 한다.

### 6. Settings UI 보호책

근본 해결은 worker 분리지만, UX도 보완해야 한다.

- action in-flight guard
- rebuild 버튼 즉시 disabled
- status polling 중복 방지
- `rebuilding`, `indexing`, `queued`, `compacting` 상태에서 destructive action 제한
- 대형 corpus 감지 시 예상 비용/백업 안내
- cancel이 즉시 반영되지 않을 수 있는 단계 표시

### 7. MCP non-exposure 유지

인덱싱 제어는 계속 Settings 전용이어야 한다. MCP에는 rebuild/cancel/compact/clear 같은 제어 도구를 추가하지 않는다. 다만 MCP response의 diagnostics에는 read-only status만 노출할 수 있다.

## 해결 방법 상세안

앞의 권장 아키텍처를 실제 구현 단위로 바꾸면 다음 순서가 가장 안전하다.

### Phase A. 즉시 보호 패치

worker 전환 전에 먼저 사용자가 같은 freeze를 반복해서 만들지 않도록 Settings 쪽에 얇은 보호막을 둔다.

- rebuild/compact/clear 버튼은 클릭 즉시 in-flight 상태로 잠그고, status 응답으로 완료/실패/취소가 확인될 때만 다시 연다.
- status polling은 이전 요청이 끝나기 전에는 새 요청을 보내지 않는다.
- 대형 corpus 또는 큰 단일 파일이 감지되면 예상 시간이 길 수 있다는 안내와 백업 안내를 먼저 표시한다.
- 이 단계는 UX 완화일 뿐이며, main process freeze의 근본 해결로 간주하지 않는다.

### Phase B. Indexing worker controller 추가

main process에는 `IndexingWorkerController`만 남기고 heavy work는 `worker_threads` worker로 이동한다.

- main process는 job enqueue, status read, cancel flag 기록, renderer/tray 응답성 유지에만 집중한다.
- worker는 source scan/read, keyword rebuild, semantic reindex, HNSW build/compact, VACUUM/backup을 담당한다.
- worker message protocol은 `start`, `cancel`, `progress`, `completed`, `failed` 정도의 작은 명령 집합으로 제한한다.
- worker가 죽으면 main process는 ledger heartbeat를 보고 실행 중 job을 failed/retryable 또는 cancelled로 정리한다.
- MCP에는 worker 제어 API를 노출하지 않는다. MCP 검색 응답에는 read-only degraded/status diagnostics만 허용한다.

### Phase C. SQLite keyword rebuild 재작성

현재 `SQLiteKeywordIndex.rebuild()`의 전체 삭제 후 전체 insert 방식은 worker 안으로 옮기더라도 실패 복구와 사용자 신뢰 측면에서 취약하다. 다음 구조로 바꾼다.

- worker 전용 write connection을 열고, main process는 동시에 write connection을 잡지 않는다.
- WAL mode를 유지하고 reader는 마지막 committed generation만 읽는다.
- rebuild는 새 generation에 쓰고, commit 직전에 generation pointer를 swap한다.
- 실패, cancel, worker crash 시 기존 committed generation은 유지한다.
- batch 단위 transaction을 사용하되, commit pointer swap은 마지막에 한 번만 수행한다.
- Windows handle 충돌을 피하기 위해 DB 파일 교체보다 테이블/generation swap을 우선한다.

### Phase D. Tokenizer와 대형 파일 비용 제한

한국어 BM25 품질을 위해 garu-ko를 유지하되, 대형 문서 전체를 매번 형태소 분석하는 구조는 피한다.

- content hash 기반 tokenizer cache를 둔다.
- Hangul이 없는 문서는 garu-ko 호출을 생략한다.
- `maxAnalysisChars`와 chunk/segment 크기를 tokenizer metadata에 기록하고, 변경 시에만 keyword cache를 재생성한다.
- 큰 단일 Markdown은 문서 하나로 읽더라도 indexing 입력은 segment 단위로 흘려 보낸다.
- FTS search_text에는 제목, frontmatter, heading, bounded body excerpt, chunk tokens를 우선 넣고 무제한 full-body enrichment를 금지한다.

### Phase E. Cancel, progress, backup을 durable state로 통합

사용자가 Settings에서 보는 상태는 memory flag가 아니라 SQLite ledger를 기준으로 해야 한다.

- job row에 `phase`, `progress`, `currentPath`, `heartbeatAt`, `cancelRequested`, `lastError`를 기록한다.
- worker는 scan/read/tokenize/insert/embedding/HNSW/commit 전 지점마다 cancel flag를 확인한다.
- cancel은 즉시 kill이 아니라 다음 safe checkpoint에서 중단하는 정책으로 표시한다.
- clear/compact/rebuild 같은 파괴적 또는 재작성 작업은 SQLite backup API 또는 checkpoint 포함 파일 백업 안내를 선행한다.
- raw DB main 파일만 복사하는 백업은 WAL/SHM 누락 위험이 있으므로 금지한다.

### Phase F. Semantic/HNSW blocking 구간 분리

Wave 2 smart_search 안정성을 위해 HNSW도 같은 원칙을 적용한다.

- HNSW add/build/save는 request path나 renderer-triggered IPC path에서 직접 실행하지 않는다.
- embedding 등록 또는 모델 변경은 semantic job을 enqueue하고, worker가 chunk embedding과 HNSW artifact commit을 처리한다.
- smart_search는 이미 committed된 HNSW artifact만 사용한다.
- HNSW artifact가 없거나 stale이면 SQLite vector fallback 또는 keyword-only degraded로 내려가며, 검색 중 HNSW를 즉석 rebuild하지 않는다.

### Phase G. 검증 게이트

해결 완료 판단은 단순히 freeze가 덜 보이는지로 하면 안 된다. 최소 검증 기준은 다음이다.

- rebuild 중 Settings status IPC p95/p99 latency가 측정된다.
- rebuild 중 tray menu와 창 focus/close가 응답한다.
- cancel 요청이 worker safe checkpoint에서 반영된다.
- 200 MiB급 corpus benchmark가 실제 userData가 아닌 temp index에서 동작한다.
- Node ABI와 Electron ABI native rebuild 경로가 분리되어 문서화된다.
- packaged Electron smoke에서 better-sqlite3와 optional HNSW native load/degraded 경로가 확인된다.

## 안전한 벤치마크 계획

대형 corpus 검증은 userData나 실제 index를 사용하지 말아야 한다.

1. opt-in benchmark script를 별도 추가한다.
2. source corpus는 read-only로 접근한다.
3. `%TEMP%\doculight-large-bench-*` 아래에 `indexDataDir`와 artifacts를 만든다.
4. child process 또는 worker에서 실행하고 parent가 timeout/RSS ceiling을 감시한다.
5. 측정 항목:
   - file count
   - total bytes
   - max file size
   - phase별 wall time
   - peak RSS/heap/external
   - DB/WAL/SHM size
   - FTS row count
   - event-loop p95/p99/max lag
   - status/cancel IPC latency
   - source root 아래 `.doculight-search-index.json` 미생성 여부
6. packaged app variant는 별도 opt-in smoke로만 실행한다.

## 즉시 판단

현재 `검색 인덱스 다시 만들기`를 205 MiB `work-report`에 실행하면 응답 없음이 발생하는 것은 타당한 증상이다. 코드상 명시 rebuild가 Electron main process에서 동기 CPU/native/SQLite 작업을 수행하기 때문이다.

현재 구조에서 “설정창에서만 실행하니까 괜찮다”는 판단은 틀렸다. 설정창에서 실행하더라도 Electron main process가 막히면 창, 트레이, MCP HTTP, status polling, cancel 처리가 모두 같이 막힌다.

## 우선순위

| Priority | 작업 | 목적 |
|---|---|---|
| P0 | full keyword rebuild를 worker thread로 이동 | Settings rebuild freeze 제거 |
| P0 | SQLite keyword rebuild를 worker-owned connection에서 수행 | better-sqlite3 동기 작업 격리 |
| P0 | large corpus benchmark 추가 | 200 MiB/대형 단일 파일 근거 확보 |
| P1 | tokenizer full-body enrichment 제한/chunk화 | CPU와 DB size 제어 |
| P1 | cancel/progress를 source ledger 기반 durable state로 전환 | 멈춘 듯한 UX 제거 |
| P1 | compact/VACUUM을 worker로 이동 | 예약 후 freeze 제거 |
| P1 | semantic/HNSW build/search blocking 구간 정리 | Wave 2 smart_search 안정화 |
| P2 | Settings UI in-flight guard와 polling guard | 중복 IPC/혼란 감소 |
| P2 | ABI별 benchmark/runtime 정책 문서화 | Node/Electron native 혼선 감소 |

## 최종 판정

질문에 대한 직접 답은 다음과 같다.

> 네. 현재 설정에서 시작하는 검색 인덱스 재빌드는 사용자 눈에는 background처럼 보이지만, 실제 heavy work는 Electron main process에서 동기적으로 실행된다. SQLite 연동, tokenizer, HNSW, ledger까지 main process에 붙어 있어 대형 corpus에서 응답 없음이 재현될 수밖에 없는 구조다.

다음 구현은 작은 패치가 아니라 indexing 실행 모델을 worker 기반으로 재설계하는 작업으로 잡아야 한다.
