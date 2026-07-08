# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DocuLight** is a lightweight Markdown document viewer built with Electron. External processes (AI assistants like Claude Desktop) communicate via an MCP (Model Context Protocol) server. The app continues running in the system tray when all windows are closed.

### Key Capabilities
- Desktop Markdown viewer with GitHub-flavored rendering (marked v17 → DOMPurify → highlight.js → Mermaid)
- Merged sidebar: link-based tree + directory tree with linked-node marking
- Multiple viewer windows with cascading positions
- Light/dark theme support with i18n (ko, en, ja, es)
- Tab-based multi-document view (optional, disabled by default)
- PDF export via pdf-lib
- BM25 full-text search across saved documents (Korean + English, wink-bm25-text-search)
- MCP server for external tool integration (stdio + HTTP JSON-RPC)
- Auto-save MCP documents with configurable subdirectory templates
- Git metadata auto-collection (remote, branch, last commit) via projectPath

## Development Commands

```bash
npm start              # Run Electron app
npm run dev            # Development mode (--dev flag)
npm run dev -- locale ja   # Override locale (ko/en/ja/es)
npm run mcp            # Run stdio MCP server standalone (for testing)
npm run bundle:mcp     # ESBuild bundle mcp-server.mjs → mcp-server.bundle.mjs
npm run build:win      # Windows installer (.exe) + Portable
npm run build:mac      # macOS zip (portable, no DMG)
npm run build:linux    # Linux AppImage + .deb
```

```bash
npx playwright test                       # Run all E2E tests
npx playwright test test/doclight.e2e.js  # Run specific test file
node test/test-link-tree.js               # Manual link-parser test
```

E2E tests use Playwright with Electron integration. Tests run serially (`workers: 1`). Config: `playwright.config.js`.

## Architecture

### Main Process (src/main/)

**Entry Point: `index.js`**
- Electron app lifecycle, single instance lock, system tray
- IPC socket server (ndjson over Named Pipe / Unix socket)
- Settings management via `electron-store`
- Locale override: CLI arg `locale <lang>` or `DOCULIGHT_LOCALE` env var

**`window-manager.js`** — BrowserWindow lifecycle, cascading positions (30px offset), navigation history, window state tracking

**`link-parser.js`** — Sidebar tree builder. Two modes: (1) link-based tree from markdown `[text](url)` / `[[wikilink]]` links, (2) directory tree from filesystem. Merges both by marking linked nodes in the directory tree. Constants: `MAX_DIR_FILES = 65535`, `MAX_TREE_FILES = 65535`, `MAX_DEPTH = 10`.

**`strings.js`** — i18n system. Loads `src/locales/{locale}.json` after `app.isReady()`. Supported: `ko`, `en`, `ja`, `es`. Falls back to `en`.

**`mcp-server.mjs`** (ESM) — Standalone stdio MCP server. Connects to Electron via IPC socket. Uses `@modelcontextprotocol/sdk` + Zod validation. Bundled to `mcp-server.bundle.mjs` via ESBuild for packaging.

**`mcp-http.mjs`** (ESM) — HTTP JSON-RPC 2.0 MCP server embedded in Electron main process. No external SDK. Loaded via dynamic `import()` from `index.js` (CJS→ESM bridge). Writes bound port to `{userData}/mcp-port` on startup.

**`frontmatter.js`** — YAML frontmatter injection utility (CJS). Shared by MCP servers and window-manager. Includes `parseFrontmatter()` for extracting frontmatter from content. Supports `docType` classification (10 types: note, plan, report, completion, issue, review, log, reference, guide, spec).

**`git-info.js`** — Git metadata collector (CJS). When `projectPath` is provided and `mcpGitInfo` setting is enabled, collects `gitRemote`, `gitBranch`, `gitLastCommit` via git CLI commands. 5-second timeout per command, safe-fail.

**`mcp-save.js`** — Auto-save manager for MCP documents (CJS). Handles `saveMcpFile()` (auto) and `mcpManualSave()` (manual). Subdirectory templating with tokens: `{yyyy-mm-dd}`, `{HH}`, `{MM}`, `{ss}`, `{project}`, `{severity}`, `{type}`.

**`search-engine.js`** — BM25 full-text search engine (CJS). Uses `wink-bm25-text-search` with Korean composite tokenizer.

**`tokenizer.js`** — Korean + English composite tokenizer (CJS). Three-layer approach: word split, Korean suffix removal, character bi-gram.

**`file-association.js`** — Windows `.md` ProgID registration (`DocuLight.Markdown`). Packaged apps only.

**`preload.js`** — `contextBridge` API (`window.doclight`) between main and renderer.

### Renderer Process (src/renderer/)

| Module | Purpose |
|--------|---------|
| `viewer.html/js/css` | Main viewer: markdown rendering pipeline, sidebar, themes, context menu |
| `settings.html/js/css` | Settings editor UI |
| `tab-manager.js` | Tab-based multi-document view |
| `sidebar-search.js` | Sidebar file search/filter |
| `pdf-export-ui.js` | PDF export modal (IIFE module, initialized after DOM load) |
| `image-resolver.js` | Relative image path resolution via IPC (file:// → data URI) |
| `lib/` | Vendored: marked v17, DOMPurify, highlight.js, mermaid |

### Rendering Pipeline (viewer.js)

1. **Parse**: `marked.parse(body)` — marked v17 does NOT generate heading IDs
2. **Sanitize**: `DOMPurify.sanitize(html, { USE_PROFILES: {html: true}, ADD_TAGS: ['details','summary'], ADD_ATTR: ['open'] })`
3. **Insert**: `contentEl.innerHTML = cleanHtml`
4. **Heading IDs**: Auto-generate slug-based IDs for all `h1`–`h6` (supports CJK characters)
5. **Images**: Resolve local `file://` URLs to data URIs via IPC
6. **Mermaid**: Render mermaid diagrams
7. **Highlight**: `hljs.highlightElement()` on all `pre code` blocks
8. **TOC**: Build table of contents from headings

### IPC Communication

**Protocol**: ndjson over Named Pipe (Windows) or Unix socket (macOS/Linux)

| Platform | Path |
|----------|------|
| Windows | `\\.\pipe\doculight-ipc` |
| macOS/Linux | `/tmp/doculight-ipc.sock` |

**Request**: `{"id": "unique-id", "action": "open"|"update"|"close"|"list", "params": {...}}`
**Response**: `{"id": "unique-id", "result": {...}}` or `{"id": "unique-id", "error": {"message": "..."}}`

### Security Model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- DOMPurify sanitization + CSP meta tag in all HTML
- `shell.openExternal` limited to `http://` and `https://` only
- Unix socket: `0o600` permissions

## MCP Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `open_markdown` | `content` OR `filePath`, `title`, `size` (s/m/l/f), `foreground`, `alwaysOnTop`, `windowName`, `severity`, `tags`, `flash`, `progress` (-1~1.0), `autoCloseSeconds`, `project`, `docName`, `description`, `docType`, `projectPath`, `noSave` | Open or upsert named viewer window |
| `update_markdown` | `windowId`, `content` OR `filePath`, `title`, `appendMode`, `separator`, `severity`, `tags`, `flash`, `progress`, `autoCloseSeconds`, `project`, `docName`, `description`, `docType`, `projectPath` | Update existing window content and/or metadata |
| `close_viewer` | `windowId` (optional), `tag` (optional) | Close specific window, all windows with tag, or all windows |
| `list_viewers` | `tag` (optional) | List open windows; filter by tag |
| `search_documents` | `query` (required), `limit` (optional, default 20), `project` (optional) | BM25 full-text search across saved documents. Requires mcpAutoSave enabled. |
| `search_projects` | `query` (optional), `limit` (optional, default 20) | Search or list projects from saved document frontmatter metadata. |

MCP tools operate at the **window level**. `open_markdown` upserts if `windowName` already exists; otherwise creates a new window. `windowId` refers to a `BrowserWindow` ID, not a tab.

### Frontmatter Metadata

`open_markdown` and `update_markdown` accept optional frontmatter metadata:

| Parameter | Type | Description |
|-----------|------|-------------|
| `project` | `string` | Project name |
| `docName` | `string` | Document name/identifier |
| `description` | `string` | Brief description |
| `docType` | `string` | One of: note, plan, report, completion, issue, review, log, reference, guide, spec |
| `projectPath` | `string` | Absolute project directory path — triggers git metadata collection if `mcpGitInfo` enabled |

When provided, the MCP server auto-assembles a YAML frontmatter block. A `date` field (ISO 8601) is automatically added. If `projectPath` is provided and `mcpGitInfo` is enabled, `gitRemote`, `gitBranch`, and `gitLastCommit` are injected.

**IMPORTANT — open_markdown call guidelines:**
- Always provide `project`, `docName`, `description`, and `docType` when the context is known.
- These are optional for backward compatibility, but strongly recommended for all new calls.

### MCP Client Configuration (Claude Desktop)

```json
{
  "mcpServers": {
    "doclight": {
      "command": "node",
      "args": ["C:\\path\\to\\DocuLightViewer\\src\\main\\mcp-server.mjs"]
    }
  }
}
```

## Key Dependencies

### Production
- `@modelcontextprotocol/sdk` ^1.12.1 — MCP stdio server
- `electron-store` ^8.2.0 — Settings persistence
- `pdf-lib` ^1.17.1 — PDF export
- `wink-bm25-text-search` ^3.1.2 — BM25 full-text search engine

Note: `marked`, `DOMPurify`, `highlight.js`, `mermaid` are **vendored bundles** in `src/renderer/lib/`, not npm imports.

### Development
- `electron` ^33.4.0
- `electron-builder` ^25.1.8
- `@playwright/test` ^1.58.2

## Settings (electron-store)

Config location: `%APPDATA%\doclight\config.json` (Windows) / `~/Library/Application Support/doclight/config.json` (macOS)

| Setting | Default | Range/Options | Description |
|---------|---------|---------------|-------------|
| `theme` | `light` | `light`, `dark` | UI color theme |
| `fontSize` | `16` | 8–32 | Base font size (px) |
| `fontFamily` | `system-ui, -apple-system, sans-serif` | string | Font stack |
| `codeTheme` | `github` | `github`, `monokai`, `dracula` | Syntax highlight theme |
| `mcpPort` | `52580` | 1024–65535 | HTTP MCP server port |
| `defaultWindowSize` | `auto` | `auto`, `s`, `m`, `l`, `f` | Default window size |
| `lastWindowBounds` | `{}` | object | Saved window position/size |
| `fileAssociation` | `false` | boolean | `.md` file association registered |
| `autoRefresh` | `true` | boolean | Auto-refresh on file change |
| `enableTabs` | `false` | boolean | Tab-based multi-document view |
| `recentFiles` | `[]` | string[] | Recently opened files (max 7) |
| `mcpAutoSave` | `false` | boolean | Auto-save MCP documents to disk |
| `mcpAutoSavePath` | `''` | string | Base directory for auto-saved files |
| `mcpSaveSubDir` | `'{yyyy-mm-dd}'` | string | Subdirectory template with tokens |
| `mcpGitInfo` | `true` | boolean | Auto-collect git info for MCP documents |
| `lastSaveAsDirectory` | `''` | string | Last "Save As" directory |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` / `Cmd+B` | Toggle sidebar |
| `Ctrl+Shift+F` / `Cmd+Shift+F` | Toggle sidebar file search |
| `Ctrl+=` / `Cmd+=` | Zoom in |
| `Ctrl+-` / `Cmd+-` | Zoom out |
| `Ctrl+0` / `Cmd+0` | Reset zoom |
| `Alt+Left` / `Ctrl+Left` | Navigate back |
| `Alt+Right` / `Ctrl+Right` | Navigate forward |
| `Ctrl+F` / `Cmd+F` | Find in page |
| `Ctrl+W` / `Cmd+W` | Close tab or window |
| `Ctrl+T` / `Cmd+T` | Open new tab (tabs enabled) |
| `Ctrl+P` / `Cmd+P` | PDF export modal |
| `Escape` | Close PDF modal → Exit sidebar search → Release always-on-top |

## Development Workflow

### Code Changes

| Change type | Action required |
|-------------|-----------------|
| `src/main/*.js`, `src/main/*.mjs` | Restart Electron |
| `src/main/preload.js` | Restart Electron |
| `src/renderer/*.js`, `*.css`, `*.html` | Reload window (Ctrl+R) |

### CJS vs ESM

- Main process files (`.js`): CommonJS — Electron defaults to CJS
- MCP server files (`.mjs`): ESM — `@modelcontextprotocol/sdk` requires ESM

### Adding a New MCP Tool

1. Add tool definition in `mcp-server.mjs` → `mcpTools` array (with Zod schema)
2. Implement handler in the switch statement
3. Add IPC action handler in `index.js` → `handleIpcRequest()`
4. Mirror in `mcp-http.mjs` if HTTP support needed
5. Update the MCP Tools table in this file

### Updating Settings Schema

1. Add default in `index.js` → `store = new Store({ schema: ... })`
2. Update settings UI in `settings.html` + `settings.js`
3. Update the Settings table in this file

### Adding i18n Keys

All 4 locale files must be updated simultaneously: `src/locales/{ko,en,ja,es}.json`

## Important Conventions

### Git Workflow

**NEVER commit or push changes without explicit user instruction.**
- Wait for user to say "커밋" or "commit" before creating commits
- Wait for user to say "푸시" or "push" before pushing to remote

### Process Safety

**NEVER use `taskkill /F /IM node.exe` or `taskkill /F /IM electron.exe`.**
- These kill ALL Node.js/Electron processes including the current Claude Code session
- Instead: Close via system tray → Quit, or Ctrl+C in terminal

### Rendering Quirks

- **marked v17** does not generate heading IDs — viewer.js Step 3a adds slug-based IDs post-render
- **DOMPurify** with `USE_PROFILES: {html: true}` preserves `id` attributes but strips custom data attributes
- **pdf-export-ui.js** `init()` must not depend on elements outside the modal — the export trigger button may not exist in HTML

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

Current work status workflow:
1. Read the active target with MCP `get_active_target`, or CLI `speckiwi active-target --json` if MCP is unavailable.
2. If `activeTarget` is empty, report that no active target is set and ask which target to use before making target-scoped changes.
3. Read `summary.countsByStatus`, `summary.countsByStability`, `summary.stabilityBlockers`, `summary.stabilityWarnings`, and `summary.newWorkCandidates` before selecting work.
4. Read open work with MCP `list_requirements` for `status=in_progress`, `status=blocked`, and `status=implemented`; CLI fallback is `speckiwi list --status <status> --json`.
5. Check missing verification evidence through `summary` or MCP `summarize_target` before saying work is complete.
6. Read recent completed work with MCP `list_completed_work`; CLI fallback is `speckiwi completed-work --json`.

Completed Work Log is a read-only summary for agents. Requirement Block status, Acceptance Criteria, Verification Evidence, and Change Notes remain the source of truth for completion.

<!-- /SpecKiwi SRS 워크플로 -->
