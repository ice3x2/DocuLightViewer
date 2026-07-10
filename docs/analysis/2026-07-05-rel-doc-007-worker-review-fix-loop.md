# REL-DOC-007 Worker Review Fix Loop

Date: 2026-07-05
Target: 0.11.0-w2
Requirement: REL-DOC-007

## Summary

The review-fix loop closed the remaining Settings search-index freeze risks by moving default semantic document indexing into `search-index-worker.js`, strengthening worker cancellation inside embedding/HNSW phases, preserving retryable job state on worker startup failures, and making benchmark/package evidence fail when worker execution is not actually proven.

## Fixed Review Findings

- Post-save semantic indexing now drains through `IndexingWorkerController.enqueueSemanticDocument()` by default.
- Worker-local semantic indexing creates its own OpenAI-compatible embedding provider and runs chunking, embedding, and HNSW/diagnostic handling in the worker runtime.
- Same-document saves queued behind an active semantic worker receive a distinct durable job id, while later queued saves still coalesce latest-wins.
- Worker startup/module-load failures leave semantic jobs `queued` with a diagnostic instead of silently dropping the in-memory queue item.
- `IndexingService` checks cancellation inside read, tokenize, embedding batch, HNSW build, and commit phases.
- Embedding API keys are included only in `semantic-document` worker config and are not written to ledger/status diagnostics.
- Internal `rebuild_index` socket action now uses `startRebuild()` instead of direct in-process rebuild.
- Benchmark reports now fail on missing worker start/schedule/completion, missing indexed documents, missing active cancel, latency threshold breaches, or non-empty contract failures.
- Package smoke now runs a real packaged `search-index-worker.js` document indexing job in addition to native ABI probing.

## Verification

- `node test/test-search-index-worker-contract.js`
- `node test/test-search-index-worker-benchmark-contract.js`
- `node test/test-wave2-ledger-contract.js`
- `node test/test-wave2-smart-search-contract.js`
- `node test/test-wave2-embedding-settings-contract.js`
- `node test/test-settings-indexing-contract.js`
- `node test/test-sqlite-native-packaging-contract.js`
- `node test/test-wave2-package-contract.js`
- `node test/test-sqlite-keyword-index-contract.js`
- `node test/test-wave2-redaction-recovery-contract.js`
- `node test/test-garu-tokenizer-contract.js`
- `node test/test-search-engine-lifecycle.js`
- `npm run build:win`
- `node test/package-smoke.js`

## Sub-Agent Review

Final focused review found no Critical or Important issues. It judged AC-1 and AC-2 sign-off defensible after benchmark and async worker failure fixes. Remaining notes are future hardening items: add a fuller packaged/Electron concurrent responsiveness smoke for MCP read/search plus tray/window event handling.
