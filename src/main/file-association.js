// src/main/file-association.js — Platform-specific .md file association management
// CommonJS module for Electron main process
'use strict';

const { app, shell } = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// === Constants ===
const PROG_ID = 'DocuLight.Markdown';
const PROG_ID_DESC = 'Markdown Document';
const APP_NAME = 'DocuLight';

// Store reference (set via init)
let store = null;

/**
 * Initialize with electron-store instance.
 * Must be called before using register/unregister.
 * @param {import('electron-store')} storeInstance
 */
function init(storeInstance) {
  store = storeInstance;
}

/**
 * Whether file association is supported in the current environment.
 * Only works in packaged (built) apps, not in development mode.
 * @returns {boolean}
 */
function isSupported() {
  return app.isPackaged;
}

// =============================================================================
// Windows Implementation
// =============================================================================

function winRegAdd(keyPath, valueName, data, type) {
  const args = ['add', keyPath];
  if (valueName === null) {
    // Default value
    args.push('/ve');
  } else {
    args.push('/v', valueName);
  }
  if (type) {
    args.push('/t', type);
  }
  args.push('/d', data, '/f');
  execFileSync('reg', args, { windowsHide: true });
}

function winRegDelete(keyPath, valueName) {
  const args = ['delete', keyPath];
  if (valueName === null) {
    args.push('/ve');
  } else if (valueName !== undefined) {
    args.push('/v', valueName);
  }
  args.push('/f');
  execFileSync('reg', args, { windowsHide: true });
}

function winRegQuery(keyPath, valueName) {
  const args = ['query', keyPath];
  if (valueName === null) {
    args.push('/ve');
  } else if (valueName !== undefined) {
    args.push('/v', valueName);
  }
  return execFileSync('reg', args, { windowsHide: true }).toString();
}

async function winRegister() {
  const execPath = process.execPath;

  // 1. Backup previous .md ProgId
  try {
    const output = winRegQuery('HKCU\\Software\\Classes\\.md', null);
    const match = output.match(/REG_SZ\s+(.+)/);
    if (match) {
      const currentProgId = match[1].trim();
      if (currentProgId && currentProgId !== PROG_ID) {
        store.set('fileAssociationPrevProgId', currentProgId);
      }
    }
  } catch {
    // No existing .md association — that's fine
  }

  // 2. ProgId registration (default association for .md)
  winRegAdd('HKCU\\Software\\Classes\\.md', null, PROG_ID, 'REG_SZ');

  // 3. OpenWithProgIds (Windows 11 "Open With" dialog)
  winRegAdd('HKCU\\Software\\Classes\\.md\\OpenWithProgIds', PROG_ID, '', 'REG_SZ');

  // 4. ProgId details
  winRegAdd(`HKCU\\Software\\Classes\\${PROG_ID}`, null, PROG_ID_DESC, 'REG_SZ');
  winRegAdd(`HKCU\\Software\\Classes\\${PROG_ID}\\DefaultIcon`, null, `"${execPath}",0`, 'REG_SZ');
  winRegAdd(`HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`, null, `"${execPath}" "%1"`, 'REG_SZ');

  // 5. Applications registration (Explorer "Open With" list)
  const exeName = path.basename(execPath);
  winRegAdd(`HKCU\\Software\\Classes\\Applications\\${exeName}\\shell\\open\\command`, null, `"${execPath}" "%1"`, 'REG_SZ');
  winRegAdd(`HKCU\\Software\\Classes\\Applications\\${exeName}\\SupportedTypes`, '.md', '', 'REG_SZ');

  // 6. Capabilities + RegisteredApplications (ms-settings deep link)
  winRegAdd(`HKCU\\Software\\Classes\\${PROG_ID}\\Capabilities`, 'ApplicationName', APP_NAME, 'REG_SZ');
  winRegAdd(`HKCU\\Software\\Classes\\${PROG_ID}\\Capabilities`, 'ApplicationDescription', 'Lightweight Markdown Viewer', 'REG_SZ');
  winRegAdd(`HKCU\\Software\\Classes\\${PROG_ID}\\Capabilities\\FileAssociations`, '.md', PROG_ID, 'REG_SZ');
  winRegAdd('HKCU\\Software\\RegisteredApplications', APP_NAME, `Software\\Classes\\${PROG_ID}\\Capabilities`, 'REG_SZ');

  // 7. SHChangeNotify (best-effort)
  try {
    execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class S{[DllImport(\"shell32.dll\")]public static extern void SHChangeNotify(int e,int f,IntPtr d1,IntPtr d2);}';[S]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)"
    ], { windowsHide: true });
  } catch { /* non-fatal */ }

  return { success: true, message: '파일 연결이 등록되었습니다' };
}

async function winUnregister() {
  const exeName = path.basename(process.execPath);

  // 1. Restore .md default value
  try {
    const output = winRegQuery('HKCU\\Software\\Classes\\.md', null);
    const match = output.match(/REG_SZ\s+(.+)/);
    if (match && match[1].trim() === PROG_ID) {
      const prevProgId = store.get('fileAssociationPrevProgId', '');
      if (prevProgId) {
        winRegAdd('HKCU\\Software\\Classes\\.md', null, prevProgId, 'REG_SZ');
      } else {
        try { winRegDelete('HKCU\\Software\\Classes\\.md', null); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // 2. Remove from OpenWithProgIds
  try { winRegDelete('HKCU\\Software\\Classes\\.md\\OpenWithProgIds', PROG_ID); } catch { /* ignore */ }

  // 3. Remove ProgId key tree
  try { winRegDelete(`HKCU\\Software\\Classes\\${PROG_ID}`); } catch { /* ignore */ }

  // 4. Remove Applications key
  try { winRegDelete(`HKCU\\Software\\Classes\\Applications\\${exeName}`); } catch { /* ignore */ }

  // 5. Remove RegisteredApplications value
  try { winRegDelete('HKCU\\Software\\RegisteredApplications', APP_NAME); } catch { /* ignore */ }

  // 6. SHChangeNotify
  try {
    execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class S{[DllImport(\"shell32.dll\")]public static extern void SHChangeNotify(int e,int f,IntPtr d1,IntPtr d2);}';[S]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)"
    ], { windowsHide: true });
  } catch { /* non-fatal */ }

  return { success: true, message: '파일 연결이 해제되었습니다' };
}

async function winIsRegistered() {
  try {
    winRegQuery('HKCU\\Software\\Classes\\.md\\OpenWithProgIds', PROG_ID);
    return true;
  } catch {
    return false;
  }
}

function winOpenSystemSettings() {
  shell.openExternal('ms-settings:defaultapps');
}

// =============================================================================
// macOS Implementation
// =============================================================================

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function macGetAppPath() {
  // process.execPath is inside .app bundle: AppName.app/Contents/MacOS/AppName
  // Go up 3 levels to get .app path
  let appPath = process.execPath;
  for (let i = 0; i < 3; i++) {
    appPath = path.dirname(appPath);
  }
  return appPath;
}

async function macRegister() {
  const appPath = macGetAppPath();

  // Validate it's actually an .app bundle
  if (!appPath.endsWith('.app')) {
    return { success: false, message: '빌드된 앱에서만 사용 가능합니다' };
  }
  if (!fs.existsSync(path.join(appPath, 'Contents', 'Info.plist'))) {
    return { success: false, message: '빌드된 앱에서만 사용 가능합니다' };
  }

  // Reject if running from mounted volume (DMG)
  if (appPath.startsWith('/Volumes/')) {
    return { success: false, message: 'Applications 폴더로 이동 후 등록해주세요' };
  }

  // Run lsregister
  if (!fs.existsSync(LSREGISTER)) {
    return { success: false, message: 'lsregister를 찾을 수 없습니다' };
  }
  execFileSync(LSREGISTER, ['-f', appPath]);

  return { success: true, message: '등록 완료. 시스템 설정에서 기본 앱을 선택해주세요.' };
}

async function macUnregister() {
  const appPath = macGetAppPath();
  try {
    if (fs.existsSync(LSREGISTER)) {
      execFileSync(LSREGISTER, ['-u', appPath]);
    }
  } catch { /* ignore */ }
  return { success: true, message: '파일 연결이 해제되었습니다' };
}

async function macIsRegistered() {
  // lsregister -dump is too slow; trust store value
  return store.get('fileAssociation', false);
}

function macOpenSystemSettings() {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.general');
}

// =============================================================================
// Linux Implementation
// =============================================================================

function linuxEscapeExecPath(p) {
  // Escape characters special in .desktop Exec field
  return p.replace(/(["`$\\])/g, '\\$1');
}

async function linuxRegister() {
  const executablePath = process.env.APPIMAGE || process.execPath;

  // Build .desktop file content
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  const escapedPath = linuxEscapeExecPath(executablePath);

  const content = [
    '[Desktop Entry]',
    `Name=${APP_NAME}`,
    'Comment=Lightweight Markdown Viewer',
    `Exec="${escapedPath}" %f`,
    `Icon=${iconPath}`,
    'Type=Application',
    'Categories=Development;TextEditor;',
    'MimeType=text/markdown;text/x-markdown;',
    'Terminal=false',
    'StartupNotify=true',
    ''
  ].join('\n');

  // Ensure directory exists
  const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
  fs.mkdirSync(appsDir, { recursive: true });

  // Write .desktop file
  const desktopPath = path.join(appsDir, 'doculight.desktop');
  fs.writeFileSync(desktopPath, content, 'utf-8');

  // update-desktop-database (non-fatal)
  try {
    execFileSync('update-desktop-database', [appsDir]);
  } catch { /* ignore */ }

  // Set as default for text/markdown and text/x-markdown
  try {
    execFileSync('xdg-mime', ['default', 'doculight.desktop', 'text/markdown']);
    execFileSync('xdg-mime', ['default', 'doculight.desktop', 'text/x-markdown']);
  } catch { /* ignore */ }

  return { success: true, message: '파일 연결이 등록되었습니다' };
}

async function linuxUnregister() {
  const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
  const desktopPath = path.join(appsDir, 'doculight.desktop');

  try {
    fs.unlinkSync(desktopPath);
  } catch { /* ignore */ }

  // update-desktop-database (non-fatal)
  try {
    execFileSync('update-desktop-database', [appsDir]);
  } catch { /* ignore */ }

  return { success: true, message: '파일 연결이 해제되었습니다' };
}

async function linuxIsRegistered() {
  try {
    const result = execFileSync('xdg-mime', ['query', 'default', 'text/markdown']).toString().trim();
    return result === 'doculight.desktop';
  } catch {
    return false;
  }
}

function linuxOpenSystemSettings() {
  // No universal way to open system default apps settings on Linux
  // no-op
}

// =============================================================================
// Platform Router
// =============================================================================

const platform = process.platform;

async function register() {
  if (platform === 'win32') return winRegister();
  if (platform === 'darwin') return macRegister();
  if (platform === 'linux') return linuxRegister();
  return { success: false, message: `지원하지 않는 플랫폼: ${platform}` };
}

async function unregister() {
  if (platform === 'win32') return winUnregister();
  if (platform === 'darwin') return macUnregister();
  if (platform === 'linux') return linuxUnregister();
  return { success: false, message: `지원하지 않는 플랫폼: ${platform}` };
}

async function isRegistered() {
  if (platform === 'win32') return winIsRegistered();
  if (platform === 'darwin') return macIsRegistered();
  if (platform === 'linux') return linuxIsRegistered();
  return false;
}

function openSystemSettings() {
  if (platform === 'win32') return winOpenSystemSettings();
  if (platform === 'darwin') return macOpenSystemSettings();
  if (platform === 'linux') return linuxOpenSystemSettings();
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  init,
  isSupported,
  register,
  unregister,
  isRegistered,
  openSystemSettings
};
