/**
 * rederive.json (spec v1): validate, verify inputs, gather the transform
 * module graph, run it in the sandbox, and byte-compare outputs against the
 * analyzed commit's own tree blob shas.
 */

import { COMMIT_RE, SHA256_RE } from './revisions.js';
import { fetchContent } from './github.js';
import { verifyPins } from './pins.js';
import { runTransform } from './sandbox.js';
import { gitBlobSha1 } from './fetch-verified.js';

const MAX_MODULES = 10;
const MAX_MODULE_BYTES = 512 * 1024;

export function validateManifest(json) {
  const errors = [];
  if (!json || typeof json !== 'object') return { ok: false, errors: ['manifest is not a JSON object'] };
  if (json.rederive !== 1) errors.push(`unsupported spec version: ${JSON.stringify(json.rederive)} (expected 1)`);
  if (!Array.isArray(json.inputs) || json.inputs.length === 0) errors.push('inputs must be a non-empty array');
  for (const [i, input] of (json.inputs ?? []).entries()) {
    const label = `inputs[${i}]`;
    if (typeof input?.name !== 'string' || !input.name) errors.push(`${label}: name required`);
    if (typeof input?.path !== 'string' || !input.path) errors.push(`${label}: path required`);
    if (input?.repo != null) {
      if (!/^[^/\s]+\/[^/\s]+$/.test(input.repo)) errors.push(`${label}: repo must be owner/name`);
      if (!COMMIT_RE.test(input.commit ?? '')) errors.push(`${label}: external input needs a 40-hex commit`);
      if (!input.sha256 && !input.blobSha) errors.push(`${label}: external input needs sha256 or blobSha`);
      if (input.sha256 && !SHA256_RE.test(input.sha256)) errors.push(`${label}: invalid sha256`);
      if (input.blobSha && !COMMIT_RE.test(input.blobSha)) errors.push(`${label}: invalid blobSha`);
    }
  }
  if (typeof json.transform?.module !== 'string' || !/\.m?js$/.test(json.transform.module)) {
    errors.push('transform.module must be a .js/.mjs path in this repository');
  }
  if (json.transform && json.transform.entry != null && typeof json.transform.entry !== 'string') {
    errors.push('transform.entry must be a string');
  }
  if (!Array.isArray(json.outputs) || json.outputs.length === 0 || json.outputs.some((o) => typeof o !== 'string')) {
    errors.push('outputs must be a non-empty array of repo paths');
  }
  return { ok: errors.length === 0, errors, manifest: json };
}

/** Collect the transform module plus its relative import graph from the analyzed commit. */
async function collectModules(repo, commit, entryPath, treePaths) {
  const sources = new Map();
  const queue = [entryPath];
  while (queue.length > 0) {
    if (sources.size >= MAX_MODULES) throw new Error(`transform imports more than ${MAX_MODULES} modules`);
    const path = queue.shift();
    if (sources.has(path)) continue;
    if (!treePaths.has(path)) throw new Error(`transform module ${path} is not in the repository tree`);
    const { text } = await fetchContent(repo, commit, path, { maxBytes: MAX_MODULE_BYTES, as: 'text' });
    sources.set(path, text);
    const importRe = /(?:^|\n)\s*(?:import|export)[^'"]*from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = importRe.exec(text)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        throw new Error(`transform module ${path} imports non-relative specifier "${spec}" — v1 allows only relative imports within the repo`);
      }
      queue.push(resolveRelative(path, spec));
    }
  }
  return sources;
}

function resolveRelative(fromPath, spec) {
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    else if (seg === '..') {
      if (parts.length === 0) throw new Error(`import "${spec}" from ${fromPath} escapes the repository`);
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Full A attempt. Returns {status:'passed', outputsMatched, rows} or
 * {status:'failed', reason, rows?}.
 */
export async function attemptRederive({ repo, commit, manifestJson, tree, resolver, onProgress = () => {} }) {
  const { ok, errors, manifest } = validateManifest(manifestJson);
  if (!ok) return { status: 'failed', reason: `manifest invalid: ${errors.join('; ')}` };

  const treeByPath = new Map(tree.entries.filter((e) => e.type === 'blob').map((e) => [e.path, e]));

  // 1. Verify + load inputs
  onProgress('verifying inputs');
  const inputs = {};
  const inputRows = [];
  for (const input of manifest.inputs) {
    if (input.repo) {
      const report = await verifyPins([{
        foundIn: 'rederive.json',
        commit: input.commit,
        url: input.url && input.url.includes(input.commit) ? input.url : null,
        repo: input.repo,
        path: input.path,
        blobSha: input.blobSha ?? null,
        sha256: input.sha256 ?? null,
        bytes: input.bytes ?? null,
      }], { resolver });
      const row = report.rows[0];
      inputRows.push({ name: input.name, ...row });
      if (row.status !== 'verified') {
        return { status: 'failed', reason: `input "${input.name}" not verified: ${row.detail}`, rows: inputRows };
      }
      const fetched = await fetchContent(input.repo, input.commit, input.path);
      inputs[input.name] = fetched.body;
    } else {
      if (!treeByPath.has(input.path)) {
        return { status: 'failed', reason: `local input "${input.name}" (${input.path}) is not in the repository tree`, rows: inputRows };
      }
      const fetched = await fetchContent(repo, commit, input.path);
      const expected = treeByPath.get(input.path).sha;
      if (fetched.gitBlobSha1 !== expected) {
        return { status: 'failed', reason: `local input "${input.name}" bytes do not match the tree blob sha`, rows: inputRows };
      }
      inputRows.push({ name: input.name, status: 'verified', detail: 'committed in this repo; blob sha matches the analyzed commit', recomputed: { gitBlobSha1: fetched.gitBlobSha1, bytes: fetched.bytes } });
      inputs[input.name] = fetched.body;
    }
  }

  // 2. Gather transform module graph
  onProgress('loading transform');
  let moduleSources;
  try {
    moduleSources = await collectModules(repo, commit, manifest.transform.module, new Set(treeByPath.keys()));
  } catch (error) {
    return { status: 'failed', reason: error.message, rows: inputRows };
  }

  // 3. Run in sandbox
  onProgress('running transform in sandbox');
  let produced;
  try {
    produced = await runTransform({
      moduleSources,
      entryModule: manifest.transform.module,
      entryName: manifest.transform.entry ?? 'derive',
      inputs,
      outputPaths: manifest.outputs,
      timeoutMs: Math.min(manifest.transform.timeoutMs ?? 30_000, 60_000),
    });
  } catch (error) {
    return { status: 'failed', reason: `transform failed: ${error.message}`, rows: inputRows };
  }

  // 4. Byte-compare outputs against the analyzed commit's tree blob shas
  onProgress('comparing outputs');
  const outputRows = [];
  let matched = 0;
  for (const outPath of manifest.outputs) {
    const committed = treeByPath.get(outPath);
    const bytes = produced.get(outPath);
    if (!committed) {
      outputRows.push({ path: outPath, status: 'failed', detail: 'declared output is not committed in the repository' });
      continue;
    }
    if (!bytes) {
      outputRows.push({ path: outPath, status: 'failed', detail: 'transform did not produce this output' });
      continue;
    }
    const producedSha = await gitBlobSha1(bytes);
    if (producedSha === committed.sha) {
      matched += 1;
      outputRows.push({ path: outPath, status: 'verified', detail: `byte-for-byte match (${bytes.byteLength} bytes, blob ${producedSha.slice(0, 12)})` });
    } else {
      outputRows.push({ path: outPath, status: 'failed', detail: `bytes differ: produced blob ${producedSha.slice(0, 12)} vs committed ${committed.sha.slice(0, 12)}` });
    }
  }

  if (matched === manifest.outputs.length) {
    return { status: 'passed', outputsMatched: matched, rows: [...inputRows, ...outputRows] };
  }
  return {
    status: 'failed',
    reason: `${manifest.outputs.length - matched} of ${manifest.outputs.length} output(s) did not match the committed bytes`,
    rows: [...inputRows, ...outputRows],
  };
}
