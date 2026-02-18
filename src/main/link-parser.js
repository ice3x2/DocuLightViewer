// Use vendored UMD bundle (the npm 'marked' v17+ is ESM-only, incompatible with CJS require)
const { marked } = require('../renderer/lib/marked.min.js');
const path = require('path');
const fs = require('fs');

// Constants
const MAX_DEPTH = 10;
const MAX_TREE_FILES = 200;
const DEPTH_CUTOFF = 5; // When MAX_TREE_FILES reached, stop at this depth

const EXCLUDED_PROTOCOLS = new Set([
  'http:', 'https:', 'mailto:', 'tel:', 'ftp:', 'data:', 'javascript:', 'vbscript:'
]);

const EXCLUDED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dmg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov'
]);

/**
 * Extract title from Markdown content
 * Priority: YAML frontmatter > H1 heading > null
 * @param {string} markdown - Markdown content
 * @returns {string|null} - Extracted title or null
 */
function extractTitle(markdown) {
  // Priority 1: YAML frontmatter title field
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
    if (titleMatch) {
      return titleMatch[1].trim().replace(/^["']|["']$/g, ''); // Remove quotes if present
    }
  }

  // Priority 2: First H1 heading
  try {
    const tokens = marked.lexer(markdown);
    for (const token of tokens) {
      if (token.type === 'heading' && token.depth === 1) {
        return token.text;
      }
    }
  } catch (error) {
    // If parsing fails, continue to priority 3
  }

  // Priority 3: Return null
  return null;
}

/**
 * Check if an extension is excluded
 * @param {string} ext - File extension (with dot)
 * @returns {boolean} - True if excluded
 */
function isExcludedExtension(ext) {
  return EXCLUDED_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Check if href is a local markdown link (not excluded)
 * @param {string} href - Link href
 * @returns {boolean} - True if local markdown link
 */
function isLocalMarkdownLink(href) {
  // Skip anchor-only links
  if (href.startsWith('#')) {
    return false;
  }

  // Skip excluded protocols
  try {
    const url = new URL(href, 'file:///dummy');
    if (EXCLUDED_PROTOCOLS.has(url.protocol)) {
      return false;
    }
  } catch (error) {
    // Not a URL, treat as relative path (continue checking)
  }

  // Check if starts with protocol (already checked excluded ones above)
  if (/^[a-z]+:/i.test(href)) {
    return false;
  }

  return true;
}

/**
 * Resolve link href relative to base path
 * @param {string} href - Link href
 * @param {string} basePath - Base directory path
 * @returns {string} - Resolved absolute path
 */
function resolveLink(href, basePath) {
  const resolved = path.resolve(basePath, href);
  return path.normalize(resolved);
}

/**
 * Recursively walk tokens to find all links
 * @param {Array} tokens - Marked tokens
 * @param {Set} links - Set to collect link hrefs
 */
function walkTokens(tokens, links) {
  for (const token of tokens) {
    // Skip code blocks and inline code
    if (token.type === 'code' || token.type === 'codespan') {
      continue;
    }

    // Skip image tokens
    if (token.type === 'image') {
      continue;
    }

    // Collect link hrefs
    if (token.type === 'link' && token.href) {
      links.add(token.href);
    }

    // Recursively walk nested tokens
    if (token.tokens && Array.isArray(token.tokens)) {
      walkTokens(token.tokens, links);
    }

    // Handle list items
    if (token.type === 'list' && token.items) {
      walkTokens(token.items, links);
    }

    // Handle table cells
    if (token.type === 'table') {
      if (token.header) {
        walkTokens(token.header, links);
      }
      if (token.rows) {
        for (const row of token.rows) {
          walkTokens(row, links);
        }
      }
    }
  }
}

/**
 * Extract wiki links from markdown text, excluding code blocks
 * @param {string} markdown - Raw markdown content
 * @returns {string[]} - Array of wiki link paths
 */
function extractWikiLinks(markdown) {
  const wikiLinks = [];

  // Remove code blocks first
  const withoutCodeBlocks = markdown
    .replace(/```[\s\S]*?```/g, '') // Remove fenced code blocks
    .replace(/`[^`]+`/g, ''); // Remove inline code

  // Find wiki links
  const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = wikiLinkRegex.exec(withoutCodeBlocks)) !== null) {
    wikiLinks.push(match[1]);
  }

  return wikiLinks;
}

/**
 * Parse local links from Markdown content
 * @param {string} markdown - Markdown content
 * @param {string} basePath - Base directory path
 * @returns {string[]} - Array of resolved absolute paths to local markdown files
 */
function parseLocalLinks(markdown, basePath) {
  const linkSet = new Set();
  const resolvedPaths = new Set();

  // Parse standard markdown links using marked
  try {
    const tokens = marked.lexer(markdown);
    walkTokens(tokens, linkSet);
  } catch (error) {
    console.error('Error parsing markdown:', error);
  }

  // Extract wiki links
  const wikiLinks = extractWikiLinks(markdown);
  wikiLinks.forEach(link => linkSet.add(link));

  // Process all collected links
  for (let href of linkSet) {
    // Filter by protocol and anchor
    if (!isLocalMarkdownLink(href)) {
      continue;
    }

    // URL decode
    try {
      href = decodeURIComponent(href);
    } catch (error) {
      // If decode fails, use original
    }

    // Strip anchor
    href = href.split('#')[0];

    // Strip query
    href = href.split('?')[0];

    // Skip empty hrefs
    if (!href) {
      continue;
    }

    // Resolve path
    const resolved = resolveLink(href, basePath);

    // Check extension
    const ext = path.extname(resolved);

    if (ext) {
      // Has extension - check if excluded
      if (isExcludedExtension(ext)) {
        continue;
      }
      // Only allow .md files
      if (ext.toLowerCase() !== '.md') {
        continue;
      }
      // .md files are included even if they don't exist
      // (buildLinkTree will mark them as exists: false)
    } else {
      // No extension - try adding .md
      const mdPath = resolved + '.md';
      if (fs.existsSync(mdPath)) {
        // Use .md version
        resolvedPaths.add(mdPath);
        continue;
      } else if (fs.existsSync(resolved)) {
        // Original path exists but not .md - skip
        continue;
      } else {
        // Neither exists - skip
        continue;
      }
    }

    // Check if symlink
    try {
      const stats = fs.lstatSync(resolved);
      if (stats.isSymbolicLink()) {
        continue;
      }
    } catch (error) {
      // If lstat fails, skip
      continue;
    }

    // Add to resolved paths
    resolvedPaths.add(resolved);
  }

  return Array.from(resolvedPaths);
}

/**
 * Build a recursive link tree from a markdown file
 * @param {string} filePath - Absolute path to markdown file
 * @param {Set} visited - Set of visited paths (for cycle detection in current branch)
 * @param {number} depth - Current depth
 * @param {Object} counter - Shared counter object {count: number}
 * @param {Set} [globalSeen] - Global set tracking files already expanded in the tree
 * @returns {Object|null} - Tree node or null if skipped
 */
function buildLinkTree(filePath, visited = new Set(), depth = 0, counter = { count: 0 }, globalSeen = new Set()) {
  // Check depth limit
  if (depth > MAX_DEPTH) {
    return null;
  }

  // Normalize path for comparison
  const normalizedPath = path.normalize(filePath);

  // Check for circular reference in current branch
  if (visited.has(normalizedPath)) {
    return null;
  }

  // Add to visited set for this branch
  visited.add(normalizedPath);

  // Read file content
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    // File doesn't exist or can't be read
    return {
      path: filePath,
      title: path.basename(filePath, '.md'),
      exists: false,
      children: []
    };
  }

  // Extract title
  const title = extractTitle(content) || path.basename(filePath, '.md');

  // If this file already appears elsewhere in the tree, skip it entirely
  if (globalSeen.has(normalizedPath)) {
    return null;
  }

  // Mark as expanded globally
  globalSeen.add(normalizedPath);

  // Parse links
  const links = parseLocalLinks(content, path.dirname(filePath));

  // Increment counter
  counter.count++;

  // Build children
  const children = [];
  let reachedLimit = false;
  const remainingCount = links.length;

  for (let i = 0; i < links.length; i++) {
    const linkPath = links[i];

    // Check if we've reached the file limit and depth cutoff
    if (counter.count >= MAX_TREE_FILES && depth >= DEPTH_CUTOFF) {
      // Add indicator node for remaining files
      const remaining = remainingCount - i;
      children.push({
        path: '...',
        title: `... (${remaining}개 더)`,
        exists: true,
        children: []
      });
      reachedLimit = true;
      break;
    }

    // Recurse with new branch visited set but shared globalSeen
    const childNode = buildLinkTree(linkPath, new Set(visited), depth + 1, counter, globalSeen);

    // Skip null results
    if (childNode !== null) {
      children.push(childNode);
    }
  }

  return {
    path: filePath,
    title,
    exists: true,
    children
  };
}

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
  buildLinkTree,
  buildDirectoryTree,
  parseLocalLinks,
  extractTitle
};
