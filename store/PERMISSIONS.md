# Permission justifications (Chrome Web Store "Privacy practices" tab)

| Permission | Why it is needed |
|---|---|
| `debugger` | Core function. The user's agents act on a tab (click, type, navigate, read the page, screenshot) through the Chrome DevTools Protocol. The extension attaches only to tabs the user has granted (or that an agent opened itself), checks every command against the user's security settings first, and detaches every tab when the killswitch is used. |
| `tabs` | List open tabs so an agent can pick a granted tab instead of opening new ones (tabs the user has not granted are listed without URL or title); open, focus or close a tab when an agent asks; show the "AI" badge on controlled tabs. |
| `webNavigation` | Detect that a popup or new tab was opened *by* a granted tab, so it can be granted too, while tabs the user opens themselves stay off limits. No browsing history is read or stored. |
| `storage` | Store the user's security settings, the paired relay's identity secret (local only), per-tab grants (kept across Chrome restarts by page URL), the killswitch state, and side-panel chat history. |
| `notifications` | Ask the user to approve sensitive actions (file uploads, submitting login or payment forms, running scripts) with Allow / Deny buttons. |
| `alarms` | Keep the connection to the local relay alive and reconnect silently after Chrome suspends the service worker. |
| `downloads` | Let an agent list downloads it triggered and wait for them to finish; cancel downloads started by an agent when the user has turned downloads off. |

* **Host permissions:** none requested. The service worker connects only to `ws://127.0.0.1:47800` (user-configurable to another local address).
* **Remote code:** none. All JavaScript ships in the package; the extension does not load or eval remote scripts. Page scripts it injects through CDP are bundled strings that run in the page to read its structure. Running an agent's own JavaScript is off by default and can only be enabled by the user.
* **Data use disclosures:** handles "website content", "user activity" and (only if the user allows it) "authentication information" solely to pass them to the agent the user connected on their own machine. Password field values are redacted by default. Not sold, not transferred to Luculent or third parties, not used for creditworthiness or advertising.
* **Single purpose:** let the user's own AI agents control tabs in this browser through a local, API-key-protected relay, within limits the user sets.

## Security controls (for the reviewer)
Enforced inside the extension for every DevTools command, independent of the relay:
per-tab grants (default: only tabs the user allows), killswitch (popup button and Alt+Shift+K), browser-internal and
extension pages always blocked, file:// blocked, banking/payment site preset (on by default), user block/allow lists,
read-only mode, cookie access off by default, uploads need approval, downloads can be turned off, incognito off by
default, rate limit, relay identity pinning, and an activity log in the popup. The relay additionally enforces password
redaction, eval/storage/cookie permissions, approval prompts for sensitive form submissions, and per-API-key scopes.
| `sidePanel` | A chat panel in Chrome so you can talk to the AI agent that is driving your browser, see its provider, model and chat name, and pull page context. |
| `tabGroups` | Put each agent's tabs in a named, colored tab group so concurrent sessions stay distinguishable. |
| `scripting` | Read a compact snapshot of the current page when you click Pull page context, and fill or read a page if Chrome refuses a debugger attach (for example a password-manager iframe). |
| `offscreen` | Play an optional, user-enabled completion chime via the Web Audio API when an AI agent finishes driving a tab (Manifest V3 service workers cannot access `AudioContext` directly). |

Host permissions (`http://*/*`, `https://*/*`) are required for `chrome.scripting` on granted tabs. The extension still only acts on tabs you grant.
