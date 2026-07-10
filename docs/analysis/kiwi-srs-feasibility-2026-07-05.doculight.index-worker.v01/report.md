# kiwi-srs-feasibility Report: REL-DOC-007

## Meta

- run-id: `2026-07-05.doculight.index-worker.v01`
- target: `0.11.0-w2`
- evaluated requirement: `REL-DOC-007`
- mode: live read/evaluate, no stability mutation

## Feasibility

`REL-DOC-007` is feasible and core. The codebase already has Settings IPC controls, source-ledger job status fields, SQLite keyword wrappers, HNSW wrappers, and package native rebuild policy. The required implementation is high effort because it changes the execution model for rebuild, compact, semantic, HNSW maintenance, and worker-runtime package smoke, but no external repository is required.

## Stability Decision

No stability mutation was applied. The requirement is already `evolving`, which is sufficient for planning and implementation. It should not be promoted to `stable` until worker/runtime implementation, responsiveness regression, large-corpus benchmark evidence, and review-fix-loop evidence are attached.

## Risks

- SQLite generation swap and worker-owned write connection need careful Windows handle handling.
- Tests must prove responsiveness while the worker is busy, not merely that the IPC call returns quickly.
- Query-time HNSW fallback build must be removed or isolated without breaking keyword-only degraded smart_search behavior.

## Next Step

Proceed to `kiwi-planner` for `REL-DOC-007`.
