/* anychat share relay — a tiny read-only page host.
   POST /api/share  {title, markdown}  -> {id, url}
   GET  /s/:id      -> rendered, escaped HTML page
   GET  /healthz    -> ok

   No accounts, no database: shares live in memory with a TTL, which is the
   honest behaviour on a free tier with an ephemeral filesystem. */

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const TTL_MS = Number(process.env.SHARE_TTL_MS || 1000 * 60 * 60 * 24 * 7); // 7 days
const MAX_BYTES = 400 * 1024;
const MAX_ITEMS = 5000;

/** @type {Map<string, {title: string, markdown: string, created: number}>} */
const shares = new Map();

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/* A deliberately small markdown subset: headings, bold, italics, inline code,
   links, lists and paragraphs. Everything is escaped first, so a hostile
   message cannot inject markup or script into a shared page. */
function renderMarkdown(md) {
  const esc = escapeHtml(md);
  const lines = esc.split(/\r?\n/);
  const out = [];
  let inList = false;

  const inline = (t) => t
    .replace(/`([^`]{1,200})`/g, '<code>$1</code>')
    .replace(/\*\*([^*]{1,400})\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]{1,400})\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{4,500})\)/g, '<a href="$2" rel="noreferrer noopener" target="_blank">$1</a>');

  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (/^&gt;\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light dark;--paper:#F7F6F3;--ink:#131313;--muted:#6B675F;--clay:#D97757;--line:#E4E1DA}
  @media (prefers-color-scheme:dark){:root{--paper:#131313;--ink:#F4F2EE;--muted:#A7A29A;--line:#2A2825}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);
    font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{max-width:720px;margin:0 auto;padding:28px 20px 80px}
  header{display:flex;align-items:center;gap:10px;padding-bottom:14px;border-bottom:1px solid var(--line);margin-bottom:22px}
  header .dot{width:10px;height:10px;border-radius:50%;background:var(--clay)}
  header h1{font-size:18px;margin:0;font-weight:600}
  header .meta{margin-left:auto;font-size:12px;color:var(--muted)}
  h1,h2,h3,h4{line-height:1.25;margin:1.4em 0 .5em;font-weight:600}
  h1{font-size:1.5em}h2{font-size:1.25em}h3{font-size:1.1em}
  p{margin:.7em 0}
  ul{margin:.6em 0 .6em 1.2em;padding:0}
  li{margin:.3em 0}
  code{background:rgba(128,128,128,.16);padding:.12em .35em;border-radius:5px;font-size:.92em;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  blockquote{margin:.8em 0;padding:.4em 0 .4em 12px;border-left:3px solid var(--line);color:var(--muted)}
  a{color:var(--clay)}
  footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
</style></head>
<body><main>
<header><span class="dot"></span><h1>${escapeHtml(title)}</h1><span class="meta">shared chat</span></header>
${body}
<footer>Shared from the anychat app · read-only · this link expires.</footer>
</main></body></html>`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  });
  res.end(JSON.stringify(obj));
}

function sweep() {
  const now = Date.now();
  for (const [id, item] of shares) if (now - item.created > TTL_MS) shares.delete(id);
  if (shares.size > MAX_ITEMS) {
    const oldest = [...shares.entries()].sort((a, b) => a[1].created - b[1].created).slice(0, shares.size - MAX_ITEMS);
    for (const [id] of oldest) shares.delete(id);
  }
}
setInterval(sweep, 60 * 1000).unref();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, shares: shares.size });

  if (req.method === 'POST' && url.pathname === '/api/share') {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) { req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return json(res, 400, { error: 'Body must be JSON.' }); }
      const title = String(payload.title || 'Shared chat').slice(0, 120);
      const markdown = String(payload.markdown || '').slice(0, MAX_BYTES);
      if (!markdown.trim()) return json(res, 400, { error: 'Nothing to share.' });

      const id = crypto.randomBytes(9).toString('base64url');
      shares.set(id, { title, markdown, created: Date.now() });
      const base = process.env.PUBLIC_BASE_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
      return json(res, 200, { id, url: `${base.replace(/\/$/, '')}/s/${id}`, expiresInMs: TTL_MS });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/s/')) {
    const id = url.pathname.slice(3).replace(/[^A-Za-z0-9_-]/g, '');
    const item = shares.get(id);
    if (!item) return send(res, 404, page('Not found', '<p>This link has expired or never existed.</p>'));
    return send(res, 200, page(item.title, renderMarkdown(item.markdown)));
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, page('anychat shares', '<p>This service hosts read-only shared chats for the anychat app.</p>'));
  }

  return send(res, 404, page('Not found', '<p>Nothing here.</p>'));
});

server.listen(PORT, () => {
  console.log(`anychat share relay on :${PORT} (ttl ${Math.round(TTL_MS / 3600000)}h)`);
});
