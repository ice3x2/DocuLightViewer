# kiwi-srs Report: Search Index Worker Runtime

## Summary

- run-id: `2026-07-05.doculight-search-index-worker`
- target: `0.11.0-w2`
- active requirement: `REL-DOC-007`
- status/stability: `planned` / `evolving`
- classification: `update`
- source report: `docs/analysis/2026-07-04-search-index-rebuild-freeze-report.md`

## Result

`REL-DOC-007` was added to close the gap between the previous non-blocking indexing intent and the observed freeze path. It requires actual worker-thread, child-process, or equivalent isolation for heavy search index maintenance work.

The malformed intermediate `REL-DOC-005` was moved to `discarded`. `REL-DOC-006` was also superseded after sub-agent review found missing latency and worker-native packaging criteria. `REL-DOC-007` is the active requirement.

## Coverage

The requirement covers:

- worker/child isolation for keyword rebuild, SQLite FTS writes, VACUUM/compact, embedding batch, and HNSW maintenance
- main-process responsiveness for Settings status/cancel, tray/window events, and MCP read/search requests, with p95/p99/max latency thresholds
- worker-owned SQLite write connection and committed generation protection
- durable status, heartbeat, cancel checkpoints, and diagnostics
- bounded Korean/basic tokenizer work for large documents using the 1200-char default analysis bound and large single-file fixture behavior
- no query-time synchronous HNSW rebuild
- Settings UX guards and concrete WAL/SHM-aware backup or explicit backup-skip policy
- worker-runtime native package smoke, automated responsiveness regression, and opt-in large-corpus benchmark evidence

## Validation

`mcp__speckiwi.validate_spec(strict=true, failOnWarning=true)` completed with 0 errors and 0 warnings after index summary counts were synchronized.
