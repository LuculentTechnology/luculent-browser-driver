# Chrome Web Store listing - Luculent Browser Driver for AI Agents

**Name (from manifest, 37 of 75 chars):** Luculent Browser Driver for AI Agents
**Short name (toolbar, 15 chars):** Luculent Driver

**Short description / summary (from manifest, 122 of 132 chars):**
Let any AI agent drive Chrome via API/MCP — fast, secure, no reconnects. Killswitch, per-tab grants, password guard. Free.

SEO notes: the name carries the main search terms ("browser", "AI agents", "driver"); the summary adds "AI agent",
"Chrome", "API", "MCP", "secure" and "free". Avoid naming other companies' products in the name or summary (store
policy on keyword stuffing and trademarks); they appear once each in the detailed description.

**Category:** Developer Tools  **Language:** English  **Price:** Free

**Detailed description:**

Luculent Browser Driver for AI Agents lets the AI agents you already use drive your own Chrome: open pages, click,
type, fill forms, read the page, upload files and run multi-step flows. It is built for speed, and you decide
exactly what agents may do.

Why it is fast
• Measured: a 7-step sign-up form in 131 ms, up to 13x faster than Playwright MCP on the same page and machine
  (method: https://github.com/dProFoSho/luculent-browser-driver/blob/main/store/BENCHMARK.md).
• One persistent connection. No "connect" tabs, no reconnect dance every time an agent starts.
• Batched actions: an agent sends a whole sequence (navigate, type, click, wait, extract) in one call.
• Compact page snapshots and diffs instead of screenshots, so agents read less and act sooner.
• Handles real sites: iframes (including cross-origin), shadow DOM, popups, dialogs, drag and drop, uploads,
  downloads, PDFs and background tabs.

Works with any agent
• Built-in MCP server (stdio and HTTP) for Claude Desktop, Cursor, Codex, Gemini CLI and other MCP clients.
• Plain HTTP and WebSocket API for your own scripts.
• Optional headless Chrome for background automation.

Secure by default
• Agents only see the tabs you grant (plus tabs they open themselves). An "AI" badge marks every controlled tab.
• Killswitch in the popup or Alt+Shift+K stops every agent and releases every tab.

What is this banner? Chrome's yellow "is debugging this browser" bar: Chrome sometimes shows a bar that says this extension "is debugging this browser." Chrome shows that bar for any extension that can control a window. It cannot be hidden. It only means an AI agent is allowed to control that window — not that your computer is being hacked, and not that anything is being sent off your machine. To stop it, press the killswitch in the popup (or Alt+Shift+K), or click Cancel on the banner.
• Password fields are off limits; banking, payment and crypto sites are blocked; custom scripts, cookies and site
  storage are off; file uploads and login or payment form submits ask you first.
• Your own block list, allow list and read-only mode. Browser-internal pages and other extensions are never
  touched. Incognito is off unless you turn it on.
• Every agent needs its own API key; keys can be limited to sites and capabilities, set to expire and revoked.
• Activity log in the popup shows every action and refusal.
• Everything runs on your computer. The extension only talks to the Luculent relay on 127.0.0.1 and refuses an
  impostor relay. There are no accounts and no advertising or third-party analytics. Optional structural navigation metadata (domain, generalized path, page type, element role/selector pattern, action sequence, plan match, timings — never page text, form values, passwords, cookies, query strings, sign-in pages, banking sites, or incognito) can be sent to Luculent to improve preemptive navigation. It is on by default except in the EU/EEA/UK, where it is off unless you turn it on. You can change this in Settings. Full disclosure: https://privacy.luculent.dev/policy

Setup takes two minutes: install the extension, enable the optional fully local MCP relay in Luculent Desktop (bundled runtime, no separate Node install needed) or run the free open-source relay (Node), mint a key and paste it
into your agent. Instructions: https://github.com/dProFoSho/luculent-browser-driver

Free and open source (MIT). Built by Luculent: your SOPs, enforced in the AI agents you already use.
Join the beta: https://luculent.dev/beta

**Privacy policy URL:** https://privacy.luculent.dev/policy#browser-driver (company policy, Browser Driver section; draft in `store/PRIVACY.md`, consent copy in `store/CONSENT.md`. Do not publish from this repo.)
**Homepage URL:** https://luculent.dev/beta
**Support URL:** https://github.com/dProFoSho/luculent-browser-driver/issues

**Single purpose (for review):** Let the user's own AI agents control tabs in this browser through a local,
API-key-protected relay on the user's computer, within security limits the user sets.

**Permission justifications:** see `store/PERMISSIONS.md`.

> Public repo (approved): https://github.com/dProFoSho/luculent-browser-driver (MIT). Another executor is creating it.
> Chrome Web Store single-purpose / Limited Use: command data stays on the user's computer and with the agents they
> authorize. Optional navigation metadata is disclosed above and in the privacy policy; it is limited to product
> improvement of the driver, never sold, never used for ads.
