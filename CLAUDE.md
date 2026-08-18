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

## Development & testing

There are no build, lint, or test commands. To preview locally, open
`index.html` directly or serve the directory (`python3 -m http.server`).

Verify changes by loading the page in Chrome with the Claude for Chrome
browser tools (`mcp__claude-in-chrome__*`): navigate to the local or deployed
URL, take a screenshot, and check the console for errors.

## Deploying

Push to `main`; GitHub Pages redeploys automatically (allow ~a minute for the
Pages build). Check deploy status with
`gh api repos/laynr/rederive/pages/builds/latest`.

Because the site is served from `/rederive/` (not the domain root), use
relative paths for all internal links and assets.
