# Navigation metadata schema

Schema version: `1` (`v` field on every event). Bump `META_SCHEMA_VERSION` in `src/meta.mjs` and teach the ingest worker to accept the new version before shipping a breaking change. Older versions are rejected.

This is structural navigation metadata only. Events are sanitized on the client before they are buffered, written to the local sink, or uploaded. Forbidden fields never leave the machine.

## Event (version 1)

| Field | Type | Notes |
| --- | --- | --- |
| `v` | number | Schema version. Currently `1`. |
| `ts` | number | Unix time in milliseconds. |
| `installId` | string | SHA-256 hex of a random local install identifier. The raw identifier is never sent. |
| `domain` | string | Registrable domain (eTLD+1). |
| `path` | string | Path template with IDs and tokens already stripped. No query string, no fragment. |
| `pageType` | string | `home`, `search`, `article`, `listing`, `product`, `settings`, or `other`. `auth` and `checkout` events are dropped, not stored. |
| `action` | string, optional | The action taken (`navigate`, `click`, `type`, ...). Never includes typed text. |
| `element` | object, optional | `{ role, tag, pattern }` only. No accessible name, label, or text. Selector patterns are generalized (`#:id`, `/ :id`). |
| `sequence` | string[], optional | Recent action names, capped. |
| `plan` | object, optional | `{ matched, adjusted, replan, reason, failed }` where `failed` is expectation field names only. |
| `timings` | object, optional | `{ actionMs, confirmMs, totalMs }`. |
| `ok` | boolean | Whether the step succeeded. |

## Never present

`text`, `innerText`, `html`, `content`, `title`, `value`, `form`, `password`, `cookie`, `header`, `query`, `search`, `hash`, `input`, `email`, `token`, `rawUrl`, `href`, `name`, `label`, `accessibleName`, `typed`, `selection`, `screenshot`, `body`, `pageText`.

Events are also dropped for: incognito tabs, non-http(s) URLs, authentication pages, checkout/payment paths, banking/payment preset hosts, and any URL blocked by the user's security settings.

## Transport

- Local buffer in the relay process (capped).
- Local file sink: `nav-meta/batch-<timestamp>-<n>.jsonl` under the relay home folder, mode `0600`.
- Optional batched gzip upload `POST` to a configured ingest URL with headers `content-type: application/jsonl`, `content-encoding: gzip`, `x-lbd-meta-schema: 1`.
- No production ingest URL is configured in this tree. The Worker under `ingest-worker/` is a scaffold only. Do not deploy it or create cloud resources until Derrick says to.

## Consent envelope (local)

`nav-meta-consent.json`: `{ consented, setByUser, region, defaultOn, seenDisclaimer, updatedAt }`. Default `consented` is true except for EU/EEA/UK (`region: "eu-eea-uk"`), detected from locale and timezone, conservative. Opt-out purges the buffer and unsunk sink files immediately.

## Priors file (feedback loop)

`priors/default.json` and an optional override at `<home>/priors.json`:

```
{ "v": 1, "updatedAt": 0, "sites": [
  { "domain": "example.com", "path": "/", "pageType": "home",
    "flows": [{ "goal": "", "weight": 1, "steps": [{ "action": "click", "targetPattern": "a", "expect": { "url": "/next" } }] }] }
] }
```

The client loads this file at relay start and looks up flows by domain and path template to seed the preemptive planner. Priors are aggregates and must not include page text or form values.

## Conversion & Adoption Measurement vs. Optional Performance Metadata

1. **Website & Chrome Web Store conversion tracking (no browsing data)**:
   - Public website analytics use privacy-preserving aggregate counts (`CfWebAnalytics` on `luculent.dev`).
   - Store outbound CTAs on `/beta` and `/beta/browser-driver` carry UTM parameters (`utm_source=luculent.dev&utm_medium=referral&utm_campaign=beta_landing|browser_driver_page`) to measure site-to-Store conversion alongside aggregate Chrome Web Store developer dashboard impressions, installs, and active user counts.
2. **Separation of optional extension metadata from browsing data**:
   - Ordinary browsing in ungranted tabs is never observed.
   - Even in agent-driven tabs, optional navigation/performance metadata (`nav-meta.v1`) only records structural action outcomes (host, path shape with IDs/tokens stripped, step kind, target kind, duration, pass/fail) and **never** page text, typed values, query strings, cookies, or credentials.
3. **Consent, withdrawal, and retention**:
   - In the EU/EEA/UK (`regionDefaultOn() === false`), optional navigation metadata stays **off by default** until explicit opt-in.
   - Users can withdraw consent at any time in the extension (`Settings` or `Side Panel`, no account required) or in their free `/beta/account` settings (`metadataOptOut`), which immediately stops collection and clears any buffered local records.
   - Raw `nav-meta.v1` events are retained for at most **90 days** before aggregation into de-identified site/locator priors (`priors.mjs`) and deletion.
