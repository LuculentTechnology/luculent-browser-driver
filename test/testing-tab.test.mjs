import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEST_SUITES,
  runInPageAudit,
  buildAgentGuidancePrompt,
  buildChatSummaryMessage,
  renderOnePageReportHtml,
} from '../extension/testing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.join(__dirname, '..', 'extension');

test('Testing tab markup has Control/Testing tabs, 3 split buttons with Fix immediately dropdowns, and report actions', () => {
  const html = fs.readFileSync(path.join(extDir, 'popup.html'), 'utf8');
  assert.match(html, /id="tabTestingBtn"/);
  assert.match(html, /id="tabTestingPanel"/);
  for (const kind of ['click', 'visual', 'code']) {
    assert.match(html, new RegExp(`data-run-suite="${kind}"`));
    assert.match(html, new RegExp(`data-toggle-menu="${kind}"`));
    assert.match(html, new RegExp(`id="menu-${kind}"`));
  }
  assert.match(html, /data-fix-now="true"/);
  assert.match(html, /Fix immediately/);
  assert.match(html, /id="approveReportBtn"/);
  assert.match(html, /id="displayInChatBtn"/);
  assert.match(html, /id="downloadReportBtn"/);
});

test('TEST_SUITES defines click, visual, and code diagnostic suites', () => {
  assert.equal(typeof runInPageAudit, 'function');
  assert.equal(TEST_SUITES.click.title, 'Click Test');
  assert.equal(TEST_SUITES.visual.title, 'Visual Check');
  assert.equal(TEST_SUITES.code.title, 'Code Check');
});

test('buildAgentGuidancePrompt and buildChatSummaryMessage support approval mode and Fix immediately mode', () => {
  const sampleReport = {
    kind: 'click',
    url: 'https://luculent.dev/beta',
    title: 'Luculent Beta',
    timestamp: '2026-11-15T05:20:00.000Z',
    viewport: { width: 1440, height: 900 },
    counts: { totalInteractive: 14, issuesTotal: 2, high: 1, medium: 1, low: 0 },
    interactiveMap: [
      { index: 1, role: 'button', tag: 'button', selector: '#cta', label: 'Join Beta', href: '', disabled: false },
    ],
    issues: [
      {
        id: 'ISS-01',
        severity: 'high',
        category: 'Unaddressable Control',
        selector: 'button.icon-only',
        label: 'button.icon-only',
        summary: 'Interactive <button> has no accessible label or text',
        detail: 'Missing aria-label on icon button.',
        fix: 'Add aria-label="Open menu" to button.icon-only.',
      },
    ],
    planSteps: [
      {
        step: 1,
        issueId: 'ISS-01',
        severity: 'high',
        target: 'button.icon-only',
        title: 'Patch Unaddressable Control: Interactive <button> has no accessible label or text',
        action: 'Add aria-label="Open menu" to button.icon-only.',
      },
    ],
  };

  const planPrompt = buildAgentGuidancePrompt(sampleReport, { fixImmediately: false });
  assert.match(planPrompt, /MODE: GUIDED CLICK TEST & PLAN FOR APPROVAL/);
  assert.match(planPrompt, /CLICK TEST EXECUTION GUIDE/);
  assert.match(planPrompt, /ISS-01/);

  const fixNowPrompt = buildAgentGuidancePrompt(sampleReport, { fixImmediately: true });
  assert.match(fixNowPrompt, /MODE: FIX IMMEDIATELY \(Approval skipped by user\)/);

  const chatSummary = buildChatSummaryMessage(sampleReport);
  assert.match(chatSummary, /Click Test Report — Luculent Beta/);
  assert.match(chatSummary, /Remediation Plan for Approval/);
  assert.match(chatSummary, /Approve & Patch/);

  const onePageHtml = renderOnePageReportHtml(sampleReport);
  assert.match(onePageHtml, /<!doctype html>/i);
  assert.match(onePageHtml, /Click Test &amp; Remediation Plan/);
  assert.match(onePageHtml, /--paper: #FAF8F4/);
  assert.match(onePageHtml, /ISS-01/);
});
