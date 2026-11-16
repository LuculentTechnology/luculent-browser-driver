# Luculent Browser Driver: Test Results

Every number on this page comes from a run log committed to this repository. If a result has no log, it is not on this page.
Machine for all runs: AMD Ryzen 5 5500, 32 GB RAM, Windows. Times are wall clock.

| Section | Run date | Log |
|---|---|---|
| 1. Driver speed vs Playwright MCP | Nov 15, 2026 | [`bench/results.json`](../bench/results.json) |
| 2. Transport comparison | Nov 14, 2026 | [`harness/logs/compare-2026-11-14.json`](logs/compare-2026-11-14.json) |
| 3. Real model runs, 10 tasks | Nov 15, 2026 | [`logs/models-deepseek-2026-11-15.json`](logs/models-deepseek-2026-11-15.json), [`logs/models-codex-2026-11-15.json`](logs/models-codex-2026-11-15.json) |
| 4. Budgeted model trials | Nov 14, 2026 | [`logs/budgeted-trials-2026-11-14.json`](logs/budgeted-trials-2026-11-14.json) |
| 5. Broad site suite | Nov 15, 2026 | [`logs/broad-local-headless-2026-11-15.json`](logs/broad-local-headless-2026-11-15.json), [`logs/broad-live-headless-2026-11-15.json`](logs/broad-live-headless-2026-11-15.json) |
| 6. Unit and security tests | Nov 15, 2026 | [`logs/npm-test-2026-11-15.tap`](logs/npm-test-2026-11-15.tap) |

## 1. Driver speed vs Playwright MCP (`node bench/bench.mjs`)

No model is involved. Both drivers run headless as MCP servers over stdio on the same local fixture pages (`test/fixtures.mjs`) and are timed by the same client. Median of 7 runs. Full method: [`store/BENCHMARK.md`](../store/BENCHMARK.md).

| Measure | Luculent (headless) | Playwright MCP 0.0.85 (headless) |
|---|---:|---:|
| 7-action sign-up form, all steps in one call | 131 ms | 1,748 ms |
| Same form, one call per action | 165 ms | 1,748 ms |
| 4-action search, all steps in one call | 163 ms | 1,115 ms |
| Same search, one call per action | 168 ms | 1,115 ms |
| Time per tool call, form | 5.9 ms | 45.3 ms |
| Time per tool call, search | 25.9 ms | 505.6 ms |
| Tool calls to finish the form | 1 | 7 |
| Data the agent reads, form | 0.8 KB | 4.0 KB |
| Data the agent reads, search | 0.4 KB | 2.4 KB |
| Cold start, new server to first page | 522 ms | 774 ms |

Luculent through the extension in a real Chrome tab, same run: form 177 ms batched / 237 ms per action, search 178 ms / 193 ms.

## 2. Transport comparison (`node harness/compare.mjs --iters 7`)

Same fixture pages. p50 / p95 over 7 runs.

| Driver / transport | Cold start | Form batched | Form per action | Search batched | Search per action |
|---|---:|---|---|---|---|
| Luculent MCP stdio, extension tab | 145 ms | 184 / 186 ms | 247 / 259 ms | 180 / 182 ms | 186 / 191 ms |
| Luculent MCP stdio, headless | 452 ms | 132 / 141 ms | 167 / 170 ms | 152 / 154 ms | 160 / 173 ms |
| Luculent MCP HTTP `/mcp`, extension tab | 25 ms | 188 / 235 ms | 293 / 314 ms | 182 / 183 ms | 206 / 209 ms |
| Luculent HTTP `/v1/rpc`, extension tab | 3 ms | 234 / 252 ms | 337 / 370 ms | 192 / 202 ms | 229 / 235 ms |
| Luculent WebSocket `/v1/ws`, extension tab | 3 ms | 209 / 223 ms | 297 / 329 ms | 189 / 195 ms | 213 / 217 ms |
| Playwright MCP 0.0.85, headless | 802 ms | not supported | 1,766 / 1,782 ms | not supported | 1,122 / 1,134 ms |

Extension cold connect (Chrome start to relay paired): 1,781 ms. OpenCode Browse and the Kimi browser extension were not installed on this machine, so the log has no numbers for them.

## 3. Real model runs, 10 tasks (`node harness/models.mjs`)

A real model drives Luculent over MCP through 10 tasks on the fixture pages: form, search, multitab, dynamic, upload, iframe, hover, drag, popup and guard. A task passes only if the server-side check matches.

### DeepSeek v4.1 Flash (`deepseek/deepseek-v4.1-flash-1017`, OpenRouter): 10/10 PASS

| Task | Result | Seconds | Tool calls | Turns | Tokens | Cost |
|---|---|---:|---:|---:|---:|---:|
| form | PASS | 34.1 | 5 | 6 | 71,343 | $0.00496 |
| search | PASS | 5.4 | 3 | 4 | 46,739 | $0.00279 |
| multitab | PASS | 5.2 | 2 | 3 | 34,743 | $0.00331 |
| dynamic | PASS | 5.2 | 4 | 5 | 58,618 | $0.00082 |
| upload | PASS | 5.1 | 3 | 4 | 45,792 | $0.00038 |
| iframe | PASS | 17.2 | 6 | 7 | 82,663 | $0.00152 |
| hover | PASS | 6.2 | 3 | 4 | 46,038 | $0.00251 |
| drag | PASS | 8.2 | 6 | 7 | 81,053 | $0.00067 |
| popup | PASS | 2.8 | 2 | 3 | 34,660 | $0.00046 |
| guard | PASS | 5.9 | 2 | 3 | 34,404 | $0.00027 |

Total cost for all 10 tasks: $0.0177.

### Codex CLI 0.164.0 (default model, Luculent over MCP HTTP): 10/10 PASS

Codex CLI does not report its model name, token count or cost to the harness, so those columns are not shown.

| Task | Result | Seconds | Tool calls |
|---|---|---:|---:|
| form | PASS | 18.6 | 4 |
| search | PASS | 26.8 | 5 |
| multitab | PASS | 13.9 | 6 |
| dynamic | PASS | 13.5 | 4 |
| upload | PASS | 14.8 | 4 |
| iframe | PASS | 13.0 | 4 |
| hover | PASS | 15.1 | 5 |
| drag | PASS | 16.1 | 4 |
| popup | PASS | 21.1 | 5 |
| guard | PASS | 15.6 | 4 |

Other models (Claude, Grok, Gemini) have no run log yet, so they are not listed.

## 4. Budgeted model trials (`node harness/models.mjs --max-tokens 1024`)

| Model | Task | Result | Seconds | Time to first action | Tool calls | Cost |
|---|---|---|---:|---:|---:|---:|
| DeepSeek v4.1 Flash (`deepseek/deepseek-v4.1-flash-1017`) | form | PASS | 4.2 | 1.04 s | 3 | $0.00104 |
| DeepSeek v4.1 Flash (`deepseek/deepseek-v4.1-flash-1017`) | search | PASS | 5.5 | 0.62 s | 5 | $0.00098 |

The same run also tried other OpenRouter models; those requests were refused by the account's model settings (HTTP 404) before any browser work, so they produced no results.

## 5. Broad site suite (`node harness/broad.mjs`, headless)

| Suite | Total | Pass | Fail | Blocked by site |
|---|---:|---:|---:|---:|
| Local fixture cases | 37 | 35 | 2 | 0 |
| Live public sites | 55 | 51 | 1 | 3 |

Local failures: `video-play-pause` (the test video stayed paused) and `long-page-scroll-end` (the footer was not in the viewport snapshot). Live failure: `github-tree-spa` (timed out waiting for the file page URL). Blocked: `reddit-old`, `ebay-browse` and `amazon-browse` returned pages without the expected listings to a headless browser.

## 6. Unit and security tests (`node --test test/*.test.mjs`)

149 tests, 135 pass, 14 fail (Nov 15, 2026). The 14 failures all trace to `extension/options.html` being missing from this build: the 12 extension security tests stop in setup waiting for the options page, plus the banner copy test and the settings defaults test. This is a known gap, not hidden here.

### Schema and behaviour fixes made while validating
| Seen in | Problem | Fix |
|---|---|---|
| Gemini, DeepSeek | Copied refs as `"[e1]"` | `[e1]`, `@e1` and `ref: e1` are all accepted |
| Gemini, Grok Bot | `waitNav:true` on a button that doesn't navigate burned 15 s | `navigated:false` after 1.5 s |
| Gemini | Guessed CSS and got a bare timeout | Failed steps always attach a compact snapshot |
| Grok Bot | A ref from the previous page waited 5 s | Stale refs fail at once with a "take a fresh snapshot" hint |
| Grok Bot, DeepSeek | `{for:'idle'}` / `{state:'visible'}` alone rejected | Wait aliases; a bare wait settles on page load |
| DeepSeek | `browser_parallel` opened unexpected tabs | Clearer description, `close:true`, `browser_tabs close` takes `tabs[]` |
| Gemini | Retried a security refusal in other ways | Tool descriptions state that "Blocked by your Luculent security settings" is final |
| Codex | Its own bundled browser plugin was picked | Harness disables the bundled browser and computer-use plugins |
| Codex | "MCP tool call requires approval" in `codex exec` | Per-tool `approval_mode="approve"` |
