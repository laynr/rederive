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

// GitHub username rules: 1–39 chars, alphanumeric + hyphen, no edge hyphens.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// First path segments on github.com that are never a user/org.
const RESERVED_OWNERS = new Set([
  'orgs', 'users', 'topics', 'search', 'settings', 'marketplace', 'features',
  'sponsors', 'collections', 'trending', 'explore', 'notifications', 'issues',
  'pulls', 'codespaces', 'apps', 'about', 'pricing', 'enterprise', 'login',
  'join', 'new', 'organizations', 'site', 'security', 'contact', 'team',
  'readme', 'gist', 'events', 'account', 'dashboard',
]);

/** Validate and assemble owner/repo from a path-ish string ("owner/repo[/...]"). */
function repoFromPath(path) {
  const segs = String(path).split(/[/?#]/).filter(Boolean);
  if (segs.length < 2) return null;
  let [owner, repo] = segs;
  try {
    owner = decodeURIComponent(owner);
    repo = decodeURIComponent(repo);
  } catch {
    return null;
  }
  repo = repo.replace(/\.git$/i, '').replace(/@.*$/, '');
  if (!OWNER_RE.test(owner) || RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  if (!REPO_RE.test(repo) || /^\.+$/.test(repo)) return null;
  return { owner, repo, full: `${owner}/${repo}` };
}

/**
 * One input, parsed properly. Accepts every realistic way a user names a repo:
 *   owner/repo · owner/repo.git
 *   github.com URLs with any scheme/www/.git/deep path/query/fragment
 *   git@github.com:owner/repo.git and ssh:// remotes
 *   whole clone commands ("git clone …", "gh repo clone …")
 *   api.github.com/repos/…, raw.githubusercontent.com/…, codeload.github.com/…
 *   cdn.jsdelivr.net/gh/owner/repo@ref/…
 *   owner.github.io[/repo] Pages URLs
 *   a github.com URL embedded in surrounding text (markdown link, sentence)
 * Rejects anything that can't be a public GitHub repo: other hosts, reserved
 * github.com paths (orgs/, topics/, …), credential-style user@host URLs, and
 * dot-only repo names that would build a path-traversing API URL.
 */
export function parseRepoInput(input) {
  let str = String(input ?? '').trim();
  str = str.replace(/^[\s"'<([{]+/, '').replace(/[\s"'>)\]}.,;]+$/, '');
  str = str.replace(/^(?:git\s+clone|gh\s+repo\s+clone)\s+(?:-{1,2}[\w=-]+\s+)*/i, '');
  if (!str) return null;

  let m = str.match(/^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i);
  if (m) return repoFromPath(m[1]);

  m = str.match(/^(?:https?:\/\/)?(?:(?:www\.)?github\.com|api\.github\.com\/repos|raw\.githubusercontent\.com|codeload\.github\.com|cdn\.jsdelivr\.net\/gh)\/(.+)$/i);
  if (m) return repoFromPath(m[1]);

  m = str.match(/^(?:https?:\/\/)?([A-Za-z0-9-]+)\.github\.io(?:\/([^/?#]+))?(?:[/?#].*)?$/i);
  if (m) return repoFromPath(`${m[1]}/${m[2] ?? `${m[1]}.github.io`}`);

  if (!/^(?:https?:)?\/\//.test(str) && !str.includes('@') && !str.includes(' ')) {
    const direct = repoFromPath(str);
    if (direct) return direct;
  }

  // Last resort: a github.com URL buried in text (markdown link, sentence,
  // command). The [^@\w.-] guard keeps credential-style user@github.com and
  // lookalike hosts (evilgithub.com) from matching.
  m = str.match(/(?:^|[^@\w.-])github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)/i);
  if (m) return repoFromPath(m[1]);

  return null;
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
