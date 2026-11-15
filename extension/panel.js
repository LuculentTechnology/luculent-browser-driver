// Side panel chat: talk to the agent driving this browser (LUC-3083, LUC-3084, LUC-3085).
import { loadNavMeta, saveNavMeta, CONSENT_TITLE, CONSENT_BODY, PRIVACY_POLICY_URL, toggleCaption } from './consent.js';
import { loadSettings, CLICK_MODES } from './settings.js';
const $ = (id) => document.getElementById(id);
const msg = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let section = 'active';
let currentId = null;

const pageParams = new URLSearchParams(location.search);
const inWorkspace = pageParams.get('workspace') === '1';
const rawTab = pageParams.get('tab');
const sourceTab = rawTab && /^\d+$/.test(rawTab) && Number.isSafeInteger(Number(rawTab)) ? Number(rawTab) : null;
document.body.classList.toggle('workspace-embedded', inWorkspace);
if (inWorkspace) {
  const navMeta = $('navMeta');
  const disclosure = document.createElement('details');
  disclosure.className = 'workspace-disclosure';
  const summary = document.createElement('summary');
  summary.textContent = 'Navigation metadata and privacy';
  navMeta.before(disclosure);
  disclosure.append(summary, navMeta);
}
if (inWorkspace && sourceTab == null) {
  $('pull').disabled = true;
  $('pull').title = 'Open the workspace from a web page to pull its context';
  $('chipRefresh').disabled = true;
}

function paintStatus(s) {
  const on = s && s.connected && !s.killed;
  $('st').querySelector('.dot').style.background = s && s.killed ? '#FF5C7A' : on ? '#4ADE80' : '#7A7A80';
  $('stText').textContent = s && s.killed ? 'stopped' : on ? 'connected' : (s && s.relayState === 'untrusted' ? 'untrusted relay' : 'offline');
  $('kill').textContent = s && s.killed ? 'Resume' : 'Killswitch';
  $('kill').classList.toggle('resume', !!(s && s.killed));
  const cm = $('clickMode');
  if (cm && s && s.settings && document.activeElement !== cm) cm.value = CLICK_MODES.includes(s.settings.clickMode) ? s.settings.clickMode : 'cowork';
}

function paintInteraction(it) {
  const el = $('cowork');
  if (!el) return;
  const state = it && it.state;
  if (state === 'paused' && it.paused) {
    el.hidden = false;
    el.className = 'cowork-note paused';
    el.innerHTML = '<span class="dot"></span><span class="txt"><b>Paused</b><small>You clicked in the AI\u2019s tab. It continues from the page as you leave it.</small></span><button type="button" id="userResume" class="primary">Resume</button>';
    $('userResume').onclick = async () => { await msg({ type: 'panel.resumeUser' }); refresh(); };
  } else if (state === 'cowork' && it.active) {
    el.hidden = false;
    el.className = 'cowork-note';
    el.innerHTML = '<span class="dot"></span><span class="txt"><b>You\u2019re coworking</b><small>The AI waits, then continues from where you leave it.</small></span>';
  } else if (state === 'resumed' || (state === 'cowork' && !it.active)) {
    el.hidden = false;
    el.className = 'cowork-note';
    el.innerHTML = '<span class="dot"></span><span class="txt"><b>The AI picks up from here</b><small>It re-read the page after your help.</small></span>';
  } else {
    el.hidden = true;
    el.innerHTML = '';
  }
}

function paintChat(view) {
  if (!view) {
    $('chatName').textContent = 'No agent connected';
    $('provider').textContent = '';
    $('model').textContent = '';
    $('chip').hidden = true;
    return;
  }
  currentId = view.id;
  $('chatName').textContent = view.chatName || view.label || 'Agent';
  $('provider').textContent = view.provider || '';
  $('model').textContent = view.model ? ((view.provider ? ' · ' : '') + view.model) : '';
  if (view.chip && view.pageContext) {
    $('chip').hidden = false;
    $('chipLabel').textContent = 'Page context: ' + view.chip.title;
  } else {
    $('chip').hidden = true;
  }
  const log = $('log');
  const msgs = view.messages || [];
  log.innerHTML = msgs.length
    ? msgs.map((m) => `<div class="msg ${esc(m.from)}"><div class="who">${esc(m.from)}${m.kind === 'page-context' ? ' · page context' : ''}</div>${esc(m.text).replace(/\n/g, '<br>')}</div>`).join('')
    : '<div class="empty">No messages yet. Send a note, or pull the page context.</div>';
  log.scrollTop = log.scrollHeight;
}

function paintList(sections) {
  const items = (sections && sections[section]) || [];
  $('list').innerHTML = items.length ? items.map((c) => {
    const title = esc(c.chatName || c.keyName || 'Agent');
    const meta = esc([c.provider, c.model].filter(Boolean).join(' · '));
    const acts = section === 'saved'
      ? `<button data-act="open" data-id="${esc(c.id)}">Open</button><button data-act="delete" data-id="${esc(c.id)}">Delete</button>`
      : `<button data-act="open" data-id="${esc(c.id)}">Open</button><button data-act="save" data-id="${esc(c.id)}">Save</button><button data-act="delete" data-id="${esc(c.id)}">Delete</button>`;
    return `<div class="row${c.id === currentId ? ' on' : ''}"><b title="${meta}">${title}</b><span>${acts}</span></div>`;
  }).join('') : `<div class="empty">No ${section} chats.</div>`;
  const sel = $('sessions');
  const all = [...(sections?.active || []), ...(sections?.closed || []), ...(sections?.saved || [])];
  sel.innerHTML = all.length ? all.map((c) => `<option value="${esc(c.id)}"${c.id === currentId ? ' selected' : ''}>${esc(c.status)} — ${esc(c.chatName || c.keyName || 'Agent')}</option>`).join('') : '<option value="">No sessions</option>';
}

function paintPause(p) {
  const el = $('pause');
  if (!p) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<b>The agent needs you</b><div>${esc(p.reason || 'CAPTCHA or 2FA')}</div><small>${esc(p.message || 'Clear it in the tab, then resume.')}</small><div style="margin-top:6px;display:flex;gap:6px"><button id="pauseResume">Resume</button></div>`;
  $('pauseResume').onclick = async () => { await msg({ type: 'panel.resume', id: p.id, text: $('in').value }); $('in').value = ''; refresh(); };
}


function paintPlan(plan) {
  const el = $('plan');
  if (!el) return;
  if (!plan || !plan.steps || !plan.steps.length) { el.hidden = true; return; }
  el.hidden = false;
  const goal = $('planGoal');
  if (goal) goal.textContent = plan.goal || plan.status || '';
  const ol = $('planSteps');
  if (ol) {
    ol.innerHTML = plan.steps.map((s) => {
      const st = s.status || 'pending';
      const conf = s.confirm && s.confirm.matched === false ? ' miss' : '';
      const extra = s.confirm && s.confirm.ms != null ? ' (' + s.confirm.ms + 'ms confirm)' : '';
      return '<li class="' + st + conf + '">' + esc((s.label || s.action || ('step ' + s.i)) + extra) + '</li>';
    }).join('');
  }
  const ev = $('planEvent');
  if (ev) {
    const e = plan.lastEvent;
    if (e && (e.event === 'replan' || e.event === 'step-failed')) {
      ev.hidden = false;
      ev.textContent = e.event === 'replan' ? ('Plan adjusted: ' + (e.reason || 'the page was not what we expected')) : ('Step failed: ' + (e.error || ''));
    } else ev.hidden = true;
  }
}

async function refresh() {
  const s = await msg({ type: 'popup.status' });
  paintStatus(s);
  const data = await msg({ type: 'panel.state', id: currentId });
  if (data && data.sections) paintList(data.sections);
  if (data && data.view) paintChat(data.view);
  else if (data && data.sections) {
    const first = (data.sections.active || [])[0] || (data.sections.closed || [])[0] || (data.sections.saved || [])[0];
    if (first) {
      currentId = first.id;
      const one = await msg({ type: 'panel.state', id: currentId });
      if (one && one.view) paintChat(one.view);
    } else paintChat(null);
  }
  paintPause(data && data.pause);
  paintInteraction(data && data.interaction);
  paintPlan(data && data.plan);
  await paintNavMeta();
}

async function paintNavMeta() {
  const nav = await loadNavMeta();
  $('navMetaTitle').textContent = CONSENT_TITLE;
  $('navMetaCaption').textContent = toggleCaption(nav);
  $('navMetaOn').checked = !!nav.consented;
  $('navMetaPrivacy').href = PRIVACY_POLICY_URL;
  $('navMetaBody').textContent = nav.seenDisclaimer ? '' : CONSENT_BODY;
}

$('navMetaOn').onchange = async () => {
  await saveNavMeta({ consented: $('navMetaOn').checked, setByUser: true, seenDisclaimer: true });
  paintNavMeta();
};

for (const b of document.querySelectorAll('#sects button')) {
  b.onclick = () => {
    section = b.dataset.sec;
    for (const x of document.querySelectorAll('#sects button')) x.classList.toggle('on', x === b);
    refresh();
  };
}
$('sessions').onchange = () => { currentId = $('sessions').value || null; refresh(); };
$('list').onclick = async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.act === 'open') currentId = id;
  if (b.dataset.act === 'save') await msg({ type: 'panel.save', id });
  if (b.dataset.act === 'delete') { await msg({ type: 'panel.delete', id }); if (currentId === id) currentId = null; }
  refresh();
};
$('kill').onclick = async () => { const s = await msg({ type: 'popup.status' }); await msg({ type: s.killed ? 'popup.resume' : 'popup.kill' }); refresh(); };
$('clickMode').onchange = async () => { await msg({ type: 'panel.clickMode', mode: $('clickMode').value }); refresh(); };
loadSettings().then((s) => { $('clickMode').value = s.clickMode || 'cowork'; }).catch(() => {});
async function pullContext() {
  if (inWorkspace && sourceTab == null) return;
  const result = await msg({ type: 'panel.pull', ...(inWorkspace ? { tabId: sourceTab } : {}) });
  if (result?.error) {
    $('log').insertAdjacentHTML('beforeend', `<div class="msg system">${esc(result.error)}</div>`);
    return;
  }
  refresh();
}
$('pull').onclick = pullContext;
$('chipRefresh').onclick = pullContext;
$('chipRemove').onclick = () => msg({ type: 'panel.clearContext', id: currentId }).then(refresh);
$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('in').value.trim();
  if (!text) return;
  $('in').value = '';
  await msg({ type: 'panel.post', id: currentId, text });
  refresh();
};
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m && (m.type === 'panel.sync' || m.type === 'panel.pause')) refresh();
  if (m && m.type === 'panel.clickPull' && !inWorkspace) {
    const b = $('pull');
    if (b) b.click();
    if (typeof send === 'function') send({ ok: true });
    return true;
  }
});
setInterval(refresh, 2000);
refresh();
