# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DocLight** is a lightweight Markdown document viewer built with Electron. It provides a desktop application for viewing Markdown files with GitHub-flavored rendering, Mermaid diagram support, and a link-based sidebar navigation. External processes (AI assistants like Claude Desktop) communicate with DocLight via an MCP (Model Context Protocol) server.

### Key Capabilities
- Desktop Markdown viewer with GitHub-flavored rendering
- Link-based sidebar navigation (auto-generated from markdown links)
- Mermaid diagram support
- Multiple viewer windows with cascading positions
- Light/dark theme support
- Navigation history (back/forward buttons)
- System tray integration
- MCP server for external tool integration
- Settings UI with electron-store persistence
- Keyboard shortcuts for common actions

## Development Commands

### Running the Application

```bash
npm start          # Run Electron app
npm run dev        # Development mode (--dev flag)
npm run mcp        # Run stdio MCP server standalone (for testing)
```

The application runs as a desktop app with system tray integration. Closing all windows does not quit the app.

### Testing

```bash
npx playwright test                    # Run all E2E tests
npx playwright test test/doclight.e2e.js  # Run specific test file
node test/test-link-tree.js            # Manual link-parser test script
```

E2E tests use Playwright with Electron integration. Tests run serially (`workers: 1`). Config: `playwright.config.js`.

### Building for Distribution

```bash
npm run build        # Build for current platform
npm run build:win    # Windows installer (.exe)
npm run build:mac    # macOS DMG
npm run build:linux  # Linux AppImage
```

## Architecture

### Main Process (src/main/)

**Entry Point: src/main/index.js**
- Electron app lifecycle management
- Single instance lock (`requestSingleInstanceLock()`)
- System tray integration (app continues running when all windows closed)
- IPC socket server (ndjson over Named Pipe on Windows, Unix socket on macOS/Linux)
- Settings management via electron-store
- Graceful shutdown on `before-quit` event

**Window Manager: src/main/window-manager.js**
- BrowserWindow lifecycle management
- Cascading window positions (offset by 30px)
- Navigation history (back/forward)
- Window state tracking (size, position, alwaysOnTop)
- Content loading from strings or file paths

**Link Parser: src/main/link-parser.js**
- Recursive markdown link parser
- Tree builder for sidebar navigation
- Supports both `[text](url)` and `[[wikilink]]` formats
- Configurable recursion depth limit
- Synchronous file operations for simplicity

**MCP Bridge (stdio): src/main/mcp-server.mjs**
- Standalone stdio-based MCP server (ESM module)
- Connects to Electron app via IPC socket
- Implements 4 MCP tools: `open_markdown`, `update_markdown`, `close_viewer`, `list_viewers`
- Uses `@modelcontextprotocol/sdk` for protocol handling
- Zod schema validation for tool parameters

**MCP Bridge (HTTP): src/main/mcp-http.mjs**
- HTTP JSON-RPC 2.0 MCP server embedded directly in Electron main process
- No external SDK dependency — raw JSON-RPC over HTTP POST
- Loaded via dynamic `import()` from index.js (CJS→ESM bridge)
- Same 4 MCP tools as stdio server but callable via HTTP

**File Association: src/main/file-association.js**
- Platform-specific `.md` file association management
- Registers/unregisters ProgID `DocuLight.Markdown` on Windows
- Only works in packaged (built) apps, not in development mode
- Initialized with electron-store instance

**Preload: src/main/preload.js**
- contextBridge API (`window.doclight`) between main and renderer processes
- Listeners (Main→Renderer): `onRenderMarkdown`, `onUpdateMarkdown`, `onSidebarTree`, `onSidebarHighlight`, `onThemeChanged`, `onSettingsChanged`, `onEmptyWindow`, `onAlwaysOnTopChanged`, `onPanelVisibility`
- Senders (Renderer→Main): `navigateTo`, `navigateBack`, `navigateForward`, `openExternal`, `notifyReady`, `zoomIn`, `zoomOut`, `zoomReset`, `releaseAlwaysOnTop`, `toggleAlwaysOnTop`, `setAlwaysOnTop`, `fileDropped`, `getFilePath`
- Settings: `getSettings`, `saveSettings`, `registerFileAssociation`, `unregisterFileAssociation`, `getFileAssociationStatus`, `openDefaultAppsSettings`

### Renderer Process (src/renderer/)

**Markdown Viewer (viewer.html, viewer.js, viewer.css)**
- Markdown rendering pipeline: marked → DOMPurify → syntax highlighting (highlight.js) → Mermaid
- Sidebar with link tree navigation
- Content scrolling with smooth scroll behavior
- Theme support (light/dark)
- Keyboard shortcuts (zoom, navigation, find, sidebar toggle)
- External link handling via `shell.openExternal`

**Settings UI (settings.html, settings.js, settings.css)**
- Form-based settings editor
- electron-store integration
- Real-time validation (ranges for numeric values)
- Reset to defaults functionality
- Apply/Cancel/Reset buttons

**Vendored Libraries (src/renderer/lib/)**
- marked.min.js (v17.0.1) — Markdown parsing
- purify.min.js (DOMPurify) — XSS protection
- highlight.min.js + theme CSS files (github, github-dark, monokai, dracula) — Syntax highlighting
- mermaid.min.js — Diagram rendering

### IPC Communication

**Protocol**: ndjson (newline-delimited JSON) over Named Pipe (Windows) or Unix socket (macOS/Linux)

**Endpoints**:
- Windows: `\\.\pipe\doclight-ipc`
- macOS/Linux: `/tmp/doclight-ipc.sock`

**Request Format**:
```json
{"id": "unique-id", "action": "open", "params": {...}}
```

**Response Format**:
```json
{"id": "unique-id", "result": {...}}
{"id": "unique-id", "error": {"message": "error details"}}
```

**Supported Actions**:
- `open`: Open new viewer window
- `update`: Update existing window content
- `close`: Close one or all windows
- `list`: List all open viewer windows

### Security Model

**Electron Security**:
- `contextIsolation: true` — Isolate preload scripts from renderer context
- `nodeIntegration: false` — Disable Node.js in renderer
- `sandbox: true` — Enable Chromium sandbox
- CSP meta tag in all HTML files

**XSS Protection**:
- DOMPurify sanitization before inserting HTML into DOM
- Content Security Policy headers

**External Links**:
- `shell.openExternal` limited to `http://` and `https://` protocols
- Prevents execution of local files or custom protocols

**IPC Socket Permissions**:
- Unix socket: 0o600 (owner read/write only)
- Named Pipe: Default Windows ACL

## MCP Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `open_markdown` | `content` OR `filePath`, `title`, `size` (s/m/l/f), `foreground`, `alwaysOnTop` | Open a new viewer window with markdown content |
| `update_markdown` | `windowId`, `content` OR `filePath`, `title` | Update existing window content and title |
| `close_viewer` | `windowId` (optional) | Close specific window or all windows |
| `list_viewers` | - | List all open viewer windows with IDs and titles |

### MCP Client Configuration

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

Replace path with actual absolute path to `mcp-server.mjs`.

## Directory Structure

```
DocuLightViewer/
├── src/
│   ├── main/
│   │   ├── index.js              # Electron main process entry point
│   │   ├── preload.js            # contextBridge API
│   │   ├── window-manager.js     # Window lifecycle management
│   │   ├── link-parser.js        # Markdown link parser + tree builder
│   │   ├── file-association.js   # Platform .md file association (packaged only)
│   │   ├── mcp-server.mjs        # MCP Bridge — stdio (ESM)
│   │   └── mcp-http.mjs          # MCP Bridge — HTTP JSON-RPC (ESM)
│   └── renderer/
│       ├── viewer.html/js/css    # Markdown viewer page
│       ├── settings.html/js/css  # Settings page
│       └── lib/                  # Vendored libraries
├── test/
│   ├── doclight.e2e.js           # Playwright E2E tests
│   ├── test-link-tree.js         # Manual link-parser test
│   └── fixtures/                 # Test markdown files
├── assets/
│   └── icon.png                  # App icon (256x256)
├── playwright.config.js          # E2E test config
└── package.json
```

## Key Dependencies

### Production Dependencies
- `@modelcontextprotocol/sdk` ^1.12.1 — MCP protocol implementation
- `electron-store` ^8.2.0 — Settings persistence

Note: `marked`, `dompurify`, `highlight.js` are used as vendored bundles in `src/renderer/lib/`, not as npm imports.

### Development Dependencies
- `electron` ^33.4.0 — Desktop app framework
- `electron-builder` ^25.1.8 — Build and packaging tool
- `@playwright/test` ^1.58.2 — E2E testing

## Settings (electron-store)

Stored in JSON format at OS-specific locations:
- Windows: `%APPDATA%\doclight\config.json`
- macOS: `~/Library/Application Support/doclight/config.json`
- Linux: `~/.config/doclight/config.json`

| Setting | Default | Range/Options | Description |
|---------|---------|---------------|-------------|
| `theme` | `light` | `light`, `dark` | UI color theme |
| `fontSize` | `16` | 8-32 | Base font size in pixels |
| `fontFamily` | `system-ui, -apple-system, sans-serif` | string | Font stack for content |
| `codeTheme` | `github` | `github`, `monokai`, `dracula` | Code syntax highlighting theme |
| `mcpPort` | `52580` | 1024-65535 | HTTP MCP server port |
| `fileAssociation` | `false` | boolean | Whether .md file association is registered |

Settings can be modified via:
1. Settings UI (accessible from system tray → Settings)
2. Direct JSON file editing (requires app restart)

## Keyboard Shortcuts

### Window Management
| Shortcut | Action |
|----------|--------|
| `Ctrl+W` / `Cmd+W` | Close current viewer window |
| `Escape` | Release always-on-top mode |

### Sidebar & View
| Shortcut | Action |
|----------|--------|
| `Ctrl+B` / `Cmd+B` | Toggle sidebar visibility |

### Zoom
| Shortcut | Action |
|----------|--------|
| `Ctrl+=` / `Cmd+=` | Zoom in |
| `Ctrl+-` / `Cmd+-` | Zoom out |
| `Ctrl+0` / `Cmd+0` | Reset zoom to 100% |

### Navigation
| Shortcut | Action |
|----------|--------|
| `Alt+Left` / `Ctrl+Left` | Navigate back in history |
| `Alt+Right` / `Ctrl+Right` | Navigate forward in history |

### Search
| Shortcut | Action |
|----------|--------|
| `Ctrl+F` / `Cmd+F` | Find in page |

## Development Workflow

### Code Changes

1. **Main process changes** (`src/main/*.js`, `src/main/*.mjs`) → Restart Electron app
2. **Renderer changes** (`src/renderer/*.js`, `src/renderer/*.css`) → Reload window (Ctrl+R / Cmd+R)
3. **HTML changes** (`src/renderer/*.html`) → Reload window
4. **Preload changes** (`src/main/preload.js`) → Restart Electron app

### Testing MCP Integration

1. Start Electron app: `npm start`
2. In separate terminal, run MCP server: `npm run mcp`
3. Send test requests via stdio (JSON-RPC format)
4. Or configure in Claude Desktop and test via chat

### Debugging

**Main Process**:
- Use `console.log` (output to terminal)
- Or enable Chrome DevTools with `mainWindow.webContents.openDevTools()`

**Renderer Process**:
- Open DevTools in viewer window (Ctrl+Shift+I / Cmd+Option+I)
- Use Console, Network, Elements tabs

**MCP Server**:
- Check stderr output (MCP uses stdout for protocol, stderr for logging)
- Add `console.error()` statements in `mcp-server.mjs`

## Important Conventions

### CJS vs ESM

- **Main process files** (`src/main/index.js`, `window-manager.js`, etc.): Use CommonJS (`.js` extension)
  - Reason: Electron defaults to CJS, simpler for most main process code
- **MCP server** (`src/main/mcp-server.mjs`): Use ESM (`.mjs` extension)
  - Reason: `@modelcontextprotocol/sdk` requires ESM

### Git Workflow

**NEVER commit or push changes without explicit user instruction.**
- Wait for user to say "커밋" or "commit" before creating commits
- Wait for user to say "푸시" or "push" before pushing to remote

### Process Safety

**NEVER use `taskkill /F /IM node.exe` or `taskkill /F /IM electron.exe`** to kill processes.
- These commands kill ALL Node.js/Electron processes including Claude Code itself
- This will terminate the current Claude Code session
- Instead: Close app via system tray → Quit, or use Ctrl+C in terminal

### File Operations

**Link Parser**: Uses synchronous file operations (`fs.readFileSync`) for simplicity.
- Link parsing is CPU-bound, not I/O-bound
- Recursion depth limit prevents stack overflow
- Tree building happens once per window open

**Window Manager**: Asynchronous operations for content loading and IPC.

### Single Instance

App uses `requestSingleInstanceLock()` to prevent multiple instances.
- If second instance launched, it activates first instance and exits
- All MCP requests route to single running instance via IPC socket

### System Tray Behavior

App continues running in system tray when all windows closed.
- User must explicitly quit via system tray → Quit
- This allows MCP tools to open new windows even when no windows visible

## Common Development Patterns

### Adding a New MCP Tool

1. Add tool definition in `src/main/mcp-server.mjs` → `mcpTools` array
2. Add Zod schema for parameters
3. Implement handler in switch statement (`case 'tool_name':`)
4. Add IPC action handler in `src/main/index.js` → `handleIpcRequest()`
5. Update this CLAUDE.md file with tool documentation

### Modifying Window Behavior

1. Edit `src/main/window-manager.js` for window lifecycle logic
2. Update `src/main/preload.js` if renderer needs new IPC methods
3. Modify `src/renderer/viewer.js` for renderer-side behavior
4. Update keyboard shortcuts in viewer.js event listeners

### Updating Settings Schema

1. Add new setting in `src/main/index.js` → `initializeSettings()` defaults
2. Add validation range/options
3. Update settings UI in `src/renderer/settings.html` and `settings.js`
4. Document in this CLAUDE.md → Settings table

### Changing Markdown Rendering Pipeline

1. Edit `src/renderer/viewer.js` → `renderMarkdown()` function
2. Modify marked options if changing parser behavior
3. Update DOMPurify config if changing sanitization rules
4. Test with complex markdown (tables, code blocks, mermaid diagrams)

## Testing Strategy

### Manual Testing

1. **Window Management**: Open multiple windows, cascade positions, close individual/all
2. **Content Loading**: Test both string content and file path loading
3. **Navigation**: Back/forward buttons, history state
4. **Settings**: Change each setting, verify persistence after restart
5. **Keyboard Shortcuts**: Test all shortcuts in table above
6. **MCP Tools**: Use Claude Desktop integration to test all 4 tools
7. **Themes**: Switch between light/dark, verify styles

### Test Checklist for MCP Tools

```
[ ] open_markdown with content string
[ ] open_markdown with filePath
[ ] open_markdown with different sizes (s/m/l/f)
[ ] open_markdown with foreground: true/false
[ ] open_markdown with alwaysOnTop: true/false
[ ] update_markdown on existing window
[ ] update_markdown with new title
[ ] close_viewer with specific windowId
[ ] close_viewer without windowId (close all)
[ ] list_viewers with 0, 1, 3+ windows open
```

### Known Limitations

1. **File Watching**: No auto-refresh when markdown files change on disk
2. **Search**: Basic browser find-in-page, no full-text search across documents
3. **Export**: No PDF export yet (puppeteer dependency removed)
4. **Collaborative Editing**: Single-user desktop app, no sync

## References and Documentation

- **README.md**: User-facing documentation (if exists)
- **package.json**: Dependencies, scripts, build configuration
- **MCP Protocol**: https://modelcontextprotocol.io/
- **Electron Docs**: https://www.electronjs.org/docs
- **Marked.js**: https://marked.js.org/
- **DOMPurify**: https://github.com/cure53/DOMPurify

## Build Configuration

Uses `electron-builder` for packaging.

**Windows**: NSIS installer (.exe)
**macOS**: DMG disk image
**Linux**: AppImage

Build artifacts output to `dist/` directory (gitignored).

To customize build:
1. Edit `package.json` → `build` section
2. Add icons to `assets/` (icon.png, icon.ico, icon.icns)
3. Run `npm run build:win` / `build:mac` / `build:linux`

## Future Enhancements (Not Implemented)

- PDF export (via headless Chromium)
- File watching and auto-refresh
- Search across all documents
- Tag-based organization
- Graph view of document links
- Collaborative editing with sync
- Cloud storage integration
- Mobile companion app

## Troubleshooting

### App won't start
- Check console for error messages
- Verify `package.json` → `main` points to `src/main/index.js`
- Ensure Node.js version ≥20.0.0 (per package.json engines)

### MCP tools not working
- Verify `mcp-server.mjs` path in Claude Desktop config
- Check IPC socket exists: `/tmp/doclight-ipc.sock` (macOS/Linux) or `\\.\pipe\doclight-ipc` (Windows)
- Ensure Electron app is running before MCP client connects
- Check stderr output from `npm run mcp` for errors

### Settings not persisting
- Check file permissions on config directory
- Verify electron-store initialization in `src/main/index.js`
- Look for errors in console during saveSettings

### Markdown not rendering
- Check browser console for JavaScript errors
- Verify all vendored libraries loaded (Network tab in DevTools)
- Test with simple markdown first (e.g., `# Heading`)
- Check DOMPurify not stripping valid HTML

### Windows overlap instead of cascade
- Check `windowManager.getNextWindowPosition()` logic
- Verify offset calculation (should be 30px per window)
- Look for off-screen window positioning edge cases
