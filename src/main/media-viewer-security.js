'use strict';

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

const DEFAULT_MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_REMOTE_IMAGE_TIMEOUT_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 5;

const MIME_EXTENSION = new Map([
  ['image/svg+xml', '.svg'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['image/x-icon', '.ico'],
  ['image/vnd.microsoft.icon', '.ico'],
  ['image/tiff', '.tiff'],
  ['image/avif', '.avif']
]);

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

function createMediaSecurityError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function normalizeMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function resolveImageMimeExtension(mime) {
  return MIME_EXTENSION.get(normalizeMime(mime)) || null;
}

function isPrivateIPv4(address) {
  const parts = parseIPv4Parts(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIPv4Parts(address) {
  const parts = String(address || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

function parseIPv6Words(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIndex = value.indexOf('%');
  let normalized = zoneIndex === -1 ? value : value.slice(0, zoneIndex);

  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const dottedParts = parseIPv4Parts(normalized.slice(lastColon + 1));
    if (lastColon === -1 || !dottedParts) return null;
    const high = ((dottedParts[0] << 8) | dottedParts[1]).toString(16);
    const low = ((dottedParts[2] << 8) | dottedParts[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const compressed = normalized.split('::');
  if (compressed.length > 2) return null;

  const parseSide = (side) => {
    if (!side) return [];
    return side.split(':').map((part) => {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return NaN;
      return Number.parseInt(part, 16);
    });
  };

  const left = parseSide(compressed[0]);
  const right = compressed.length === 2 ? parseSide(compressed[1]) : [];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;

  const missing = 8 - left.length - right.length;
  if ((compressed.length === 1 && missing !== 0) || (compressed.length === 2 && missing < 0)) return null;
  return [
    ...left,
    ...Array(Math.max(0, missing)).fill(0),
    ...right
  ];
}

function ipv4FromIPv6Address(address) {
  const words = parseIPv6Words(address);
  if (!words || words.length !== 8) return null;

  const firstFiveZero = words.slice(0, 5).every((word) => word === 0);
  const mapped = firstFiveZero && words[5] === 0xffff;
  const compatible = firstFiveZero && words[5] === 0;
  if (!mapped && !compatible) return null;

  return [
    (words[6] >> 8) & 0xff,
    words[6] & 0xff,
    (words[7] >> 8) & 0xff,
    words[7] & 0xff
  ].join('.');
}

function ipv4FromNat64Address(words) {
  if (!words || words.length !== 8) return null;
  const wellKnownNat64 = words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words.slice(2, 6).every((word) => word === 0);
  const localUseNat64 = words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words[2] === 0x0001;
  if (!wellKnownNat64 && !localUseNat64) return null;
  return [
    (words[6] >> 8) & 0xff,
    words[6] & 0xff,
    (words[7] >> 8) & 0xff,
    words[7] & 0xff
  ].join('.');
}

function isPrivateIPv6(address) {
  const value = String(address || '').toLowerCase();
  const words = parseIPv6Words(value);
  const embeddedIPv4 = ipv4FromIPv6Address(value);
  if (embeddedIPv4) return isPrivateIPv4(embeddedIPv4);
  const nat64IPv4 = ipv4FromNat64Address(words);
  if (nat64IPv4) return isPrivateIPv4(nat64IPv4);
  if (words && words.length === 8) {
    const first = words[0];
    const second = words[1];
    const third = words[2];
    const allZero = words.every((word) => word === 0);
    const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
    return (
      allZero ||
      loopback ||
      (first >= 0xfe80 && first <= 0xfeff) ||
      (first >= 0xfc00 && first <= 0xfdff) ||
      (first >= 0xff00 && first <= 0xffff) ||
      (first === 0x0100 && words.slice(1, 4).every((word) => word === 0)) ||
      (first === 0x2001 && second === 0x0000) ||
      (first === 0x2001 && second === 0x0002 && third === 0x0000) ||
      (first === 0x2001 && second === 0x0db8) ||
      first === 0x2002
    );
  }
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fe80:') ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('::ffff:127.') ||
    value.startsWith('::ffff:10.') ||
    value.startsWith('::ffff:192.168.') ||
    /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(value)
  );
}

function isPrivateHostLiteral(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = net.isIP(host);
  if (family === 4) return isPrivateIPv4(host);
  if (family === 6) return isPrivateIPv6(host);
  return false;
}

function assertPublicHost(hostname, options = {}) {
  if (options.allowPrivateNetworkForTests) return;
  if (isPrivateHostLiteral(hostname)) {
    throw createMediaSecurityError('private_network_forbidden', 'Remote image host is not allowed.');
  }
}

async function assertResolvedPublicHost(hostname, options = {}) {
  if (options.allowPrivateNetworkForTests) return;
  assertPublicHost(hostname, options);

  const family = net.isIP(String(hostname || '').replace(/^\[|\]$/g, ''));
  if (family) return;

  const records = await dns.promises.lookup(hostname, { all: true, verbatim: false });
  for (const record of records) {
    if ((record.family === 4 && isPrivateIPv4(record.address)) ||
        (record.family === 6 && isPrivateIPv6(record.address))) {
      throw createMediaSecurityError('private_network_forbidden', 'Remote image host is not allowed.');
    }
  }
}

async function resolveHostForRequest(hostname, options = {}) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  if (family) {
    if (!options.allowPrivateNetworkForTests) {
      assertPublicHost(host, options);
    }
    return { address: host, family };
  }

  const records = await dns.promises.lookup(hostname, { all: true, verbatim: false });
  if (records.length === 0) {
    throw createMediaSecurityError('host_lookup_failed', 'Remote image host could not be resolved.');
  }

  for (const record of records) {
    const privateAddress = (record.family === 4 && isPrivateIPv4(record.address)) ||
      (record.family === 6 && isPrivateIPv6(record.address));
    if (privateAddress && !options.allowPrivateNetworkForTests) {
      throw createMediaSecurityError('private_network_forbidden', 'Remote image host is not allowed.');
    }
    if (!privateAddress || options.allowPrivateNetworkForTests) {
      return { address: record.address, family: record.family };
    }
  }

  throw createMediaSecurityError('private_network_forbidden', 'Remote image host is not allowed.');
}

function createPinnedLookup(record) {
  return function pinnedLookup(_hostname, _options, callback) {
    callback(null, record.address, record.family);
  };
}

function validateRemoteImageUrl(rawUrl, options = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    throw createMediaSecurityError('invalid_url', 'Remote image URL is invalid.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw createMediaSecurityError('unsupported_protocol', 'Remote image protocol is not allowed.');
  }

  if (url.username || url.password) {
    throw createMediaSecurityError('url_credentials_forbidden', 'Remote image URL credentials are not allowed.');
  }

  assertPublicHost(url.hostname, options);
  return url;
}

function sanitizeDownloadFilename(candidate, mime, fallbackBase = 'media') {
  const ext = resolveImageMimeExtension(mime) || path.extname(String(candidate || '')).toLowerCase() || '.bin';
  const baseCandidate = path.basename(String(candidate || fallbackBase));
  let base = baseCandidate
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\.\.+/g, '.')
    .trim();

  base = base.replace(/[. ]+$/g, '');
  if (!base) base = fallbackBase;

  let parsed = path.parse(base);
  if (!parsed.name) parsed.name = fallbackBase;
  if (WINDOWS_RESERVED_NAMES.has(parsed.name.toUpperCase())) {
    parsed.name = `${parsed.name}_file`;
  }

  const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
  return `${parsed.name}${safeExt}`;
}

function filenameFromContentDisposition(value) {
  const header = String(value || '');
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return encoded[1].trim().replace(/^"|"$/g, '');
    }
  }
  const plain = header.match(/filename=([^;]+)/i);
  if (plain) return plain[1].trim().replace(/^"|"$/g, '');
  return '';
}

function requestUrl(url, options) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'GET',
      timeout: options.timeoutMs,
      lookup: createPinnedLookup(options.resolvedAddress),
      headers: {
        Accept: 'image/*'
      }
    }, (res) => resolve(res));

    req.on('timeout', () => {
      req.destroy(createMediaSecurityError('fetch_timeout', 'Remote image fetch timed out.'));
    });
    req.on('error', (err) => {
      if (!err.code) err.code = 'fetch_failed';
      reject(err);
    });
    req.end();
  });
}

async function fetchRemoteImageForMediaViewer(rawUrl, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes || DEFAULT_MAX_REMOTE_IMAGE_BYTES));
  const timeoutMs = Math.max(100, Number(options.timeoutMs || DEFAULT_REMOTE_IMAGE_TIMEOUT_MS));
  const maxRedirects = Math.max(0, Number(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS));

  let currentUrl = validateRemoteImageUrl(rawUrl, options);
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    await assertResolvedPublicHost(currentUrl.hostname, options);
    const resolvedAddress = await resolveHostForRequest(currentUrl.hostname, options);

    const res = await requestUrl(currentUrl, { timeoutMs, resolvedAddress });
    const statusCode = Number(res.statusCode || 0);

    if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
      const nextUrl = new URL(res.headers.location, currentUrl);
      currentUrl = validateRemoteImageUrl(nextUrl.href, options);
      res.resume();
      continue;
    }

    if (statusCode < 200 || statusCode >= 300) {
      res.resume();
      throw createMediaSecurityError('fetch_failed', 'Remote image fetch failed.');
    }

    const mime = normalizeMime(res.headers['content-type']);
    const ext = resolveImageMimeExtension(mime);
    if (!ext) {
      res.resume();
      throw createMediaSecurityError('unsupported_mime', 'Remote image type is not supported.');
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of res) {
      total += chunk.length;
      if (total > maxBytes) {
        throw createMediaSecurityError('response_too_large', 'Remote image is too large.');
      }
      chunks.push(chunk);
    }

    const dispositionName = filenameFromContentDisposition(res.headers['content-disposition']);
    const urlName = decodeURIComponent(path.posix.basename(currentUrl.pathname || '') || '');
    const safeFileName = sanitizeDownloadFilename(dispositionName || urlName || 'remote-image', mime, 'remote-image');
    return {
      bytes: Buffer.concat(chunks),
      mime,
      extension: ext,
      safeFileName,
      sourceUrl: `${currentUrl.protocol}//${currentUrl.host}${currentUrl.pathname}`
    };
  }

  throw createMediaSecurityError('too_many_redirects', 'Remote image has too many redirects.');
}

module.exports = {
  DEFAULT_MAX_REMOTE_IMAGE_BYTES,
  DEFAULT_REMOTE_IMAGE_TIMEOUT_MS,
  validateRemoteImageUrl,
  createPinnedLookup,
  sanitizeDownloadFilename,
  resolveImageMimeExtension,
  fetchRemoteImageForMediaViewer
};
