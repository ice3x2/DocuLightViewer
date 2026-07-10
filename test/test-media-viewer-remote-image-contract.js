'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');
const securityModulePath = path.join(root, 'src/main/media-viewer-security.js');
const securityModuleSource = fs.readFileSync(securityModulePath, 'utf-8');

assert(fs.existsSync(securityModulePath), 'SEC-ARCH-005 media-viewer-security module exists');

const {
  validateRemoteImageUrl,
  createPinnedLookup,
  sanitizeDownloadFilename,
  resolveImageMimeExtension,
  fetchRemoteImageForMediaViewer
} = require(securityModulePath);

function securityAssert(condition, message) {
  assert(condition, `SEC-ARCH-005 remote image contract: ${message}`);
}

function assertRejected(fn, code, message) {
  let rejected = false;
  try {
    fn();
  } catch (err) {
    rejected = true;
    securityAssert(err && err.code === code, `${message} rejects with ${code}`);
    securityAssert(!String(err.message || '').includes('user:pass'), `${message} redacts URL credentials`);
  }
  securityAssert(rejected, `${message} rejects`);
}

securityAssert(typeof validateRemoteImageUrl === 'function', 'validateRemoteImageUrl is exported');
securityAssert(typeof createPinnedLookup === 'function', 'createPinnedLookup is exported');
securityAssert(typeof sanitizeDownloadFilename === 'function', 'sanitizeDownloadFilename is exported');
securityAssert(typeof resolveImageMimeExtension === 'function', 'resolveImageMimeExtension is exported');
securityAssert(typeof fetchRemoteImageForMediaViewer === 'function', 'fetchRemoteImageForMediaViewer is exported');

assertRejected(() => validateRemoteImageUrl('file:///C:/secret.png'), 'unsupported_protocol', 'file protocol');
assertRejected(() => validateRemoteImageUrl('ftp://example.com/image.png'), 'unsupported_protocol', 'ftp protocol');
assertRejected(() => validateRemoteImageUrl('http://user:pass@example.com/image.png'), 'url_credentials_forbidden', 'credential URL');
assertRejected(() => validateRemoteImageUrl('http://127.0.0.1/image.png'), 'private_network_forbidden', 'loopback IPv4');
assertRejected(() => validateRemoteImageUrl('http://localhost/image.png'), 'private_network_forbidden', 'localhost');
assertRejected(() => validateRemoteImageUrl('http://10.1.2.3/image.png'), 'private_network_forbidden', 'private IPv4');
assertRejected(() => validateRemoteImageUrl('http://100.64.0.1/image.png'), 'private_network_forbidden', 'shared address space IPv4');
assertRejected(() => validateRemoteImageUrl('http://198.18.0.1/image.png'), 'private_network_forbidden', 'benchmarking IPv4');
assertRejected(() => validateRemoteImageUrl('http://224.0.0.1/image.png'), 'private_network_forbidden', 'multicast IPv4');
assertRejected(() => validateRemoteImageUrl('http://255.255.255.255/image.png'), 'private_network_forbidden', 'broadcast/reserved IPv4');
assertRejected(() => validateRemoteImageUrl('http://[::1]/image.png'), 'private_network_forbidden', 'loopback IPv6');
assertRejected(() => validateRemoteImageUrl('http://[::ffff:7f00:1]/image.png'), 'private_network_forbidden', 'IPv4-mapped loopback IPv6 hex literal');
assertRejected(() => validateRemoteImageUrl('http://[::ffff:a00:1]/image.png'), 'private_network_forbidden', 'IPv4-mapped private 10/8 IPv6 hex literal');
assertRejected(() => validateRemoteImageUrl('http://[::ffff:ac10:1]/image.png'), 'private_network_forbidden', 'IPv4-mapped private 172.16/12 IPv6 hex literal');
assertRejected(() => validateRemoteImageUrl('http://[::ffff:c0a8:1]/image.png'), 'private_network_forbidden', 'IPv4-mapped private 192.168/16 IPv6 hex literal');
assertRejected(() => validateRemoteImageUrl('http://[::127.0.0.1]/image.png'), 'private_network_forbidden', 'IPv4-compatible loopback IPv6 dotted literal');
assertRejected(() => validateRemoteImageUrl('http://[::10.0.0.1]/image.png'), 'private_network_forbidden', 'IPv4-compatible private 10/8 IPv6 dotted literal');
assertRejected(() => validateRemoteImageUrl('http://[::192.168.0.1]/image.png'), 'private_network_forbidden', 'IPv4-compatible private 192.168/16 IPv6 dotted literal');
assertRejected(() => validateRemoteImageUrl('http://[::7f00:1]/image.png'), 'private_network_forbidden', 'IPv4-compatible loopback IPv6 hex literal');
assertRejected(() => validateRemoteImageUrl('http://[0:0:0:0:0:0:7f00:1]/image.png'), 'private_network_forbidden', 'fully expanded IPv4-compatible loopback IPv6 literal');
assertRejected(() => validateRemoteImageUrl('http://[::]/image.png'), 'private_network_forbidden', 'unspecified IPv6 literal');
assertRejected(() => validateRemoteImageUrl('http://[fe80::1]/image.png'), 'private_network_forbidden', 'IPv6 link-local fe80 literal');
assertRejected(() => validateRemoteImageUrl('http://[fe90::1]/image.png'), 'private_network_forbidden', 'IPv6 link-local fe90 literal');
assertRejected(() => validateRemoteImageUrl('http://[fea0::1]/image.png'), 'private_network_forbidden', 'IPv6 link-local fea0 literal');
assertRejected(() => validateRemoteImageUrl('http://[febf::1]/image.png'), 'private_network_forbidden', 'IPv6 link-local febf literal');
assertRejected(() => validateRemoteImageUrl('http://[fec0::1]/image.png'), 'private_network_forbidden', 'deprecated IPv6 site-local literal');
assertRejected(() => validateRemoteImageUrl('http://[ff02::1]/image.png'), 'private_network_forbidden', 'IPv6 multicast literal');
assertRejected(() => validateRemoteImageUrl('http://[64:ff9b::7f00:1]/image.png'), 'private_network_forbidden', 'NAT64 embedded loopback literal');

securityAssert(
  validateRemoteImageUrl('https://example.com/image.png').href === 'https://example.com/image.png',
  'https public URL is accepted'
);

const traversalName = sanitizeDownloadFilename('../evil/CON.png', 'image/png');
securityAssert(!traversalName.includes('..'), 'filename sanitizer removes traversal segments');
securityAssert(!/[\\/]/.test(traversalName), 'filename sanitizer removes path separators');
securityAssert(!/^CON(\.|$)/i.test(traversalName), 'filename sanitizer avoids Windows reserved names');
securityAssert(traversalName.endsWith('.png'), 'filename sanitizer preserves safe MIME extension');

securityAssert(
  sanitizeDownloadFilename('report.exe', 'image/png').endsWith('.png'),
  'filename sanitizer prevents extension spoofing'
);
securityAssert(
  sanitizeDownloadFilename('bad\u0000name.svg', 'image/svg+xml') === 'badname.svg',
  'filename sanitizer removes control characters'
);

securityAssert(resolveImageMimeExtension('image/svg+xml') === '.svg', 'SVG MIME maps to .svg');
securityAssert(resolveImageMimeExtension('image/jpeg') === '.jpg', 'JPEG MIME maps to .jpg');
securityAssert(resolveImageMimeExtension('text/html') === null, 'non-image MIME has no extension');
securityAssert(securityModuleSource.includes('lookup: createPinnedLookup'), 'remote fetch pins the validated DNS result for the request');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

(async () => {
  await withServer((req, res) => {
    securityAssert(req.headers.cookie === undefined, 'remote fetch does not send cookie header');
    securityAssert(req.headers.authorization === undefined, 'remote fetch does not send authorization header');
    securityAssert(req.headers.referer === undefined, 'remote fetch does not send referer header');

    if (req.url === '/image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '8' });
      res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return;
    }

    if (req.url === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
      return;
    }

    if (req.url === '/redirect-file') {
      res.writeHead(302, { Location: 'file:///C:/secret.png' });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end('not found');
  }, async (baseUrl) => {
    const image = await fetchRemoteImageForMediaViewer(`${baseUrl}/image.png`, {
      allowPrivateNetworkForTests: true,
      maxBytes: 32,
      timeoutMs: 3000
    });
    securityAssert(Buffer.isBuffer(image.bytes), 'remote fetch returns image bytes');
    securityAssert(image.mime === 'image/png', 'remote fetch returns verified image MIME');
    securityAssert(image.safeFileName.endsWith('.png'), 'remote fetch returns sanitized filename');

    await assert.rejects(
      () => fetchRemoteImageForMediaViewer(`${baseUrl}/html`, {
        allowPrivateNetworkForTests: true,
        maxBytes: 32,
        timeoutMs: 3000
      }),
      (err) => err && err.code === 'unsupported_mime',
      'remote fetch rejects non-image MIME'
    );

    await assert.rejects(
      () => fetchRemoteImageForMediaViewer(`${baseUrl}/redirect-file`, {
        allowPrivateNetworkForTests: true,
        maxBytes: 32,
        timeoutMs: 3000
      }),
      (err) => err && err.code === 'unsupported_protocol',
      'redirect target is revalidated against protocol policy'
    );
  });

  console.log('PASS: SEC-ARCH-005 remote image security contract');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
