'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const publicSha = '12d312cea07d530c7aa28ffb849575ea3d94b459';
const root = path.resolve(__dirname, '../../..');
const output = path.join(__dirname, 'public-ledger-12d312c.sqlite');
const runtimeRoot = process.env.DOCULIGHT_R3_NODE_ROOT;
if (!runtimeRoot || !path.isAbsolute(runtimeRoot) || fs.existsSync(output)) {
  throw new Error('Set DOCULIGHT_R3_NODE_ROOT to the prepared Node runtime; output must not exist');
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doculight-public-ledger-'));
try {
  for (const name of ['source-ledger-store.js', 'redaction.js']) {
    const bytes = execFileSync('git', ['show', `${publicSha}:src/main/${name}`], { cwd: root });
    fs.writeFileSync(path.join(temp, name), bytes);
  }
  const Database = createRequire(path.join(runtimeRoot, 'package.json'))('better-sqlite3');
  const { SourceLedgerStore } = require(path.join(temp, 'source-ledger-store.js'));
  const dbPath = path.join(temp, 'baseline.sqlite');
  const ledger = new SourceLedgerStore({ dbPath, loadDatabase: () => Database });
  ledger.initialize();
  ledger.close();
  fs.copyFileSync(dbPath, output, fs.constants.COPYFILE_EXCL);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  console.log(JSON.stringify({ publicSha, output, sha256: digest }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
