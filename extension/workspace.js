const params = new URLSearchParams(location.search);
const rawTab = params.get('tab');
const sourceTab = rawTab && /^\d+$/.test(rawTab) && Number.isSafeInteger(Number(rawTab)) ? rawTab : null;
const chat = document.getElementById('chatFrame');
const settings = document.getElementById('settingsFrame');
const chatLink = document.getElementById('chatLink');
const settingsLink = document.getElementById('settingsLink');
const chatUrl = new URL('panel.html', location.href);
chatUrl.searchParams.set('workspace', '1');
if (sourceTab !== null) chatUrl.searchParams.set('tab', sourceTab);
chat.src = chatUrl.href;

function showView() {
  const showSettings = location.hash === '#settings';
  chat.hidden = showSettings;
  settings.hidden = !showSettings;
  if (showSettings && settings.getAttribute('src') === 'about:blank') settings.src = 'options.html';
  if (showSettings) {
    chatLink.removeAttribute('aria-current');
    settingsLink.setAttribute('aria-current', 'page');
  } else {
    settingsLink.removeAttribute('aria-current');
    chatLink.setAttribute('aria-current', 'page');
  }
}

addEventListener('hashchange', showView);
showView();
