'use strict';

const { execFile } = require('child_process');
const path = require('path');

const GIT_TIMEOUT_MS = 5000;
const MAX_COMMIT_LENGTH = 200;

/**
 * git 명령을 실행하고 stdout을 반환한다.
 * 실패/타임아웃 시 null을 반환한다 (throw 없음).
 * @param {string[]} args - git 서브커맨드 + 인자 배열
 * @param {string} cwd - 작업 디렉토리 (절대 경로)
 * @returns {Promise<string|null>}
 */
function execGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const trimmed = stdout.trim();
        resolve(trimmed || null);
      });
  });
}

/**
 * Remote URL에서 credential을 제거한다.
 * https://user:pass@host/... → https://host/...
 * git@host:... → 그대로 유지 (SSH는 credential 아님)
 * @param {string} url
 * @returns {string}
 */
function sanitizeRemoteUrl(url) {
  if (!url) return url;
  return url.replace(/\/\/[^@]+@/, '//');
}

/**
 * projectPath에서 git 정보를 수집한다.
 * 실패한 항목은 결과에서 제외된다.
 * @param {string} projectPath - 프로젝트 디렉토리 절대 경로
 * @returns {Promise<object>} truthy 필드만 포함된 객체
 */
async function collectGitInfo(projectPath) {
  const result = { projectPath };

  result.project = path.basename(projectPath);

  const [remote, branch, lastCommit, repoRoot] = await Promise.all([
    execGit(['remote', 'get-url', 'origin'], projectPath),
    execGit(['branch', '--show-current'], projectPath),
    execGit(['log', '-1', '--format=%s'], projectPath),
    execGit(['rev-parse', '--show-toplevel'], projectPath),
  ]);

  if (remote) {
    result.gitRemote = sanitizeRemoteUrl(remote);
  }

  if (branch) {
    result.gitBranch = branch;
  }

  if (lastCommit) {
    result.gitLastCommit = lastCommit.length > MAX_COMMIT_LENGTH
      ? lastCommit.substring(0, MAX_COMMIT_LENGTH) + '\u2026'
      : lastCommit;
  }

  if (repoRoot) {
    result.project = path.basename(repoRoot);
  }

  return result;
}

module.exports = { collectGitInfo };
