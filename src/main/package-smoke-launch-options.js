'use strict';

function shouldDisableSandbox(platform, environment) {
  return platform === 'linux' && environment.GITHUB_ACTIONS === 'true';
}

function getPackageSmokeLaunchArgs(platform, environment = process.env) {
  const args = ['--package-smoke'];
  if (shouldDisableSandbox(platform, environment)) args.push('--no-sandbox');
  return args;
}

function getPackageSmokeCliStdioArgs(platform, environment = process.env) {
  const args = ['--mcp-stdio'];
  if (shouldDisableSandbox(platform, environment)) args.push('--no-sandbox');
  return args;
}

module.exports = {
  getPackageSmokeLaunchArgs,
  getPackageSmokeCliStdioArgs
};
