# S07 cooperative scheduler evidence

Issue [#30](https://github.com/ice3x2/DocuLightViewer/issues/30), start SHA `00dfa538c85d19cd605e18881dfa5f543182629d`, branch `feature/issue-24-s01-sol-medium`. Active target `0.11.0-w2` has no stability blocker. Requirements: `FR-DOC-019` (in_progress/stable), `REL-DOC-007` (verified/evolving), `IR-APP-013` (planned/evolving). No status is advanced here.

## Feasibility boundary

S06's `accept_save` still returns `owner_not_implemented`; S08 (#31) owns durable save and indexing jobs. S07 exercises the actual S06 owner worker and `OwnerWorkerController` through their existing six-type private registry. A fixture gated by private `r3SchedulerFixture` worker data performs CPU loops and real `better-sqlite3` transactions on the owner's keyword connection. It creates no second writer, public MCP tool, IPC control, or save response field. Its table exists only in temporary test databases. Actual saved-document indexing overlap remains for #31–#35 and #45; packaged application close/focus and full ledger status gates remain for #49. This transitional test does not prove those later gates.

The scheduler bounds accepted jobs to 32, rotates them in FIFO order after each synchronous work unit, and yields only between units. A Promise-returning unit fails with `owner_async_unit`. Cancellation targets one job and completes at the next unit boundary. `get_status` uses the controller's sequence-monotonic cache without a database read. `query_keyword` remains a read-only owner connection query; the fixture's count probe is private and gated. The saved file and completed-import file are unchanged after cancellation. S08 must use the bounded unit contract for real commands and leave cancelled revisions retryable in its durable ledger.

## RED and GREEN

The source-only snapshots were refreshed with `node test/r3/prepare-runtime.cjs --node-root %TEMP%/doculight-r3-node-20260924d --electron-root %TEMP%/doculight-r3-electron-20260924d`. Real `better-sqlite3` loaded under Node v24.16.0 / ABI 137 and Electron 33.4.11 / ABI 130 on Windows 10.0.26200 x64. Final source hash: `8423453fae1309404e2823b99e55d17062c5abd46c4f2ceff1fbd81202d724d5`.

| Stage | Command and result |
| --- | --- |
| Owner-route RED | Node S07 exited 1: `ASSERTION_FAIL case=s07 assertions=1 FR-DOC-019 real owner scheduler runs first committed SQLite work unit`. A test cleanup timer was corrected before accepting this semantic RED; the clean repeat exited 1 with only that assertion. |
| Atomic-unit RED | Node S07 exited 1: `ASSERTION_FAIL case=s07 assertions=2 work unit rejects asynchronous transaction boundary`. |
| Cancel-status RED | Node S07 exited 1: `ASSERTION_FAIL case=s07 assertions=9 cancel-requested cached status retains committed progress`. |
| Callback RED | Node S07 exited 1: `ASSERTION_FAIL case=s07 assertions=3 failed completion callback is not invoked twice`. |
| Fair-order RED | Node and Electron S07 exited 1: `ASSERTION_FAIL case=s07 assertions=2 bounded scheduler rotates queued jobs after each committed unit`. |
| Active-window RED | Electron S07 exited 1: `ASSERTION_FAIL case=s07 assertions=16 Electron sample window spans sustained active owner progress and two heartbeat ticks`. The test then attached a rejection handler to its in-flight job so cleanup could not produce an unrelated unhandled rejection. |
| Final Node GREEN | `node test/r3/run-node.cjs --case s07` exited 0 in 1.339 s, `PASS case=s07 assertions=15`; query/status/cancel group 0.337 ms, cancellation after 4 of 256 committed units. |
| Final Electron GREEN | `node test/r3/run-electron.cjs --scenario s07` exited 0 in 2.197 s, `PASS case=s07 assertions=20`; 67 active-window samples. |
| S06 regression | Node S06 exited 0 in 3.674 s and Electron S06 exited 0 in 3.507 s; each reported 42 assertions. The pre-existing search-index-worker contract also passed. |

An earlier Electron run completed assertions but exited before terminal PASS because closing the temporary test window quit Electron. The S07 harness keeps the test app open until dispatch reports PASS. Hardware acceleration is disabled for this scenario to prevent post-PASS GPU log lines invalidating the strict terminal marker.

## Raw Electron measurements

The final run sampled the active owner from monotonic `726.275 ms` to `1317.035 ms` (590.760 ms). Each of 67 samples records start/end monotonic times, operation kind, `active=true`, and committed-unit progress in the [raw measurement artifact](2026-09-24-s07-electron-raw.json). Progress rose from unit 1 to 1201 across samples; the job was cancelled after 1203 of 20,000 possible SQLite+CPU units. Each successive status sample waited for another 20 real committed units using owner STATUS acknowledgments rather than a fixed sleep. The samples comprise 60 cached status queries, six focus calls, and one close call. `p95=0.236 ms`, `p99=0.678 ms`, `max=0.678 ms`, cancel `6.590 ms`; all are below unchanged `250/500/1000 ms` and `1000 ms` gates. Fifty-nine main heartbeat gaps measured only inside the active window had max `11.929 ms`, below `250 ms`.

The test uses real SQLite reads/writes, CPU work, an actual owner worker, and real Electron window methods. It is not a process-cold full application or 160 MiB document benchmark. Product producer migration is not claimed by this sample.

## Handoff

The six private command types and seven wire tags are unchanged. S08 can submit stateful `runUnit` jobs to `createWorkUnitScheduler`, with one bounded synchronous transaction per unit, cached STATUS via `onProgress`, correlated RESULT via `onDone`, and target cancellation via `scheduler.cancel`. `accept_save` still returns `owner_not_implemented` without the private fixture gate. Durable revisions, file publication, and pending/retry semantics belong to S08. Independent [TDD/performance review](2026-09-24-s07-tdd-review.json) and [owner runtime review](2026-09-24-s07-runtime-review.json) both pass with no remaining finding. Pre-implementation RED commands and assertion names are recorded, but their original source snapshots and raw transcripts were not archived; exact historical chronology is author-reported.
