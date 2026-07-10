'use strict';

const fs = require('fs');
const path = require('path');

function stripWrappingQuotes(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function normalizePastedMarkdownPathCandidate(value, options = {}) {
  if (typeof value !== 'string') return null;

  let candidate = stripWrappingQuotes(value.trim());
  if (!candidate || candidate.includes('\0') || /[\r\n]/.test(candidate)) return null;

  const platform = options.platform || process.platform;
  const isAbsolute = platform === 'win32'
    ? /^[A-Za-z]:[\\/]/.test(candidate)
    : candidate.startsWith('/');

  if (!isAbsolute) return null;
  if (path.extname(candidate).toLowerCase() !== '.md') return null;

  return platform === 'win32'
    ? path.win32.normalize(candidate)
    : path.posix.normalize(candidate);
}

async function resolveReadablePastedMarkdownPath(value, options = {}) {
  const filePath = normalizePastedMarkdownPathCandidate(value, options);
  if (!filePath) return null;

  const fsModule = options.fs || fs;
  try {
    await fsModule.promises.access(filePath, fs.constants.R_OK);
    const stat = await fsModule.promises.stat(filePath);
    if (!stat.isFile()) return null;
    return path.normalize(filePath);
  } catch {
    return null;
  }
}

module.exports = {
  normalizePastedMarkdownPathCandidate,
  resolveReadablePastedMarkdownPath
};
