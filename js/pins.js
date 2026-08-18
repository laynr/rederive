/**
 * Pin extraction from scan results + committed manifests, and ACTIVE
 * verification: re-download pinned inputs by commit and check recorded
 * hashes. Pins without recorded hashes are anchored via the GitHub contents
 * API (capped at 3 extra calls per analysis).
 */

import { COMMIT_RE, SHA256_RE } from './revisions.js';
import { fetchPinnedUrl } from './github.js';

const BUDGET = {
  maxPins: 10,
  maxBytesPerFile: 8 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  maxAnchorCalls: 3,
};

/** Walk parsed JSON for pin-shaped objects: 40-hex commit + (url | repo+path). */
export function extractManifestPins(json, foundIn, out = [], depth = 0) {
  if (depth > 6 || out.length >= 25 || !json || typeof json !== 'object') return out;
  const obj = json;
  if (!Array.isArray(obj)) {
    const commit = [obj.commit, obj.sha, obj.rev, obj.revision].find((v) => typeof v === 'string' && COMMIT_RE.test(v));
    const url = typeof obj.url === 'string' && /^https:\/\//.test(obj.url) ? obj.url : null;
    const repo = typeof obj.repo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(obj.repo) ? obj.repo : null;
    const path = [obj.file, obj.path].find((v) => typeof v === 'string' && v.length > 0) ?? null;
    if (commit && (url || (repo && path))) {
      out.push({
        foundIn,
        commit,
        url: url && url.includes(commit) ? url : null,
        repo,
        path,
        blobSha: typeof obj.blobSha === 'string' && COMMIT_RE.test(obj.blobSha) ? obj.blobSha : null,
        sha256: typeof obj.sha256 === 'string' && SHA256_RE.test(obj.sha256) ? obj.sha256 : null,
        bytes: Number.isSafeInteger(obj.bytes) ? obj.bytes : null,
      });
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') extractManifestPins(v, foundIn, out, depth + 1);
  }
  return out;
}

/** Pins found in script text: commit-pinned URLs. */
export function extractScriptPins(scanResults) {
  const pins = [];
  for (const r of scanResults) {
    for (const u of r.pinnedUrls ?? []) {
      const m = u.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/(.+)$/)
        ?? u.match(/^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+\/[^/@]+)@([0-9a-f]{40})\/(.+)$/);
      pins.push({
        foundIn: r.path,
        commit: m ? m[2] : (u.match(/\/([0-9a-f]{40})\//)?.[1] ?? null),
        url: u,
        repo: m ? m[1] : null,
        path: m ? m[3] : null,
        blobSha: null,
        sha256: null,
        bytes: null,
      });
    }
  }
  return pins;
}

export function dedupePins(pins) {
  const seen = new Set();
  return pins.filter((p) => {
    const key = p.url ?? `${p.repo}@${p.commit}/${p.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Actively verify pins. Returns {rows, verified, weak, failed, skipped}.
 * Row status: 'verified' | 'verified-weak' | 'failed' | 'skipped'.
 */
export async function verifyPins(pins, { resolver, onProgress = () => {} } = {}) {
  const rows = [];
  let totalBytes = 0;
  let anchorCalls = 0;
  const selected = pins.slice(0, BUDGET.maxPins);

  for (const [i, pin] of selected.entries()) {
    onProgress(i + 1, selected.length, pin);
    const row = { pin, status: 'skipped', detail: '', recomputed: {} };
    rows.push(row);

    if (pin.bytes && pin.bytes > BUDGET.maxBytesPerFile) {
      row.detail = `skipped: recorded size ${pin.bytes} bytes exceeds per-file cap`;
      continue;
    }
    if (totalBytes >= BUDGET.maxTotalBytes) {
      row.detail = 'skipped: total download budget exhausted';
      continue;
    }
    const url = pin.url ?? (pin.repo && pin.path && pin.commit
      ? `https://raw.githubusercontent.com/${pin.repo}/${pin.commit}/${pin.path}`
      : null);
    if (!url || !pin.commit) {
      row.detail = 'skipped: no commit-pinned URL could be built';
      continue;
    }

    let fetched;
    try {
      fetched = await fetchPinnedUrl(url, { maxBytes: BUDGET.maxBytesPerFile });
    } catch (error) {
      row.status = 'failed';
      row.detail = `pinned content unreachable: ${error.message}`;
      continue;
    }
    totalBytes += fetched.bytes;
    row.recomputed = { sha256: fetched.sha256, gitBlobSha1: fetched.gitBlobSha1, bytes: fetched.bytes };

    const checks = [];
    if (pin.sha256) checks.push(['sha256', pin.sha256, fetched.sha256]);
    if (pin.blobSha) checks.push(['git blob sha', pin.blobSha, fetched.gitBlobSha1]);
    if (pin.bytes != null) checks.push(['bytes', String(pin.bytes), String(fetched.bytes)]);

    if (checks.length > 0) {
      const bad = checks.filter(([, expected, actual]) => expected !== actual);
      if (bad.length === 0) {
        row.status = 'verified';
        row.detail = checks.map(([k]) => k).join(' + ') + ' match';
      } else {
        row.status = 'failed';
        row.detail = bad.map(([k, e, a]) => `${k} mismatch: recorded ${e.slice(0, 16)}…, got ${a.slice(0, 16)}…`).join('; ');
      }
      continue;
    }

    // No recorded content hash — anchor the recomputed blob sha against GitHub.
    if (resolver && pin.repo && pin.path && anchorCalls < BUDGET.maxAnchorCalls) {
      anchorCalls += 1;
      try {
        const blobSha = await resolver.resolveFileBlob(pin.repo, pin.path, pin.commit);
        if (blobSha === fetched.gitBlobSha1) {
          row.status = 'verified';
          row.detail = 'git blob sha anchored via GitHub contents API';
        } else {
          row.status = 'failed';
          row.detail = `git blob mismatch vs GitHub: ${blobSha.slice(0, 16)}… vs ${fetched.gitBlobSha1.slice(0, 16)}…`;
        }
        continue;
      } catch (error) {
        row.detail = `anchor lookup failed (${error.message}); `;
      }
    }
    row.status = 'verified-weak';
    row.detail += 'pinned to commit; content hash not independently anchored (record sha256 to strengthen)';
  }

  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    verified: count('verified'),
    weak: count('verified-weak'),
    failed: count('failed'),
    skipped: count('skipped'),
    omitted: Math.max(0, pins.length - selected.length),
  };
}
