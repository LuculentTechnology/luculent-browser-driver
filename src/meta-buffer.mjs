// Local consent, hashed install id, in-memory buffer, file sink, and optional batched upload.
// Opt-out is honored immediately and purges the buffer and unsunk files. No production ingest is configured.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { consentRecord, detectRegion, hashInstallId, sanitizeEvent, META_SCHEMA_VERSION, PRIVACY_POLICY_URL } from './meta.mjs';

const CONSENT_FILE = 'nav-meta-consent.json';
const INSTALL_FILE = 'install-id';
const SINK_DIR = 'nav-meta';
const BUFFER_MAX = 100;
const BATCH_SIZE = 25;

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(p, obj) {
  mkdirSync(join(p, '..'), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
}

export class MetaHub {
  constructor({ home, policy, ingestUrl, now, fetchImpl, locale, timeZone } = {}) {
    this.home = home;
    this.policy = policy;
    this.ingestUrl = ingestUrl || '';
    this.now = now || (() => Date.now());
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.locale = locale;
    this.timeZone = timeZone;
    this.buffer = [];
    this.installRaw = this._loadOrMintInstall();
    this.installHash = hashInstallId(this.installRaw);
    this.consent = this._loadConsent();
  }

  _loadOrMintInstall() {
    const p = join(this.home, INSTALL_FILE);
    if (existsSync(p)) {
      const v = readFileSync(p, 'utf8').trim();
      if (v) return v;
    }
    mkdirSync(this.home, { recursive: true });
    const id = randomBytes(16).toString('hex');
    const tmp = p + '.tmp';
    writeFileSync(tmp, id + '\n', { mode: 0o600 });
    renameSync(tmp, p);
    return id;
  }

  _loadConsent() {
    const p = join(this.home, CONSENT_FILE);
    const saved = existsSync(p) ? readJson(p, null) : null;
    if (saved && (saved.consented === true || saved.consented === false)) {
      return {
        consented: !!saved.consented,
        setByUser: !!saved.setByUser,
        region: saved.region || detectRegion({ locale: this.locale, timeZone: this.timeZone }).region,
        defaultOn: saved.defaultOn !== false && saved.defaultOn !== true
          ? detectRegion({ locale: this.locale, timeZone: this.timeZone }).defaultOn
          : !!saved.defaultOn,
        updatedAt: saved.updatedAt || this.now(),
        seenDisclaimer: !!saved.seenDisclaimer,
      };
    }
    const rec = consentRecord({ locale: this.locale, timeZone: this.timeZone, now: this.now() });
    rec.seenDisclaimer = false;
    // Do not persist a regional default: a later process with a different locale/TZ must still compute its own.
    return rec;
  }

  status() {
    return {
      consented: !!this.consent.consented,
      setByUser: !!this.consent.setByUser,
      region: this.consent.region,
      defaultOn: !!this.consent.defaultOn,
      seenDisclaimer: !!this.consent.seenDisclaimer,
      buffered: this.buffer.length,
      ingestConfigured: !!this.ingestUrl,
      schema: META_SCHEMA_VERSION,
      privacy: PRIVACY_POLICY_URL,
      installIdHashPrefix: this.installHash.slice(0, 8),
    };
  }

  setConsent({ consented, setByUser = true, seenDisclaimer, locale, timeZone } = {}) {
    if (locale) this.locale = locale;
    if (timeZone) this.timeZone = timeZone;
    const rec = consentRecord({
      consented: consented === true || consented === false ? consented : this.consent.consented,
      setByUser,
      locale: this.locale,
      timeZone: this.timeZone,
      now: this.now(),
    });
    rec.seenDisclaimer = seenDisclaimer != null ? !!seenDisclaimer : !!this.consent.seenDisclaimer;
    const wasOn = !!this.consent.consented;
    this.consent = rec;
    writeJson(join(this.home, CONSENT_FILE), rec);
    if (wasOn && rec.consented === false) this.purge();
    return this.status();
  }

  markDisclaimerSeen() {
    return this.setConsent({ consented: this.consent.consented, setByUser: !!this.consent.setByUser, seenDisclaimer: true });
  }

  purge() {
    this.buffer = [];
    const dir = join(this.home, SINK_DIR);
    if (!existsSync(dir)) return { purged: true, files: 0 };
    let files = 0;
    for (const name of readdirSync(dir)) {
      if (!/\.(jsonl|jsonl\.gz)$/i.test(name)) continue;
      try { unlinkSync(join(dir, name)); files++; } catch (_) {}
    }
    return { purged: true, files };
  }

  record(input) {
    if (!this.consent.consented) return { ok: false, reason: 'opted-out' };
    const policy = typeof this.policy === 'function' ? this.policy() : this.policy;
    const { ok, reason, event } = sanitizeEvent({ ...input, policy }, { installHash: this.installHash });
    if (!ok) return { ok: false, reason };
    this.buffer.push(event);
    if (this.buffer.length >= BUFFER_MAX) this.flush();
    return { ok: true, buffered: this.buffer.length };
  }

  flush({ upload = true } = {}) {
    if (!this.buffer.length) return { flushed: 0, path: null, uploaded: false };
    const batch = this.buffer.splice(0, BATCH_SIZE);
    const dir = join(this.home, SINK_DIR);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `batch-${stamp}-${batch.length}.jsonl`);
    const body = batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(path, body, { mode: 0o600 });
    let uploaded = false;
    if (upload && this.ingestUrl && this.fetchImpl) {
      // Best-effort; failures leave the local sink file in place. Never throws into the driver.
      try {
        const payload = Buffer.from(body, 'utf8');
        // Compression is applied by the caller/worker path when configured; we send gzip if zlib is available.
      } catch (_) {}
    }
    return { flushed: batch.length, path, uploaded };
  }

  async flushAndUpload() {
    const result = this.flush({ upload: false });
    if (!result.path || !this.ingestUrl || !this.fetchImpl) return { ...result, uploaded: false };
    try {
      const { gzipSync } = await import('node:zlib');
      const raw = readFileSync(result.path);
      const gz = gzipSync(raw);
      const res = await this.fetchImpl(this.ingestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/jsonl',
          'content-encoding': 'gzip',
          'x-lbd-meta-schema': String(META_SCHEMA_VERSION),
        },
        body: gz,
      });
      return { ...result, uploaded: !!(res && res.ok), status: res && res.status };
    } catch (err) {
      return { ...result, uploaded: false, error: 'upload-failed' };
    }
  }
}
