'use strict';

const crypto = require('crypto');

const DEFAULT_MAX_TOKENS = 900;
const DEFAULT_OVERLAP_TOKENS = 120;
const CHUNKER_VERSION = 'heading-aware-v1';

// @req DR-DOC-008
class HeadingAwareChunker {
  constructor({ maxTokens = DEFAULT_MAX_TOKENS, overlapTokens = DEFAULT_OVERLAP_TOKENS } = {}) {
    this.maxTokens = Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS);
    this.overlapTokens = Math.max(0, Math.min(Number(overlapTokens) || 0, this.maxTokens - 1));
  }

  // @req DR-DOC-008
  chunkMarkdown(content, { documentId = 'document' } = {}) {
    const source = typeof content === 'string' ? content : '';
    const bodyInfo = stripFrontmatter(source);
    const sections = splitSections(bodyInfo.body, {
      baseOffset: bodyInfo.baseOffset,
      baseLine: bodyInfo.baseLine
    });
    const chunks = [];
    for (const section of sections) {
      const sectionText = section.text.trim();
      if (!sectionText) continue;
      const tokens = tokenizeWithPositions(sectionText);
      if (tokens.length <= this.maxTokens) {
        chunks.push(buildChunk({
          documentId,
          ordinal: chunks.length,
          section,
          text: sectionText,
          tokenCount: tokens.length,
          relativeStart: leadingTrimLength(section.text),
          relativeEnd: section.text.length
        }));
        continue;
      }

      const step = Math.max(1, this.maxTokens - this.overlapTokens);
      for (let startToken = 0; startToken < tokens.length; startToken += step) {
        const endToken = Math.min(tokens.length, startToken + this.maxTokens);
        const start = tokens[startToken].start;
        const end = tokens[endToken - 1].end;
        const text = sectionText.slice(start, end).trim();
        chunks.push(buildChunk({
          documentId,
          ordinal: chunks.length,
          section,
          text,
          tokenCount: endToken - startToken,
          relativeStart: leadingTrimLength(section.text) + start,
          relativeEnd: leadingTrimLength(section.text) + end
        }));
        if (endToken >= tokens.length) break;
      }
    }
    return chunks;
  }
}

// @req DR-DOC-008
function createHeadingAwareChunker(options = {}) {
  return new HeadingAwareChunker(options);
}

function stripFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/);
  if (!match) {
    return { body: content, baseOffset: 0, baseLine: 1 };
  }
  return {
    body: content.slice(match[0].length),
    baseOffset: match[0].length,
    baseLine: countNewlines(match[0]) + 1
  };
}

function splitSections(body, { baseOffset, baseLine }) {
  const lines = lineRecords(body, baseOffset, baseLine);
  const sections = [];
  const headingStack = [];
  let current = newSection([], null, lines.length ? lines[0] : null);

  for (const line of lines) {
    const heading = line.text.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (current.lines.length) sections.push(finishSection(current));
      const level = heading[1].length;
      headingStack.length = level - 1;
      headingStack[level - 1] = heading[2].trim();
      current = newSection(headingStack.filter(Boolean), level, line);
    }
    current.lines.push(line);
  }
  if (current.lines.length) sections.push(finishSection(current));
  if (sections.length) return sections;
  return [{
    headingPath: [],
    headingLevel: null,
    lineStart: baseLine,
    lineEnd: baseLine,
    offsetStart: baseOffset,
    offsetEnd: baseOffset,
    text: ''
  }];
}

function newSection(headingPath, headingLevel, firstLine) {
  return {
    headingPath: headingPath.slice(),
    headingLevel,
    firstLine,
    lines: []
  };
}

function finishSection(section) {
  const first = section.lines[0] || section.firstLine;
  const last = section.lines[section.lines.length - 1] || first;
  const offsetStart = first ? first.start : 0;
  const offsetEnd = last ? last.end : offsetStart;
  return {
    headingPath: section.headingPath,
    headingLevel: section.headingLevel,
    lineStart: first ? first.lineNumber : null,
    lineEnd: last ? last.lineNumber : null,
    offsetStart,
    offsetEnd,
    text: section.lines.map((line) => line.text).join('\n')
  };
}

function lineRecords(text, baseOffset, baseLine) {
  const records = [];
  const regex = /.*(?:\r?\n|$)/g;
  let match;
  let lineNumber = baseLine;
  while ((match = regex.exec(text)) !== null) {
    if (match[0] === '' && match.index === text.length) break;
    const raw = match[0];
    const stripped = raw.replace(/\r?\n$/, '');
    records.push({
      text: stripped,
      lineNumber,
      start: baseOffset + match.index,
      end: baseOffset + match.index + raw.length
    });
    lineNumber += 1;
  }
  return records;
}

function buildChunk({ documentId, ordinal, section, text, tokenCount, relativeStart, relativeEnd }) {
  const offsetStart = section.offsetStart + relativeStart;
  const offsetEnd = section.offsetStart + relativeEnd;
  const lineStart = section.lineStart == null ? null : section.lineStart + countNewlines(section.text.slice(0, relativeStart));
  const lineEnd = section.lineStart == null ? null : section.lineStart + countNewlines(section.text.slice(0, relativeEnd));
  const textHash = stableHash(text);
  return {
    chunkId: stableId('chk', documentId, CHUNKER_VERSION, String(ordinal), textHash),
    ordinal,
    kind: 'markdown',
    headingPath: section.headingPath.slice(),
    headingLevel: section.headingLevel,
    lineStart,
    lineEnd,
    offsetStart,
    offsetEnd,
    tokenCount,
    textHash,
    metadata: {
      chunkerVersion: CHUNKER_VERSION
    },
    text
  };
}

function tokenizeWithPositions(text) {
  const tokens = [];
  const regex = /\S+/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tokens.push({ value: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function countNewlines(text) {
  const matches = String(text).match(/\n/g);
  return matches ? matches.length : 0;
}

function leadingTrimLength(text) {
  const match = String(text).match(/^\s*/);
  return match ? match[0].length : 0;
}

function stableId(prefix, ...parts) {
  return `${prefix}_${stableHash(parts.join('\0')).slice(0, 24)}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = {
  HeadingAwareChunker,
  createHeadingAwareChunker,
  CHUNKER_VERSION,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OVERLAP_TOKENS
};
