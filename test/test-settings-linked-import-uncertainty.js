'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const settingsSource = fs.readFileSync(path.join(root, 'src/renderer/settings.js'), 'utf8');

async function renderImportResult(result) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, disabled: false, textContent: '', style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, callback) { this[`on_${name}`] = callback; },
      setAttribute() {}, getAttribute() { return ''; }, querySelector() { return null; }
    });
    return elements.get(id);
  };
  const context = {
    document: { getElementById: element, addEventListener() {}, querySelectorAll: () => [] },
    window: { doclight: { importLinkedMarkdown: async () => result }, addEventListener() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout, clearTimeout, console
  };
  vm.runInNewContext(settingsSource, context, { filename: 'settings.js' });
  const click = element('linked-import-btn').on_click;
  assert.equal(typeof click, 'function', 'real Settings script registers the import click handler');
  await click();
  return element('linked-import-status').textContent;
}

(async () => {
  const counts = { imported: 2, updated: 1, existing: 3, skipped: 4 };
  const uncertain = await renderImportResult({ success: true, counts, unconfirmedCount: 1,
    unconfirmed: [{ sourceRelativePath: 'C.md', diagnosticCode: 'ack_unknown' }] });
  assert.equal(uncertain, 'settings.linkedImportUnconfirmed',
    'unconfirmed owner acceptance chooses the partial-result locale key, never complete');
  const complete = await renderImportResult({ success: true, counts, unconfirmedCount: 0 });
  assert.equal(complete, 'settings.linkedImportComplete',
    'fully confirmed import retains the existing complete message');

  for (const locale of ['ko', 'en', 'ja', 'es']) {
    const strings = JSON.parse(fs.readFileSync(path.join(root, 'src/locales', `${locale}.json`), 'utf8'));
    const template = strings['settings.linkedImportUnconfirmed'];
    assert.equal(typeof template, 'string', `${locale} supplies the partial-result message`);
    for (const key of ['imported', 'updated', 'existing', 'skipped', 'unconfirmed']) {
      assert(template.includes(`{${key}}`), `${locale} partial result includes ${key} count`);
    }
    assert(!/[A-Z]:\\|\\\\|\/Users\/|C\.md/.test(template), `${locale} message contains no raw path`);
  }
  console.log('test-settings-linked-import-uncertainty: all assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
