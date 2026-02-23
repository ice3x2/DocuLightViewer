# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DocuLight** is a lightweight Markdown document viewer built with Electron. External processes (AI assistants like Claude Desktop) communicate via an MCP (Model Context Protocol) server. The app continues running in the system tray when all windows are closed.

### Key Capabilities
- Desktop Markdown viewer with GitHub-flavored rendering (marked → DOMPurify → highlight.js → Mermaid)
- Link-based sidebar navigation (auto-generated from markdown links)
- Multiple viewer windows with cascading positions
- Light/dark theme support with i18n (ko, en, ja, es)
- Navigation history (back/forward buttons)
- Tab-based multi-document view (optional, disabled by default)
- PDF export via pdf-lib
- MCP server for external tool integration (stdio + HTTP JSON-RPC)

## Development Commands

```bash
npm start              # Run Electron app
npm run dev            # Development mode (--dev flag)
npm run dev -- locale ja   # Override locale (ko/en/ja/es)
npm run mcp            # Run stdio MCP server standalone (for testing)
npm run build:win      # Windows installer (.exe)
npm run build:mac      # macOS DMG
npm run build:linux    # Linux AppImage
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

**`link-parser.js`** — Recursive markdown link parser building sidebar tree. Supports `[text](url)` and `[[wikilink]]`. Uses synchronous file I/O; recursion depth-limited.

**`strings.js`** — i18n system. Loads `src/locales/{locale}.json` after `app.isReady()`. Supported: `ko`, `en`, `ja`, `es`. Falls back to `en`.

**`mcp-server.mjs`** (ESM) — Standalone stdio MCP server. Connects to Electron via IPC socket. Uses `@modelcontextprotocol/sdk` + Zod validation.

**`mcp-http.mjs`** (ESM) — HTTP JSON-RPC 2.0 MCP server embedded in Electron main process. No external SDK. Loaded via dynamic `import()` from `index.js` (CJS→ESM bridge). Writes bound port to `{userData}/mcp-port` on startup.

**`file-association.js`** — Windows `.md` ProgID registration (`DocuLight.Markdown`). Packaged apps only.

**`preload.js`** — `contextBridge` API (`window.doclight`) between main and renderer.

### Renderer Process (src/renderer/)

| Module | Purpose |
|--------|---------|
| `viewer.html/js/css` | Main viewer: markdown rendering pipeline, sidebar, themes |
| `settings.html/js/css` | Settings editor UI |
| `tab-manager.js` | Tab-based multi-document view |
| `sidebar-search.js` | Sidebar file search/filter |
| `pdf-export-ui.js` | PDF export modal |
| `image-resolver.js` | Relative image path resolution |
| `lib/` | Vendored: marked v17, DOMPurify, highlight.js, mermaid |

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
| `open_markdown` | `content` OR `filePath`, `title`, `size` (s/m/l/f), `foreground`, `alwaysOnTop`, `windowName`, `severity` (info/success/warning/error), `tags` (string[]), `flash`, `progress` (-1~1.0), `autoCloseSeconds` (1~3600) | Open or upsert named viewer window |
| `update_markdown` | `windowId`, `content` OR `filePath`, `title`, `appendMode`, `separator`, `severity`, `tags`, `flash`, `progress`, `autoCloseSeconds` | Update existing window content and/or metadata |
| `close_viewer` | `windowId` (optional), `tag` (optional) | Close specific window, all windows with tag, or all windows |
| `list_viewers` | `tag` (optional) | List open windows; filter by tag; shows windowName, severity, tags, progress |

MCP tools operate at the **window level**. `open_markdown` upserts if `windowName` already exists; otherwise creates a new window. `windowId` refers to a `BrowserWindow` ID, not a tab.

### WindowEntry.meta New Fields (Step 19)

| Field | Type | Description |
|-------|------|-------------|
| `windowName` | `string\|null` | Named window key for upsert |
| `tags` | `string[]` | Window tags for grouping |
| `severity` | `string\|null` | Severity theme: info/success/warning/error |
| `autoCloseTimer` | `Timeout\|undefined` | Auto-close timer handle |
| `autoCloseSeconds` | `number\|undefined` | Auto-close duration in seconds |
| `progress` | `number\|undefined` | Taskbar progress value (-1~1.0) |
| `lastRenderedContent` | `string\|undefined` | Last rendered content for append mode |

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

## Directory Structure

```
src/
├── main/
│   ├── index.js          # Entry point + IPC socket server
│   ├── preload.js        # contextBridge API
│   ├── window-manager.js # Window lifecycle + cascading
│   ├── link-parser.js    # Markdown link parser + sidebar tree
│   ├── strings.js        # i18n loader
│   ├── file-association.js # .md file association (Windows, packaged only)
│   ├── mcp-server.mjs    # MCP stdio bridge (ESM)
│   └── mcp-http.mjs      # MCP HTTP JSON-RPC bridge (ESM)
├── renderer/
│   ├── viewer.{html,js,css}   # Main viewer
│   ├── settings.{html,js,css} # Settings UI
│   ├── tab-manager.js
│   ├── sidebar-search.js
│   ├── pdf-export-ui.js
│   ├── image-resolver.js
│   └── lib/              # Vendored libraries
└── locales/
    ├── en.json           # English (default fallback)
    ├── ko.json
    ├── ja.json
    └── es.json
```

## Key Dependencies

### Production
- `@modelcontextprotocol/sdk` ^1.12.1 — MCP stdio server
- `electron-store` ^8.2.0 — Settings persistence
- `pdf-lib` ^1.17.1 — PDF export

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

## Important Conventions

### Git Workflow

**NEVER commit or push changes without explicit user instruction.**
- Wait for user to say "커밋" or "commit" before creating commits
- Wait for user to say "푸시" or "push" before pushing to remote

### Process Safety

**NEVER use `taskkill /F /IM node.exe` or `taskkill /F /IM electron.exe`.**
- These kill ALL Node.js/Electron processes including the current Claude Code session
- Instead: Close via system tray → Quit, or Ctrl+C in terminal
