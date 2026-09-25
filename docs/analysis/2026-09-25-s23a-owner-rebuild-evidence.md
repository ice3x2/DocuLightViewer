# S23a Settings rebuild/retry owner cutover evidence

- Starting checkpoint: `56ede848058274c596df102006a89498a0d720db` in isolated `DocuLightViewer-r3`; original worktree untouched.
- Requirements: `FR-DOC-019 AC-6/10` (stable, in_progress), `IR-APP-010` (stable, verified), `IR-APP-013 AC-15/16` (evolving, planned), `REL-DOC-008 AC-4/5` (evolving, implemented). No requirement ID or lifecycle status changed.
- Focused sourceHash after independent review fixes: `5ad59582f77451bf909f8c9a907e6302a1fd393b8231347769597d6442f8226b` (Node ABI 137, Electron ABI 130, Windows x64). The hash excludes this analysis file and plan progress text.

## TDD and database ownership

The first semantic RED extracted the actual `indexing:start-rebuild` Settings IPC registration, started the real long owner on writable source and keyword SQLite, and made the legacy short-worker route observable. It failed as `ASSERTION_FAIL case=s23 assertions=12 actual Settings rebuild starts a durable job on the long owner` (exit 1). The owner now accepts a strict private `manage_index` `{operation}` command for `rebuild` and `retry`; invalid controller and direct worker-wire payloads reject with `owner_invalid_manage_index_payload`, without echoing a path. Settings rebuild/retry call the same owner, preserve `started/scheduled/jobId/reason/status`, and deny duplicate work. Compact and clear remain separate S23b work.

The S23 fixture's startup audit recorded `ownerThreadId=1`, `ownerOpenCount=2`, with source and keyword writable opens on that same long worker thread. The actual extracted Settings handler never called its instrumented short-worker rebuild method. The owner stages at most 16 documents per page, yields to status/query/cancel between pages, checks contained real paths against its configured publication root, and atomically commits a validated staged generation. Missing keyword index alone did not start work. A failed first rebuild in a missing-index state accepted `retry`; an interrupted explicit rebuild was closed and restarted after owner recovery.

Independent review found three high-severity omissions in the first frozen hash. Additional semantic REDs were `ASSERTION_FAIL case=s23 assertions=18 actual product facade refreshes project list and indexed count after owner terminal without search_documents`, `ASSERTION_FAIL case=s23 assertions=37 manage_index rejects immediately while owner migration is incomplete`, and `ASSERTION_FAIL case=s23 assertions=41 owner completes rebuild of existing 11 MiB Markdown without a size-cap failure`. The owner now notifies the product read-only search facade after terminal commit, controller and worker reject maintenance until recovery completes, startup resumes only explicitly requested rebuilds, and the scanner streams UTF-8 in 64 KiB chunks instead of imposing a 10 MiB cap. Scoped requeue marks an affected committed ANN index stale before dropping its membership and keeps its artifact for safe fallback/recovery.

A second independent review found that cancel acknowledgement replaced the rebuild snapshot with a generic indexing state. The semantic RED was `ASSERTION_FAIL case=s23 assertions=30 cancel request preserves active Settings rebuild identity, live session, and stop policy`. The owner now keeps `kind=rebuild`, job ID, active rebuild session, progress, and `cancelRequested=true` until the terminal update; Settings continues to show rebuilding and can target the same job during cancellation.

## Committed generation and source state

The test computes a SHA-256 checksum over ordered committed `keyword_documents` and `keyword_segments` rows. This is the logical committed-index checksum: staging/WAL may change physical SQLite file bytes. A body-only FTS query remained available during staging and after injected precommit failure and mid-work cancellation.

| Boundary | Committed generation ID | Logical committed checksum |
| --- | --- | --- |
| Before and after injected precommit fault | `generation-4bfbe4ec-ccfc-4eba-a50f-87d6f8ece01a` | `199b2bcdbb9c829118cf165923d88c0c00eb6cf6d6c77186bbdedf4066681907` |
| Before and after mid-work cancellation | `generation-68a0b08d-8478-4463-949f-f300c00a0d52` | `133aa752dd756436de259aa280401ad1392a8bf355925f13dbf6b8a80e122841` |

After successful commit, scoped derived reset/requeue removed an old chunk for the affected document and enqueued its new job. Its document ID, source alias, and unrelated queued `index_jobs` row survived. The product Settings status response showed an active rebuild session; owner query/status responded during a 96-document rebuild page before cancellation.

The product read-only facade refreshed `search_projects` from Old/1 to New/2 and top-level `indexedCount` to 2 after owner commit without first calling `search_documents`. Fault and cancel retained the prior facade. The owner rejected a request during the migration barrier immediately with `owner-recovery-pending`; a nonexplicit interrupted job did not trigger startup rebuild. For the large-file regression, two sparse 11 MiB files (including frontmatter beyond the legacy 1,200-character recognition window) and a UTF-8 chunk-boundary file had byte-equivalent committed metadata, full-content/body hashes, and FTS text to the legacy Settings builder. A sparse 167,772,165-byte Markdown file also completed an owner rebuild and retained its leading keyword. No peak RSS measurement was taken; the streaming implementation retains one 64 KiB byte chunk and a 2,400-character prefix.

## Verification

| Check | Result |
| --- | --- |
| `node test/r3/run-node.cjs --case s23` | PASS 45 assertions; exact `S23_EVIDENCE` values above |
| `node test/r3/run-node.cjs --case s19` | PASS 47 |
| `node test/r3/run-node.cjs --case s20` | PASS 21; 3,101 recovered in 32-row pages |
| `node test/r3/run-node.cjs --case s17` | PASS 32 |
| `node test/test-settings-indexing-contract.js` | PASS |
| `node test/test-sqlite-keyword-index-contract.js` | PASS |
| `node test/r3/run-electron.cjs --scenario s26` | PASS 25 on the same sourceHash; two cold Electron PIDs, save/import/cancel/restart and public search envelopes. Immutable raw output: [S23a S26 Electron sample](./2026-09-25-s23a-s26-electron-raw.json) |

Public MCP tools and fields were not changed. `FR-DOC-019 AC-10` remains unchecked until independent re-review and the broader S23b/S23c product audit. #46, #43, #44, and #45 remain open. The staged-to-committed SQLite swap is one atomic transaction; the current focused test proves responsiveness between document pages, while a large-corpus commit latency bound has not been measured. S20's 200 ms startup timing assertion failed twice under concurrent and high-load runs, then passed in an isolated rerun (`PASS 21`, 3,101 recovered); this is reported as a timing flake rather than hidden.
