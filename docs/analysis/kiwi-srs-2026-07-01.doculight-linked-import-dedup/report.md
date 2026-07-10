# Linked Local Markdown Import Deduplication Report

| Field | Value |
|---|---|
| Date | 2026-07-01 |
| Target | 0.11.0-w2 |
| Requirement IDs | FR-DOC-029, DR-DOC-011, CON-DOC-002, FR-DOC-030 |
| Status | SRS improved |
| Review Topology | 5 read-only sub-agent reviews |

## 결론

이미 저장된 문서는 다시 저장하면 안 된다. 이 판단은 raw absolute path 하나로 하면 안 된다.

절대경로는 입력을 정규화하고 import root containment와 realpath 검증을 하기 위한 internal-only 값이다. 중복 저장 방지는 `source_id + path_key`, canonical realpath hash, stable `documentId`, content hash, optional file-id/inode evidence를 역할별로 나누어 적용해야 한다.

이번 검토 결과, 기존 `FR-DOC-029`와 `DR-DOC-011`의 방향은 맞았다. 다만 MCP viewer tools를 통한 우회 실행, symlink TOCTOU, concurrent import race, destination collision, encoded traversal fixture, legacy saved document adoption이 더 명시되어야 했다. 이를 `CON-DOC-002`로 보강했다.

추가 검토에서 한 가지 중요한 차이를 더 확인했다. knowledge-store root 안에 이미 존재하던 Markdown은 원본 local source identity가 없을 수 있다. 이 경우 원본과 자동 병합하면 안 되지만, 지식 저장소 문서로는 반드시 채택되어 인덱싱되어야 한다. 이를 `FR-DOC-030`으로 보강했다.

## 핵심 해결책

1. Import entrypoint를 하나로 제한한다.

   Linked local Markdown import는 Settings/import dialog 또는 source-path-backed local import action에서 사용자가 import root와 실행을 명시적으로 승인한 경우에만 시작한다. `open_markdown`, `update_markdown`, `save_document`, `search_documents`, `search_projects`, `smart_search` 같은 MCP 도구는 import를 시작하지 않는다.

2. Same-run cycle과 duplicate는 canonical source identity로 막는다.

   Importer는 링크 후보를 lexical normalization으로 정리한 뒤 realpath를 계산하고, canonical containment를 확인한다. 같은 run에서는 active recursion stack과 visited set에 canonical realpath hash 또는 canonical source identity를 넣는다. raw absolute path, destination path, content hash, inode/file-id, `documentId`만으로 cycle 여부를 판단하지 않는다.

3. Persistent duplicate/update는 SQLite unique constraint로 닫는다.

   주 조회 키는 `(source_id, path_key)`다. canonical path hash는 symlink/junction/case alias를 잡는 보조 키다. 같은 canonical source에 대해 concurrent import jobs가 들어와도 SQLite unique constraint 또는 transaction/upsert로 하나의 active `documentId`와 하나의 destination write만 성공해야 한다.

4. Content hash는 primary identity가 아니다.

   content hash가 같으면 no-op update, stale vector reuse, move/copy 후보 판단에 쓰되, 서로 다른 active source path를 자동 병합하지 않는다. 이전 path가 inactive/missing/deleted이고 file-id/inode 같은 platform evidence가 있거나 사용자가 승인한 경우에만 move로 채택한다.

5. Destination path는 identity 결정 뒤의 derived value다.

   저장 위치는 source identity 결정 이후 계산한다. source-relative layout을 보존하더라도 absolute segment, drive/UNC segment, `..`, NUL-like segment, encoded slash/backslash/traversal, reserved device name, case/Unicode normalization collision을 거부하거나 deterministic conflict name으로 격리한다.

6. 기존 저장본은 무조건 덮어쓰지 않는다.

   Legacy destination file 또는 saved document가 있는데 source identity ledger row가 없으면 adoption candidate로만 기록한다. content hash, frontmatter identity, optional file-id/inode, destination containment evidence가 모두 일관될 때만 채택하고, 증거가 부족하면 `ambiguous` diagnostic을 반환한다.

7. Raw path는 외부에 노출하지 않는다.

   Import result, diagnostics, logs, backup/export manifest, `smart_search` trace에는 raw local absolute path, canonical path, app userData index path, destination path, credential-bearing URL을 넣지 않는다. 외부에는 `documentId`, source-relative path, redacted path token, status counts, diagnostic code만 노출한다.

8. 이미 knowledge-store root에 있는 Markdown은 rewrite 없이 legacy document로 채택한다.

   DocuLightViewer나 MCP를 거치지 않고 저장소 폴더에 들어온 Markdown도 인덱싱 대상이다. Scanner는 해당 파일을 `source_kind=knowledge_store` 또는 동등한 marker와 함께 SQLite 원장에 등록하고 stable `documentId`, source-relative `path_key`, content hash, freshness evidence를 기록한다. 이때 파일 본문을 수정하거나 다시 저장하지 않는다.

9. Legacy document와 local source-path import는 자동 병합하지 않는다.

   같은 content hash, basename, title/docName만으로 동일 문서라고 보지 않는다. Trusted DocuLight `documentId`가 있고 uniqueness 검증을 통과하면 재사용할 수 있지만, 없거나 충돌하면 ledger insert에서 새 stable `documentId`를 만들고 파일은 그대로 둔다.

10. Broken link는 indexing failure가 아니라 graph diagnostic이다.

    target이 없는 링크는 삭제하지 않는다. 원본 href, normalized href, anchor, source documentId, source location, diagnostic code를 `missing` 또는 equivalent edge status로 저장한다. 나중에 target 문서가 저장, legacy-adopt, local-import되면 다음 reconciliation에서 기존 edge를 `resolved`로 바꿀 수 있어야 한다.

## Identity Decision Matrix

| Key | 역할 | Same-run visited | Persistent lookup | 결정 |
|---|---|---:|---:|---|
| Raw absolute path | 입력 정규화, realpath 계산 시작점 | No | No | internal-only, primary 금지 |
| Canonical realpath hash | 물리 source alias와 cycle 방지 | Yes | 보조 alias guard | symlink/junction/case alias 방지 |
| Source root fingerprint | 승인된 import root 식별 | No | Yes, with `path_key` | `source_id` 재사용 기준 |
| Source-relative `path_key` | 논리 source identity | 보조 | Primary with `source_id` | `UNIQUE(source_id, path_key)` |
| `content_hash` | no-op/update/vector reuse | No | 보조 | primary 금지 |
| Optional file-id/inode | move evidence | No | move 후보 증거 | inactive previous path에서만 사용 |
| Stable `documentId` | 외부/public document identity | 결과 재사용 | match 이후 primary | update/move 시 보존 |
| Destination path | 저장본 위치 | No | collision guard | identity merge 기준 금지 |

## SRS 반영

추가된 요구사항:

- `CON-DOC-002`: linked local Markdown import는 duplicate-safe, user-confirmed, MCP-inert workflow여야 한다.
- `FR-DOC-030`: existing knowledge-store Markdown files는 rewrite 없이 legacy document로 채택되어 인덱싱되고 broken links를 diagnosable edge로 보존해야 한다.

연결 요구사항:

- `FR-DOC-029`: linked local import의 기능 동작과 중복 저장 금지.
- `DR-DOC-011`: source identity ledger와 import graph persistence.
- `SEC-DOC-003`: redaction policy.
- `IR-MCP-018`, `CON-MCP-007`: MCP strict schema와 no indexing/import control tool policy.
- `FR-DOC-019`: legacy adoption indexing enqueue.
- `DR-DOC-009`: source-root scanner policy.

폐기된 요구사항:

- `CON-DOC-001`: 같은 의미였지만 acceptance criteria label이 중복 렌더링되어 `CON-DOC-002`로 supersede 후 discarded 처리했다.

## 구현 순서 제안

1. `LocalLinkedImportService`를 Settings/local import 전용 internal service로 만든다.
2. `SourceIdentityResolver`를 분리해 root fingerprint, source-relative `path_key`, canonical realpath hash, content hash를 계산한다.
3. SQLite ledger에 `sources`, `documents`, `source_identities`, `import_jobs`, `import_job_documents`, `import_job_edges` 또는 동등 schema를 둔다.
4. `(source_id, path_key)`와 canonical path hash alias에 unique/upsert 경계를 둔다.
5. Import traversal은 기존 `link-parser.js` 규칙을 재사용하되, import 전용 edge status와 diagnostics를 생성한다.
6. Destination path는 source identity 결정 이후 sanitization과 final realpath containment를 거쳐 계산한다.
7. Post-save indexing은 기존 Wave 2 common entrypoint에 `requested_by=local.linked_import`로 enqueue한다.
8. Legacy knowledge-store files는 `requested_by=knowledge_store.legacy_adoption`으로 enqueue하고 파일 rewrite는 하지 않는다.
9. Broken link reconciliation은 link graph indexing phase에서 수행하며 missing edge를 삭제하지 않는다.
10. MCP 도구에는 linked import parameter나 tool을 추가하지 않는다.

## Release-Gating Fixtures

필수 fixture:

- Root document already imported.
- Linked child already imported.
- `A.md -> B.md -> C.md -> A.md`.
- Self-link and duplicate links.
- Concurrent duplicate import jobs.
- Symlink/junction alias.
- Case-insensitive alias.
- Root fingerprint change.
- Destination collision.
- Legacy destination without source identity ledger row.
- `%2e%2e`, `%2f`, `%5c`, double-encoded traversal.
- NUL-like input and Windows reserved names.
- Unicode normalization collision.
- Korean and space-containing filenames.
- Pre-existing knowledge-store files without ledger rows.
- Trusted documentId frontmatter reuse and documentId collision.
- Broken relative link and broken wikilink.
- Target added later and target removed later.
- Duplicate content in two active files.
- Same basename in different directories.
- Excluded target.
- Outside-root link.
- Symlink/junction escape.

Pass condition:

- Canonical source당 active 저장본은 최대 하나다.
- 이미 저장된 source는 기존 `documentId`를 재사용한다.
- unchanged content는 duplicate write와 duplicate indexing job을 만들지 않는다.
- changed content는 같은 `documentId` revision update로 처리된다.
- ambiguous legacy/copy/move 후보는 자동 overwrite/merge하지 않는다.
- response, logs, diagnostics, export, `smart_search` trace에는 raw absolute path가 없다.
- legacy knowledge-store file은 rewrite 없이 documentId와 indexing job을 얻는다.
- broken link는 indexing failure가 아니라 missing edge diagnostic으로 남고, target 추가 후 resolved로 갱신된다.

## 평가 요약

5개 서브에이전트 결론은 일치한다.

- 기존 `FR-DOC-029`와 `DR-DOC-011`은 문제의 핵심을 이미 잡고 있다.
- 절대경로 단독 판단은 부적절하다.
- 새 대형 기능 요구사항은 과하다.
- 다만 cross-surface safety invariant는 별도 constraint로 두는 편이 구현과 검증에 유리하다.

따라서 해결책은 새 MCP 도구를 만들거나 `save_document`에 recursive 옵션을 추가하는 것이 아니다. Settings/local import 내부 workflow를 만들고, SQLite identity ledger와 transaction/upsert로 중복 저장을 닫는 것이다.

추가로, 이미 저장소 폴더 안에 있는 문서는 legacy knowledge-store document로 채택한다. 이것은 local source-path import와의 자동 병합이 아니라 “이미 저장소 안에 있는 문서를 그대로 인덱싱하는 것”이다. 깨진 링크는 지우지 말고 missing edge로 남긴다.
