# Luculent Browser Driver for AI Agents - Privacy Policy

_Last updated: November 14, 2026_. Canonical policy: https://privacy.luculent.dev/policy#browser-driver

Luculent Browser Driver for AI Agents ("the extension") is a free, open-source Chrome extension published by
Luculent. It lets AI agents that you run and authorise control tabs in your browser through a relay program running
on your own computer, within the security settings you choose.

**What the extension accesses.** Only tabs you have allowed agents to use (or tabs an agent opened itself). When an
agent you authorised sends a command, the extension reads or changes the tab that command targets: page content and
structure, the tab's URL and title, form fields it fills, screenshots it is asked to take, and downloads it is asked
to report. By default it does **not** read or type passwords, read cookies or site storage, run custom scripts,
open browser-internal pages, or work on banking and payment sites; you can change each of these in Settings.

**Where that data goes.** Only to the Luculent relay on your computer (default `127.0.0.1:47800`), and from there
only to the agent holding a valid API key that you created. The extension has no servers of its own. Luculent does
not receive, collect, store or sell any of this data. There is no analytics, tracking or advertising code.

**Stored data (on your computer only).** Your security settings, the paired relay's identity secret, which tabs you
granted (remembered across Chrome restarts by page URL), the killswitch state, side-panel chat history (Active / Closed / Saved; Closed chats are deleted after 30 days unless you save them), and a short activity log (the last 200 actions and
refusals, with URLs and action names but never typed text or password values). The relay stores hashed API keys,
its settings and an activity log file (`audit.log`, capped at 2 MB) in your user folder. You can delete all of it at
any time by removing the extension and that folder.

**Approvals.** When an agent asks for something you set to "Ask me" (for example a file upload), Chrome shows a
notification with Allow / Deny. Nothing happens until you answer; unanswered requests are declined.

**Agents you connect.** An agent you connect (for example a cloud AI model) receives the page data it asks for,
under that agent provider's own privacy policy. Use tab grants, site block lists, read-only mode, per-key scopes and
the killswitch to limit this.

**Children.** The extension is not directed at children under 13.

**Changes.** We will update this page and its date if this policy changes. The source code is public, so every
change is visible.



**Optional navigation metadata.** If you leave this on (or, in the EU, EEA and UK, if you opt in), the extension may send Luculent structural information about how agents navigate websites, so the preemptive planner can get better over time. That is only the site's registrable domain (eTLD+1), path templates with IDs stripped, element role and selector fingerprints, action sequences, plan vs actual state, timings, success or failure, and a hashed install id. We never collect page text, form values, passwords, cookies, query strings, data from sign-in pages, data from banking or blocked sites, or anything from Incognito. It is on by default outside the EU, EEA and UK, and off until you opt in there. Turning it off deletes anything not yet uploaded. Details, retention, deletion, and the Chrome Web Store Limited Use statement are in the [company privacy policy](https://privacy.luculent.dev/policy#browser-driver).

**Contact.** privacy@luculent.dev
