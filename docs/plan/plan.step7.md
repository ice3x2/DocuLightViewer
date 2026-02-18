# Step 7: Index File Management & UI Improvements

## Overview

**Objective**: Implement index file management, UI improvements, and full tree structure API

**Core Requirements**:
1. Change default welcome screen to English
2. Support configurable index file paths (absolute or relative to docsRoot)
3. Auto-load index file on startup
4. Sidebar header click navigation to index
5. Index paths for API and MCP documentation
6. Fallback for invalid index paths
7. Full document tree structure API

---

## 1. Configuration Changes

### 1.1 Config Structure

**File**: `config.json5`

**New Fields**:
```json5
{
  docsRoot: "/data/docs",
  apiKey: "your-api-key",
  port: 3000,

  // UI Configuration
  ui: {
    title: "DocuLight",
    icon: "/images/icon.svg",

    // NEW: Index file paths
    indexFile: "/README.md",           // Main docs index (relative to docsRoot)
    apiIndexFile: "/public/api-doc.md", // API docs index (relative to project root or absolute)
    mcpIndexFile: "/public/mcp-doc.md"  // MCP docs index (relative to project root or absolute)
  },

  // Existing fields...
  maxUploadMB: 10,
  excludes: [],
  security: { allows: [] },
  ssl: { enabled: false }
}
```

### 1.2 Path Resolution Rules

**For `ui.indexFile` (main docs)**:
- Absolute path: `/absolute/path/to/index.md`
- Relative path: `README.md` or `/guide/index.md` (relative to docsRoot)
- Default: `null` (no auto-load)

**For `ui.apiIndexFile` and `ui.mcpIndexFile`**:
- Absolute path: `/absolute/path/to/doc.md`
- Relative path: relative to project root
- Default: `/public/api-doc.md` and `/public/mcp-doc.md`

**Path Validation**:
- Check if file exists
- Verify path is within docsRoot (for main docs)
- Verify file has .md extension
- Fallback to default screen if invalid

---

## 2. Config Loader Updates

### 2.1 Enhanced Config Validation

**File**: `src/utils/config-loader.js`

**New Validation**:
```javascript
// Validate UI configuration
if (config.ui) {
  // Validate index file paths
  if (config.ui.indexFile) {
    const indexPath = resolveIndexPath(config.ui.indexFile, config.docsRoot);
    if (indexPath && fs.existsSync(indexPath)) {
      config.ui.resolvedIndexFile = indexPath;
      console.log(`Index file configured: ${config.ui.indexFile}`);
    } else {
      console.warn(`Index file not found: ${config.ui.indexFile}, using default welcome screen`);
      config.ui.resolvedIndexFile = null;
    }
  }

  // Validate API/MCP index files
  if (config.ui.apiIndexFile) {
    const apiIndexPath = resolveDocPath(config.ui.apiIndexFile);
    config.ui.resolvedApiIndexFile = fs.existsSync(apiIndexPath) ? apiIndexPath : null;
  }

  if (config.ui.mcpIndexFile) {
    const mcpIndexPath = resolveDocPath(config.ui.mcpIndexFile);
    config.ui.resolvedMcpIndexFile = fs.existsSync(mcpIndexPath) ? mcpIndexPath : null;
  }
}

function resolveIndexPath(indexPath, docsRoot) {
  if (path.isAbsolute(indexPath)) {
    return indexPath;
  }
  return path.join(docsRoot, indexPath);
}

function resolveDocPath(docPath) {
  if (path.isAbsolute(docPath)) {
    return docPath;
  }
  return path.join(__dirname, '../../', docPath);
}
```

---

## 3. Default Welcome Screen (English)

### 3.1 Update View Template

**File**: `src/views/index.ejs`

**Current (Korean)**:
```html
<div class="welcome">
  <h1>환영합니다</h1>
  <p>좌측 트리에서 Markdown 문서를 선택하여 열람하세요.</p>
</div>
```

**New (English with branding)**:
```html
<div class="welcome">
  <div class="welcome-logo">
    <svg width="80" height="80" viewBox="0 0 24 24">
      <!-- DocuLight icon SVG -->
    </svg>
  </div>
  <h1>Welcome to DocuLight</h1>
  <p class="welcome-subtitle">A lightweight Markdown documentation viewer</p>
  <div class="welcome-actions">
    <div class="welcome-card">
      <h3>📂 Browse Documents</h3>
      <p>Select a file from the sidebar to start reading</p>
    </div>
    <div class="welcome-card">
      <h3>🔍 Quick Start</h3>
      <p>Use Ctrl+K to search, or click any folder to explore</p>
    </div>
    <div class="welcome-card">
      <h3>📖 Documentation</h3>
      <p>
        <a href="/api/doc" target="_blank">API Reference</a> •
        <a href="/mcp/doc" target="_blank">MCP Integration</a>
      </p>
    </div>
  </div>
</div>
```

### 3.2 Welcome Screen CSS

**Enhanced Styling**:
```css
.welcome {
  text-align: center;
  padding: 80px 40px;
  max-width: 900px;
  margin: 0 auto;
}

.welcome-logo {
  margin-bottom: 30px;
  opacity: 0.8;
}

.welcome h1 {
  font-size: 42px;
  font-weight: 600;
  margin-bottom: 12px;
  color: #0366d6;
}

.welcome-subtitle {
  font-size: 18px;
  color: #586069;
  margin-bottom: 50px;
}

.welcome-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 24px;
  margin-top: 40px;
}

.welcome-card {
  background: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 8px;
  padding: 24px;
  text-align: left;
  transition: all 0.2s;
}

.welcome-card:hover {
  border-color: #0366d6;
  box-shadow: 0 4px 12px rgba(3, 102, 214, 0.1);
  transform: translateY(-2px);
}

.welcome-card h3 {
  font-size: 18px;
  margin-bottom: 8px;
  color: #24292e;
}

.welcome-card p {
  font-size: 14px;
  color: #586069;
  line-height: 1.6;
}

.welcome-card a {
  color: #0366d6;
  text-decoration: none;
  font-weight: 500;
}

.welcome-card a:hover {
  text-decoration: underline;
}
```

---

## 4. Auto-Load Index File

### 4.1 Client-Side Implementation

**File**: `public/js/app.js`

**Auto-load Logic**:
```javascript
// On page load
async function initializeApp() {
  try {
    // Load tree
    await loadTree('/');

    // Check if index file is configured
    const indexFile = await checkIndexFile();

    if (indexFile) {
      // Auto-load index file
      console.log('Loading index file:', indexFile);
      await loadFile(indexFile);

      // Expand and highlight in tree
      await expandToFile(indexFile);
    } else {
      // Check last opened file in IndexedDB
      const lastOpened = await getLastOpened();
      if (lastOpened) {
        await loadFile(lastOpened);
        await expandToFile(lastOpened);
      } else {
        // Show welcome screen
        showWelcomeScreen();
      }
    }
  } catch (error) {
    console.error('Initialization error:', error);
    showWelcomeScreen();
  }
}

// Check if index file is configured
async function checkIndexFile() {
  try {
    const response = await fetch('/api/config/index');
    if (response.ok) {
      const data = await response.json();
      return data.indexFile || null;
    }
  } catch (error) {
    console.error('Failed to check index file:', error);
  }
  return null;
}

// Show welcome screen
function showWelcomeScreen() {
  const content = document.getElementById('markdown-content');
  content.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">
        <svg>...</svg>
      </div>
      <h1>Welcome to DocuLight</h1>
      <p class="welcome-subtitle">A lightweight Markdown documentation viewer</p>
      <div class="welcome-actions">
        <!-- Welcome cards -->
      </div>
    </div>
  `;
}
```

### 4.2 Server-Side Index Config API

**New Endpoint**: `GET /api/config/index`

**File**: `src/controllers/config-controller.js` (new file)

```javascript
const path = require('path');

/**
 * Get index file configuration
 */
function getIndexConfig(req, res) {
  const config = req.app.locals.config;

  let indexFile = null;

  if (config.ui && config.ui.resolvedIndexFile) {
    // Convert absolute path to relative path for client
    const docsRoot = config.docsRoot;
    indexFile = path.relative(docsRoot, config.ui.resolvedIndexFile);

    // Ensure leading slash
    if (!indexFile.startsWith('/')) {
      indexFile = '/' + indexFile;
    }
  }

  res.json({
    indexFile,
    hasIndex: !!indexFile
  });
}

module.exports = { getIndexConfig };
```

**Add Route**: `src/app.js`
```javascript
const { getIndexConfig } = require('./controllers/config-controller');

// Before API router
app.get('/api/config/index', getIndexConfig);
```

---

## 5. Sidebar Header Navigation

### 5.1 Update Sidebar Header

**File**: `src/views/index.ejs`

**Current**:
```html
<div class="sidebar-title">
  <img src="<%= uiIcon %>" alt="icon" class="sidebar-icon">
  <h1 title="<%= uiTitle %>"><%= uiTitle %></h1>
</div>
```

**New (Clickable)**:
```html
<div class="sidebar-title" id="sidebar-title" role="button" tabindex="0" title="Go to home">
  <img src="<%= uiIcon %>" alt="icon" class="sidebar-icon">
  <h1><%= uiTitle %></h1>
</div>
```

**CSS Update**:
```css
.sidebar-title {
  cursor: pointer;
  transition: opacity 0.2s;
  user-select: none;
}

.sidebar-title:hover {
  opacity: 0.8;
}

.sidebar-title:active {
  opacity: 0.6;
}
```

**JavaScript**:
```javascript
// Handle sidebar header click
document.getElementById('sidebar-title').addEventListener('click', async () => {
  const indexFile = await checkIndexFile();

  if (indexFile) {
    // Load index file
    await loadFile(indexFile);
    await expandToFile(indexFile);
  } else {
    // Show welcome screen
    showWelcomeScreen();
    updateBreadcrumb('Home');
  }
});

// Handle keyboard navigation (Enter/Space)
document.getElementById('sidebar-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    document.getElementById('sidebar-title').click();
  }
});
```

---

## 6. API/MCP Documentation Index

### 6.1 Doc Controller Updates

**File**: `src/controllers/doc-controller.js`

**Enhanced Function**:
```javascript
const path = require('path');
const fs = require('fs');

/**
 * Serve API or MCP documentation
 */
function getDocumentation(req, res, next) {
  const docType = req.params.docType; // 'api' or 'mcp'
  const config = req.app.locals.config;

  // Validate doc type
  if (!['api', 'mcp'].includes(docType)) {
    return res.status(404).json({
      error: {
        code: 'INVALID_DOC_TYPE',
        message: 'Documentation type must be "api" or "mcp"'
      }
    });
  }

  // Try to get custom index file from config
  let docPath;
  if (docType === 'api' && config.ui?.resolvedApiIndexFile) {
    docPath = config.ui.resolvedApiIndexFile;
  } else if (docType === 'mcp' && config.ui?.resolvedMcpIndexFile) {
    docPath = config.ui.resolvedMcpIndexFile;
  } else {
    // Fallback to default
    const docFile = `${docType}-doc.md`;
    docPath = path.join(__dirname, '../../public', docFile);
  }

  // Check if documentation exists
  if (!fs.existsSync(docPath)) {
    return res.status(404).json({
      error: {
        code: 'DOC_NOT_FOUND',
        message: `Documentation file not found: ${path.basename(docPath)}`
      }
    });
  }

  try {
    const content = fs.readFileSync(docPath, 'utf-8');
    const stats = fs.statSync(docPath);

    res.json({
      content,
      type: docType,
      path: `/${docType}/doc`,
      size: stats.size,
      modified: stats.mtime,
      isCustom: !!(docType === 'api' ? config.ui?.resolvedApiIndexFile : config.ui?.resolvedMcpIndexFile)
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getDocumentation };
```

---

## 7. Full Tree Structure API

### 7.1 New API Endpoint

**Endpoint**: `GET /api/tree/full`

**Purpose**: Return complete document tree structure (no path parameter)

**File**: `src/controllers/tree-controller.js`

**New Function**:
```javascript
/**
 * Get full document tree structure
 */
async function getFullTree(req, res, next) {
  const config = req.app.locals.config;
  const logger = req.app.locals.logger;

  try {
    const tree = await buildTree(config.docsRoot, config.docsRoot, config.excludes);

    res.json({
      root: config.docsRoot,
      tree,
      timestamp: new Date().toISOString(),
      totalFiles: countFiles(tree),
      totalDirectories: countDirectories(tree)
    });
  } catch (error) {
    logger.error('Failed to build full tree', { error: error.message });
    next(error);
  }
}

/**
 * Count files in tree
 */
function countFiles(node) {
  if (node.type === 'file') return 1;
  if (node.type === 'directory' && node.children) {
    return node.children.reduce((sum, child) => sum + countFiles(child), 0);
  }
  return 0;
}

/**
 * Count directories in tree
 */
function countDirectories(node) {
  if (node.type === 'file') return 0;
  if (node.type === 'directory' && node.children) {
    return 1 + node.children.reduce((sum, child) => sum + countDirectories(child), 0);
  }
  return node.type === 'directory' ? 1 : 0;
}

module.exports = { getTree, getFullTree };
```

**Add Route**: `src/routes/api.js`
```javascript
const { getTree, getFullTree } = require('../controllers/tree-controller');

// Public routes
router.get('/tree/full', getFullTree);  // NEW: Full tree
router.get('/tree', getTree);           // Existing: Partial tree
```

### 7.2 MCP Tool for Full Tree

**File**: `DocuLight-mcp-server/src/tools/list.js`

**Enhanced Function**:
```javascript
export async function listDocuments(config, path) {
  const client = new DocuLightClient(config.baseUrl, config.apiKey);

  try {
    let result;

    // If path is root or empty, get full tree
    if (!path || path === '/' || path === '') {
      result = await client.getFullTree();

      // Format full tree
      const treeText = formatFullTree(result.tree);

      return {
        content: [
          {
            type: 'text',
            text: `# Full Document Tree\n\nRoot: ${result.root}\nFiles: ${result.totalFiles}\nDirectories: ${result.totalDirectories}\n\n${treeText}`
          }
        ]
      };
    } else {
      // Get partial tree for specific path
      result = await client.getTree(path);
      const treeText = formatTree(result.children || [result]);

      return {
        content: [
          {
            type: 'text',
            text: `# Documents at ${path}\n\n${treeText}`
          }
        ]
      };
    }
  } catch (error) {
    throw new Error(`Failed to list documents: ${error.message}`);
  }
}

function formatFullTree(node, indent = 0) {
  let output = '';
  const prefix = '  '.repeat(indent);
  const icon = node.type === 'directory' ? '📁' : '📄';

  output += `${prefix}${icon} ${node.name}\n`;

  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      output += formatFullTree(child, indent + 1);
    }
  }

  return output;
}
```

**Update Client**: `DocuLight-mcp-server/src/client.js`
```javascript
/**
 * Get full directory tree
 */
async getFullTree() {
  return this.request('GET', '/tree/full');
}
```

---

## 8. Config File Hot Reload (Optional)

### 8.1 Watch Config File

**File**: `src/app.js`

**Add File Watcher**:
```javascript
const fs = require('fs');
const path = require('path');

// Watch config file for changes
const configPath = path.join(__dirname, '../config.json5');

fs.watch(configPath, (eventType) => {
  if (eventType === 'change') {
    logger.info('Config file changed, reloading...');

    try {
      // Reload config
      delete require.cache[require.resolve('./utils/config-loader')];
      const { loadConfig } = require('./utils/config-loader');
      const newConfig = loadConfig();

      // Update app.locals.config
      app.locals.config = newConfig;

      logger.info('Config reloaded successfully');
    } catch (error) {
      logger.error('Failed to reload config', { error: error.message });
    }
  }
});
```

---

## 9. Implementation Steps

### Phase 1: Config & Backend (2-3 hours)

1. ✅ Update `config.example.json5` with new UI fields
2. ✅ Enhance `config-loader.js` with path resolution and validation
3. ✅ Create `config-controller.js` for index config API
4. ✅ Update `doc-controller.js` for custom index paths
5. ✅ Add `getFullTree` function to `tree-controller.js`
6. ✅ Add `/api/config/index` and `/api/tree/full` routes

### Phase 2: Frontend UI (2-3 hours)

1. ✅ Update welcome screen to English with enhanced design
2. ✅ Add welcome screen CSS
3. ✅ Implement `checkIndexFile()` function
4. ✅ Implement `showWelcomeScreen()` function
5. ✅ Update `initializeApp()` with auto-load logic
6. ✅ Add sidebar header click handler
7. ✅ Add keyboard navigation for sidebar header

### Phase 3: MCP Server Updates (1-2 hours)

1. ✅ Update `client.js` with `getFullTree()` method
2. ✅ Enhance `list.js` tool for full tree support
3. ✅ Test MCP full tree listing

### Phase 4: Testing & Documentation (1-2 hours)

1. ✅ Test index file auto-load with valid paths
2. ✅ Test fallback with invalid paths
3. ✅ Test sidebar header navigation
4. ✅ Test custom API/MCP index files
5. ✅ Test full tree API endpoint
6. ✅ Test MCP full tree tool
7. ✅ Update README.md with new configuration options

**Total Estimated Time**: 6-10 hours

---

## 10. Configuration Examples

### 10.1 Basic Configuration

```json5
{
  docsRoot: "/data/docs",
  apiKey: "your-api-key",

  ui: {
    title: "My Documentation",
    icon: "/images/icon.svg",
    indexFile: "/README.md"  // Auto-load README.md on startup
  }
}
```

### 10.2 Advanced Configuration

```json5
{
  docsRoot: "/data/docs",
  apiKey: "your-api-key",

  ui: {
    title: "Company Docs",
    icon: "/images/logo.png",

    // Custom index files
    indexFile: "/welcome.md",                    // Main docs index
    apiIndexFile: "/docs/api/reference.md",      // Custom API docs
    mcpIndexFile: "/docs/integration/mcp.md"     // Custom MCP docs
  }
}
```

### 10.3 No Auto-Load Configuration

```json5
{
  docsRoot: "/data/docs",
  apiKey: "your-api-key",

  ui: {
    title: "DocuLight",
    icon: "/images/icon.svg"
    // No indexFile specified - show welcome screen
  }
}
```

---

## 11. Testing Plan

### 11.1 Config Validation Tests

```bash
# Test 1: Valid relative path
echo '{ ui: { indexFile: "/README.md" } }' >> config.json5
curl http://localhost:3000/api/config/index
# Expected: { "indexFile": "/README.md", "hasIndex": true }

# Test 2: Invalid path
echo '{ ui: { indexFile: "/nonexistent.md" } }' >> config.json5
curl http://localhost:3000/api/config/index
# Expected: { "indexFile": null, "hasIndex": false }

# Test 3: Absolute path
echo '{ ui: { indexFile: "/absolute/path/to/doc.md" } }' >> config.json5
# Expected: Works if file exists, null otherwise
```

### 11.2 Auto-Load Tests

```bash
# Test 1: Open browser, should auto-load index file
open http://localhost:3000

# Test 2: Click sidebar header, should go back to index
# (Manual browser test)

# Test 3: No index file, should show welcome screen
# (Manual browser test)
```

### 11.3 Full Tree API Tests

```bash
# Test 1: Get full tree
curl http://localhost:3000/api/tree/full | jq

# Expected output:
# {
#   "root": "/data/docs",
#   "tree": { ... },
#   "totalFiles": 42,
#   "totalDirectories": 15
# }

# Test 2: MCP full tree
echo '{"name":"DocuLight_list","arguments":{}}' | \
  DocuLight_URL=http://localhost:3000 \
  DocuLight_API_KEY=your-key \
  node DocuLight-mcp-server/src/index.js
```

---

## 12. Success Criteria

- [ ] Welcome screen is in English with enhanced design
- [ ] Config supports `ui.indexFile`, `ui.apiIndexFile`, `ui.mcpIndexFile`
- [ ] Index file auto-loads on startup (if configured)
- [ ] Sidebar header click navigates to index
- [ ] Invalid index paths fall back to welcome screen
- [ ] `/api/config/index` returns correct index file path
- [ ] `/api/tree/full` returns complete tree structure
- [ ] Custom API/MCP index files load correctly
- [ ] MCP `DocuLight_list` tool supports full tree
- [ ] All features work with hot config reload

---

## 13. Future Enhancements

- [ ] Multiple index files per language
- [ ] Index file templates
- [ ] Auto-generated table of contents
- [ ] Search integration with index
- [ ] Index file preview in config UI
- [ ] Tree caching for large document sets

---

**Version**: 1.0.0
**Last Updated**: 2025-10-24
