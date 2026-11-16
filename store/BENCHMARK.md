# Benchmark stat sheet - Luculent Browser Driver for AI Agents vs Playwright MCP

All numbers are real measurements from `npm run bench -- --iters 7` (`bench/bench.mjs`), saved to `bench/results.json`.
Run: Nov 15, 2026, 9:52 PM PT, on a desktop PC (AMD Ryzen 5 5500, 32 GB, Windows 11, Node 24.19), at normal
priority with other jobs running (about 50% CPU load). Median of 7 runs after 1 warm-up. **Default security settings
on** (password guard, banking preset, JavaScript/cookies off, uploads ask first), except the per-key rate limit, raised
so the per-action flow can fire 7 calls in under 0.2 s.

## Headline numbers
Both drivers drive headless Chrome over MCP stdio on the same local pages.

| Test | Luculent Browser Driver | Playwright MCP 0.0.85 | Difference |
|---|---|---|---|
| 7-action sign-up form (Luculent: all steps in one call) | **131 ms** | 1,748 ms | **13x faster** |
| Same form, one call per action | **165 ms** | 1,748 ms | **10x faster** |
| 4-action search (Luculent: all steps in one call) | **163 ms** | 1,115 ms | **6.8x faster** |
| Same search, one call per action | **168 ms** | 1,115 ms | **6.6x faster** |
| Time per tool call, form (median) | **5.9 ms** | 45.3 ms | **7.6x faster** |
| Time per tool call, search (median) | **25.9 ms** | 505.6 ms | **19x faster** |
| Tool calls to finish the form | **1** | 7 | **6 fewer** |
| Data the agent reads, form | **0.8 KB** | 4.0 KB | **5x less** |
| Data the agent reads, search | **0.4 KB** | 2.4 KB | **6x less** |
| Cold start, new MCP server to first page loaded | **522 ms** | 774 ms | **1.4x faster** |

Store-safe claims (rounded down): "Up to 13x faster than Playwright MCP on the same form", "5x less data for the model
to read".

## Full results
| Driver | Form batched | Form per-action | Median ms/call (form / search) | Form bytes (batched / per-action) | Search batched | Search per-action | Search bytes (batched / per-action) | Cold start |
|---|---|---|---|---|---|---|---|---|
| LBD headless (MCP stdio) | 131 ms | 165 ms | 5.9 / 25.9 | 0.8 KB / 2.6 KB | 163 ms | 168 ms | 0.4 KB / 1.5 KB | 522 ms |
| LBD extension, your own Chrome tab (MCP stdio) | 177 ms | 237 ms | 14.4 / 35.6 | 0.8 KB / 2.6 KB | 178 ms | 193 ms | 0.4 KB / 1.5 KB | - |
| Playwright MCP headless (MCP stdio) | - (no batching) | 1,748 ms | 45.3 / 505.6 | - / 4.0 KB | - | 1,115 ms | - / 2.4 KB | 774 ms |

Playwright MCP has no extension mode in this harness, so the own-tab row has no Playwright comparison.

Earlier runs: Nov 14, 2026 (same machine, Idle priority) gave 131 ms batched headless, 154 ms per-action, 159 ms in
the extension, and 1,766 ms / 1,121 ms for Playwright MCP form / search. Nov 13 (before the security checks and the
post-click settle step were added) gave 96 ms batched headless and 150 ms in the extension.

## Earlier transport comparison (Nov 14, 2026, `harness/compare.mjs`)
Published earlier in this file; kept for reference. Same fixture pages; Luculent over each transport and Playwright MCP.

| Driver / Transport | Cold startup | Form batched (p50 / p95) | Form per-action (p50 / p95) | Form reqs | Form bytes | Search batched (p50 / p95) | Search per-action (p50 / p95) | Search reqs | Search bytes | Ratio vs LBD matched |
|---|---:|---|---|---|---|---|---|---|---|---|
| LBD extension, real tab (MCP stdio, provisional baseline) | 145 ms | **159 ms** / - | 213 ms / - | 1 / 7 | 0.8 KB / 2.8 KB | **174 ms** / - | 196 ms / - | 1 / 4 | 0.4 KB / 1.5 KB | 1.0x |
| LBD extension, real tab (MCP stdio, 7-run p50/p95) | 145 ms | **184 ms** / 186 ms | 247 ms / 259 ms | 1 / 7 | 1.3 KB / 4.0 KB | **180 ms** / 182 ms | 186 ms / 191 ms | 1 / 4 | 0.7 KB / 2.3 KB | 1.0x |
| LBD headless (MCP stdio, 7-run p50/p95) | 452 ms | **132 ms** / 141 ms | 167 ms / 170 ms | 1 / 7 | 1.3 KB / 3.9 KB | **152 ms** / 154 ms | 160 ms / 173 ms | 1 / 4 | 0.7 KB / 2.2 KB | 1.0x |
| LBD extension, real tab (MCP HTTP `/mcp`) | 25 ms | **188 ms** / 235 ms | 293 ms / 314 ms | 1 / 7 | 1.3 KB / 3.9 KB | **182 ms** / 183 ms | 206 ms / 209 ms | 1 / 4 | 0.7 KB / 2.2 KB | 1.02x |
| LBD extension, real tab (Direct HTTP `/v1/rpc`) | 3 ms | **234 ms** / 252 ms | 337 ms / 370 ms | 1 / 7 | 1.3 KB / 4.7 KB | **192 ms** / 202 ms | 229 ms / 235 ms | 1 / 4 | 0.7 KB / 2.8 KB | 1.27x / 1.07x |
| LBD extension, real tab (WebSocket `/v1/ws`) | 3 ms | **209 ms** / 223 ms | 297 ms / 329 ms | 1 / 7 | 1.3 KB / 4.8 KB | **189 ms** / 195 ms | 213 ms / 217 ms | 1 / 4 | 0.8 KB / 2.8 KB | 1.13x / 1.05x |
| Playwright MCP 0.0.85 headless (MCP stdio) | 802 ms | Unsupported | **1,766 ms** / 1,782 ms | 7 | 5.0 KB | Unsupported | **1,122 ms** / 1,134 ms | 4 | 3.0 KB | **13.3x slower** (`form`), **7.4x slower** (`search`) |
| OpenCode Browse | - | Not installed on benchmark host | - | - | - | Not installed on benchmark host | - | - | - | *(blank until matched)* |
| Kimi Browser Extension | - | Incompatible (no MCP/HTTP driver API) | - | - | - | Incompatible (no MCP/HTTP driver API) | - | - | - | *(blank — incompatible)* |

## Method
* **Same pages, same machine, same transport.** A local fixture server (`test/fixtures.mjs`) serves the pages.
  Every driver is spawned as an MCP server over stdio and timed by the same client (`McpClient` in
  `bench/bench.mjs`) from request write to response parse. Model thinking time is excluded for everyone; no model
  is involved in any number on this page.
* **Form flow (7 actions):** navigate to /form, type name, type email, select plan, tick terms, click submit
  (waits for navigation), read the summary. Each run checks the server received the right submission and the
  summary text matches; a wrong result fails the run.
* **Search flow (4 actions):** navigate, type a query and submit, wait for the result text (rendered after a
  ~150 ms delay), read results.
* **Luculent Browser Driver:** `browser_run` with all steps in one call (`snapshot: none`), and again with one
  `browser_run` call per step (`snapshot: diff`, the response an agent normally reads). Headless = Chrome launched
  by the relay; extension = the unpacked extension in a separate Chrome for Testing profile, driving a tab that
  was already open (with "All tabs" granted, as a user would grant that tab).
* **Playwright MCP 0.0.85:** `--headless --isolated --browser chrome`, one call per action using the refs from
  its accessibility snapshots, as an agent would (`browser_navigate`, `browser_type`, `browser_select_option`,
  `browser_click`, `browser_evaluate`, `browser_wait_for`). Bytes include the snapshot text the agent has to read.
* **Time per tool call:** median over every individual call in the 7 timed runs. Playwright's search figure includes
  its `browser_wait_for` call, which waits for the delayed results; Luculent's per-step `wait` does the same.
* **Data the agent reads:** response payload size. Luculent is the single batched call; Playwright is the sum of
  its per-action responses, including snapshots.
* **Cold start:** spawn a brand-new MCP server process, initialize it, start a fresh headless Chrome and load
  `about:blank`, timed until that first navigation returns. Luculent: `lbd mcp` + `browser_headless launch` +
  `browser_run navigate` against an already running relay (the relay is a background service in normal use).
  Playwright MCP: process spawn + `browser_navigate`, which launches its browser. Median of 7 fresh starts after 1
  warm-up.
* **Medians** of 7 timed iterations after 1 warm-up per driver.
* **What is not measured:** Claude's and ChatGPT's browser agents run in their own clouds and can't be pointed at
  this local fixture with the model time removed, so no numbers are claimed for them. Model-driven end-to-end runs
  and other browser tools (for example OpenCode Browse) are not part of this benchmark. Real sites add network time
  for every driver equally.
* **OpenCode:** OpenCode 1.19.5 was used to check the setup, not the timing: it connected to Browser Driver as a
  local MCP server using the configuration on the Browser Driver page (`opencode mcp list` shows `browser
  connected`).

Reproduce: `npm install && npx playwright install chromium && npm run bench -- --iters 7`.