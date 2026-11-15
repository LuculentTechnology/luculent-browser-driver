# Navigation metadata consent copy (draft for review)

This is the disclaimer shown on the setup/onboarding flow, the Settings toggle, and the side panel. It is written as an honest explanation and a gentle ask, not legalese and not a guilt trip. Do not publish this file as a standalone page; the public policy URL is https://privacy.luculent.dev/policy.

## Title

Help the driver get much faster over time

## Body

The Luculent Browser Driver can learn how sites are usually moved through — the kinds of clicks and page-to-page steps that work — and use that to plan a few moves ahead. That is how it gets faster and a little smarter with time, and it is a core part of how a small team like ours improves the product.

If you leave this on, here is exactly what we collect:

• the site's registrable domain (for example wikipedia.org)
• a generalized path with IDs and tokens already stripped (for example /wiki/:title, never the raw identifier)
• a rough page type (article, search, listing, and so on)
• the accessibility role and a generalized selector pattern of elements an agent acted on — not the visible label or any text
• the sequence of actions (navigate, click, type, and so on — not what was typed)
• whether a planned next step matched the real page, and why it was confirmed or adjusted
• how long those steps took, and whether they succeeded

We hash an install identifier so events can be grouped without naming you.

Here is what we never collect: the text of a page, anything you type, passwords, cookies, query strings, or anything from sign-in pages, banking and payment sites, or incognito windows.

You can turn this off at any time. When you do, collection stops immediately and we delete anything still waiting on your computer.

The full policy is at https://privacy.luculent.dev/policy

## Toggle wording

- When the regional default is on (opt-out, most regions): "Share navigation metadata. This is on unless you turn it off."
- When the regional default is off (opt-in, EU/EEA/UK, and any conservative match on locale or timezone): "Share navigation metadata. This is off unless you turn it on."
- After the user changes it: "Share navigation metadata." plus "On — you can turn this off any time." or "Off — nothing is collected."

## Behavior (must stay in sync with the code)

- Default ON (opt-out) except default OFF (opt-in) for EU/EEA/UK, detected from locale and timezone, conservative (if it might be EU/EEA/UK, default off).
- Honor a change immediately. Turning it off stops collection and deletes the local buffer and unsunk sink files on this computer.
- Link the policy as https://privacy.luculent.dev/policy.
