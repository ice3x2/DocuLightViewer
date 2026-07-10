---
title: DocuLight broken Markdown link policy review
docType: report
category: knowledge-store-smart-search
project: DocuLightViewer
target: 0.11.0-w2
status: researched
date: 2026-07-01
relatedRequirements: CON-ARCH-007, FR-DOC-033, DR-DOC-013, CON-DOC-007, FR-DOC-034, CON-DOC-006
---

# DocuLight broken Markdown link policy review

## 결론

Broken Markdown link는 인덱싱 실패가 아니라 persistent link graph의 진단 edge로 저장해야 한다. 다만 기존 문서는 이 방향을 부분적으로만 적고 있어, 실제 구현자가 `missing`, `external`, `path_policy_violation`, `ambiguous`, `stale`를 서로 다르게 처리하거나 broken edge를 ranking/filter에 섞을 위험이 있었다.

따라서 정책은 별도 제약 요구사항 `CON-DOC-006`으로 정리한다. 초기 `CON-DOC-003`은 평가에서 발견된 상태 enum drift와 MCP/background reconciliation 표현 혼선을 해결하기 위해 `CON-DOC-004`로 supersede했고, 이후 active 요구사항이 discarded 중간 요구사항을 참조하지 않도록 최종 trace-clean 체인인 `DR-DOC-013`, `CON-DOC-006`, `FR-DOC-033`, `CON-DOC-007`, `FR-DOC-034`, `CON-ARCH-007`로 교체했다. 핵심 원칙은 다음과 같다.

1. `resolved` edge만 link ranking boost와 `linkedTo`/`linkedFrom` 필터에 사용한다.
2. broken edge는 문서 row, destination write, recursive import, link boost를 만들지 않는다.
3. raw href와 normalized href는 내부 원장 값으로만 유지하고 외부 응답에는 redacted token, edge status, diagnostic code, counts만 노출한다.
4. target이 나중에 저장, legacy-adopt, local-import되면 normal background indexing/link graph reconciliation에서 `missing` 또는 `ambiguous` edge를 `resolved`로 전환한다.
5. target이 삭제, 제외, tombstone되면 기존 `resolved` edge는 source document indexing을 실패시키지 않고 `stale` 또는 `missing`으로 전환한다.
6. MCP save/search/open/update 호출은 broken-link reconciliation control, recursive import, bulk scan, rebuild, retry, cancel을 노출하거나 동기 시작하지 않는다. `save_document`는 ordinary post-save indexing enqueue만 허용한다.

## 서브에이전트 검토 요약

### 상태 전이 검토

기존 `FR-DOC-030`은 broken link를 graph diagnostic으로 보존하고 target added/removed reconciliation을 다루지만, canonical state machine은 없다. `FR-DOC-029`, `DR-DOC-011`, `FR-DOC-030`에 흩어진 `skipped`, `missing`, `external`, `ambiguous`, `stale equivalent` 용어를 하나의 enum과 전이 규칙으로 묶어야 한다.

### 보안과 redaction 검토

Broken href 자체가 민감 정보일 수 있다. Windows/UNC/POSIX absolute path, `..`, encoded traversal, credential-like URL이 raw href나 normalized href에 들어갈 수 있으므로, 외부 표면에는 raw/normalized href를 내보내지 않는다. Outside-root, symlink/junction escape, encoded path escape는 `path_policy_violation`으로 저장하고 문서 row나 destination write를 만들지 않는다.

### 검색과 진단 검토

Broken edge는 ranking-neutral이어야 한다. BM25/FTS에 `missing`, `broken` 같은 synthetic diagnostic token을 주입하지 않는다. 원문에 작성된 link text/href는 일반 본문 검색으로 매칭될 수 있지만, broken-edge metadata는 link graph diagnostics 경로에만 둔다. `includeDiagnostics=true`는 redacted aggregate counts, link graph readiness, last reconciliation/index revision을 제공할 수 있다.

## Canonical edge status

| Status | 의미 | 저장/인덱싱 부작용 | 검색/랭킹 | 전이 |
|---|---|---|---|---|
| `resolved` | active target `documentId/path_key`가 유일하게 확인됨 | target documentId 연결 | link boost와 `linkedTo`/`linkedFrom` 허용 | target 삭제/제외 시 `stale` 또는 `missing` |
| `missing` | 정책 범위 안의 local Markdown target이나 active target 문서가 없음 | document row/write 생성 금지 | ranking-neutral, diagnostics only | target 추가 시 `resolved` |
| `external` | remote/protocol URL 또는 외부 문서 링크 | import/write 생성 금지 | ranking-neutral, diagnostics only | source text 변경 전까지 terminal |
| `path_policy_violation` | outside-root, traversal, encoded slash/backslash, absolute/UNC segment, symlink/junction escape | document row/write/import 생성 금지 | ranking-neutral, diagnostics only | source text 또는 policy 변경 전까지 terminal |
| `skipped` | depth/file/byte limit, excluded target, non-Markdown/image/binary, cycle 등 의도적 skip | document row/write 생성 금지 | ranking-neutral, diagnostics only | source text 또는 limits 변경 시 재평가 |
| `ambiguous` | 여러 active candidate 또는 identity evidence 부족 | 자동 merge/overwrite 금지 | ranking-neutral, diagnostics only | unique identity 확보 시 `resolved` |
| `stale` | 과거 resolved target이 삭제, 제외, tombstone, 불확실 move 상태가 됨 | source document indexing은 유지 | ranking-neutral, diagnostics only | target 복원/재채택 시 `resolved`, 증거 소멸 시 `missing` |

## SRS 반영 방향

기존 linked import/duplicate-safety/legacy adoption 방향은 여전히 맞지만, active traceability와 canonical status 일관성을 위해 새 ID로 교체했다. `DR-DOC-011`은 split skipped_* 상태가 남아 있어 중간 `DR-DOC-012`를 거쳐 최종 `DR-DOC-013`으로 supersede했고, linked import/duplicate-safety/legacy adoption 및 Wave 2 gate도 discarded 중간 요구사항을 참조하지 않도록 각각 `FR-DOC-033`, `CON-DOC-007`, `FR-DOC-034`, `CON-ARCH-007`로 정리했다.

추가 요구사항:

- `DR-DOC-013`: source identity/import graph ledger는 active canonical edge status와 diagnostic_code를 분리해야 한다.
- `CON-DOC-006`: broken Markdown link edge lifecycle은 canonical, background-reconciled, non-blocking, redacted, MCP-inert이어야 한다.
- `FR-DOC-033`: linked local Markdown import는 canonical diagnostics를 사용하고 중복 저장 없이 graph connectivity를 보존해야 한다.
- `CON-DOC-007`: linked local Markdown import는 duplicate-safe, user-confirmed, MCP-inert, canonical-diagnostic이어야 한다.
- `FR-DOC-034`: existing knowledge-store Markdown files는 rewrite 없이 채택되고 canonical broken-link diagnostics를 사용해야 한다.
- `CON-ARCH-007`: Wave 2 implementation gate는 위 active 요구사항만 의존해야 한다.

검증 fixture는 최소한 broken relative link, broken wikilink, external URL, excluded target, outside-root target, symlink/junction escape, encoded traversal variants, ambiguous basename/case/Unicode collisions, target added later, target removed later, Korean/space filename, `includeDiagnostics` redaction을 포함해야 한다.

## 최종 검증

SpecKiwi strict validation은 errors 0, warnings 0으로 통과했다. 최종 독립 리뷰는 `DR-DOC-013`, `CON-DOC-006`, `FR-DOC-033`, `CON-DOC-007`, `FR-DOC-034`, `CON-ARCH-007`이 모두 broken-link 정책과 일관되며, active `depends_on`/`extends`가 discarded 중간 요구사항을 참조하는 경우가 0건이라고 확인했다.

최종 판정: A+.
