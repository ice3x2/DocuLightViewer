# PG-04 same-locator publication during derivation

Requirements: FR-DOC-019 AC-2, REL-DOC-009 AC-1/2/3/4, IR-APP-013 AC-13.

- [x] Preserve semantic RED: `test-desired-job-publication-witness.js` proves same-byte/new-metadata publication currently lets the old claim complete before intent ACK.
- [x] Hold actual token preparation for over 1 second; a second same-locator save publishes Markdown and a body-free intent without `publication_busy`.
- [x] Prepare classification, chunks, token search text, and link candidates outside the locator gate with cancellation checks and no derived writes.
- [x] Under the locator gate, re-read and validate source bytes, claim/revision and accepted intent, then reject any checksum-valid published same-locator intent still awaiting ACK when it changes bytes, metadata, or aliases.
- [x] Resolve link candidates against the current ledger and commit source/keyword state plus completion CAS without yielding inside the gate. Keep global publisher order and locator-before-global lock order.
- [x] Verify unchanged content completes; newer bytes and same bytes/new metadata leave old derived rows and keyword index uncommitted; S11/S12/S13/S17/S19/S20/S23/S25 pass.
- [x] Measure guarded commit on a 10,485,752-byte fixture: 841 chunks, 389.8 ms in the retained final focused log. Preserve all failed reports and do not raise timeouts.
- [x] Reproduce A→B→C pre-ACK same-locator metadata loss and prevent stale derived writes even when B's file is superseded by C; verify same-byte/new distinct alias and latest accepted metadata/alias convergence.
- [x] Measure guarded witness scan with 1024 checksum-valid intents: 400.5 ms; record the slow all-real publication setup separately for #44/#65.
- [ ] Obtain independent code review before building a new package or running five cold samples.
