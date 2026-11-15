# Benchmark stat sheet - Luculent Browser Driver for AI Agents vs Playwright MCP

All numbers are real measurements from `npm run bench` (`bench/bench.mjs`), saved to `bench/results.json`.
Run: Nov 14, 2026, 12:06 AM PT, on a desktop PC (AMD Ryzen 5 5500, 32 GB, Windows 11, Node 24), at Idle CPU
priority with other jobs running. Median of 7 runs after 1 warm-up. **Default security settings on** (password
guard, banking preset, JavaScript/cookies off, uploads ask first), except the per-key rate limit, raised so the
per-action flow can fire 7 calls in under 0.2 s.

## Headline numbers
| Flow | Luculent Browser Driver | Playwright MCP 0.0.85 | Speed-up |
|---|---|---|---|
| 7-action sign-up form, batched in 1 call (headless) | **131 ms** | n/a (no batching) | **13x faster** (13.5x) than Playwright's 1,766 ms |
| Same form, batched, driving a real tab through the extension | **159 ms** | n/a | **11x faster** |
| Same form, one MCP call per action (headless) | **154 ms** (8 ms median per call) | 1,766 ms (52 ms median per call) | **11x faster** |
| 4-action search flow (results render after a ~150 ms delay in both), batched | **156 ms** | 1,121 ms per action | **7x faster** |
| Data the agent has to read for the form | **0.8 KB** batched / 2.7 KB per action | 4.0 KB | **5x less** |

Store-safe claims (rounded down): "Up to 13x faster than Playwright MCP on the same form", "11x faster in your own
Chrome tab", "5x less data for the model to read".

## Full results
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

Earlier runs on Nov 13 (before the security checks and the post-click settle step were added) gave 96 ms batched
headless and 150 ms in the extension (18x and 12x). The extra ~30 ms buys correct results on animated and
re-rendering pages (see `harness/RESULTS.md`).

## Method
* **Same pages, same machine, same transport.** A local fixture server (`test/fixtures.mjs`) serves the pages.
  Every driver is spawned as an MCP server over stdio and timed by the same client (`McpClient` in
  `bench/bench.mjs`) from request write to response parse. Model thinking time is excluded for everyone.
* **Form flow (7 actions):** navigate to /form, type name, type email, select plan, tick terms, click submit
  (waits for navigation), read the summary. Each run checks the server received the right submission and the
  summary text matches; a wrong result fails the run.
* **Search flow (4 actions):** navigate, type a query and submit, wait for the result text, read results.
* **Luculent Browser Driver:** `browser_run` with all steps in one call (`snapshot: none`), and again with one
  `browser_run` call per step (`snapshot: diff`, the response an agent normally reads). Headless = Chrome launched
  by the relay; extension = the unpacked extension in a separate Chrome for Testing profile, driving a tab that
  was already open (with "All tabs" granted, as a user would grant that tab).
* **Playwright MCP 0.0.85:** `--headless --isolated --browser chrome`, one call per action using the refs from
  its accessibility snapshots, as an agent would (`browser_navigate`, `browser_type`, `browser_select_option`,
  `browser_click`, `browser_evaluate`, `browser_wait_for`). Bytes include the snapshot text the agent has to read.
* **Medians** of 7 timed iterations after 1 warm-up per driver; bytes are response payload sizes.
* **What is not measured:** Claude's and ChatGPT's browser agents run in their own clouds and can't be pointed at
  this local fixture with the model time removed, so no numbers are claimed for them. Real sites add network
  time for every driver equally.

Reproduce: `npm install && npx playwright install chromium && npm run bench -- --iters 7`.
