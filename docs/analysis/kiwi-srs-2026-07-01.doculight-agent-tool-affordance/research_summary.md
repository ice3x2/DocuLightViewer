---
title: DocuLight agent-facing MCP tool affordance research
docType: report
project: DocuLightViewer
target: 0.11.0-w2
date: 2026-07-01
status: researched
relatedRequirements: IR-MCP-018, CON-MCP-007, FR-DOC-028, FR-DOC-025, SEC-DOC-003, CON-DOC-006, DR-DOC-013
---

# DocuLight agent-facing MCP tool affordance research

## Summary

Three read-only research agents independently found that the current Wave 2 SRS already covers strict eight-tool parity, canonical JSON envelopes, redaction, and the no-indexing-control boundary. The missing layer is client-profile and model-size conformance: small local models need self-routing names, short descriptions, strict enums, and corrective errors; frontier models need hard boundaries that prevent invented orchestration such as recursive import, force reindex, job polling, or large diagnostics.

The recommended SRS change is a new MCP constraint layered on `IR-MCP-018` and `CON-MCP-007`, not a new MCP tool. Wave 2 should remain exactly eight MCP tools.

## Research Inputs

- MCP official tools spec treats `name`, `description`, and `inputSchema` as the discoverable tool contract and supports `content[]` responses with `isError`.
- Claude Code uses MCP tool search by default, warns for large MCP output, and supports both local stdio and remote HTTP/SSE-style servers.
- OpenCode and Hermes-style clients can configure MCP servers and may project tools into different agent/tool-call surfaces.
- Existing DocuLight SRS already fixes `save_document` and `smart_search` names, strict schemas, default limit 20, hard max 50, `content[0].text` canonical JSON, redaction, degraded responses, and no MCP indexing-control tools.
- Existing DocuLight broken-link requirements already define unresolved Markdown links as non-blocking diagnostic graph edges. Agent-facing MCP conformance should preserve that policy: broken links may appear only as redacted diagnostic counts/codes or explicit diagnostics, and only resolved edges may influence link ranking or `linkedTo`/`linkedFrom` filters.

## Consolidated SRS Direction

Add one MCP constraint requiring deterministic client-profile conformance fixtures:

1. Keep exactly eight tools: existing six plus `save_document` and `smart_search`.
2. Make tool descriptions self-routing, compact, and front-loaded with “use this / do not use this” intent discriminators.
3. Use a portable JSON Schema subset for `save_document` and `smart_search` so schema readers in small and frontier clients can project the tools consistently.
4. Keep `content[0].text` canonical JSON as the only required parse target. `structuredContent` or `outputSchema` may be added later only if text JSON remains compatible.
5. Keep default outputs compact and bounded: `smart_search.limit=20`, max 50, diagnostics/trace/scores default false, bounded snippets and warnings, no full Markdown echo.
6. Make validation failures corrective but redacted: name the field, code, expected location/value class, and safe hint, but never echo raw path-like or credential-bearing values.
7. Test client profiles without live external clients or live embedding providers by using normalized tool-selection prompts, schema projection, and mocked/degraded provider states.
8. Treat broken links as first-class diagnostic state, not as save/index/search failure. `smart_search` fixtures should distinguish resolved-link search behavior from broken-link diagnostics and verify that raw href/path values are never echoed.

## Over-engineering To Avoid

- Do not add vendor-specific client adapters.
- Do not run live multi-vendor LLM benchmarks as release gates.
- Do not add alias tools such as `save_markdown`, `remember_document`, or `semantic_search`.
- Do not add MCP tools or fields for recursive import, reindex, rebuild, retry, cancel, status, model change, or link reconciliation.
- Do not replace `search_documents` with semantic behavior.
- Do not make verbose diagnostics the default.

## Proposed Requirement

`CON-MCP-008 — Wave 2 MCP tools are self-routing and client-profile compatible for small-to-frontier agents`

This requirement should depend on `IR-MCP-018`, `CON-MCP-007`, `FR-DOC-028`, `FR-DOC-025`, `SEC-DOC-003`, `CON-DOC-006`, and `DR-DOC-013`.
