'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { annotate, injectScript } = require('./annotate');
const { Store, relKey, DIR_NAME, LOCK_NAME } = require('./store');
const instances = require('./instances');

const CLIENT_DIR = path.join(__dirname, 'client');
const API_ROOT = '/__protoserve/api/comments';
const MAX_BODY = 24 * 1024 * 1024; // screenshots ride along as data URLs

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8'
};

const SKIP_DIRS = new Set(['node_modules', DIR_NAME, '.git', '.next', 'dist', 'build', '.cache']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function listHtml(root, dir, depth, out, inside) {
  if (depth > 4) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (inside && !inside(full)) continue; // a link pointing out of the folder
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      listHtml(root, full, depth + 1, out, inside);
    } else if (/\.html?$/i.test(e.name)) {
      out.push(relKey(root, full));
    }
  }
  return out;
}

function send(res, code, type, body, extra) {
  const headers = Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra || {});
  res.writeHead(code, headers);
  if (res.req && res.req.method === 'HEAD') return res.end();
  res.end(body);
}
function sendJson(res, code, obj) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}

/** Reject anything that is not a same-origin request from an allowed host. */
function localRequest(req, allowHost) {
  const hostHeader = String(req.headers.host || '');
  if (!hostHeader) return true; // HTTP/1.0 clients send no Host; browsers always do
  const hostName = hostHeader.replace(/:\d+$/, '').toLowerCase();
  const allowed = LOOPBACK.has(hostName) || (allowHost && hostName === String(allowHost).toLowerCase());
  if (!allowed) return false;
  const origin = req.headers.origin;
  if (origin) {
    let o;
    try { o = new URL(origin); } catch { return false; }
    if (o.host.toLowerCase() !== hostHeader.toLowerCase()) return false;
  }
  return true;
}

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        // Answer first, then hang up — otherwise the client only sees ECONNRESET.
        sendJson(res, 413, { error: 'Comment too large. The screenshot exceeded 24MB.' });
        res.end();
        reject(Object.assign(new Error('payload too large'), { handled: true }));
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (done) return;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', (e) => { if (!done) reject(e); });
  });
}

function createServer(root, opts) {
  const allowHost = (opts && opts.host) || null;
  root = path.resolve(root);
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* use the literal path */ }

  const store = new Store(root);

  /* Every .html under the root, each with its open/resolved tallies. The panel's scope switcher
     shows the counts beside the names, so picking a prototype is an informed choice rather than a
     blind jump — which is the whole reason it is worth more than a filename dropdown. One store
     read serves the lot; the client re-fetches via /__protoserve/files when it opens the menu. */
  function fileScopes() {
    /* ONE store read for the whole listing. store.list() loads and parses comments.json on every
       call, so mapping it over the file list re-read the same file once per prototype — 40 reads
       per page load in a 40-file folder, and again on every /files fetch, which every connected
       client now makes on every comments event. */
    let data;
    try { data = store.load(); }
    catch { data = null; }                         // an unreadable store must not break the switcher
    return listHtml(root, root, 0, [], contained).map((name) => {
      let open = 0, resolved = 0;
      if (data) {
        const b = data.files && data.files[name];
        const list = b && Array.isArray(b.comments) ? b.comments : [];
        for (const c of list) {
          if (c && c.parent_id) continue;          // replies are not comments in their own right
          if (c && c.resolved) resolved++; else open++;
        }
      }
      return { name, open, resolved };
    });
  }
  const clients = new Set();
  const served = new Set(); // files we have actually handed out, for reload decisions
  const overlayCss = () => fs.readFileSync(path.join(CLIENT_DIR, 'overlay.css'), 'utf8');
  const overlayJs = () => fs.readFileSync(path.join(CLIENT_DIR, 'overlay.js'), 'utf8');
  const guardJs = () => fs.readFileSync(path.join(CLIENT_DIR, 'guard.js'), 'utf8');

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
    for (const res of clients) { try { res.write(payload); } catch { clients.delete(res); } }
  }

  /** True when an absolute path is genuinely inside the served folder. */
  function contained(target) {
    const first = path.relative(root, target).split(path.sep)[0] || '';
    if (first.toLowerCase() === DIR_NAME) return false;
    let real;
    try { real = fs.realpathSync(target); } catch { return true; } // not existing yet is fine
    return real === realRoot || real.startsWith(realRoot + path.sep);
  }

  /** Resolve a URL path to a real file inside the served folder, or null. */
  function safePath(urlPath) {
    let decoded;
    try { decoded = decodeURIComponent(urlPath); }
    catch { return null; } // a stray '%' must not crash the server
    if (decoded.indexOf('\0') !== -1) return null;
    const target = path.resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    return contained(target) ? target : null;
  }

  function serveHtml(res, filePath) {
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch { return send(res, 404, 'text/plain', 'Not found'); }
    const file = relKey(root, filePath);
    let html;
    try {
      html = annotate(raw);
    } catch (e) {
      // One unparseable prototype must not take down the whole session.
      return send(res, 500, 'text/plain',
        `protoserve could not parse ${file}:\n${e.message}\n\nThe file itself is untouched.`);
    }
    const cfg = { file, files: fileScopes(), css: overlayCss() };
    const tag =
      `<script data-protoserve="guard">${guardJs()}</script>` +
      `<script data-protoserve="config">window.__PS=${JSON.stringify(cfg).replace(/</g, '\\u003c')}</script>` +
      `<script data-protoserve="overlay" src="/__protoserve/overlay.js" defer></script>`;
    served.add(file);
    send(res, 200, MIME['.html'], injectScript(html, tag));
  }

  function serveIndexOf(res, dirPath) {
    const idx = path.join(dirPath, 'index.html');
    if (fs.existsSync(idx)) {
      if (!contained(idx)) return send(res, 403, 'text/plain', 'Forbidden');
      return serveHtml(res, idx);
    }
    const files = listHtml(root, dirPath, 0, [], contained);
    if (files.length === 1) {
      const only = path.join(root, files[0]);
      if (!contained(only)) return send(res, 403, 'text/plain', 'Forbidden');
      return serveHtml(res, only);
    }
    const rows = files.map((f) => `<li><a href="/${encodeURI(f)}">${esc(f)}</a></li>`).join('');
    send(res, 200, MIME['.html'],
      `<!doctype html><meta charset="utf-8"><title>protoserve</title>` +
      `<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 24px;color:#1d1d1f}` +
      `h1{font-size:17px;font-weight:600}a{color:#0071e3}li{margin:4px 0}</style>` +
      `<h1>Prototypes in ${esc(path.basename(root))}</h1><ul>${rows || '<li>No .html files found.</li>'}</ul>`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      try {
        if (!res.headersSent) send(res, 500, 'text/plain', 'protoserve error: ' + e.message);
        else res.end();
      } catch { /* the socket is already gone */ }
    }
  });

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return send(res, 400, 'text/plain', 'Bad request'); }
    const pathname = url.pathname;

    if (!localRequest(req, allowHost)) {
      return send(res, 403, 'text/plain', 'protoserve only serves local requests.');
    }

    // ---- internal endpoints
    if (pathname === '/__protoserve/ping') {
      return sendJson(res, 200, { protoserve: true, pid: process.pid, root });
    }
    if (pathname === '/__protoserve/files') {
      if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');
      return sendJson(res, 200, { files: fileScopes() });
    }
    if (pathname === '/__protoserve/overlay.js') {
      return send(res, 200, MIME['.js'], overlayJs());
    }
    if (pathname === '/__protoserve/html-to-image.js') {
      try {
        return send(res, 200, MIME['.js'],
          fs.readFileSync(require.resolve('html-to-image/dist/html-to-image.js')));
      } catch {
        return send(res, 404, 'text/plain', 'html-to-image not installed');
      }
    }
    if (pathname === '/__protoserve/events') {
      if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      res.write('retry: 1000\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    // ---- comment API
    if (pathname === API_ROOT || pathname.startsWith(API_ROOT + '/')) {
      const file = url.searchParams.get('file');
      if (!file) return sendJson(res, 400, { error: 'file parameter is required' });
      const key = file.split(path.sep).join('/');
      if (key.split('/').indexOf('..') !== -1) return sendJson(res, 400, { error: 'invalid file' });
      const id = pathname.slice(API_ROOT.length).replace(/^\//, '').replace(/\/+$/, '');
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating && !/^application\/json\b/.test(String(req.headers['content-type'] || ''))) {
        return sendJson(res, 415, { error: 'expected application/json' });
      }

      try {
        if (req.method === 'GET') {
          // `listening`: live `protoserve watch --sent` processes for this file, so the page can say
          // whether anyone is on the other end of the Send button.
          return sendJson(res, 200, {
            file: key, comments: store.list(key),
            listening: instances.listenersFor(path.resolve(root), key)
          });
        }
        if (req.method === 'POST' && id === 'send') {
          // Explicit, never automatic: nothing reaches the agent until this is called.
          const body = await readBody(req, res);
          const sent = store.markSent(key, Array.isArray(body.ids) ? body.ids : null);
          if (sent.length) broadcast('comments', { file: key });
          return sendJson(res, 200, { sent: sent.map((c) => c.id) });
        }
        if (req.method === 'POST' && id === 'restore') {
          const body = await readBody(req, res);
          const list = Array.isArray(body.comments) ? body.comments : [];
          for (const c of list) if (c && c.id) store.restore(key, c);
          broadcast('comments', { file: key });
          return sendJson(res, 200, { restored: list.length });
        }
        if (req.method === 'POST' && !id) {
          const body = await readBody(req, res);
          if (!body.text || !String(body.text).trim()) {
            return sendJson(res, 400, { error: 'text is required' });
          }
          const created = store.add(key, {
            text: String(body.text).trim(),
            anchor: body.anchor || null,
            state: body.state || null,
            parent_id: body.parent_id || null
          });
          if (body.screenshot) {
            const rel = store.attachShot(key, created.id, body.screenshot);
            if (rel) created.screenshot = rel;
          }
          if (created.parent_id) store.unsend(key, created.parent_id);
          broadcast('comments', { file: key });
          return sendJson(res, 200, created);
        }
        if (req.method === 'PATCH' && id) {
          const body = await readBody(req, res);
          const updated = store.update(key, id, body);
          if (!updated) return sendJson(res, 404, { error: 'comment not found' });
          broadcast('comments', { file: key });
          return sendJson(res, 200, updated);
        }
        if (req.method === 'DELETE' && id) {
          const removed = store.remove(key, id);
          if (!removed) return sendJson(res, 404, { error: 'comment not found' });
          broadcast('comments', { file: key });
          return sendJson(res, 200, { removed });
        }
      } catch (e) {
        if (e && e.handled) return; // 413 already answered
        return sendJson(res, 400, { error: e.message });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ---- static
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'text/plain', 'Method not allowed');
    }
    const target = safePath(pathname);
    if (!target) return send(res, 403, 'text/plain', 'Forbidden');

    let stat = null;
    try { stat = fs.statSync(target); } catch { /* missing */ }
    if (!stat) return send(res, 404, 'text/plain', 'Not found');
    if (stat.isDirectory()) return serveIndexOf(res, target);
    if (/\.html?$/i.test(target)) return serveHtml(res, target);

    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    try { return send(res, 200, type, fs.readFileSync(target)); }
    catch { return send(res, 404, 'text/plain', 'Not found'); }
  }

  // ---- watch for changes: comments refresh in place, prototype edits reload.
  let commentTimer = null;
  let reloadTimer = null;
  let watcher = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_evt, name) => {
      if (!name) return;
      const rel = String(name).split(path.sep).join('/');
      const first = rel.split('/')[0] || '';
      if (first.toLowerCase() === DIR_NAME) {
        if (rel.indexOf('/' + LOCK_NAME) !== -1 || rel.endsWith('.tmp')) return;
        clearTimeout(commentTimer);
        commentTimer = setTimeout(() => broadcast('comments', {}), 120);
        return;
      }
      if (rel.includes('node_modules/') || rel.endsWith('.tmp')) return;
      // macOS recursive watches can report paths that were never ours. Only reload
      // for something that exists now, or that we actually served before.
      if (!served.has(rel) && !fs.existsSync(path.join(root, rel))) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => broadcast('reload', { file: rel }), 120);
    });
  } catch { /* watching is optional */ }

  // Live-reload clients hold their sockets open forever, so they must be released
  // BEFORE close() starts waiting for connections to drain — not from its
  // 'close' event, which only fires once they are already gone.
  const baseClose = server.close.bind(server);
  server.close = function (cb) {
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
    clearTimeout(commentTimer);
    clearTimeout(reloadTimer);
    for (const res of clients) { try { res.end(); res.destroy(); } catch { /* gone */ } }
    clients.clear();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return baseClose(cb);
  };
  server.root = root;
  return server;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function tryPort(p) {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < 60) { attempts++; tryPort(p + 1); }
        else reject(err);
      });
      server.listen(p, host, () => resolve(server.address().port));
    }
    tryPort(port);
  });
}

module.exports = { createServer, listen, listHtml };
