'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

function wave2Assert(condition, message) {
  assert(condition, `Wave 2 embedding model settings contract: ${message}`);
}

const preload = read('src/main/preload.js');
const main = read('src/main/index.js');
const settingsHtml = read('src/renderer/settings.html');
const settingsJs = read('src/renderer/settings.js');
const settingsCss = read('src/renderer/settings.css');
const searchEngineSource = read('src/main/search-engine.js');
const embeddingProviderPath = path.join(root, 'src/main/embedding-provider.js');
wave2Assert(fs.existsSync(embeddingProviderPath), 'main process has an OpenAI-compatible embedding provider module');
const embeddingProvider = read('src/main/embedding-provider.js');
const embeddingSettingsModule = read('src/main/embedding-settings.js');
const { createOpenAICompatibleEmbeddingProvider } = require('../src/main/embedding-provider');
const {
  createEmbeddingActivationRecord,
  migratePlaintextEmbeddingApiKey,
  normalizeEmbeddingActivationRecord,
  normalizeSecretMigrationState
} = require('../src/main/embedding-settings');
const embeddingSaveBlock = main.slice(
  main.indexOf("ipcMain.handle('embedding:save-model-settings'"),
  main.indexOf("ipcMain.handle('embedding:clear-model-settings'")
);
const embeddingClearBlock = main.slice(
  main.indexOf("ipcMain.handle('embedding:clear-model-settings'"),
  main.indexOf("// Navigate to a linked document")
);
const fingerprintBlock = main.slice(
  main.indexOf('function createEmbeddingFingerprint'),
  main.indexOf('function hasEmbeddingTransmissionConfirmation')
);
const activationRecordBlock = main.slice(
  main.indexOf("require('./embedding-settings')"),
  main.indexOf('function normalizeEmbeddingSemanticIndexing')
);
const embeddingValidationBlock = main.slice(
  main.indexOf('async function validateEmbeddingModelConfig'),
  main.indexOf('function normalizeOptionalPositiveInt')
);

wave2Assert(
  settingsHtml.includes('embedding-model-status') || settingsHtml.includes('embedding-status'),
  'Settings UI exposes embedding model settings status'
);
wave2Assert(
  settingsHtml.includes('embedding-policy-confirm-checkbox'),
  'Settings registration requires remote embedding retention/cost confirmation'
);
wave2Assert(
  settingsHtml.includes('id="embedding-registration-view"') &&
    settingsHtml.includes('class="settings-view embedding-registration-view hidden"'),
  'Settings registration uses an in-window settings view instead of a modal dialog'
);
wave2Assert(
  !settingsHtml.includes('id="embedding-modal"'),
  'Settings registration no longer uses a modal overlay'
);
wave2Assert(
  settingsHtml.includes('embedding-project-policy-mode') && settingsHtml.includes('embedding-project-policy-list'),
  'Settings registration exposes project policy controls'
);
wave2Assert(
  settingsHtml.includes('embedding-offline-only-checkbox'),
  'Settings registration exposes offline-only governance'
);
wave2Assert(
  /id="embedding-connect-btn"[^>]*disabled/.test(settingsHtml),
  'Settings registration keeps Connect disabled until background validation succeeds'
);

for (const apiName of [
  'getEmbeddingModelStatus',
  'validateEmbeddingModel',
  'saveEmbeddingModelSettings',
  'clearEmbeddingModelSettings'
]) {
  wave2Assert(preload.includes(`${apiName}:`), `preload exposes ${apiName}`);
  wave2Assert(settingsJs.includes(`window.doclight.${apiName}`), `settings renderer calls ${apiName}`);
}

for (const channel of [
  'embedding:get-status',
  'embedding:validate-model',
  'embedding:save-model-settings',
  'embedding:clear-model-settings'
]) {
  wave2Assert(main.includes(`'${channel}'`) || main.includes(`"${channel}"`), `main process registers ${channel}`);
}

wave2Assert(
  main.includes('sanitizeSettingsPayload(store.store)'),
  'get-settings returns a sanitized payload without stored embedding secrets'
);
wave2Assert(
  main.includes('settings.semanticSearch = sanitizeEmbeddingSettingsForRenderer(getStoredEmbeddingSettings())'),
  'get-settings sanitizes legacy semanticSearch endpoint values'
);
wave2Assert(
  (main.match(/store\.set\('semanticSearch'/g) || []).length === 3,
  'semanticSearch is persisted only after successful registration, offline-only save, or explicit removal'
);
wave2Assert(
  main.includes("key === 'semanticSearch'"),
  'generic save-settings IPC cannot bypass embedding registration validation'
);
wave2Assert(
  main.includes('indexingProgress') && !/return \{ \.\.\.settings, indexing: indexingStatus/.test(main),
  'embedding status exposes percent progress without raw indexing payloads'
);
wave2Assert(
  main.includes('hasEmbeddingTransmissionConfirmation') && main.includes('retention-cost-confirmation-required'),
  'main process rejects embedding registration without retention/cost confirmation'
);
wave2Assert(
  main.includes('EMBEDDING_DIMENSIONS_REQUIRED'),
  'embedding validation rejects models when dimensions cannot be discovered or configured'
);
wave2Assert(
  main.includes('normalizeEmbeddingProjectPolicy') && main.includes("statusReason: 'offline-only'"),
  'main process normalizes project policy and supports offline-only mode'
);
wave2Assert(
  main.includes('createEmbeddingActivationRecord') &&
    embeddingSettingsModule.includes('projectPolicyHash') &&
    embeddingSettingsModule.includes('endpointHost') &&
    embeddingSettingsModule.includes('retentionCostConfirmationVersion'),
  'remote embedding activation record stores endpoint host, model, retention/cost confirmation version, and project policy hash'
);
wave2Assert(
  main.includes('activationRecord: null') &&
    embeddingSaveBlock.includes('activationRecord: createEmbeddingActivationRecord') &&
    embeddingClearBlock.includes('activationRecord: null'),
  'offline-only mode and model removal clear remote embedding activation records'
);
wave2Assert(
  main.includes("require('./embedding-settings')") &&
    main.includes('createEmbeddingActivationRecord') &&
    main.includes('normalizeEmbeddingActivationRecord') &&
    main.includes('normalizeEmbeddingProjectPolicy'),
  'main process imports shared embedding settings activation record helpers'
);
wave2Assert(
  main.includes("Object.prototype.hasOwnProperty.call(input, 'offlineOnly')"),
  'current embedding save payload can override stored offline-only mode'
);
wave2Assert(
  main.includes('allowStoredKeyFallback') &&
    main.includes('getEmbeddingApiKey(input.apiKey, { allowStoredFallback: false })') &&
    main.includes('persistEmbeddingApiKey(settings?.apiKey, { replaceExisting: true })'),
  'blank API key during explicit registration does not reuse a stored key for a new provider'
);
wave2Assert(
  main.includes("settings.status === 'degraded'") && main.includes('noModelStatus'),
  'embedding status preserves no-model degraded or unreachable governance states'
);
wave2Assert(
  settingsJs.includes('retentionCostConfirmed') && settingsJs.includes('embeddingPolicyConfirmCheckbox'),
  'renderer sends explicit retention/cost confirmation state'
);
wave2Assert(
  settingsJs.includes('showEmbeddingRegistrationView') &&
    settingsJs.includes("setSettingsTitle('settings.embeddingModelRegister')") &&
    settingsJs.includes('embeddingRegistrationView.classList.remove'),
  'renderer opens embedding registration as a settings view with the page title updated'
);
wave2Assert(
  settingsJs.includes('closeEmbeddingRegistrationView') &&
    settingsJs.includes('showMainSettingsView()'),
  'renderer returns from embedding registration to the main settings view'
);
wave2Assert(
  settingsJs.includes('projectPolicy') && settingsJs.includes('offlineOnly'),
  'renderer sends project policy and offline-only governance state'
);
wave2Assert(
  embeddingSaveBlock && !embeddingSaveBlock.includes('startRebuild'),
  'successful embedding registration does not start broad search index rebuild'
);
wave2Assert(
  main.includes('semanticIndexing') &&
    main.includes("status: semanticReindex.skipped === true ? 'idle' : 'queued'") &&
    main.includes('queuedAt: semanticReindex.skipped === true ? null : validatedAt'),
  'successful embedding registration marks semantic indexing queued when a source root is configured without destructive rebuild'
);
wave2Assert(
  main.includes("status: semanticReindex.skipped === true ? 'idle' : 'queued'") &&
    main.includes('skippedReason: semanticReindex.skipped === true ? semanticReindex.reason : null'),
  'successful embedding registration can persist a connected model with idle semantic indexing when no document store source root is configured'
);
wave2Assert(
  embeddingSaveBlock.includes('queueSemanticReindexForActiveDocuments'),
  'successful embedding registration enqueues active documents through the settings-only indexing boundary'
);
wave2Assert(
  embeddingSaveBlock.indexOf('queueSemanticReindexForActiveDocuments') < embeddingSaveBlock.indexOf("store.set('semanticSearch', nextSettings)"),
  'embedding registration does not persist provider settings before semantic reindex enqueue succeeds'
);
wave2Assert(
  embeddingSaveBlock.includes("semantic-reindex-unavailable") &&
    embeddingSaveBlock.includes('semanticReindex.skipped !== true') &&
    embeddingSaveBlock.indexOf("semantic-reindex-unavailable") < embeddingSaveBlock.indexOf("store.set('semanticSearch', nextSettings)"),
  'embedding registration rejects hard semantic reindex enqueue failures before persisting provider settings'
);
wave2Assert(
  embeddingSaveBlock.includes('clearSemanticDerivedState') && embeddingClearBlock.includes('clearSemanticDerivedState'),
  'model change and removal clear or stale only semantic derived state'
);
wave2Assert(
  main.includes('embeddingConfigProvider: () => getStoredEmbeddingSettings()') &&
    main.includes('embeddingProvider: createOpenAICompatibleEmbeddingProvider'),
  'SearchEngine receives live embedding settings and OpenAI-compatible provider for background semantic indexing'
);
for (const fingerprintTerm of ['baseURLHash', 'dimensions', 'encodingFormat', 'chunkerVersion', 'normalization', 'hnswSpace', 'distanceMetric']) {
  wave2Assert(fingerprintBlock.includes(fingerprintTerm), `model fingerprint includes ${fingerprintTerm}`);
}
wave2Assert(
  main.includes('getSemanticIndexingProgress') && main.includes('semanticIndexingProgress'),
  'embedding model status uses semantic indexing job progress instead of keyword rebuild-only progress'
);
const semanticProgressBlock = searchEngineSource.slice(
  searchEngineSource.indexOf('getSemanticIndexingProgress()'),
  searchEngineSource.indexOf('getStatus(options = {})')
);
wave2Assert(
  semanticProgressBlock.includes("job.jobType === 'index_document'"),
  'embedding model status excludes keyword rebuild, compact, and clear jobs from semantic indexing progress'
);
wave2Assert(
  embeddingProvider.includes('/embeddings') &&
    embeddingProvider.includes('Authorization') &&
    embeddingProvider.includes('purpose') &&
    embeddingProvider.includes('extractEmbeddingVectors') &&
    embeddingProvider.includes('dimensions') &&
    embeddingProvider.includes('isApprovedEmbeddingEndpoint'),
  'embedding provider posts OpenAI-compatible embeddings requests without hard-coded local model information'
);
wave2Assert(
  settingsJs.indexOf("state === 'unreachable'") < settingsJs.indexOf('settings.embeddingModelUnset'),
  'renderer prioritizes unreachable embedding state over unset text'
);
wave2Assert(
  settingsJs.includes('function formatEmbeddingProviderHost') &&
    settingsJs.includes('status.activationRecord.endpointHost') &&
    settingsJs.includes('host: formatEmbeddingProviderHost(status)') &&
    !settingsJs.includes('host: status.baseURL ||'),
  'renderer displays provider host instead of raw baseURL for embedding model status'
);
wave2Assert(
  settingsJs.indexOf('window.doclight.validateEmbeddingModel') < settingsJs.indexOf('window.doclight.saveEmbeddingModelSettings(payload)'),
  'renderer validates embedding connection before saving provider settings'
);
wave2Assert(
  embeddingValidationBlock.includes('createOpenAICompatibleEmbeddingProvider') &&
    embeddingValidationBlock.includes("inputs: ['DocuLight embedding validation']") &&
    !embeddingValidationBlock.includes('validationBody.dimensions'),
  'Settings embedding validation uses the shared OpenAI-compatible provider dimension fallback'
);
wave2Assert(
  settingsJs.includes('EMBEDDING_VALIDATION_DEBOUNCE_MS') &&
    settingsJs.includes('function scheduleEmbeddingValidation') &&
    settingsJs.includes('async function validateEmbeddingRegistration') &&
    settingsJs.includes('let embeddingValidationSequence') &&
    settingsJs.includes('let embeddingValidationReady'),
  'renderer performs debounced background embedding validation and tracks the latest validation state'
);
wave2Assert(
  settingsJs.includes('embeddingConnectBtn.disabled = !embeddingValidationReady') &&
    settingsJs.includes('embeddingValidationInputs') &&
    settingsJs.includes("addEventListener('input', scheduleEmbeddingValidation)") &&
    settingsJs.includes("addEventListener('change', scheduleEmbeddingValidation)"),
  'renderer enables Connect only after the current registration inputs validate successfully'
);
wave2Assert(
  settingsJs.includes('validation.ok === true') &&
    !settingsJs.includes('validation.success || validation.ok') &&
    !settingsJs.includes('!validation.success && !validation.ok'),
  'renderer treats only ok=true embedding validation as a connectable remote model'
);
wave2Assert(
  main.includes('success: result.ok === true'),
  'main embedding validation IPC reports success only when model validation ok=true'
);
wave2Assert(
  settingsJs.includes('settings.embeddingValidationOfflineBlocked') &&
    settingsJs.indexOf('if (payload.offlineOnly)') < settingsJs.indexOf('settings.embeddingValidationOfflineBlocked') &&
    !/if \(payload\.offlineOnly\)[\s\S]{0,180}setEmbeddingValidationReady\(true\)/.test(settingsJs),
  'offline-only mode blocks remote Connect validation instead of enabling the Connect button'
);
wave2Assert(
  settingsJs.includes('let embeddingConnectionInProgress') &&
    settingsJs.includes('function setEmbeddingRegistrationInputsDisabled') &&
    settingsJs.includes('setEmbeddingRegistrationInputsDisabled(true)') &&
    settingsJs.includes('setEmbeddingRegistrationInputsDisabled(false)'),
  'renderer locks registration inputs while Connect is saving a validated payload'
);
wave2Assert(
  settingsJs.includes('function isEmbeddingChunkConfigValid') &&
    settingsJs.includes('settings.embeddingValidationInvalidChunk') &&
    settingsJs.includes('if (!isEmbeddingChunkConfigValid())'),
  'renderer rejects invalid chunk settings before enabling Connect'
);
wave2Assert(
  settingsJs.includes('settings.embeddingModelRemoveConfirm'),
  'renderer confirms embedding model removal'
);

wave2Assert(
  /chunk(?:Size)?[^0-9]{0,40}900/i.test(settingsHtml) || /chunk(?:Size)?[^0-9]{0,40}900/i.test(settingsJs),
  'chunk size default is 900 tokens'
);
wave2Assert(
  /chunk(?:Overlap)?[^0-9]{0,40}120/i.test(settingsHtml) || /chunk(?:Overlap)?[^0-9]{0,40}120/i.test(settingsJs),
  'chunk overlap default is 120 tokens'
);
wave2Assert(
  main.includes('normalizePositiveInt(input.chunkSize, EMBEDDING_DEFAULT_CHUNK_SIZE)') &&
    main.includes('normalizeNonNegativeInt(input.chunkOverlap, EMBEDDING_DEFAULT_CHUNK_OVERLAP)') &&
    main.includes('chunkSize: validation.chunkSize') &&
    main.includes('chunkOverlap: validation.chunkOverlap') &&
    main.includes('createEmbeddingFingerprint({ baseURL: normalized.baseURL, model, dimensions, chunkSize, chunkOverlap })'),
  'custom chunk size and non-negative overlap flow through validation, fingerprint, and saved chunker configuration'
);

wave2Assert(settingsCss.includes('embedding') && /success|connected/i.test(settingsCss), 'settings CSS has connected embedding status style');
wave2Assert(settingsCss.includes('embedding') && /error|unreachable|failed/i.test(settingsCss), 'settings CSS has unreachable embedding status style');

for (const locale of ['en', 'ko', 'ja', 'es']) {
  const data = JSON.parse(read(`src/locales/${locale}.json`));
  for (const key of [
    'settings.embeddingModel',
    'settings.embeddingModelUnset',
    'settings.embeddingModelUnreachable',
    'settings.embeddingModelConnected',
    'settings.embeddingModelRegister',
    'settings.embeddingProjectPolicy',
    'settings.embeddingProjectPolicyAllowAll',
    'settings.embeddingProjectPolicyAllowList',
    'settings.embeddingProjectPolicyDenyList',
    'settings.embeddingProjectPolicyList',
    'settings.embeddingProjectPolicyListPlaceholder',
    'settings.embeddingOfflineOnly',
    'settings.embeddingPolicyConfirm',
    'settings.embeddingPolicyRequired',
    'settings.embeddingValidationPending',
    'settings.embeddingValidationChecking',
    'settings.embeddingValidationReady',
    'settings.embeddingValidationOfflineBlocked',
    'settings.embeddingValidationInvalidChunk',
    'settings.embeddingModelRemoveConfirm'
  ]) {
    wave2Assert(Object.prototype.hasOwnProperty.call(data, key), `${locale} locale contains ${key}`);
  }
}

for (const [relativePath, content] of [
  ['src/main/index.js', main],
  ['src/main/preload.js', preload],
  ['src/renderer/settings.js', settingsJs]
]) {
  wave2Assert(!content.includes('model-api.txt'), `${relativePath} does not read model-api.txt in PH-001 contract code`);
  wave2Assert(!content.includes('sk-') && !content.includes('api_key='), `${relativePath} does not expose plaintext embedding credentials`);
}

const forbiddenLocalEndpoint = process.env.DOCULIGHT_TEST_FORBIDDEN_EMBEDDING_ENDPOINT || '';
const forbiddenLocalModel = process.env.DOCULIGHT_TEST_FORBIDDEN_EMBEDDING_MODEL || '';
const forbiddenLocalModelName = forbiddenLocalModel ? path.basename(forbiddenLocalModel) : '';
for (const [relativePath, content] of [
  ['src/main/index.js', main],
  ['src/main/embedding-provider.js', embeddingProvider],
  ['src/main/embedding-settings.js', embeddingSettingsModule],
  ['src/renderer/settings.js', settingsJs],
  ['test/test-wave2-embedding-settings-contract.js', read('test/test-wave2-embedding-settings-contract.js')],
  ['docs/spec/20.app-shell.srs.md', read('docs/spec/20.app-shell.srs.md')]
]) {
  if (forbiddenLocalEndpoint) {
    wave2Assert(!content.includes(forbiddenLocalEndpoint), `${relativePath} does not hard-code local embedding endpoint`);
  }
  if (forbiddenLocalModel) {
    wave2Assert(!content.includes(forbiddenLocalModel), `${relativePath} does not hard-code local embedding model`);
  }
  if (forbiddenLocalModelName) {
    wave2Assert(!content.includes(forbiddenLocalModelName), `${relativePath} does not hard-code local embedding model name`);
  }
}

(async () => {
  let rejectedUnapprovedEndpoint = false;
  const permissiveFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { data: [{ embedding: [1, 0, 0] }] };
    }
  });
  try {
    await createOpenAICompatibleEmbeddingProvider({ fetchImpl: permissiveFetch }).embed({
      baseURL: 'http://example.test/v1',
      model: 'fixture',
      inputs: ['blocked']
    });
  } catch (err) {
    rejectedUnapprovedEndpoint = err && err.code === 'embedding_endpoint_policy';
  }
  wave2Assert(rejectedUnapprovedEndpoint, 'embedding provider enforces HTTPS or approved local endpoint policy at request time');

  let requestBody = null;
  const provider = createOpenAICompatibleEmbeddingProvider({
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ embedding: [1, 0, 0] }] };
        }
      };
    }
  });
  await provider.embed({
    baseURL: 'https://example.test/v1',
    model: 'fixture',
    inputs: ['dimensioned'],
    dimensions: 3
  });
  wave2Assert(requestBody && requestBody.dimensions === 3, 'embedding provider sends configured dimensions when present');

  const dimensionFallbackRequests = [];
  const dimensionFallbackProvider = createOpenAICompatibleEmbeddingProvider({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      dimensionFallbackRequests.push(body);
      if (Object.prototype.hasOwnProperty.call(body, 'dimensions')) {
        return {
          ok: false,
          status: 400,
          async json() {
            return { error: { message: 'dimensions parameter is unsupported' } };
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ embedding: [1, 0, 0] }] };
        }
      };
    }
  });
  const fallbackResult = await dimensionFallbackProvider.embed({
    baseURL: 'https://example.test/v1',
    model: 'fixture',
    inputs: ['dimension-fallback'],
    dimensions: 3
  });
  wave2Assert(
    fallbackResult.embeddings[0].length === 3 &&
      dimensionFallbackRequests.length === 2 &&
      dimensionFallbackRequests[0].dimensions === 3 &&
      !Object.prototype.hasOwnProperty.call(dimensionFallbackRequests[1], 'dimensions'),
    'embedding provider retries without dimensions when an OpenAI-compatible endpoint rejects the dimensions parameter'
  );

  const unrelated400Requests = [];
  const unrelated400Provider = createOpenAICompatibleEmbeddingProvider({
    fetchImpl: async (_url, options) => {
      unrelated400Requests.push(JSON.parse(options.body));
      return {
        ok: false,
        status: 400,
        async json() {
          return { error: { message: 'model does not exist' } };
        }
      };
    }
  });
  let unrelated400Rejected = false;
  try {
    await unrelated400Provider.embed({
      baseURL: 'https://example.test/v1',
      model: 'missing-model',
      inputs: ['unrelated-400'],
      dimensions: 3
    });
  } catch (err) {
    unrelated400Rejected = err && err.code === 'embedding_endpoint_unreachable';
  }
  wave2Assert(
    unrelated400Rejected && unrelated400Requests.length === 1,
    'embedding provider does not retry non-dimension 400/422 failures'
  );

  const mismatchProvider = createOpenAICompatibleEmbeddingProvider({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (Object.prototype.hasOwnProperty.call(body, 'dimensions')) {
        return {
          ok: false,
          status: 400,
          async json() {
            return { error: { message: 'dimensions parameter is unsupported' } };
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ embedding: [1, 0] }] };
        }
      };
    }
  });
  let mismatchRejected = false;
  try {
    await mismatchProvider.embed({
      baseURL: 'https://example.test/v1',
      model: 'fixture',
      inputs: ['dimension-mismatch'],
      dimensions: 3
    });
  } catch (err) {
    mismatchRejected = err && err.code === 'embedding_dimensions_mismatch';
  }
  wave2Assert(
    mismatchRejected,
    'embedding provider rejects a dimensions fallback when the returned vector length does not match configured dimensions'
  );

  const activationRecord = createEmbeddingActivationRecord({
    endpointHost: 'Example.TEST:443',
    model: 'fixture-model',
    retentionCostConfirmationVersion: 'remote-embedding-v1',
    projectPolicy: { mode: 'allow-list', projects: ['Project-B', 'Project-A'] }
  });
  wave2Assert(activationRecord && activationRecord.endpointHost === 'example.test:443', 'activation record stores normalized endpoint host only');
  wave2Assert(
    JSON.stringify(Object.keys(activationRecord).sort()) === JSON.stringify([
      'endpointHost',
      'model',
      'projectPolicyHash',
      'provider',
      'retentionCostConfirmationVersion'
    ].sort()),
    'activation record stores only the allowed AC-6 fields'
  );
  wave2Assert(activationRecord.provider === 'openai-compatible', 'activation record stores provider');
  wave2Assert(activationRecord.model === 'fixture-model', 'activation record stores model');
  wave2Assert(activationRecord.retentionCostConfirmationVersion === 'remote-embedding-v1', 'activation record stores retention/cost confirmation version');
  wave2Assert(/^[a-f0-9]{16}$/.test(activationRecord.projectPolicyHash), 'activation record stores project policy hash');
  wave2Assert(!JSON.stringify(activationRecord).includes('Project-A'), 'activation record does not store raw project policy list');
  wave2Assert(!Object.prototype.hasOwnProperty.call(activationRecord, 'apiKey'), 'activation record does not expose API key fields');
  wave2Assert(!Object.prototype.hasOwnProperty.call(activationRecord, 'baseURL'), 'activation record does not expose raw endpoint URL fields');

  const pollutedRecord = normalizeEmbeddingActivationRecord({
    provider: 'openai-compatible',
    endpointHost: 'https://user:token@example.test/v1?api_key=x',
    model: 'fixture-model',
    retentionCostConfirmationVersion: 'remote-embedding-v1',
    projectPolicyHash: activationRecord.projectPolicyHash,
    apiKey: 'sk-should-not-survive',
    baseURL: 'https://user:token@example.test/v1?api_key=x'
  });
  wave2Assert(pollutedRecord === null, 'activation record normalizer rejects credential-bearing endpoint URL values');

  const noisyStoredRecord = normalizeEmbeddingActivationRecord({
    ...activationRecord,
    apiKey: 'sk-should-not-survive',
    baseURL: 'https://example.test/v1'
  });
  wave2Assert(noisyStoredRecord && !Object.prototype.hasOwnProperty.call(noisyStoredRecord, 'apiKey'), 'activation record normalizer drops unexpected API key fields');
  wave2Assert(noisyStoredRecord && !Object.prototype.hasOwnProperty.call(noisyStoredRecord, 'baseURL'), 'activation record normalizer drops unexpected raw endpoint fields');

  function createFakeStore(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
      get(key, fallback) {
        return values.has(key) ? values.get(key) : fallback;
      },
      set(key, value) {
        values.set(key, value);
      },
      delete(key) {
        values.delete(key);
      },
      snapshot() {
        return Object.fromEntries(values.entries());
      }
    };
  }

  const encryptedStore = createFakeStore({
    apiKey: 'sk-legacy-root-apiKey',
    embeddingApiKey: 'sk-legacy-root',
    semanticSearch: {
      enabled: false,
      apiKey: 'sk-legacy-semantic',
      apiKeyStorage: 'none',
      hasApiKey: false,
      activationRecord: {
        ...activationRecord,
        apiKey: 'sk-nested-secret',
        baseURL: 'https://user:token@example.test/v1?api_key=x'
      },
      secretMigration: {
        status: 'sk-hostile-status',
        migratedAt: 'api_key=hostile'
      }
    }
  });
  const migration = migratePlaintextEmbeddingApiKey({
    store: encryptedStore,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (secret) => Buffer.from(`encrypted:${secret}`, 'utf-8')
    },
    now: () => '2026-07-02T00:00:00.000Z'
  });
  const encryptedSnapshot = encryptedStore.snapshot();
  wave2Assert(migration.status === 'migrated_safeStorage', 'plaintext embedding API key migrates to safeStorage when encryption is available');
  wave2Assert(encryptedSnapshot.apiKey === undefined, 'plaintext root apiKey is removed after migration');
  wave2Assert(encryptedSnapshot.embeddingApiKey === undefined, 'plaintext root embedding API key is removed after migration');
  wave2Assert(encryptedSnapshot.semanticSearch && encryptedSnapshot.semanticSearch.apiKey === undefined, 'plaintext semanticSearch API key is removed after migration');
  wave2Assert(encryptedSnapshot.semanticSearch.activationRecord && !Object.prototype.hasOwnProperty.call(encryptedSnapshot.semanticSearch.activationRecord, 'apiKey'), 'migration removes nested activationRecord API key fields from store');
  wave2Assert(encryptedSnapshot.semanticSearch.activationRecord && !Object.prototype.hasOwnProperty.call(encryptedSnapshot.semanticSearch.activationRecord, 'baseURL'), 'migration removes nested activationRecord raw endpoint fields from store');
  wave2Assert(encryptedSnapshot.embeddingApiKeyCiphertext && !encryptedSnapshot.embeddingApiKeyCiphertext.includes('sk-legacy'), 'migration stores only encrypted API key ciphertext');
  wave2Assert(encryptedSnapshot.semanticSearch.secretMigration.status === 'migrated_safeStorage', 'migration records sanitized status code');
  wave2Assert(!JSON.stringify(encryptedSnapshot.semanticSearch.secretMigration).includes('sk-') && !JSON.stringify(encryptedSnapshot.semanticSearch.secretMigration).includes('api_key='), 'migration status does not expose secret-like values');

  const deleteStore = createFakeStore({
    embeddingApiKey: 'sk-delete-me',
    semanticSearch: { apiKeyStorage: 'none', hasApiKey: false }
  });
  const deleteMigration = migratePlaintextEmbeddingApiKey({
    store: deleteStore,
    safeStorage: { isEncryptionAvailable: () => false },
    now: () => '2026-07-02T00:00:00.000Z'
  });
  const deleteSnapshot = deleteStore.snapshot();
  wave2Assert(deleteMigration.status === 'deleted_plaintext', 'plaintext embedding API key is deleted when safeStorage and env fallback are unavailable');
  wave2Assert(deleteSnapshot.embeddingApiKey === undefined, 'deleted plaintext embedding API key is removed from store');
  wave2Assert(!deleteSnapshot.embeddingApiKeyCiphertext, 'delete fallback does not preserve plaintext as ciphertext');

  const envStore = createFakeStore({
    apiKey: 'sk-env-delete',
    semanticSearch: { apiKeyStorage: 'none', hasApiKey: false }
  });
  const envMigration = migratePlaintextEmbeddingApiKey({
    store: envStore,
    safeStorage: { isEncryptionAvailable: () => false },
    envKey: 'sk-env-fallback',
    now: () => '2026-07-02T00:00:00.000Z'
  });
  const envSnapshot = envStore.snapshot();
  wave2Assert(envMigration.status === 'deleted_plaintext_using_env', 'plaintext embedding API key is deleted while env fallback is recorded when available');
  wave2Assert(envSnapshot.apiKey === undefined && envSnapshot.semanticSearch.hasApiKey === true && envSnapshot.semanticSearch.apiKeyStorage === 'env', 'env fallback records sanitized secret storage state');

  const hostileMigration = normalizeSecretMigrationState({
    status: 'sk-hostile-status',
    migratedAt: 'api_key=hostile'
  });
  wave2Assert(hostileMigration === null, 'secret migration normalizer rejects hostile legacy status strings');

  console.log('test-wave2-embedding-settings-contract: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
