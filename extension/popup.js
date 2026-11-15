const $ = (id) => document.getElementById(id);
const msg = (payload) => chrome.runtime.sendMessage(payload);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabId = tab?.id;
let paused = false;
let refreshing = false;
let changingPause = false;
let actionSignature = '';

function setNotice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function paintTask(task, unavailable = false, tabInfo = null) {
  paused = !!task?.paused;
  const tabState = tabInfo?.state || task?.state || 'idle';
  const stateLabel = { active: 'Active', idle: 'Idle', paused: 'Paused', stopped: 'Stopped', 'needs-input': 'Needs input' }[tabState] || '';
  $('agent').textContent = task?.agent || (unavailable ? 'Tab activity unavailable' : tabState === 'paused' ? 'Tab paused' : tabState === 'needs-input' ? 'Needs input' : 'No active agent');
  const model = [task?.provider, task?.model, stateLabel && task ? stateLabel : ''].filter(Boolean).join(' · ');
  $('model').textContent = model;
  $('model').hidden = !model;
  $('taskDetails').hidden = !task;
  $('chatRow').hidden = !task?.chatName;
  $('chatName').textContent = task?.chatName || '';
  $('task').textContent = task?.goal || tabInfo?.reason || (task ? 'Browser actions' : '');
  $('pause').disabled = !task || changingPause;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  const actions = Array.isArray(task?.actions) ? task.actions : [];
  const signature = JSON.stringify([actions, task?.index, unavailable]);
  if (signature === actionSignature) return;
  actionSignature = signature;
  const list = $('actions');
  const scroll = list.scrollTop;
  list.replaceChildren(...actions.map((action, index) => {
    const item = document.createElement('li');
    item.textContent = action.replaceAll('_', ' ');
    if (index === task.index) item.setAttribute('aria-current', 'step');
    return item;
  }));
  list.scrollTop = scroll;
  $('emptyActions').hidden = actions.length > 0;
  $('emptyActions').textContent = unavailable
    ? 'Live task details and Pause need an updated relay.'
    : 'Actions appear here while an agent works in this tab.';
}

function paintApprovals(approvals = [], accessRequests = []) {
  const cards = [
    ...accessRequests.map((item) => {
      const card = document.createElement('div');
      card.className = 'pend pend-access';
      const summary = document.createElement('b');
      summary.textContent = `${item.keyName || 'AI agent'} wants to connect`;
      const hint = document.createElement('small');
      hint.textContent = 'Approve access mode is on. Choose how long to allow this agent:';
      const buttons = document.createElement('div');
      buttons.className = 'btns btns-wrap';
      for (const opt of [
        { label: 'Approve once', allow: true, scope: 'once', cls: 'ok' },
        { label: 'Approve 24h', allow: true, scope: '24h', cls: 'ok' },
        { label: 'Always approve', allow: true, scope: 'always', cls: 'ok' },
        { label: 'Deny', allow: false, scope: 'deny', cls: 'no' },
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = opt.label;
        button.className = opt.cls;
        button.onclick = async () => {
          await msg({ type: 'popup.accessResolve', id: item.id, allow: opt.allow, scope: opt.scope });
          void refresh();
        };
        buttons.append(button);
      }
      card.append(summary, document.createElement('br'), hint, buttons);
      return card;
    }),
    ...approvals.map((item) => {
      const card = document.createElement('div');
      card.className = 'pend';
      const summary = document.createElement('b');
      summary.textContent = item.key + ' wants to ' + item.summary;
      const buttons = document.createElement('div');
      buttons.className = 'btns';
      for (const allow of [true, false]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = allow ? 'Allow' : 'Deny';
        button.className = allow ? 'ok' : 'no';
        button.onclick = async () => {
          await msg({ type: 'popup.confirm', id: item.id, allow });
          void refresh();
        };
        buttons.append(button);
      }
      card.append(summary);
      if (item.url) {
        const url = document.createElement('small');
        url.textContent = item.url;
        card.append(document.createElement('br'), url);
      }
      card.append(buttons);
      return card;
    }),
  ];
  $('pending').hidden = !cards.length;
  $('pending').replaceChildren(...cards);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const s = await msg({ type: 'popup.status' });
    if (!s || s.error) return;
    const state = s.killed ? 'stopped' : s.relayState === 'untrusted' ? 'untrusted' : s.connected ? 'connected' : 'offline';
    $('st').dataset.state = state;
    $('st').textContent = { stopped: 'Agents stopped', untrusted: 'Untrusted relay', connected: 'Relay connected', offline: 'Relay offline' }[state];
    $('rc').hidden = state !== 'offline';
    const all = s.settings?.grantMode === 'all';
    const granted = s.granted.includes(tabId);
    $('grant').disabled = tabId == null || all;
    $('grant').textContent = all ? 'Agents can use every tab' : granted ? 'Revoke tab access' : 'Let agents use this tab';
    $('grant').onclick = async () => {
      await msg({ type: granted ? 'popup.revoke' : 'popup.grant', tabId });
      void refresh();
    };
    paintApprovals(s.pending, s.pendingAccess);
    const active = s.connected && !s.killed && tabId != null ? await msg({ type: 'popup.tabState', tabId }) : null;
    const releasable = tabId != null && (granted || !!active?.attached || (active?.state && active.state !== 'idle'));
    $('release').hidden = !releasable;
    $('release').disabled = !releasable;
    $('release').onclick = async () => {
      await msg({ type: 'popup.releaseTab', tabId });
      void refresh();
    };
    paintTask(active?.task, !!active?.error, active);
  } catch (error) {
    setNotice(error.message);
  } finally {
    refreshing = false;
  }
}

$('pause').onclick = async () => {
  changingPause = true;
  $('pause').disabled = true;
  setNotice();
  try {
    const result = await msg({ type: 'popup.pauseTab', tabId, pause: !paused });
    if (!result || result.error) throw new Error(result?.error || 'Could not change the pause state.');
  } catch (error) {
    setNotice(error.message);
  } finally {
    changingPause = false;
    void refresh();
  }
};
$('opts').onclick = () => chrome.runtime.openOptionsPage();
$('rc').onclick = async () => {
  await msg({ type: 'popup.reconnect' });
  void refresh();
};
$('openWorkspace').onclick = async () => {
  try {
    const url = new URL(chrome.runtime.getURL('workspace.html'));
    if (tabId != null && /^https?:/.test(tab.url || '')) url.searchParams.set('tab', String(tabId));
    await chrome.tabs.create({ url: url.href });
  } catch (error) {
    setNotice('Could not open the workspace. ' + error.message);
  }
};

// Testing tab: Click Test, Visual Check, and Code Check with Fix Immediately dropdowns, 1-page report download, and Display in chat.
import { TEST_SUITES, renderOnePageReportHtml, buildChatSummaryMessage } from './testing.js';

let currentReport = null;

function setTestNotice(text = '') {
  const el = $('testNotice');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
}

function switchPopupTab(which) {
  const isTesting = which === 'testing';
  $('tabControlBtn')?.classList.toggle('is-active', !isTesting);
  $('tabControlBtn')?.setAttribute('aria-selected', String(!isTesting));
  $('tabTestingBtn')?.classList.toggle('is-active', isTesting);
  $('tabTestingBtn')?.setAttribute('aria-selected', String(isTesting));
  if ($('tabControlPanel')) $('tabControlPanel').hidden = isTesting;
  if ($('tabTestingPanel')) $('tabTestingPanel').hidden = !isTesting;
}

$('tabControlBtn')?.addEventListener('click', () => switchPopupTab('control'));
$('tabTestingBtn')?.addEventListener('click', () => switchPopupTab('testing'));

function closeAllSplitMenus() {
  for (const m of document.querySelectorAll('.split-menu')) m.hidden = true;
  for (const b of document.querySelectorAll('[data-toggle-menu]')) b.setAttribute('aria-expanded', 'false');
}

for (const arrow of document.querySelectorAll('[data-toggle-menu]')) {
  arrow.addEventListener('click', (e) => {
    e.stopPropagation();
    const kind = arrow.dataset.toggleMenu;
    const menu = $('menu-' + kind);
    if (!menu) return;
    const willOpen = menu.hidden;
    closeAllSplitMenus();
    menu.hidden = !willOpen;
    arrow.setAttribute('aria-expanded', String(willOpen));
  });
}
document.addEventListener('click', () => closeAllSplitMenus());

function paintTestReport(report) {
  currentReport = report || null;
  const card = $('testReportCard');
  if (!card) return;
  if (!report) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const suite = TEST_SUITES[report.kind] || TEST_SUITES.click;
  $('reportBadge').textContent = suite.badge;
  $('reportHeading').textContent = `${suite.title} · ${report.title || 'Active page'}`;
  const pill = $('reportStatusPill');
  if (report.status === 'fixing') {
    pill.textContent = 'Fixing immediately';
    pill.dataset.state = 'active';
  } else if (report.status === 'approved') {
    pill.textContent = 'Approved & patching';
    pill.dataset.state = 'active';
  } else {
    pill.textContent = 'Await approval';
    pill.dataset.state = 'ready';
  }
  $('reportMetrics').innerHTML = [
    `<div class="report-metric"><span>Controls</span><b>${report.counts?.totalInteractive ?? 0}</b></div>`,
    `<div class="report-metric"><span>Findings</span><b>${report.counts?.issuesTotal ?? 0}</b></div>`,
    `<div class="report-metric"><span>High Sev</span><b>${report.counts?.high ?? 0}</b></div>`,
  ].join('');
  $('reportPlanList').innerHTML = (report.planSteps || []).map((p) => (
    `<li><b>[${esc(p.issueId)}]</b> ${esc(p.title)}<small>${esc(p.action)}</small></li>`
  )).join('');
  if ($('approveReportBtn')) {
    $('approveReportBtn').disabled = report.status === 'approved' || report.status === 'fixing';
    $('approveReportBtn').textContent = report.status === 'approved' || report.status === 'fixing' ? 'Approved & Sent' : 'Approve & Patch';
  }
}

for (const btn of document.querySelectorAll('[data-run-suite]')) {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeAllSplitMenus();
    const kind = btn.dataset.runSuite || 'click';
    const fixImmediately = btn.dataset.fixNow === 'true';
    const suite = TEST_SUITES[kind] || TEST_SUITES.click;
    setTestNotice(fixImmediately ? `Running ${suite.title} & dispatching immediate fix...` : `Running ${suite.title} & building plan...`);
    if ($('reportChatSummary')) $('reportChatSummary').hidden = true;
    try {
      const res = await msg({ type: 'testing.run', kind, tabId, fixImmediately });
      if (!res || res.error) throw new Error(res?.error || `Could not run ${suite.title}.`);
      paintTestReport(res.report);
      setTestNotice(
        fixImmediately
          ? `${suite.title} complete. Immediate fix instructions sent to the connected AI.`
          : `${suite.title} complete (${res.report.counts.issuesTotal} finding(s)). Review the plan below to approve or download.`
      );
    } catch (err) {
      setTestNotice(err.message);
    }
  });
}

$('approveReportBtn')?.addEventListener('click', async () => {
  if (!currentReport) return;
  setTestNotice('Approving remediation plan and instructing AI to patch...');
  try {
    const res = await msg({ type: 'testing.approve' });
    if (!res || res.error) throw new Error(res?.error || 'Could not approve report.');
    paintTestReport(res.report);
    setTestNotice('Remediation plan approved and dispatched to the connected AI agent.');
  } catch (err) {
    setTestNotice(err.message);
  }
});

$('displayInChatBtn')?.addEventListener('click', async () => {
  if (!currentReport) return;
  try {
    const res = await msg({ type: 'testing.displayInChat' });
    if (!res || res.error) throw new Error(res?.error || 'Could not display report in chat.');
    const box = $('reportChatSummary');
    if (box) {
      box.hidden = false;
      box.textContent = res.summary || buildChatSummaryMessage(currentReport);
    }
    setTestNotice(res.dispatched ? 'Summary posted to connected AI chat and displayed below.' : 'Summary displayed below (connect an AI agent to sync to chat).');
  } catch (err) {
    setTestNotice(err.message);
  }
});

$('downloadReportBtn')?.addEventListener('click', () => {
  if (!currentReport) return;
  const html = renderOnePageReportHtml(currentReport);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const slug = String(currentReport.title || currentReport.kind || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
  a.href = url;
  a.download = `luculent-${currentReport.kind}-report-${slug}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setTestNotice('Downloaded 1-page Luculent report.');
});

msg({ type: 'testing.getLatest' }).then((r) => {
  if (r && r.report) paintTestReport(r.report);
}).catch(() => {});

void refresh();
setInterval(refresh, 900);
