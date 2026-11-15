# Benchmark stat sheet - Luculent Browser Driver for AI Agents vs Playwright MCP

All numbers are real measurements from `npm run bench` (`bench/bench.mjs`), saved to `bench/results.json`.
Run: Nov 14, 2026, 12:06 AM PT, on a desktop PC (AMD Ryzen 5 5500, 32 GB, Windows 11, Node 24), at Idle CPU
priority with other jobs running. Median of 7 runs after 1 warm-up. **Default security settings on** (password
guard, banking preset, JavaScript/cookies off, uploads ask first), except the per-key rate limit, raised so the
per-action flow can fire 7 calls in under 0.2 s.

## Headline numbers
| Flow | Luculent Browser Driver | Playwright MCP 0.0.85 | Speed or size difference |
|---|---|---|---|
| 7-action sign-up form (headless) | **131 ms** (batched) | 1,766 ms (one call per action) | **13× faster** |
| Same form in an existing Chrome tab | **159 ms** (batched) | Not measured in extension mode | — |
| 4-action search flow (results render after a ~150 ms delay in both), batched | **156 ms** | 1,121 ms per action | **7x faster** |
| Data the agent has to read for the form | **0.8 KB** batched / 2.7 KB per action | 4.0 KB | **5x less** |

Store-safe claims (rounded down): "Up to 13× faster than Playwright MCP on the same headless form", "5× less data for the model to read". The existing-tab comparison requires a matched run.

## Full results
| Driver | Form batched | Form per-action | Median ms/call | Form bytes (per-action) | Search batched | Search per-action |
|---|---|---|---|---|---|---|
| LBD headless (MCP stdio) | 131 ms | 154 ms | 8.1 | 2.7 KB | 156 ms | 168 ms |
| LBD extension, real tab (MCP stdio) | 159 ms | 213 ms | 15.4 | 2.8 KB | 174 ms | 196 ms |
| Playwright MCP headless (MCP stdio) | - | 1,766 ms | 52.0 | 4.0 KB | - | 1,121 ms |

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
