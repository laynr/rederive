/**
 * Bounded, digested resource retrieval.
 * Ported from laynr/FedRAMP docs/js/fetch-json.js (tested upstream), generalized:
 * raw bytes are returned, JSON/text decoding is opt-in, the content-type
 * allowlist is a parameter, and GitHub API rate limits throw a typed error.
 */

export const JSON_TYPES = /(json|octet-stream|text\/plain)/i;

export class RateLimitError extends Error {
  constructor(resetAt, url) {
    const when = resetAt ? resetAt.toLocaleTimeString() : 'later';
    super(`GitHub API rate limit reached — resets at ${when}`);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
    this.url = url;
  }
}

export async function readBoundedBytes(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response too large (${declared} bytes declared; limit ${maxBytes})`);
  }

  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`response too large (${bytes.byteLength} bytes; limit ${maxBytes})`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('response exceeded size limit'); } catch { /* preserve the size-limit error */ }
        throw new Error(`response too large (more than ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function digestHex(algorithm, bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto digests are unavailable in this runtime');
  const digest = await globalThis.crypto.subtle.digest(algorithm, bytes);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

export const sha256Hex = (bytes) => digestHex('SHA-256', bytes);

/** Git object identity: SHA-1("blob " + byteLength + NUL + raw bytes). */
export async function gitBlobSha1(bytes) {
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const object = new Uint8Array(prefix.byteLength + bytes.byteLength);
  object.set(prefix);
  object.set(bytes, prefix.byteLength);
  return digestHex('SHA-1', object);
}

export function assertGitBlobIdentity(actual, expected, label = 'resource') {
  if (actual !== expected) {
    throw new Error(`Git blob mismatch for ${label}: expected ${expected}, received ${actual}`);
  }
}

function rateLimitReset(response) {
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null;
}

/**
 * Fetch a resource with byte/time bounds and content digests.
 * Returns {body, bytes, sha256, gitBlobSha1, contentType} plus `text` when
 * as:'text'|'json' and `data` when as:'json'.
 */
export async function fetchVerifiedBytes(
  url,
  { maxBytes, timeoutMs, fetchImpl = globalThis.fetch, headers = {}, as = 'bytes', allowTypes = null } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable in this runtime');

  let response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`request failed for ${url}: ${error.message}`, { cause: error });
  }
  if (!response.ok) {
    const isApi = new URL(url).hostname === 'api.github.com';
    if (isApi && (response.status === 403 || response.status === 429)
      && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new RateLimitError(rateLimitReset(response), url);
    }
    const error = new Error(`${response.status}${response.statusText ? ` ${response.statusText}` : ''} for ${url}`);
    error.status = response.status;
    throw error;
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (allowTypes && contentType && !allowTypes.test(contentType)) {
    throw new Error(`unexpected content-type "${contentType}" for ${url}`);
  }

  let body;
  try {
    body = await readBoundedBytes(response, maxBytes);
  } catch (error) {
    throw new Error(`${error.message} for ${url}`, { cause: error });
  }
  const result = {
    body,
    bytes: body.byteLength,
    sha256: await sha256Hex(body),
    gitBlobSha1: await gitBlobSha1(body),
    contentType,
  };
  if (as === 'text' || as === 'json') {
    try {
      result.text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      if (as === 'json') result.data = JSON.parse(result.text);
    } catch (error) {
      throw new Error(`invalid UTF-8 ${as === 'json' ? 'JSON' : 'text'} from ${url}: ${error.message}`, { cause: error });
    }
  }
  return result;
}

/** JSON convenience wrapper matching the upstream fetchJSONResource contract. */
export function fetchJSONResource(url, options = {}) {
  return fetchVerifiedBytes(url, { ...options, as: 'json', allowTypes: JSON_TYPES });
}
