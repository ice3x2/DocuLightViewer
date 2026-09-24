'use strict';
const fs = require('node:fs');
const path = require('node:path');
const original = fs.readdirSync;
const ingress = path.resolve(process.env.DOCULIGHT_S20_INGRESS_ROOT);
fs.readdirSync = function checkedRead(directory, ...args) {
  if (path.resolve(directory) === ingress) throw new Error('S20 ingress must stream bounded entries');
  return original.call(fs, directory, ...args);
};
require('../../../src/main/search-owner-worker');
