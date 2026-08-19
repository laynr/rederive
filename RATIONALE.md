# Design rationale

## The problem I chose

Public decisions often depend on data files stored in Git repositories. Git can show exactly which bytes were committed and how those bytes changed, but that does not automatically show where the data came from or whether the repository's code can reproduce it.

I chose the Systems & Reliability theme and tested a simple question: could an outside reviewer open a repository and get a useful, understandable answer about the strength of its data provenance?

This is relevant to public-sector work because a reviewer may need to understand an analytical result without access to the original developer, build machine, or internal service. The goal was not merely to label a repository. It was to make the evidence and the missing evidence visible.

## What I built

rederive is a static web page that accepts a public GitHub repository, examines one exact revision, and reports an evidence grade:

- **F:** data is present, but no generation path was detected.
- **C:** generation code was detected, but its inputs can move or are not clearly identified.
- **B:** the starting inputs are fixed and verifiable, and generation code appears to exist, but rederive does not independently reproduce the output.
- **A:** the repository explicitly declares the transform and inputs, rederive executes that transform without network access, and the resulting bytes equal the committed output.

The page also shows the evidence behind the grade and concrete ways the repository could improve it.

The most important distinction is that F, C, and B come from bounded source inspection, while A comes from execution. The lower grades are diagnostic; A is a tested claim under a narrow contract.

## Why this approach was interesting

The initial idea was to turn a vague statement—“this data is reproducible”—into increasingly strong claims that an outside reviewer could inspect:

1. Data exists.
2. Code appears to generate it.
3. The code starts from an exact, recoverable input.
4. An independent execution produces the exact committed output.

Git provides one useful anchor: an exact commit identifies an immutable repository snapshot. External files need a separate content fingerprint, currently SHA-256, so a re-download can be checked against the recorded bytes.

The non-obvious part is not the hash function. It is the separation of claims. “I can retrieve the same source input” is valuable, but it is weaker than “I ran the submitted code on that input and reproduced the committed result.” The B/A boundary makes that difference explicit.

For A, `rederive.json` names the entry module, declared inputs, and expected output. The output's expected bytes come from the file already committed at the examined Git revision. The page loads the declared code and inputs, executes the transform in a restricted browser environment, and performs the byte comparison outside that environment.

## What the real repositories showed

I tested the ladder against public repositories rather than relying only on constructed examples:

- **Johns Hopkins COVID-19 data received F** at commit `4360e50239b4eb6b22f3a1759323748f36752177`. The examined revision contains thousands of recognized data files, while rederive found no code in that snapshot that explains how they were generated.
- **Singapore's Careers@Gov data repository received C** at commit `906ab278b8c22f5d3b01e849b46caf4457380dfa`. Its scheduled TypeScript process fetches live APIs and writes committed files. The process is visible, but the same URLs can return different information later.
- **ProPublica's COMPAS analysis received B** at commit `bafff5da3f2e45eca6c2d5055faad269defd135a`. Its Python code reads committed source data, so Git fixes the starting bytes. rederive does not run the Python pipeline. In a separate manual execution, the regular two-year output matched while the violent-recidivism output did not, demonstrating why fixed inputs alone are not output proof.
- **`laynr/rederive-demo` received A** at commit `e17df8dddd75bbe0287ade55305267f8c0c4dbb0`. This is a purpose-built reference that supplies `rederive.json` and fits the JavaScript execution contract. This demonstrates feasibility not adoption.

I also found a confirmed false positive in the lower-grade scanner. The Economist's `the-economist-gdp-per-hour-estimates` received B at commit `513d0913e3e53d691fc05ba5effc7d6e870e7618`, even though `scripts/01-data-setup.R` calls a live OECD service. The scanner saw committed inputs and failed to recognize that network dependency. This shows that pattern-based inspection (what F, C, and B use) cannot support confident provenance claims.

The current OWID ETL project provided another useful counterexample. It has a substantially richer pipeline, including DVC-managed snapshots, dependency graphs, and a data catalog. rederive does not understand those mechanisms and reports C. In provenance maturity, OWID's actual system should score higher than this prototype can recognize.

## Key design decisions and tradeoffs

### Static and client-side

I chose a static page because it is self-contained, easy to deploy, and easy for a reviewer to inspect. It requires no account, database, application server, or local installation. It also suits constrained environments where adding a service creates operational and authorization costs.

The tradeoff is severe: **a browser is not a general-purpose data-build environment. Real projects use Python, R, notebooks, shell tools, containers, databases, workflow engines, and language-specific dependency systems. The current A runner accepts only JavaScript modules with declared relative imports. This makes A meaningful when it applies, but it applies to a small space.**

### A restricted execution boundary

Running another repository's code in a browser is not automatically safe. The current implementation uses a disposable module Worker inside an opaque-origin sandboxed iframe, applies a content-security policy that denies network access, restricts imports to declared repository files, and terminates the Worker on timeout. The final byte comparison happens outside the sandbox.

Those controls reduce access to network, cookies, and storage, but they are defense in depth rather than a formal proof. Resource exhaustion and browser vulnerabilities remain possible. The fallback execution path is weaker; a production verifier should fail closed instead of using weaker isolation.

## What I would do next

I would not expand the browser into a collection of language runtimes. I would move execution to a small native tool or a repository's existing CI and make the result portable.

I would also replace generic pattern matching with ecosystem-aware adapters for systems such as DVC, notebooks, dbt, workflow files, and common CI providers. Unknown evidence should lower confidence instead of being silently treated as absent.

The result of the experiment is therefore mixed but useful: the independent execution and exact byte comparison work, while the browser-only architecture and heuristic lower grades are too narrow for the diversity of real data projects. The strongest next design keeps the clear evidence ladder and independent report, but relies on native build environments for execution.

## Testing and evaluation

The browser self-test suite contains 24 checks covering classification, fixed-input verification, manifest handling, sandbox restrictions, timeouts, and output comparison. I also exercised six live repositories and manually inspected the source paths responsible for representative grades.

The external examples are tied to exact Git revisions during analysis. That matters because a repository's default branch can change after the video or review.

## Use of AI

Claude Code assisted with implementation, tests, and review. I treated generated conclusions as hypotheses to verify, especially claims about external repositories. Manual inspection uncovered both a real lower-grade false positive and the mismatch in one ProPublica output. Those findings changed the presentation from “the analyzer proves provenance” to the narrower and more defensible claim described here.

The development transcript is included under [`transcripts/`](transcripts/).

## Time

The working prototype took approximately 1 hour and 40 minutes. Documentation, external-repository verification, and video preparation followed separately.
