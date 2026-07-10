'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

function wave2Assert(condition, message) {
  assert(condition, `Wave 2 MCP contract: save_document/smart_search ${message}`);
}

const FORBIDDEN_INDEXING_CONTROL_TOOL_RE = /(?:^|_)(?:rebuild|clear|retry|cancel|status|import|reconcil|model[-_]?change)(?:_|$)/i;

function toolByName(tools, name) {
  return tools.find((tool) => tool.name === name);
}

function makeIpcPath(label) {
  const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, '-');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\doculight-mcp-contract-${process.pid}-${safeLabel}-${Date.now()}`;
  }
  return path.join(os.tmpdir(), `doculight-mcp-contract-${process.pid}-${safeLabel}-${Date.now()}.sock`);
}

function waitForServerListen(server, ipcPath) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ipcPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function withFakeIpcServer(label, handler, run) {
  const ipcPath = makeIpcPath(label);
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(ipcPath); } catch { /* ignore */ }
  }
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        requests.push(message);
        const handled = handler(message);
        if (handled && handled.error) {
          socket.write(JSON.stringify({ id: message.id, error: handled.error }) + '\n');
          continue;
        }
        socket.write(JSON.stringify({ id: message.id, result: handled }) + '\n');
      }
    });
  });
  await waitForServerListen(server, ipcPath);
  try {
    await run(ipcPath, requests);
  } finally {
    await closeServer(server);
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(ipcPath); } catch { /* ignore */ }
    }
  }
}

async function validateStdioBridgeRuntime({ serverPath, args, label, expectedToolNames, extraEnv = {} }) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  await withFakeIpcServer(label, (message) => {
    if (message.action === 'save_document') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            schemaVersion: 'save_document.v1',
            saved: true,
            documentId: `doc-${label}`,
            sourceRelativePath: 'ProjectParity/guide/runtime-save.md',
            resolvedTitle: 'Runtime Save',
            indexing: {
              state: 'queued',
              jobId: `job-${label}`
            },
            warnings: []
          })
        }]
      };
    }
    if (message.action === 'smart_search') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            schemaVersion: 'smart_search.v1',
            mode: { requested: 'auto', used: 'keyword' },
            degraded: true,
            degradationReasons: ['keyword_only'],
            results: [],
            indexFreshness: 'ready',
            staleFilteredCount: 0,
            diagnostics: {
              linkStatusCounts: {
                resolved: 0,
                missing: 0,
                external: 0,
                path_policy_violation: 0,
                skipped: 0,
                ambiguous: 0,
                stale: 0
              },
              warnings: []
            }
          })
        }]
      };
    }
    if (message.action === 'search_projects') {
      return {
        error: {
          message: 'failed at C:\\Users\\secret\\project.md?token=rawsecret'
        }
      };
    }
    return {};
  }, async (ipcPath, requests) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: args || [serverPath],
      cwd: root,
      env: {
        ...process.env,
        DOCULIGHT_MCP_IPC_PATH: ipcPath,
        DOCLIGHT_APP_PATH: path.join(root, 'does-not-exist'),
        ...extraEnv
      }
    });
    const client = new Client({ name: `wave2-${label}`, version: '0.0.0' });
    try {
      await client.connect(transport);
      const toolList = await client.listTools();
      const names = toolList.tools.map((tool) => tool.name).sort();
      wave2Assert(JSON.stringify(names) === JSON.stringify(expectedToolNames.slice().sort()), `${label} stdio tools/list exposes exact eight-tool set`);

      const invalidPathResult = await client.callTool({
        name: 'smart_search',
        arguments: {
          query: 'needle',
          filters: { pathPrefix: 'C:\\Users\\secret\\doc.md?token=rawsecret' },
          includeDiagnostics: true
        }
      });
      const invalidPathText = JSON.stringify(invalidPathResult);
      wave2Assert(invalidPathResult.isError === true, `${label} smart_search rejects unsafe pathPrefix before IPC`);
      wave2Assert(!invalidPathText.includes('C:\\Users\\secret'), `${label} smart_search validation does not echo Windows absolute path`);
      wave2Assert(!invalidPathText.includes('rawsecret'), `${label} smart_search validation does not echo credential value`);

      const forbiddenSaveResult = await client.callTool({
        name: 'save_document',
        arguments: {
          content: '# Invalid',
          filePath: 'C:\\Users\\secret\\leak.md'
        }
      });
      const forbiddenSaveText = JSON.stringify(forbiddenSaveResult);
      wave2Assert(forbiddenSaveResult.isError === true, `${label} save_document rejects forbidden destination-like field before IPC`);
      wave2Assert(!forbiddenSaveText.includes('C:\\Users\\secret'), `${label} save_document validation does not echo forbidden raw path`);

      const saveResult = await client.callTool({
        name: 'save_document',
        arguments: {
          content: '# Runtime Save\n\nbody',
          title: 'Runtime Save'
        }
      });
      const savePayload = JSON.parse(saveResult.content[0].text);
      wave2Assert(savePayload.indexing && savePayload.indexing.jobId === `job-${label}`, `${label} save_document passes diagnostic indexing.jobId in canonical JSON`);
      wave2Assert(!Object.prototype.hasOwnProperty.call(savePayload.indexing, 'statusUrl'), `${label} indexing.jobId does not imply MCP polling status URL`);
      wave2Assert(!Object.prototype.hasOwnProperty.call(savePayload.indexing, 'cancelTool'), `${label} indexing.jobId does not imply MCP cancel control`);
      wave2Assert(!Object.prototype.hasOwnProperty.call(savePayload.indexing, 'retryTool'), `${label} indexing.jobId does not imply MCP retry control`);
      wave2Assert(!Object.prototype.hasOwnProperty.call(savePayload.indexing, 'rebuildTool'), `${label} indexing.jobId does not imply MCP rebuild control`);
      wave2Assert(!Object.prototype.hasOwnProperty.call(savePayload.indexing, 'importTool'), `${label} indexing.jobId does not imply MCP import control`);
      wave2Assert(!Object.prototype.hasOwnProperty.call(savePayload.indexing, 'reconciliationTool'), `${label} indexing.jobId does not imply MCP reconciliation control`);
      wave2Assert(requests.some((request) => request.action === 'save_document'), `${label} valid save_document reaches fake IPC once schema validation passes`);

      const ipcErrorResult = await client.callTool({
        name: 'search_projects',
        arguments: {
          query: 'secret'
        }
      });
      const ipcErrorText = JSON.stringify(ipcErrorResult);
      wave2Assert(ipcErrorResult.isError === true, `${label} IPC error is returned as a tool error`);
      wave2Assert(!ipcErrorText.includes('C:\\Users\\secret'), `${label} IPC error redacts Windows absolute paths`);
      wave2Assert(!ipcErrorText.includes('rawsecret'), `${label} IPC error redacts credential values`);
    } finally {
      await client.close();
    }
  });
}

function assertSchemaTerms(source, label, terms) {
  for (const term of terms) {
    wave2Assert(source.includes(term), `${label} schema preserves ${term}`);
  }
}

(async () => {
  const { TOOLS } = await import('../src/main/mcp-http.mjs');
  const stdioSource = read('src/main/mcp-server.mjs');
  const mainSource = read('src/main/index.js');
  const bundleSource = fs.existsSync(path.join(root, 'src/main/mcp-server.bundle.mjs'))
    ? read('src/main/mcp-server.bundle.mjs')
    : '';
  const normalizedBundleSource = bundleSource.replace(/\r\n/g, '\n');

  const expectedToolNames = [
    'open_markdown',
    'update_markdown',
    'close_viewer',
    'list_viewers',
    'save_document',
    'search_documents',
    'search_projects',
    'smart_search'
  ];
  const forbiddenToolNames = [
    'save_markdown',
    'store_document',
    'remember_document',
    'rebuild_search_index',
    'clear_search_index',
    'retry_indexing',
    'cancel_indexing',
    'import_markdown_links',
    'reconcile_broken_links'
  ];

  const httpNames = TOOLS.map((tool) => tool.name).sort();
  wave2Assert(
    JSON.stringify(httpNames) === JSON.stringify(expectedToolNames.slice().sort()),
    `HTTP tools/list exposes exact eight-tool set ${expectedToolNames.join(', ')}`
  );

  for (const forbidden of forbiddenToolNames) {
    wave2Assert(!httpNames.includes(forbidden), `HTTP tools/list rejects forbidden tool ${forbidden}`);
    wave2Assert(!stdioSource.includes(`'${forbidden}'`) && !stdioSource.includes(`"${forbidden}"`), `stdio source rejects forbidden tool ${forbidden}`);
    wave2Assert(!bundleSource.includes(`'${forbidden}'`) && !bundleSource.includes(`"${forbidden}"`), `generated bundle rejects forbidden tool ${forbidden}`);
  }
  for (const name of httpNames) {
    wave2Assert(!FORBIDDEN_INDEXING_CONTROL_TOOL_RE.test(name), `HTTP tool ${name} is not an indexing control or status tool`);
  }

  for (const name of expectedToolNames) {
    wave2Assert(stdioSource.includes(`'${name}'`) || stdioSource.includes(`"${name}"`), `stdio source declares ${name}`);
    wave2Assert(bundleSource.includes(name), `generated bundle declares ${name}`);
  }

  wave2Assert(stdioSource.includes('resolveMcpIpcPath'), 'stdio source selects IPC through runtime profile resolver');
  wave2Assert(stdioSource.includes('DOCULIGHT_MCP_PROFILE'), 'stdio source documents dev/default MCP profile selection');
  wave2Assert(stdioSource.includes('DOCULIGHT_MCP_IPC_PATH'), 'stdio source preserves explicit MCP IPC override');
  wave2Assert(stdioSource.includes('MCP_EXPLICIT_IPC_PATH'), 'stdio source treats explicit MCP IPC path as an opt-in endpoint');
  wave2Assert(stdioSource.includes('explicit MCP IPC server not found'), 'stdio source does not auto-launch packaged app for explicit MCP IPC path failures');
  wave2Assert(stdioSource.includes('dev profile IPC server not found'), 'stdio source does not auto-launch packaged app for dev profile');
  wave2Assert(
    stdioSource.includes('describeIpcEndpoint') &&
      stdioSource.includes('REDACTED_MCP_IPC') &&
      stdioSource.includes("describeIpcEndpoint('explicit')") &&
      stdioSource.includes("describeIpcEndpoint('dev')"),
    'stdio source redacts explicit and dev IPC endpoint classes'
  );
  wave2Assert(
    stdioSource.includes('buildAutoLaunchEnv') &&
      stdioSource.includes('delete env.ELECTRON_RUN_AS_NODE') &&
      stdioSource.includes('delete env.DOCULIGHT_PACKAGED_MCP_STDIO'),
    'stdio source strips stdio-only environment before auto-launching the app'
  );
  wave2Assert(
    stdioSource.includes('redactString') &&
      stdioSource.includes('sanitizeMcpErrorMessage') &&
      stdioSource.includes('sanitizeMcpDiagnosticText'),
    'stdio source sanitizes MCP-facing errors and stderr diagnostics'
  );
  wave2Assert(
    stdioSource.includes('sanitizeMcpDiagnosticText(msg.id)') &&
      bundleSource.includes('sanitizeMcpDiagnosticText(msg.id)'),
    'stdio source and generated bundle sanitize unknown IPC response ids before stderr diagnostics'
  );
  wave2Assert(
    !stdioSource.includes('path.basename(text)') &&
      !bundleSource.includes('path.basename(text)'),
    'stdio source and generated bundle do not expose credential-bearing process basenames in stderr diagnostics'
  );
  wave2Assert(
    mainSource.includes('redactEarlyMcpStdioError') &&
      mainSource.includes("Fatal:', redactEarlyMcpStdioError") &&
      mainSource.includes('$1[REDACTED]@'),
    'main --mcp-stdio early import failure path redacts startup errors, including URL userinfo credentials, before stderr diagnostics'
  );
  const ipcWriteStart = stdioSource.indexOf('const ok = ipcSocket.write(payload);');
  const ipcWriteCatch = stdioSource.indexOf('} catch (err)', ipcWriteStart);
  const ipcWriteBackpressureSlice = stdioSource.slice(ipcWriteStart, ipcWriteCatch);
  wave2Assert(
    ipcWriteStart !== -1 &&
      ipcWriteCatch !== -1 &&
      !ipcWriteBackpressureSlice.includes('Buffer full: retry once after reconnect') &&
      !ipcWriteBackpressureSlice.includes('pendingRequests.delete(id)') &&
      !ipcWriteBackpressureSlice.includes('sendIpcRequest(action, params, true)') &&
      ipcWriteBackpressureSlice.includes("ipcSocket.once('drain'"),
    'stdio IPC write backpressure keeps the pending request instead of retrying non-idempotent actions'
  );
  wave2Assert(mainSource.includes('--mcp-stdio'), 'main process declares a packaged executable stdio MCP entrypoint flag');
  wave2Assert(mainSource.includes('DOCULIGHT_PACKAGED_MCP_STDIO') && mainSource.includes('process.env.DOCLIGHT_APP_PATH = process.execPath'), 'main process packaged stdio entrypoint points auto-launch at the current executable without recursion flags');
  wave2Assert(
    mainSource.indexOf('--mcp-stdio') !== -1 &&
      mainSource.indexOf('--mcp-stdio') < mainSource.indexOf("require('electron')") &&
      mainSource.indexOf('--mcp-stdio') < mainSource.indexOf("require('./search-engine')") &&
      mainSource.indexOf('--mcp-stdio') < mainSource.indexOf('BrowserWindow') &&
      mainSource.indexOf('--mcp-stdio') < mainSource.indexOf('Tray') &&
      mainSource.indexOf('--mcp-stdio') < mainSource.indexOf('startMcpHttpServer'),
    'main process dispatches --mcp-stdio before Electron, native/search, tray, and HTTP app services'
  );

  assertSchemaTerms(stdioSource, 'stdio source save_document', [
    'inputSchema: SAVE_DOCUMENT_ZOD_SCHEMA',
    'const SAVE_DOCUMENT_ZOD_SCHEMA = z.object(SAVE_DOCUMENT_ARG_SHAPE).strict();',
    'content: z.string().min(1).max(MAX_CONTENT_SIZE)',
    'title: z.string().min(1).max(200)',
    'project: z.string().min(1).max(120)',
    'docName: z.string().min(1).max(160)',
    'description: z.string().min(0).max(1000)',
    'docType: z.enum(DOC_TYPE_VALUES)',
    'category: z.string().min(1).max(120)',
    'documentTags: z.array(z.string().min(1).max(64)).max(32)',
    'gitContextPath: z.string().min(1).max(1024)'
  ]);
  assertSchemaTerms(stdioSource, 'stdio source smart_search', [
    'inputSchema: SMART_SEARCH_ZOD_SCHEMA',
    'const SMART_SEARCH_ZOD_SCHEMA = z.object(SMART_SEARCH_ARG_SHAPE).strict();',
    "mode: z.enum(['auto', 'keyword', 'hybrid']).default('auto')",
    'limit: z.number().int().min(1).max(50).default(20)',
    'linkedTo: z.string().max(256)',
    'linkedFrom: z.string().max(256)',
    'filters: z.object({',
    'pathPrefix: z.string().max(512).refine(isSafeSmartSearchPathPrefix',
    'includeDiagnostics: z.boolean().default(false)'
  ]);
  assertSchemaTerms(normalizedBundleSource, 'generated bundle save_document', [
    'inputSchema: SAVE_DOCUMENT_ZOD_SCHEMA',
    'var SAVE_DOCUMENT_ZOD_SCHEMA = external_exports3.object(SAVE_DOCUMENT_ARG_SHAPE).strict();',
    'content: external_exports3.string().min(1).max(MAX_CONTENT_SIZE)',
    'title: external_exports3.string().min(1).max(200)',
    'project: external_exports3.string().min(1).max(120)',
    'docName: external_exports3.string().min(1).max(160)',
    'description: external_exports3.string().min(0).max(1e3)',
    'docType: external_exports3.enum(import_frontmatter.DOC_TYPE_VALUES)',
    'category: external_exports3.string().min(1).max(120)',
    'documentTags: external_exports3.array(external_exports3.string().min(1).max(64)).max(32)',
    'gitContextPath: external_exports3.string().min(1).max(1024)'
  ]);
  assertSchemaTerms(normalizedBundleSource, 'generated bundle smart_search', [
    'inputSchema: SMART_SEARCH_ZOD_SCHEMA',
    'var SMART_SEARCH_ZOD_SCHEMA = external_exports3.object(SMART_SEARCH_ARG_SHAPE).strict();',
    'mode: external_exports3.enum(["auto", "keyword", "hybrid"]).default("auto")',
    'limit: external_exports3.number().int().min(1).max(50).default(20)',
    'linkedTo: external_exports3.string().max(256)',
    'linkedFrom: external_exports3.string().max(256)',
    'filters: external_exports3.object({',
    'pathPrefix: external_exports3.string().max(512).refine(isSafeSmartSearchPathPrefix',
    'includeDiagnostics: external_exports3.boolean().default(false)'
  ]);

  const saveDocument = toolByName(TOOLS, 'save_document');
  const smartSearch = toolByName(TOOLS, 'smart_search');
  const openMarkdown = toolByName(TOOLS, 'open_markdown');
  const updateMarkdown = toolByName(TOOLS, 'update_markdown');
  wave2Assert(saveDocument, 'tool save_document exists');
  wave2Assert(smartSearch, 'tool smart_search exists');
  wave2Assert(openMarkdown, 'tool open_markdown exists');
  wave2Assert(updateMarkdown, 'tool update_markdown exists');

  const saveSchema = saveDocument.inputSchema || {};
  wave2Assert(saveSchema.additionalProperties === false, 'save_document rejects unknown fields');
  wave2Assert(Array.isArray(saveSchema.required) && saveSchema.required.length === 1 && saveSchema.required[0] === 'content', 'save_document requires only content');
  const saveProps = saveSchema.properties || {};
  wave2Assert(saveProps.content && saveProps.content.type === 'string' && saveProps.content.minLength === 1 && saveProps.content.maxLength === 10485760, 'save_document content schema is 1..10MB string');
  wave2Assert(saveProps.title && saveProps.title.type === 'string' && saveProps.title.minLength === 1 && saveProps.title.maxLength === 200, 'save_document title schema is 1..200 string');
  wave2Assert(saveProps.project && saveProps.project.type === 'string' && saveProps.project.minLength === 1 && saveProps.project.maxLength === 120, 'save_document project schema is 1..120 string');
  wave2Assert(saveProps.docName && saveProps.docName.type === 'string' && saveProps.docName.minLength === 1 && saveProps.docName.maxLength === 160, 'save_document docName schema is 1..160 string');
  wave2Assert(saveProps.description && saveProps.description.type === 'string' && saveProps.description.minLength === 0 && saveProps.description.maxLength === 1000, 'save_document description schema is 0..1000 string');
  wave2Assert(saveProps.docType && JSON.stringify(saveProps.docType.enum) === JSON.stringify(['note', 'plan', 'report', 'completion', 'issue', 'review', 'log', 'reference', 'guide', 'spec']), 'save_document docType schema uses DOC_TYPE_VALUES enum');
  wave2Assert(saveProps.category && saveProps.category.type === 'string' && saveProps.category.minLength === 1 && saveProps.category.maxLength === 120, 'save_document category schema is 1..120 string');
  wave2Assert(
    saveProps.documentTags &&
      saveProps.documentTags.type === 'array' &&
      saveProps.documentTags.maxItems === 32 &&
      saveProps.documentTags.items &&
      saveProps.documentTags.items.type === 'string' &&
      saveProps.documentTags.items.minLength === 1 &&
      saveProps.documentTags.items.maxLength === 64,
    'save_document documentTags schema is max 32 strings of 1..64 chars'
  );
  wave2Assert(saveProps.gitContextPath && saveProps.gitContextPath.type === 'string' && saveProps.gitContextPath.minLength === 1 && saveProps.gitContextPath.maxLength === 1024, 'save_document gitContextPath schema is 1..1024 string');
  wave2Assert(
    /title:\s*z\.string\(\)\.min\(1\)\.max\(200\)/.test(stdioSource) &&
      /project:\s*z\.string\(\)\.min\(1\)\.max\(120\)/.test(stdioSource) &&
      /docName:\s*z\.string\(\)\.min\(1\)\.max\(160\)/.test(stdioSource) &&
      /description:\s*z\.string\(\)\.min\(0\)\.max\(1000\)/.test(stdioSource) &&
      /docType:\s*z\.enum\(DOC_TYPE_VALUES\)/.test(stdioSource) &&
      /category:\s*z\.string\(\)\.min\(1\)\.max\(120\)/.test(stdioSource) &&
      /documentTags:\s*z\.array\(z\.string\(\)\.min\(1\)\.max\(64\)\)\.max\(32\)/.test(stdioSource) &&
      /gitContextPath:\s*z\.string\(\)\.min\(1\)\.max\(1024\)/.test(stdioSource),
    'stdio save_document schema fixes optional metadata type and length constraints'
  );
  for (const forbiddenField of [
    'noSave',
    'windowId',
    'windowName',
    'foreground',
    'alwaysOnTop',
    'size',
    'severity',
    'progress',
    'tags',
    'appendMode',
    'query',
    'limit',
    'mode',
    'filters',
    'forceIndex',
    'rebuild',
    'clearIndex',
    'cancel',
    'retry',
    'status',
    'filePath',
    'sourceFilePath',
    'path',
    'savePath',
    'outputPath',
    'destinationPath',
    'directory',
    'mcpAutoSavePath',
    'projectPath'
  ]) {
    wave2Assert(!Object.prototype.hasOwnProperty.call(saveSchema.properties || {}, forbiddenField), `save_document rejects ${forbiddenField}`);
  }

  wave2Assert(/persistent document store/i.test(saveDocument.description), 'save_document description is document-store first');
  wave2Assert(/no viewer|without opening|does not open/i.test(saveDocument.description), 'save_document description states no viewer side effect');
  wave2Assert(/persistent document metadata/i.test(saveProps.documentTags.description || ''), 'save_document documentTags description says persistent document metadata');
  wave2Assert(/Viewer\/window grouping tags/i.test(saveProps.documentTags.description || ''), 'save_document documentTags description distinguishes viewer window tags');
  wave2Assert(/not accepted by save_document/i.test(saveProps.documentTags.description || ''), 'save_document documentTags description says tags are not accepted');
  wave2Assert(/visible DocuLight viewer/i.test(openMarkdown.description) && /Use save_document instead/i.test(openMarkdown.description), 'open_markdown description distinguishes visible viewer from document-only save');
  wave2Assert(/existing visible DocuLight viewer window by windowId/i.test(updateMarkdown.description), 'update_markdown description is scoped to existing windowId updates');
  wave2Assert(stdioSource.includes('Use save_document instead when you only want to save Markdown') && stdioSource.includes('Update the content of an existing visible DocuLight viewer window by windowId.'), 'stdio descriptions distinguish viewer-backed open/update from save_document');

  const smartSchema = smartSearch.inputSchema || {};
  const serializedTypedSchemas = JSON.stringify({ saveSchema, smartSchema });
  for (const unsupportedSchemaFeature of ['oneOf', 'anyOf', 'allOf', '$ref', 'nullable']) {
    wave2Assert(
      !serializedTypedSchemas.includes(unsupportedSchemaFeature),
      `save_document and smart_search schemas avoid non-portable JSON Schema feature ${unsupportedSchemaFeature}`
    );
  }
  wave2Assert(smartSchema.properties && smartSchema.properties.limit && smartSchema.properties.limit.default === 20, 'smart_search limit defaults to 20');
  wave2Assert(smartSchema.properties.limit.maximum === 50, 'smart_search limit hard maximum is 50');
  wave2Assert((smartSchema.properties.mode.enum || []).join('|') === 'auto|keyword|hybrid', 'smart_search mode enum is auto|keyword|hybrid');
  wave2Assert(smartSchema.properties.filters && smartSchema.properties.filters.properties.pathPrefix, 'smart_search exposes source-relative pathPrefix filter');
  wave2Assert(smartSchema.properties.linkedTo && smartSchema.properties.linkedFrom, 'smart_search schema advertises top-level resolved link filters accepted by runtime');
  wave2Assert(!stdioSource.includes("requested: args && args.mode ? args.mode : 'auto'"), 'stdio smart_search validation errors do not echo raw requested mode');
  wave2Assert(
    /case 'search_documents':[\s\S]*await searchEngine\.ensureFresh\(\)[\s\S]*searchEngine\.search/.test(read('src/main/index.js')),
    'stdio IPC search_documents performs a freshness compatibility check before search'
  );
  wave2Assert(
    /async search_documents[\s\S]*await searchEngine\.ensureFresh\(\)[\s\S]*searchEngine\.search/.test(read('src/main/mcp-http.mjs')),
    'HTTP search_documents performs a freshness compatibility check before search'
  );

  for (const responseTerm of ['schemaVersion', 'degradationReasons', 'indexFreshness', 'staleFilteredCount']) {
    wave2Assert(stdioSource.includes(responseTerm) || bundleSource.includes(responseTerm), `smart_search response envelope includes ${responseTerm}`);
  }
  for (const bundleContractTerm of [
    'gitContextPath: external_exports3.string().min(1).max(1024)',
    'documentTags: external_exports3.array(external_exports3.string().min(1).max(64)).max(32)',
    'Save Markdown content to DocuLight',
    'persistent document store',
    'Response envelope includes schemaVersion'
  ]) {
    wave2Assert(bundleSource.includes(bundleContractTerm), `generated bundle preserves typed source contract term ${bundleContractTerm}`);
  }
  const stdioSaveToolSlice = stdioSource.slice(
    stdioSource.lastIndexOf('server.', stdioSource.indexOf("'save_document'")),
    stdioSource.lastIndexOf('server.', stdioSource.indexOf("'search_documents'"))
  );
  const stdioSmartToolSlice = stdioSource.slice(
    stdioSource.lastIndexOf('server.', stdioSource.indexOf("'smart_search'"))
  );
  const bundleSaveToolSlice = normalizedBundleSource.slice(
    normalizedBundleSource.lastIndexOf('server.', normalizedBundleSource.indexOf('"save_document"')),
    normalizedBundleSource.lastIndexOf('server.', normalizedBundleSource.indexOf('"search_documents"'))
  );
  const bundleSmartToolSlice = normalizedBundleSource.slice(
    normalizedBundleSource.lastIndexOf('server.', normalizedBundleSource.indexOf('"smart_search"'))
  );
  for (const toolSlice of [stdioSaveToolSlice, stdioSmartToolSlice, bundleSaveToolSlice, bundleSmartToolSlice]) {
    wave2Assert(toolSlice.includes('content') && toolSlice.includes('text') && toolSlice.includes('JSON.stringify'), 'v1 tool handler returns canonical JSON through content[0].text');
    wave2Assert(!toolSlice.includes('structuredContent'), 'v1 tool handler does not add structuredContent');
    wave2Assert(!toolSlice.includes('outputSchema'), 'v1 tool handler does not add outputSchema');
  }
  await validateStdioBridgeRuntime({
    serverPath: 'src/main/mcp-server.mjs',
    label: 'source',
    expectedToolNames
  });
  await validateStdioBridgeRuntime({
    serverPath: 'src/main/index.js',
    args: ['src/main/index.js', '--mcp-stdio'],
    label: 'main-entrypoint',
    expectedToolNames,
    extraEnv: {
      ELECTRON_RUN_AS_NODE: '1'
    }
  });
  await validateStdioBridgeRuntime({
    serverPath: 'src/main/mcp-server.bundle.mjs',
    label: 'bundle',
    expectedToolNames
  });

  console.log('test-wave2-mcp-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
