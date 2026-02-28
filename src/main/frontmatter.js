// src/main/frontmatter.js — Frontmatter injection utility (CJS)
'use strict';

/**
 * Inject or merge YAML frontmatter into markdown content.
 *
 * If content already has a frontmatter block (---\n...\n---), the new metadata
 * fields are merged in (new values take priority). Otherwise, a new frontmatter
 * block is prepended.
 *
 * @param {string} content - Raw markdown content
 * @param {object} meta - Metadata fields to inject
 * @param {string} [meta.project]
 * @param {string} [meta.docName]
 * @param {string} [meta.description]
 * @returns {string} Content with frontmatter prepended/merged
 */
function injectFrontmatter(content, { project, docName, description }) {
  const newFields = {};
  if (project) newFields.project = project;
  if (docName) newFields.docName = docName;
  if (description) newFields.description = description;
  newFields.date = new Date().toISOString().replace(/\.\d{3}Z$/, '');

  // Check if content already has frontmatter
  const fmRegex = /^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/;
  const match = content.match(fmRegex);

  if (match) {
    // Parse existing frontmatter and merge (new values override existing)
    const existingFields = parseSimpleYaml(match[1] || '');
    const merged = { ...existingFields, ...newFields };
    const yamlBlock = buildYamlBlock(merged);
    return yamlBlock + content.slice(match[0].length);
  }

  // No existing frontmatter: prepend new block
  const yamlBlock = buildYamlBlock(newFields);
  return yamlBlock + content;
}

/**
 * Parse simple YAML key-value pairs (no nesting, no arrays).
 *
 * @param {string} yaml - Raw YAML content (without --- delimiters)
 * @returns {object} Parsed key-value pairs
 */
function parseSimpleYaml(yaml) {
  const result = {};
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (m) {
      const key = m[1];
      let value = m[2].trim();
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  return result;
}

/**
 * Build a YAML frontmatter block string from key-value pairs.
 *
 * @param {object} fields - Key-value pairs
 * @returns {string} Complete frontmatter block with --- delimiters and trailing newline
 */
function buildYamlBlock(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    // Quote values that contain special YAML characters
    const needsQuote = /[:#\[\]{}&*!|>'"`,@%]/.test(String(value)) ||
                       String(value).includes('\n');
    const formatted = needsQuote
      ? `"${String(value).replace(/"/g, '\\"')}"`
      : String(value);
    lines.push(`${key}: ${formatted}`);
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

/**
 * Extract and parse frontmatter from full markdown content.
 *
 * @param {string} content - Full markdown content (may or may not have frontmatter)
 * @returns {{ data: object, body: string }} data: parsed key-value pairs, body: content without frontmatter
 */
function parseFrontmatter(content) {
  const fmRegex = /^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/;
  const match = content.match(fmRegex);
  if (match) {
    return {
      data: parseSimpleYaml(match[1] || ''),
      body: content.slice(match[0].length)
    };
  }
  return { data: {}, body: content };
}

module.exports = { injectFrontmatter, parseSimpleYaml, buildYamlBlock, parseFrontmatter };
