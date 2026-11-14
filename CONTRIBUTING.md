# Contributing

Thanks for helping make Luculent Browser Driver for AI Agents faster and safer.

## Setup
```bash
npm install
npx playwright install chromium   # the extension tests load the extension into Playwright's Chromium
npm test                          # relay, security controls, headless and real-extension end-to-end tests
```
Node 20+ is required. Tests run against local fixtures only and never touch your own Chrome profile.

## Before you open a pull request
* `npm test` passes. New behaviour comes with a test (`test/*.test.mjs`); a new site/use case belongs in
  `harness/broad.mjs` (local fixture in `test/fixtures-broad.mjs` for anything with logins, payments or uploads).
* Security controls stay default-safe. Anything that lets an agent do more (new CDP methods, new actions that read
  page data, new permissions in `extension/manifest.json`) needs a matching check in **both** `src/relay.mjs` (or
  `src/policy.mjs`) and `extension/sw.js`, plus a test in `test/security.test.mjs` / `test/extension-security.test.mjs`.
* No new runtime dependencies without discussion (the relay depends only on `ws`).
* No remote code: the extension must not load or eval scripts from the network.
* Keep the benchmark honest: if you change performance, re-run `npm run bench` and update `store/BENCHMARK.md` with
  the real numbers and the machine they came from.

## Live-site testing etiquette
`node harness/broad.mjs --live 1` visits public sites. It never logs in, posts or buys, waits at least 1.5 s between
pages, and marks bot walls as "blocked" instead of retrying. Please keep it that way.

## Reporting security issues
Please don't open a public issue; see [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the MIT License.
