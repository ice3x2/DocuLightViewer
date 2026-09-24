'use strict';
const { OwnerWorkerController } = require('../../../src/main/search-owner-controller');
const config = JSON.parse(process.argv[2]);
const owner = new OwnerWorkerController(config);
owner.start().then(() => {
  if (process.send) process.send({ ready: true });
  setTimeout(() => process.exit(0), 25);
}).catch(() => process.exit(2));
