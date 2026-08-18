/**
 * Immutable-revision resolution for arbitrary GitHub repos.
 * Ported from laynr/FedRAMP docs/js/feeds.js (tested upstream), generalized:
 * no hardcoded feed registry — targets are {repo, ref, path} built at
 * runtime; paths are URL-encoded; the memoization cache is per-resolver
 * instead of module-global.
 */

import { fetchJSONResource } from './fetch-verified.js';

export const FETCH_LIMITS = {
  maxBytes: 16 * 1024 * 1024,
  timeoutMs: 30_000,
};

export const REVISION_LIMITS = { maxBytes: 1024 * 1024, timeoutMs: 15_000 };
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function immutableUrls(repo, path, commit) {
  if (!COMMIT_RE.test(commit)) throw new Error(`invalid commit SHA: ${commit}`);
  const file = encodePath(path);
  return [
    `https://raw.githubusercontent.com/${repo}/${commit}/${file}`,
    `https://cdn.jsdelivr.net/gh/${repo}@${commit}/${file}`,
  ];
}

/**
 * Create a resolver with its own repo@ref memoization cache — one per
 * analysis run, so branch tips are re-resolved for each new grading.
 */
export function createRevisionResolver({ fetchResource = fetchJSONResource } = {}) {
  const revisionPromises = new Map();

  async function resolveRepository(repo, ref) {
    const key = `${repo}@${ref}`;
    if (!revisionPromises.has(key)) {
      revisionPromises.set(key, (async () => {
        const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`;
        const { data } = await fetchResource(url, {
          ...REVISION_LIMITS,
          headers: { accept: 'application/vnd.github+json' },
        });
        const commit = data?.sha;
        if (!COMMIT_RE.test(commit)) throw new Error(`GitHub returned no valid commit for ${key}`);
        const commitDate = typeof data?.commit?.committer?.date === 'string' ? data.commit.committer.date : null;
        return { commit, commitDate };
      })());
    }
    try {
      return await revisionPromises.get(key);
    } catch (error) {
      revisionPromises.delete(key);
      throw error;
    }
  }

  async function resolveFileBlob(repo, path, commit) {
    const url = `https://api.github.com/repos/${repo}/contents/${encodePath(path)}?ref=${commit}`;
    const { data } = await fetchResource(url, {
      ...REVISION_LIMITS,
      headers: { accept: 'application/vnd.github+json' },
    });
    const blobSha = data?.sha;
    if (!COMMIT_RE.test(blobSha) || data?.type !== 'file') {
      throw new Error(`GitHub returned no valid blob identity for ${repo}/${path}@${commit}`);
    }
    return blobSha;
  }

  /** Resolve mutable refs once per repo@ref, then return immutable URLs per target. */
  async function resolveRevisions(targets) {
    const repositories = new Map();
    for (const t of targets) repositories.set(`${t.repo}@${t.ref}`, t);
    const resolved = new Map(await Promise.all([...repositories].map(async ([key, t]) => [
      key,
      await resolveRepository(t.repo, t.ref),
    ])));

    return Promise.all(targets.map(async (t) => {
      const revision = resolved.get(`${t.repo}@${t.ref}`);
      const blobSha = await resolveFileBlob(t.repo, t.path, revision.commit);
      return { ...t, ...revision, blobSha, urls: immutableUrls(t.repo, t.path, revision.commit) };
    }));
  }

  return { resolveRepository, resolveFileBlob, resolveRevisions };
}
