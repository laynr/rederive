# rederive

Can a repo's committed data actually be re-derived from its own scripts?
Paste it at **https://laynr.github.io/rederive/** and find out.

- **F** — data files present; no generation code, or the output is hand-edited
- **C** — a script exists, but it fetches live, unpinned sources
- **B** — inputs pinned to commits/hashes; this page re-downloads them and
  verifies the recorded hashes match
- **A** — the repo opts into [rederive.json](https://laynr.github.io/rederive/spec.html);
  the page re-runs the recipe in a no-network browser sandbox and the output
  matches the committed bytes exactly

Static page, zero runtime dependencies, no build step. Analysis is fully
client-side: ≤3 anonymous GitHub API calls per repo, file contents via
commit-pinned CDN URLs. Living A-grade example:
[laynr/rederive-demo](https://github.com/laynr/rederive-demo).

## Limitations

Grades below A are heuristic: content scanning covers a bounded sample of
scripts, and pins are verified against their recorded hashes but not proven
to actually feed the declared outputs — grades are evidence, not proof.
