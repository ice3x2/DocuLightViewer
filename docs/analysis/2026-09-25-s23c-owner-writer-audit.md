# S23c contained adoption and product SQLite writer audit

Source HEAD: `6f7200e58c1630955c10e140994b751fd3a84d67`
Frozen sourceHash: `b65556251551425e41a898f1f276e21d7107a2d7bf5b2d4f037b89054c84fb15`
Requirements: `FR-DOC-019` AC-6/10, `FR-DOC-035` AC-4/6/7/12/13, `DR-DOC-014`, `REL-DOC-009`, `IR-APP-010`.

## Semantic RED evidence

- The new contained command test first failed with `owner_unknown_type`; after registering the owner command, its main-process guard failed with `Error: main ledger access`. Both failures preceded implementation of the respective behavior.
- The unchanged registration test failed because `sources.updated_at` changed from `2026-09-25T02:51:57.809Z` to `2026-09-25T02:51:57.849Z`. Moving source creation after the unchanged check made it pass.
- The deterministic Windows junction race paused after canonical realpath A, retargeted the junction to outside B for `open`, then restored A before the post-check. Before the handle identity fix, `test-s23c-junction-race.cjs` failed with `Missing expected rejection: opened handle from outside target must be rejected despite restored lexical realpath`. After comparing the handle's device and inode with the canonical target before and after the bounded same-handle read, the test passed without document or job rows.
- The cold product private `rebuild_index` probe at sourceHash `024b282364790ac14cd29843f65550e134d26fd8cd5a06b99abc5f7d8f45479e` failed `S26 private rebuild_index cannot start a short-worker job outside the owner`. The pre-start SQLite hook observed writable opens in product main thread 0 and short worker threads 2–6. The route now uses the same guarded owner maintenance function as Settings.

## Final product run

`S26` passed 36 assertions across two inspected cold Electron PIDs. It exercised contained opt-in viewer registration, external registration, linked Settings import, all eight public MCP tools, Settings status/cancel/retry/rebuild/compact/confirmed-clear, private `rebuild_index`, and restart recovery. Compact returned `compact-rebuild-required` for the legacy `auto_vacuum=NONE` fixture. The private rebuild returned a durable owner job; subsequent Settings actions either returned a durable owner job or a truthful `job-in-progress` response.

The [constructor events](./2026-09-25-s23c-sqlite-open-raw.jsonl) are the pre-start audit JSONL with absolute paths reduced to database/module names. SHA-256: `f6daaad61e111fe49846b9bdaace774068460673845112caad252f554741bdd0`. The original local audit file has SHA-256 `0c8c1f91333964eb6afdfca2ca48bf06b2cd392f8e57b68acdab64c8911dca2a`. The [summary](./2026-09-25-s23c-owner-writer-audit.json) verifies 51 product opens: 4 writable owner opens (ledger and keyword in each run), 0 writable main opens, 0 writable short-worker opens, and 47 read-only product opens. Auxiliary ledger snapshots opened 23 read-only connections and no writable connections. The [S26 result](./2026-09-25-s23c-s26-result.json) records the product-route outcome without fixture paths.

## Gates and remaining scope

- Same-hash S23 45, S20 21, S19 47, S17 32, S25 16, contained adoption, junction race, opened registrar, keyword, smart search, and MCP parity passed.
- At sourceHash `67b5bf273bd258d40e22fb100d700fd15375e3796d2097f4627733ac065ae202`, S20 failed its startup timing assertion when run concurrently with S23/S19/S17/S25 (`owner publishes ready before first recovery page is unblocked`). A sequential rerun at that hash passed 21 assertions; the final hash also passed S20 sequentially with ready time 421 ms, 3,101 recovered, and page limit 32. The parallel failure is retained as a timing limitation, not erased by the sequential pass.
- The short worker/controller and legacy recovery adapter remain. `SearchEngine` still constructs the legacy controller and its non-product/package-smoke and compatibility methods have callers; removal requires a separate dead-call inventory and S19/S17 gates. The product's private rebuild route was migrated to the owner. GitHub #43, #61, and #46 are not claimed complete by this audit.
