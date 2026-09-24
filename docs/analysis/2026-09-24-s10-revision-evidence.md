# S10 durable desired revision evidence

Issue [#33](https://github.com/ice3x2/DocuLightViewer/issues/33) starts from pushed S09 SHA `780e623a5b46717f74e931952fff86e6bbb98b66` on `feature/issue-24-s01-sol-medium`. Requirements: `FR-DOC-019`, `REL-DOC-009`, `DR-DOC-014`. Active target is `0.11.0-w2`; none of these requirements has draft or deprecated stability. The private publisher and owner are not yet connected to the public save producers (#37).

## Test-first record

`test/r3/cases/s10.cjs` and the Node case registry were written before S10 behavior changes. The first real filesystem and SQLite run exited **1** with `ASSERTION_FAIL case=s10 assertions=2 owner accepts latest published same-body intent despite equal wall time`. The S09 owner had no durable publication-order evidence and returned a retryable non-ACK. No setup, module, or ABI failure is counted as RED. Subsequent assertions were added before the corresponding changes and observed these semantic REDs (all exit 1):

| Gate | Observed assertion |
|---|---|
| Durable desired enumeration | `assertions=6 current desired state is enumerable independently of terminal job history` |
| Automatic restart convergence | `assertions=15 restart automatically accepts durable latest intent without a user re-save` |
| Fresh failed-job retry | `assertions=16 failed current attempt creates a fresh retry job without reviving terminal history` |
| Dead publisher lock | `assertions=30 dead publisher lock is recovered before a new durable publication` |
| Late explicit old-intent replay | `assertions=35 late retry of an older private intent cannot republish older bytes over the newer final` |
| Automatic concurrent publisher wait | `assertions=32 second publisher waits asynchronously and publishes without a caller re-save` |
| Repeated content after intervening save | `assertions=39 A to B to A publication gets a fresh intent identity for the final A` |
| Crashed partial legacy lock owner | `assertions=31 stale partial legacy owner record cannot permanently block later publication` |
| Transient owner startup transaction | `assertions=24 owner retries a transient startup acceptance failure without a caller re-save` |

The final source-only snapshot hash is `1dead2018c26bdbe82700e9c1c21b13a380ec854f838a7a0810050d0f0c7f5a8`. `node test/r3/prepare-runtime.cjs --node-root %TEMP%/doculight-r3-node-20260924d --electron-root %TEMP%/doculight-r3-electron-20260924d` refreshed existing snapshots without dependency install or native rebuild. With `DOCULIGHT_R3_NODE_ROOT` set to the Node snapshot, `node test/r3/run-node.cjs --case s10` exited **0**, `PASS case=s10 assertions=46` (about 4.28 seconds). Windows x64, Node v24.16.0 / ABI 137, Electron 33.4.11 / ABI 130. An earlier run intermittently hit the restart assertion within a 500 ms test poll; the fixture now permits 2 seconds for the asynchronous owner startup scan.

## Verified boundaries

| Fixture | Evidence |
|---|---|
| Two pre-ACK same-body intents with equal millisecond time | Private publication order 1 then 2 selects the actually later published intent. Both aliases and both tag sets persist; the later scalar category wins. The owner cleans intents after durable receipts. |
| Owner restart without caller re-save | A second same-body pair is left on disk before ACK. Starting a new owner with `ingressRoot` resumes the bounded private scan, commits one current revision/job, retains both aliases and metadata, and removes only receipted intents. |
| A→B→C with timestamp rollback and concurrent ACCEPT | Forced timestamps run backward from 2030 to 2000. The C body/hash is the desired winner and only one current queued job remains. Older ACCEPT calls cannot borrow C's job. |
| Active job receives D | Claim marks revision 1 indexing. D advances desired revision 2 but leaves `active_requested_revision=1`, `dirty=1`, and `keyword_dirty=1`; a second active claim is rejected. |
| Cancellation, failure and retry | Cancelling old active work preserves D's final file. D becomes claimable; after a simulated failed attempt, a new retry job ID is queued, terminal history stays terminal, retry count and both dirty fields persist, and the final file remains. |
| More rows than page size | Eight pending documents are traversed through document-ID keyset pages of size 2 with no missing or duplicate document. |
| Cross-process publication contention | A child publisher holds the private gate after reserving order. A parent publisher waits asynchronously, publishes after the child, and the persisted order matches final file bytes. The caller does not perform a manual re-save. |
| Gate crash and stale replay | The new gate is an atomically linked, already flushed owner file, so it cannot expose half-written owner JSON. A live PID lock blocks publication before changing the final file; a dead PID lock and a legacy crashed partial owner directory are reclaimed. Explicit replay of an older intent after a newer final publication is rejected without overwriting current bytes. A→B→A creates a new intent ID and latest receipt. |
| Transient restart failure | A real SQLite trigger aborts job insertion during startup replay. The owner retains the private intent and final file, then automatically retries after the trigger is dropped. Replay processes one intent per event-loop turn and backs off from 500 ms up to 30 seconds on continuing failures. |
| Pre-S10 witness-free equal-time intents | The S09 fixture constructs legacy IDs with no order field. Both contenders remain retryable with their file and provenance; the owner does not infer a false scalar metadata winner. No pre-existing public producer emits S10 private intents before #37. |

Adjacent focused regressions passed on the same snapshot: S06 42 assertions, S08 53, and S09 37. `speckiwi --root C:/Work/git/_Snoworca/DocuLightViewer-r3 validate --json` exited 0 with errors 0 and the same six existing warnings (four completed-work status warnings, two rule-version warnings). `REL-DOC-009 AC-1` and its change note were updated through SpecKiwi dry-run and mutation, preserving the requirement ID. `git diff --check` exited 0.

The private owner now has a durable pending-page and claim/retry contract for S11's executor. This S10 test does not claim S11's completion race or S12's keyword cache write, and public save producer wiring remains #37. A witness-free legacy same-body/same-time pair cannot be ordered retroactively; retaining both intents and refusing a false ACK is the safe boundary. A reused PID cannot be distinguished portably through Node's process probe; if a dead lock owner PID is reused by another process, gate recovery conservatively fails closed before modifying a user file. [S20 #43](https://github.com/ice3x2/DocuLightViewer/issues/43) explicitly owns safe startup recovery or a redacted recovery action rather than guessing ownership. Independent [ordering/data review](2026-09-24-s10-order-review.json) and [TDD/reliability review](2026-09-24-s10-tdd-review.json) both passed without blocking findings; original preimplementation RED transcripts/source snapshots were not archived, so their complete chronology is author-reported.
