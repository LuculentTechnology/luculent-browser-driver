# Validation results - Luculent Browser Driver for AI Agents

## 1. Broad real-site and use-case suite (`node harness/broad.mjs`)

92 checks: 37 local fixture pages (`test/fixtures-broad.mjs`) and 55 live public sites, each checked against page
or server state. Live sites: the-internet.herokuapp.com, UI Testing Playground, DemoQA, TodoMVC (React, Vue,
Angular), Wikipedia, MDN, GitHub, Hacker News, Google Maps, YouTube, CodePen, old.reddit.com, eBay, Amazon.
No logins, no posting, no purchases, one pass at a time.

Runs: Nov 13-14, 2026 (PT), Chromium 158 headless, default security policy except where a case needs a capability
(the suite uses an open policy on test pages; the safe defaults are covered by the security tests below).

| | Total | Pass | Fail | Bot wall |
|---|---|---|---|---|
| Before (headless, Nov 13 10:50 PM PT) | 92 | 39 | 52 | 1 |
| After, headless (Nov 13 11:48 PM PT) | 92 | **89** | **0** | 3 |
| Extension initial run (Nov 13 11:59 PM PT) | 92 | 87 | 2 | 3 |
| Extension coverage including focused reruns | 92 | **89** | **0** | 3 |

The initial extension run had two failures under load, `cookie-banner-modal` and `long-page-scroll-end`. Both passed on focused reruns, and all 37 local fixtures passed. The coverage row combines that evidence with the initial run. A new full run on the release candidate is pending. The three extension bot-wall cases remain blocked.

### By category (before / after headless / extension initial run)
| Category | Before | Headless | Extension | Cases |
|---|---|---|---|---|
| iframes (incl. cross-origin) | 1/4 | 4/4 | 4/4 | iframe-same, iframe-cross-origin, ti-iframe-tinymce, ti-nested-frames |
| editors | 0/2 | 2/2 | 1/2 | contenteditable, codepen-editor-iframe (bot wall in ext run) |
| drag and drop | 0/5 | 5/5 | 5/5 | html5-drag, mouse-drag-slider, ti-drag-drop, ti-slider, demoqa-droppable |
| hover menus | 3/4 | 4/4 | 4/4 | hover-menu, ti-hovers, ti-jqueryui-menu, uitp-mouseover |
| date pickers | 3/3 | 3/3 | 3/3 | date-native, date-custom, demoqa-date-picker |
| selects / comboboxes | 3/3 | 3/3 | 3/3 | combobox, ti-dropdown, demoqa-react-select |
| modals / overlays | 3/5 | 5/5 | 4/5 | cookie-banner-modal, covered-click-warns, ti-entry-ad-modal, demoqa-modal, uitp-hiddenlayers |
| popups / new tabs | 1/4 | 4/4 | 4/4 | window-open-popup, target-blank-link, multi-tab-parallel, ti-windows |
| auth guard | 1/1 | 1/1 | 1/1 | auth-form-local |
| slow navigation / waits | 6/10 | 10/10 | 10/10 | slow submit/link/enter, lazy element, hn-front-new, ti-dynamic-loading, uitp load/ajax/client delay, progressbar |
| canvas / maps | 0/3 | 3/3 | 3/3 | canvas-xy-click, canvas-wheel, google-maps |
| video | 0/2 | 2/2 | 2/2 | video-play-pause, youtube-video |
| keyboard | 1/2 | 2/2 | 2/2 | keyboard-shortcuts, ti-key-presses |
| big tables | 2/5 | 5/5 | 4/5 | long-table-extract, long-page-scroll-end, wikipedia-table, ti-tables, ti-large-dom |
| infinite scroll | 1/3 | 3/3 | 3/3 | infinite-scroll, ti-infinite-scroll, uitp-scrollbars |
| forms | 4/6 | 6/6 | 6/6 | form-validation, ti-checkboxes, demoqa-text-box, demoqa-form-validation, uitp-textinput, uitp-overlapped |
| files (upload / download) | 3/3 | 3/3 | 3/3 | file-download, file-upload, ti-upload |
| PDF | 0/2 | 2/2 | 2/2 | pdf-open, pdf-live |
| permissions (geolocation) | 0/2 | 2/2 | 2/2 | geolocation-permission, ti-geolocation |
| SPA routing | 1/6 | 6/6 | 6/6 | spa-pushstate-nav, github-tree-spa, mdn-search, todomvc-react/vue/angular |
| history | 2/2 | 2/2 | 2/2 | back-forward, spa-back-forward |
| JS dialogs | 0/2 | 2/2 | 2/2 | js-dialogs, ti-js-alerts |
| shadow DOM | 2/3 | 3/3 | 3/3 | nested-shadow, ti-shadowdom, uitp-shadowdom |
| context menu | 1/2 | 2/2 | 2/2 | right-click, ti-context-menu |
| search + extract | 1/4 | 3/4 | 3/4 | wikipedia-search, github-repo, mdn-doc-extract, reddit-old (bot wall) |
| e-commerce browse | 0/2 | 0/2 | 1/2 | ebay-browse, amazon-browse (bot walls) |
| locators | 0/2 | 2/2 | 2/2 | uitp-dynamicid, uitp-nbsp |

### Bugs found and fixed
| Problem | Fix |
|---|---|
| Same-origin and cross-origin iframes unreachable | `frame` option on every step; out-of-process frames attached with `Target.setAutoAttach` |
| `window.open` / `target=_blank` popups lost | `expectPopup` switches to the new tab; extension grants popups opened by a granted tab (via `webNavigation`) |
| JS alert/confirm/prompt hung the page | `dialogs: accept|dismiss|manual` on `browser_run`, `browser_dialog` tool |
| No drag, wheel, canvas or slider input | `drag` (re-measures source and target), `wheel`, x/y offsets on clicks |
| Clicks landing during fade-in animations (entry ad, modals) | element must hold still ~1.5 s max before the click |
| React/Angular re-render races after typing or Enter (TodoMVC) | short idle settle after submits and same-document navigations |
| Waits matched the first hidden duplicate | `state: visible` considers every match unless a ref or `nth` is given |
| `role=...[name=/regex/]` unsupported; MDN results in shadow DOM | regex names and shadow-aware covered-element check |
| PDFs returned empty text | rewritten extractor with ToUnicode CMaps, hex strings and line breaks |
| HTTP test sites blocked in headless (`ERR_BLOCKED_BY_CLIENT`) | HTTPS-First auto mode disabled for the relay's own headless Chrome |
| Background tabs took ~5 s per mouse event | focus emulation on attach (now ~25 ms) |
| Video, tables, geolocation and permissions not scriptable | `media`, `table`, `geolocation`, `permissions` steps |
| Bot pages reported as failures | known robot-page titles and texts classified as "blocked" |

## 2. Test suite (`npm test`)
49/49 pass (Nov 14, 2026, 12:04 AM PT): driver end-to-end, extension end-to-end, 17 relay security tests and
12 extension security tests (pairing, ungranted tabs hidden, grant/revoke, popup inheritance, a rogue relay that
cannot reach ungranted tabs, upload approval, password guard, eval approval, audit log, killswitch, impostor relay).

## 3. Real model clients (`node harness/models.mjs`)
The same tasks run through each client against the real extension in a throwaway Chromium profile, each checked
against page or server state. Tasks: **form**, **search** (async results), **multitab**, **dynamic** (late content),
**upload**, **iframe** (cross-origin), **hover** (menu), **drag**, **popup** (new window), **guard** (the agent is
asked to type a password: it must be blocked and nothing submitted).

### Gemini free pool (keys 1-5, shared rotation), Nov 14, 2026, 12:13 AM PT: **10/10**
| Task | Result | Seconds | Tool calls | Model (key) |
|---|---|---|---|---|
| form | PASS | 5.4 | 3 | gemini-flash-lite-latest (key 1) |
| search | PASS | 8.8 | 5 | gemini-flash-lite-latest (key 1) |
| multitab | PASS | 3.0 | 1 | gemini-flash-lite-latest (key 1) |
| dynamic | PASS | 3.5 | 2 | gemini-flash-lite-latest (key 1) |
| upload | PASS | 9.5 | 2 | gemini-3.1-flash-lite (key 1), after two 429s rotated it on |
| iframe | PASS | 46.1 | 5 | gemini-3.1-flash-lite (key 1) |
| hover | PASS | 7.4 | 1 | gemini-3.1-flash-lite (key 1) |
| drag | PASS | 10.3 | 3 | gemini-3.1-flash-lite (key 1) |
| popup | PASS | 9.5 | 4 | gemini-3.1-flash-lite (key 1) |
| guard | PASS | 27.0 | 3 | gemini-3.1-flash-lite (key 1): password refused, nothing submitted |

Rotation fixes (the runs used to die on a model with no allowed calls instead of moving on):
* the model list now starts from the shared pool's preferred order (Gemma included), not a fixed 4-model list;
* any key- or model-level error (429 incl. limit 0, 403, 404, 5xx) cools that key+model and picks the next
  available one, across all 5 keys; an invalid key (401 or `API_KEY_INVALID`) skips that key entirely;
* a 400 caused by the request (for example a model without tool calling) is skipped for this run only, so it
  doesn't poison the shared cooldowns other jobs use;
* rotation helper errors are logged instead of silently reading as "all keys cooling".

### Earlier 5-task run (Nov 13, 2026)
| Client | form | search | multitab | dynamic | upload | Total |
|---|---|---|---|---|---|---|
| Codex CLI 0.164 (MCP over HTTP, bearer key) | PASS 16.5 s / 2 | PASS 15.5 s / 2 | PASS 14.8 s / 4 | PASS 11.9 s / 2 | PASS 19.3 s / 2 | **5/5** |
| Grok Bot (MCP over HTTP from a shell on the same PC; tool time only) | PASS 385 ms / 2 | PASS 290 ms / 1 | PASS 261 ms / 4 | PASS 173 ms / 2 | PASS 114 ms / 1 | **5/5** |
| DeepSeek v4.1 Flash (OpenRouter, now optional) | PASS 6.4 s / 3 | PASS 7.7 s / 3 | PASS 4.3 s / 1 | PASS 6.0 s / 4 | PASS 3.8 s / 2 | **5/5**, $0.0113 |

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

Reproduce: `node harness/models.mjs --models gemini,codex` (Gemini needs `LBD_STEWARD` pointing at a folder with the
rotation scripts and key file; Codex needs a logged-in Codex CLI).
