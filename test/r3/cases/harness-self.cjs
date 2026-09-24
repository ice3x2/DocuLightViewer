'use strict';
module.exports = {
  name: 'harness-self',
  async run(context) {
    const Database = require('better-sqlite3');
    const independent = new Database(':memory:');
    try { context.assert(independent.prepare('select 2 as value').get().value === 2, 'case-local SQLite module'); }
    finally { independent.close(); }
    context.assert(context.fixture.db.prepare('select 1 as value').get().value === 1, 'real SQLite query');
    context.assert(require('node:fs').readFileSync(context.fixture.markdownPath, 'utf8') === '# R3 fixture\n', 'real Markdown bytes');
  }
};
