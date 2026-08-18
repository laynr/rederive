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
client-side: at most 6 anonymous GitHub API calls per repo (3 for
metadata/tree, plus up to 3 blob-anchor lookups during pin verification),
with file contents fetched via commit-pinned CDN URLs. Living A-grade
example: [laynr/rederive-demo](https://github.com/laynr/rederive-demo).

## Limitations

Grades below A are heuristic: content scanning covers a bounded sample of
scripts, and pins are verified against their recorded hashes but not proven
to actually feed the declared outputs — grades are evidence, not proof.

The A-grade sandbox is defense in depth, not a formally proven boundary: the
repo's transform runs in a disposable module Worker inside an opaque-origin
sandboxed iframe whose CSP denies network access, and is hard-terminated on
timeout — but it is still third-party code executing in your browser, and
resource exhaustion before the timeout fires is possible. The byte-for-byte
output comparison, computed outside the sandbox, is what the grade actually
rests on.
