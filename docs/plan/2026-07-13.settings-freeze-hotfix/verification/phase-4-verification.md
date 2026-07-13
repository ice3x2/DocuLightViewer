# Phase 4 Verification

## RED

- Command: `node test/test-startup-index-recovery-memory-contract.js`
- Expected failure: startup reconciliation retains every verified document body in `_smartIndexQueue`.
- Actual evidence: FAILED because `_smartIndexQueue` retained the first 2 MiB Markdown string instead of `null`.

## GREEN

- Command: `node test/test-startup-index-recovery-memory-contract.js`; `node test/test-search-engine-lifecycle.js`; `node test/test-wave2-ledger-contract.js`
- Retained-content evidence: PASS with 4 known recovered documents / 8 MiB source bodies plus one legacy unbound fallback / 0 retained content bytes / 5 lazy worker inputs. This test does not claim a process RSS measurement.
- Standard gate evidence: `npm run test:release-regression` PASS, including the Wave 2 recovery contract.

## Review

- Requirement IDs: `FR-DOC-019`, `REL-DOC-007`, `SEC-DOC-003`.
- Diff inspection: preverified content hash and known identity retained; queue body is null; fallback queue also uses `retainContent:false`.
- Result: PASS
