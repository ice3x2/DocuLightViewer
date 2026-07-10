---
title: DocuLight Wave 2 SRS re-review before implementation planning
docType: report
category: knowledge-store-smart-search
project: DocuLightViewer
target: 0.11.0-w2
status: reviewed
date: 2026-07-02
relatedRequirements: FR-APP-012, FR-TREE-009, DR-DOC-013, CON-DOC-006, SEC-DOC-003, FR-DOC-025
---

# DocuLight Wave 2 SRS re-review before implementation planning

## 결론

0.11.0-w2 SRS는 구현 계획으로 진입해도 된다. 다만 기존 SRS 재검토에서 두 가지 drift가 발견되어 active 요구사항을 교체했다.

- `FR-TREE-008`은 폐기하고 `FR-TREE-009`로 대체했다. 이유는 `anchor_missing` 같은 폐기된 상태와 ambiguous target winner 선택 가능성이 남아 있었기 때문이다.
- `FR-APP-011`은 폐기하고 `FR-APP-012`로 대체했다. 이유는 embedding 설정 UI의 chunk 기본값이 `DR-DOC-008`의 canonical `900 tokens / 120 overlap`과 충돌했기 때문이다.

SpecKiwi strict validation은 0 errors / 0 warnings로 통과했다. Active target `0.11.0-w2`는 `planned: 28`, `verified: 1`, `discarded: 34`, `stable: 63` 상태이며 draft/deprecated/stability blocker는 없다.

## 깨진 링크 정책 판단

사용자의 추가 지적대로 깨진 링크 정책은 구현 계획의 핵심 제약으로 고정해야 한다. 현 SRS의 `FR-TREE-009`, `DR-DOC-013`, `CON-DOC-006`, `SEC-DOC-003`은 정책을 충분히 다룬다. 새 요구사항을 추가할 필요는 없다.

정책 불변식은 다음과 같다.

1. 깨진 링크는 저장 실패, 인덱싱 실패, 자동 import 신호가 아니다.
2. Canonical edge status는 `resolved`, `missing`, `external`, `path_policy_violation`, `skipped`, `ambiguous`, `stale`만 허용한다.
3. Reason detail은 별도 status가 아니라 `diagnostic_code`로 저장한다.
4. `resolved` edge만 `to_document_id`, linkScore, backlink, reciprocal link, same-cluster boost, `linkedTo`, `linkedFrom`에 참여한다.
5. `missing`, `external`, `path_policy_violation`, `skipped`, `ambiguous`, `stale`는 ranking-neutral diagnostic edge다.
6. BM25/FTS에는 `broken`, `missing` 같은 synthetic diagnostic token을 넣지 않는다.
7. Raw href, normalized href, canonical path, source root, destination path, userData path는 internal-only다.
8. MCP 도구는 recursive import, rebuild, retry, cancel, broken-link reconciliation control을 노출하거나 동기 시작하지 않는다.
9. `save_document`와 viewer save는 ordinary post-save indexing enqueue만 허용하고, 링크 재해결은 background reconciliation이 담당한다.

따라서 planner는 redaction utility, SQLite source identity/link ledger, link status fixture를 초반 phase로 배치해야 한다. 이 정책이 늦게 들어가면 `save_document`, linked local import, smart_search ranking을 다시 고칠 가능성이 크다.

## 3개 서브에이전트 재검토 요약

Code-context 검토는 현재 코드가 Wave 1.5 keyword SQLite cache까지만 갖고 있으며 embedding/HNSW/settings registration/link graph/save_document/smart_search는 대부분 greenfield라고 보았다. 따라서 구현은 small patch가 아니라 persistence, MCP contract, settings UI, indexing worker, package smoke를 묶는 큰 작업이다.

Existing-SRS 검토는 `FR-TREE-008`과 `FR-APP-011`의 drift를 지적했다. 위 두 요구사항은 active replacement로 정리했고, `FR-DOC-022`의 폐기 요구사항 언급은 구현 blocker가 아닌 planner cleanup note로 남긴다.

Policy-risk 검토는 바로 PM으로 들어가지 말고 planner를 먼저 실행해야 한다고 판단했다. 권장 순서는 shared redaction, SQLite ledger/recovery, embedding settings, HNSW packaging, background indexing/chunking/link graph, `save_document`, embedding/HNSW lifecycle, `smart_search`, linked import/legacy adoption, conformance 순서다.

## 구현 계획에 반영할 게이트

- `SEC-DOC-003` redaction fixture를 `save_document`, `smart_search`, diagnostics, logs, backup/export, package smoke에서 공유한다.
- `DR-DOC-013` source identity ledger를 destination path나 content hash보다 먼저 구현한다.
- `CON-DOC-006` broken-link lifecycle fixture를 link graph와 smart_search보다 먼저 구현한다.
- `FR-TREE-009`는 기존 sidebar parser 동작을 변경하지 않는 indexing-only extractor로 접근한다.
- `FR-APP-012`는 embedding model registration UI와 model fingerprint chunk defaults를 `900/120`으로 맞춘다.

## 비고

`hnswlib-node` npm metadata 기준 최신 확인 결과는 `3.0.0`, license는 `Apache-2.0`이다. package/build 단계에서 native module packaging smoke를 release-gating으로 두어야 한다.
