# Luculent Browser Driver for AI Agents - Quickstart

Let any agent (Claude, Cursor, Codex, Gemini CLI, your own scripts) drive Chrome through one local relay with an
API key. One persistent connection, no connect or welcome tabs, batched actions, compact snapshot diffs.

```
agent --MCP/HTTP/WS + API key--> relay (127.0.0.1:47800) --WebSocket--> extension --chrome.debugger--> your tabs
                                          \--------------- CDP ---------------> headless Chrome (background jobs)
```

## 1. Install (once)

The Chrome extension itself does not use Node. Running the local relay for external HTTP and MCP clients currently requires Node 20+.

```bash
git clone https://github.com/dProFoSho/luculent-browser-driver
cd luculent-browser-driver
npm install
```

### Load the extension into Chrome
Install **Luculent Browser Driver for AI Agents** from the Chrome Web Store, or load it unpacked:
1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension` folder.
3. Pin **Luculent Driver**. The badge shows nothing when connected, `off` when the relay is down and `STOP` after
   the killswitch. Tabs agents control show an **AI** badge.

The unpacked build has a fixed ID (`oddcfadbpoapebpdmfbggiiibpbcpdoo`) that the relay trusts by default. For
another build, add its ID with `LBD_EXTENSION_IDS=<id>`.

Want a throwaway browser instead of your main profile? `node src/cli.mjs chrome` opens a separate Chromium profile
with the extension already loaded (uses Playwright's Chromium; branded Chrome 137+ blocks `--load-extension`).

## 2. Start the relay

```bash
node src/cli.mjs start        # foreground
node src/cli.mjs status       # is the extension connected?
```

The first time the extension connects it pairs with this relay and remembers its identity; it refuses any other
program that later pretends to be the relay.

## 3. Mint an API key (one per agent)

```bash
node src/cli.mjs keys mint --name my-agent --scopes read,act,tabs,headless
node src/cli.mjs keys list
node src/cli.mjs keys revoke my-agent
```

* The key (`lbd_...`) is shown once. Keys are stored hashed in `~/.luculent/browser-driver/keys.json` (override the
  folder with `LBD_HOME`), never in the repo.
* Scopes: `read` (list tabs, snapshot, extract, screenshot, wait), `act` (navigate, click, type, select),
  `tabs` (open, close, focus), `headless` (background Chrome), and the sensitive `upload`, `eval`, `cookies`,
  `storage`, `passwords`, `files`, `cdp`, `admin`. Sensitive scopes only work if your security settings allow them too.
* `--origins example.com,*.github.com` limits a key to those sites. `--days 30` makes it expire.

## 4. Grant tabs

Agents only see tabs you grant. Open the extension popup on a tab and choose **Let agents use this tab**; revoke it
from the same place. Tabs and popups an agent opens itself are granted automatically. To let agents use every tab,
set **Which tabs** to **All tabs** in Settings (`lbd policy set grantMode=all`).

## 5. Security settings

Open **Settings** from the popup, or use the CLI:

```bash
node src/cli.mjs policy                          # show current settings
node src/cli.mjs policy set uploads=allow        # deny | confirm | allow
node src/cli.mjs policy set readOnly=true
node src/cli.mjs policy set blocklist=example.com,*.example.org
node src/cli.mjs policy set perMinute=120
node src/cli.mjs policy reset                    # back to the safe defaults
node src/cli.mjs pending                         # actions waiting for your approval
node src/cli.mjs approve <id>                    # or: deny <id>
node src/cli.mjs audit --n 50                    # recent actions and refusals
```

Defaults: only granted tabs, passwords blocked, banking and payment sites blocked, custom JavaScript, cookies and
storage blocked, uploads and sensitive form submits ask you first, `chrome://` and `file://` blocked, incognito
off, 20 actions per second. The full table is in the [README](README.md#security).

## 6. Killswitch

* Extension popup **Killswitch**, or `Alt+Shift+K`: detaches every tab and refuses all calls.
* `node src/cli.mjs kill` does the same from a terminal; `node src/cli.mjs resume` re-enables control.
  The killswitch survives relay restarts.

## 7. What is this banner?

Chrome sometimes shows a bar that says this extension "is debugging this browser." Chrome shows that bar for any extension that can control a window. It cannot be hidden. It only means an AI agent is allowed to control that window — not that your computer is being hacked, and not that anything is being sent off your machine. To stop it, press the killswitch in the popup (or Alt+Shift+K), or click Cancel on the banner.

## 7. Connect an agent

### Any MCP client over stdio (Claude Desktop, Cursor, Gemini CLI, Codex)
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

### MCP over HTTP (Streamable HTTP)
`POST http://127.0.0.1:47800/mcp` with `Authorization: Bearer lbd_...`.

**Codex CLI** (`~/.codex/config.toml`):
```toml
[mcp_servers.browser]
url = "http://127.0.0.1:47800/mcp"
bearer_token_env_var = "LBD_KEY"
default_tools_approval_mode = "approve"
```
Some Codex versions still ask for approval in `codex exec`; add `[mcp_servers.browser.tools.browser_run]` with
`approval_mode = "approve"` for each tool you use. On Windows, if Codex reports "failed to spawn code-mode host",
its install path is too long: hard-link `codex.exe` and `codex-code-mode-host.exe` into a short folder.

**Gemini CLI** (`~/.gemini/settings.json`):
```json
{ "mcpServers": { "browser": { "httpUrl": "http://127.0.0.1:47800/mcp", "headers": { "Authorization": "Bearer ${LBD_KEY}" } } } }
```

### Plain HTTP / WebSocket (scripts, custom agents)
```bash
curl -s http://127.0.0.1:47800/v1/rpc -H "Authorization: Bearer $LBD_KEY" -H "content-type: application/json" \
  -d '{"method":"run","params":{"steps":[{"action":"navigate","url":"https://example.com"},{"action":"extract","target":"h1"}],"snapshot":"diff"}}'
```
WebSocket: `ws://127.0.0.1:47800/v1/ws` (Bearer header or `?key=`), messages `{id, method, params}` and replies
`{id, result | error}`.

### Agents in the cloud
A cloud agent cannot reach `127.0.0.1` on your computer. Either run its calls from a shell on that computer, or
expose only the relay's `/mcp` path through a tunnel you control (for example `cloudflared tunnel --url
http://127.0.0.1:47800`) and give the agent a dedicated key with only the scopes and `--origins` it needs. Revoke
it when you are done; the API key is the only gate.

## 8. Driving fast

* **Batch.** `browser_run` takes many steps in one call:
  ```json
  {"steps":[
    {"action":"navigate","url":"https://news.ycombinator.com"},
    {"action":"click","target":"text=new","waitNav":true},
    {"action":"extract","target":".titleline > a","all":true}
  ], "snapshot":"diff"}
  ```
* **Targets:** `e12` (ref from a snapshot), `text=Sign in`, `role=button[name="Search"]` (names can be
  `/regex/i`), `label=Email`, or CSS. Add `"frame": "iframe#editor"` to act inside an iframe.
* **Snapshots, not screenshots.** `browser_snapshot` returns one line per interactive element; `snapshot:"diff"`
  returns only what changed. Screenshots only when you ask.
* **Popups and dialogs.** `"expectPopup": true` on a click switches to the new tab; `browser_run` takes a
  `dialogs` setting (`accept` by default, `dismiss`, or `manual` to answer with `browser_dialog`).
* **More step types:** `drag`, `wheel`, `table`, `media`, `pdf`, `geolocation`, `permissions`, `upload`, `wait`.
* **Parallel.** `browser_parallel` runs jobs on several tabs at once.
* **Headless.** `browser_headless launch` starts a clean background Chrome for automation.

## 9. Tests and benchmark

```bash
npx playwright install chromium
npm test                          # unit, security and end-to-end tests (headless + extension)
npm run bench -- --iters 7        # vs Playwright MCP on identical local flows
node harness/broad.mjs            # 92 real-site and fixture checks (--source extension for the extension)
node harness/models.mjs --models gemini,codex   # real model clients driving the browser
```
