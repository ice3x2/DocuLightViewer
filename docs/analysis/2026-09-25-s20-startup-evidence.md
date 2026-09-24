# S20 startup recovery evidence

Requirements: `FR-DOC-019` (stable, in progress), `REL-DOC-009` (evolving, planned), `IR-APP-013` (evolving, planned), and `IR-APP-010` (stable, verified). Active target: `0.11.0-w2`. Starting commit: `12d176cbcd84e56aba820a13fbec43ac9dedbd26`.

## Change and RED evidence

`test/r3/cases/s20.cjs` uses actual Markdown files and SQLite databases in the prepared Node ABI 137 snapshot. The first RED run exited 1 at `second live controller cannot open the same ledger` (one assertion), proving that two controllers could open the same writable database. After the exclusive lock was implemented, a second RED run exited 1 at `publication gate recovers recycled PID without losing Markdown` (five assertions). After the publication identity fix, a SharedArrayBuffer barrier held the first recovery page; RED exited 1 at `owner publishes ready before first recovery page is unblocked` (six assertions). After moving the first page past START-ready, a worker fixture prohibited full ingress `readdirSync`; RED exited 1 at `private ingress replay accepts a saved intent without full directory materialization` (eleven assertions). Each RED was an assertion failure, not an ABI or fixture setup failure.

The owner lock is an atomically linked file beside the ledger. Its record contains PID, process-start identity, and a unique controller token. A second live controller is rejected before worker construction and SQLite open. An actual child owner process was exited without shutdown; a new owner recovered its dead lock. A fixture with the current PID and a different start identity proved safe PID-reuse recovery. On platforms where process-start identity cannot be established, a live PID is treated as unknown and the lock remains busy; dead PID proof still permits recovery. The publication gate uses the same liveness proof. No process was terminated by the implementation.

Independent review found a compare-and-rename race in that first lock version. A deterministic test replaced the dead owner record with a live A lock between B's stale read and rename; RED exited 1 at `serialized recovery rejects A between B stale-read and rename, then keeps C out`. The publication version of the same test also exited 1 with its sidecar disabled. Both lock paths now serialize *every* acquisition and stale recovery through an atomic `.recovery` directory. A cannot acquire while B inspects and renames. A process crash while holding that short sidecar gate fails closed and needs explicit operator inspection; no age-based deletion is used.

The worker sends cached keyword health and START-ready before the first interrupted-job page. The barrier test proves `start()` resolves while that page is held. Recovery uses the existing 32-job keyset page and yields between pages. The test populated 3,101 real Markdown files and SQLite `indexing` jobs; START-ready took 425–613 ms in sampled runs, cached status and cancel returned during recovery, and all 3,101 jobs left `indexing` within the test deadline. Private intent replay now streams directory entries and the per-intent lookup retains only same-document candidates. No startup path loads every ingress filename into an array.

Independent review also found that S19 legacy migration used an unbounded `.all()` and ran before START-ready. A fixture with 3,101 actual legacy jobs produced RED at `owner START-ready precedes first real legacy migration page`. Legacy migration now reads at most 32 jobs per keyset page after START-ready. The test records each page, observes query and cancel replies before migration completes, and verifies all 3,101 legacy jobs migrate. New save acceptance stays closed until migration commits; a Markdown file published during migration remains on disk, returns `enqueue_failed`, and its durable intent replays after migration. Unknown migration schema markers still fail before ready. S11/S19 assertions now wait for the cached `recoveryComplete` status because START-ready intentionally precedes reconciliation.

Existing `SearchEngine.initialize` and `ensureFresh` keep missing/root/tokenizer-incompatible keyword caches stale without an implicit rebuild; the lifecycle and worker tests cover the narrow explicit Settings rebuild, cancelled/failed rebuild preservation, and search compatibility. S09, S10, S11, and S17 cover ACK/replay idempotence, same-document revisions, publication ordering, and durable desired-job behavior. S10's post-START check now waits for asynchronous recovery; when a newer save is committed before recovery, the superseded old job may correctly be `cancelled` rather than `failed`.

## GREEN commands

Prepared snapshot: `C:/Users/beom/AppData/Local/Temp/doculight-r3-node-20260924d`; Node ABI 137; Windows. Source hash at the recorded S20 run: `36ca3047485ec1790a914d227e0b764d804f6d77b4dfb51384885481a9877501`.

| Command | Result |
| --- | --- |
| `node test/r3/run-node.cjs --case s20` | PASS, 21 assertions; 3,101 interrupted jobs and 3,101 legacy jobs; 32-job pages |
| `node test/r3/run-node.cjs --case s10` | PASS, 47 assertions |
| `node test/r3/run-node.cjs --case s11` | PASS, 25 assertions |
| `node test/r3/run-node.cjs --case s19` | PASS, 47 assertions |
| `node test/r3/run-node.cjs --case s09` | PASS, 37 assertions |
| `node test/r3/run-node.cjs --case s17` | PASS, 32 assertions |
| `node test/test-search-engine-lifecycle.js` | PASS |
| `node test/test-startup-index-recovery-memory-contract.js` | PASS, 8 MiB source bodies and zero retained content bytes |
| `node test/test-search-index-worker-contract.js` | PASS |

**Open issue boundary:** Product main still calls `SearchEngine.initialize()`, whose legacy startup reconciliation can use main-thread SQLite and `.all()` independently of this owner route. Product-wide DB-free startup therefore remains unproven and issue #43 must stay open. The S23/S26 product owner cutover must remove that path and prove the cold app route. Prior committed keyword cache preservation is covered by the existing lifecycle and worker tests, but a new S20-specific real SQLite checksum assertion remains to add before issue closure. No SRS status or verification field was changed. This evidence covers the safe owner startup slice and does not assert completion of the broader `IR-APP-013` UI state matrix or all `REL-DOC-009` release fault gates.
