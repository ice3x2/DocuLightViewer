'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');

const REDACTED = '[REDACTED]';
const CREDENTIAL_KEY_RE = /(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|credential|bearer|provider[_-]?key|embedding[_-]?key)/i;
const QUERY_CREDENTIAL_RE = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|credential|bearer|provider[_-]?key|embedding[_-]?key)=)([^&#\s]+)/gi;
const BODY_CREDENTIAL_RE = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|credential|bearer|provider[_-]?key|embedding[_-]?key)=)([^&#\s,;]+)/gi;
const HEADER_CREDENTIAL_RE = /\b(authorization|x-api-key|api-key)\s*[:=]\s*(bearer\s+)?[^\s,;]+/gi;
const WINDOWS_ABSOLUTE_RE = /\b[A-Za-z]:[\\/][^\r\n"'<>|?*,;]+/g;
const UNC_PATH_RE = /\\\\[^\\/\r\n"'<>|?*,;]+[\\/][^\r\n"'<>|?*,;]+/g;
const FILE_URL_RE = /\bfile:\/\/\/?[^\s"'<>()[\]{}]+/gi;
const POSIX_ABSOLUTE_RE = /(^|[\s"'=:(,{\[])(\/(?!\/)[^\s"'<>()[\]{}]*)/g;

// @req SEC-DOC-003
function createRedactor(options = {}) {
  const sensitivePaths = buildSensitivePathList(options);
  return {
    redactValue(value) {
      return redactValue(value, { ...options, sensitivePaths });
    },
    redactString(value) {
      return redactString(value, { ...options, sensitivePaths });
    },
    redactPath(value, tokenType = 'PATH') {
      return redactToken(tokenType, value);
    },
    redactHref(value) {
      return redactToken('HREF', value);
    }
  };
}

// @req SEC-DOC-003
function redactValue(value, options = {}) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value, options);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options));
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return redactToken('BINARY', value.toString('hex'));
  if (typeof value !== 'object') return value;

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY_RE.test(key)) {
      output[key] = REDACTED;
    } else if (isInternalPathKey(key)) {
      output[key] = child == null ? child : redactToken('PATH', String(child));
    } else if (isRawHrefKey(key)) {
      output[key] = child == null ? child : redactToken('HREF', String(child));
    } else {
      output[key] = redactValue(child, options);
    }
  }
  return output;
}

// @req SEC-DOC-003
function redactString(value, options = {}) {
  let text = String(value);
  text = redactUrlCredentials(text);
  text = redactConfiguredPaths(text, options.sensitivePaths || buildSensitivePathList(options));
  text = text.replace(FILE_URL_RE, (match) => redactToken('PATH', match));
  text = text.replace(UNC_PATH_RE, (match) => redactToken('PATH', match));
  text = text.replace(WINDOWS_ABSOLUTE_RE, (match) => redactToken('PATH', match));
  text = text.replace(POSIX_ABSOLUTE_RE, (match, prefix, rawPath) => `${prefix}${redactToken('PATH', rawPath)}`);
  return text;
}

// @req SEC-DOC-003
function redactUrlCredentials(value) {
  let text = String(value);
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/?#\s"'<>@]+)@/gi, '$1[REDACTED]@');
  text = text.replace(QUERY_CREDENTIAL_RE, (_, prefix) => `${prefix}${REDACTED}`);
  text = text.replace(BODY_CREDENTIAL_RE, (_, prefix) => `${prefix}${REDACTED}`);
  text = text.replace(HEADER_CREDENTIAL_RE, (match, header) => `${header}: ${REDACTED}`);
  return text;
}

// @req SEC-DOC-003
function redactConfiguredPaths(value, sensitivePaths) {
  let text = String(value);
  for (const rawPath of sensitivePaths) {
    if (!rawPath) continue;
    const token = redactToken('PATH', rawPath);
    text = replacePathInsensitive(text, rawPath, token);
    const normalized = rawPath.replace(/\\/g, '/');
    if (normalized !== rawPath) {
      text = replacePathInsensitive(text, normalized, token);
    }
  }
  return text;
}

// @req SEC-DOC-003
function redactToken(type, value) {
  const hash = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
  return `[REDACTED_${String(type || 'VALUE').toUpperCase()}:${hash}]`;
}

// @req SEC-DOC-003
function buildSensitivePathList(options = {}) {
  const values = [
    options.userDataDir,
    options.indexDir,
    options.dbPath,
    os.homedir()
  ];

  if (Array.isArray(options.sourceRoots)) values.push(...options.sourceRoots);
  if (Array.isArray(options.extraPaths)) values.push(...options.extraPaths);

  return Array.from(new Set(values
    .filter((item) => typeof item === 'string' && item.trim())
    .flatMap((item) => pathVariants(item))))
    .sort((a, b) => b.length - a.length);
}

// @req SEC-DOC-003
function pathVariants(value) {
  const variants = new Set();
  variants.add(value);
  try {
    variants.add(path.resolve(value));
  } catch {
    // Non-filesystem path-like values are handled by the generic regex pass.
  }
  for (const item of Array.from(variants)) {
    variants.add(item.replace(/\//g, '\\'));
    variants.add(item.replace(/\\/g, '/'));
  }
  return Array.from(variants);
}

// @req SEC-DOC-003
function replacePathInsensitive(text, rawNeedle, replacement) {
  if (!rawNeedle) return text;
  const escaped = escapeRegExp(rawNeedle);
  return text.replace(new RegExp(escaped, 'gi'), replacement);
}

// @req SEC-DOC-003
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// @req SEC-DOC-003
function isInternalPathKey(key) {
  const normalized = String(key).replace(/[_\-\s]/g, '').toLowerCase();
  if (isAllowedRelativePathKey(normalized)) return false;
  const pathSignals = ['internal', 'absolute', 'canonical', 'root', 'userdata', 'index', 'db', 'gitcontext', 'projectpath', 'destination', 'source', 'current', 'file', 'directory', 'dir'];
  return (normalized.includes('path') && pathSignals.some((signal) => normalized.includes(signal)))
    || normalized.includes('sourceroot')
    || normalized.includes('rootinternal')
    || normalized.includes('userdata')
    || normalized.includes('gitcontextpath');
}

function isAllowedRelativePathKey(normalizedKey) {
  return normalizedKey === 'sourcerelativepath' ||
    normalizedKey === 'fromsourcerelativepath' ||
    normalizedKey === 'tosourcerelativepath' ||
    normalizedKey === 'relativepath';
}

// @req SEC-DOC-003
function isRawHrefKey(key) {
  return /^(original|normalized|raw).*href/i.test(key) || /^hrefInternal$/i.test(key);
}

module.exports = {
  REDACTED,
  createRedactor,
  redactValue,
  redactString,
  redactUrlCredentials,
  redactToken
};
