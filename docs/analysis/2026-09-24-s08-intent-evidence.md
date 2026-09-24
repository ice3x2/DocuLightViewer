# S08 private save-intent and file publication evidence

Start: `1919a335bccc429f0e378e08d8c5f8cbb238e890` on `feature/issue-24-s01-sol-medium`, isolated `DocuLightViewer-r3`. Requirements: `REL-DOC-009`, `FR-DOC-019`, `FR-DOC-028`, with `DR-DOC-014` private original provenance. Active target `0.11.0-w2`; `REL-DOC-009 planned/evolving`, no Stability blockers. Live #31 bottom boundary limits S08 to private file/intent publication. S09 owns authoritative ledger/job ACK, desired revision, alias upsert, and intent cleanup.

## Test-first record

`test/r3/cases/s08.cjs` and both Node case registries were written before the publisher behavior. A no-behavior export stub made the case load. Source-only refresh reused S03 Node/Electron native dependencies, then `node test/r3/run-node.cjs --case s08` returned exit 1 with exact semantic marker:

```text
ASSERTION_FAIL case=s08 assertions=0 expected content_hash_mismatch rejection
```

The earlier module-missing `SETUP_ERROR` was discarded and is not counted as RED. An independent review found that a later update at the same destination needed an atomic replacement. The new update/fault assertions failed before the fix with `ASSERTION_FAIL case=s08 assertions=28 expected fault_injected rejection` (exit 1). Additional untrusted-intent assertions failed before replay hardening with `ASSERTION_FAIL case=s08 assertions=28 oversized private intent is quarantined with bounded diagnostic` (exit 1). The old-intent preservation case failed with `ASSERTION_FAIL case=s08 assertions=40 older pending intent stays readable with original alias while new final bytes supersede it` (exit 1). The oversized final-file case failed with `ASSERTION_FAIL case=s08 assertions=44 oversized existing final is rejected without full read` (exit 1). Final source-only snapshot hash: `2e6567ff996a1ec56979a1a5e9071f39608a84d49887d0e4a3732e6dc6c98aa8`; final focused command exit 0:

```text
PASS case=s08 assertions=53
```

Runtime: Windows 10.0.26200 x64, Node v24.16.0 / ABI 137; existing Electron 33.4.11 / ABI 130 snapshot was source-refreshed without native rebuild. Existing `node test/test-mcp-http-save-parity.js` returned exit 0 with `test-mcp-http-save-parity: all assertions passed`.

## Real filesystem fault matrix

| Point | Observed bound |
| --- | --- |
| Ephemeral content hash mismatch | Rejected before final file |
| Private intent temp write, flush, rename | Injected failure; no final file |
| Document temp write, flush, rename | Injected failure; no final file; retry from published intent creates exact final bytes |
| After final publication | Injected failure leaves final bytes and private intent; restart/retry observes same published file and intent |
| Owner unavailable / no ACK | Publisher returns saved file with `indexing.state=enqueue_failed`, `index_enqueue_failed` warning and no `jobId` or queued claim |
| Repeated same identity | Same deterministic intent ID, final bytes and single matching intent file |
| Explicit update of same locator | Pre-rename failure keeps old final bytes and retryable new intent; retry atomically replaces final bytes with a distinct intent |
| Oversized/unknown-schema/unsafe-provenance intent | Bounded read rejects and quarantines the private record; diagnostic contains a stable code only; final user file remains |
| Replaced same lexical source root | Captured directory device/file ID and canonical path mismatch quarantines old pending intent; no replay into replacement root |
| Private ingress at 1024 entries | New publication is rejected before a final file appears |
| Older intent after valid update | Original alias and metadata stay decodable with `superseded`/`stale_final`; the old body is not replayed over new bytes |
| Transient intent read failure | Stable retryable diagnostic; valid intent remains in place and is not quarantined |
| Oversized existing final file | Bounded `fstat` and chunked hash reject publication without full-file read; user file and private provenance remain |
| Destination parent on another volume | Controlled `stat(dev)` fault rejects publication before final file |
| Traversal, symlink ancestor, oversize bytes | Rejected before publication; symlink outside target stays untouched |

The durable record contains checksum, source/root identity, contained locator, content hash, bounded lexical/canonical original aliases and normalized metadata. Body bytes stay ephemeral. Public publisher result omits raw original paths. The private reader validates checksum, root and published final hash before S09 can use it. New destinations use an atomic same-volume hard link from the flushed private temp file so a racing unrelated target cannot be overwritten by Windows rename semantics. Explicit updates use atomic rename after confirming the old file's identity and hash. A final containment and hash check follows publication. This is a transitional private S08 publisher: it reports `enqueue_failed` because no authoritative S09 ACK exists and makes no owner call. `faultAt=post_publish` models a process crash with no response, not an owner rejection. No alias row, job, desired revision, authoritative ACK, or intent deletion is asserted here.

On Windows, Node can `fsync` the intent and Markdown file handles but this runtime cannot portably open and `fsync` directory handles. The code verifies final containment and bytes after same-volume atomic publication. Directory entry persistence across sudden power loss remains a platform limit for the release fault gate; after a process crash, the final file and intent are retryable. An external actor retargeting a junction in the narrow check/publication window cannot be fully excluded with Node path APIs; the production owner must maintain a controlled store root, and the remaining race is recorded for release review. No saved final file is rolled back.

`speckiwi --root C:/Work/git/_Snoworca/DocuLightViewer-r3 edit-ac REL-DOC-009 AC-2` dry-run and mutation each returned exit 0 with `written=false` and `written=true` respectively; the ID remained AC-2. `add-change-note` dry-run and mutation also returned exit 0 and recorded why no-clobber hard-link publication is used for absent targets. `speckiwi validate --json` returned exit 0, errors 0, with the six pre-existing SRS warnings. `git diff --check` returned exit 0.

Independent [durability/security review](2026-09-24-s08-durability-review.json) and [TDD/compatibility review](2026-09-24-s08-tdd-review.json) passed with no remaining finding. The final saved-file/intent primitive is still not wired to the public save producer or authoritative owner commit; those are explicit S09 and #37 gates. The original pre-implementation RED transcript/source snapshot was not archived, so exact historical test-first chronology is author-reported rather than independently reconstructable from this final tree.
