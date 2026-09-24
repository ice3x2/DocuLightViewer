'use strict';

const crypto = require('node:crypto');

// @req REL-DOC-007 FR-DOC-019
const MAX_SAVE_BYTES = 10 * 1024 * 1024;
const TARGET_BYTES = MAX_SAVE_BYTES - 1024;

function largeMarkdownFixture() {
  const header = '---\ntitle: S22 large document\ncategory: engineering\ndocumentTags: [performance, 색인]\n---\n# s22fullindexproof\n';
  const sections = [header];
  const tail = 'Final paragraph contains mixed language and a [link](./related-final.md).\n';
  let usedBytes = Buffer.byteLength(header) + Buffer.byteLength(tail);
  for (let i = 0; ; i += 1) {
    const label = String(i).padStart(4, '0');
    const lines = [`## Section ${label} 문서 색인 and search\n`,
      `한국어 문장과 English words describe section ${label}. [Related note](./related-${label}.md) is linked here.\n`,
      '```js\n', `const section${label} = "indexing code fence and 링크 ${label}";\n`, '```\n'];
    for (let j = 0; j < 55; j += 1) {
      lines.push(`Paragraph ${label}.${String(j).padStart(2, '0')}: 저장된 Markdown preserves metadata and searchable English text. 검색 문서 색인 작업은 안전하게 계속됩니다.\n`);
    }
    const section = lines.join('');
    const sectionBytes = Buffer.byteLength(section);
    if (usedBytes + sectionBytes > TARGET_BYTES - 256) break;
    sections.push(section);
    usedBytes += sectionBytes;
  }
  for (let i = 0; ; i += 1) {
    const line = `Appendix note ${String(i).padStart(4, '0')}: English and 한국어 indexing observations link to [record](./linked-${i}.md).\n`;
    const lineBytes = Buffer.byteLength(line);
    if (usedBytes + lineBytes > TARGET_BYTES) break;
    sections.push(line);
    usedBytes += lineBytes;
  }
  sections.push(tail);
  const bytes = Buffer.from(sections.join(''), 'utf8');
  return { bytes, byteLength: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

module.exports = { largeMarkdownFixture, MAX_SAVE_BYTES, TARGET_BYTES };
