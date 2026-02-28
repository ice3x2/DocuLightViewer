// src/main/tokenizer.js — Korean + English composite tokenizer (CJS)
// For use with wink-bm25-text-search's definePrepTasks()
'use strict';

// Frequent Korean suffixes (particles + common verb endings)
const KO_SUFFIXES = /(?:을|를|이|가|은|는|에|의|로|와|과|에서|까지|부터|으로|에게|한테|하다|합니다|입니다|하는|하여|된|되는|되어|했다|됩니다|입니까)$/;

/**
 * Korean + English composite tokenizer.
 *
 * Layer 1: Word-level tokens (whitespace split)
 * Layer 2: Korean suffix stripping (particles/endings)
 * Layer 3: Character bi-gram (spaces removed)
 *
 * @param {string} text
 * @returns {string[]} tokens
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];

  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s가-힣\u3040-\u30FF\u4E00-\u9FFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return [];

  const tokens = [];
  const words = normalized.split(' ');

  // Layer 1: original words
  for (const w of words) {
    if (w.length > 0) tokens.push(w);
  }

  // Layer 2: strip Korean suffixes
  for (const w of words) {
    if (/[가-힣]/.test(w)) {
      const stripped = w.replace(KO_SUFFIXES, '');
      if (stripped && stripped !== w && stripped.length >= 2) {
        tokens.push(stripped);
      }
    }
  }

  // Layer 3: character bi-gram (no spaces)
  const flat = words.join('');
  for (let i = 0; i < flat.length - 1; i++) {
    tokens.push(flat.substring(i, i + 2));
  }

  return tokens;
}

module.exports = { tokenize };
