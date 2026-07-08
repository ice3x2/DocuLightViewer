'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const root = path.join(__dirname, '..');
  const { TOOLS } = await import('../src/main/mcp-http.mjs');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const builderYml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf-8');
  const stdioSource = fs.readFileSync(path.join(root, 'src/main/mcp-server.mjs'), 'utf-8');
  const bundleSource = fs.readFileSync(path.join(root, 'src/main/mcp-server.bundle.mjs'), 'utf-8');

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
  const httpNames = TOOLS.map((tool) => tool.name).sort();
  assert.deepStrictEqual(httpNames, expectedToolNames.slice().sort(), 'HTTP tools/list exposes the expected eight tools');

  for (const name of expectedToolNames) {
    assert(stdioSource.includes(`'${name}'`) || stdioSource.includes(`"${name}"`), `stdio source contains ${name}`);
    assert(bundleSource.includes(name), `stdio bundle contains ${name}`);
  }

  const httpSearch = TOOLS.find((tool) => tool.name === 'search_documents');
  const stdioToolNames = Array.from(stdioSource.matchAll(/server\.(?:tool|registerTool)\(\s*['"]([^'"]+)['"]/g)).map((m) => m[1]).sort();
  const bundleToolNames = Array.from(bundleSource.matchAll(/server\.(?:tool|registerTool)\(\s*['"]([^'"]+)['"]/g)).map((m) => m[1]).sort();
  assert.deepStrictEqual(stdioToolNames, expectedToolNames.slice().sort(), 'stdio source declares the expected eight tools');
  assert.deepStrictEqual(bundleToolNames, expectedToolNames.slice().sort(), 'stdio bundle declares the expected eight tools');

  assert(httpSearch.inputSchema.properties.docType, 'HTTP search_documents exposes docType');
  assert.strictEqual(httpSearch.inputSchema.required[0], 'query', 'HTTP search_documents requires query');
  assert.deepStrictEqual(httpSearch.inputSchema.properties.docType.enum, ['note', 'plan', 'report', 'completion', 'issue', 'review', 'log', 'reference', 'guide', 'spec'], 'HTTP search_documents docType enum matches DOC_TYPE_VALUES');
  assert(stdioSource.includes('docType: z.enum(DOC_TYPE_VALUES)'), 'stdio source search_documents exposes docType enum');
  assert(/server\.tool\(\s*'search_documents'[\s\S]*query:\s*z\.string\(\)/.test(stdioSource), 'stdio source search_documents requires query schema');
  assert(bundleSource.includes('docType') && bundleSource.includes('DOC_TYPE_VALUES'), 'bundle search_documents exposes docType enum');
  assert(/server\.tool\(\s*"search_documents"[\s\S]*query:\s*external_exports3\.string\(\)/.test(bundleSource), 'bundle search_documents requires query schema');
  assert(/sendIpcRequest\("search_documents",\s*\{\s*query,\s*limit,\s*project,\s*docType\s*\}\)/.test(bundleSource), 'bundle forwards query, limit, project, and docType filters');
  const httpSaveDocument = TOOLS.find((tool) => tool.name === 'save_document');
  const httpSmartSearch = TOOLS.find((tool) => tool.name === 'smart_search');
  assert(httpSaveDocument, 'HTTP exposes save_document');
  assert(httpSmartSearch, 'HTTP exposes smart_search');
  assert.strictEqual(httpSaveDocument.inputSchema.additionalProperties, false, 'HTTP save_document schema rejects additional properties');
  assert.deepStrictEqual(httpSaveDocument.inputSchema.required, ['content'], 'HTTP save_document requires only content');
  assert(httpSaveDocument.description.includes('persistent document store'), 'HTTP save_document description mentions persistent document store');
  assert(/does not open|no viewer|without showing/i.test(httpSaveDocument.description), 'HTTP save_document description says no viewer side effect');
  assert.strictEqual(httpSmartSearch.inputSchema.properties.limit.default, 20, 'HTTP smart_search default limit is 20');
  assert.strictEqual(httpSmartSearch.inputSchema.properties.limit.maximum, 50, 'HTTP smart_search maximum limit is 50');
  for (const forbidden of ['save_markdown', 'store_document', 'remember_document', 'rebuild_search_index', 'clear_search_index', 'cancel_indexing', 'retry_indexing']) {
    assert(!httpNames.includes(forbidden), `HTTP tools/list does not expose forbidden tool ${forbidden}`);
    assert(!stdioToolNames.includes(forbidden), `stdio source does not expose forbidden tool ${forbidden}`);
    assert(!bundleToolNames.includes(forbidden), `bundle does not expose forbidden tool ${forbidden}`);
  }

  assert(packageJson.scripts['bundle:mcp'].includes('--external:better-sqlite3'), 'MCP bundle keeps better-sqlite3 external');
  assert(packageJson.scripts['bundle:mcp'].includes('--external:hnswlib-node'), 'MCP bundle keeps hnswlib-node external');
  assert(packageJson.scripts['bundle:mcp'].includes('--outfile=src/main/mcp-server.bundle.mjs'), 'MCP bundle writes generated bundle');
  for (const hook of ['prebuild', 'prebuild:win', 'prebuild:mac', 'prebuild:linux']) {
    assert.strictEqual(packageJson.scripts[hook], 'npm run bundle:mcp', `${hook} regenerates MCP bundle`);
  }
  assert(builderYml.includes('src/main/mcp-server.bundle.mjs'), 'electron-builder asarUnpack includes MCP bundle');

  console.log('test-mcp-tool-parity: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
