/**
 * GitHub access for one analysis: repo metadata + recursive tree via
 * api.github.com (budget: 3 calls), file contents via commit-pinned CDN
 * mirrors that don't count against the anonymous rate limit.
 */

import { fetchVerifiedBytes, fetchJSONResource } from './fetch-verified.js';
import { immutableUrls, REVISION_LIMITS } from './revisions.js';

const API = 'https://api.github.com';
const API_HEADERS = { accept: 'application/vnd.github+json' };
const TREE_LIMITS = { maxBytes: 32 * 1024 * 1024, timeoutMs: 30_000 };

/** Accepts "owner/repo", full github.com URLs, and URLs with trailing paths. */
export function parseRepoInput(input) {
  const str = String(input ?? '').trim();
  if (!str) return null;
  let path = str;
  const urlMatch = str.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
  if (urlMatch) path = urlMatch[1];
  const m = path.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/?#].*)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], full: `${m[1]}/${m[2]}` };
}

export async function getRepoMeta(repo) {
  const { data } = await fetchJSONResource(`${API}/repos/${repo}`, {
    ...REVISION_LIMITS,
    headers: API_HEADERS,
  });
  return {
    fullName: data.full_name ?? repo,
    defaultBranch: data.default_branch,
    description: data.description,
    sizeKB: data.size,
  };
}

/** Recursive tree at a commit: {entries: [{path,type,size,sha}], truncated}. */
export async function getTree(repo, commit) {
  const { data } = await fetchJSONResource(`${API}/repos/${repo}/git/trees/${commit}?recursive=1`, {
    ...TREE_LIMITS,
    headers: API_HEADERS,
  });
  const entries = (data.tree ?? []).map((e) => ({
    path: e.path,
    type: e.type,
    size: e.size ?? 0,
    sha: e.sha,
  }));
  return { entries, truncated: Boolean(data.truncated) };
}

/**
 * Fetch a file's bytes at a pinned commit via CDN mirrors (raw first,
 * jsdelivr fallback). Never touches api.github.com.
 */
export async function fetchContent(repo, commit, path, { maxBytes = 8 * 1024 * 1024, timeoutMs = 30_000, as = 'bytes' } = {}) {
  const errors = [];
  for (const url of immutableUrls(repo, path, commit)) {
    try {
      return await fetchVerifiedBytes(url, { maxBytes, timeoutMs, as });
    } catch (error) {
      errors.push(error);
      // A too-large body will be too large on the mirror as well.
      if (/too large/.test(error.message)) break;
    }
  }
  throw new Error(`unfetchable ${repo}/${path}@${commit.slice(0, 12)}: ${errors.map((e) => e.message).join('; ')}`);
}

/** Fetch an arbitrary URL (e.g. a pin's recorded url), with a jsdelivr fallback for raw.githubusercontent URLs. */
export async function fetchPinnedUrl(url, { maxBytes = 8 * 1024 * 1024, timeoutMs = 30_000 } = {}) {
  const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/(.+)$/);
  const jsd = url.match(/^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+\/[^/@]+)@([0-9a-f]{40})\/(.+)$/);
  const m = raw ?? jsd;
  if (m) return fetchContent(m[1], m[2], decodeURIComponent(m[3]), { maxBytes, timeoutMs });
  return fetchVerifiedBytes(url, { maxBytes, timeoutMs });
}
