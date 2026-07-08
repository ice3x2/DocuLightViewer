'use strict';

const { tokenize: basicTokenize } = require('./tokenizer');

const CONTENT_POS = new Set([
  'NNG', 'NNP', 'NNB', 'NR', 'NP',
  'VV', 'VA', 'VX', 'XR',
  'SL', 'SN'
]);

const DEFAULT_GARU_VERSION = '0.9.6';
const DEFAULT_MAX_ANALYSIS_CHARS = 1200;
const EDGE_PUNCT = new RegExp('^[^\\w\\uAC00-\\uD7A3]+|[^\\w\\uAC00-\\uD7A3]+$', 'g');

function uniqueTokens(tokens) {
  const seen = new Set();
  const out = [];
  for (const raw of tokens || []) {
    const token = normalizeToken(raw);
    if (!token || token.length > 64 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function normalizeToken(token) {
  return String(token || '').toLowerCase().replace(EDGE_PUNCT, '').trim();
}

function createBasicKeywordTokenizer() {
  return new KeywordTokenizer({ provider: 'basic' });
}

function createKeywordTokenizer(options = {}) {
  return new KeywordTokenizer(options);
}

class KeywordTokenizer {
  constructor(options = {}) {
    this.provider = options.provider || 'garu';
    const requestedMaxAnalysisChars = Number(options.maxAnalysisChars) > 0
      ? Number(options.maxAnalysisChars)
      : DEFAULT_MAX_ANALYSIS_CHARS;
    this.maxAnalysisChars = Math.min(requestedMaxAnalysisChars, DEFAULT_MAX_ANALYSIS_CHARS);
    this._loadGaru = options.loadGaru || loadDefaultGaru;
    this._garu = null;
    this._garuVersion = null;
    this._degradedReason = null;
    this._initialized = this.provider !== 'garu';
  }

  async initialize() {
    if (this._initialized) return this;
    this._initialized = true;

    if (this.provider !== 'garu') return this;

    try {
      this._garu = await this._loadGaru();
      const info = typeof this._garu.modelInfo === 'function' ? this._garu.modelInfo() : null;
      this._garuVersion = info && info.version ? String(info.version) : DEFAULT_GARU_VERSION;
      this._degradedReason = null;
    } catch (err) {
      this._garu = null;
      this._garuVersion = null;
      this._degradedReason = err && err.message ? err.message : String(err);
    }
    return this;
  }

  tokenize(text) {
    const analysisText = this._buildAnalysisText(text);
    const base = basicTokenize(analysisText);
    const garuTokens = this._tokenizeWithGaru(analysisText);
    return uniqueTokens([...base, ...garuTokens]);
  }

  tokenizeQuery(query) {
    return this.tokenize(query);
  }

  buildSearchText(raw) {
    const text = String(raw || '');
    const boundedText = this._buildAnalysisText(text);
    const tokens = this.tokenize(boundedText);
    return `${boundedText} ${tokens.join(' ')}`.trim();
  }

  getStatus() {
    if (this._garu) {
      return {
        provider: 'garu-ko',
        version: this._garuVersion || DEFAULT_GARU_VERSION,
        available: true,
        degradedReason: this._degradedReason,
        maxAnalysisChars: this.maxAnalysisChars
      };
    }
    return {
      provider: 'basic',
      version: 'builtin',
      available: false,
      degradedReason: this._degradedReason,
      maxAnalysisChars: this.maxAnalysisChars
    };
  }

  getIndexMetadata() {
    const status = this.getStatus();
    return {
      tokenizer_provider: status.provider,
      tokenizer_version: status.version,
      tokenizer_degraded_reason: status.degradedReason || ''
    };
  }

  _tokenizeWithGaru(text) {
    if (!this._garu || !text) return [];
    try {
      const result = this._garu.analyze(text);
      const tokens = Array.isArray(result) ? (result[0] && result[0].tokens) || [] : result.tokens || [];
      return tokens
        .filter((token) => CONTENT_POS.has(token.pos))
        .map((token) => token.text);
    } catch (err) {
      this._degradedReason = err && err.message ? err.message : String(err);
      return [];
    }
  }

  _buildAnalysisText(text) {
    const raw = String(text || '');
    if (!raw) return '';

    const prefix = raw.slice(0, this.maxAnalysisChars);
    const h1 = prefix.match(/^#{1,6}\s+(.+)$/m);
    const frontmatter = prefix.match(/^---\r?\n[\s\S]*?\r?\n---/m);
    const headings = Array.from(prefix.matchAll(/^#{1,4}\s+.+$/gm)).map((match) => match[0]).join('\n');
    const selected = [
      frontmatter ? frontmatter[0] : '',
      h1 ? h1[1] : '',
      headings,
      prefix
    ].filter(Boolean).join('\n');

    return selected.slice(0, this.maxAnalysisChars);
  }
}

async function loadDefaultGaru() {
  const mod = await import('garu-ko/node');
  const garu = await withFilteredGaruInitWarning(() => mod.Garu.load());
  return garu;
}

async function withFilteredGaruInitWarning(fn) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    const message = args.map((arg) => String(arg)).join(' ');
    if (message.includes('using deprecated parameters for the initialization function')) {
      return;
    }
    originalWarn(...args);
  };
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

module.exports = {
  createBasicKeywordTokenizer,
  createKeywordTokenizer,
  KeywordTokenizer,
  uniqueTokens
};
