# <picture><source media="(prefers-color-scheme: dark)" srcset="store/assets/luculent-lockup-readme.svg"><source media="(prefers-color-scheme: light)" srcset="store/assets/luculent-lockup-readme-on-light.svg"><img src="store/assets/luculent-lockup-readme.svg" width="156" height="39" alt="Luculent" align="absmiddle"></picture> Browser Driver for AI Agents

**A fast, persistent browser driver for AI agents, with Chrome security controls built in.**

> Built by [Luculent](https://luculent.dev): SOPs for AI agents. **[Join the beta at luculent.dev/beta](https://luculent.dev/beta)**

---

### Benchmark results

Every number below comes from a run log committed to this repo. Full tables and logs: **[`harness/RESULTS.md`](harness/RESULTS.md)**.

* **Driver speed:** a 7-action sign-up form takes **131 ms** in one call with Luculent (headless) vs **1,748 ms** with Playwright MCP 0.0.85, on the same pages and machine (median of 7, no model involved).
* **Fewer calls, less to read:** the form is **1** tool call instead of 7, and the agent reads **0.8 KB** instead of 4.0 KB.
* **Real models:** DeepSeek v4.1 Flash and Codex CLI each passed **10/10** harness tasks (form, search, multitab, dynamic, upload, iframe, hover, drag, popup, guard). DeepSeek's 10 runs cost $0.0177 in total.
* **Broad suite:** 35/37 local fixture cases and 51/55 live public sites pass headless (3 of the 4 live misses were sites that block headless browsers).

---

<picture><source media="(prefers-reduced-motion: reduce)" srcset="store/assets/readme-browser-run-still.png"><img src="store/assets/readme-browser-run.png" alt="Illustrated replay of five browser actions on a Luculent sample site: open the form, fill the name and email, select Pro, and check the terms. The original batch took 229 ms. A slower replay shows each action."></picture>

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

## Driver speed vs Playwright MCP

Real measurements from `npm run bench` on the same local pages, same machine (AMD Ryzen 5 5500), same MCP stdio
transport, both headless. Median of 7 runs; no model is involved. Full method: [store/BENCHMARK.md](store/BENCHMARK.md).

| Flow (local test page) | Luculent Browser Driver | Playwright MCP 0.0.85 |
|---|---:|---:|
| 7-action sign-up form, all steps in one call | **131 ms** | 1,748 ms |
| Same form, one call per action | **165 ms** | 1,748 ms |
| Same form in your Chrome tab, through the extension | **177 ms** | not supported |
| 4-action search with a delayed result, one call | **163 ms** | 1,115 ms |
| Data the agent reads for the form | **0.8 KB** | 4.0 KB |
| Cold start, new server to first page | **522 ms** | 774 ms |

## Quickstart

The [v0.3.0 release](https://github.com/LuculentTechnology/luculent-browser-driver/releases/tag/v0.3.0) publishes two ZIPs:

| Asset | What it is |
| --- | --- |
| [`luculent-browser-driver-0.3.0.zip`](https://github.com/LuculentTechnology/luculent-browser-driver/releases/download/v0.3.0/luculent-browser-driver-0.3.0.zip) | The Chrome extension. Unzip it and load the folder unpacked at `chrome://extensions`. |
| [`luculent-local-relay-0.3.0-windows-x64.zip`](https://github.com/LuculentTechnology/luculent-browser-driver/releases/download/v0.3.0/luculent-local-relay-0.3.0-windows-x64.zip) | Optional, fully local Windows relay. It bundles its own Node runtime and an `lbd.cmd` launcher, so no Node or npm install is needed. It also contains the extension in `driver/extension`. |

A Chrome Web Store listing has not been verified for this release, so install the extension from the published ZIP.

Choose your setup based on what you need:

### Scenario A: In-Browser Diagnostics & Testing (Zero Extra Software)
If you only want in-browser testing, unzip [`luculent-browser-driver-0.3.0.zip`](https://github.com/LuculentTechnology/luculent-browser-driver/releases/download/v0.3.0/luculent-browser-driver-0.3.0.zip), open `chrome://extensions`, turn on **Developer mode** and click
**Load unpacked** on the unzipped folder. Open the extension popup on any tab to run Click Tests, Visual Checks, and Code Audits directly in Chrome. **No relay, Node, or background processes required.**

### Scenario B: Driving Chrome with External AI Agents (Claude, Cursor, Codex, Gemini)
To let external AI agents control your browser tabs over MCP or HTTP, connect Chrome to the local agent relay:

1. **Install the Extension**: Load it unpacked from a published ZIP (see the table above) or from the `extension`
   folder of a clone. The relay trusts the fixed ID of the `extension` folder and of `driver/extension` in the Windows
   relay ZIP. The standalone extension ZIP gets a different ID, so add it with `LBD_EXTENSION_IDS=<id>` if you use it
   with a relay.
2. **Start the Relay**:
   - **Option 1 (Windows, no Node install — Recommended)**: Download [`luculent-local-relay-0.3.0-windows-x64.zip`](https://github.com/LuculentTechnology/luculent-browser-driver/releases/download/v0.3.0/luculent-local-relay-0.3.0-windows-x64.zip), unzip it and run
     `.\lbd.cmd start` in PowerShell from that folder. The ZIP bundles the relay and its Node runtime, so nothing else
     needs to be installed. Load `driver/extension` from the same folder unpacked, then mint a key in a second window
     with `.\lbd.cmd keys mint --name my-agent --scopes read,act,tabs`. There is no `.exe` installer.
   - **Option 2 (Terminal Auto-Installer — for developers)**:
     - **Windows (PowerShell)**:
       ```powershell
       irm https://raw.githubusercontent.com/LuculentTechnology/luculent-browser-driver/main/scripts/install.ps1 | iex
       ```
     - **macOS / Linux (Terminal)**:
       ```bash
       curl -fsSL https://raw.githubusercontent.com/LuculentTechnology/luculent-browser-driver/main/scripts/install.sh | bash
       ```
   - **Option 3 (Existing Node / npx)**: `npx luculent-browser-driver start`
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
