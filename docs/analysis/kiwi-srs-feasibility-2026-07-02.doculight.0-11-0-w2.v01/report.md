---
title: DocuLight Wave 2 feasibility report
docType: report
category: knowledge-store-smart-search
project: DocuLightViewer
target: 0.11.0-w2
status: feasible
date: 2026-07-02
relatedRequirements: OPS-ARCH-009, OPS-ARCH-010, CON-ARCH-007, DR-APP-002, SEC-APP-003, FR-APP-012, FR-TREE-009, IR-MCP-018, CON-MCP-007, CON-MCP-010, DR-DOC-006, FR-DOC-019, DR-DOC-007, FR-DOC-020, FR-DOC-021, DR-DOC-008, FR-DOC-022, DR-DOC-009, FR-DOC-024, FR-DOC-025, SEC-DOC-003, FR-DOC-028, REL-DOC-004, DR-DOC-013, CON-DOC-006, FR-DOC-033, CON-DOC-007, FR-DOC-034
---

# DocuLight Wave 2 feasibility report

## 판정

0.11.0-w2는 구현 가능하다. 단, 단일 기능이 아니라 persistence, background jobs, embedding provider, native HNSW, MCP contract, settings UI, link graph, redaction, package smoke가 엮인 high-risk sequence다. 바로 PM으로 투입하지 않고 planner로 phase/task 순서를 고정해야 한다.

현재 active target은 SRS strict validation 0 errors / 0 warnings이고, active planned work는 28건이다. 모든 requirement stability는 stable이다. 따라서 SRS 안정성 때문에 막히지는 않는다.

## 구현 순서 제안

1. Shared redaction utility와 fixture를 먼저 만든다.
2. SQLite Wave 2 ledger와 recovery/migration boundary를 만든다.
3. Settings embedding model registration, safe storage, connection test, `900/120` chunk defaults를 만든다.
4. HNSW native dependency packaging과 degraded smoke를 만든다.
5. Background indexing, chunking, category classification, persistent link graph를 만든다.
6. `save_document` MCP 도구를 no-viewer/content-only 저장으로 추가한다.
7. Embedding/HNSW lifecycle과 model-change purge를 연결한다.
8. `smart_search` hybrid ranker와 diagnostics를 추가한다.
9. Settings/local import 쪽 bounded linked Markdown import와 legacy adoption을 추가한다.
10. Eight-tool client profile, package smoke, Korean/mixed-language retrieval fixtures로 release gate를 닫는다.

## 깨진 링크 정책

깨진 링크 정책은 충분히 연구되어 있고 SRS도 active requirement로 정리되어 있다. 구현 계획에서는 이를 다음 불변식으로 다뤄야 한다.

- 깨진 링크는 인덱싱 실패가 아니다.
- 깨진 링크는 자동 저장 또는 recursive import 신호가 아니다.
- `resolved` edge만 link ranking과 `linkedTo`/`linkedFrom` filter에 참여한다.
- Non-resolved edge는 redacted diagnostics로만 노출한다.
- BM25/FTS에는 diagnostic synthetic token을 넣지 않는다.
- 링크 재해결은 background reconciliation에서만 일어난다.
- MCP는 import/rebuild/retry/cancel/reconciliation control을 추가하지 않는다.

이 정책은 `FR-TREE-009`, `DR-DOC-013`, `CON-DOC-006`, `SEC-DOC-003`, `FR-DOC-025`가 함께 만족해야 한다.

## 과한 요구사항 여부

요구사항 자체는 과하지 않다. DocuLightViewer가 문서 저장소와 smart search를 내장하려면 SQLite 원장, embedding fingerprint, HNSW derived index, background jobs, link diagnostics, redaction은 서로 분리할 수 없다.

다만 실행 단위는 과하게 크다. PM은 한 번에 전체를 고치려 하지 말고 red/green TDD task로 쪼개야 한다. 특히 `save_document`와 `smart_search`를 먼저 붙이고 나중에 ledger/redaction을 끼워 넣는 순서는 재작업 가능성이 높다.

## 현재 코드 대비 gap

- 현재 MCP 도구는 stdio/HTTP 모두 6개이며 Wave 2의 8-tool contract가 없다.
- 현재 SQLite store는 Wave 1.5 keyword derived cache이고 Wave 2 source-of-truth ledger가 없다.
- 현재 settings UI에는 embedding model registration 상태/등록 modal이 없다.
- 현재 코드에는 HNSW dependency와 package smoke가 없다.
- 현재 link parser는 sidebar runtime tree용이며 persistent graph/reconciliation 저장소가 없다.
- 현재 `search_documents` compatibility는 유지되어야 하고 `smart_search`는 별도 read-only tool로 추가해야 한다.

## Planner 진입 조건

Planner는 다음 요구사항을 가장 앞쪽 phase로 배치해야 한다.

- `SEC-DOC-003`: redaction utility and fixtures.
- `DR-DOC-006`, `DR-DOC-013`: SQLite ledger and source identity.
- `CON-DOC-006`, `FR-TREE-009`: canonical broken-link diagnostics.
- `IR-MCP-018`, `CON-MCP-007`, `CON-MCP-010`: strict eight-tool MCP parity.
- `FR-APP-012`, `DR-DOC-008`: embedding settings and canonical chunk defaults.

## 검증

- SpecKiwi MCP active target 확인 완료.
- SpecKiwi strict validation 0 errors / 0 warnings 확인 완료.
- 3개 사전 서브에이전트 검토 결과를 반영했다.
- 추가 broken-link policy reviewer는 현 active SRS가 충분하다고 확인했다. 연구 문서의 winner-selection처럼 읽힐 수 있는 표현과 `unresolved count` 표현은 planner 전에 보정했다.
