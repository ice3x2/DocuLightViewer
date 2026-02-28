// test/mcp-http.e2e.js — DocuLight MCP HTTP E2E Tests (TC-01 ~ TC-35)
// Tests for the HTTP JSON-RPC MCP server (mcp-http.mjs)
// Run: npx playwright test test/mcp-http.e2e.js

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const net = require('net');
const http = require('http');
const fs = require('fs');

const FIXTURES = path.join(__dirname, 'fixtures');
const HELLO_MD = path.join(FIXTURES, 'hello.md');
const PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\doculight-ipc'
  : '/tmp/doculight-ipc.sock';

/** @type {import('playwright').ElectronApplication} */
let app;

// ============================================================================
// Helper: send ndjson IPC request to the Electron app's socket server
// ============================================================================

function sendIpcRequest(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const socket = net.connect({ path: PIPE_PATH }, () => {
      const msg = JSON.stringify({ id, action, params }) + '\n';
      socket.write(msg);
    });

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        try {
          const response = JSON.parse(line);
          socket.end();
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.result);
          }
        } catch (e) {
          socket.end();
          reject(e);
        }
      }
    });

    socket.on('error', reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error('IPC request timeout'));
    });
  });
}

// ============================================================================
// Helper: wait for IPC server to be ready
// ============================================================================

async function waitForIpcServer(maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await sendIpcRequest('list_viewers');
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('IPC server not ready after ' + maxAttempts + ' attempts');
}

// ============================================================================
// Helper: read MCP port from the port discovery file
// ============================================================================

async function getMcpPort(electronApp, maxAttempts = 30) {
  // First, get the userData path from the Electron main process
  const userDataPath = await electronApp.evaluate(async ({ app: eApp }) => {
    return eApp.getPath('userData');
  });
  const portFilePath = path.join(userDataPath, 'mcp-port');

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const portStr = fs.readFileSync(portFilePath, 'utf-8').trim();
      const port = parseInt(portStr, 10);
      if (port > 0) return port;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('MCP port file not found after ' + maxAttempts + ' attempts (path: ' + portFilePath + ')');
}

// ============================================================================
// Helper: low-level HTTP request
// ============================================================================

function sendRawHttp(port, httpMethod, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: httpMethod,
      headers
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(rawBody); } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: rawBody,
          json
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('HTTP request timeout')); });

    if (body) req.write(body);
    req.end();
  });
}

// ============================================================================
// Helper: send MCP JSON-RPC request via HTTP
// ============================================================================

async function sendMcpRequest(port, method, params = {}, opts = {}) {
  const { acceptSSE = false, isNotification = false } = opts;
  const body = {
    jsonrpc: '2.0',
    method,
    params
  };
  if (!isNotification) {
    body.id = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (acceptSSE) headers['Accept'] = 'text/event-stream';

  const res = await sendRawHttp(port, 'POST', '/mcp', JSON.stringify(body), headers);
  return res;
}

// ============================================================================
// Helper: send MCP JSON-RPC batch request
// ============================================================================

async function sendMcpBatch(port, messages) {
  const headers = { 'Content-Type': 'application/json' };
  return sendRawHttp(port, 'POST', '/mcp', JSON.stringify(messages), headers);
}

// ============================================================================
// Helper: extract windowId from MCP tools/call result
// ============================================================================

function extractWindowId(result) {
  const text = result?.content?.[0]?.text || '';
  const m = text.match(/windowId:\s*(\S+)/);
  return m ? m[1] : null;
}

// ============================================================================
// Helper: get viewer window
// ============================================================================

function getViewer() {
  return app.windows().find(w => w.url().includes('viewer.html'));
}

// ============================================================================
// Test Suite
// ============================================================================

test.describe('MCP HTTP E2E Tests', () => {
  let mcpPort;

  test.beforeAll(async () => {
    const electronPath = require('electron');
    app = await electron.launch({
      executablePath: typeof electronPath === 'string' ? electronPath : electronPath.toString(),
      args: [path.join(__dirname, '..')],
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 30000,
    });

    // Wait for IPC server
    await waitForIpcServer();

    // Wait for MCP HTTP server and get port
    mcpPort = await getMcpPort(app);

    // Clear persisted panel prefs from IndexedDB for consistent state
    try {
      const tempResult = await sendIpcRequest('open_markdown', {
        content: '# Test Init', title: 'Init',
      });
      await new Promise(r => setTimeout(r, 800));
      const initViewer = app.windows().find(w => w.url().includes('viewer.html'));
      if (initViewer) {
        await initViewer.evaluate(async () => {
          await new Promise((resolve) => {
            const req = indexedDB.open('doculight', 1);
            req.onsuccess = (e) => {
              const db = e.target.result;
              try {
                const tx = db.transaction('ui-prefs', 'readwrite');
                const store = tx.objectStore('ui-prefs');
                store.delete('panel-state');
                tx.oncomplete = resolve;
                tx.onerror = resolve;
              } catch { resolve(); }
            };
            req.onerror = resolve;
          });
        });
      }
      await sendIpcRequest('close_viewer', { windowId: tempResult.windowId });
      await new Promise(r => setTimeout(r, 300));
    } catch { /* ignore */ }
  });

  test.afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  test.beforeEach(async () => {
    try {
      await sendIpcRequest('close_viewer');
      await new Promise(r => setTimeout(r, 300));
    } catch { /* ignore */ }
  });

  // =========================================================================
  // Group A: Streamable HTTP Transport (TC-01 ~ TC-11)
  // =========================================================================

  test('TC-01: POST JSON request returns 200 with valid JSON-RPC response', async () => {
    const res = await sendMcpRequest(mcpPort, 'ping');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json.jsonrpc).toBe('2.0');
    expect(res.json.result).toEqual({});
  });

  test('TC-02: POST notification returns 202 with empty body', async () => {
    const res = await sendMcpRequest(mcpPort, 'notifications/initialized', {}, { isNotification: true });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  test('TC-03: POST with Accept text/event-stream returns SSE format', async () => {
    const res = await sendMcpRequest(mcpPort, 'ping', {}, { acceptSSE: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: message\ndata:');
  });

  test('TC-04: initialize returns Mcp-Session-Id header with UUID', async () => {
    const res = await sendMcpRequest(mcpPort, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['mcp-session-id']).toMatch(/^[0-9a-f]{8}-/);
  });

  test('TC-05: Batch request returns batch response array', async () => {
    const res = await sendMcpBatch(mcpPort, [
      { jsonrpc: '2.0', id: 'b1', method: 'ping', params: {} },
      { jsonrpc: '2.0', id: 'b2', method: 'ping', params: {} }
    ]);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);
    expect(res.json.length).toBe(2);
  });

  test('TC-06: GET /mcp returns SSE stream', async () => {
    // Use net.Socket directly to avoid http module's response buffering
    const result = await new Promise((resolve, reject) => {
      let resolved = false;
      const socket = net.connect(mcpPort, '127.0.0.1', () => {
        socket.write('GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n');
      });

      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        // Once we have the full headers (double CRLF), resolve
        if (!resolved && buffer.includes('\r\n\r\n')) {
          resolved = true;
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on('error', (err) => {
        if (!resolved) { resolved = true; reject(err); }
      });
      socket.setTimeout(5000, () => {
        if (!resolved) { resolved = true; socket.destroy(); reject(new Error('timeout')); }
      });
    });

    expect(result).toContain('HTTP/1.1 200');
    expect(result.toLowerCase()).toContain('content-type: text/event-stream');
  });

  test('TC-07: DELETE /mcp returns 405', async () => {
    const res = await sendRawHttp(mcpPort, 'DELETE', '/mcp');
    expect(res.statusCode).toBe(405);
  });

  test('TC-08: OPTIONS /mcp returns 204 with CORS headers', async () => {
    const res = await sendRawHttp(mcpPort, 'OPTIONS', '/mcp');
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Mcp-Session-Id');
  });

  test('TC-09: Invalid JSON returns 400 with parse error code -32700', async () => {
    const res = await sendRawHttp(mcpPort, 'POST', '/mcp', 'not-json', { 'Content-Type': 'application/json' });
    expect(res.statusCode).toBe(400);
    expect(res.json.error.code).toBe(-32700);
  });

  test('TC-10: Unknown method returns -32601 error', async () => {
    const res = await sendMcpRequest(mcpPort, 'nonexistent/method');
    expect(res.statusCode).toBe(200);
    expect(res.json.error.code).toBe(-32601);
  });

  test('TC-11: Wrong path returns 404', async () => {
    const res = await sendRawHttp(mcpPort, 'POST', '/other', JSON.stringify({
      jsonrpc: '2.0', id: 'x', method: 'ping'
    }), { 'Content-Type': 'application/json' });
    expect(res.statusCode).toBe(404);
  });

  // =========================================================================
  // Group B: MCP Lifecycle (TC-12 ~ TC-15)
  // =========================================================================

  test('TC-12: initialize response contains protocol version, server info, and capabilities', async () => {
    const res = await sendMcpRequest(mcpPort, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json.result.protocolVersion).toBe('2025-03-26');
    expect(res.json.result.serverInfo.name).toBe('doculight');
    expect(res.json.result.capabilities.tools).toBeDefined();
  });

  test('TC-13: notifications/initialized returns 202', async () => {
    const res = await sendMcpRequest(mcpPort, 'notifications/initialized', {}, { isNotification: true });
    expect(res.statusCode).toBe(202);
  });

  test('TC-14: ping returns empty result object', async () => {
    const res = await sendMcpRequest(mcpPort, 'ping');
    expect(res.statusCode).toBe(200);
    expect(res.json.result).toEqual({});
  });

  test('TC-15: tools/list returns 6 tools with inputSchema', async () => {
    const res = await sendMcpRequest(mcpPort, 'tools/list');
    expect(res.statusCode).toBe(200);
    const tools = res.json.result.tools;
    expect(tools).toHaveLength(6);

    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('open_markdown');
    expect(toolNames).toContain('update_markdown');
    expect(toolNames).toContain('close_viewer');
    expect(toolNames).toContain('list_viewers');
    expect(toolNames).toContain('search_documents');
    expect(toolNames).toContain('search_projects');

    // Each tool must have inputSchema
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
    }
  });

  // =========================================================================
  // Group C: MCP Tools via HTTP (TC-16 ~ TC-32)
  // =========================================================================

  test('TC-16: open_markdown with content creates viewer window', async () => {
    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# HTTP Test Content\n\nHello from HTTP MCP test.',
        title: 'HTTP TC-16'
      }
    });

    expect(res.statusCode).toBe(200);
    const windowId = extractWindowId(res.json.result);
    expect(windowId).toBeTruthy();

    await new Promise(r => setTimeout(r, 1000));

    // Verify via IPC that the window exists
    const listResult = await sendIpcRequest('list_viewers');
    const found = listResult.windows.find(w => String(w.windowId) === String(windowId));
    expect(found).toBeTruthy();

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-17: open_markdown with filePath opens file', async () => {
    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        filePath: HELLO_MD
      }
    });

    expect(res.statusCode).toBe(200);
    const windowId = extractWindowId(res.json.result);
    expect(windowId).toBeTruthy();

    await new Promise(r => setTimeout(r, 1000));

    // Verify window exists
    const listResult = await sendIpcRequest('list_viewers');
    expect(listResult.windows.length).toBeGreaterThanOrEqual(1);

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-18: open_markdown with same windowName upserts (same windowId)', async () => {
    // First call
    const res1 = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# First',
        title: 'Upsert First',
        windowName: 'http-upsert-tc18'
      }
    });

    expect(res1.statusCode).toBe(200);
    const windowId1 = extractWindowId(res1.json.result);
    expect(windowId1).toBeTruthy();

    await new Promise(r => setTimeout(r, 500));

    // Second call with same windowName
    const res2 = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# Second (upserted)',
        title: 'Upsert Second',
        windowName: 'http-upsert-tc18'
      }
    });

    expect(res2.statusCode).toBe(200);
    const windowId2 = extractWindowId(res2.json.result);
    expect(windowId2).toBe(windowId1);

    // Response text should indicate update
    const text = res2.json.result.content[0].text;
    expect(text).toContain('Updated existing');

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-19: open_markdown with severity/tags/progress sets meta fields', async () => {
    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# Severity Tags Progress Test',
        title: 'HTTP TC-19',
        severity: 'warning',
        tags: ['http-test'],
        progress: 0.75
      }
    });

    expect(res.statusCode).toBe(200);
    const windowId = extractWindowId(res.json.result);
    expect(windowId).toBeTruthy();

    await new Promise(r => setTimeout(r, 500));

    // Verify meta fields via IPC list_viewers
    const listResult = await sendIpcRequest('list_viewers');
    const found = listResult.windows.find(w => String(w.windowId) === String(windowId));
    expect(found).toBeTruthy();
    expect(found.severity).toBe('warning');
    expect(found.tags).toContain('http-test');
    expect(found.progress).toBe(0.75);

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-20: open_markdown with frontmatter metadata shows metabox in viewer', async () => {
    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# Frontmatter Test\n\nSome content here.',
        title: 'HTTP TC-20',
        project: 'TestProject',
        docName: 'TestDoc',
        description: 'A test document for frontmatter'
      }
    });

    expect(res.statusCode).toBe(200);
    const windowId = extractWindowId(res.json.result);
    expect(windowId).toBeTruthy();

    await new Promise(r => setTimeout(r, 1500));

    // Check viewer DOM for metabox
    const viewer = getViewer();
    expect(viewer).toBeTruthy();

    const metaboxExists = await viewer.evaluate(() => {
      const metabox = document.querySelector('.frontmatter-metabox, #frontmatter-metabox, [class*="metabox"]');
      return metabox !== null;
    });
    expect(metaboxExists).toBe(true);

    // Check that the metabox contains the project name
    const metaboxText = await viewer.evaluate(() => {
      const metabox = document.querySelector('.frontmatter-metabox, #frontmatter-metabox, [class*="metabox"]');
      return metabox ? metabox.textContent : '';
    });
    expect(metaboxText).toContain('TestProject');

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-21: open_markdown with autoCloseSeconds closes window after timeout', async () => {
    test.setTimeout(15000);

    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# Auto-close HTTP Test',
        title: 'HTTP TC-21',
        autoCloseSeconds: 2
      }
    });

    expect(res.statusCode).toBe(200);
    const windowId = extractWindowId(res.json.result);
    expect(windowId).toBeTruthy();

    // Window should exist immediately
    const listBefore = await sendIpcRequest('list_viewers');
    const existsBefore = listBefore.windows.some(w => String(w.windowId) === String(windowId));
    expect(existsBefore).toBe(true);

    // Wait past auto-close deadline (2s + buffer)
    await new Promise(r => setTimeout(r, 3500));

    // Window should be gone
    const listAfter = await sendIpcRequest('list_viewers');
    const existsAfter = listAfter.windows.some(w => String(w.windowId) === String(windowId));
    expect(existsAfter).toBe(false);
  });

  test('TC-22: open_markdown without content or filePath returns isError', async () => {
    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {}
    });

    expect(res.statusCode).toBe(200);
    expect(res.json.result.isError).toBe(true);
  });

  test('TC-23: update_markdown replaces content via HTTP', async () => {
    // Open a window first
    const openRes = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# Original Content',
        title: 'HTTP TC-23'
      }
    });

    const windowId = extractWindowId(openRes.json.result);
    expect(windowId).toBeTruthy();

    await new Promise(r => setTimeout(r, 1000));

    // Update content via HTTP
    const updateRes = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'update_markdown',
      arguments: {
        windowId: windowId,
        content: '# Replaced Content\n\nNew text via HTTP update.',
        title: 'HTTP TC-23 Updated'
      }
    });

    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json.result.isError).toBeFalsy();

    await new Promise(r => setTimeout(r, 500));

    // Check viewer DOM for new content
    const viewer = getViewer();
    expect(viewer).toBeTruthy();
    const heading = await viewer.textContent('#content h1');
    expect(heading).toBe('Replaced Content');

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-24: update_markdown appendMode appends content', async () => {
    // Open a window
    const openRes = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: 'First part of content.',
        title: 'HTTP TC-24'
      }
    });

    const windowId = extractWindowId(openRes.json.result);
    expect(windowId).toBeTruthy();

    await new Promise(r => setTimeout(r, 1000));

    // Append content via HTTP
    const updateRes = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'update_markdown',
      arguments: {
        windowId: windowId,
        content: 'Second part appended.',
        appendMode: true
      }
    });

    expect(updateRes.statusCode).toBe(200);

    await new Promise(r => setTimeout(r, 500));

    // Check viewer DOM for both parts
    const viewer = getViewer();
    expect(viewer).toBeTruthy();
    const text = await viewer.evaluate(() => {
      const el = document.getElementById('content');
      return el ? el.textContent : '';
    });
    expect(text).toContain('First part of content');
    expect(text).toContain('Second part appended');

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-25: update_markdown changes severity/tags/progress', async () => {
    // Open with initial severity info
    const openRes = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# Update Meta Test',
        title: 'HTTP TC-25',
        severity: 'info'
      }
    });

    const windowId = extractWindowId(openRes.json.result);
    expect(windowId).toBeTruthy();

    await new Promise(r => setTimeout(r, 500));

    // Update severity to error
    const updateRes = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'update_markdown',
      arguments: {
        windowId: windowId,
        severity: 'error'
      }
    });

    expect(updateRes.statusCode).toBe(200);

    await new Promise(r => setTimeout(r, 300));

    // Check via IPC list_viewers
    const listResult = await sendIpcRequest('list_viewers');
    const found = listResult.windows.find(w => String(w.windowId) === String(windowId));
    expect(found).toBeTruthy();
    expect(found.severity).toBe('error');

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-26: close_viewer by windowId closes specific window', async () => {
    // Open 2 windows
    const res1 = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: { content: '# Window A', title: 'HTTP TC-26 A' }
    });
    const res2 = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: { content: '# Window B', title: 'HTTP TC-26 B' }
    });

    const windowIdA = extractWindowId(res1.json.result);
    const windowIdB = extractWindowId(res2.json.result);
    expect(windowIdA).toBeTruthy();
    expect(windowIdB).toBeTruthy();

    await new Promise(r => setTimeout(r, 500));

    // Close window A via HTTP
    const closeRes = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'close_viewer',
      arguments: { windowId: windowIdA }
    });

    expect(closeRes.statusCode).toBe(200);

    await new Promise(r => setTimeout(r, 500));

    // Verify only window B remains
    const listResult = await sendIpcRequest('list_viewers');
    const hasA = listResult.windows.some(w => String(w.windowId) === String(windowIdA));
    const hasB = listResult.windows.some(w => String(w.windowId) === String(windowIdB));
    expect(hasA).toBe(false);
    expect(hasB).toBe(true);

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-27: close_viewer by tag closes only tagged windows', async () => {
    // Open tagged window
    const tagged = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# Tagged',
        title: 'HTTP TC-27 Tagged',
        tags: ['http-close-tag']
      }
    });

    // Open untagged window
    const untagged = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# Untagged',
        title: 'HTTP TC-27 Untagged'
      }
    });

    const taggedId = extractWindowId(tagged.json.result);
    const untaggedId = extractWindowId(untagged.json.result);

    await new Promise(r => setTimeout(r, 500));

    // Close by tag via HTTP
    const closeRes = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'close_viewer',
      arguments: { tag: 'http-close-tag' }
    });

    expect(closeRes.statusCode).toBe(200);

    await new Promise(r => setTimeout(r, 500));

    // Verify tagged gone, untagged remains
    const listResult = await sendIpcRequest('list_viewers');
    const hasTagged = listResult.windows.some(w => String(w.windowId) === String(taggedId));
    const hasUntagged = listResult.windows.some(w => String(w.windowId) === String(untaggedId));
    expect(hasTagged).toBe(false);
    expect(hasUntagged).toBe(true);

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-28: close_viewer with no params closes all windows', async () => {
    // Open 2 windows
    await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: { content: '# A', title: 'HTTP TC-28 A' }
    });
    await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: { content: '# B', title: 'HTTP TC-28 B' }
    });

    await new Promise(r => setTimeout(r, 500));

    // Close all via HTTP
    const closeRes = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'close_viewer',
      arguments: {}
    });

    expect(closeRes.statusCode).toBe(200);

    await new Promise(r => setTimeout(r, 500));

    // Verify 0 windows
    const listResult = await sendIpcRequest('list_viewers');
    expect(listResult.windows.length).toBe(0);
  });

  test('TC-29: list_viewers via HTTP shows all open windows', async () => {
    // Open 2 windows via HTTP
    await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: { content: '# List A', title: 'HTTP TC-29 A' }
    });
    await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: { content: '# List B', title: 'HTTP TC-29 B' }
    });

    await new Promise(r => setTimeout(r, 500));

    // List via HTTP
    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'list_viewers',
      arguments: {}
    });

    expect(res.statusCode).toBe(200);
    const text = res.json.result.content[0].text;
    expect(text).toContain('HTTP TC-29 A');
    expect(text).toContain('HTTP TC-29 B');

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-30: list_viewers with tag filter returns only tagged windows', async () => {
    // Open tagged window
    await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# Tagged',
        title: 'HTTP TC-30 Tagged',
        tags: ['http-list-tag']
      }
    });

    // Open untagged window
    await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: '# Untagged',
        title: 'HTTP TC-30 Untagged'
      }
    });

    await new Promise(r => setTimeout(r, 500));

    // List with tag filter via HTTP
    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'list_viewers',
      arguments: { tag: 'http-list-tag' }
    });

    expect(res.statusCode).toBe(200);
    const text = res.json.result.content[0].text;
    expect(text).toContain('HTTP TC-30 Tagged');
    expect(text).not.toContain('HTTP TC-30 Untagged');

    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 300));
  });

  test('TC-31: Unknown tool returns isError result', async () => {
    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'nonexistent_tool',
      arguments: {}
    });

    expect(res.statusCode).toBe(200);
    expect(res.json.result.isError).toBe(true);
    expect(res.json.result.content[0].text).toContain('Unknown tool');
  });

  test('TC-32: search_documents returns valid JSON-RPC response', async () => {
    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'search_documents',
      arguments: { query: 'test' }
    });

    expect(res.statusCode).toBe(200);
    // Either returns results or an isError about mcpAutoSave not being enabled
    expect(res.json.result).toBeDefined();
    if (res.json.result.isError) {
      expect(res.json.result.content[0].text).toContain('mcpAutoSave');
    } else {
      // Valid response with content
      expect(res.json.result.content).toBeDefined();
      expect(res.json.result.content[0].type).toBe('text');
    }
  });

  // =========================================================================
  // Group D: Performance (TC-33 ~ TC-35)
  // =========================================================================

  test('TC-33: 20 sequential open_markdown calls all succeed with avg < 2000ms', async () => {
    test.setTimeout(60000);

    const times = [];
    const windowIds = [];

    for (let i = 0; i < 20; i++) {
      const start = Date.now();
      const res = await sendMcpRequest(mcpPort, 'tools/call', {
        name: 'open_markdown',
        arguments: {
          content: `# Perf Test ${i}\n\nWindow number ${i}.`,
          title: `Perf TC-33 #${i}`
        }
      });
      const elapsed = Date.now() - start;
      times.push(elapsed);

      expect(res.statusCode).toBe(200);
      const windowId = extractWindowId(res.json.result);
      expect(windowId).toBeTruthy();
      windowIds.push(windowId);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`TC-33: 20 open_markdown avg=${Math.round(avg)}ms, max=${Math.max(...times)}ms, min=${Math.min(...times)}ms`);
    expect(avg).toBeLessThan(2000);

    // Cleanup
    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 500));
  });

  test('TC-34: 1MB content open_markdown succeeds without timeout', async () => {
    test.setTimeout(60000);

    const largeContent = 'text '.repeat(200000); // ~1MB

    const start = Date.now();
    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'open_markdown',
      arguments: {
        content: largeContent,
        title: 'Perf TC-34 1MB'
      }
    });
    const elapsed = Date.now() - start;
    console.log(`TC-34: 1MB content open_markdown took ${elapsed}ms`);

    expect(res.statusCode).toBe(200);
    const windowId = extractWindowId(res.json.result);
    expect(windowId).toBeTruthy();

    // Cleanup
    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 500));
  });

  test('TC-35: 10 windows then list_viewers completes under 1000ms', async () => {
    test.setTimeout(60000);

    // Open 10 windows
    for (let i = 0; i < 10; i++) {
      const res = await sendMcpRequest(mcpPort, 'tools/call', {
        name: 'open_markdown',
        arguments: {
          content: `# List Perf ${i}`,
          title: `Perf TC-35 #${i}`
        }
      });
      expect(res.statusCode).toBe(200);
    }

    await new Promise(r => setTimeout(r, 500));

    // Time list_viewers
    const start = Date.now();
    const res = await sendMcpRequest(mcpPort, 'tools/call', {
      name: 'list_viewers',
      arguments: {}
    });
    const elapsed = Date.now() - start;
    console.log(`TC-35: list_viewers with 10 windows took ${elapsed}ms`);

    expect(res.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(1000);

    // Verify all 10 are listed
    const text = res.json.result.content[0].text;
    expect(text).toContain('10');

    // Cleanup
    await sendIpcRequest('close_viewer');
    await new Promise(r => setTimeout(r, 500));
  });

});
