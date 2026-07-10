'use strict';

function getPackageSmokeLaunchArgs(platform, environment = process.env) {
  const args = ['--package-smoke'];
  if (platform === 'linux' && environment.GITHUB_ACTIONS === 'true') {
    args.push('--no-sandbox');
  }
  return args;
}

module.exports = { getPackageSmokeLaunchArgs };
