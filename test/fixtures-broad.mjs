// Local fixtures for risky or hard-to-find flows used by the broad suite (harness/broad.mjs) and security tests.
// Two servers: `a` (127.0.0.1) and `b` (localhost, a different site) so cross-origin iframes run out of process.
import http from 'node:http';

const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const esc = (s) => String(s || '').replace(/[<>&"]/g, '');

function wav(seconds = 2) {
  const rate = 8000, n = rate * seconds, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(20 * Math.sin(i / 8));
  return b;
}
function pdf() {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = 'BT /F1 18 Tf 20 80 Td (LBD fixture PDF) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function pagesFor(other) {
  return {
    '/frame-inner': page('Inner', `<h2 id="h">Inner frame</h2><input id="fi" aria-label="Frame input"><button id="fb" onclick="document.getElementById('fo').textContent='frame clicked '+document.getElementById('fi').value">Frame button</button><p id="fo"></p>`),
    '/iframes': page('Iframes', `<h1>Iframes</h1><iframe id="same" name="same" src="/frame-inner" width="400" height="160"></iframe><iframe id="cross" name="cross" src="${other}/frame-inner?x=1" width="400" height="160"></iframe>`),
    '/editor': page('Editor', `<h1>Editor</h1><div id="ed" contenteditable="true" aria-label="Rich editor" style="border:1px solid #999;min-height:60px"></div><pre id="html"></pre>
      <script>const ed=document.getElementById('ed');document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='b'){document.execCommand('bold');e.preventDefault();}});ed.addEventListener('input',()=>{document.getElementById('html').textContent=ed.innerHTML;});</script>`),
    '/dnd': page('Drag', `<h1>Drag and drop</h1><div id="src" draggable="true" style="width:80px;height:40px;background:#9cf">Drag me</div><div id="dst" style="width:160px;height:80px;margin-top:20px;background:#fc9">Drop here</div>
      <div id="track" style="position:relative;width:300px;height:20px;background:#eee;margin-top:20px"><div id="knob" style="position:absolute;left:0;width:20px;height:20px;background:#333"></div></div><p id="kv">0</p>
      <script>const s=document.getElementById('src'),d=document.getElementById('dst');s.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','src'));d.addEventListener('dragover',e=>e.preventDefault());d.addEventListener('drop',e=>{e.preventDefault();d.textContent='Dropped '+e.dataTransfer.getData('text/plain');});
      const k=document.getElementById('knob'),t=document.getElementById('track');let drag=false;k.addEventListener('mousedown',()=>drag=true);addEventListener('mouseup',()=>drag=false);addEventListener('mousemove',e=>{if(!drag)return;const x=Math.max(0,Math.min(280,e.clientX-t.getBoundingClientRect().left-10));k.style.left=x+'px';document.getElementById('kv').textContent=String(Math.round(x));});</script>`),
    '/hover': page('Hover', `<style>#menu .sub{display:none}#menu:hover .sub{display:block}</style><h1>Hover menu</h1><div id="menu" style="width:120px">Products<div class="sub"><a href="/item/hovered">Laptops</a></div></div>`),
    '/date': page('Date', `<h1>Dates</h1><label>Native <input type="date" id="native"></label><label>Custom <input id="custom" readonly placeholder="Pick a date"></label><div id="cal" hidden role="grid"></div><p id="out"></p>
      <script>const c=document.getElementById('custom'),cal=document.getElementById('cal');c.onclick=()=>{cal.hidden=false;cal.innerHTML=Array.from({length:30},(_,i)=>'<button class="day" role="gridcell">'+(i+1)+'</button>').join('');};cal.onclick=(e)=>{if(e.target.classList.contains('day')){c.value='2026-11-'+e.target.textContent.padStart(2,'0');cal.hidden=true;document.getElementById('out').textContent='picked '+c.value;}};document.getElementById('native').onchange=e=>document.getElementById('out').textContent='native '+e.target.value;</script>`),
    '/combo': page('Combo', `<h1>Combobox</h1><input id="cb" role="combobox" aria-label="Country" aria-expanded="false" autocomplete="off"><ul id="lb" role="listbox" hidden></ul><p id="out"></p>
      <script>const C=['Canada','Chile','China','Colombia','Croatia'];const cb=document.getElementById('cb'),lb=document.getElementById('lb');cb.addEventListener('input',()=>{const v=cb.value.toLowerCase();const m=C.filter(c=>c.toLowerCase().startsWith(v));lb.innerHTML=m.map(c=>'<li role="option">'+c+'</li>').join('');lb.hidden=!m.length;cb.setAttribute('aria-expanded',String(!!m.length));});lb.addEventListener('click',e=>{if(e.target.getAttribute('role')==='option'){cb.value=e.target.textContent;lb.hidden=true;document.getElementById('out').textContent='chose '+cb.value;}});</script>`),
    '/modal': page('Modal', `<h1>Modal page</h1><button id="open">Open dialog</button><p id="out">none</p>
      <div id="cookie" style="position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:end;justify-content:center"><div style="background:#fff;padding:20px">We use cookies <button id="accept">Accept all</button></div></div>
      <dialog id="dlg"><p>Are you sure?</p><button id="yes">Yes</button></dialog>
      <script>document.getElementById('accept').onclick=()=>document.getElementById('cookie').remove();document.getElementById('open').onclick=()=>document.getElementById('dlg').showModal();document.getElementById('yes').onclick=()=>{document.getElementById('dlg').close();document.getElementById('out').textContent='confirmed';};</script>`),
    '/popup': page('Popup', `<h1>Popups</h1><button id="wo" onclick="window.open('/item/popup','_blank')">Open window</button><a id="blank" href="/item/blank" target="_blank">New tab link</a>`),
    '/login': page('Login', `<h1>Sign in</h1><form action="/welcome" method="post"><label>Username <input name="user" autocomplete="username"></label><label>Password <input type="password" name="pass" autocomplete="current-password"></label><button>Sign in</button></form>`),
    '/upload': page('Upload', `<h1>Upload</h1><label>Attachment <input type="file" id="up" onchange="document.getElementById('out').textContent=[...this.files].map(f=>f.name).join(',')"></label><p id="out"></p>`),
    '/prefilled': page('Prefilled', `<h1>Saved login</h1><form action="/welcome" method="post"><input name="user" value="ada"><input type="password" id="pw" name="pass" value="hunter2"><button>Go</button></form>`),
    '/checkout': page('Checkout', `<h1>Checkout</h1><form action="/paid" method="post"><label>Card number <input name="cc" autocomplete="cc-number"></label><label>CVC <input name="cvc" autocomplete="cc-csc"></label><button>Pay now</button></form>`),
    '/slow-form': page('Slow form', `<h1>Slow form</h1><form action="/slow" method="get"><input name="q" aria-label="Query"><input type="hidden" name="ms" value="2600"><button>Send</button></form><a id="slowlink" href="/slow?ms=3000&q=link">Slow link</a>`),
    '/canvas': page('Canvas', `<h1>Canvas</h1><canvas id="cv" width="300" height="200" style="border:1px solid #000"></canvas><p id="out"></p>
      <script>const cv=document.getElementById('cv');cv.addEventListener('click',e=>{const r=cv.getBoundingClientRect();document.getElementById('out').textContent='hit '+Math.round(e.clientX-r.left)+','+Math.round(e.clientY-r.top);});cv.addEventListener('wheel',e=>{e.preventDefault();document.getElementById('out').textContent='wheel '+(e.deltaY>0?'down':'up');},{passive:false});</script>`),
    '/video': page('Video', `<h1>Video</h1><video id="v" src="/tone.wav" muted controls width="300"></video><button id="play" onclick="document.getElementById('v').play()">Play</button><button id="pause" onclick="document.getElementById('v').pause()">Pause</button>`),
    '/keys': page('Keys', `<h1>Shortcuts</h1><div id="palette" hidden role="dialog">Command palette</div><p id="last"></p>
      <script>addEventListener('keydown',e=>{document.getElementById('last').textContent=(e.ctrlKey?'Ctrl+':'')+(e.shiftKey?'Shift+':'')+(e.altKey?'Alt+':'')+e.key;if(e.ctrlKey&&e.key==='k'){e.preventDefault();document.getElementById('palette').hidden=false;}if(e.key==='Escape')document.getElementById('palette').hidden=true;});</script>`),
    '/table': page('Table', `<h1>Big table</h1><table id="t"><thead><tr><th>ID</th><th>Name</th><th>Price</th></tr></thead><tbody>${Array.from({ length: 1500 }, (_, i) => `<tr><td>${i + 1}</td><td>Product ${i + 1}</td><td>$${((i + 1) * 1.25).toFixed(2)}</td></tr>`).join('')}</tbody></table><footer id="end">End of table</footer>`),
    '/infinite': page('Infinite', `<h1>Feed</h1><div id="feed"></div><script>let n=0;const f=document.getElementById('feed');const more=()=>{for(let i=0;i<20;i++){const d=document.createElement('div');d.className='post';d.style.height='60px';d.textContent='Post '+(++n);f.appendChild(d);}};more();addEventListener('scroll',()=>{if(innerHeight+scrollY>=document.body.scrollHeight-200&&n<200)setTimeout(more,150);});</script>`),
    '/validate': page('Validate', `<h1>Register</h1><form id="f" novalidate action="/done" method="get"><label>Email <input id="em" name="email" type="email" required></label><label>Age <input id="age" name="notes" type="number" min="18" required></label><button>Register</button></form><ul id="errs"></ul>
      <script>document.getElementById('f').addEventListener('submit',e=>{const errs=[];const em=document.getElementById('em'),age=document.getElementById('age');if(!em.checkValidity())errs.push('Enter a valid email');if(!age.checkValidity())errs.push('You must be 18+');if(errs.length){e.preventDefault();document.getElementById('errs').innerHTML=errs.map(x=>'<li class="err">'+x+'</li>').join('');}});</script>`),
    '/download': page('Download', `<h1>Download</h1><a id="dl" href="/file.csv">Get CSV</a> <a id="pdf" href="/doc.pdf">Open PDF</a>`),
    '/geo': page('Geo', `<h1>Where am I</h1><button id="loc">Locate me</button><p id="out"></p><script>document.getElementById('loc').onclick=()=>navigator.geolocation.getCurrentPosition(p=>{document.getElementById('out').textContent='at '+p.coords.latitude.toFixed(3)+','+p.coords.longitude.toFixed(3);},e=>{document.getElementById('out').textContent='geo error '+e.code;},{timeout:4000});</script>`),
    '/spa': page('SPA', `<nav><a href="/spa/home" data-r>Home</a> <a href="/spa/about" data-r>About</a> <a href="/spa/contact" data-r>Contact</a></nav><main id="view"></main>
      <script>const R={'/spa/home':'Home view','/spa/about':'About view','/spa/contact':'Contact view'};const show=()=>{document.getElementById('view').innerHTML='<h1>'+(R[location.pathname]||'Home view')+'</h1>';document.title=(R[location.pathname]||'Home view');};document.addEventListener('click',e=>{const a=e.target.closest('a[data-r]');if(a){e.preventDefault();setTimeout(()=>{history.pushState({},'',a.getAttribute('href'));show();},80);}});addEventListener('popstate',show);show();</script>`),
    '/dialogs': page('Dialogs', `<h1>Dialogs</h1><button id="al" onclick="alert('hello');document.getElementById('out').textContent='after alert'">Alert</button><button id="cf" onclick="document.getElementById('out').textContent='confirm '+confirm('ok?')">Confirm</button><button id="pr" onclick="document.getElementById('out').textContent='prompt '+prompt('name?','x')">Prompt</button><p id="out"></p>`),
    '/shadow-deep': page('Shadow deep', `<h1>Nested shadow</h1><outer-el></outer-el><script>customElements.define('inner-el',class extends HTMLElement{connectedCallback(){const r=this.attachShadow({mode:'open'});r.innerHTML='<input id="deep" aria-label="Deep input"><button id="deepb">Deep go</button><p id="deepo"></p>';r.getElementById('deepb').onclick=()=>{r.getElementById('deepo').textContent='deep '+r.getElementById('deep').value;};}});customElements.define('outer-el',class extends HTMLElement{connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<div><inner-el></inner-el></div>';}});</script>`),
    '/lazy': page('Lazy', `<h1>Lazy</h1><div id="slot">loading...</div><script>setTimeout(()=>{document.getElementById('slot').innerHTML='<button id="late">Late button</button>';document.getElementById('late').onclick=()=>{document.getElementById('slot').insertAdjacentHTML('beforeend','<p id="res">late clicked</p>')};},1800);</script>`),
    '/context': page('Context', `<h1>Context menu</h1><div id="hot" style="width:200px;height:60px;background:#ddd">Right click me</div><p id="out"></p><script>document.getElementById('hot').addEventListener('contextmenu',e=>{e.preventDefault();document.getElementById('out').textContent='context menu';});</script>`),
  };
}

function handler(other, submissions) {
  const PAGES = pagesFor(other);
  return async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    if (req.method === 'POST') for await (const c of req) body += c;
    const send = (code, type, data, extra = {}) => { res.writeHead(code, { 'content-type': type, ...extra }); res.end(data); };
    if (u.pathname === '/tone.wav') return send(200, 'audio/wav', wav());
    if (u.pathname === '/doc.pdf') return send(200, 'application/pdf', pdf());
    if (u.pathname === '/file.csv') return send(200, 'text/csv', 'id,name\n1,alpha\n2,beta\n', { 'content-disposition': 'attachment; filename="lbd-test.csv"' });
    if (u.pathname === '/slow') { await new Promise((r) => setTimeout(r, Math.min(Number(u.searchParams.get('ms')) || 2500, 8000))); return send(200, 'text/html; charset=utf-8', page('Slow done', `<h1 id="slowdone">Slow done ${esc(u.searchParams.get('q'))}</h1>`)); }
    if (u.pathname === '/welcome' || u.pathname === '/paid') { const p = Object.fromEntries(new URLSearchParams(body)); submissions.push({ path: u.pathname, ...p }); return send(200, 'text/html; charset=utf-8', page('Posted', `<h1 id="posted">${u.pathname === '/paid' ? 'Paid' : 'Welcome ' + esc(p.user)}</h1>`)); }
    if (u.pathname === '/done') { submissions.push({ path: '/done', ...Object.fromEntries(u.searchParams) }); return send(200, 'text/html; charset=utf-8', page('Done', `<h1 id="done">Registered ${esc(u.searchParams.get('email'))}</h1>`)); }
    if (u.pathname.startsWith('/item/')) return send(200, 'text/html; charset=utf-8', page('Item', `<h1>Item ${esc(u.pathname.slice(6))}</h1>`));
    if (u.pathname.startsWith('/spa')) return send(200, 'text/html; charset=utf-8', PAGES['/spa']);
    const html = PAGES[u.pathname];
    if (!html) return send(404, 'text/plain', 'nope');
    send(200, 'text/html; charset=utf-8', html);
  };
}

export async function startBroadFixtures() {
  const submissions = [];
  const listen = (srv, host) => new Promise((r) => srv.listen(0, host, () => r(srv.address().port)));
  const sa = http.createServer(), sb = http.createServer();
  const pa = await listen(sa, '127.0.0.1');
  const pb = await listen(sb, '127.0.0.1');
  const a = `http://127.0.0.1:${pa}`, b = `http://localhost:${pb}`;
  sa.on('request', handler(b, submissions));
  sb.on('request', handler(a, submissions));
  return { a, b, submissions, close: () => Promise.all([sa, sb].map((s) => new Promise((c) => { s.closeAllConnections?.(); s.close(c); }))) };
}