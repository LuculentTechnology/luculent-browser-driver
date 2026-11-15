import { loadSettings, saveSettings } from './settings.js';
import { loadAccount, openSignIn, signOutLocal } from './account-sync.js';
import { loadNavMeta, saveNavMeta, CONSENT_TITLE, CONSENT_BODY, PRIVACY_POLICY_URL, toggleCaption } from './consent.js';
import { playPingSound } from './ping.js';
const $ = (id) => document.getElementById(id);
const msg = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
for (const sel of document.querySelectorAll('select[data-lv]')) sel.innerHTML = '<option value="deny">Block</option><option value="confirm">Ask me each time</option><option value="allow">Allow</option>';
for (const sel of document.querySelectorAll('select[data-lv2]')) sel.innerHTML = '<option value="deny">Block</option><option value="allow">Allow</option>';
const get = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);

async function fill() {
  const s = await loadSettings();
  for (const el of document.querySelectorAll('[data-k]')) {
    const v = get(s, el.dataset.k);
    if (el.type === 'checkbox') el.checked = !!v;
    else if ('list' in el.dataset) el.value = (v || []).join('\n');
    else el.value = v;
  }
  const { relayUrl } = await chrome.storage.local.get(['relayUrl']);
  $('url').value = relayUrl || '';
  const nav = await loadNavMeta();
  $('navMetaTitle').textContent = CONSENT_TITLE;
  $('navMetaBody').textContent = CONSENT_BODY;
  $('navMetaCaption').textContent = toggleCaption(nav);
  $('navMetaOn').checked = !!nav.consented;
  $('navMetaPrivacy').href = PRIVACY_POLICY_URL;
}
$('navMetaOn').addEventListener('change', async () => {
  const nav = await saveNavMeta({ consented: $('navMetaOn').checked, setByUser: true, seenDisclaimer: true });
  $('navMetaCaption').textContent = toggleCaption(nav);
  $('saved').textContent = 'Saved';
  setTimeout(() => { $('saved').textContent = ''; }, 1200);
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (!el.dataset || !el.dataset.k) return;
  const k = el.dataset.k;
  let v = el.type === 'checkbox' ? el.checked : 'list' in el.dataset ? el.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : el.type === 'number' ? Number(el.value) : el.value;
  let patch = { [k]: v };
  if (k.includes('.')) { const [a, b] = k.split('.'); const s = await loadSettings(); patch = { [a]: { ...s[a], [b]: v } }; }
  await saveSettings(patch);
  $('saved').textContent = 'Saved'; setTimeout(() => { $('saved').textContent = ''; }, 1200);
  renderTabs();
});
$('url').onchange = () => chrome.storage.local.set({ relayUrl: $('url').value.trim() || undefined });
if ($('testPing')) $('testPing').onclick = () => { void playPingSound($('pingSound')?.value || 'chime'); };
$('repair').onclick = async () => { await msg({ type: 'popup.repair' }); $('repair').textContent = 'Re-paired'; };
$('kill').onclick = async () => { const s = await msg({ type: 'popup.status' }); await msg({ type: s.killed ? 'popup.resume' : 'popup.kill' }); render(); };

async function renderTabs() {
  const s = await msg({ type: 'popup.status' });
  const tabs = await chrome.tabs.query({});
  if (s.settings.grantMode === 'all') { $('tabs').innerHTML = '<small>Every tab is available to agents.</small>'; return; }
  $('tabs').innerHTML = '<div style="padding-top:8px"><b>Granted tabs</b></div>' + tabs.filter((t) => !/^chrome-extension:/.test(t.url || '')).map((t) => `<label><input type="checkbox" data-tab="${t.id}" ${s.granted.includes(t.id) ? 'checked' : ''}> ${esc((t.title || t.url || '').slice(0, 80))}</label>`).join('');
}
$('tabs').addEventListener('change', async (e) => { const id = Number(e.target.dataset.tab); if (!id) return; e.stopPropagation(); await msg({ type: e.target.checked ? 'popup.grant' : 'popup.revoke', tabId: id }); });

async function render() {
  const s = await msg({ type: 'popup.status' });
  if (!s) return;
  $('kill').textContent = s.killed ? 'Resume agents' : 'Stop all agents';
  $('kill').classList.toggle('resume', !!s.killed);
  const log = s.audit.slice().reverse();
  $('log').innerHTML = log.length ? log.map((e) => `<div class="${e.result === 'denied' ? 'denied' : ''}">${esc((e.t || '').replace('T', ' ').slice(0, 19))} ${esc(e.key || e.source || '')} ${esc(e.actions ? e.actions.join(',') : e.method || '')} ${esc(e.host || '')} ${esc(e.result || '')} ${esc(e.reason || '')}</div>`).join('') : '<small>Nothing yet.</small>';
}
fill(); renderTabs(); render(); setInterval(render, 1500);
async function renderAccount() {
  const rec = await loadAccount();
  const status = document.getElementById('accountStatus');
  const signIn = document.getElementById('accountSignIn');
  const signOut = document.getElementById('accountSignOut');
  if (!status || !signIn || !signOut) return;
  if (rec) {
    status.innerHTML = '<small>Signed in. Settings sync to this Luculent account.</small>';
    signIn.hidden = true;
    signOut.hidden = false;
  } else {
    status.innerHTML = '<small>Not signed in. Settings stay on this browser.</small>';
    signIn.hidden = false;
    signOut.hidden = true;
  }
}
const accountSignIn = document.getElementById('accountSignIn');
const accountSignOut = document.getElementById('accountSignOut');
if (accountSignIn) accountSignIn.onclick = () => openSignIn();
if (accountSignOut) accountSignOut.onclick = async () => { await signOutLocal(); renderAccount(); };
renderAccount();
