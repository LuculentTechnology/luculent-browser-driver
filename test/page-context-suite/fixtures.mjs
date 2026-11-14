// Local pages for the Pull page context suite: password forms, iframes, shadow DOM, infinite scroll, huge pages, PDFs.
import http from 'node:http';

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function pdf() {
  const stream = 'BT /F1 18 Tf 20 80 Td (LBD page context fixture PDF) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const start = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offs.forEach((n) => { out += `${String(n).padStart(10, '0')} 00000 n \n`; });
  out += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return out;
}

const HUGE = ('BEGIN-HUGE-MARKER ' + ('The analytical engine weaves algebraic patterns. '.repeat(50)) + ' ').repeat(80);

function pagesFor(other) {
  return {
    '/login': page('Sign in', `<nav>Home About Help</nav><h1>Sign in</h1><form>
      <label>Username <input name="user" value="tester"></label>
      <label>Password <input type="password" name="pass" value="super-secret-pass" autocomplete="current-password"></label>
      <button type="submit">Sign in</button>
    </form><p>Welcome back. Use your account to continue.</p>`),
    '/iframes': page('Iframe host', `<h1>Iframe host</h1><p>Outer article text.</p><iframe id="same" src="/iframe-inner" style="width:400px;height:200px"></iframe>`),
    '/iframe-inner': page('Iframe inner', `<h2>Inner frame</h2><p>IFRAME-MAIN-CONTENT lives only in the frame.</p>`),
    '/shadow': page('Shadow demo', `<h1>Shadow host page</h1><p>Light DOM intro.</p><shadow-box></shadow-box>
      <script>
        customElements.define('shadow-box', class extends HTMLElement {
          connectedCallback() {
            const r = this.attachShadow({ mode: 'open' });
            r.innerHTML = '<h2>Inside shadow</h2><p>SECRET-SHADOW-CONTENT is in the open root.</p>';
          }
        });
      </script>`),
    '/infinite': page('Feed', `<h1>Feed</h1><div id="feed"></div>
      <script>
        let n = 0;
        const f = document.getElementById('feed');
        const more = () => { for (let i = 0; i < 20; i++) { n++; const d = document.createElement('div'); d.className = 'post'; d.textContent = 'Post ' + n; f.appendChild(d); } };
        more();
        window.addEventListener('scroll', () => { if (window.scrollY + window.innerHeight > document.body.scrollHeight - 200) more(); });
      </script>`),
    '/huge': page('Huge article', `<nav>Skip to content</nav><h1>Huge article</h1><p>${HUGE}</p><p>END-HUGE-MARKER</p>`),
    '/doc.pdf': null,
  };
}

export function startSuiteFixtures() {
  const other = { href: 'http://127.0.0.1:0' };
  const pdfBuf = pdf();
  const handler = (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, data) => { res.writeHead(code, { 'content-type': type }); res.end(data); };
    if (u.pathname === '/doc.pdf') return send(200, 'application/pdf', pdfBuf);
    const pages = pagesFor(other);
    const html = pages[u.pathname];
    if (html) return send(200, 'text/html; charset=utf-8', html);
    send(404, 'text/plain', 'not found');
  };
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      resolve({ origin, port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
