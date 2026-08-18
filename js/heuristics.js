/**
 * Pure heuristics over a repo tree and script contents. No network — the
 * caller injects a fetchText(path) function for the scan budget.
 */

const DATA_EXTS = new Set(['csv', 'tsv', 'json', 'ndjson', 'jsonl', 'geojson', 'xml', 'parquet', 'arrow', 'sqlite', 'db']);
const DATA_DIR_RE = /^(data|datasets?|outputs?|out|generated|gen|derived|processed)$/i;
const CODE_EXTS = new Set(['js', 'mjs', 'cjs', 'ts', 'py', 'rb', 'sh', 'r', 'pl', 'go', 'rs', 'java', 'jl', 'ipynb']);
const GENERATOR_NAME_RE = /(build|generat|gen[_-]|fetch|update|scrape|crawl|download|derive|etl|pipeline|refresh|sync|convert|process|make[_-]|import)/i;
const CODE_DIR_RE = /^(scripts?|tools?|bin|src|etl|pipeline)$/i;
const EXCLUDED_DIR_RE = /^(node_modules|vendor|\.git|tests?|test|spec|fixtures?|__snapshots__|__tests__|examples?)$/i;
const CONFIG_NAMES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.json', 'composer.lock',
  'tsconfig.json', 'jsconfig.json', 'renovate.json', 'lerna.json', 'bower.json', 'manifest.json',
  'rederive.json', '.eslintrc.json', '.babelrc', 'deno.json', 'Cargo.lock',
]);

const ext = (path) => {
  const base = path.split('/').pop();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
};
const segments = (path) => path.split('/');
const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);

/** Classify tree entries into data files, code candidates, and pin-manifest candidates. */
export function classifyTree(entries) {
  const blobs = entries.filter((e) => e.type === 'blob');
  const paths = new Set(blobs.map((e) => e.path));

  const excluded = (path) => segments(path).slice(0, -1).some((s) => EXCLUDED_DIR_RE.test(s));
  const isConfig = (path) => {
    const base = path.split('/').pop();
    return CONFIG_NAMES.has(base) || /\.config\.[a-z]+$/i.test(base) || path.startsWith('.github/');
  };

  // Count same-extension siblings per directory for the "grid of CSVs" rule.
  const siblingCounts = new Map();
  for (const e of blobs) {
    const key = `${dirOf(e.path)}*.${ext(e.path)}`;
    siblingCounts.set(key, (siblingCounts.get(key) ?? 0) + 1);
  }

  const dataFiles = [];
  for (const e of blobs) {
    if (excluded(e.path) || isConfig(e.path)) continue;
    const x = ext(e.path);
    const inDataDir = segments(e.path).slice(0, -1).some((s) => DATA_DIR_RE.test(s));
    const isDataExt = DATA_EXTS.has(x) || ((x === 'yaml' || x === 'yml') && inDataDir);
    if (!isDataExt || e.size < 1024) continue;
    const siblings = siblingCounts.get(`${dirOf(e.path)}*.${x}`) ?? 0;
    if (inDataDir || e.size >= 50 * 1024 || siblings >= 10) {
      dataFiles.push(e);
    }
  }

  const codeFiles = blobs.filter((e) => {
    if (excluded(e.path)) return false;
    const base = e.path.split('/').pop();
    // Test files are not generators — their fixtures legitimately contain
    // mutable-URL strings (asserting they get rejected) and generic writes.
    if (/(\.(test|spec)\.[a-z]+|_test\.[a-z]+)$/i.test(base) || /^test_[^/]+\.py$/i.test(base)) return false;
    return CODE_EXTS.has(ext(e.path)) || base === 'Makefile' || base === 'Justfile' || base === 'Dockerfile';
  });

  const workflowFiles = blobs.filter((e) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(e.path));
  const packageJsons = blobs.filter((e) => e.path.split('/').pop() === 'package.json' && !excluded(e.path));

  // Small JSONs that might be pin manifests (FedRAMP-style meta.json etc.)
  const pinManifestCandidates = blobs.filter((e) => {
    if (excluded(e.path) || e.size >= 100 * 1024 || e.size < 20) return false;
    const base = e.path.split('/').pop();
    if (!/\.(json|ya?ml|lock|toml)$/i.test(base) && !/lock$/i.test(base)) return false;
    return /(meta|sources?|inputs?|pins?|provenance|upstream|lock)/i.test(base);
  });

  const totalDataBytes = dataFiles.reduce((n, e) => n + e.size, 0);
  const dataDirs = [...new Set(dataFiles.map((e) => dirOf(e.path) || '(root)'))];

  return {
    paths,
    dataFiles,
    dataDirs,
    totalDataBytes,
    gradable: totalDataBytes >= 100 * 1024 || dataFiles.length >= 5,
    codeFiles,
    workflowFiles,
    packageJsons,
    pinManifestCandidates,
    hasRederiveManifest: paths.has('rederive.json'),
  };
}

/** Rank candidate scripts for the content-scan download budget. */
export function rankScanCandidates(facts) {
  const score = (e) => {
    const base = e.path.split('/').pop();
    if (base === 'Makefile' || base === 'Justfile' || base === 'package.json') return 0;
    if (/^\.github\/workflows\//.test(e.path)) return 0;
    let s = 3;
    if (GENERATOR_NAME_RE.test(base)) s -= 2;
    if (segments(e.path).slice(0, -1).some((d) => CODE_DIR_RE.test(d))) s -= 1;
    return s;
  };
  const pool = [...facts.codeFiles, ...facts.workflowFiles, ...facts.packageJsons]
    .filter((e, i, arr) => arr.findIndex((x) => x.path === e.path) === i)
    .filter((e) => e.size <= 200 * 1024);
  return pool.sort((a, b) => score(a) - score(b) || a.size - b.size);
}

const URL_RE = /https?:\/\/[^\s"'`<>)\]}]+/g;
const NET_CALL_RE = /\b(requests\.(get|post)|urllib|urlopen|fetch\s*\(|axios|curl\s|wget\s|http\.get|httpx\.|aiohttp|read_csv\s*\(\s*["']https?:|download\.file|GET\s+http)/i;
const WRITE_RE = /\b(to_csv|to_json|to_parquet|writeFile|writeFileSync|json\.dump|csv\.writer|write_csv|saveRDS|write\.csv|fwrite|open\([^)]*["']w)/i;
const MUTABLE_URL_RE = /(raw\.githubusercontent\.com\/[^/\s"'`]+\/[^/\s"'`]+\/(main|master|HEAD)\/|@(main|master|latest)\b|github\.com\/[^\s"'`]+\/blob\/(main|master)\/)/;
const COMMIT_IN_URL_RE = /\/[0-9a-f]{40}\//;
const PIN_ASSIGN_RE = /\b(commit|sha|rev|ref|revision|version)\s*[:=]\s*["']([0-9a-f]{40})["']/gi;
const SHA256_CONST_RE = /\b[0-9a-f]{64}\b/;
const TEMPLATE_MARK_RE = /[${}%]|\+\s*$/;

const isPinnedUrl = (u) => COMMIT_IN_URL_RE.test(u) || /@[0-9a-f]{40}\b/.test(u);

/** A literal URL that plausibly fetches data live (unpinned). Excludes
 * runtime-composed templates (judged by their resolved pins), api.github.com
 * revision lookups, and github.com web pages that aren't data fetches. */
function isLiveDataUrl(u) {
  if (TEMPLATE_MARK_RE.test(u)) return false;
  const host = u.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  if (host === 'api.github.com') return false;
  if (host === 'github.com' || host === 'www.github.com') {
    return /\/(raw|releases\/download|archive)\//.test(u);
  }
  return true;
}

/**
 * Scan one script's text against the tree facts.
 * Returns evidence flags for the grader plus extracted pins.
 */
export function scanScriptText(path, text, facts) {
  const result = {
    path,
    referencesData: false,
    referencedPaths: [],
    writesData: false,
    networkCalls: false,
    unpinnedFetch: false,
    pinnedUrls: [],
    liveUrls: [],
    commitPins: [],
    hasSha256Constants: false,
    readsCommittedInputs: [],
    scheduledWorkflow: false,
  };

  // Does it mention any detected data path, data dir, or write data files?
  const dataDirNames = new Set(facts.dataDirs.map((d) => d.replace(/\/$/, '').split('/').pop()).filter(Boolean));
  for (const f of facts.dataFiles) {
    const base = f.path.split('/').pop();
    if (base.length >= 5 && text.includes(base)) {
      result.referencesData = true;
      result.referencedPaths.push(f.path);
      if (result.referencedPaths.length >= 5) break;
    }
  }
  if (!result.referencesData) {
    for (const d of dataDirNames) {
      if (d.length >= 3 && new RegExp(`["'/ ]${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`).test(text)) {
        result.referencesData = true;
        break;
      }
    }
  }
  if (WRITE_RE.test(text)) result.writesData = true;

  // Network + pinning. One pinned source does not excuse a live one: a script
  // is unpinned unless ALL of its detected network inputs are pinned.
  const urls = text.match(URL_RE) ?? [];
  result.networkCalls = NET_CALL_RE.test(text);
  for (const u of urls) {
    if (isPinnedUrl(u)) result.pinnedUrls.push(u);
    else if (isLiveDataUrl(u)) result.liveUrls.push(u);
  }
  let m;
  while ((m = PIN_ASSIGN_RE.exec(text)) !== null) result.commitPins.push(m[2]);
  result.hasSha256Constants = SHA256_CONST_RE.test(text);
  const hasMutableUrl = MUTABLE_URL_RE.test(text);
  result.unpinnedFetch = hasMutableUrl
    || (result.networkCalls && (result.liveUrls.length > 0
      || (result.pinnedUrls.length === 0 && result.commitPins.length === 0)));

  // Reads of paths committed in the same tree (relative reads, no network → pinned by commit)
  const readRe = /(?:open|read_csv|read_json|readFileSync|readFile|read\.csv|fromJSON|loadtxt|pd\.read_\w+)\s*\(\s*["']([^"']+)["']/g;
  while ((m = readRe.exec(text)) !== null) {
    const p = m[1].replace(/^\.\//, '');
    if (facts.paths.has(p)) result.readsCommittedInputs.push(p);
  }

  if (/^\.github\/workflows\//.test(path) && /\bschedule:\s*$|\bcron:/m.test(text)) {
    result.scheduledWorkflow = true;
  }

  return result;
}

/** package.json scripts wiring candidate files counts as generator evidence. */
export function scanPackageJson(path, text, facts) {
  const base = scanScriptText(path, text, facts);
  try {
    const pkg = JSON.parse(text);
    const scripts = Object.values(pkg.scripts ?? {}).join(' ');
    if (scripts && facts.codeFiles.some((e) => scripts.includes(e.path.split('/').pop()))) {
      base.wiresGenerators = true;
    }
  } catch { /* not JSON — treat as plain text scan */ }
  return base;
}
