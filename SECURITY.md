# Security policy

Luculent Browser Driver for AI Agents gives software control over a web browser, so we treat security reports as
the top priority.

## Reporting a vulnerability
Email **security@luculent.dev** with steps to reproduce, the version (`extension/manifest.json` and `lbd status`),
and your OS/Chrome version. Please do not open a public GitHub issue for security problems. We aim to acknowledge
within 2 business days and to ship a fix or mitigation for high-severity issues within 14 days, and we will credit
you in the release notes unless you prefer otherwise.

## Scope
In scope: anything that lets a web page, another local program, or an agent do more than the user's security
settings allow. Examples: bypassing per-tab grants, the password guard, read-only mode, site block lists, upload or
eval approvals, the killswitch, relay identity pinning (TOFU), API-key scopes, or the relay's web-origin and
DNS-rebinding checks.

Out of scope: actions an agent performs within the permissions the user granted; issues that need an attacker who
already runs code as the user with full access to the relay's data folder; social engineering.

## Design summary
* The relay listens on 127.0.0.1 only, refuses browser-page origins and foreign Host headers, and requires an API key
  (stored as a SHA-256 hash) for every agent call.
* The extension pins the relay's identity on first pairing (HMAC challenge) and refuses an impostor on the same port.
* Browser-level rules (tab grants, internal pages, banking preset, read-only, cookies, uploads, killswitch) are
  enforced inside the extension for every DevTools command, independent of the relay.
* Settings can only be loosened in the extension UI or with the relay admin token, never by an agent.
