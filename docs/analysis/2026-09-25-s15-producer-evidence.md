# S15 producer integration evidence (partial; #38 open)

Start: `81cfbda20ba53d87335a30ba93289d24c0739104` in isolated `DocuLightViewer-r3`. Active target `0.11.0-w2` has no Stability blockers. Relevant requirements: `FR-DOC-019` in_progress/stable, `FR-DOC-035` implemented/evolving, `IR-MCP-018` verified/stable, `IR-MCP-019` verified/evolving, `REL-DOC-009` planned/evolving, and `SEC-DOC-003` verified/stable.

## Producer call path

| Producer | Durable path now | Observable result |
|---|---|---|
| HTTP `open_markdown`, `update_markdown` | `createToolHandlers` → `saveMcpFile` / `saveMcpUpdatedContent` → `publishMcpSave` → S08 `publishSave` → owner `acceptPublishedSave` | Existing `windowId` response and saved file retained; one owner acceptance per save |
| Source stdio / generated bundle `open_markdown`, `update_markdown` | MCP tool sends existing IPC action → main `handleIpcMessage` → same shared helpers | Existing eight-tool schema and IPC response retained |
| Renderer manual save | Existing IPC → `mcpManualSave` → shared publisher | Existing file path response and window metadata retained |
| Renderer save-as / quick-save within configured store | Registered IPC handler → `saveRendererFile` → shared publisher | Chosen path, file bytes, and response retained |
| Indexed `documentId` open | Existing resolver/viewer path | Read-only; no save, intent, or job (adjacent origin contract test) |

The shared producer derives `contentBytes`, a configured destination locator, `sourceId`, `rootFingerprint`, `contentHash`, and empty original aliases for content-only saves. It does not allocate `desiredRevision`. Publication writes the private body-free intent and atomic final Markdown first; only then does the owner accept. Failed acceptance leaves the final file and intent for retry. No configured-root producer also calls legacy `markDirty`.

## TDD and execution

- First RED: `node test/r3/run-node.cjs --case s15` exited 1 at `content-only open uses durable ingress once` (0 assertions passed) while old open saved a file.
- Renderer IPC RED after a behavior-neutral handler extraction: same command exited 1 at `renderer save-as IPC preserves chosen file and publishes one durable intent` (9 assertions passed).
- External existing path regression RED: same command exited 1 at `existing externally chosen save path remains editable pending S16 registration` (17 assertions passed). The external file remains editable while its registration is deferred.
- Owner-start failure RED: same command exited 1 at `owner unavailable still publishes body-free durable intent and final file without legacy enqueue` (19 assertions passed). The configured-root fallback now uses the S08 publisher and leaves a retryable private intent without calling `markDirty`. An unsafe ingress regression confirms that publication stops before writing the file.
- Temporary Windows read contention RED: same command exited 1 at `temporary Windows reader contention retries atomic replacement without losing latest save` (24 assertions passed). A bounded retry around transient replace errors now preserves the latest update.
- Final Node ABI 137 snapshot root: `C:/Users/beom/AppData/Local/Temp/doculight-r3-node-20260924d`; `s15` exit 0, 25 assertions. Real owner open + two updates produced the same documentId, increasing desiredRevision, committed job IDs, and latest final bytes. SQLite `documents` retained the latest desired revision, hash, and job. `s14` exit 0, 20 assertions.
- `npm run bundle:mcp` exit 0. `node test/test-mcp-tool-parity.js`, `node test/test-mcp-http-save-parity.js`, `node test/test-indexed-origin-open-contract.js`, and `node test/test-opened-markdown-registrar-contract.js` all exited 0. Bundle generation produced no tracked artifact drift.
- Source-only hash for independent review: `014cb0aa845bbb12f6e5cdbfcb3783f4b821d094c06d17ad7cc5a763911d65bc`.

## Open S16 dependency

The configured owner accepts only one publication root, and its keyword index is scoped to that root. Renderer save-as may choose an external location. This change preserves that chosen external file and the legacy `markDirty` path; it does **not** claim an external durable acceptance. S16 #39 must associate that external origin with a separate configured-store copy and publish the copy through the same owner, then remove the legacy external enqueue. Switching owner roots for each save would strand pending jobs and change keyword scope. #38 remains open until this path has end-to-end evidence and independent review.
