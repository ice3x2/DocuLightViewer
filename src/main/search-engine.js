// src/main/search-engine.js — BM25 full-text search engine (CJS)
'use strict';

const bm25 = require('wink-bm25-text-search');
const path = require('path');
const fs = require('fs');
const { tokenize } = require('./tokenizer');
const { parseSimpleYaml } = require('./frontmatter');

const INDEX_FILENAME = '.doculight-search-index.json';
const FM_REGEX = /^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/;
const MIN_DOCS_FOR_CONSOLIDATE = 3;

class SearchEngine {
  constructor(store) {
    this.store = store;
    this.engine = null;
    this.docMeta = new Map(); // docId → { title, project, docName, description, date, snippet }
    this.dirty = false;
    this.initialized = false;
  }

  // ─── Initialization ──────────────────────────────────────

  /**
   * Initialize search engine. Load existing index or build from scratch.
   */
  async initialize() {
    const savePath = this.store.get('mcpAutoSavePath', '');
    if (!savePath) return;

    const indexPath = path.join(savePath, INDEX_FILENAME);
    try {
      if (fs.existsSync(indexPath)) {
        await this._loadIndex(indexPath);
      } else {
        await this.rebuild();
      }
      this.initialized = true;
    } catch (err) {
      console.error('[doculight] Search index init failed:', err.message);
      this._createFreshEngine();
      this.initialized = true;
    }
  }

  // ─── Index Build ─────────────────────────────────────────

  /**
   * Full rebuild: scan all .md files under mcpAutoSavePath.
   */
  async rebuild() {
    const savePath = this.store.get('mcpAutoSavePath', '');
    if (!savePath) throw new Error('mcpAutoSavePath not configured');

    this._createFreshEngine();

    const mdFiles = await this._scanMarkdownFiles(savePath);
    for (const filePath of mdFiles) {
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        this._indexDocument(filePath, content);
      } catch (err) {
        console.error(`[doculight] Failed to index ${filePath}:`, err.message);
      }
    }

    // wink requires at least 3 documents for consolidation
    if (mdFiles.length >= MIN_DOCS_FOR_CONSOLIDATE) {
      this.engine.consolidate();
    }
    this.dirty = false;
    this.initialized = true;

    // Save index
    await this._saveIndex(path.join(savePath, INDEX_FILENAME));

    return { indexed: mdFiles.length };
  }

  // ─── Search: search_documents ────────────────────────────

  /**
   * BM25 full-text search across body + frontmatter fields.
   *
   * @param {string} query
   * @param {{ limit?: number, project?: string }} [options]
   * @returns {Array<{ filePath, score, title, project, docName, description, date, snippet }>}
   */
  search(query, { limit = 20, project } = {}) {
    if (!this.engine || this.docMeta.size < MIN_DOCS_FOR_CONSOLIDATE) {
      // Not enough docs for BM25 — fallback to simple token matching
      return this._fallbackSearch(query, { limit, project });
    }

    try {
      const filterFn = project
        ? (ov) => ov.project === project
        : undefined;

      const results = this.engine.search(query, limit, filterFn);

      return results.map(([docId, score]) => {
        const meta = this.docMeta.get(docId) || {};
        return {
          filePath: docId,
          score: Math.round(score * 1000) / 1000,
          title: meta.title || path.basename(docId, '.md'),
          project: meta.project || null,
          docName: meta.docName || null,
          description: meta.description || null,
          date: meta.date || null,
          snippet: meta.snippet || null
        };
      });
    } catch (err) {
      console.error('[doculight] BM25 search error:', err.message);
      return this._fallbackSearch(query, { limit, project });
    }
  }

  // ─── Search: search_projects ─────────────────────────────

  /**
   * Search or list projects from frontmatter metadata.
   *
   * @param {string} [query]
   * @param {number} [limit=20]
   * @returns {Array<{ project, description, documentCount, documents }>}
   */
  searchProjects(query, limit = 20) {
    const projectMap = new Map();
    for (const [docId, meta] of this.docMeta) {
      const proj = meta.project || '(no project)';
      if (!projectMap.has(proj)) {
        projectMap.set(proj, {
          project: proj,
          description: meta.description || '',
          documents: []
        });
      }
      projectMap.get(proj).documents.push({
        filePath: docId,
        title: meta.title || path.basename(docId, '.md'),
        docName: meta.docName || null,
        date: meta.date || null
      });
    }

    let projects = Array.from(projectMap.values());

    if (query && query.trim()) {
      const queryTokens = tokenize(query.toLowerCase());
      projects = projects
        .map(p => {
          const targetTokens = tokenize(`${p.project} ${p.description}`.toLowerCase());
          let score = 0;
          for (const qt of queryTokens) {
            for (const tt of targetTokens) {
              if (tt.includes(qt) || qt.includes(tt)) score++;
            }
          }
          return { ...p, _score: score };
        })
        .filter(p => p._score > 0)
        .sort((a, b) => b._score - a._score);
    }

    return projects.slice(0, limit).map(p => ({
      project: p.project,
      description: p.description,
      documentCount: p.documents.length,
      documents: p.documents
    }));
  }

  // ─── Index Update ────────────────────────────────────────

  markDirty() {
    this.dirty = true;
  }

  async ensureFresh() {
    if (this.dirty || !this.initialized) {
      await this.rebuild();
    }
  }

  // ─── Internal Methods ────────────────────────────────────

  _createFreshEngine() {
    this.engine = bm25();
    this.docMeta = new Map();

    this.engine.defineConfig({
      fldWeights: {
        title: 5,
        project: 4,
        docName: 3,
        description: 2,
        body: 1
      },
      bm25Params: { k1: 1.2, b: 0.75, k: 1 },
      ovFldNames: ['project', 'docName']
    });

    this.engine.definePrepTasks([tokenize]);
  }

  _indexDocument(filePath, content) {
    const fmMatch = content.match(FM_REGEX);
    let fmData = {};
    let body = content;

    if (fmMatch) {
      fmData = parseSimpleYaml(fmMatch[1] || '');
      body = content.slice(fmMatch[0].length);
    }

    const title = fmData.title || fmData.docName || this._extractTitle(body) || path.basename(filePath, '.md');

    const doc = {
      title: title,
      project: fmData.project || '',
      docName: fmData.docName || '',
      description: fmData.description || '',
      body: body
    };

    this.engine.addDoc(doc, filePath);

    this.docMeta.set(filePath, {
      title,
      project: fmData.project || null,
      docName: fmData.docName || null,
      description: fmData.description || null,
      date: fmData.date || null,
      snippet: body.replace(/\s+/g, ' ').trim().slice(0, 200)
    });
  }

  _extractTitle(content) {
    const m = content.match(/^#{1,6}\s+(.+)/m);
    return m ? m[1].trim() : null;
  }

  /**
   * Fallback search for when BM25 index is not available (< 3 docs).
   * Uses simple token matching on docMeta.
   */
  _fallbackSearch(query, { limit = 20, project } = {}) {
    if (!query || !query.trim()) return [];
    const queryTokens = tokenize(query.toLowerCase());
    const results = [];

    for (const [docId, meta] of this.docMeta) {
      if (project && meta.project !== project) continue;

      const target = `${meta.title || ''} ${meta.project || ''} ${meta.docName || ''} ${meta.description || ''} ${meta.snippet || ''}`.toLowerCase();
      const targetTokens = tokenize(target);

      let score = 0;
      for (const qt of queryTokens) {
        for (const tt of targetTokens) {
          if (tt.includes(qt) || qt.includes(tt)) score++;
        }
      }

      if (score > 0) {
        results.push({
          filePath: docId,
          score: Math.round(score * 100) / 100,
          title: meta.title || path.basename(docId, '.md'),
          project: meta.project || null,
          docName: meta.docName || null,
          description: meta.description || null,
          date: meta.date || null,
          snippet: meta.snippet || null
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async _scanMarkdownFiles(dirPath) {
    const results = [];
    let entries;
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = await this._scanMarkdownFiles(fullPath);
        results.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  async _saveIndex(indexPath) {
    try {
      const indexJson = this.engine.exportJSON();
      const metaJson = JSON.stringify(Object.fromEntries(this.docMeta));
      const combined = JSON.stringify({ index: indexJson, meta: metaJson });
      await fs.promises.writeFile(indexPath, combined, 'utf-8');
      console.log(`[doculight] Search index saved: ${indexPath} (${this.docMeta.size} docs)`);
    } catch (err) {
      console.error(`[doculight] Failed to save index: ${err.message}`);
    }
  }

  async _loadIndex(indexPath) {
    const raw = await fs.promises.readFile(indexPath, 'utf-8');
    const { index: indexJson, meta: metaJson } = JSON.parse(raw);

    this.engine = bm25();
    // importJSON restores config, then definePrepTasks re-registers tokenizer
    this.engine.importJSON(indexJson);
    this.engine.definePrepTasks([tokenize]);

    const metaObj = JSON.parse(metaJson);
    this.docMeta = new Map(Object.entries(metaObj));

    console.log(`[doculight] Search index loaded: ${this.docMeta.size} documents`);
  }
}

module.exports = { SearchEngine };
