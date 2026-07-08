'use strict';

const fs = require('fs');
const path = require('path');
const { redactString } = require('./redaction');

const DEFAULT_HNSW_PARAMS = Object.freeze({
  metric: 'cosine',
  m: 16,
  efConstruction: 200,
  efSearch: 64,
  compactionThreshold: 0.20
});

function loadHnswlib(options = {}) {
  if (options.forceUnavailable || process.env.DOCULIGHT_HNSW_FORCE_UNAVAILABLE === '1') {
    return {
      available: false,
      reason: 'native_unavailable',
      errorSummary: 'hnswlib-node native load was disabled for diagnostics'
    };
  }

  if (options.HierarchicalNSW || options.hnswlib) {
    const hnswlib = options.hnswlib || { HierarchicalNSW: options.HierarchicalNSW };
    if (!hnswlib || typeof hnswlib.HierarchicalNSW !== 'function') {
      return {
        available: false,
        reason: 'native_unavailable',
        errorSummary: 'Injected HNSW runtime did not expose HierarchicalNSW'
      };
    }
    return {
      available: true,
      reason: null,
      module: hnswlib,
      HierarchicalNSW: hnswlib.HierarchicalNSW
    };
  }

  try {
    const hnswlib = require('hnswlib-node');
    if (!hnswlib || typeof hnswlib.HierarchicalNSW !== 'function') {
      return {
        available: false,
        reason: 'native_unavailable',
        errorSummary: 'hnswlib-node did not expose HierarchicalNSW'
      };
    }
    return {
      available: true,
      reason: null,
      module: hnswlib,
      HierarchicalNSW: hnswlib.HierarchicalNSW
    };
  } catch (err) {
    return {
      available: false,
      reason: 'native_unavailable',
      errorSummary: redactString(err && err.message ? err.message : String(err))
    };
  }
}

function createHnswIndex(options = {}) {
  return new HnswIndex(options);
}

class HnswIndex {
  constructor(options = {}) {
    this.options = {
      ...DEFAULT_HNSW_PARAMS,
      ...options
    };
    this.dimensions = Number(this.options.dimensions) || 0;
    this.maxElements = Number(this.options.maxElements) || 0;
    this.runtime = loadHnswlib(options);
    this.index = null;
    this.labels = new Set();
    this.tombstones = new Set();
    this.status = this.runtime.available ? 'idle' : 'degraded';
    this.degradationReason = this.runtime.reason;
    this.errorSummary = this.runtime.errorSummary || null;
  }

  init(maxElements = this.maxElements) {
    if (!this.runtime.available) return this.getStatus();
    if (!this.dimensions || !Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      throw new Error('HNSW dimensions must be a positive integer');
    }
    const capacity = Number(maxElements) || 0;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('HNSW maxElements must be a positive integer');
    }

    this.maxElements = capacity;
    this.index = new this.runtime.HierarchicalNSW(this.options.metric, this.dimensions);
    this.index.initIndex(capacity, this.options.m, this.options.efConstruction);
    if (typeof this.index.setEf === 'function') {
      this.index.setEf(this.options.efSearch);
    }
    this.status = 'ready';
    return this.getStatus();
  }

  addPoint(vector, label) {
    if (!this.index) return { ok: false, reason: this.degradationReason || 'not_initialized' };
    this.index.addPoint(vector, label);
    this.labels.add(label);
    this.tombstones.delete(label);
    return { ok: true };
  }

  markDeleted(label) {
    this.tombstones.add(label);
    return this.getCompactionStatus();
  }

  isDeleted(label) {
    return this.tombstones.has(label);
  }

  search(vector, limit) {
    if (!this.index) {
      return { ok: false, reason: this.degradationReason || 'not_initialized', neighbors: [], distances: [] };
    }
    const requestedLimit = Math.max(1, Number(limit) || 1);
    const knownMembershipCount = this.labels.size > 0
      ? this.labels.size
      : (Number(this.options.membershipCount) || this.maxElements || requestedLimit);
    const searchLimit = Math.max(1, Math.min(knownMembershipCount, requestedLimit + this.tombstones.size));
    const result = this.index.searchKnn(vector, searchLimit);
    const labels = result.neighbors || result.labels || [];
    const distances = result.distances || [];
    const filtered = [];
    for (let i = 0; i < labels.length && filtered.length < requestedLimit; i += 1) {
      if (!this.tombstones.has(labels[i])) {
        filtered.push({ label: labels[i], distance: distances[i] });
      }
    }
    return {
      ok: true,
      labels: filtered.map((item) => item.label),
      distances: filtered.map((item) => item.distance),
      filteredCount: labels.length - filtered.length
    };
  }

  writeIndex(filePath) {
    if (!this.index) return { ok: false, reason: this.degradationReason || 'not_initialized' };
    this.index.writeIndexSync(filePath);
    return { ok: true };
  }

  writeIndexAtomic(filePath) {
    if (!this.index) return { ok: false, reason: this.degradationReason || 'not_initialized' };
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      this.index.writeIndexSync(tempPath);
      fs.renameSync(tempPath, filePath);
      return { ok: true, filePath };
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup */ }
      return { ok: false, reason: 'atomic_swap_failed', errorSummary: redactString(err && err.message ? err.message : String(err)) };
    }
  }

  readIndex(filePath) {
    if (!this.runtime.available) return this.getStatus();
    if (!this.dimensions || !Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      throw new Error('HNSW dimensions must be a positive integer');
    }
    this.index = new this.runtime.HierarchicalNSW(this.options.metric, this.dimensions);
    this.index.readIndexSync(filePath);
    if (typeof this.index.setEf === 'function') {
      this.index.setEf(this.options.efSearch);
    }
    this.status = 'ready';
    return this.getStatus();
  }

  getCompactionStatus() {
    const total = this.labels.size || Number(this.options.membershipCount) || this.maxElements || 0;
    const deleted = this.tombstones.size;
    const ratio = total > 0 ? deleted / total : 0;
    return {
      deletedCount: deleted,
      membershipCount: total,
      tombstoneRatio: ratio,
      compactionRecommended: ratio >= this.options.compactionThreshold
    };
  }

  getStatus() {
    return {
      backend: 'hnswlib-node',
      status: this.status,
      available: this.runtime.available === true,
      degradationReason: this.degradationReason,
      errorSummary: this.errorSummary,
      compaction: this.getCompactionStatus(),
      params: {
        metric: this.options.metric,
        dimensions: this.dimensions,
        maxElements: this.maxElements,
        m: this.options.m,
        efConstruction: this.options.efConstruction,
        efSearch: this.options.efSearch,
        compactionThreshold: this.options.compactionThreshold
      }
    };
  }
}

module.exports = {
  DEFAULT_HNSW_PARAMS,
  HnswIndex,
  createHnswIndex,
  loadHnswlib
};
