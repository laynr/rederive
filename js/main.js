/** Orchestrator: parse input, run the analysis pipeline, render. */

import { parseRepoInput, getRepoMeta, getTree, fetchContent } from './github.js';
import { createRevisionResolver } from './revisions.js';
import { classifyTree, rankScanCandidates, scanScriptText, scanPackageJson } from './heuristics.js';
import { extractManifestPins, extractScriptPins, dedupePins, verifyPins } from './pins.js';
import { attemptRederive } from './manifest.js';
import { computeGrade } from './grade.js';
import { createProgress, renderReport, renderError, renderSelftest } from './report.js';
import { sha256Hex, gitBlobSha1 } from './fetch-verified.js';

const SCAN_BUDGET = { maxFiles: 20, maxTotalBytes: 1.5 * 1024 * 1024 };
const STEPS = ['resolve repository', 'fetch file tree', 'scan generation code', 'check pin manifests', 'verify pinned inputs', 're-derive (rederive.json)'];

async function analyze(repoFull) {
  const progress = createProgress(STEPS);
  const resolver = createRevisionResolver();

  progress.start('resolve repository');
  const meta = await getRepoMeta(repoFull);
  const { commit } = await resolver.resolveRepository(meta.fullName, meta.defaultBranch);
  progress.done('resolve repository', `${meta.defaultBranch} @ ${commit.slice(0, 12)}`);

  progress.start('fetch file tree');
  const tree = await getTree(meta.fullName, commit);
  const facts = classifyTree(tree.entries);
  progress.done('fetch file tree', `${tree.entries.length} entries${tree.truncated ? ' (truncated)' : ''}`);

  // Scan generation-code candidates via CDN (no API quota)
  progress.start('scan generation code');
  const candidates = rankScanCandidates(facts).slice(0, SCAN_BUDGET.maxFiles);
  const scans = [];
  let scannedBytes = 0;
  let scanned = 0;
  for (const cand of candidates) {
    if (scannedBytes + cand.size > SCAN_BUDGET.maxTotalBytes) continue;
    progress.note('scan generation code', `${scanned + 1}/${candidates.length} ${cand.path}`);
    try {
      const { text, body } = await fetchContent(meta.fullName, commit, cand.path, { maxBytes: 256 * 1024, as: 'text' });
      scannedBytes += body.byteLength;
      scanned += 1;
      const replacementRatio = (text.match(/�/g) ?? []).length / Math.max(text.length, 1);
      if (replacementRatio > 0.01) continue;
      scans.push(cand.path.endsWith('package.json') ? scanPackageJson(cand.path, text, facts) : scanScriptText(cand.path, text, facts));
    } catch { /* unfetchable candidate — skip, keep grading */ }
  }
  progress.done('scan generation code', `${scanned} file(s) scanned`);

  // Pin manifests (FedRAMP-style meta.json etc.)
  progress.start('check pin manifests');
  let manifestPins = [];
  for (const cand of facts.pinManifestCandidates.slice(0, 5)) {
    try {
      const { data } = await fetchContent(meta.fullName, commit, cand.path, { maxBytes: 128 * 1024, as: 'json' });
      manifestPins = manifestPins.concat(extractManifestPins(data, cand.path));
    } catch { /* not JSON or unfetchable — ignore */ }
  }
  const pins = dedupePins([...manifestPins, ...extractScriptPins(scans)]);
  progress.done('check pin manifests', `${pins.length} pin(s) found`);

  // Active verification (B)
  let pinReport = null;
  if (pins.length > 0) {
    progress.start('verify pinned inputs');
    pinReport = await verifyPins(pins, {
      resolver,
      onProgress: (i, n, pin) => progress.note('verify pinned inputs', `${i}/${n} ${pin.path ?? pin.url ?? ''}`),
    });
    const failNote = pinReport.failed ? `, ${pinReport.failed} FAILED` : '';
    progress[pinReport.failed ? 'fail' : 'done']('verify pinned inputs', `${pinReport.verified + pinReport.weak} verified${failNote}`);
  } else {
    progress.skip('verify pinned inputs');
  }

  // A attempt
  let manifestResult = null;
  if (facts.hasRederiveManifest) {
    progress.start('re-derive (rederive.json)');
    try {
      const { data } = await fetchContent(meta.fullName, commit, 'rederive.json', { maxBytes: 64 * 1024, as: 'json' });
      manifestResult = await attemptRederive({
        repo: meta.fullName,
        commit,
        manifestJson: data,
        tree,
        resolver,
        onProgress: (note) => progress.note('re-derive (rederive.json)', note),
      });
    } catch (error) {
      manifestResult = { status: 'failed', reason: error.message };
    }
    progress[manifestResult.status === 'passed' ? 'done' : 'fail']('re-derive (rederive.json)',
      manifestResult.status === 'passed' ? 'byte-for-byte match' : manifestResult.reason);
  } else {
    progress.skip('re-derive (rederive.json)');
  }

  const graded = computeGrade({
    facts,
    scans,
    scannedCount: scanned,
    truncated: tree.truncated,
    pinReport,
    manifest: manifestResult,
  });

  renderReport({ repo: meta.fullName, commit, ...graded, pinReport, manifestResult });
}

async function run(input) {
  const parsed = parseRepoInput(input);
  const report = document.querySelector('#report');
  report.hidden = true;
  if (!parsed) {
    renderError(new Error('could not parse that as a GitHub repo — try "owner/repo" or a github.com URL'));
    return;
  }
  history.replaceState(null, '', `?repo=${encodeURIComponent(parsed.full)}`);
  document.querySelector('#repo-input').value = parsed.full;
  try {
    await analyze(parsed.full);
  } catch (error) {
    if (error.status === 404) {
      renderError(new Error(`${parsed.full} not found — rederive only works on public repositories`));
    } else {
      renderError(error);
    }
  } finally {
    document.querySelector('#grade-btn').disabled = false;
  }
}

async function selftest() {
  const enc = (s) => new TextEncoder().encode(s);
  const results = [];
  const check = async (name, fn, expected) => {
    try {
      const actual = await fn();
      results.push({ name, pass: actual === expected, detail: `expected ${expected}, got ${actual}` });
    } catch (error) {
      results.push({ name, pass: false, detail: error.message });
    }
  };
  await check('git blob sha of "hello\\n"', () => gitBlobSha1(enc('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  await check('sha256 of empty', () => sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  await check('parseRepoInput url', () => parseRepoInput('https://github.com/laynr/FedRAMP/tree/main/docs')?.full, 'laynr/FedRAMP');
  await check('parseRepoInput plain', () => parseRepoInput('laynr/rederive')?.full, 'laynr/rederive');
  await check('classifyTree covid-style', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ path: `csse_covid_19_data/daily/${i}.csv`, type: 'blob', size: 90_000, sha: 'x' }));
    const facts = classifyTree(entries);
    return `${facts.dataFiles.length},${facts.gradable}`;
  }, '12,true');
  await check('scan detects unpinned fetch', () => {
    const facts = classifyTree([{ path: 'data/out.csv', type: 'blob', size: 200_000, sha: 'x' }]);
    const scan = scanScriptText('fetch.py', 'import requests\nr = requests.get("https://example.com/api/live")\nopen("data/out.csv","w").write(r.text)\n', facts);
    return `${scan.networkCalls},${scan.unpinnedFetch},${scan.writesData}`;
  }, 'true,true,true');
  renderSelftest(results);
}

const form = document.querySelector('#grade-form');
form.addEventListener('submit', (e) => {
  e.preventDefault();
  document.querySelector('#grade-btn').disabled = true;
  run(document.querySelector('#repo-input').value);
});
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => run(chip.dataset.repo));
}

const params = new URLSearchParams(location.search);
if (params.has('selftest')) selftest();
else if (params.get('repo')) run(params.get('repo'));
