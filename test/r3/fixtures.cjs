'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createFixture({ Database }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-r3-'));
  try {
    const markdownPath = path.join(root, 'fixture.md');
    fs.writeFileSync(markdownPath, '# R3 fixture\n');
    const db = new Database(path.join(root, 'fixture.sqlite'));
    return {
      root, markdownPath, db,
      close() {
        if (db.open) db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { createFixture };
