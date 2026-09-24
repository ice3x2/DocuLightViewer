# S04 source alias ledger evidence

Issue [#27](https://github.com/ice3x2/DocuLightViewer/issues/27), starting HEAD `0bfb5d803ced0e451cd105bed9034b89ed466798`, isolated worktree `C:/Work/git/_Snoworca/DocuLightViewer-r3` on `feature/issue-24-s01-sol-medium`. Relevant requirements: `DR-DOC-014` (in_progress/evolving), `FR-DOC-035` (implemented/evolving), and `DR-DOC-013` (verified/stable). Active target: `0.11.0-w2`; no stability blockers. No requirement status was advanced.

## Test-first record

The S04 case and both Node runner registrations were added before product code. The S03 source snapshot was refreshed in the existing separate Node and Electron roots under `%TEMP%` by `node test/r3/prepare-runtime.cjs --node-root "$env:TEMP/doculight-r3-node-20260924d" --electron-root "$env:TEMP/doculight-r3-electron-20260924d"`. The refresh took about 1.0 seconds and reused dependencies; Node ABI was 137 and Electron ABI was 130. File symlinks are denied by this Windows host (`EPERM`), so the fixture uses two permitted directory junctions resolving to the same original Markdown file. The fixture removes each junction before the harness removes its temporary directory.

With `DOCULIGHT_R3_NODE_ROOT` set to `%TEMP%/doculight-r3-node-20260924d`, `node test/r3/run-node.cjs --case s04` exited **1** in about **0.46 seconds** before implementation:

```text
ASSERTION_FAIL case=s04 assertions=1 two lexical aliases to one canonical original retain separate rows
```

This was a semantic assertion against real SQLite. The old `canonical_path_hash UNIQUE` and `ON CONFLICT(canonical_path_hash)` allowed only one alias row. A preliminary fixture cleanup error from leaving Windows junctions in the temporary directory was corrected in the test before this RED; it was not counted as RED.

## Implemented boundary and fixture

`source-ledger-store.js` now atomically rebuilds only the alias table when the old canonical-hash-only unique constraint is present. It copies every alias field, preserves alias IDs and timestamps, and installs a unique canonical-hash plus lexical-path index. Fresh databases use the same index. The alias upsert runs in a transaction, keeps separate lexical aliases for one canonical original and document ID, reuses an existing alias on repeat, and rejects assigning that canonical original to another document. Raw origins stay in internal columns; the public alias mapper returns neither path. The indexed copy remains `documents.relative_path`; the legacy hash-only row keeps both origin columns null.

The SQLite fixture starts with a populated ledger, then replaces only its alias table with the pre-origin layout containing one hash-only row. It retains a source, document metadata, chunk, embedding bytes, ANN index and membership, and a queued job. It reopens and migrates the database, adds two junction aliases, retries the first alias, attempts a conflicting document owner, reopens again, and checks rows, IDs, metadata, bytes, foreign keys, null origins, and public serialization.

After the code change, source-only refresh took about **1.0 seconds**. `node test/r3/run-node.cjs --case s04` exited **0** in about **0.49 seconds** (`PASS case=s04 assertions=20`). The existing `node test/test-wave2-ledger-contract.js`, run inside the Node snapshot, exited **0** in about **1.26 seconds** (`all assertions passed`). The case later gained three preservation assertions for embedding bytes, queued job status, and document metadata. A source-only refresh took **1.00 seconds**, followed by `node test/r3/run-node.cjs --case s04` exit **0** in **0.51 seconds** (`PASS case=s04 assertions=23`).

An additional alias-ID collision assertion exposed a second identity hazard. Test-only refresh then `node test/r3/run-node.cjs --case s04` exited **1** in **0.66 seconds**: `ASSERTION_FAIL case=s04 assertions=7 caller alias ID cannot silently reuse an existing alias identity`. The minimal guard was added before the alias upsert. Final source-only refresh took **1.15 seconds**, with source hash `f58f87072418368655e1c3219114c78cb424231eae9ac4c9d0acc30062ffdf8b`; the case exited **0** in **0.48 seconds** (`PASS case=s04 assertions=24`). The existing Wave 2 ledger contract again exited **0** in **1.25 seconds**. `git diff --check` exited 0; Git reported only its LF-to-CRLF working-copy notice. A reviewer run against a stale snapshot produced `SETUP_ERROR manifest stale`; this was a harness setup result, not TDD RED. The refreshed snapshot and final hash are the review baseline.

Independent [data/migration review](2026-09-24-s04-data-review.json) and [TDD/compatibility review](2026-09-24-s04-tdd-review.json) passed with no remaining findings. The original pre-implementation RED stdout/source snapshot was not archived; the recorded command and assertion sequence is the available historical evidence.
