# PG-04 same-locator publication during derivation

Requirements: FR-DOC-019 AC-2, REL-DOC-009 AC-1/2/3/4, IR-APP-013 AC-13.

- [x] Preserve semantic RED: `test-desired-job-publication-witness.js` proved that, before the fix, same-byte/new-metadata publication let the old claim complete before intent ACK.
- [x] Hold actual token preparation for over 1 second; a second same-locator save publishes Markdown and a body-free intent without `publication_busy`.
- [x] Prepare classification, chunks, token search text, and link candidates outside the locator gate with cancellation checks and no derived writes.
- [x] Under the locator gate, re-read and validate source bytes, claim/revision and accepted intent, then reject any checksum-valid published same-locator intent still awaiting ACK when it changes bytes, metadata, or aliases.
- [x] Resolve link candidates against the current ledger and commit source/keyword state plus completion CAS without yielding inside the gate. Keep global publisher order and locator-before-global lock order.
- [x] Verify unchanged content completes; newer bytes and same bytes/new metadata leave old derived rows and keyword index uncommitted; S11/S12/S13/S17/S19/S20/S23/S25 pass.
- [x] Measure guarded commit on a 10,485,752-byte fixture: 841 chunks, 389.8 ms in the retained final focused log. Preserve all failed reports and do not raise timeouts.
- [x] Reproduce A→B→C pre-ACK same-locator metadata loss and prevent stale derived writes even when B's file is superseded by C; verify same-byte/new distinct alias and latest accepted metadata/alias convergence.
- [x] Measure guarded witness scan with 1024 checksum-valid intents: 400.5 ms; record the slow all-real publication setup separately for #44/#65.
- [x] Obtain independent code review before building a new package or running five cold samples. The A→B→C, alias, owner-lock, Windows identity, and receipt findings were fixed and re-reviewed before the final build.
- [x] Run one exact-commit Windows x64 portable PG-04 series with five new process-cold profiles and keep every outcome. The immutable final report is `docs/analysis/p0-pg04-win32-x64-1790636912067-7f9c817e.json` at commit `fd03b5ecf4f40742eedec3f6f2f6dca5b606d865`, sourceHash `7ccf1dda9d74be2ae9c3b6be4b27c3ee9abf00bfbfe21531379036d1a2264a68`; all five passed the original limits. Earlier failed reports remain historical evidence.
- [x] Record the report's `corpus.ledgerRows=1` precisely as one **source row**. The fixture contains four Markdown files and 4,320,592 bytes; document and job row counts were not collected in this report. Do not use that field as a scaled-ledger claim.
- [ ] Keep broader same-locator near-capacity performance and live Windows/macOS/Linux release CI gates in #44/#65 and #21; this Windows PG-04 result does not approve a release.
