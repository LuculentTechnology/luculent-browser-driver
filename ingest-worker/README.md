# Luculent Browser Driver navigation-metadata ingest (scaffold)

This Worker accepts batched, compressed navigation-metadata events from a user's local relay.

**Do not deploy this Worker. Do not create Cloudflare or other cloud resources from this tree.** Deploy waits for Derrick's go.

## What it does (when deployed later)

- Accepts `POST /v1/nav-meta` with `content-type: application/jsonl` and optional `content-encoding: gzip`.
- Requires `x-lbd-meta-schema` to match a supported schema version (currently `1`).
- Parses each line as JSON, drops events that fail validation or contain forbidden fields (page text, form values, passwords, cookies, query strings, raw URLs, titles, and so on).
- Would store accepted events for aggregation into per-site navigation priors. Storage bindings are commented out on purpose.

## Local check

```
node --check src/index.js
node --test ../test/meta.test.mjs
```

The Worker is not started by the driver, and the relay's ingest URL is empty unless someone sets it later.
