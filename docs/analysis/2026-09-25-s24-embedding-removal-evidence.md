# S24 embedding registration removal evidence

- Issue: [#47](https://github.com/ice3x2/DocuLightViewer/issues/47). Start: `66c5159bde338fde5fce9e21edc07b62ab3ea705` on isolated `DocuLightViewer-r3`.
- Requirement source: `FR-APP-013`, `DR-APP-003`, and `SEC-APP-004` implemented/evolving; `IR-MCP-018` and `CON-MCP-007` verified/stable in the branch-local SRS. Active target: `0.11.0-w2`; no stability blockers. `FR-APP-012`, `DR-APP-002`, and `SEC-APP-003` retain historical discarded blocks.
- Final standard R3 sourceHash after LOW evidence/status correction: `114ad69597d6b7db765352000dc4bcc92ca9a05cdff5ddac27de9b72f5aa9c15`. The implementation-only reviewed hash was `b012f3fb6496f90718869d8562990b680d8c04889d9ac0f5626333dc64061dc1`; the R3 hash also includes tracked `docs/spec/` files.
- Environment: Windows x64; Node v24.16.0 ABI 137; Electron 33.4.11 ABI 130. Prepared runtimes: `%TEMP%/doculight-r3-node-s24` and `%TEMP%/doculight-r3-electron-s24`.

## Inventory and change

The start SHA still exposed an embedding section and registration view in Settings, four preload bridge methods, four `embedding:` main IPC handlers, provider and credential wiring, and 30 `settings.embedding*` keys in each of ko/en/ja/es. Those Settings surfaces and keys are removed together. The adaptive Settings poller now requests indexing status only. Product SearchEngine construction no longer receives an embedding provider or legacy enabled configuration. `get-settings` omits legacy embedding fields.

Startup calls `removeLegacyEmbeddingSettings` in the retained `embedding-settings.js` helper. It removes only `semanticSearch`, `embeddingApiKeyCiphertext`, `embeddingApiKey`, and `apiKey` when present; it does not write on a repeated or empty cleanup. This leaves other settings and the SQLite semantic derived data untouched. No MCP tool or schema was added or changed.

## RED and GREEN

1. Initial `s24.cjs` assertion failed: `Settings has no embedding registration, status, or removal controls` (exit 1).
2. After UI/IPC cleanup, `node test/r3/run-node.cjs --case s24` failed at assertion 20: `provider-free semantic search uses embedding_disabled` (exit 1). The existing provider-free branch returned `embedding_provider_unavailable`; it now returns the already supported `embedding_disabled` reason.
3. With prepared snapshots, Node S24 passes 28 assertions and Electron S24 passes 3 assertions. The Node case checks the four legacy keys and unrelated settings, second-call zero writes, a real SQLite keyword hit in `smart_search`, existing `embedding_disabled` response, retained Markdown bytes, retained `chunk_embeddings` bytes, and committed `ann_indexes` state. It also executes the product's actual `registerIpcHandlers()` body in a VM with recorded `ipcMain.handle/on` calls: Settings and indexing handlers remain and no `embedding:` channel registers. The same probe against the start SHA failed specifically because the product registered embedding channels (exit 1); the current source passes. The Electron case loads the real Settings page and preload with context isolation, finding no embedding controls or bridge methods while localized indexing status remains visible.
4. `node test/test-embedding-removal-compat-contract.js`, `node test/test-settings-status-poller-contract.js`, `node test/test-settings-indexing-contract.js`, `node test/test-wave2-mcp-contract.js`, and `node test/test-mcp-tool-parity.js` pass. The poller contract retains indexing-only single-flight, rejection/retry, stop during flight, hung-cycle/no-timer-backlog, and post-stop assertions; it never calls the supplied embedding callback. `npm run test:wave1` passed on the implementation; `npm run test:wave2` passed again at the updated review hash. Worker contract and benchmark passed. The previous S21 Electron scenario passes 23 assertions at the updated hash. The historical registration contract test was replaced in the Wave 2 gate by the removal compatibility contract.

Commands for the frozen snapshot:

```powershell
$env:DOCULIGHT_R3_NODE_ROOT = "$env:TEMP\doculight-r3-node-s24"
$env:DOCULIGHT_R3_ELECTRON_ROOT = "$env:TEMP\doculight-r3-electron-s24"
node test/r3/run-node.cjs --case s24
node test/r3/run-electron.cjs --scenario s24
```

S21 [#44](https://github.com/ice3x2/DocuLightViewer/issues/44) remains open: this S24 change resolves its pre-existing embedding UI dependency, while its product owner DB-free and owner-action gates depend on other issues.

## SRS reconciliation map before mutation

The previous verified/stable `DR-APP-002` and `SEC-APP-003` described an active remote provider and cited the deleted historical registration test. Their July 2026 verification remains historical in the original blocks and Completed Work Log. The guarded SpecKiwi supersede created narrow `DR-APP-003` and `SEC-APP-004` successors, while `FR-APP-013` remains the removal requirement.

| Old criteria | S24 disposition |
| --- | --- |
| DR-APP-002 AC-1 schema/defaults, AC-2 safeStorage/env, AC-4 fingerprint preview, AC-5 retention/cost confirmation | Historical provider-registration behavior removed by FR-APP-013 AC-1/2/6. No active registration or credential storage is retained. |
| DR-APP-002 AC-3 no secret exposure | FR-APP-013 AC-4, DR-APP-003 AC-4: startup deletes credential/activation values and Settings payload omits them. |
| DR-APP-002 AC-6 plaintext migration or deletion | DR-APP-003 AC-1/2: choose the approved deletion path, including ciphertext, with idempotence; FR-APP-013 AC-4/5. |
| SEC-APP-003 AC-1 project allow/deny, AC-3 endpoint/proxy validation, AC-5 provider fixture set | Historical outbound-provider governance; FR-APP-013 AC-2/6 and SEC-APP-004 AC-1/2 prevent any configured outbound provider path. |
| SEC-APP-003 AC-2 offline-only | SEC-APP-004 AC-1/2: embedding stays disabled for every project, including legacy enabled settings. |
| SEC-APP-003 AC-4 blocked-policy diagnostics | FR-APP-013 AC-7/8 and SEC-APP-004 AC-3: existing `embedding_disabled` keyword-only degradation. |
| SEC-APP-003 AC-6 sanitized activation record | FR-APP-013 AC-4 and DR-APP-003 AC-1/4: remove the record and prevent Settings exposure. |

The preserved data constraint is FR-APP-013 AC-7, DR-APP-003 AC-3, and SEC-APP-004 AC-4: neither Markdown nor existing chunk embedding/ANN derived data is deleted by this settings cleanup.

## Guarded SRS reconciliation result

Branch-root SpecKiwi CLI `supersede --dry-run --confirm-discard-verified` resolved exact new IDs `DR-APP-003` and `SEC-APP-004`. The guarded `--apply` superseded `DR-APP-002` and `SEC-APP-003`, retaining their July verification rows and Completed Work Log history. After per-AC evidence and independent review, the two narrow successors and `FR-APP-013` moved from planned to `implemented/evolving` through CLI dry-run/apply. None was marked verified. The prior `FR-APP-012` historical registration requirement remains discarded.

Current test evidence was attached per acceptance criterion to FR-APP-013, DR-APP-003, and SEC-APP-004. Their trace links identify `src/main/embedding-settings.js`, `src/main/index.js`, and the successor relationships. The deleted `test/test-wave2-embedding-settings-contract.js` is cited only by historical discarded requirement rows; the active Wave 2 gate uses `test/test-embedding-removal-compat-contract.js`.

The verified `CON-ARCH-007` architecture gate retains historical predecessor links because SpecKiwi denies granular edits of verified requirements. New links point to `FR-APP-013`, `DR-APP-003`, and `SEC-APP-004` as the current gate. Its AC-9 requires reading active non-discarded requirements dynamically, and AC-10 treats discarded dependencies as cleanup items. `speckiwi validate --json` reports 0 errors and 8 warnings: `SRS-W015` six times for historical Completed Work Log rows (including the two newly discarded requirements), and pre-existing `SRS-W073` twice for the rules-version constant. Active target summary reports 0 stability blockers and 0 stability warnings. `speckiwi sync-index --dry-run --json` reports no operations; status/type rollups were already updated by the CLI mutations.

Two independent SRS/code reviews passed with LOW evidence/status accuracy items. The compatibility contract now executes the actual product `sanitizeSettingsPayload` function on a legacy secret/activation fixture and asserts that the Settings payload retains only the unrelated theme. `DR-APP-003` VE-1 therefore covers AC-4; VE-2 was narrowed to AC-1/2/3, which its S24 Node fixture checks. At the final hash, prepared R3 Node S24 passed 28 assertions and Electron S24 passed 3; the removal compatibility, indexing-only poller, Wave 2 MCP, and MCP tool parity contracts passed. `speckiwi validate --json` reports 0 errors, the same 8 historical/pre-existing warnings (`SRS-W015` ×6, `SRS-W073` ×2), and no stability blockers or warnings. `sync-index --dry-run` reports no operations. No new product behavior or public MCP surface was introduced during SRS reconciliation.
