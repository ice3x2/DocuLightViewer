'use strict';

const path = require('path');

function defaultUnpackedApp(platform, root) {
  if (platform === 'win32') return path.join(root, 'dist', 'win-unpacked', 'DocuLight.exe');
  if (platform === 'darwin') return path.join(root, 'dist', 'mac-arm64', 'DocuLight.app', 'Contents', 'MacOS', 'DocuLight');
  return path.join(root, 'dist', 'linux-unpacked', 'doculight');
}

// @req OPS-ARCH-009 AC-2 OPS-ARCH-010 AC-3 OPS-ARCH-013 AC-9
function selectPackageSmokeArtifact(args, platform, root) {
  let appPath;
  let artifactKind;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--app' && args[i + 1]) appPath = args[++i];
    else if (arg === '--artifact-kind' && args[i + 1]) artifactKind = args[++i];
    else throw new Error(`Unknown package smoke option: ${arg}`);
  }
  if (appPath && !artifactKind) throw new Error('--artifact-kind is required with --app');
  if (artifactKind && !appPath) throw new Error('--app is required with --artifact-kind');
  if (!appPath) {
    const unpacked = defaultUnpackedApp(platform, root);
    return { appPath: unpacked, artifactKind: 'unpacked',
      unpackedNativeRoot: platform === 'darwin'
        ? path.join(root, 'dist', 'mac-arm64', 'DocuLight.app', 'Contents', 'Resources', 'app.asar.unpacked')
        : path.join(path.dirname(unpacked), 'resources', 'app.asar.unpacked') };
  }
  if (!path.isAbsolute(appPath)) throw new Error('absolute --app path required');
  const selected = path.resolve(appPath);
  if (artifactKind === 'portable') {
    if (platform !== 'win32' || !/^DocuLight-Portable-[\w.-]+\.exe$/i.test(path.basename(selected))) {
      throw new Error('portable artifact required');
    }
    return { appPath: selected, artifactKind, unpackedNativeRoot: null };
  }
  if (artifactKind === 'appimage' && platform === 'linux'
    && /\.AppImage$/.test(path.basename(selected))) {
    return { appPath: selected, artifactKind, unpackedNativeRoot: null };
  }
  if (artifactKind === 'app' && platform === 'darwin'
    && path.basename(selected) === 'DocuLight'
    && path.basename(path.dirname(selected)) === 'MacOS'
    && path.basename(path.dirname(path.dirname(selected))) === 'Contents'
    && path.basename(path.dirname(path.dirname(path.dirname(selected)))).endsWith('.app')) {
    return { appPath: selected, artifactKind,
      unpackedNativeRoot: path.join(path.dirname(path.dirname(selected)),
        'Resources', 'app.asar.unpacked') };
  }
  const expectedUnpacked = platform === 'win32'
    ? path.basename(selected) === 'DocuLight.exe' && path.basename(path.dirname(selected)) === 'win-unpacked'
    : selected === defaultUnpackedApp(platform, root);
  if (artifactKind !== 'unpacked' || !expectedUnpacked) {
    throw new Error('unpacked artifact required');
  }
  return { appPath: selected, artifactKind, unpackedNativeRoot: platform === 'darwin'
    ? path.join(root, 'dist', 'mac-arm64', 'DocuLight.app', 'Contents', 'Resources', 'app.asar.unpacked')
    : path.join(path.dirname(selected), 'resources', 'app.asar.unpacked') };
}

module.exports = { selectPackageSmokeArtifact };
