'use strict';

const { publishSave } = require('../../../src/main/index-ingress-store');

const input = JSON.parse(process.argv[2]);
input.contentBytes = Buffer.from(input.contentBytes.data);
publishSave(input).then(
  () => { process.exitCode = 0; },
  () => { process.exitCode = 1; }
);
