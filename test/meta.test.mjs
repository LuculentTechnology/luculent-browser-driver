import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as read } from 'node:fs';
import {
  CONSENT_BODY, CONSENT_TITLE, PRIVACY_POLICY_URL, META_SCHEMA_VERSION,
  etld1, pathTemplate, pageTypeFromPath, isAuthUrl, shouldCollect,
  fingerprintElement, hashInstallId, sanitizeEvent, parseLocale, regionDefaultOn,
  localeLooksEuEeaUk, timezoneLooksEuEeaUk, consentRecord, FORBIDDEN_EVENT_KEYS,
} from '../src/meta.mjs';
import { MetaHub } from '../src/meta-buffer.mjs';
import { loadPriors, lookupPriors, normalizePriors, bundledPriorsPath } from '../src/priors.mjs';
import { validateEvent } from '../ingest-worker/src/schema.js';
import * as extConsent from '../extension/consent.js';

const INSTALL = hashInstallId('test-install-raw');
const POLICY = { bankingPreset: true, blocklist: [], allowlist: [], internalPages: 'deny', fileUrls: 'deny' };

describe('regional consent defaults', () => {
  it('defaults on outside the EU/EEA/UK', () => {
    assert.equal(regionDefaultOn({ locale: 'en-US', timeZone: 'America/Los_Angeles' }), true);
    assert.equal(regionDefaultOn({ locale: 'en-AU', timeZone: 'Australia/Sydney' }), true);
    assert.equal(regionDefaultOn({ locale: 'pt-BR', timeZone: 'America/Sao_Paulo' }), true);
    assert.equal(regionDefaultOn({ locale: 'es-MX', timeZone: 'America/Mexico_City' }), true);
    assert.equal(regionDefaultOn({ locale: 'fr-CA', timeZone: 'America/Toronto' }), true);
  });
  it('defaults off for EU/EEA/UK locales or timezones, including conservative cases', () => {
    assert.equal(regionDefaultOn({ locale: 'en-GB', timeZone: 'America/Los_Angeles' }), false);
    assert.equal(regionDefaultOn({ locale: 'en_GB.UTF-8', timeZone: 'America/Los_Angeles' }), false);
    assert.equal(regionDefaultOn({ locale: 'en_US.UTF-8@euro', timeZone: 'America/Los_Angeles' }), true);
    assert.deepEqual(parseLocale('en_GB.UTF-8'), { language: 'en', region: 'GB' });
    assert.deepEqual(parseLocale('en-US.UTF-8@euro'), { language: 'en', region: 'US' });
    assert.equal(regionDefaultOn({ locale: 'en-US', timeZone: 'Europe/London' }), false);
    assert.equal(regionDefaultOn({ locale: 'fr-FR', timeZone: 'Europe/Paris' }), false);
    assert.equal(regionDefaultOn({ locale: 'de', timeZone: 'UTC' }), false);
    assert.equal(regionDefaultOn({ locale: 'pt-PT', timeZone: 'Atlantic/Azores' }), false);
    assert.equal(regionDefaultOn({ locale: 'is', timeZone: 'Atlantic/Reykjavik' }), false);
    assert.equal(regionDefaultOn({ locale: 'en-IE' }), false);
    assert.equal(regionDefaultOn({ locale: 'es' }), false); // ambiguous Spanish
    assert.equal(timezoneLooksEuEeaUk('Europe/Berlin'), true);
    assert.equal(localeLooksEuEeaUk('nl-NL'), true);
    assert.equal(localeLooksEuEeaUk('en-US'), false);
  });
});

describe('path templates and domains', () => {
  it('keeps eTLD+1 and strips ids, tokens, and query is never part of the path', () => {
    assert.equal(etld1('www.bbc.co.uk'), 'bbc.co.uk');
    assert.equal(etld1('en.wikipedia.org'), 'wikipedia.org');
    assert.equal(etld1('dprofosho.github.io'), 'dprofosho.github.io');
    assert.equal(pathTemplate('/wiki/Ada_Lovelace'), '/wiki/:title');
    assert.equal(pathTemplate('/blog/my-first-post'), '/blog/:title');
    assert.equal(pathTemplate('/users/12345/posts/ab'), '/users/:id/posts/ab');
    assert.equal(pathTemplate('/u/johndoe'), '/u/:id');
    assert.equal(pathTemplate('/item/550e8400-e29b-41d4-a716-446655440000'), '/item/:id');
    assert.equal(pathTemplate('/x/deadbeefdeadbeefdeadbeefdeadbeef'), '/x/:id');
    assert.equal(pathTemplate('/reset/eyJhbGciOiJIUzI1NiJ9abc'), '/reset/:id');
    assert.equal(pageTypeFromPath('/wiki/Ada_Lovelace'), 'article');
    assert.equal(pageTypeFromPath('/search'), 'search');
    assert.equal(pageTypeFromPath('/login'), 'auth');
    assert.equal(pageTypeFromPath('/checkout/pay'), 'checkout');
  });
});

describe('collection gates and PII stripping', () => {
  it('refuses auth, banking, incognito, and query-bearing raw use still drops query', () => {
    assert.equal(isAuthUrl('https://github.com/login'), true);
    assert.equal(isAuthUrl('https://accounts.google.com/ServiceLogin'), true);
    assert.equal(isAuthUrl('https://en.wikipedia.org/wiki/Ada_Lovelace'), false);
    assert.equal(shouldCollect({ url: 'https://chase.com/accounts', policy: POLICY }).ok, false);
    assert.equal(shouldCollect({ url: 'https://example.com/', incognito: true, policy: POLICY }).reason, 'incognito');
    assert.equal(shouldCollect({ url: 'https://example.com/login', policy: POLICY }).reason, 'auth');
    assert.equal(shouldCollect({ url: 'https://en.wikipedia.org/wiki/Ada_Lovelace?q=secret', policy: POLICY }).ok, true);
  });
  it('sanitizeEvent never keeps page text, form values, passwords, cookies, or query strings', () => {
    const { ok, event } = sanitizeEvent({
      url: 'https://en.wikipedia.org/wiki/Ada_Lovelace?session=abc&email=a@b.com#top',
      action: 'click',
      text: 'THIS MUST NOT APPEAR',
      title: 'Ada Lovelace - Wikipedia',
      value: 'LbdDummyPass_t1272_X9!',
      password: 'LbdDummyPass_t1272_X9!',
      cookies: 'sid=1',
      query: 'session=abc',
      element: { role: 'link', name: 'Ada Lovelace', selector: 'a[href="/wiki/Ada_Lovelace"]', label: 'Ada Lovelace' },
      ok: true,
    }, { installHash: INSTALL });
    assert.equal(ok, true);
    assert.equal(event.domain, 'wikipedia.org');
    assert.equal(event.path, '/wiki/:title');
    assert.equal(event.v, META_SCHEMA_VERSION);
    assert.equal(event.installId, INSTALL);
    assert.ok(!JSON.stringify(event).includes('LbdDummyPass'));
    assert.ok(!JSON.stringify(event).includes('THIS MUST NOT APPEAR'));
    assert.ok(!JSON.stringify(event).includes('session=abc'));
    assert.ok(!JSON.stringify(event).includes('a@b.com'));
    assert.ok(!JSON.stringify(event).includes('Ada Lovelace'));
    for (const k of FORBIDDEN_EVENT_KEYS) assert.equal(Object.prototype.hasOwnProperty.call(event, k), false);
    assert.equal(event.element.name, undefined);
    assert.equal(event.element.label, undefined);
    assert.equal(event.element.role, 'link');
    assert.equal(validateEvent(event).ok, true);
  });
  it('drops auth and banking events even if someone passes them in', () => {
    assert.equal(sanitizeEvent({ url: 'https://github.com/login', action: 'type' }, { installHash: INSTALL }).ok, false);
    assert.equal(sanitizeEvent({ url: 'https://paypal.com/wallet', action: 'click', policy: POLICY }, { installHash: INSTALL }).ok, false);
  });
  it('fingerprints strip text selectors and generated ids', () => {
    const fp = fingerprintElement({ role: 'button', selector: 'button#abc123def456:has-text("Submit email")' });
    assert.equal(fp.role, 'button');
    assert.ok(!JSON.stringify(fp).includes('Submit email'));
    assert.ok(!JSON.stringify(fp).includes('abc123def456'));
    const leaky = fingerprintElement({
      pattern: 'text=Sign in role=button[name=Create account] label=Submit [name=email]',
    });
    const dumped = JSON.stringify(leaky);
    assert.ok(!dumped.includes('Sign in'), dumped);
    assert.ok(!dumped.includes('Create account'), dumped);
    assert.ok(!dumped.includes('Submit'), dumped);
    assert.ok(!dumped.includes('email'), dumped);
  });
});

describe('MetaHub consent, purge, and sink', () => {
  let home;
  before(() => { home = mkdtempSync(join(tmpdir(), 'lbd-meta-')); });
  after(() => { rmSync(home, { recursive: true, force: true }); });

  it('uses a regional default and honors opt-out by purging the buffer and sink', async () => {
    const hub = new MetaHub({ home, locale: 'en-US', timeZone: 'America/Los_Angeles', policy: POLICY });
    assert.equal(hub.status().consented, true);
    assert.equal(hub.status().region, 'other');
    assert.equal(hub.status().setByUser, false);
    const rec = hub.record({ url: 'https://en.wikipedia.org/wiki/Ada_Lovelace', action: 'click', ok: true });
    assert.equal(rec.ok, true);
    const flushed = hub.flush({ upload: false });
    assert.equal(flushed.flushed, 1);
    assert.ok(existsSync(flushed.path));
    const body = readFileSync(flushed.path, 'utf8');
    assert.ok(body.includes('wikipedia.org'));
    assert.ok(!body.includes('?'));
    const off = hub.setConsent({ consented: false, setByUser: true });
    assert.equal(off.consented, false);
    assert.equal(hub.buffer.length, 0);
    assert.equal(readdirSync(join(home, 'nav-meta')).filter((n) => n.endsWith('.jsonl')).length, 0);
    const after = hub.record({ url: 'https://en.wikipedia.org/wiki/Ada_Lovelace', action: 'click', ok: true });
    assert.equal(after.reason, 'opted-out');
  });

  it('defaults off in EU and does not record until opted in', () => {
    const euHome = mkdtempSync(join(tmpdir(), 'lbd-meta-eu-'));
    try {
      const hub = new MetaHub({ home: euHome, locale: 'en-GB', timeZone: 'Europe/London', policy: POLICY });
      assert.equal(hub.status().consented, false);
      assert.equal(hub.status().region, 'eu-eea-uk');
      assert.equal(hub.record({ url: 'https://example.com/', action: 'navigate' }).reason, 'opted-out');
      hub.setConsent({ consented: true, setByUser: true });
      assert.equal(hub.record({ url: 'https://example.com/', action: 'navigate' }).ok, true);
    } finally {
      rmSync(euHome, { recursive: true, force: true });
    }
  });

  it('never writes the raw install id into events', () => {
    const h = new MetaHub({ home: mkdtempSync(join(tmpdir(), 'lbd-meta-id-')), locale: 'en-US', timeZone: 'America/Los_Angeles', policy: POLICY });
    h.record({ url: 'https://example.com/docs/x', action: 'click', ok: true });
    const ev = h.buffer[0];
    assert.equal(ev.installId, hashInstallId(h.installRaw));
    assert.notEqual(ev.installId, h.installRaw);
    assert.equal(ev.installId.length, 64);
    rmSync(h.home, { recursive: true, force: true });
  });
});

describe('priors loader', () => {
  it('loads the bundled file and looks up flows by domain and path template', () => {
    const bundled = loadPriors(bundledPriorsPath());
    assert.equal(bundled.v, 1);
    const home = mkdtempSync(join(tmpdir(), 'lbd-priors-'));
    writeFileSync(join(home, 'priors.json'), JSON.stringify({
      v: 1,
      updatedAt: 1,
      sites: [{
        domain: 'wikipedia.org',
        path: '/wiki/:title',
        pageType: 'article',
        flows: [{ goal: 'open a related article', weight: 3, steps: [{ action: 'click', targetPattern: 'a[href^="/wiki/"]', expect: { url: '/wiki/' } }] }],
      }],
    }));
    const doc = loadPriors(join(home, 'priors.json'));
    const hit = lookupPriors(doc, { url: 'https://en.wikipedia.org/wiki/Ada_Lovelace' });
    assert.equal(hit.domain, 'wikipedia.org');
    assert.ok(hit.flows.length >= 1);
    assert.equal(hit.flows[0].steps[0].action, 'click');
    rmSync(home, { recursive: true, force: true });
  });
  it('normalizePriors ignores empty domains', () => {
    assert.equal(normalizePriors({ sites: [{ domain: '', path: '/' }] }).sites.length, 0);
  });
});

describe('consent copy stays in sync', () => {
  it('extension, policy URL, and store/CONSENT.md share the same title and body', () => {
    assert.equal(extConsent.CONSENT_TITLE, CONSENT_TITLE);
    assert.equal(extConsent.CONSENT_BODY, CONSENT_BODY);
    assert.equal(extConsent.PRIVACY_POLICY_URL, PRIVACY_POLICY_URL);
    assert.equal(PRIVACY_POLICY_URL, 'https://privacy.luculent.dev/policy');
    const md = read(new URL('../store/CONSENT.md', import.meta.url), 'utf8');
    assert.ok(md.includes(CONSENT_TITLE));
    assert.ok(md.includes(CONSENT_BODY));
    assert.ok(md.includes(PRIVACY_POLICY_URL));
    const privacy = read(new URL('../store/PRIVACY.md', import.meta.url), 'utf8');
    assert.ok(privacy.includes(PRIVACY_POLICY_URL));
    assert.ok(privacy.includes('We never collect') || /never collect/i.test(privacy));
  });
  it('regionDefaultOn matches between the extension and the relay helpers', () => {
    const samples = [
      { locale: 'en-US', timeZone: 'America/Los_Angeles' },
      { locale: 'en-GB', timeZone: 'Europe/London' },
      { locale: 'de', timeZone: 'Europe/Berlin' },
      { locale: 'es-MX', timeZone: 'America/Mexico_City' },
    ];
    for (const s of samples) {
      assert.equal(extConsent.regionDefaultOn(s), regionDefaultOn(s));
    }
  });
});
