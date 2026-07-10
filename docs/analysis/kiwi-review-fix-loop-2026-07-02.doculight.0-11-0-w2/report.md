# Wave 2 PH-010 Review/Fix Loop Report

- Target: `0.11.0-w2`
- Task: `T-PH010-01`
- Date: `2026-07-02`
- Scope: final verification and targeted review fixes for Wave 2 smart-search/package conformance, with additional `save_document` git metadata redaction hardening discovered during review.

## Findings Resolved

1. PH-009 evidence had been recorded under the wrong SRS block.
   - Fixed by moving package evidence to `OPS-ARCH-009`/`OPS-ARCH-010` and validating SpecKiwi strict mode.
2. PH-009 PM call log and residual-risk records were incomplete.
   - Fixed by updating `.kiwi` PM state/task records for PH-009 before PH-010 closeout.
3. `save_document` could persist raw `gitContextPath`/`projectPath` and credential-bearing git remote values into saved Markdown frontmatter.
   - Fixed by sanitizing collected git metadata before frontmatter injection.
   - Added regression fixtures for query credentials, relative path-like remotes, SCP-like Windows absolute remotes, existing git frontmatter, URL/SCP credential path segments, and SCP user/host credential prefixes.
4. Existing input frontmatter could bypass git metadata sanitization.
   - Fixed by stripping `projectPath`, `gitRemote`, `gitBranch`, and `gitLastCommit` from incoming `save_document` content before safe metadata merge.

## Verification

- `node --check src/main/mcp-save.js`
- `node --check test/test-mcp-http-save-parity.js`
- `node test/test-mcp-http-save-parity.js`
- `npm run test:wave1`
- `npm run test:wave1.5`
- `npm run test:garu`
- `npm run test:wave2`
- `npm run build:win`
- `npm run smoke:package`
- SpecKiwi `validate_spec` with `strict=true`, `failOnWarning=true`

`npm run build:win` completed successfully. The optional `hnswlib-node` rebuild still reports `native_unavailable` degraded mode, which is an accepted optional-native state for the current package gate.

## Sub-Agent Review

- Halley: package/native/release review found misplaced PH-009 evidence; fixed.
- Erdos: SRS/PM evidence review found PH-009 PM evidence gaps; fixed.
- Hume: MCP/security review found raw `gitContextPath`/credential git remote leakage; fixed.
- Mill: final narrow redaction re-review found follow-up Medium issues in git remote handling; all were fixed. Final result: no remaining Critical/High/Medium findings in the narrow `save_document` git frontmatter/gitRemote redaction area.

## Residual Risk

- `SEC-DOC-003` AC-4 remains broader than saved Markdown/frontmatter and still needs a dedicated shared redaction fixture covering trace/export/backup surfaces.
- Optional native HNSW failure injection and multi-arch skipped-reason artifacts remain broader package-matrix work, not PH-010 blocker scope.
