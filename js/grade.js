/**
 * Evidence → letter grade. Pure decision table, evaluated top-down,
 * first match wins (see plan §grading).
 */

export function computeGrade(ev) {
  const bullets = [];
  const add = (severity, text, paths = []) => bullets.push({ severity, text, paths });

  // A rederive.json makes a repo gradable regardless of data volume —
  // the manifest itself declares which committed files are the data.
  if (!ev.facts.gradable && !ev.manifest) {
    add('warn', 'No significant committed data files found — nothing to grade.');
    return { grade: 'N/A', verdict: 'no significant committed data', bullets, next: [] };
  }

  if (ev.facts.dataFiles.length > 0) {
    add('info', `${ev.facts.dataFiles.length} data file(s), ${formatBytes(ev.facts.totalDataBytes)} total, in ${ev.facts.dataDirs.slice(0, 5).join(', ') || 'repo root'}.`,
      ev.facts.dataFiles.slice(0, 5).map((f) => f.path));
  }
  if (ev.truncated) add('warn', 'Repository tree was truncated by the GitHub API — analysis covers a sample of files.');

  // writesData alone is not generator evidence — generic write calls appear in
  // unrelated build tooling. It only counts coupled to a data-path reference.
  const generators = ev.scans.filter((s) => s.referencesData || s.wiresGenerators);
  const anyUnpinned = generators.some((s) => s.unpinnedFetch);
  const anyNetwork = generators.some((s) => s.networkCalls);
  const scheduled = ev.scans.filter((s) => s.scheduledWorkflow);

  // A path
  if (ev.manifest) {
    if (ev.manifest.status === 'passed') {
      add('good', `rederive.json verified: transform re-ran in the browser sandbox and ${ev.manifest.outputsMatched} output(s) matched the committed bytes exactly.`);
      return { grade: 'A', verdict: 'the recipe just ran here and reproduced the committed data exactly', bullets, next: [] };
    }
    add('bad', `A attempt failed: ${ev.manifest.reason}`);
  }

  if (generators.length === 0) {
    // Contradictory evidence: no generator identified, but pins actively
    // verified — that's not a flat F.
    if (ev.pinReport && ev.pinReport.failed === 0 && ev.pinReport.verified + ev.pinReport.weak > 0) {
      add('warn', `No generation code identified, but ${ev.pinReport.verified + ev.pinReport.weak} pinned input(s) were verified — provenance is recorded even though the recipe wasn't found.`);
      return {
        grade: 'C',
        verdict: 'generator not identified, but verified pins exist',
        bullets,
        next: [
          'Commit the script that turns the pinned inputs into the data files, referencing their paths, to reach B.',
        ],
      };
    }
    if (ev.facts.codeFiles.length === 0) {
      add('bad', 'No generation code in the repository — data only. The data cannot be re-derived or traced.');
    } else {
      add('bad', `Code files exist (${ev.facts.codeFiles.length}) but none of the ${ev.scannedCount} scanned scripts reference the data files — the data appears hand-maintained.`);
    }
    return {
      grade: 'F',
      verdict: 'data cannot be re-derived from this repository',
      bullets,
      next: [
        'Commit the script that generates these files and have it reference the data paths.',
        'Then pin its inputs (commit SHAs / sha256) to reach B.',
      ],
    };
  }

  add('good', `Generation code found: ${generators.slice(0, 5).map((g) => g.path).join(', ')}${generators.length > 5 ? '…' : ''}.`,
    generators.slice(0, 5).map((g) => g.path));
  if (scheduled.length) add('good', `Scheduled workflow(s) regenerate the data automatically: ${scheduled.map((s) => s.path).join(', ')}.`);

  // B path — pins verified
  if (ev.pinReport && ev.pinReport.rows.length > 0) {
    const { verified, weak, failed, skipped } = ev.pinReport;
    if (failed > 0) {
      add('bad', `Pin verification FAILED for ${failed} input(s) — recorded hashes do not match the pinned content (or it is unreachable).`);
      return {
        grade: 'C',
        verdict: 'pins claimed but could not be verified',
        bullets,
        next: ['Fix or refresh the recorded commit/sha256 values so pinned inputs verify.'],
      };
    }
    if (verified + weak > 0) {
      // B means ALL inputs are pinned. Verified pins alongside live unpinned
      // fetches is mixed evidence, not a B.
      if (anyUnpinned) {
        const offenders = generators.filter((s) => s.unpinnedFetch);
        add('bad', `${verified + weak} pinned input(s) verified, but generator(s) also fetch live unpinned sources: ${offenders.slice(0, 5).map((s) => s.path).join(', ')}. B requires every network input to be pinned.`);
        return {
          grade: 'C',
          verdict: 'partially pinned — some inputs are still moving targets',
          bullets,
          next: ['Pin the remaining live sources to immutable commits with recorded hashes; when every network input is pinned and verifiable, that is grade B.'],
        };
      }
      add('good', `Actively verified ${verified} pinned input(s)${weak ? ` (+${weak} pinned to commit without an independent content hash)` : ''}${skipped ? `, ${skipped} skipped` : ''} — re-downloaded and hashes matched.`);
      return {
        grade: 'B',
        verdict: 'inputs pinned and verified — re-derivable in principle',
        bullets,
        next: ['Adopt rederive.json (see the spec) so the transform itself can be re-run and byte-checked here — that is grade A.'],
      };
    }
  }

  // B path — inputs committed in-tree, no network
  const committedOnly = generators.filter((s) => s.readsCommittedInputs.length > 0 && !s.networkCalls);
  if (committedOnly.length > 0 && !anyNetwork) {
    add('good', `Generator(s) read only files committed in this repository (${[...new Set(committedOnly.flatMap((s) => s.readsCommittedInputs))].slice(0, 5).join(', ')}) with no network access — the commit itself pins the inputs.`);
    return {
      grade: 'B',
      verdict: 'inputs committed alongside outputs — the commit is the pin',
      bullets,
      next: ['Adopt rederive.json (see the spec) so the transform can be re-run and byte-checked here — that is grade A.'],
    };
  }

  if (anyUnpinned) {
    const offenders = generators.filter((s) => s.unpinnedFetch);
    add('bad', `Generator(s) fetch live, unpinned sources: ${offenders.slice(0, 5).map((s) => s.path).join(', ')}. Re-running today may not reproduce the committed data.`);
    return {
      grade: 'C',
      verdict: 'generated, but from moving targets',
      bullets,
      next: [
        'Pin every source download to an immutable revision (40-hex commit in the URL) and record its sha256.',
        'Then this page can re-download and verify them — that is grade B.',
      ],
    };
  }

  add('warn', 'Generator found, but where its inputs come from is unclear (paths not in this repository, no pins detected).');
  return {
    grade: 'C',
    verdict: 'generated, but input provenance is unclear',
    bullets,
    next: [
      'Commit the inputs, or pin them to commit SHAs with recorded hashes, to reach B.',
    ],
  };
}

export function formatBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 ** 3)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 ** 2)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
