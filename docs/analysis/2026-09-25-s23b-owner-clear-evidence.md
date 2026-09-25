# S23b owner maintenance evidence

Scope: GitHub #61, `FR-DOC-019 AC-6/AC-10`, `IR-APP-010`, `IR-APP-013 AC-15/16`, `REL-DOC-004`, and `REL-DOC-007/008`. Starting SHA: `fa907204c686c59466f0d0428e278b24fa8d988c`. This is an uncommitted R3 review candidate; #61 remains open.

## RED

`node test/test-s23b-maintenance.js` first failed semantically on a real keyword SQLite database with `PRAGMA auto_vacuum=0`, 1,025 free pages, 4,288,512 file bytes, and a committed body-only FTS hit: owner compact returned `unsupported-operation` rather than physical reclamation or an explicit rebuild-required result. With the compact branch isolated, owner clear returned `unsupported-operation`; direct unconfirmed `indexing:clear` invoked the old `SearchEngine.clear()` mutation. Follow-up RED assertions found stale product project metadata after terminal clear, interrupted clear left in `indexing` on restart, active clear absent from Settings state, and compact admission in `READY_KEYWORD_DEGRADED`.

## Current GREEN and limits

`node test/test-s23b-maintenance.js` passes. The default `auto_vacuum=NONE` database cannot reclaim pages through `incremental_vacuum`, so `manage_index compact` returns `{started:false, scheduled:false, compacted:false, reason:'compact-rebuild-required'}`. The test re-reads `auto_vacuum`, `freelist_count`, and bytes after the request and verifies no false success claim. Settings translates this reason in all four locales. Physical NONE-mode compaction is **not implemented**; #61 must remain open.

Direct `indexing:clear` without a live Settings sender does not prompt or mutate. The main process presents a native confirmation dialog to a Settings sender; decline does not call the owner. Confirmed clear schedules one durable owner job, shown as a scheduled notice in Settings. The owner copies the committed SQLite snapshot through `better-sqlite3` online backup in 32-page steps, reopens and checks the backup, then deletes keyword rows in 128-row yielded units under one transaction. A separate owner read-only facade and the product facade retain the old committed body-only FTS hit until commit; search_documents, search_projects, and smart_search envelopes are byte-equivalent while clear is pending. A precommit fault or cancel rolls back, preserving the old generation and hit. Success leaves a readable backup with the old hit, removes the committed keyword generation, retains Markdown and unrelated jobs, and invalidates product search/project metadata only after terminal success. Settings permits keyword rebuild after clear and Stop while clear is active. Interrupted precommit clear is marked failed on restart without replay or cache deletion. In the 4 MiB fixture, owner query during backup took 1–3 ms and cancel acknowledgement took 1–2 ms; these are fixture samples, not a large-database percentile claim.

The keyword deletion transaction appends a `keyword_clear_receipts` row keyed by the maintenance job ID. If ledger finalization fails after keyword COMMIT, the owner reports terminal `completed` with `index_clear_ledger_finalize_pending`, because the old generation is already gone. On restart, the exact receipt finalizes an open clear job as completed. A later keyword generation does not erase the receipt. This is cross-database reconciliation, not a claim that keyword and source-ledger commits are atomic.

## Regression commands

- `node test/test-s23b-maintenance.js` — PASS; `S23B_COMPACT_ORACLE`, `S23B_CLEAR_EVIDENCE`, and `S23B_CANCEL_EVIDENCE` lines contain raw fixture measurements and the redacted backup token.
- `node test/test-settings-indexing-contract.js` — PASS.
- `node test/test-sqlite-keyword-index-contract.js` — PASS.
- `node test/r3/run-node.cjs --case s23` — PASS 45 after fixing cancel-request status job identity.
- `node test/r3/run-node.cjs --case s20` — PASS 21.
- `node test/r3/run-node.cjs --case s19` — PASS 47.
- `node test/r3/run-node.cjs --case s17` — PASS 32.
- `node test/r3/run-electron.cjs --scenario s26` — PASS 25 in two cold Electron processes on current sourceHash `3a236a61ed7cf67c3d0a61a804c3976b21f3cfc994dbbeee76d5d877ff9f0b0a`; raw JSON is [`2026-09-25-s23b-s26-electron-raw-v2.json`](./2026-09-25-s23b-s26-electron-raw-v2.json). An earlier hash `a6788e4e2998d82be96f5fde9ae1417379da61397182e149deffe944fd88a928` failed twice at S26 partial linked-import assertion 9; both raw failures remain attached as [`first`](./2026-09-25-s23b-s26-electron-failed.json) and [`repeat`](./2026-09-25-s23b-s26-electron-failed-repeat.json). Current S26 does not drive the Settings clear IPC itself.

Frozen sourceHash: `3a236a61ed7cf67c3d0a61a804c3976b21f3cfc994dbbeee76d5d877ff9f0b0a` (Node ABI 137, Electron ABI 130, Windows x64). The product-wide writable-open audit belongs to S23c; this change routes Settings compact/clear away from the short worker but does not delete that still-live worker.
