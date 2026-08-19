# rederive

**Can a repository's committed data be reproduced from the evidence in that repository?**

Try it at [laynr.github.io/rederive](https://laynr.github.io/rederive/).

rederive is a small, static prototype for examining data provenance in a public Git repository. It looks for data, the code that appears to produce it, and evidence that the inputs are fixed and verifiable. It then assigns an evidence grade:

- **F — data without a detected generation path.** The repository contains data files, but rederive did not find code that appears to produce them.
- **C — a process with moving or unclear inputs.** Generation code is present, but it reads from a live URL or another source whose contents may change. Running the same code later may therefore start with different information.
- **B — fixed, verifiable inputs, but no independent output check.** The source input is committed in Git or identified by an exact Git commit and verified fingerprint. rederive can establish what the process starts with, but it does not run the repository's code and prove that the committed output follows from that input.
- **A — an independently reproduced output.** The repository provides a `rederive.json` declaration. rederive loads the declared code and inputs from the exact repository revision, runs the transform without network access, and compares the resulting bytes with the committed output.

F, C, and B are diagnostic judgments based on bounded source inspection. They are useful clues, not proofs. A is deliberately different: it requires an explicit contract and a successful execution.

## Try the evidence ladder

These examples show both the useful parts and the limits of the prototype:

- **F — [Johns Hopkins COVID-19 data](https://laynr.github.io/rederive/?repo=CSSEGISandData%2FCOVID-19):** thousands of committed data files, with no generation code detected in the repository snapshot.
- **C — [Singapore government jobs data](https://laynr.github.io/rederive/?repo=opengovsg%2Fcareersgovsg-jobs-data):** a scheduled TypeScript process generates committed files from live APIs. The process is visible, but the remote responses can change.
- **B — [ProPublica COMPAS analysis](https://laynr.github.io/rederive/?repo=propublica%2Fcompas-analysis):** transformation code reads committed source data, so the starting input is fixed by Git. rederive does not execute the Python pipeline. In a separate manual test, one generated output matched the repository exactly and another did not, which is precisely why B is evidence rather than proof.
- **A — [rederive-demo](https://laynr.github.io/rederive/?repo=laynr%2Frederive-demo):** a purpose-built reference repository whose declared JavaScript transform reproduces the committed output byte for byte.

The A example demonstrates the mechanism; it is not evidence of adoption. I did not find an independently maintained repository using `rederive.json`.

## What `rederive.json` says

The declaration removes the need to guess which code produces which file. It names:

- the entry module to execute;
- the committed input files it may read;
- the expected output paths;
- the time limit and format version.

The expected output bytes are not copied into the declaration. The files already committed at the exact Git revision are the ground truth. rederive executes the declared transform and compares its results with those committed files.

The current A runner is intentionally narrow. It accepts JavaScript modules, allows only declared relative imports from the same repository revision, denies network access during execution, enforces a timeout, and compares bytes outside the execution sandbox. It cannot currently execute ordinary Python, R, notebooks, shell scripts, or arbitrary build systems.

The complete contract is documented in [the A-grade specification](https://laynr.github.io/rederive/spec.html).

## Why a static page

The assignment called for a self-contained systems-and-reliability experience. A static page made the first experiment easy to inspect and deploy: there is no application server, database, account, or installation step. Repository analysis happens locally in the browser, using public GitHub content.

That choice also exposed the central tradeoff. A browser is a good place to explain evidence, but a poor universal build environment. Real data projects use Python, R, SQL, notebooks, containers, workflow engines, and native tools. Supporting only browser-safe JavaScript makes the strongest grade genuine but very limited.

## Known limitations

- **Lower grades depend on heuristics.** rederive ranks likely source files and scans a bounded sample for file reads, writes, network calls, schedules, data paths, and mutable URLs. This is implemented with pattern matching, so unusual syntax and indirect dependencies can be missed.
- **A confirmed false positive exists.** An Economist repository was classified as B even though an R script calls a live OECD service. The scanner recognized committed inputs but missed that network access. This shows why lower grades must not be presented as certainty.
- **Modern provenance systems are not understood.** For example, the current OWID ETL repository records dependencies and snapshots with DVC and its own catalog, but rederive does not parse that model and reports a lower grade than the project deserves.
- **B does not prove the output.** It establishes that an exact input is available and that generation code appears to exist. It does not prove the code was used, that the environment was equivalent, or that the output matches.
- **A requires cooperation.** The repository author must add `rederive.json`, and the transform must fit the restricted JavaScript interface.
- **Running untrusted code still has risk.** The transform runs in a disposable Worker inside an opaque-origin sandboxed iframe. A content-security policy denies network access, and the Worker is terminated on timeout. These are meaningful boundaries, not a formal security proof; resource exhaustion and browser vulnerabilities remain possible. A production version should fail closed if the strongest isolation path is unavailable.

## A better next version

The obvious baseline is already valuable: clone the repository, select an exact revision, install exact dependencies, run its normal build, and fail if `git diff` shows a changed generated file. A well-designed CI job can do this in the project's native environment and record the command, inputs, dependency lockfiles, environment, and output hashes.

The limitation of CI is that it is usually an assertion made by the publisher inside the publisher's own system. The useful part of rederive is the independent, inspectable verification report.

I would combine those ideas in a next version:

1. A native CI job or local command runs the real Python, R, JavaScript, SQL, or containerized pipeline.
2. It emits structured provenance describing the exact revision, inputs, command, environment, and output fingerprints.
3. The static page verifies that evidence and explains it clearly, without trying to replace the project's build system.

The experiment's verification mechanism worked. The browser-only execution architecture was too narrow.

## Run locally

No build step is required:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Add `?selftest=1` to run the browser test suite.

The current suite includes 24 browser checks plus six live-repository checks used during development.

## AI use and time

Claude Code assisted with implementation, testing, and review. I accepted suggestions selectively, checked repository claims against source code and exact Git revisions, and kept the lower-grade conclusions explicitly probabilistic. The development transcript is included in [`transcripts/`](transcripts/).

The prototype took approximately 1 hour and 40 minutes to build, followed by documentation and video preparation.
