// Local fixture site used by tests and the benchmark.
import http from 'node:http';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const PAGES = {
  '/': page('Home', `<h1>Fixture home</h1><nav><a href="/form">Form</a> <a href="/list">List</a> <a href="/search">Search</a> <a href="/dynamic">Dynamic</a></nav><p>Welcome to the fixture site.</p>`),
  '/form': page('Signup', `<h1>Sign up</h1>
    <form action="/done" method="get">
      <label for="name">Full name</label><input id="name" name="name">
      <label>Email <input type="email" name="email" placeholder="you@example.com"></label>
      <label for="plan">Plan</label><select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option><option value="biz">Business</option></select>
      <label><input type="checkbox" name="tos" id="tos"> I agree to the terms</label>
      <textarea name="notes" aria-label="Notes"></textarea>
      <button type="submit">Create account</button>
    </form>`),
  '/list': page('List', `<h1>Items</h1><ul id="items">${Array.from({ length: 50 }, (_, i) => `<li class="item"><a href="/item/${i + 1}">Item ${i + 1}</a> <span class="price">$${(i + 1) * 3}.00</span></li>`).join('')}</ul>`),
  '/search': page('Search', `<h1>Search</h1><input type="search" id="q" aria-label="Search query"><button id="go">Search</button><div id="results"></div>
    <script>
      const run = () => { const q = document.getElementById('q').value; setTimeout(() => { document.getElementById('results').innerHTML = ['alpha','beta','gamma'].map((w) => '<div class="result"><a href="/item/' + w + '">' + q + ' ' + w + '</a></div>').join(''); }, 120); };
      document.getElementById('go').onclick = run;
      document.getElementById('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    </script>`),
  '/dynamic': page('Dynamic', `<h1>Dynamic</h1><button id="load" onclick="setTimeout(()=>{const d=document.createElement('div');d.id='late';d.textContent='Loaded late';document.body.appendChild(d)},300)">Load</button><div id="counter">0</div>
    <script>let n=0; document.getElementById('counter').addEventListener('click',()=>{document.getElementById('counter').textContent=String(++n)});</script>`),
  '/upload': page('Upload', `<h1>Upload a file</h1><input type="file" id="file" aria-label="Choose file"><p id="picked">nothing picked</p>
    <script>document.getElementById('file').addEventListener('change', (e) => { const f = e.target.files[0]; f.text().then((t) => { document.getElementById('picked').textContent = 'picked ' + f.name + ' (' + t.trim() + ')'; }); });</script>`),
  '/shadow': page('Shadow', `<h1>Shadow</h1><x-card></x-card><script>customElements.define('x-card', class extends HTMLElement { connectedCallback(){ const r=this.attachShadow({mode:'open'}); r.innerHTML='<button id="sb">Shadow button</button><span id="out"></span>'; r.getElementById('sb').onclick=()=>{r.getElementById('out').textContent='clicked'}; } });</script>`),
};

export function startFixtures(port = 0) {
  const submissions = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/done') submissions.push(Object.fromEntries(u.searchParams));
    let html = PAGES[u.pathname];
    if (u.pathname === '/done') html = page('Done', `<h1>Account created</h1><p id="summary">${['name', 'email', 'plan', 'tos', 'notes'].map((k) => `${k}=${(u.searchParams.get(k) || '').replace(/[<>&]/g, '')}`).join(';')}</p>`);
    if (u.pathname.startsWith('/item/')) html = page('Item', `<h1>Item ${u.pathname.slice(6).replace(/[<>&]/g, '')}</h1><a href="/list">Back</a>`);
    if (!html) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, submissions, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}
