// Popup modes. Each mode owns a <section data-mode="...">. Only "driver" ships today; the planned "markup" editor
// registers here later and the mode bar appears automatically once there is more than one mode.
import { saveSettings } from './settings.js';
import { BANNER_Q, BANNER_TEXT } from './banner.js';
const MODES = [{ id: 'driver', label: 'Driver' }];
function showMode(id) {
  for (const sec of document.querySelectorAll('section[data-mode]')) sec.hidden = sec.dataset.mode !== id;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === id);
  chrome.storage.local.set({ popupMode: id });
}
const nav = document.getElementById('modes');
for (const m of MODES) { const b = document.createElement('button'); b.textContent = m.label; b.dataset.mode = m.id; b.onclick = () => showMode(m.id); nav.appendChild(b); }
nav.classList.toggle('single', MODES.length < 2);
chrome.storage.local.get(['popupMode'], (s) => showMode(MODES.some((m) => m.id === s.popupMode) ? s.popupMode : MODES[0].id));

const $ = (id) => document.getElementById(id);
const msg = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let tabId = null;
chrome.tabs.query({ active: true, currentWindow: true }, (t) => { tabId = t[0] ? t[0].id : null; refresh(); });

function line(e) {
  const when = (e.t || '').slice(11, 19);
  const what = e.actions ? e.actions.join(', ') : e.method || e.result;
  return `<div class="${e.result === 'denied' ? 'denied' : ''}">${esc(when)} <b>${esc(e.key || e.source || '')}</b> ${esc(what)} ${e.host ? esc(e.host) : ''} ${e.result && e.result !== 'ok' ? '- ' + esc(e.result) : ''}${e.reason ? ': ' + esc(e.reason) : ''}</div>`;
}

async function refresh() {
  const s = await msg({ type: 'popup.status' });
  if (!s) return;
  $('st').innerHTML = s.killed ? '<span class="dot" style="background:#dc2626"></span>stopped' : s.relayState === 'untrusted' ? '<span class="dot" style="background:#dc2626"></span>untrusted relay' : s.connected ? '<span class="dot" style="background:#16a34a"></span>connected' : '<span class="dot" style="background:#6b7280"></span>offline';
  $('at').textContent = s.attached;
  $('kill').textContent = s.killed ? 'Resume agents' : 'Killswitch: stop all agents';
  $('kill').classList.toggle('resume', !!s.killed);
  const all = s.settings && s.settings.grantMode === 'all';
  const g = all || (tabId != null && s.granted.includes(tabId));
  $('grant').textContent = all ? 'Agents can use every tab' : g ? 'Agents can use this tab (click to revoke)' : 'Let agents use this tab';
  $('grant').classList.toggle('on', g); $('grant').disabled = all;
  $('grantNote').textContent = all ? 'Change "Which tabs" in settings to grant tabs one by one.' : 'Agents only see tabs you grant here, plus tabs they open themselves.';
  if (s.settings) { $('q_readOnly').checked = s.settings.readOnly; $('q_passwords').checked = s.settings.passwords === 'allow'; $('q_eval').checked = s.settings.eval === 'allow'; }
  $('pending').innerHTML = s.pending.map((p) => `<div class="pend"><b>${esc(p.key)}</b> wants to ${esc(p.summary)}<br><small>${esc(p.url || '')}</small><div class="btns"><button class="ok" data-id="${esc(p.id)}" data-allow="1">Allow</button><button class="no" data-id="${esc(p.id)}">Deny</button></div></div>`).join('');
  const log = s.audit.slice(-8).reverse();
  $('log').innerHTML = log.length ? log.map(line).join('') : '<small>Nothing yet.</small>';
}
$('pending').onclick = async (e) => { const b = e.target.closest('button[data-id]'); if (!b) return; await msg({ type: 'popup.confirm', id: b.dataset.id, allow: !!b.dataset.allow }); refresh(); };
$('kill').onclick = async () => { const s = await msg({ type: 'popup.status' }); await msg({ type: s.killed ? 'popup.resume' : 'popup.kill' }); refresh(); };
$('rc').onclick = () => msg({ type: 'popup.reconnect' }).then(() => setTimeout(refresh, 400));
$('grant').onclick = async () => { const s = await msg({ type: 'popup.status' }); if (tabId == null) return; await msg({ type: s.granted.includes(tabId) ? 'popup.revoke' : 'popup.grant', tabId }); refresh(); };
$('q_readOnly').onchange = (e) => saveSettings({ readOnly: e.target.checked });
$('q_passwords').onchange = (e) => saveSettings({ passwords: e.target.checked ? 'allow' : 'deny' });
$('q_eval').onchange = (e) => saveSettings({ eval: e.target.checked ? 'allow' : 'deny' });
$('opts').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
setInterval(refresh, 1000);
const bh = $('bannerHelp');
const be = $('bannerExplain');
if (bh && be) {
  bh.textContent = BANNER_Q;
  be.textContent = BANNER_TEXT;
  bh.onclick = (e) => { e.preventDefault(); be.hidden = !be.hidden; };
}
const chatBtn = $('chat');
if (chatBtn) chatBtn.onclick = async () => {
  const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] }).then((w) => w.filter((x) => x.focused)).catch(() => []);
  const windowId = win ? win.id : (await chrome.windows.getCurrent()).id;
  try { await chrome.sidePanel.open({ windowId }); } catch (e) { be.hidden = false; be.textContent = 'Could not open the chat panel: ' + (e.message || e); }
};
const setupBtn = $('setup');
if (setupBtn) setupBtn.onclick = async () => { await msg({ type: 'popup.setup' }); refresh(); };
