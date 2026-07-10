'use strict';

// @req FR-DOC-020
// @req FR-DOC-024
function createOpenAICompatibleEmbeddingProvider(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      async embed() {
        const err = new Error('fetch is not available for embedding provider');
        err.code = 'embedding_provider_unavailable';
        throw err;
      }
    };
  }

  return {
    async embed(request = {}) {
      const config = typeof options.getEmbeddingConfig === 'function' ? options.getEmbeddingConfig() : {};
      const baseURL = normalizeEmbeddingBaseURL(request.baseURL || config.baseURL);
      if (!isApprovedEmbeddingEndpoint(baseURL)) {
        const err = new Error('Embedding endpoint must use HTTPS or an approved local HTTP host');
        err.code = 'embedding_endpoint_policy';
        throw err;
      }
      const model = String(request.model || config.model || '').trim();
      if (!model) {
        const err = new Error('Embedding model is not configured');
        err.code = 'embedding_model_unconfigured';
        throw err;
      }
      const inputs = normalizeEmbeddingInputs(request.inputs || request.input);
      const timeoutMs = Math.max(1000, Math.min(Number(request.timeoutMs || config.timeout || options.timeoutMs) || 30000, 120000));
      const apiKey = typeof options.getApiKey === 'function' ? String(options.getApiKey() || '') : '';
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const body = { model, input: inputs };
      const dimensions = normalizeOptionalPositiveInt(request.dimensions || config.dimensions);
      if (dimensions) body.dimensions = dimensions;
      let response = await postEmbeddingRequest(fetchImpl, `${baseURL}/embeddings`, body, headers, timeoutMs);
      let retriedWithoutDimensions = false;
      if (!response.ok && dimensions && await shouldRetryWithoutDimensions(response)) {
        response = await postEmbeddingRequest(fetchImpl, `${baseURL}/embeddings`, { model, input: inputs }, headers, timeoutMs);
        retriedWithoutDimensions = true;
      }
      if (!response.ok) {
        const err = new Error(`Embedding endpoint returned HTTP ${response.status}`);
        err.code = 'embedding_endpoint_unreachable';
        throw err;
      }
      const payload = await response.json();
      const embeddings = extractEmbeddingVectors(payload);
      if (retriedWithoutDimensions && !embeddings.every((vector) => vector.length === dimensions)) {
        const err = new Error(`Embedding response dimensions mismatch: expected ${dimensions}`);
        err.code = 'embedding_dimensions_mismatch';
        throw err;
      }
      return {
        embeddings,
        model,
        purpose: request.purpose || 'document'
      };
    }
  };
}

function postEmbeddingRequest(fetchImpl, url, body, headers, timeoutMs) {
  return fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }, timeoutMs);
}

function isDimensionParameterRetryStatus(status) {
  return status === 400 || status === 422;
}

async function shouldRetryWithoutDimensions(response) {
  if (!response || !isDimensionParameterRetryStatus(response.status)) return false;
  const message = await readEmbeddingErrorMessage(response);
  return isDimensionParameterUnsupportedMessage(message);
}

async function readEmbeddingErrorMessage(response) {
  try {
    if (typeof response.json === 'function') {
      const payload = await response.json();
      return stringifyErrorPayload(payload);
    }
    if (typeof response.text === 'function') {
      return String(await response.text());
    }
  } catch {
    return '';
  }
  return '';
}

function stringifyErrorPayload(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const error = payload.error && typeof payload.error === 'object' ? payload.error : payload;
    const parts = [
      error.message,
      error.type,
      error.param,
      error.code
    ].filter((value) => value !== undefined && value !== null);
    if (parts.length > 0) return parts.map((value) => String(value)).join(' ');
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return '';
  }
}

function isDimensionParameterUnsupportedMessage(message) {
  const normalized = String(message || '').toLowerCase();
  if (!normalized) return false;
  return normalized.includes('dimension') || normalized.includes('matryoshka');
}

function normalizeEmbeddingBaseURL(rawBaseURL) {
  const raw = String(rawBaseURL || '').trim();
  if (!raw) {
    const err = new Error('Embedding endpoint URL is not configured');
    err.code = 'embedding_endpoint_required';
    throw err;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const err = new Error('Embedding endpoint URL is invalid');
    err.code = 'embedding_endpoint_invalid';
    throw err;
  }
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname === '/' ? '' : pathname}`.replace(/\/+$/, '');
}

function isApprovedEmbeddingEndpoint(rawBaseURL) {
  let parsed;
  try {
    parsed = new URL(rawBaseURL);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'https:') return true;
  if (protocol !== 'http:') return false;
  const host = String(parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return parts[0] === 192 && parts[1] === 168;
}

function normalizeOptionalPositiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeEmbeddingInputs(value) {
  const inputs = Array.isArray(value) ? value : [value];
  const normalized = inputs.map((item) => String(item == null ? '' : item));
  if (normalized.length === 0) {
    const err = new Error('Embedding input is empty');
    err.code = 'embedding_input_empty';
    throw err;
  }
  return normalized;
}

function extractEmbeddingVectors(payload = {}) {
  const data = Array.isArray(payload.data) ? payload.data : [];
  const vectors = data
    .map((item) => item && item.embedding)
    .filter((vector) => Array.isArray(vector) || ArrayBuffer.isView(vector))
    .map((vector) => Array.from(vector).map((value) => Number(value)));
  if (vectors.length === 0) {
    const err = new Error('Embedding response did not contain vectors');
    err.code = 'embedding_response_empty';
    throw err;
  }
  return vectors;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (err) {
    const wrapped = new Error(err && err.name === 'AbortError' ? 'Embedding request timed out' : (err && err.message ? err.message : String(err)));
    wrapped.code = err && err.name === 'AbortError' ? 'embedding_timeout' : 'embedding_endpoint_unreachable';
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  createOpenAICompatibleEmbeddingProvider,
  extractEmbeddingVectors,
  isApprovedEmbeddingEndpoint
};
