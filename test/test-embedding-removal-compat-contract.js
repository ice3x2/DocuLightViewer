'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { removeLegacyEmbeddingSettings } = require('../src/main/embedding-settings');

// @req FR-APP-013 AC-1 AC-2 AC-3 AC-4 AC-5 AC-6
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
for (const file of ['src/renderer/settings.html', 'src/renderer/settings.js', 'src/renderer/settings.css']) {
  assert.doesNotMatch(read(file), /embedding-(?:section|registration|register|clear|model|url|key|chunk)|EmbeddingModel|refreshEmbedding/i);
}
assert.doesNotMatch(read('src/main/preload.js'), /EmbeddingModel|embedding:/);
const main = read('src/main/index.js');
assert.doesNotMatch(main, /ipcMain\.handle\('embedding:/);
assert.doesNotMatch(main, /embeddingProvider:\s*createOpenAICompatibleEmbeddingProvider/);
const sanitizerStart = main.indexOf('function sanitizeSettingsPayload(settingsPayload) {');
const sanitizerEnd = main.indexOf('\nfunction isRemoteHttpUrl(', sanitizerStart);
assert.ok(sanitizerStart >= 0 && sanitizerEnd > sanitizerStart);
assert.match(main, /ipcMain\.handle\('get-settings',[\s\S]*?return sanitizeSettingsPayload\(store\.store\)/);
const sanitizeSettingsPayload = vm.runInNewContext(
  `${main.slice(sanitizerStart, sanitizerEnd)}\nsanitizeSettingsPayload`, {}
);
const visible = sanitizeSettingsPayload({ theme: 'dark', semanticSearch: { apiKey: 'nested-secret', activationRecord: { model: 'old' } },
  embeddingApiKeyCiphertext: 'cipher', embeddingApiKey: 'root-secret', apiKey: 'root-api-secret' });
assert.deepEqual(JSON.parse(JSON.stringify(visible)), { theme: 'dark' }, 'get-settings sanitizer omits legacy secrets and activation');
const locales = ['ko', 'en', 'ja', 'es'].map(lang => JSON.parse(read(`src/locales/${lang}.json`)));
for (const locale of locales) {
  assert.deepEqual(Object.keys(locale).sort(), Object.keys(locales[0]).sort());
  assert.equal(Object.keys(locale).some(key => key.startsWith('settings.embedding')), false);
}
const entries = new Map(Object.entries({ theme: 'dark', semanticSearch: { enabled: true, apiKey: 'secret', activationRecord: { model: 'old' } },
  embeddingApiKeyCiphertext: 'cipher', embeddingApiKey: 'root-secret', apiKey: 'root-api-secret' }));
let writes = 0;
const store = { has: key => entries.has(key), get: key => entries.get(key),
  delete: key => { writes++; entries.delete(key); } };
removeLegacyEmbeddingSettings(store);
assert.deepEqual([...entries], [['theme', 'dark']]);
assert.equal(writes, 4);
removeLegacyEmbeddingSettings(store);
assert.equal(writes, 4);
console.log('test-embedding-removal-compat-contract: all assertions passed');
