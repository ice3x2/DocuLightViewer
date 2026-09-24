# S13 link graph revision evidence

- Issue: [#36](https://github.com/ice3x2/DocuLightViewer/issues/36)
- Start: `d7e4e9ea204916b7746b193a88d225bee9c11a32` in isolated `DocuLightViewer-r3`.
- Requirements: `DR-DOC-013`, `CON-DOC-006`, `FR-TREE-009`, `FR-DOC-025` are stable/verified; `FR-DOC-019` is stable/in_progress. Active target is `0.11.0-w2`; no stability blocker.
- Runtime: Windows, Node 24.16.0, Node ABI 137, Electron ABI 130. Prepared snapshot: `C:/Users/beom/AppData/Local/Temp/doculight-r3-node-20260924d`.

## RED and GREEN

`test/r3/cases/s13.cjs` was registered and run on a real SQLite file before changing behavior. `node test/r3/run-node.cjs --case s13` exited 1 with `ASSERTION_FAIL case=s13 assertions=3 target addition reconciles source edge after background indexing`. The test setup and native SQLite load succeeded. At that point A's indexed revision contained a `missing` edge to B; saving and deriving B left the A edge missing.

The owner now drains a bounded, durable `link_reconcile_queue` populated by document upsert. Reconciliation changes only link status, diagnostic code, and active target identity in one SQLite transaction; it returns canonical counts and never returns raw href or paths. Derivation still replaces each source revision's entire edge set inside its guarded ledger transaction. A stale claim cannot replace a newer revision. The resolved-only read path requires active source and target documents and the indexed source revision to be current. Smart-search link filters fail closed if the ledger is unavailable.

Independent review found an unbounded popular-target transaction and unsupported promotion of ambiguous edges. Before repair, a second real SQLite RED exited 1 with `ASSERTION_FAIL case=s13 assertions=16 popular target reconciliation bounds one SQLite transaction by edge count`. The fixture had 130 distinct edges to one target. Reconciliation now pages at most 32 edges per owner drain call with a durable edge cursor, an indexed target lookup, and `hasMore` until the queue empties. Ambiguous edges are left untouched for source re-extraction with stable identity evidence.

A third real SQLite RED used a pre-S13 ledger schema and the first linked smart-search read. It exited 1 with `ASSERTION_FAIL case=s13 assertions=19 first linked smart-search read does not migrate or write an older ledger schema`; the first query had created the new queue table and index through lazy writable initialization. Linked filters and status counts now open a file-must-exist read-only connection without schema migration, and close it after the query. Missing or incompatible ledger reads fail closed. A follow-up independent review found that candidate identity recovery still used the writable lazy path. With the filter already read-only, the same old-schema fixture called `getSmartSearchDocumentIdentityForCandidate` and produced a fourth semantic RED: `ASSERTION_FAIL case=s13 assertions=19 first linked smart-search candidate and filter read do not migrate an older ledger schema`. Candidate identity, semantic candidate, semantic progress, and HNSW status reads now use the read-only existing-ledger path while mutating Settings/startup operations retain their existing writer route.

After repair, the same S13 command exited 0 with 20 assertions. The fixture covers missing to resolved after target addition, resolved to stale after tombstone, null target identity for stale edges, exact seven canonical status counts, stale source completion, a latest zero-link revision, read-only lookup, unavailable-ledger filter behavior, a first read of an older schema without migration, redacted diagnostics, bounded popular-target convergence, and preservation of ambiguous edges. The real database contains `links` and `link_reconcile_queue` created through `SourceLedgerStore.initialize()`.

## Adjacent contracts

- `node test/r3/run-node.cjs --case s12`: exit 0, 28 assertions.
- `node test/test-wave2-ledger-contract.js`: exit 0.
- `node test/test-wave2-smart-search-contract.js`: exit 0.
- `node test/test-link-extraction.js`, `node test/test-link-tree.js`, `node test/test-link-tree-build.js`, and `node test/test-sidebar-tree.js`: exit 0.
- `git diff --check`: exit 0.

The existing legacy `IndexingService` path still clears links directly; S14–S16 own producer cutover and #46 owns legacy owner cleanup. S13 evidence applies to the new private owner graph path.
