const path = require('path');
const fs = require('fs');

// Constants
const MAX_DEPTH = 10;
const MAX_TREE_FILES = 200;

/**
 * 계층적 번호 파일명 비교 (예: 00.index.md < 00-1.arch.md < 01.phase1.md)
 * 패턴: {숫자}[-{하위숫자}].나머지
 * 규칙: 주 번호 오름차순 → 하위 번호 없는 것 우선 → 하위 번호 오름차순 → 나머지 자연 정렬
 */
function compareFileNames(a, b) {
  const regex = /^(\d+)(?:-(\d+))?[.\-]/;
  const ma = a.match(regex);
  const mb = b.match(regex);

  // 둘 다 번호 패턴이 없으면 기본 자연 정렬
  if (!ma && !mb) return a.localeCompare(b, undefined, { numeric: true });
  // 번호 있는 쪽이 앞
  if (!ma) return 1;
  if (!mb) return -1;

  // 주 번호 비교
  const primaryA = parseInt(ma[1], 10);
  const primaryB = parseInt(mb[1], 10);
  if (primaryA !== primaryB) return primaryA - primaryB;

  // 같은 주 번호: 하위 번호 없는 쪽이 앞
  const hasSubA = ma[2] !== undefined;
  const hasSubB = mb[2] !== undefined;
  if (!hasSubA && hasSubB) return -1;
  if (hasSubA && !hasSubB) return 1;

  // 둘 다 하위 번호 있으면 하위 번호 비교
  if (hasSubA && hasSubB) {
    const subA = parseInt(ma[2], 10);
    const subB = parseInt(mb[2], 10);
    if (subA !== subB) return subA - subB;
  }

  // 나머지 자연 정렬
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * 디렉토리 구조 기반 .md 파일 트리 구성
 * @param {string} rootDir - 탐색 시작 디렉토리 절대 경로
 * @param {number} [depth=0] - 현재 깊이
 * @param {Object} [counter={count:0}] - 파일 수 카운터
 * @returns {Object} - 트리 노드 { path, title, exists, isDirectory, children }
 */
function buildDirectoryTree(rootDir, depth = 0, counter = { count: 0 }) {
  if (depth > MAX_DEPTH || counter.count >= MAX_TREE_FILES) {
    return { path: rootDir, title: path.basename(rootDir), exists: true, isDirectory: true, children: [] };
  }

  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return { path: rootDir, title: path.basename(rootDir), exists: false, isDirectory: true, children: [] };
  }

  // 디렉토리와 .md 파일만 필터
  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => compareFileNames(a.name, b.name));
  const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md')).sort((a, b) => compareFileNames(a.name, b.name));

  const children = [];

  // 디렉토리 먼저 (재귀)
  for (const dir of dirs) {
    const dirPath = path.join(rootDir, dir.name);
    const childNode = buildDirectoryTree(dirPath, depth + 1, counter);
    // .md 파일이 하나도 없는 빈 디렉토리 → 생략
    if (hasMdFiles(childNode)) {
      children.push(childNode);
    }
  }

  // .md 파일
  for (const file of mdFiles) {
    counter.count++;
    if (counter.count > MAX_TREE_FILES) break;
    const filePath = path.join(rootDir, file.name);
    children.push({ path: filePath, title: file.name, exists: true, isDirectory: false, children: [] });
  }

  return {
    path: rootDir,
    title: path.basename(rootDir),
    exists: true,
    isDirectory: true,
    children
  };
}

/** 트리 노드 내에 .md 파일이 하나라도 있는지 재귀 확인 */
function hasMdFiles(node) {
  if (!node.isDirectory) return true; // .md 파일 자체
  return node.children && node.children.some(c => hasMdFiles(c));
}

// Export functions
module.exports = {
  buildDirectoryTree
};
