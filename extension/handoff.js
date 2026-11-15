import { exchangeHandoffCode, pullAndApply } from './account-sync.js';
import { loadSettings, saveSettings } from './settings.js';
import { loadNavMeta, saveNavMeta } from './consent.js';

const st = document.getElementById('st');
const code = new URLSearchParams(location.search).get('code') || '';
if (!code) {
  st.textContent = 'No sign-in code was provided. Open Sign in to sync from the extension and try again.';
} else {
  exchangeHandoffCode(code, 'Chrome')
    .then(() => pullAndApply({ loadSettings, saveSettings, loadNavMeta, saveNavMeta }))
    .then(() => { st.textContent = 'Signed in. Settings will sync on this browser. You can close this tab.'; })
    .catch((err) => { st.textContent = err.message || 'Sign-in failed.'; });
}
