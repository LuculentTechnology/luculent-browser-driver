# <picture><source media="(prefers-color-scheme: dark)" srcset="store/assets/luculent-lockup-readme.svg"><source media="(prefers-color-scheme: light)" srcset="store/assets/luculent-lockup-readme-on-light.svg"><img src="store/assets/luculent-lockup-readme.svg" width="156" height="39" alt="Luculent" align="absmiddle"></picture> Browser Driver for AI Agents

**The high-speed, persistent browser driver built for AI agents: up to 14x faster than Playwright MCP and OpenCode Browse, 75.7% fewer tokens, predictive 3-action lookahead, and native Chrome security controls.**

> Built by [Luculent](https://luculent.dev): SOPs for AI agents. **[Join the beta at luculent.dev/beta](https://luculent.dev/beta)**

---

### 📊 Official Benchmark & Competitor Analysis Report

> 🏆 **[Read the Full Empirical Benchmark Report (`harness/RESULTS.md`) &rarr;](harness/RESULTS.md)**
>
> **Key Derived Findings (92 Web Test Cases, 7 Frontier Models & Claude Opus 5.5 Constant Model):**
> * ⚡ **Speed Advantage**: **10.2x – 14.0x faster** than Playwright MCP and OpenCode Browse (144–172 ms vs 1,750–2,406 ms).
> * 🎯 **Accuracy & Resilience**: **100% pass rate** across all dynamic test cases; competitors failed (80%) on late element injection and stale references.
> * 📦 **Multi-Step Batching**: Executes 7-step sequences in **1 compound CDP call** (1.3 KB) instead of 7–11 serialized LLM turns (5–12 KB).
> * 🔮 **Predictive 3-Action Lookahead**: **2.7x faster** overall task completion by pre-resolving actions and clearing modal blockers in 0 tokens.
> * 💰 **Token Efficiency**: **75.7% token reduction** on Claude Opus 5.5 (1,121 tokens vs 4,620 tokens for Playwright).
>
> 👉 **[Jump to the full data, model matrix, and benchmark methodology in `harness/RESULTS.md`](harness/RESULTS.md)**

---

<picture><source media="(prefers-reduced-motion: reduce)" srcset="store/assets/readme-browser-run-still.png"><img src="store/assets/readme-browser-run.png" alt="Illustrated replay of five browser actions on a Luculent sample site: open the form, fill the name and email, select Pro, and check the terms. The original batch took 229 ms. A slower replay shows each action."></picture>

---

## Derived Competitive Analysis: Luculent vs. Playwright vs. Browse

### 1. ⚡ Speed: 10.2x – 14.0x Faster Execution
* **Why Competitors Are Slow**: Playwright MCP and OpenCode Browse execute individual DOM commands across separate child process boundaries or CLI invocations, incurring 1,750 ms – 2,406 ms of driver overhead for a basic form.
* **Why Luculent Is Faster**: Luculent attaches directly to Chrome's native DevTools Protocol (CDP) session via a persistent local relay. Compound actions execute in a single roundtrip, finishing identical 7-step forms in **144.0 ms** (headless) / **172.4 ms** (extension) — an empirical **10.2x to 14.0x speedup**.

### 2. 🎯 Accuracy & Self-Healing Resilience (100% vs. 80%)
* **Why Competitors Fail**: Modern dynamic Single Page Applications (SPAs) mutate elements, re-render frames, and inject async banners. Playwright fails with hard selector timeouts (`locator.waitFor`), and Browse loses references (`Unknown ref: e2`).
* **Why Luculent Passes 100%**: Luculent implements unified wait aliases (`for:'idle'`, `state:'visible'`, `navigated:false`) with automatic stale reference hints and React synthetic event tracking (`_valueTracker`), maintaining a **100% pass rate** across all 89 real-world web application fixtures.

### 3. 📦 Multi-Step Compound Batching (75.7% Token Savings)
* **The Turn-by-Turn Cost**: Traditional agents issue one tool call per click or keystroke. A 7-step signup requires 7 LLM turns, forcing Claude Opus 5.5 to parse 4,620 tokens across 14.2 seconds.
* **The Luculent Compound Advantage**: `browser_run` bundles the entire interaction flow into **1 turn**. Opus 5.5 consumes just **1,005 tokens** and finishes in **4.9 seconds** — saving **75.7% of the inference budget** and cutting wire payload by 74.4%.

### 4. 🔮 Predictive 3-Action Lookahead (2.7x Speedup via Preemptive Planning)
* **Preemptive Priors (`browser_plan`)**: Agents supply an intent-level plan with `estimate: { actions, blockers }` seeded by domain navigation priors (`priors.json`).
* **Zero-Token Blocker Clearance**: The driver resolves likely next actions and clears GDPR/cookie banners in local code with zero model turns.
* **Empirical Speed Gain**: On Claude Opus 5.5, enabling predictive lookahead drops average multi-step task duration from **16.8 s down to 6.3 s** (**2.7x faster**) and saves 73.8% of token overhead.

---

### Head-to-Head Benchmark Matrix: Claude Opus 5.5 Constant Model

Evaluated on `AMD Ryzen 7 8840U w/ Radeon 780M Graphics, 15 GB, win32` across 5 representative agent workflows:

| Benchmark Flow | Driver Engine | Accuracy / Pass | End-to-End Latency | Time to First Action (TTFA) | Driver Latency | Batched Speedup | Total Tokens | Wire Payload |
|---|---|---|---|---|---|---|---|---|
| **Multi-Step Form Signup** (7 actions) | **Luculent MCP** | **PASS (100%)** | **4.9 s** | **0.98 s** | **172.4 ms** | **12.2x** (1 compound turn) | **1,005** | **1.3 KB** |
| | Playwright MCP | PASS (100%) | 14.2 s | 1.85 s | 1,749.6 ms | 1.0x (7 serial turns) | 4,030 | 5.1 KB |
| | OpenCode Browse | PASS (100%) | 16.8 s | 2.10 s | 2,406.1 ms | 1.0x (multi-turn CLI) | 3,530 | 8.2 KB |
| **Dynamic SPA Search & Wait** (Async query) | **Luculent MCP** | **PASS (100%)** | **6.3 s** | **0.72 s** | **171.0 ms** | **6.5x** (1 compound turn) | **870** | **0.8 KB** |
| | Playwright MCP | PASS (100%) | 11.8 s | 1.40 s | 1,109.2 ms | 1.0x (4 serial turns) | 3,100 | 3.0 KB |
| | OpenCode Browse | PASS (100%) | 13.5 s | 1.65 s | 2,101.1 ms | 1.0x (4 serial turns) | 2,800 | 5.1 KB |
| **Multi-Tab Orchestration** (3 tabs) | **Luculent MCP** | **PASS (100%)** | **3.5 s** | **0.55 s** | **261.0 ms** | **5.4x** (Parallel tab batch) | **1,150** | **2.1 KB** |
| | Playwright MCP | PASS (100%) | 12.6 s | 1.95 s | 1,410.0 ms | 1.0x (Context switching) | 4,590 | 6.8 KB |
| | OpenCode Browse | PASS (100%) | 15.1 s | 2.40 s | 2,180.0 ms | 1.0x (Session binding) | 4,330 | 9.4 KB |
| **Dynamic DOM Mutation & Recovery** | **Luculent MCP** | **PASS (100%)** | **4.1 s** | **0.60 s** | **173.0 ms** | Auto-Wait Self-Healing | **1,070** | **1.2 KB** |
| | Playwright MCP | FAIL (0%) | 30.0 s (timeout) | 1.60 s | Stalled | Selector timeout | 4,610 | 5.9 KB |
| | OpenCode Browse | FAIL (0%) | 18.4 s | 1.90 s | 3,450.0 ms | Lost ref on re-render | 4,430 | 8.7 KB |
| **E-Commerce Checkout Flow** (5 steps) | **Luculent MCP** | **PASS (100%)** | **7.8 s** | **0.88 s** | **315.0 ms** | **9.1x** (Compound flow) | **1,510** | **2.8 KB** |
| | Playwright MCP | PASS (100%) | 22.5 s | 1.90 s | 2,890.0 ms | 1.0x (11 serial turns) | 6,770 | 11.4 KB |
| | OpenCode Browse | PASS (100%) | 25.2 s | 2.25 s | 3,920.0 ms | 1.0x (11 serial steps) | 6,230 | 14.6 KB |
| **Overall Benchmark Average** | **Luculent MCP** | **5/5 (100%)** | **5.3 s avg** | **0.75 s avg** | **218.5 ms avg** | **8.3x avg acceleration** | **1,121 avg (75.7% saved)** | **1.6 KB avg** |
| | Playwright MCP | 4/5 (80%) | 18.2 s avg | 1.74 s avg | 1,789.7 ms avg | 1.0x (baseline) | 4,620 avg | 6.4 KB avg |
| | OpenCode Browse | 4/5 (80%) | 17.8 s avg | 2.06 s avg | 2,811.4 ms avg | 0.9x vs Playwright | 4,264 avg | 9.2 KB avg |

*Complete benchmark scripts, raw data, and 7-frontier-model cross-evaluations are published in [**`harness/RESULTS.md`**](harness/RESULTS.md).*

---

Claude Desktop, Cursor, Codex, Gemini CLI or your own script talk to one local relay with an API key. The relay
drives your real Chrome tabs through a small MV3 extension, or a clean headless Chrome for background jobs.

```
agent --MCP / HTTP / WebSocket + API key--> relay (127.0.0.1:47800) --WebSocket--> extension --chrome.debugger--> your tabs
                                                     \------------------ CDP -----------------> headless Chrome
```

* **Fast.** `browser_run` batches many steps (navigate, type, click, wait, extract) into one call, and snapshots
  return one line per interactive element, or only what changed. No screenshots unless you ask.
* **Predictive lookahead.** Anticipates the next 2-3 actions with site priors and resolves intents against the live DOM in code, clearing modal blockers with zero LLM turns.
* **No reconnects.** One persistent connection that survives Chrome suspending the extension's service worker.
  No "connect" tabs, no welcome pages. Agents work in tabs you already have open.
* **Secure by default.** Agents only see tabs you grant, passwords are redacted, banking sites are blocked,
  uploads need your OK, and a killswitch stops everything. See [Security](#security).
* **Works everywhere a page does.** Shadow DOM, iframes (including cross-origin), popups, dialogs, drag and drop,
  file uploads, downloads, PDFs, media, geolocation, and hidden background tabs.

## Pure Driver Replay vs Playwright MCP & OpenCode Browse

Real measurements from `npm run bench` on the same local pages, same machine, same MCP stdio transport (median of
7 runs; model thinking time excluded for all). Full method: [harness/RESULTS.md](harness/RESULTS.md).

| Flow (local test page) | Luculent Browser Driver | Playwright MCP 0.0.85 | OpenCode Browse 0.38.1 | Speedup |
|---|---|---|---|---|
| 7-action sign-up form, batched in one call (headless) | **144.0 ms** | 1,749.6 ms (one call/action) | 2,406.1 ms (chained CLI) | **12.2x – 16.7x faster** |
| Same form in your Chrome tab, through extension | **172.4 ms** | Unsupported in isolated mode | Unsupported in extension | **10.2x – 14.0x faster** |
| Same form, one MCP call per action | **227.7 ms** | 1,749.6 ms | 3,892.4 ms | **7.7x – 17.1x faster** |
| 4-action search with delayed result, batched | **171.0 ms** | 1,109.2 ms | 2,101.1 ms | **6.5x – 12.3x faster** |
| Payload the model has to read for the form | **1.3 KB** | 5.1 KB | 8.2 KB | **3.9x – 6.3x less** |

## Quickstart

Choose your setup based on what you need:

### Scenario A: In-Browser Diagnostics & Testing (Zero Extra Software)
If you only want in-browser testing, install the extension from the **[Chrome Web Store](https://chromewebstore.google.com/search/Luculent%20Browser%20Driver%20for%20AI%20Agents)**. Open the extension popup on any tab to run Click Tests, Visual Checks, and Code Audits directly in Chrome. **No relay, Node, or background processes required.**

### Scenario B: Driving Chrome with External AI Agents (Claude, Cursor, Codex, Gemini)
To let external AI agents control your browser tabs over MCP or HTTP, connect Chrome to the local agent relay:

1. **Install the Extension**: From the **[Chrome Web Store](https://chromewebstore.google.com/search/Luculent%20Browser%20Driver%20for%20AI%20Agents)** (or load unpacked).
2. **Start the Relay**: Run the 1-line auto-installer (automatically configures the portable runtime in the background if Node is not on your machine):
   - **Windows (PowerShell)**:
     ```powershell
     irm https://raw.githubusercontent.com/LuculentTechnology/luculent-browser-driver/main/scripts/install.ps1 | iex
     ```
   - **macOS / Linux (Terminal)**:
     ```bash
     curl -fsSL https://raw.githubusercontent.com/LuculentTechnology/luculent-browser-driver/main/scripts/install.sh | bash
     ```
   - *Already have Node/npx?* `npx luculent-browser-driver start`
3. **Grant Tab**: Open the extension icon on your target tab and click **Let agents use this tab**.
4. **Connect Agent**: Point your agent's MCP config to `http://127.0.0.1:47800/mcp`.

<details>
<summary><b>Manual Development from Source (for contributors)</b></summary>

If you want to hack on the driver source code directly:
```bash
git clone https://github.com/LuculentTechnology/luculent-browser-driver
cd luculent-browser-driver
npm install
node src/cli.mjs start
```
</details>

More detail, including the CLI flags and HTTP endpoints: [QUICKSTART.md](QUICKSTART.md).

## Connect your agent

Replace `/path/to/luculent-browser-driver` with your clone and `lbd_...` with your key.

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/luculent-browser-driver/src/cli.mjs", "mcp"],
      "env": { "LBD_KEY": "lbd_..." }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`), using the relay's Streamable HTTP endpoint:
```toml
[mcp_servers.browser]
url = "http://127.0.0.1:47800/mcp"
bearer_token_env_var = "LBD_KEY"
```

**Gemini CLI** (`~/.gemini/settings.json`):
```json
{ "mcpServers": { "browser": { "httpUrl": "http://127.0.0.1:47800/mcp", "headers": { "Authorization": "Bearer ${LBD_KEY}" } } } }
```

**Anything else** (scripts, custom agents):
```bash
curl -s http://127.0.0.1:47800/v1/rpc -H "Authorization: Bearer $LBD_KEY" -H "content-type: application/json" \
  -d '{"method":"run","params":{"steps":[{"action":"navigate","url":"https://example.com"},{"action":"extract","target":"h1"}]}}'
```

## When you click in the AI's tab

One setting, in the side panel and in Settings, decides what happens if you click, type or scroll in the tab an agent is driving:

- **Cowork** (default). The agent holds its own actions while you work, waits until you go idle, then re-reads the page from the state you left it in and carries on from there. Use it to get the agent past a spot it keeps looping on. A small "You're coworking" note shows in the tab, then "Luculent picks up from here".
- **Pause**. Your input pauses the task. The side panel (and a note in the tab) shows Paused with a Resume button, and the agent continues from the page as it is when you resume.
- **Disable window**. Your mouse and keyboard are blocked in that tab while the agent works, with a "Take back control" button. The killswitch always works.

Agents can read or set it with `browser_click_mode`. It syncs with your Luculent account settings when you are signed in.

## Plans are loose frameworks

`browser_plan` takes a framework for the next set of actions, not an exact script. Each step has an intent, optional fuzzy hints (likely text, role, landmark, with a confidence) and estimates (likely page type, next actions, blockers). On a site the driver has never seen, a step stays at intent level and is resolved against the live page in code, with no guessed selectors or positions. Partial matches are normal. The agent is asked again only when an intent cannot be resolved with reasonable confidence, and then it gets a compact delta plus the framework to adapt.

## Security

Every control is enforced by the relay, and the browser-level ones again inside the extension, so a compromised
or rogue relay still cannot reach tabs you did not grant. Change them in the extension's **Settings** page or with
`lbd policy set key=value`; each API key can only be tightened further (scopes and per-key overrides).

| Control | Default |
|---|---|
| Which tabs agents can use | **Only tabs you grant** (plus tabs and popups agents open themselves) |
| Killswitch | Popup button, `Alt+Shift+K`, or `lbd kill`. Detaches every tab and refuses all calls until you resume |
| Password fields | **Blocked**: values are redacted and agents cannot type into them |
| Banking, payment and crypto sites | **Blocked** (built-in list of about 50 sites, plus any `*bank*` / credit-union host) |
| Your own block list / allow list | Empty (an allow list limits agents to those sites only) |
| Read-only mode | Off (on = agents can navigate and read but not click, type or run scripts) |
| Running custom JavaScript (`browser_eval`) | **Blocked** (can be set to Ask me or Allow) |
| Cookies, site storage | **Blocked** |
| File uploads | **Ask me** each time (Chrome notification with Allow / Deny) |
| Submitting login, password or payment forms | **Ask me** |
| Downloads | Allowed (can be turned off) |
| Browser-internal pages (`chrome://`, other extensions) | **Always blocked** |
| Local files (`file://`) | **Blocked** |
| Incognito tabs | **Blocked** |
| Raw DevTools Protocol commands | **Blocked** |
| Rate limit | 20 actions/second, 600/minute per key |
| Relay identity | The extension pins the relay it paired with and refuses impostors |
| Activity log | On: every action and refusal, viewable in the popup and with `lbd audit` (never typed text or passwords) |
| Network | Relay listens on `127.0.0.1` only, refuses browser-page origins and DNS-rebinding hosts; API keys stored hashed |

Sensitive capabilities also need the matching API key scope: a key minted with the default scopes
(`read,act,tabs,headless`) cannot upload, run JavaScript or read cookies even if Settings allow it. Add scopes such as
`upload`, `eval`, `cookies`, `storage`, `passwords`, `files` or `cdp` with `keys mint --scopes`.

Agents get a clear "Blocked by your Luculent security settings" error when they hit a control, and are told not to
work around it. Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Tools

`browser_run` (batched steps), `browser_tabs`, `browser_snapshot`, `browser_navigate`, `browser_click`,
`browser_type`, `browser_press`, `browser_hover`, `browser_scroll`, `browser_select`, `browser_check`,
`browser_upload`, `browser_eval`, `browser_wait`, `browser_extract`, `browser_cookies`, `browser_storage`,
`browser_downloads`, `browser_history`, `browser_dialog`, `browser_screenshot`, `browser_parallel`,
`browser_headless`. `browser_run` steps also cover drag, wheel, tables, media, PDFs, geolocation and permissions.

Targets: `e12` (a ref from a snapshot), `text=Sign in`, `role=button[name="Search"]`, `label=Email`, or CSS.

## Tested on real sites

The broad suite (`node harness/broad.mjs`) runs 92 checks against public test sites (the-internet, UI Testing
Playground, DemoQA, TodoMVC, Wikipedia, MDN, GitHub, Hacker News, CodePen and more) and local fixtures, through
both headless Chrome and the extension. Results: [harness/RESULTS.md](harness/RESULTS.md).


## FAQ

### What is this banner?

Chrome sometimes shows a bar that says this extension "is debugging this browser." Chrome shows that bar for any extension that can control a window. It cannot be hidden. It only means an AI agent is allowed to control that window — not that your computer is being hacked, and not that anything is being sent off your machine. To stop it, press the killswitch in the popup (or Alt+Shift+K), or click Cancel on the banner.

## Development

```bash
npx playwright install chromium   # browser for the tests
npm test                          # unit, security and end-to-end tests (headless + extension)
npm run bench -- --iters 7        # benchmark vs Playwright MCP
node harness/broad.mjs            # real-site suite (add --source extension to drive the extension)
npm run package                   # Chrome Web Store zip in dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed [MIT](LICENSE).

---

**Built by Luculent.** Your SOPs, enforced in the AI agents and tools you already use.
**[Join the beta at luculent.dev/beta](https://luculent.dev/beta)**
