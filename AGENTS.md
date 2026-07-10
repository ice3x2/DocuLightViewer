# SpecKiwi SRS 워크플로 v1.3

This repository uses `docs/spec/` as the required source of truth for requirements.

Before making any code, test, CLI, MCP, or documentation change, agents MUST:
1. Read `docs/spec/00.index.md`.
2. Find the relevant Requirement ID in the scope SRS files.
3. Mention the Requirement ID in the work summary.
4. If no matching requirement exists, stop and ask whether to create/update an SRS requirement first.

Requirement metadata has two separate lifecycle fields:
- `Status` tracks implementation and verification progress.
- `Stability` tracks requirement maturity and change-control maturity.

Agents MUST stop before implementing a non-discarded requirement with `Stability=draft` or `Stability=deprecated` unless the user explicitly overrides that workflow.

TDD principle:
- Agents MUST follow TDD for behavior changes: write or update a failing automated test for the relevant Requirement ID before implementation, make the smallest change to pass, then refactor while keeping tests green.
- If no meaningful automated test can be written, agents MUST stop before implementation and explain the exception and alternative verification evidence.

Agents MUST NOT:
- Implement behavior that is not covered by an SRS requirement.
- Create an alternate requirements source outside `docs/spec/`.
- Change requirement IDs manually.
- Mark requirements as verified without evidence.
- Introduce or invoke bulk-archive / bulk-finalize tooling that flips multiple requirements to `verified` or empties Active Target without per-requirement evidence and stability gate checks.

When SpecKiwi MCP tools are available, agents MUST use them for requirement lookup and safe SRS updates. If MCP is unavailable, use the `speckiwi` CLI.

Embedding model test information:
- For embedding model tests, read `model-api.txt` in the repository root.
- `model-api.txt` is intentionally gitignored and may contain local endpoint/model settings.
- Do not hard-code these values into committed code, tests, or SRS documents unless the user explicitly asks for a requirement/config change.

Multilingual / i18n guidance:
- DocuLight supports `ko`, `en`, `ja`, and `es`; keep user-visible UI text in `src/locales/*.json` instead of hard-coding strings in main, preload, or renderer code.
- When adding or renaming a locale key, update every supported locale file together. English fallback is a safety net, not a reason to leave missing translations.
- Use the existing `src/main/strings.js` loading/fallback flow, `DOCULIGHT_LOCALE`, and `locale <lang>` override behavior; do not introduce a separate localization mechanism.
- Renderer-facing text should come through the existing strings payload/API, and accessibility labels, titles, tooltips, errors, and status messages should be localized when they are user-visible.
- Relevant SRS requirements: `FR-APP-006`, `FR-APP-007`, and `IR-APP-005`.

Feature roadmap notes:
- Retrieval evaluation set is a future smart_search quality roadmap item related to `FR-DOC-025`. Before implementing it as code, tests, CLI, MCP behavior, or product documentation, create or update a dedicated SRS requirement if the active target does not already cover it.
- The intended retrieval evaluation set should include Korean and mixed-language gold queries, expected document or chunk relevance labels, category/documentTags/link-filter cases, and metrics such as Recall@20, NDCG@20, MRR, filter accuracy, and latency.
- The evaluation should compare BM25-only, garu-ko BM25, embedding-only, and hybrid smart_search modes without changing the existing `search_documents` compatibility contract.
- Document-only MCP save is a future workflow/roadmap item related to `IR-MCP-001`, `IR-MCP-013`, `FR-DOC-001`, and `FR-DOC-019`. Some callers may want to save Markdown into the configured document store and indexing pipeline without showing or focusing a DocuLight viewer window.
- Before implementing or changing document-only save behavior, verify the existing parameter name and semantics in source and SRS. If the active SRS does not explicitly cover the parameter, add or update a dedicated requirement first.
- Document-only save must preserve the same frontmatter, auto-save path, post-save indexing, redaction, and transport parity guarantees as viewer-backed `open_markdown`/`update_markdown`, while avoiding unintended visible window state changes unless explicitly requested.

Current work status workflow:
1. Read the active target with MCP `get_active_target`, or CLI `speckiwi active-target --json` if MCP is unavailable.
2. If `activeTarget` is empty, report that no active target is set and ask which target to use before making target-scoped changes.
3. Read `summary.countsByStatus`, `summary.countsByStability`, `summary.stabilityBlockers`, `summary.stabilityWarnings`, and `summary.newWorkCandidates` before selecting work.
4. Read open work with MCP `list_requirements` for `status=in_progress`, `status=blocked`, and `status=implemented`; CLI fallback is `speckiwi list --status <status> --json`.
5. Check missing verification evidence through `summary` or MCP `summarize_target` before saying work is complete.
6. Read recent completed work with MCP `list_completed_work`; CLI fallback is `speckiwi completed-work --json`.

Completed Work Log is a read-only summary for agents. Requirement Block status, Acceptance Criteria, Verification Evidence, and Change Notes remain the source of truth for completion.

<!-- /SpecKiwi SRS 워크플로 -->
