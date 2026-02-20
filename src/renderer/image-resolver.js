// src/renderer/image-resolver.js — Image path resolution for local markdown files
(function() {
  'use strict';
  window.__docuLightModules = window.__docuLightModules || [];
  window.__docuLightModules.push({
    name: 'imageResolver',
    init: function() {
      if (typeof marked === 'undefined') return;

      marked.use({
        gfm: true,
        breaks: true,
        renderer: {
          image({ href, title, text }) {
            const resolvedHref = resolveImagePath(href);
            const titleAttr = title ? ' title="' + escapeHtml(title) + '"' : '';
            const altAttr = text ? escapeHtml(text) : '';
            return '<img src="' + escapeHtml(resolvedHref) + '" alt="' + altAttr + '"' + titleAttr + '>';
          }
        }
      });
    }
  });

  function resolveImagePath(href) {
    if (!href) return '';

    // data: URLs — pass through
    if (href.startsWith('data:')) return href;

    // Absolute URLs — pass through
    if (href.startsWith('http://') || href.startsWith('https://')) return href;

    // file:// URLs — pass through
    if (href.startsWith('file://')) return href;

    // Try to decode URI component (marked parser may not decode)
    try { href = decodeURIComponent(href); } catch (e) { /* malformed URI — keep original */ }

    // Relative path — resolve against basePath
    var state = window.DocuLight && window.DocuLight.state;
    var imageBasePath = state ? state.imageBasePath : null;
    var currentFilePath = state ? state.currentFilePath : null;

    if (!imageBasePath && !currentFilePath) {
      // content-only mode — return as-is
      return href;
    }

    // Determine basePath
    var basePath = imageBasePath;
    if (!basePath && currentFilePath) {
      var lastSlash = currentFilePath.lastIndexOf('/');
      basePath = lastSlash >= 0 ? currentFilePath.substring(0, lastSlash) : '';
    }

    // Root directory guard: if basePath is drive root or depth-1 directory,
    // fall back to currentFilePath's directory
    if (basePath && isRootLike(basePath) && currentFilePath) {
      var lastSlash2 = currentFilePath.lastIndexOf('/');
      if (lastSlash2 >= 0) {
        basePath = currentFilePath.substring(0, lastSlash2);
      }
    }

    if (!basePath) return href;

    var absolutePath = resolveRelativePath(basePath, href);

    if (isPathWithin(absolutePath, basePath)) {
      return pathToFileUrl(absolutePath);
    } else {
      // Path traversal blocked
      return '';
    }
  }

  function isRootLike(p) {
    var normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
    // Unix root: /
    if (normalized === '') return true;
    // Windows drive root: C:
    if (/^[A-Za-z]:$/.test(normalized)) return true;
    // Depth-1: /foo or C:/foo
    var parts = normalized.split('/').filter(function(s) { return s !== ''; });
    if (parts.length <= 1) return true;
    // Windows depth-1: C:/foo
    if (parts.length === 2 && /^[A-Za-z]:$/.test(parts[0])) return true;
    return false;
  }

  function resolveRelativePath(basePath, relativePath) {
    if (!basePath) return relativePath;
    var baseDir = basePath;
    var combined = baseDir + '/' + relativePath;
    var isUnix = combined.startsWith('/');
    var parts = combined.split('/');
    var resolved = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === '.' || part === '') continue;
      if (part === '..') {
        if (resolved.length > 0 && !/^[A-Za-z]:$/.test(resolved[resolved.length - 1])) {
          resolved.pop();
        }
        continue;
      }
      resolved.push(part);
    }
    var result = resolved.join('/');
    return isUnix ? '/' + result : result;
  }

  function isPathWithin(absPath, basePath) {
    var platform = window.DocuLight && window.DocuLight.state && window.DocuLight.state.platform;
    var isWindows = (platform === 'win32') || /^[A-Za-z]:/.test(absPath);
    var normalizedAbs = absPath.replace(/\\/g, '/');
    var normalizedBase = basePath.replace(/\\/g, '/');
    var a = isWindows ? normalizedAbs.toLowerCase() : normalizedAbs;
    var b = isWindows ? normalizedBase.toLowerCase() : normalizedBase;
    return a.startsWith(b + '/') || a === b;
  }

  function pathToFileUrl(absPath) {
    var normalized = absPath.replace(/\\/g, '/');
    var encoded = normalized.split('/').map(function(segment) {
      return encodeURIComponent(segment).replace(/%3A/g, ':');
    }).join('/');
    return 'file:///' + encoded.replace(/^\//, '');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
})();
