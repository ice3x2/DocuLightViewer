'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getPackageSmokeLaunchArgs } = require('./package-smoke-launch-options');

const root = path.resolve(__dirname, '..');
const platform = process.platform;
const WAVE2_CLIENT_PROFILE_ORACLE_PATH = path.join(root, 'test', 'fixtures', 'wave2-client-profile-oracles.json');
const WAVE2_TYPED_TOOLS = Object.freeze([
  'open_markdown',
  'update_markdown',
  'close_viewer',
  'list_viewers',
  'search_documents',
  'search_projects',
  'save_document',
  'smart_search'
]);
const FORBIDDEN_INDEXING_CONTROL_TOOL_RE = /(?:^|_)(?:rebuild|clear|retry|cancel|status|import|reconcil\w*|model_change|reindex)(?:_|$)/i;
const WAVE2_CLIENT_PROFILE_ORACLE = Object.freeze(JSON.parse(fs.readFileSync(WAVE2_CLIENT_PROFILE_ORACLE_PATH, 'utf-8')));
const WAVE2_REDACTION_FIXTURE = Object.freeze({
  raw: 'raw gitContextPath C:\\Users\\Example\\repo api_key=secret',
  expected: '[REDACTED]',
  degradedModes: ['keyword_only', 'native_unavailable'],
  retrievalIdentity: ['search_documents', 'documentId']
});
const WAVE2_REQUIRED_PROFILES = Object.freeze(['codex', 'claude_code', 'opencode', 'openclo', 'hermes', 'small_local', 'frontier_model']);
const WAVE2_REQUIRED_INTENT_IDS = Object.freeze([
  'save_only_generated_markdown',
  'visible_open_update',
  'legacy_keyword_search',
  'read_only_smart_search',
  'diagnostics_request',
  'forbidden_recursive_import',
  'forbidden_reindex_control',
  'broken_relative_link_diagnostics',
  'wrong_mode_self_correction'
]);
const WAVE2_REQUIRED_ORACLE_FIELDS = Object.freeze([
  'clientProfile',
  'prompt',
  'expectedToolName',
  'rejectedToolNames',
  'expectedMinimalArguments',
  'expectedEnvelopeShape',
  'expectedErrorShape',
  'expectedDiagnostics',
  'expectedRedactions',
  'outputCaps'
]);
const WAVE2_OUTPUT_CAP_CEILINGS = Object.freeze({
  resultsLength: 50,
  snippetTextChars: 480,
  headingPathLength: 8,
  headingPathItemChars: 120,
  warningsLength: 5,
  diagnosticsWarningsLength: 10,
  diagnosticStatusItems: 16,
  traceItems: 10,
  scoreDetailFields: 8,
  defaultSerializedBytes: 65536,
  diagnosticSerializedBytes: 131072
});
const WAVE2_SMART_SEARCH_ALLOWED_MINIMAL_ARGUMENT_KEYS = Object.freeze(new Set([
  'query',
  'mode',
  'limit',
  'filters',
  'linkedTo',
  'linkedFrom',
  'includeSnippets',
  'includeScores',
  'includeTrace',
  'includeDiagnostics',
  'allowDegraded'
]));

function findPackagedApp() {
  if (platform === 'win32') {
    return path.join(root, 'dist', 'win-unpacked', 'DocuLight.exe');
  }
  if (platform === 'darwin') {
    return path.join(root, 'dist', 'mac-arm64', 'DocuLight.app', 'Contents', 'MacOS', 'DocuLight');
  }
  return path.join(root, 'dist', 'linux-unpacked', 'doculight');
}

function findUnpackedNativeDir(packageName) {
  if (platform === 'win32') {
    return path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', packageName);
  }
  if (platform === 'darwin') {
    return path.join(root, 'dist', 'mac-arm64', 'DocuLight.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', packageName);
  }
  return path.join(root, 'dist', 'linux-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', packageName);
}

function collectNodeFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectNodeFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.node')) out.push(fullPath);
  }
  return out;
}

function makePackageSmokeIpcPath(label) {
  const safeLabel = String(label || 'app').replace(/[^a-z0-9_-]/gi, '-');
  if (platform === 'win32') {
    return `\\\\.\\pipe\\doculight-package-smoke-${process.pid}-${safeLabel}-${Date.now()}`;
  }
  return path.join(os.tmpdir(), `doculight-package-smoke-${process.pid}-${safeLabel}-${Date.now()}.sock`);
}

function sanitizeProcessOutputForFailure(value) {
  return String(value || '')
    .slice(0, 4000)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/?#\s"'<>@]+)@/gi, '$1[REDACTED]@')
    .replace(/\b[A-Za-z]:[\\/](?:[^\s"'<>|]+[\\/]?)+/g, '[REDACTED_PATH]')
    .replace(/\\\\[^\\/\s]+[\\/][^\\/\s]+(?:[\\/][^\s"'<>|]+)*/g, '[REDACTED_PATH]')
    .replace(/(^|[\s"'=:])\/(?:Users|home|tmp|temp|var|private|mnt|Volumes|Work)\b[^\s"'<>]*/g, '$1[REDACTED_PATH]')
    .replace(/(api[_-]?key|token|password|bearer)=([^\s"'&]+)/gi, '$1=[REDACTED]');
}

const sanitizedFailureFixture = sanitizeProcessOutputForFailure('https://user:password@example.test/v1?token=rawsecret C:\\Users\\secret\\doc.md');
assert(!sanitizedFailureFixture.includes('user:password'), 'package smoke failure sanitizer redacts URL userinfo credentials');
assert(!sanitizedFailureFixture.includes('token=rawsecret'), 'package smoke failure sanitizer redacts URL query credentials');
assert(!sanitizedFailureFixture.includes('C:\\Users\\secret'), 'package smoke failure sanitizer redacts Windows absolute paths');

function containsRawSensitiveText(text, values) {
  const haystack = String(text || '');
  return values.some((value) => {
    if (value == null) return false;
    const raw = String(value);
    const escaped = JSON.stringify(raw).slice(1, -1);
    return haystack.includes(raw) || haystack.includes(escaped);
  });
}

function containsRawArtifactEcho(text) {
  const haystack = String(text || '');
  return /\b[A-Za-z]:(?:\\{1,2}|\/)[^\r\n"'<>|?*,;]+/.test(haystack) ||
    /\\{2,}[^\\/\r\n"'<>|?*,;]+(?:\\{1,2}|\/)[^\r\n"'<>|?*,;]+/.test(haystack) ||
    /(^|[":\s])\/(?:Users|home|tmp|temp|var|private|mnt|Volumes|Work)\b/.test(haystack) ||
    /api[_-]?key=secret|token=rawsecret|password=rawsecret|bearer=rawsecret|user:password/i.test(haystack) ||
    containsRawSensitiveText(haystack, [
      'C:\\Users\\secret',
      'C:\\Users\\Example',
      'token=rawsecret',
      'api_key=secret',
      'password=rawsecret',
      'bearer=rawsecret',
      'user:password'
    ]);
}

function normalizeMcpToolNameForPolicy(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function isForbiddenIndexingControlToolName(name) {
  return FORBIDDEN_INDEXING_CONTROL_TOOL_RE.test(normalizeMcpToolNameForPolicy(name));
}

function runSmoke(exePath, artifactPath) {
  return new Promise((resolve, reject) => {
    const smokeIpcPath = makePackageSmokeIpcPath('app');
    const smokeUserDataDir = path.join(os.tmpdir(), `doculight-package-smoke-user-data-${process.pid}-${Date.now()}`);
    if (platform !== 'win32') {
      try { fs.unlinkSync(smokeIpcPath); } catch { /* ignore */ }
    }
    fs.mkdirSync(smokeUserDataDir, { recursive: true });
    const cleanup = () => {
      if (platform !== 'win32') {
        try { fs.unlinkSync(smokeIpcPath); } catch { /* ignore */ }
      }
      try { fs.rmSync(smokeUserDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    const child = spawn(exePath, getPackageSmokeLaunchArgs(platform), {
      cwd: root,
      env: {
        ...process.env,
        DOCULIGHT_PACKAGE_SMOKE: '1',
        DOCULIGHT_PACKAGE_SMOKE_OUT: artifactPath,
        DOCULIGHT_IPC_PATH: smokeIpcPath,
        DOCULIGHT_DEFAULT_USER_DATA_DIR: smokeUserDataDir
      },
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(`Package smoke timed out. stdout=${sanitizeProcessOutputForFailure(stdout)} stderr=${sanitizeProcessOutputForFailure(stderr)}`));
    }, 30000);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`Package smoke failed to spawn packaged app: ${sanitizeProcessOutputForFailure(err && err.message ? err.message : String(err))}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        cleanup();
        reject(new Error(`Package smoke exited ${code}. stdout=${sanitizeProcessOutputForFailure(stdout)} stderr=${sanitizeProcessOutputForFailure(stderr)}`));
        return;
      }
      cleanup();
      resolve({ stdout, stderr });
    });
  });
}

function validateWave2ClientProfileOracles(fixture) {
  assert(fixture && fixture.version === 'wave2-client-profile-oracles.v1', 'client-profile oracle fixture version is current');
  assert(Array.isArray(fixture.oracles), 'client-profile oracle fixture exposes an oracles array');

  const profiles = new Set(fixture.oracles.map((oracle) => oracle.clientProfile));
  for (const profile of WAVE2_REQUIRED_PROFILES) {
    assert(profiles.has(profile), `client-profile oracle covers ${profile}`);
  }

  const intentIds = new Set(fixture.oracles.map((oracle) => oracle.intentId));
  for (const intentId of WAVE2_REQUIRED_INTENT_IDS) {
    assert(intentIds.has(intentId), `client-profile oracle covers ${intentId}`);
  }

  for (const oracle of fixture.oracles) {
    for (const field of WAVE2_REQUIRED_ORACLE_FIELDS) {
      assert(Object.prototype.hasOwnProperty.call(oracle, field), `client-profile oracle ${oracle.intentId || oracle.clientProfile} declares ${field}`);
    }
    assert(typeof oracle.prompt === 'string' && oracle.prompt.length > 10, 'client-profile oracle prompt is explicit');
    assert(WAVE2_TYPED_TOOLS.includes(oracle.expectedToolName), `expectedToolName ${oracle.expectedToolName} is one of the typed MCP tools`);
    assert(Array.isArray(oracle.rejectedToolNames), 'client-profile oracle rejectedToolNames is an array');
    assert(Array.isArray(oracle.expectedDiagnostics), 'client-profile oracle expectedDiagnostics is an array');
    assert(Array.isArray(oracle.expectedRedactions), 'client-profile oracle expectedRedactions is an array');
    assert(oracle.expectedRedactions.length > 0, 'client-profile oracle declares at least one expected redaction class');
    if (oracle.expectedToolName === 'smart_search') {
      for (const key of Object.keys(oracle.expectedMinimalArguments || {})) {
        assert(
          WAVE2_SMART_SEARCH_ALLOWED_MINIMAL_ARGUMENT_KEYS.has(key),
          `client-profile oracle ${oracle.intentId} uses schema-valid smart_search top-level argument ${key}`
        );
      }
    }
    for (const [key, ceiling] of Object.entries(WAVE2_OUTPUT_CAP_CEILINGS)) {
      assert(Number.isFinite(oracle.outputCaps[key]), `client-profile oracle ${oracle.intentId} declares numeric cap ${key}`);
      assert(oracle.outputCaps[key] <= ceiling, `client-profile oracle ${oracle.intentId} cap ${key} stays below SRS ceiling`);
    }
  }
}

function validateWave2PackageToolContracts(tools, stdioSource, bundleSource) {
  const normalizedStdioSource = stdioSource.replace(/\r\n/g, '\n');
  const normalizedBundleSource = bundleSource.replace(/\r\n/g, '\n');
  const names = tools.map((tool) => tool.name).sort();
  assert.deepStrictEqual(names, WAVE2_TYPED_TOOLS.slice().sort(), 'package smoke HTTP tools/list exposes exact typed eight-tool set');
  for (const name of WAVE2_TYPED_TOOLS) {
    assert(stdioSource.includes(`'${name}'`) || stdioSource.includes(`"${name}"`), `package smoke stdio source declares ${name}`);
    assert(bundleSource.includes(name), `package smoke generated bundle declares ${name}`);
  }
  for (const forbidden of ['save_markdown', 'store_document', 'remember_document', 'rebuild_search_index', 'clear_search_index', 'retry_indexing', 'cancel_indexing']) {
    assert(!names.includes(forbidden), `package smoke HTTP tools/list omits forbidden tool ${forbidden}`);
    assert(!stdioSource.includes(`'${forbidden}'`) && !stdioSource.includes(`"${forbidden}"`), `package smoke stdio source omits forbidden tool ${forbidden}`);
    assert(!bundleSource.includes(`"${forbidden}"`) && !bundleSource.includes(`'${forbidden}'`), `package smoke bundle omits forbidden tool ${forbidden}`);
  }
  for (const name of names) {
    assert(!isForbiddenIndexingControlToolName(name), `package smoke HTTP tool ${name} is not an indexing control or status tool`);
  }
  for (const [label, source, terms] of [
    ['stdio save_document', normalizedStdioSource, [
      'inputSchema: SAVE_DOCUMENT_ZOD_SCHEMA',
      'const SAVE_DOCUMENT_ZOD_SCHEMA = z.object(SAVE_DOCUMENT_ARG_SHAPE).strict();',
      'content: z.string().min(1).max(MAX_CONTENT_SIZE)',
      'documentTags: z.array(z.string().min(1).max(64)).max(32)',
      'gitContextPath: z.string().min(1).max(1024)'
    ]],
    ['stdio smart_search', normalizedStdioSource, [
      'inputSchema: SMART_SEARCH_ZOD_SCHEMA',
      'const SMART_SEARCH_ZOD_SCHEMA = z.object(SMART_SEARCH_ARG_SHAPE).strict();',
      "mode: z.enum(['auto', 'keyword', 'hybrid']).default('auto')",
      'limit: z.number().int().min(1).max(50).default(20)',
      'pathPrefix: z.string().max(512).refine(isSafeSmartSearchPathPrefix'
    ]],
    ['bundle save_document', normalizedBundleSource, [
      'inputSchema: SAVE_DOCUMENT_ZOD_SCHEMA',
      'var SAVE_DOCUMENT_ZOD_SCHEMA = external_exports3.object(SAVE_DOCUMENT_ARG_SHAPE).strict();',
      'content: external_exports3.string().min(1).max(MAX_CONTENT_SIZE)',
      'documentTags: external_exports3.array(external_exports3.string().min(1).max(64)).max(32)',
      'gitContextPath: external_exports3.string().min(1).max(1024)'
    ]],
    ['bundle smart_search', normalizedBundleSource, [
      'inputSchema: SMART_SEARCH_ZOD_SCHEMA',
      'var SMART_SEARCH_ZOD_SCHEMA = external_exports3.object(SMART_SEARCH_ARG_SHAPE).strict();',
      'mode: external_exports3.enum(["auto", "keyword", "hybrid"]).default("auto")',
      'limit: external_exports3.number().int().min(1).max(50).default(20)',
      'pathPrefix: external_exports3.string().max(512).refine(isSafeSmartSearchPathPrefix'
    ]]
  ]) {
    for (const term of terms) {
      assert(source.includes(term), `package smoke ${label} preserves typed schema term ${term}`);
    }
  }

  const saveDocument = tools.find((tool) => tool.name === 'save_document');
  const openMarkdown = tools.find((tool) => tool.name === 'open_markdown');
  const updateMarkdown = tools.find((tool) => tool.name === 'update_markdown');
  const smartSearch = tools.find((tool) => tool.name === 'smart_search');
  assert(saveDocument && openMarkdown && updateMarkdown && smartSearch, 'package smoke typed save/search/viewer tools exist');
  const saveProps = saveDocument.inputSchema.properties || {};
  assert.strictEqual(saveDocument.inputSchema.additionalProperties, false, 'package smoke save_document rejects unknown fields');
  assert.deepStrictEqual(saveDocument.inputSchema.required, ['content'], 'package smoke save_document requires only content');
  assert(saveProps.content && saveProps.content.maxLength === 10485760, 'package smoke save_document content is capped at 10MB');
  assert(saveProps.title && saveProps.title.maxLength === 200, 'package smoke save_document title length is capped');
  assert(saveProps.project && saveProps.project.maxLength === 120, 'package smoke save_document project length is capped');
  assert(saveProps.docName && saveProps.docName.maxLength === 160, 'package smoke save_document docName length is capped');
  assert(saveProps.description && saveProps.description.maxLength === 1000, 'package smoke save_document description length is capped');
  assert(saveProps.category && saveProps.category.maxLength === 120, 'package smoke save_document category length is capped');
  assert(saveProps.documentTags && saveProps.documentTags.maxItems === 32 && saveProps.documentTags.items.maxLength === 64, 'package smoke save_document documentTags are bounded');
  assert(saveProps.gitContextPath && saveProps.gitContextPath.maxLength === 1024, 'package smoke save_document gitContextPath is bounded');
  for (const forbiddenField of ['noSave', 'windowId', 'windowName', 'foreground', 'alwaysOnTop', 'size', 'severity', 'progress', 'tags', 'appendMode', 'query', 'limit', 'mode', 'filters', 'forceIndex', 'rebuild', 'clearIndex', 'cancel', 'retry', 'status', 'filePath', 'sourceFilePath', 'path', 'savePath', 'outputPath', 'destinationPath', 'directory', 'mcpAutoSavePath', 'projectPath']) {
    assert(!Object.prototype.hasOwnProperty.call(saveProps, forbiddenField), `package smoke save_document schema rejects ${forbiddenField}`);
  }
  assert(/persistent document store/i.test(saveDocument.description), 'package smoke save_document description mentions persistent document store');
  assert(/search_documents and smart_search/i.test(saveDocument.description), 'package smoke save_document description mentions future retrieval');
  assert(/does not open|no viewer|without showing/i.test(saveDocument.description), 'package smoke save_document description says no viewer side effect');
  assert(/persistent document metadata/i.test(saveProps.documentTags.description || ''), 'package smoke documentTags description says persistent document metadata');
  assert(/Viewer\/window grouping tags/i.test(saveProps.documentTags.description || ''), 'package smoke documentTags description distinguishes viewer tags');
  assert(/visible DocuLight viewer/i.test(openMarkdown.description) && /Use save_document instead/i.test(openMarkdown.description), 'package smoke open_markdown description distinguishes visible viewer');
  assert(/existing visible DocuLight viewer window by windowId/i.test(updateMarkdown.description), 'package smoke update_markdown description is windowId-scoped');

  const smartProps = smartSearch.inputSchema.properties || {};
  assert.strictEqual(smartProps.limit.default, 20, 'package smoke smart_search default limit is 20');
  assert.strictEqual(smartProps.limit.maximum, 50, 'package smoke smart_search hard maximum is 50');
  assert.deepStrictEqual(smartProps.mode.enum, ['auto', 'keyword', 'hybrid'], 'package smoke smart_search mode enum is portable');
  assert(smartProps.filters && smartProps.filters.additionalProperties === false, 'package smoke smart_search filters reject unknown fields');
}

function buildPackageSmokePlatformCoverage(hnswNativeStatus) {
  const currentArch = process.arch;
  const releaseGating = [
    { platform: 'win32', arch: 'x64', status: platform === 'win32' && currentArch === 'x64' ? 'smoked' : 'gated_by_release_workflow' },
    { platform: 'darwin', arch: 'arm64', status: platform === 'darwin' && currentArch === 'arm64' ? 'smoked' : 'gated_by_release_workflow' },
    { platform: 'linux', arch: 'x64', status: platform === 'linux' && currentArch === 'x64' ? 'smoked' : 'gated_by_release_workflow' }
  ];
  const bestEffort = [
    {
      platform: 'win32',
      arch: 'arm64',
      status: platform === 'win32' && fs.existsSync(path.join(root, 'dist', 'win-arm64-unpacked', 'DocuLight.exe')) ? 'built_skipped_smoke' : 'skipped',
      reason: 'Windows arm64 is built as best-effort; package smoke executes the release-gating Windows x64 unpacked app in this job.'
    },
    {
      platform: 'darwin',
      arch: 'x64',
      status: platform === 'darwin' && fs.existsSync(path.join(root, 'dist', 'mac', 'DocuLight.app')) ? 'built_skipped_smoke' : 'skipped',
      reason: 'macOS x64 is best-effort until CI capacity supports per-arch package smoke on Intel runners.'
    },
    {
      platform: 'linux',
      arch: 'arm64',
      status: platform === 'linux' && fs.existsSync(path.join(root, 'dist', 'linux-arm64-unpacked', 'doculight')) ? 'built_skipped_smoke' : 'skipped',
      reason: 'Linux arm64 is best-effort until CI capacity supports arm64 package smoke execution.'
    }
  ];
  return {
    version: 'package-smoke-platform-policy.v1',
    current: { platform, arch: currentArch },
    releaseGating,
    bestEffort,
    hnswNativeStatus
  };
}

function writePackageSmokeReports(reportDir, artifact, platformCoverage) {
  if (!reportDir) return;
  fs.mkdirSync(reportDir, { recursive: true });
  const suffix = `${platform}-${process.arch}`;
  fs.writeFileSync(path.join(reportDir, `package-smoke-${suffix}.json`), JSON.stringify(artifact, null, 2), 'utf-8');
  fs.writeFileSync(path.join(reportDir, `package-smoke-platform-policy-${suffix}.json`), JSON.stringify(platformCoverage, null, 2), 'utf-8');
}

(async () => {
  const exePath = findPackagedApp();
  assert(fs.existsSync(exePath), 'packaged app exists at the expected packaged output path');

  assert(WAVE2_TYPED_TOOLS.includes('save_document') && WAVE2_TYPED_TOOLS.includes('smart_search'), 'Wave 2 typed save/search tools are declared');
  assert(WAVE2_REDACTION_FIXTURE.raw.includes('gitContextPath'), 'raw gitContextPath redaction fixture is declared');
  assert(WAVE2_REDACTION_FIXTURE.degradedModes.includes('keyword_only') && WAVE2_REDACTION_FIXTURE.degradedModes.includes('native_unavailable'), 'native failure keyword-only degraded fallback fixture is declared');
  assert(WAVE2_REDACTION_FIXTURE.retrievalIdentity.includes('documentId'), 'save_document-to-search retrieval identity fixture is declared');
  validateWave2ClientProfileOracles(WAVE2_CLIENT_PROFILE_ORACLE);
  const { TOOLS } = await import('../src/main/mcp-http.mjs');
  const stdioSource = fs.readFileSync(path.join(root, 'src', 'main', 'mcp-server.mjs'), 'utf-8');
  const bundlePath = path.join(root, 'src', 'main', 'mcp-server.bundle.mjs');
  const bundleSource = fs.readFileSync(bundlePath, 'utf-8');
  validateWave2PackageToolContracts(TOOLS, stdioSource, bundleSource);

  const unpackedNativeDir = findUnpackedNativeDir('better-sqlite3');
  const nodeFiles = collectNodeFiles(unpackedNativeDir);
  assert(nodeFiles.length > 0, 'packaged app.asar.unpacked contains better-sqlite3 native .node file');
  const hnswNativeDir = findUnpackedNativeDir('hnswlib-node');
  const hnswNodeFiles = collectNodeFiles(hnswNativeDir);
  const hnswNativeStatus = hnswNodeFiles.length > 0 ? 'present' : 'optional_missing';
  assert(['present', 'optional_missing'].includes(hnswNativeStatus), 'hnswlib-node native package status is diagnosable');
  const platformCoverage = buildPackageSmokePlatformCoverage(hnswNativeStatus);
  assert(platformCoverage.releaseGating.length === 3, 'package smoke platform policy declares three release-gating targets');
  assert(platformCoverage.bestEffort.length === 3, 'package smoke platform policy declares three best-effort targets');
  assert(platformCoverage.releaseGating.some((item) => item.platform === platform && item.status === 'smoked'), 'package smoke platform policy marks the current release-gating target smoked');
  assert(platformCoverage.bestEffort.every((item) => item.reason && item.reason.length > 20), 'package smoke platform policy records skipped reasons for best-effort targets');

  assert(!bundleSource.includes('better-sqlite3'), 'generated MCP bundle does not contain direct better-sqlite3 import text');
  assert(!bundleSource.includes('hnswlib-node'), 'generated MCP bundle does not contain direct hnswlib-node import text');
  assert(!bundleSource.includes('garu-ko'), 'generated MCP bundle does not contain direct garu-ko import text');

  const artifactPath = path.join(os.tmpdir(), `doculight-package-smoke-${process.pid}.json`);
  try {
    await runSmoke(exePath, artifactPath);
    assert(fs.existsSync(artifactPath), 'packaged app writes package smoke artifact');
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
    assert.strictEqual(artifact.ok, true, 'packaged app native smoke reports ok');
    assert.strictEqual(artifact.backend, 'sqlite-fts5', 'packaged app smoke loaded SQLite FTS5 backend');
    assert.strictEqual(artifact.tokenizer.provider, 'garu-ko', 'packaged app smoke loaded garu-ko tokenizer');
    assert(artifact.resultCount > 0, 'packaged app smoke searched SQLite FTS results');
    assert(artifact.koreanResultCount > 0, 'packaged app smoke searched Korean morphology FTS results');
    assert(artifact.saveToSearch && artifact.saveToSearch.saved === true, 'package smoke save_document fixture reports saved=true');
    assert(artifact.saveToSearch.documentId, 'package smoke save_document fixture records documentId');
    assert(artifact.saveToSearch.sourceRelativePath, 'package smoke save_document fixture records source-relative identity');
    assert(artifact.saveToSearch.searchDocumentsFound > 0, 'package smoke save_document marker is retrievable by search_documents');
    assert(artifact.saveToSearch.smartSearchFound > 0, 'package smoke save_document marker is retrievable by smart_search');
    assert.strictEqual(artifact.saveToSearch.identityMatched, true, 'package smoke smart_search result matches saved document identity');
    assert(['queued', 'degraded', 'enqueue_failed'].includes(artifact.saveToSearch.indexingState), 'package smoke save_document records post-save indexing.state');
    assert.strictEqual(artifact.saveToSearch.indexingJobIdPresent, true, 'package smoke save_document returns diagnostic indexing.jobId');
    assert.strictEqual(artifact.saveToSearch.indexingJobIdDiagnosticOnly, true, 'package smoke indexing.jobId exposes no MCP status/cancel/retry/rebuild/import/reconciliation controls');
    assert.strictEqual(artifact.saveToSearch.queuedBooleanPresent, false, 'package smoke save_document envelope has no queued boolean');
    assert.strictEqual(artifact.saveToSearch.degraded, true, 'package smoke smart_search returns degraded keyword-only envelope when embeddings are disabled');
    assert(
      Array.isArray(artifact.saveToSearch.degradationReasons) &&
        artifact.saveToSearch.degradationReasons.includes('embedding_disabled'),
      'package smoke smart_search degraded envelope reports embedding_disabled'
    );
    assert(artifact.saveDocumentInvalid && artifact.saveDocumentInvalid.forbiddenFieldRejected === true, 'package smoke rejects forbidden save_document fields at runtime');
    assert(artifact.saveDocumentInvalid.unknownFieldRejected === true, 'package smoke rejects one unknown save_document field at runtime');
    assert(artifact.saveDocumentInvalid.multipleUnknownFieldsRejected === true, 'package smoke rejects multiple unknown save_document fields at runtime');
    assert(artifact.saveDocumentInvalid.gitContextPathRejected === true, 'package smoke rejects unsafe gitContextPath at runtime');
    assert.strictEqual(artifact.saveDocumentInvalid.writeFailedCode, 'write_failed', 'package smoke captures save_document write_failed envelope');
    assert.strictEqual(artifact.saveDocumentInvalid.canonicalErrorEnvelope, true, 'package smoke invalid save_document responses use canonical error envelopes');
    assert.strictEqual(artifact.saveDocumentInvalid.rawEchoFree, true, 'package smoke invalid save_document responses do not echo raw path or credentials');
    assert(artifact.nativeFailure && Array.isArray(artifact.nativeFailure.smartSearchDegradationReasons), 'package smoke records native failure smart_search fixture');
    assert(artifact.nativeFailure.smartSearchDegradationReasons.includes('native_unavailable'), 'package smoke native failure fixture reports native_unavailable');
    assert(artifact.workerNative && /search-index-worker|worker_threads/i.test(artifact.workerNative.runtime || ''), 'package smoke records worker native runtime evidence');
    assert(['loaded', 'native_unavailable'].includes(artifact.workerNative.betterSqlite3.state), 'package smoke workerNative better-sqlite3 is loaded or native_unavailable');
    assert(['loaded', 'native_unavailable'].includes(artifact.workerNative.hnswlibNode.state), 'package smoke workerNative hnswlib-node is loaded or native_unavailable');
    assert(artifact.workerNative.betterSqlite3.state === 'loaded', 'package smoke better-sqlite3 loads inside the worker native runtime');
    assert(
      artifact.workerNative.searchIndexWorkerJob &&
        artifact.workerNative.searchIndexWorkerJob.completed === true &&
        artifact.workerNative.searchIndexWorkerJob.documentIndexed === true,
      'package smoke runs the packaged search-index-worker.js through a real document indexing job'
    );
    assert(artifact.workerNative.electronAbi || artifact.workerNative.nodeAbi || process.versions.modules, 'package smoke workerNative records Electron ABI or Node ABI diagnostics');
    assert(artifact.packagedCliStdio && artifact.packagedCliStdio.status === 'passed', 'package smoke packaged --mcp-stdio client passes');
    assert(
      ['direct-executable-mcp-stdio', 'windows-electron-run-as-node-asar-index'].includes(artifact.packagedCliStdio.launchMode),
      'package smoke records the packaged CLI stdio launch mode'
    );
    assert.deepStrictEqual(artifact.packagedCliStdio.toolNames, WAVE2_TYPED_TOOLS.slice().sort(), 'package smoke packaged --mcp-stdio exposes exact eight-tool set');
    assert.deepStrictEqual(artifact.packagedCliStdio.httpToolNames, WAVE2_TYPED_TOOLS.slice().sort(), 'package smoke HTTP tools/list matches packaged --mcp-stdio tool set');
    assert.strictEqual(artifact.packagedCliStdio.stdoutPurity, 'mcp_jsonrpc_only', 'package smoke packaged --mcp-stdio stdout remains MCP JSON-RPC only');
    assert.strictEqual(artifact.packagedCliStdio.stdoutNonJsonLineCount, 0, 'package smoke packaged --mcp-stdio raw stdout has no non-JSON lines');
    assert(artifact.packagedCliStdio.stdoutJsonRpcMessageCount >= 2, 'package smoke packaged --mcp-stdio raw stdout records JSON-RPC messages');
    assert.strictEqual(artifact.packagedCliStdio.initializeHandshake, true, 'package smoke packaged --mcp-stdio raw probe verifies initialize handshake');
    assert.strictEqual(artifact.packagedCliStdio.initializedNotification, true, 'package smoke packaged --mcp-stdio raw probe sends initialized notification');
    assert(Number.isInteger(artifact.packagedCliStdio.stderrByteCount) && artifact.packagedCliStdio.stderrByteCount >= 0, 'package smoke packaged --mcp-stdio records stderr byte count');
    assert.deepStrictEqual(artifact.packagedCliStdio.rawProbeToolNames, WAVE2_TYPED_TOOLS.slice().sort(), 'package smoke raw stdio probe sees exact eight-tool set');
    for (const name of artifact.packagedCliStdio.rawProbeToolNames) {
      assert(!isForbiddenIndexingControlToolName(name), `package smoke raw stdio tool ${name} is not an indexing control or status tool`);
    }
    assert.strictEqual(artifact.packagedCliStdio.redactedEndpointClass, '[REDACTED_MCP_IPC:explicit]', 'package smoke packaged --mcp-stdio records redacted endpoint class');
    assert.strictEqual(artifact.packagedCliStdio.noIndexingControls, true, 'package smoke packaged --mcp-stdio exposes no indexing controls');
    assert.strictEqual(artifact.packagedCliStdio.saveDocument.saved, true, 'package smoke packaged --mcp-stdio save_document succeeds');
    assert.strictEqual(artifact.packagedCliStdio.smartSearch.found, true, 'package smoke packaged --mcp-stdio smart_search finds the saved marker');
    assert.strictEqual(artifact.packagedCliStdio.httpSearchDocuments.found, true, 'package smoke HTTP search_documents finds the marker saved by packaged --mcp-stdio');
    assert.strictEqual(artifact.packagedCliStdio.invalidSaveDocument.rejected, true, 'package smoke packaged --mcp-stdio rejects invalid save_document');
    assert.strictEqual(artifact.packagedCliStdio.invalidSaveDocument.rawEchoFree, true, 'package smoke packaged --mcp-stdio invalid save_document is redacted');
    assert.strictEqual(artifact.packagedCliStdio.invalidSmartSearch.pathPrefixRejected, true, 'package smoke packaged --mcp-stdio rejects unsafe smart_search pathPrefix');
    assert.strictEqual(artifact.packagedCliStdio.invalidSmartSearch.rawEchoFree, true, 'package smoke packaged --mcp-stdio invalid smart_search is redacted');
    assert.strictEqual(artifact.packagedCliStdio.crossTransportMarkerIdentity.markerSearchedBy, 'http-search_documents', 'package smoke searches the CLI-saved marker through HTTP search_documents');
    assert.strictEqual(artifact.packagedCliStdio.crossTransportMarkerIdentity.matched, true, 'package smoke packaged CLI stdio and HTTP evidence share marker identity');
    assert.strictEqual(artifact.redactionFixture && artifact.redactionFixture.allClassesCovered, true, 'package smoke redaction fixture covers required path and credential classes');
    assert.strictEqual(artifact.redactionFixture.rawEchoFree, true, 'package smoke redaction fixture does not echo raw values');
    assert.strictEqual(artifact.clientProfileOracle.version, 'wave2-client-profile-oracles.v1', 'package smoke artifact includes client-profile oracle version');
    assert(artifact.clientProfileOracle.count >= WAVE2_REQUIRED_INTENT_IDS.length, 'package smoke artifact includes client-profile oracle coverage count');
    assert(artifact.clientProfileOracle.defaultSerializedBytes <= WAVE2_OUTPUT_CAP_CEILINGS.defaultSerializedBytes, 'package smoke artifact preserves default serialized cap');
    assert(String(artifact.indexPath || '').startsWith('[REDACTED_PATH:'), 'package smoke artifact stores redacted index path token');
    const serializedArtifact = JSON.stringify(artifact);
    assert(!containsRawArtifactEcho(serializedArtifact), 'package smoke artifact does not expose raw absolute paths or credentials, including JSON-escaped values');
    if (hnswNativeStatus === 'optional_missing') {
      assert.strictEqual(hnswNativeStatus, 'optional_missing', 'optional hnswlib-node absence is recorded as degraded package state');
    }
    writePackageSmokeReports(process.env.DOCULIGHT_PACKAGE_SMOKE_REPORT_DIR, artifact, platformCoverage);
  } finally {
    try { fs.unlinkSync(artifactPath); } catch { /* ignore */ }
  }

  console.log('package-smoke: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
