// Curveball test suite for Luculent Browser Driver
// Tests edge cases: non-standard prompts, messy selectors, React hydration/valueTracker,
// custom ARIA dropdowns, covered elements, zero-token diagnostics, in-page audits, unicode/emojis.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { relayClient } from '../src/mcp-stdio.mjs';
import { startFixtures } from './fixtures.mjs';
import { HELPER_SRC, HELPER_VERSION } from '../src/helper.mjs';
import { TEST_SUITES, buildAgentGuidancePrompt } from '../extension/testing.js';

let relay, fx, keys, full, rpc, tab;

before(async () => {
  keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-curveball-')));
  relay = await new Relay({ port: 0, keys, log: () => {} }).start();
  fx = await startFixtures();
  full = keys.mint({ name: 'full', scopes: ['read', 'act', 'tabs', 'headless', 'admin'] }).token;
  rpc = relayClient({ url: `ws://127.0.0.1:${relay.port}/v1/ws`, key: full });
  const r = await rpc('headless.launch', {});
  tab = r.tab;
});

after(async () => {
  rpc?.close();
  await relay?.stop();
  await fx?.close();
});

test('curveball: parse natural language and shorthand selectors in helper VM', () => {
  const sandbox = {
    window: {},
    document: {
      querySelector: () => null,
      title: 'Sandbox'
    },
    location: { href: 'https://example.com/test' },
    performance: { getEntriesByType: () => [] },
    addEventListener: () => {},
    removeEventListener: () => {},
    console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(HELPER_SRC, sandbox);
  const lbd = sandbox.__lbd;
  assert.ok(lbd, 'helper should register __lbd');

  // Natural language shorthand: role + quoted text
  const btnParsed = lbd.parse('button "Checkout"');
  assert.equal(btnParsed.role, 'button');
  assert.equal(btnParsed.name, 'Checkout');

  // Link shorthand
  const linkParsed = lbd.parse("link 'Documentation'");
  assert.equal(linkParsed.role, 'link');
  assert.equal(linkParsed.name, 'Documentation');

  // testid / data-testid
  const testidParsed = lbd.parse('testid=checkout-btn');
  assert.equal(testidParsed.css, '[data-testid="checkout-btn"]');

  // placeholder
  const placeholderParsed = lbd.parse('placeholder="Full legal name"');
  assert.equal(placeholderParsed.placeholder, 'Full legal name');

  // name
  const nameParsed = lbd.parse('name="customer_name"');
  assert.equal(nameParsed.css, '[name="customer_name"]');

  // id shorthand
  const idParsed = lbd.parse('id="name-field"');
  assert.equal(idParsed.css, '#name-field');

  // Dirty model ref styles: "[e12]", "(ref: e15)", "@e7", "ref=e9"
  assert.equal(lbd.parse('[e12]').ref, 'e12');
  assert.equal(lbd.parse('(ref: e15)').ref, 'e15');
  assert.equal(lbd.parse('@e7').ref, 'e7');
  assert.equal(lbd.parse('ref=e9').ref, 'e9');
  assert.equal(lbd.parse('ref e44').ref, 'e44');
});

test('curveball: live headless Chrome executes action synonyms, shorthand targets & emojis', async () => {
  const emojiNotes = '🔥🚀 Test Order for Ada Lovelace! Special: "double quotes", <brackets> & symbols.';
  const r = await rpc('run', {
    tab,
    snapshot: 'none',
    steps: [
      { action: 'open', url: fx.url + '/form' },
      { action: 'input', target: 'name=name', text: 'Ada Lovelace' },
      { action: 'input', target: 'placeholder=you@example.com', text: 'ada@example.com' },
      { action: 'select', target: '#plan', value: 'Pro' },
      { action: 'check', target: 'label=I agree to the terms' },
      { action: 'input', target: 'name=notes', text: emojiNotes },
      { action: 'tap', target: 'button "Create account"', waitNav: true },
      { action: 'read', target: '#summary' }
    ]
  });

  assert.equal(r.ok, true, JSON.stringify(r.results));
  const summary = r.results.at(-1).value;
  assert.match(summary, /name=Ada Lovelace/);
  assert.match(summary, /email=ada@example.com/);
  assert.match(summary, /plan=pro/);
  assert.match(summary, /tos=on/);
  assert.match(summary, /🔥🚀 Test Order for Ada Lovelace/);
});

test('curveball: live headless Chrome diagnostics returns clean error state', async () => {
  const r = await rpc('run', {
    tab,
    snapshot: 'none',
    steps: [
      { action: 'navigate', url: fx.url + '/' },
      { action: 'diagnostics' }
    ]
  });

  assert.equal(r.ok, true);
  const diagStep = r.results.find((res) => res.action === 'diagnostics');
  assert.ok(diagStep, 'diagnostics step returned result');
  assert.ok(Array.isArray(diagStep.value.errors), 'errors should be an array');
  assert.ok(Array.isArray(diagStep.value.console), 'console entries should be an array');
  assert.ok(Array.isArray(diagStep.value.failedResources), 'failedResources should be an array');
  assert.ok(typeof diagStep.value.url === 'string');
});

test('curveball: in-page test runner and audit prompt generation', () => {
  assert.ok(TEST_SUITES.click);
  assert.ok(TEST_SUITES.visual);
  assert.ok(TEST_SUITES.code);

  const mockReport = {
    kind: 'click',
    title: 'Click Test',
    url: 'https://example.com/test',
    score: 85,
    counts: {
      totalInteractive: 20,
      issuesTotal: 3,
      high: 1,
      medium: 1,
      low: 1
    },
    interactiveTargets: [
      { selector: 'button.checkout', label: 'Checkout', role: 'button', visible: true }
    ],
    issues: [
      { id: 'ISS-01', severity: 'high', category: 'Covered Element', selector: '#submit-btn', label: 'Submit', summary: 'Button covered by overlay', detail: 'Modal backdrop prevents click', fix: 'Dismiss modal' },
      { id: 'ISS-02', severity: 'medium', category: 'Tap Target Size', selector: 'a.nav-link', label: 'Link', summary: 'Target size under 48px', detail: 'Too small', fix: 'Increase padding' }
    ],
    planSteps: [
      { step: 1, issueId: 'ISS-01', severity: 'high', target: '#submit-btn', title: 'Dismiss overlay before click', action: 'Add dismiss step' }
    ]
  };

  const approvalPrompt = buildAgentGuidancePrompt(mockReport, { fixImmediately: false });
  assert.match(approvalPrompt, /MODE: GUIDED CLICK TEST & PLAN FOR APPROVAL/);
  assert.match(approvalPrompt, /stand by for user approval/);

  const fixPrompt = buildAgentGuidancePrompt(mockReport, { fixImmediately: true });
  assert.match(fixPrompt, /MODE: FIX IMMEDIATELY \(Approval skipped by user\)/);
  assert.match(fixPrompt, /immediately patch every discovered issue/);
});
