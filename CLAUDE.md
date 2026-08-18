# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

rederive is a static, client-side-only site hosted on GitHub Pages at
https://laynr.github.io/rederive/ (repo: github.com/laynr/rederive).

## Hard constraints

- **Zero runtime dependencies.** No frameworks, no libraries, no CDN scripts,
  no npm packages. Plain HTML, CSS, and vanilla JavaScript only.
- **No build step.** Files in the repo are served as-is by GitHub Pages
  (deployed from the `main` branch root). Never introduce bundlers,
  transpilers, or preprocessors.
- All logic runs in the browser; there is no server component.

## What it is

Paste a GitHub repo URL → graded report (F/C/B/A) on whether the repo's
committed data can be re-derived from its own scripts. B actively re-downloads
pinned inputs and checks hashes; A re-runs a rederive.json transform in a
sandboxed iframe (`sandbox.html` — a separate document, NOT srcdoc, because
srcdoc would inherit the page CSP and block its inline bootstrap) and
byte-compares outputs. Budget: ≤3 api.github.com calls per analysis (repo
meta, head commit, recursive tree) + ≤3 pin-anchor calls; all file contents
come from commit-pinned raw.githubusercontent/jsdelivr URLs (CORS `*`, no
API quota). `js/fetch-verified.js` and `js/revisions.js` are ports of
laynr/FedRAMP's tested `fetch-json.js`/`feeds.js` — keep them close to
upstream.

## Development & testing

There are no build, lint, or test commands. Serve locally with
`python3 -m http.server` (crypto.subtle needs a secure context — localhost
works, `file://` does not).

Verify changes with the Claude for Chrome browser tools
(`mcp__claude-in-chrome__*`); hard-reload (cmd+shift+r) after editing JS —
Chrome heuristically caches modules from http.server. Test matrix:
- `?selftest=1` — in-page hash/heuristic vectors, all must pass
- `?repo=CSSEGISandData/COVID-19` → F
- `?repo=owid/covid-19-data` → C
- `?repo=laynr/FedRAMP` → B (pin table all verified)
- `?repo=laynr/rederive-demo` → A (byte-for-byte)
- bogus repo → not-found error; code-only repo → N/A
- confirm ≤3 api.github.com requests and a clean console

## Deploying

Push to `main`; GitHub Pages redeploys automatically (allow ~a minute for the
Pages build). Check deploy status with
`gh api repos/laynr/rederive/pages/builds/latest`.

Because the site is served from `/rederive/` (not the domain root), use
relative paths for all internal links and assets.
