# Internal notes (monorepo only, excluded from the open-source export)

Tracking: LUC-637 (Linear) with sub-issues LUC-3029..3044 and the new hardening/security/open-source sub-issues;
Asana mirror under parent 1220532723893080. Worktree: D:\Luculent\wt-browser-driver (branch feat/browser-driver).

## Reused from the Luculent repo
Most earlier BX work is ADRs and stubs, so this is a fresh build. It keeps their contracts so the Rust side can
adopt it: the extension icons (`app/extensions/chrome/images`), ADR `docs/adr/0592-bx1-browser-extension-mv3.md`
(MV3 + `chrome.debugger`), the `BrowserEngine`/`Target` split in `crates/core/src/browser/mod.rs` (extension vs
headless vs in-app), the headless launch flags in `crates/daemon/src/browser/mod.rs`, and the BX5 safety rules
in `crates/daemon/src/browser_engine.rs` (now enforced by scopes, allowlists and the killswitch). The native
messaging stub (`crates/cli/src/cmd/browser/host.rs`) is superseded by the WebSocket relay; the in-app browser
(LUC-1545) can register as another router source later.

## Built to grow into the Luculent Extension
The Markup Browser will merge into this extension later as the "Luculent Extension". The MVP leaves room for that:
* **Popup mode slot** (`extension/popup.js` `MODES`): each mode owns a `<section data-mode>`; the mode bar appears
  once a second mode (Markup Editor) registers.
* **Auth layer** (`extension/auth.js`): a credential slot for a Luculent Master API key or a scoped sub-key, unused
  by the local relay today. On the relay side, `src/keys.mjs` already issues scoped, revocable sub-keys.
* **Pluggable outbound transport** (`extension/transports.js`): `local` (the relay) ships now; `cloud` (a Luculent
  endpoint for Markup submissions) is a stub to fill in.

## Post-MVP
Side panel on/off (LUC-3043) and markup visual-editing toolbar (LUC-3044).

### Grok Bot (Cosmech Main)
Grok Bot runs on its own cloud box, so it cannot reach `127.0.0.1` on Battlestation. Two options:

1. **Run through Battlestation (works today):** Grok Bot calls the HTTP RPC from a Battlestation shell, e.g.
   `Invoke-RestMethod http://127.0.0.1:47800/v1/rpc -Headers @{Authorization="Bearer $env:LBD_KEY"} ...`.
   Tonight's Grok Bot validation used this path.
2. **Native MCP connector (needs Derrick's go):** expose only the relay's `/mcp` path through a tunnel, then add
   it to Grok Bot as a remote MCP server with the key as the bearer token:
   ```powershell
   cloudflared tunnel --url http://127.0.0.1:47800      # or: tailscale funnel 47800
   ```
   Mint a dedicated key with only the scopes it needs (and `--origins` if possible), and revoke it when done.
   The relay already refuses browser-page origins; the API key is the only gate, so keep it secret.

## Model harness on Battlestation
`harness/models.mjs` uses the Gemini 1-5 free keys through the steward rotation. Run with
`$env:LBD_STEWARD='D:\Luculent\ops\hermes-steward'`. OpenRouter/DeepSeek is still available with `--models deepseek`
but is no longer the default (Nov 13, 2026: Derrick asked to move model runs to the Gemini keys).
