# Luculent Browser Driver for AI Agents — Privacy Policy (draft)

_Last updated: November 14, 2026_. Canonical policy: https://privacy.luculent.dev/policy#browser-driver

This is the Browser Driver draft for review. The public company policy URL is https://privacy.luculent.dev/policy. Do not publish this file yourself; another pass is updating that page. Keep this draft specific enough that the published policy can match it.

Luculent Browser Driver for AI Agents ("the extension") is a free, open-source Chrome extension published by Luculent. It lets AI agents that you run and authorize control tabs in your browser through a relay program running on your own computer, within the security settings you choose.

## What the extension accesses

Only tabs you have allowed agents to use (or tabs an agent opened itself). When an agent you authorized sends a command, the extension reads or changes the tab that command targets: page content and structure, the tab's URL and title, form fields it fills, screenshots it is asked to take, and downloads it is asked to report. By default it does **not** read or type passwords, read cookies or site storage, run custom scripts, open browser-internal pages, or work on banking and payment sites; you can change each of these in Settings. Incognito tabs stay off limits unless you turn that on, and Chrome also requires "Allow in Incognito" on the extension.

## Where page and command data goes

Page content, form values, screenshots, and the other command data above go only to the Luculent relay on your computer (default `127.0.0.1:47800`), and from there only to the agent holding a valid API key that you created. The extension refuses an impostor relay on that port. Luculent does not receive this page or command data. There is no advertising or third-party analytics code in the extension.

An agent you connect (for example a cloud AI model) receives the page data it asks for, under that agent provider's own privacy policy. Use tab grants, site block lists, read-only mode, per-key scopes and the killswitch to limit this.

## Optional navigation metadata (product improvement)

Separately, the driver can collect **structural navigation metadata** so it can learn how sites are usually moved through and plan a few steps ahead. That work is part of how we develop the product. It is optional, and it is not page content.

**What we collect when this is on**

- the registrable domain of the page (eTLD+1, for example `wikipedia.org`)
- a generalized path template, with identifiers, tokens, and similar segments already stripped on your computer (for example `/wiki/:title` or `/users/:id`)
- a rough page-type classification derived from that path (such as article, search, listing, home)
- the accessibility role and a generalized selector pattern of elements an agent acted on — not the visible label and not any text
- the sequence of actions (navigate, click, type, and so on) without what was typed
- whether a planned next step matched the real page, whether the plan was adjusted, the reason, and which expectation field missed
- how long those steps took, and whether they succeeded or failed
- a SHA-256 hash of a random install identifier (the raw identifier stays on your computer and is never sent)

**What we never collect**

- page text, titles, screenshots, or HTML
- anything you type, form values, or passwords
- cookies, site storage, or HTTP headers
- query strings or URL fragments
- anything from sign-in, signup, or other authentication pages
- anything from banking, payment, or other sites on the built-in block preset, or from a site on your own block list
- anything from incognito windows
- raw URLs that still contain identifiers, email addresses, or tokens
- your name, email address, or a Luculent account (the driver does not have accounts)

**Consent and defaults**

You see this explained in setup/onboarding, in Settings, and in the side panel, with a link to this policy. In most regions the default is on, and you can turn it off. In the EU, EEA, and UK the default is off, and it stays off unless you turn it on. We detect that from browser locale and timezone, and we treat close or ambiguous cases as EU/EEA/UK so the default stays off. A change is honored immediately. If you turn it off, collection stops at once and the local buffer and any unsunk batch files on your computer are deleted.

**How it is sent and stored**

Events are stripped of the fields above on your computer, then held in a small local buffer on the relay machine. They are written in batches, compressed, and — only if an ingest endpoint is configured — uploaded to a Luculent ingest service. Until that endpoint is configured, events stay in a local file sink under your Luculent Browser Driver data folder and are not sent anywhere. We use this data to build aggregated per-site navigation priors (common flows and expected states) that can be shipped back to the driver to seed preemptive planning. Those priors are aggregates. They do not include page text, form values, or the raw install identifier.

**Chrome Web Store Limited Use**

Navigation metadata is used only to provide and improve the Luculent Browser Driver, including preemptive navigation. We do not sell it, we do not use it for advertising, we do not use it to credit or credit-score anyone, and we do not allow humans to read individual events except where needed to maintain security, investigate abuse, or comply with law. This is intended to satisfy Chrome Web Store Limited Use.

## Stored data on your computer

Your security settings, the optional navigation-metadata consent state, the paired relay's identity secret, the local install identifier, which tabs you granted (remembered across Chrome restarts by page URL), the killswitch state, side-panel chat history (Active / Closed / Saved; Closed chats are deleted after 30 days unless you save them), a short activity log (the last 200 actions and refusals, with URLs and action names but never typed text or password values), and any unsunk navigation-metadata batches. The relay stores hashed API keys, its settings and an activity log file (`audit.log`, capped at 2 MB) in your user folder. You can delete all of it at any time by removing the extension and that folder, or turn off navigation metadata to delete the pending batches only.

## Approvals

When an agent asks for something you set to "Ask me" (for example a file upload), Chrome shows a notification with Allow / Deny. Nothing happens until you answer; unanswered requests are declined.

## Children

The extension is not directed at children under 13.

## Changes

We will update this policy and its date if our practices change. The source code is public, so every change is visible.

## Contact

privacy@luculent.dev
