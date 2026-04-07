const path = require('path');
const fs = require('fs');

// Constants
const MAX_DEPTH = 10;
const MAX_DIR_FILES = 65535;  // 단일 디렉토리 최대 파일 수
const MAX_TREE_FILES = 65535; // 전체 트리 최대 파일 수

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif']);
const BINARY_EXTENSIONS = new Set(['.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib']);

/**
 * 계층적 번호 파일명 비교 (예: 00.index.md < 00-1.arch.md < 01.phase1.md)
 * 패턴: {숫자}[-{하위숫자}].나머지
 * 규칙: 주 번호 오름차순 → 하위 번호 없는 것 우선 → 하위 번호 오름차순 → 나머지 자연 정렬
 */
function compareFileNames(a, b) {
  const regex = /^(\d+)(?:-(\d+))?[.\-]/;
  const ma = a.match(regex);
  const mb = b.match(regex);

  // 둘 다 번호 패턴이 없으면 기본 자연 정렬 (en 로케일 고정)
  if (!ma && !mb) return a.localeCompare(b, 'en', { numeric: true });
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

  // 나머지 자연 정렬 (en 로케일 고정)
  return a.localeCompare(b, 'en', { numeric: true });
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

  // .md 파일 (디렉토리별 예산 제한)
  let dirFileCount = 0;
  for (const file of mdFiles) {
    if (dirFileCount >= MAX_DIR_FILES || counter.count >= MAX_TREE_FILES) break;
    dirFileCount++;
    counter.count++;
    const filePath = path.join(rootDir, file.name);
    // frontmatter name/title 파싱
    let fmName = null;
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const fmNameMatch = fileContent.match(/^---\s*\n[\s\S]*?name:\s*(.+)\n[\s\S]*?---/i);
      if (fmNameMatch) {
        const val = fmNameMatch[1].trim().replace(/^["']|["']$/g, '').trim();
        if (val) fmName = val;
      }
      if (!fmName) {
        const fmTitleMatch = fileContent.match(/^---\s*\n[\s\S]*?title:\s*(.+)\n[\s\S]*?---/i);
        if (fmTitleMatch) {
          const val = fmTitleMatch[1].trim().replace(/^["']|["']$/g, '').trim();
          if (val) fmName = val;
        }
      }
    } catch (_) { /* 읽기 실패 시 null 유지 */ }
    children.push({ path: filePath, title: file.name, frontmatterName: fmName, exists: true, isDirectory: false, children: [] });
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

// ---------------------------------------------------------------------------
// 링크 기반 트리 빌드
// ---------------------------------------------------------------------------

/**
 * 펜스드 코드 블록과 인라인 코드를 제거
 */
function stripCodeBlocks(content) {
  // 펜스드 코드 블록 (```...```) 제거
  let stripped = content.replace(/```[\s\S]*?```/g, '');
  // 인라인 코드 (`...`) 제거
  stripped = stripped.replace(/`[^`]+`/g, '');
  return stripped;
}

/**
 * 마크다운 콘텐츠에서 로컬 마크다운 파일 링크 추출
 * @param {string} content - 마크다운 콘텐츠
 * @param {string} basePath - 상대 경로 해석 기준 디렉토리
 * @returns {Array<{resolvedPath: string, title: string}>}
 */
function extractMarkdownLinks(content, basePath) {
  const stripped = stripCodeBlocks(content);
  const seen = new Set();
  const results = [];

  // [text](href) 매칭
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(stripped)) !== null) {
    processLink(match[2], match[1], basePath, seen, results);
  }

  // [[wikilink]] 매칭
  const wikiRegex = /\[\[([^\]]+)\]\]/g;
  while ((match = wikiRegex.exec(stripped)) !== null) {
    processLink(match[1], match[1], basePath, seen, results);
  }

  return results;
}

function processLink(href, title, basePath, seen, results) {
  // 프로토콜이 있으면 스킵 (http, https, ftp, mailto 등)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return;
  // 앵커 전용 스킵
  if (href.startsWith('#')) return;

  // 쿼리 스트링과 앵커 제거
  let cleaned = href.split('?')[0].split('#')[0];
  if (!cleaned) return;

  // URI 디코딩
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch { /* 디코딩 오류 무시 */ }

  // 이미지/바이너리 확장자 스킵
  const ext = path.extname(cleaned).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext) || BINARY_EXTENSIONS.has(ext)) return;

  // 확장자 없으면 .md 추가; .md/.markdown이 아니면 스킵
  if (!ext) {
    cleaned += '.md';
  } else if (ext !== '.md' && ext !== '.markdown') {
    return;
  }

  // 절대 경로로 변환
  const resolved = path.resolve(basePath, cleaned);
  const normalized = path.normalize(resolved);

  // 중복 제거
  if (seen.has(normalized)) return;
  seen.add(normalized);

  results.push({ resolvedPath: normalized, title: title || path.basename(normalized) });
}

/**
 * 마크다운 링크를 따라 트리 빌드
 * @param {string} filePath - 시작 파일 절대 경로
 * @param {Set} [visited] - 분기별 visited 셋 (순환 참조 방지)
 * @param {number} [depth=0] - 현재 재귀 깊이
 * @param {Object} [counter={count:0}] - 글로벌 파일 카운터
 * @param {Set} [globalSeen] - 글로벌 seen 셋 (중복 확장 방지)
 * @returns {Object|null} 트리 노드
 */
function buildLinkTree(filePath, visited, depth = 0, counter = { count: 0 }, globalSeen) {
  if (!visited) visited = new Set();
  if (!globalSeen) globalSeen = new Set();

  const normalized = path.normalize(filePath);

  if (depth > MAX_DEPTH) return null;
  if (visited.has(normalized)) return null; // 순환 참조

  // 파일 읽기 시도
  let content;
  try {
    content = fs.readFileSync(normalized, 'utf-8');
  } catch {
    return { path: normalized, title: path.basename(normalized), frontmatterName: null, exists: false, isDirectory: false, children: [] };
  }

  // 제목 추출: frontmatter title: → 첫 H1 → basename (대소문자 무시)
  let title = path.basename(normalized);
  const frontmatterMatch = content.match(/^---\s*\n[\s\S]*?title:\s*(.+)\n[\s\S]*?---/i);
  if (frontmatterMatch) {
    title = frontmatterMatch[1].trim().replace(/^["']|["']$/g, '');
  } else {
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) title = h1Match[1].trim();
  }

  // name 필드 파싱 (대소문자 무시, name → title 우선순위)
  let frontmatterName = null;
  const nameMatch = content.match(/^---\s*\n[\s\S]*?name:\s*(.+)\n[\s\S]*?---/i);
  if (nameMatch) {
    const nameVal = nameMatch[1].trim().replace(/^["']|["']$/g, '').trim();
    if (nameVal) frontmatterName = nameVal;
  }
  // name이 없으면 frontmatter title을 대체로 사용
  if (!frontmatterName && frontmatterMatch) {
    frontmatterName = title;
  }

  // 이미 글로벌에서 확장했으면 leaf 노드로 반환 (중복 방지)
  if (globalSeen.has(normalized)) {
    return { path: normalized, title, frontmatterName, exists: true, isDirectory: false, children: [] };
  }
  globalSeen.add(normalized);

  // 링크 추출 및 재귀
  const links = extractMarkdownLinks(content, path.dirname(normalized));
  const children = [];

  visited.add(normalized);
  for (const link of links) {
    counter.count++;
    if (counter.count > MAX_TREE_FILES) break;
    const childNode = buildLinkTree(link.resolvedPath, new Set(visited), depth + 1, counter, globalSeen);
    if (childNode) {
      children.push(childNode);
    }
  }

  return { path: normalized, title, frontmatterName, exists: true, isDirectory: false, children };
}

/**
 * 트리 내 전체 노드 수 재귀 카운트
 */
function countTreeFiles(node) {
  if (!node) return 0;
  let count = 1;
  if (node.children) {
    for (const child of node.children) {
      count += countTreeFiles(child);
    }
  }
  return count;
}

/**
 * 링크 트리에서 모든 경로를 Set으로 수집
 * @param {Object} node - 링크 트리 노드
 * @returns {Set<string>} 소문자 정규화된 경로 Set
 */
function collectLinkedPaths(node) {
  const paths = new Set();
  (function walk(n) {
    if (!n) return;
    paths.add(path.normalize(n.path).toLowerCase());
    if (n.children) n.children.forEach(walk);
  })(node);
  return paths;
}

/**
 * dirTree를 순회하며 linkedPaths에 있는 노드에 linked=true 마킹. 매칭되면 Set에서 삭제
 * @param {Object} node - 디렉토리 트리 노드
 * @param {Set<string>} linkedPaths - 매칭할 경로 Set (변경됨)
 */
function markLinkedNodes(node, linkedPaths) {
  const norm = path.normalize(node.path).toLowerCase();
  if (linkedPaths.has(norm)) {
    node.linked = true;
    linkedPaths.delete(norm);
  }
  if (node.children) {
    for (const child of node.children) {
      markLinkedNodes(child, linkedPaths);
    }
  }
}

/**
 * linkedPaths에 남은 (디렉토리 외부) 경로들에 대해 linkTree에서 노드 정보 추출
 * @param {Object} linkTree - 링크 트리
 * @param {Set<string>} remainingPaths - 아직 매칭되지 않은 경로 (변경됨)
 * @returns {Array<Object>} 외부 링크 노드 배열
 */
function buildExternalNodes(linkTree, remainingPaths) {
  const nodes = [];
  (function walk(n) {
    if (!n) return;
    const norm = path.normalize(n.path).toLowerCase();
    if (remainingPaths.has(norm)) {
      nodes.push({
        path: n.path, title: n.title, exists: n.exists,
        isDirectory: false, children: [], linked: true
      });
      remainingPaths.delete(norm);
    }
    if (n.children) n.children.forEach(walk);
  })(linkTree);
  return nodes;
}

/**
 * 사이드바 트리 빌드: 링크 트리와 디렉토리 트리를 머지
 * @param {string} filePath - 열린 파일의 절대 경로
 * @returns {Object} treeType 속성 포함 트리 ('merged' 또는 'directory')
 */
function buildSidebarTree(filePath) {
  const normalized = path.normalize(filePath);
  const dirRoot = path.dirname(normalized);

  // 1. 링크 트리 빌드
  const linkTree = buildLinkTree(normalized);
  const totalLinks = countTreeFiles(linkTree);

  // 2. 디렉토리 트리 빌드 (항상)
  const dirTree = buildDirectoryTree(dirRoot);

  if (totalLinks <= 1) {
    // 링크 없음 → 순수 디렉토리 트리
    dirTree.treeType = 'directory';
    return dirTree;
  }

  // 3. 머지: 링크된 경로 수집 → dirTree에 마킹 → 외부 링크 추가
  const linkedPaths = collectLinkedPaths(linkTree);
  markLinkedNodes(dirTree, linkedPaths);

  // linkedPaths에서 dirTree에 매칭된 것들은 제거됨 → 남은 것 = 외부 링크
  if (linkedPaths.size > 0) {
    const externalNodes = buildExternalNodes(linkTree, linkedPaths);
    if (externalNodes.length > 0) {
      dirTree.children.push({
        path: '', title: '__external_links__',
        exists: true, isDirectory: true, isVirtual: true,
        children: externalNodes
      });
    }
  }

  dirTree.treeType = 'merged';
  dirTree.linkRoot = normalized;
  return dirTree;
}

// Export functions
module.exports = {
  buildDirectoryTree,
  buildSidebarTree,
  buildLinkTree,
  extractMarkdownLinks,
  countTreeFiles,
  compareFileNames,
  // 테스트용
  collectLinkedPaths,
  markLinkedNodes
};
