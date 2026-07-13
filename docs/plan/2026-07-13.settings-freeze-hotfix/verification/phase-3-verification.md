# Phase 3 Verification

## RED

- Command: `node test/test-status-coalescer-contract.js`; `node test/test-search-index-worker-contract.js`
- Expected failure: timer와 per-file rebuild status가 공통 500 ms coalescer를 사용하지 않아 burst가 그대로 durable write로 전달된다.
- Actual evidence: coalescer module assertion failed; worker contract reported missing shared 500 ms coalescer.

## GREEN

- Command: `node test/test-status-coalescer-contract.js`; `node test/test-search-index-worker-contract.js`; `node test/test-search-index-worker-benchmark-contract.js`
- Heartbeat/terminal durability evidence: PASS; first status immediate, 1,000 burst statuses collapse to latest at 500 ms, flush/cancel deterministic, worker terminal contract passes.
- Benchmark evidence: PASS.

## Review

- Requirement IDs: `REL-DOC-007`, `REL-DOC-008`.
- Diff inspection: all worker `postStatus` calls share coalescer; cancel and terminal paths flush immediately.
- Result: PASS
