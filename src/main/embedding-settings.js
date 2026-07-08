'use strict';

const crypto = require('crypto');

const EMBEDDING_PROJECT_POLICY_MODES = new Set(['allow-all', 'allow-list', 'deny-list']);
const SECRET_MIGRATION_STATUSES = new Set([
  'migrated_safeStorage',
  'deleted_plaintext',
  'deleted_plaintext_using_env'
]);

function normalizeEmbeddingProjectPolicy(rawPolicy = {}) {
  const policy = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  const mode = EMBEDDING_PROJECT_POLICY_MODES.has(policy.mode) ? policy.mode : 'allow-all';
  const projectsInput = Array.isArray(policy.projects)
    ? policy.projects
    : String(policy.projects || '').split(/[\n,]/);
  const projects = projectsInput
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 200);
  return { mode, projects };
}

function createProjectPolicyHash(projectPolicy) {
  const normalized = normalizeEmbeddingProjectPolicy(projectPolicy);
  const canonical = {
    mode: normalized.mode,
    projects: [...normalized.projects].sort((a, b) => a.localeCompare(b, 'en'))
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 16);
}

function normalizeEndpointHost(rawHost) {
  const value = String(rawHost || '').trim().toLowerCase();
  if (!value || value.length > 253 || /[\s/?#\\@]/.test(value)) return '';

  let host = '';
  let port = '';
  if (value.startsWith('[')) {
    const match = value.match(/^(\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/i);
    if (!match) return '';
    host = match[1];
    port = match[2] || '';
  } else {
    const match = value.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/i);
    if (!match) return '';
    host = match[1];
    port = match[2] || '';
    if (!host || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return '';
  }

  if (port) {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) return '';
  }
  return port ? `${host}:${port}` : host;
}

function normalizeEmbeddingActivationRecord(rawRecord = {}) {
  if (!rawRecord || typeof rawRecord !== 'object') return null;
  const provider = String(rawRecord.provider || '').trim();
  const endpointHost = normalizeEndpointHost(rawRecord.endpointHost);
  const model = String(rawRecord.model || '').trim();
  const retentionCostConfirmationVersion = String(rawRecord.retentionCostConfirmationVersion || '').trim();
  const projectPolicyHash = String(rawRecord.projectPolicyHash || '').trim();
  if (!provider || !endpointHost || !model || !retentionCostConfirmationVersion || !/^[a-f0-9]{16,64}$/i.test(projectPolicyHash)) {
    return null;
  }
  return {
    provider,
    endpointHost,
    model,
    retentionCostConfirmationVersion,
    projectPolicyHash
  };
}

function createEmbeddingActivationRecord({
  provider = 'openai-compatible',
  endpointHost,
  model,
  retentionCostConfirmationVersion,
  projectPolicy
} = {}) {
  return normalizeEmbeddingActivationRecord({
    provider,
    endpointHost,
    model,
    retentionCostConfirmationVersion,
    projectPolicyHash: createProjectPolicyHash(projectPolicy)
  });
}

function normalizeSecretMigrationState(rawState = {}) {
  if (!rawState || typeof rawState !== 'object') return null;
  const status = String(rawState.status || '').trim();
  if (!SECRET_MIGRATION_STATUSES.has(status)) return null;
  const migratedAt = String(rawState.migratedAt || '').trim();
  if (migratedAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(migratedAt)) {
    return null;
  }
  return {
    status,
    migratedAt: migratedAt || null
  };
}

function migratePlaintextEmbeddingApiKey({
  store,
  safeStorage,
  envKey = '',
  now = () => new Date().toISOString()
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    return { status: 'store_unavailable', migrated: false };
  }

  const originalSemanticSearch = store.get('semanticSearch', {}) || {};
  const semanticSearch = sanitizeLegacySemanticSearch(originalSemanticSearch);
  const candidates = [
    { key: 'embeddingApiKey', value: store.get('embeddingApiKey', '') },
    { key: 'apiKey', value: store.get('apiKey', '') },
    { key: 'semanticSearch.apiKey', value: semanticSearch.apiKey }
  ];
  const plaintext = candidates
    .map(candidate => String(candidate.value || '').trim())
    .find(Boolean);

  deleteStoreKey(store, 'embeddingApiKey');
  deleteStoreKey(store, 'apiKey');
  delete semanticSearch.apiKey;
  semanticSearch.activationRecord = normalizeEmbeddingActivationRecord(semanticSearch.activationRecord);
  semanticSearch.secretMigration = normalizeSecretMigrationState(semanticSearch.secretMigration);

  if (!plaintext) {
    if (JSON.stringify(semanticSearch) !== JSON.stringify(sanitizeLegacySemanticSearch(originalSemanticSearch))) {
      store.set('semanticSearch', semanticSearch);
    }
    return { status: 'not_needed', migrated: false };
  }

  let status = 'deleted_plaintext';
  let apiKeyStorage = 'none';
  let hasApiKey = false;
  if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(plaintext);
    store.set('embeddingApiKeyCiphertext', Buffer.from(encrypted).toString('base64'));
    status = 'migrated_safeStorage';
    apiKeyStorage = 'safeStorage';
    hasApiKey = true;
  } else if (String(envKey || '').trim()) {
    status = 'deleted_plaintext_using_env';
    apiKeyStorage = 'env';
    hasApiKey = true;
  } else {
    deleteStoreKey(store, 'embeddingApiKeyCiphertext');
  }

  semanticSearch.apiKeyStorage = apiKeyStorage;
  semanticSearch.hasApiKey = hasApiKey;
  semanticSearch.secretMigration = {
    status,
    migratedAt: now()
  };
  store.set('semanticSearch', semanticSearch);
  return { status, migrated: status === 'migrated_safeStorage' };
}

function sanitizeLegacySemanticSearch(rawSettings) {
  return rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)
    ? { ...rawSettings }
    : {};
}

function deleteStoreKey(store, key) {
  if (typeof store.delete === 'function') {
    store.delete(key);
  } else {
    store.set(key, undefined);
  }
}

module.exports = {
  createEmbeddingActivationRecord,
  createProjectPolicyHash,
  migratePlaintextEmbeddingApiKey,
  normalizeEmbeddingActivationRecord,
  normalizeEmbeddingProjectPolicy,
  normalizeSecretMigrationState
};
