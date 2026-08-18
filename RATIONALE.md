# rederive — rationale

## Why this approach

Committed data is everywhere trusted and almost nowhere verifiable. The JHU
COVID-19 repo — one of the most cited datasets ever — is thousands of CSVs
with zero generation code; nothing about it can be re-derived or traced. At
the other end, it is possible to build data pipelines where every input is
pinned to an immutable commit, every byte is hashed, and the whole derivation
re-runs deterministically (github.com/laynr/FedRAMP does this). rederive makes
that spectrum legible: paste a repo, get a graded F/C/B/A report on how
verifiable its data actually is. The underlying idea is "trust me" becomes
"check me."

The tool practices what it grades: a static page with zero runtime
dependencies, no frameworks, no build step, no backend. All analysis runs in
the visitor's browser against GitHub's public API (≤6 anonymous calls per
repo) with file contents fetched from commit-pinned CDN URLs. There is
nothing server-side to trust.

## What is non-obvious

- **The grades are actions, not pattern matches.** B doesn't mean "pins were
  detected" — the page re-downloads each pinned input at its commit and
  recomputes sha256 and the git blob SHA-1 against the recorded values. A
  means the page just executed the repo's declared transform in a sandboxed,
  no-network context and the output matched the committed bytes exactly.
- **The repo's own commit is the ground truth for A.** Output hashes live
  nowhere in the manifest; expected bytes are anchored by the analyzed
  commit's tree blob SHAs, so a repo can't claim hashes it doesn't ship.
- **The git blob SHA trick.** Recomputing `SHA-1("blob " + len + "\0" +
  bytes)` lets the page verify content against GitHub's own object identity —
  independent of any hash the publisher recorded.
- **Rate-limit arithmetic.** Anonymous GitHub API allows 60 calls/hour, so
  the design fetches only metadata and one recursive tree from the API; all
  file contents come from commit-pinned raw.githubusercontent/jsDelivr URLs,
  which are CORS-open and uncounted.

## Tradeoffs

- **Heuristics under-claim by design.** Script scanning covers a bounded,
  ranked sample; generic write calls don't count as generator evidence unless
  coupled to the detected data paths. False negatives (a C that deserved B)
  are acceptable; a confident wrong B is not. Grades are evidence, not proof
  — pins are verified but not proven to feed the declared outputs.
- **A requires opt-in.** Re-running arbitrary Python/R pipelines in a browser
  isn't feasible without dependencies, so A is earned through a small
  manifest spec (rederive.json) plus a pure ES-module transform. That narrows
  who can get an A today but makes the top grade actually mean something.
- **The sandbox is layered defense, not a proof.** Opaque-origin iframe, CSP
  `default-src 'none'`, a disposable worker with hard termination — but it is
  still third-party code in a browser. The grade rests on the byte
  comparison, computed outside the sandbox.
- **Deterministic-by-construction demo.** laynr/rederive-demo derives even
  its timestamp from upstream input content, never the wall clock, so the
  same commit always reproduces identical bytes.

## Extensions

- Grade history: analyze a repo at a past commit (the machinery already pins
  everything to a commit; only ref selection is missing).
- A Node CLI sharing the same modules (they are runtime-agnostic ES modules)
  for CI use: fail a build when the grade drops.
- Badge endpoint semantics: repos embed their grade, recomputed on view.
- Wasm runners for Python-adjacent transforms as an opt-in heavier tier.

## Time spent

About 1 hour 40 minutes in a single Claude Code session (the unedited
transcript is in `transcripts/`): concept and grading rubric, the static
analyzer, active pin verification, the rederive.json spec + sandbox executor,
the demo repo, an in-page selftest suite (24 vectors), browser-driven E2E
across six live repos, and repeated deploy/verify cycles on GitHub Pages —
plus separate time on this write-up's polish and the video.
