'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { createServer, listen } = require('./server');
const { Store, relKey, DIR_NAME } = require('./store');
const { parseDoc } = require('./annotate');
const { resolveAnchor } = require('./anchor');
const instances = require('./instances');

const VERSION = require('../package.json').version;

const HELP = `protoserve ${VERSION} — comment on HTML prototypes, then hand the notes to your AI agent.

Usage: protoserve [path] [flags]

Arguments:
  path              File or folder to serve. A file serves its folder and opens
                    at that file. Defaults to the current folder.

Flags:
  -p, --port N      Port to serve on (default: 8300, auto-increments if busy)
      --host HOST   Host to bind (default: localhost)
      --no-open     Don't open a browser
      --detach      Start the server in the background and return immediately.
                    It survives the shell, terminal or agent that launched it;
                    stop it with 'protoserve kill'. Prints the URL and pid.
  -h, --help        Show this help
  -v, --version     Show version

Commands:
  protoserve comments <file> [--open|--resolved] [--text]
                              List comments as JSON, with line numbers
                              re-resolved against the file as it is right now.
                              --open (alias --unresolved) hides resolved ones.
  protoserve resolve <file> <id>...      Mark comments resolved
  protoserve unresolve <file> <id>...    Reopen comments
  protoserve delete <file> <id>...       Delete comments permanently
  protoserve reply <file> <id> <text>    Reply to a comment
  protoserve watch [file] [--new]        Stream comment events as JSONL
  protoserve list                        List running protoserve instances
  protoserve kill <pid>... | --all       Stop running instances

Comments live in .protoserve/ beside the prototype. Source files are never modified.`;

// ---------------------------------------------------------------- helpers
function fail(msg, code) {
  process.stderr.write(msg + '\n');
  process.exit(code == null ? 1 : code);
}

/**
 * Work out which folder owns this file's comments.
 * A running server is the best answer; otherwise the nearest ancestor that
 * actually holds a comments.json. The home directory is never a root.
 */
function findRoot(file) {
  const abs = path.resolve(file);
  const start = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);

  let best = null;
  for (const i of instances.read()) {
    const root = path.resolve(i.root);
    if (start === root || start.startsWith(root + path.sep)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  if (best) return best;

  const home = os.homedir();
  const stop = path.parse(start).root;
  let d = start;
  for (;;) {
    if (d !== home && fs.existsSync(path.join(d, DIR_NAME, 'comments.json'))) return d;
    if (d === stop) break;
    d = path.dirname(d);
  }
  return start;
}

function target(file) {
  const abs = path.resolve(file);
  const root = findRoot(abs);
  return { abs, root, key: relKey(root, abs), store: new Store(root) };
}

const SOURCE_EXT = /\.(html?|js|mjs|jsx|ts|tsx)$/i;
const SKIP_SOURCE = new Set(['node_modules', DIR_NAME, '.git', 'dist', 'build', '.next', '.cache']);

function sourceFiles(root, dir, depth, out) {
  if (depth > 3 || out.length > 80) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_SOURCE.has(e.name)) sourceFiles(root, full, depth + 1, out);
    } else if (SOURCE_EXT.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Many standalone prototypes build their markup in JavaScript, so the clicked
 * element has no line in the HTML. Rather than a dead end, grep the prototype
 * and its sibling sources for the element's text and hand back candidates.
 */
const sourceCache = new Map();
function loadSources(root, primary) {
  const key = root + '::' + primary;
  if (sourceCache.has(key)) return sourceCache.get(key);
  const files = [primary].concat(sourceFiles(root, root, 0, []).filter((f) => f !== primary));
  const loaded = [];
  for (const f of files) {
    try {
      if (fs.statSync(f).size > 4 * 1024 * 1024) continue;
      loaded.push([f, fs.readFileSync(f, 'utf8')]);
    } catch { /* unreadable */ }
  }
  sourceCache.set(key, loaded);
  return loaded;
}

function findInSource(root, primary, anchor) {
  // Most specific first: exact copy, then a distinctive prefix, then the
  // identifiers that a template almost always contains verbatim.
  const clean = String(anchor.selected_text || anchor.text_snippet || '').replace(/\s+/g, ' ').trim();
  const needles = [];
  if (clean.length >= 6) needles.push({ kind: 'text', q: clean });
  if (clean.length > 40) needles.push({ kind: 'text', q: clean.slice(0, 40) });
  if (clean.length > 18) needles.push({ kind: 'text', q: clean.slice(0, 18) });
  if (anchor.id) needles.push({ kind: 'id', q: anchor.id });
  for (const c of anchor.classes || []) {
    if (String(c).length >= 4) needles.push({ kind: 'class', q: c });
  }
  if (!needles.length) return [];

  const loaded = loadSources(root, primary);

  for (const needle of needles) {
    const hits = [];
    for (const [f, txt] of loaded) {
      if (txt.indexOf(needle.q) === -1) continue;
      const lines = txt.split('\n');
      for (let i = 0; i < lines.length && hits.length < 5; i++) {
        if (lines[i].indexOf(needle.q) !== -1) {
          hits.push({ file: f, line: i + 1, matched: needle.kind, preview: lines[i].trim().slice(0, 160) });
        }
      }
      if (hits.length >= 5) break;
    }
    if (hits.length) return hits; // stop at the most specific needle that matched
  }
  return [];
}

/** Re-resolve every anchor against the file's current contents. */
function hydrate(t, comments) {
  let doc = null;
  try { doc = parseDoc(fs.readFileSync(t.abs, 'utf8')); } catch { doc = null; }
  const byParent = new Map();
  for (const c of comments) {
    if (c.parent_id) {
      if (!byParent.has(c.parent_id)) byParent.set(c.parent_id, []);
      byParent.get(c.parent_id).push({
        id: c.id, text: c.text, created_at: c.created_at, resolved: c.resolved
      });
    }
  }
  return comments.filter((c) => !c.parent_id).map((c) => {
    const a = c.anchor || {};
    const r = doc ? resolveAnchor(doc, a) : { found: false, method: 'none' };
    const shot = t.store.shotPath(c);
    const needsSource = !r.found || r.verified === false;
    const sourceMatches = needsSource ? findInSource(t.root, t.abs, a) : [];
    return {
      id: c.id,
      number: c.number,
      text: c.text,
      resolved: !!c.resolved,
      created_at: c.created_at,
      updated_at: c.updated_at || null,
      anchor: {
        kind: a.kind || 'element',
        selector: a.selector || null,
        tag: a.tag || null,
        selected_text: a.selected_text || null,
        text_snippet: a.text_snippet || null,
        outer_html: a.outer_html || null,
        line: r.found ? r.line : null,
        col: r.found ? r.col : null,
        resolution: r.found ? r.method : 'not_found',
        verified: r.found ? r.verified !== false : false,
        original_line: a.loc ? a.loc.line : null,
        box: a.box || null,
        computed: a.computed || null,
        source_matches: sourceMatches
      },
      state: c.state || null,
      screenshot: shot && fs.existsSync(shot) ? shot : null,
      replies: byParent.get(c.id) || []
    };
  });
}

function humanize(file, list) {
  const lines = [];
  for (const c of list) {
    const at = c.anchor.line ? `line ${c.anchor.line}` : 'line unknown';
    lines.push(`#${c.number} [${c.id}] ${c.resolved ? '(resolved) ' : ''}${at} · ${c.anchor.selector || c.anchor.tag || ''}`);
    lines.push(`   ${c.text}`);
    if (c.anchor.selected_text) lines.push(`   text: "${c.anchor.selected_text}"`);
    if (c.anchor.resolution === 'not_found') lines.push('   NOTE: not in the static HTML (likely built by JS) — candidates below');
    else if (c.anchor.verified === false) lines.push('   NOTE: anchor unverified — confirm against outer_html before editing');
    for (const m of c.anchor.source_matches || []) {
      lines.push(`   candidate (${m.matched}): ${path.basename(m.file)}:${m.line}  ${m.preview.slice(0, 74)}`);
    }
    for (const r of c.replies) lines.push(`   ↳ ${r.text}`);
    lines.push('');
  }
  if (!list.length) lines.push('No comments.');
  return `${file}\n\n` + lines.join('\n');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { execFile(cmd, args, () => {}); } catch { /* opening is optional */ }
}

// ---------------------------------------------------------------- commands
function cmdComments(args) {
  const file = args.shift();
  if (!file) fail('Usage: protoserve comments <file> [--open|--resolved] [--text]');
  const t = target(file);
  if (!fs.existsSync(t.abs)) fail(`No such file: ${t.abs}`);
  const all = hydrate(t, t.store.list(t.key));
  let list = all;
  if (args.includes('--open') || args.includes('--unresolved')) list = all.filter((c) => !c.resolved);
  if (args.includes('--resolved')) list = all.filter((c) => c.resolved);
  if (args.includes('--text')) {
    process.stdout.write(humanize(t.abs, list) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    file: t.abs,
    root: t.root,
    open: all.filter((c) => !c.resolved).length,
    resolved: all.filter((c) => c.resolved).length,
    listed: list.length,
    comments: list
  }, null, 2) + '\n');
}

function cmdSetResolved(args, value, verb) {
  const file = args.shift();
  const ids = args.filter((a) => !a.startsWith('-'));
  if (!file || !ids.length) fail(`Usage: protoserve ${verb} <file> <id>...`);
  const t = target(file);
  const done = [];
  for (const id of ids) {
    const c = t.store.update(t.key, id, { resolved: value });
    if (c) done.push(id); else process.stderr.write(`not found: ${id}\n`);
  }
  process.stdout.write(JSON.stringify({ [verb + 'd']: done }) + '\n');
}

function cmdDelete(args) {
  const file = args.shift();
  const ids = args.filter((a) => !a.startsWith('-'));
  if (!file || !ids.length) fail('Usage: protoserve delete <file> <id>...');
  const t = target(file);
  const done = [];
  for (const id of ids) {
    const removed = t.store.remove(t.key, id);
    if (removed) done.push(id); else process.stderr.write(`not found: ${id}\n`);
  }
  process.stdout.write(JSON.stringify({ deleted: done }) + '\n');
}

function cmdReply(args) {
  const file = args.shift();
  const id = args.shift();
  const text = args.join(' ').trim();
  if (!file || !id || !text) fail('Usage: protoserve reply <file> <id> <text>');
  const t = target(file);
  const parent = t.store.list(t.key).find((c) => c.id === id);
  if (!parent) fail(`not found: ${id}`);
  const c = t.store.add(t.key, { text, parent_id: id, anchor: parent.anchor || null, state: null });
  process.stdout.write(JSON.stringify(c) + '\n');
}

function cmdWatch(args) {
  const onlyNew = args.includes('--new');
  const file = args.find((a) => !a.startsWith('-'));
  const t = target(file || process.cwd());
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

  function snapshot() {
    const map = new Map();
    let data;
    try { data = t.store.load(); } catch { return map; } // unreadable right now; try again next tick
    for (const key of Object.keys(data.files || {})) {
      const bucket = data.files[key];
      const list = bucket && Array.isArray(bucket.comments) ? bucket.comments : [];
      for (const c of list) if (c && c.id) map.set(key + '::' + c.id, c);
    }
    return map;
  }

  const only = file ? t.key : null;
  const inScope = (k) => !only || k.split('::')[0] === only;

  let prev = snapshot();
  if (!onlyNew) {
    for (const [k, c] of prev) {
      if (!c.resolved && inScope(k)) emit({ type: 'initial', file: k.split('::')[0], comment: c });
    }
  }
  const watchDir = t.store.dir;
  fs.mkdirSync(watchDir, { recursive: true });
  let timer = null;
  fs.watch(watchDir, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
      const next = snapshot();
      for (const [k, c] of next) {
        if (!inScope(k)) continue;
        const before = prev.get(k);
        const fileKey = k.split('::')[0];
        if (!before) { emit({ type: c.parent_id ? 'new_reply' : 'new_comment', file: fileKey, comment: c }); continue; }
        if (onlyNew) continue;
        if (before.resolved !== c.resolved) emit({ type: c.resolved ? 'resolved' : 'unresolved', file: fileKey, comment: c });
        if (before.text !== c.text) emit({ type: 'edited', file: fileKey, comment: c });
      }
      if (!onlyNew) {
        for (const [k, c] of prev) if (!next.has(k) && inScope(k)) emit({ type: 'deleted', file: k.split('::')[0], comment: c });
      }
      prev = next;
      } catch (e) {
        // A half-written store must never kill a long-running watch.
        process.stderr.write('protoserve watch: ' + e.message + '\n');
      }
    }, 90);
  });
}

function cmdList() {
  const list = instances.read();
  if (!list.length) { process.stdout.write('No protoserve instances running.\n'); return; }
  const rows = [['PID', 'PORT', 'URL', 'PATH']].concat(
    list.map((i) => [String(i.pid), String(i.port), String(i.url || ''), String(i.root || '')])
  );
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  process.stdout.write(rows.map((r) => r.map((v, c) => v.padEnd(w[c])).join('  ')).join('\n') + '\n');
}

async function cmdKill(args) {
  const list = instances.read();
  const targets = args.includes('--all')
    ? list
    : list.filter((i) => args.includes(String(i.pid)));
  if (!targets.length) { process.stdout.write('Nothing to stop.\n'); return; }
  for (const i of targets) {
    // pids are recycled; confirm this really is our server before signalling it.
    if (!(await instances.verify(i))) {
      process.stdout.write(`Skipped PID ${i.pid} — not a running protoserve (stale entry removed)\n`);
      instances.unregister(i.pid);
      continue;
    }
    try {
      process.kill(i.pid, 'SIGTERM');
      process.stdout.write(`Stopped PID ${i.pid} (port ${i.port})\n`);
      instances.unregister(i.pid);
    } catch (e) {
      process.stdout.write(`Could not stop PID ${i.pid}: ${e.message}\n`);
    }
  }
}

async function cmdServe(args) {
  let port = 8300, host = 'localhost', open = true, given = null, detach = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' || a === '--port') {
      const raw = args[++i];
      if (!/^\d{1,5}$/.test(String(raw || ''))) fail(`Invalid port: ${raw === undefined ? '(missing)' : raw}`);
      const n = Number(raw);
      if (n > 65535) fail(`Invalid port: ${raw}`);
      port = n;
    }
    else if (a === '--host') host = args[++i] || host;
    else if (a === '--no-open') open = false;
    else if (a === '--detach' || a === '-d') detach = true;
    else if (!a.startsWith('-')) given = a;
  }
  const input = path.resolve(given || process.cwd());
  if (!fs.existsSync(input)) fail(`No such file or folder: ${input}`);
  const isDir = fs.statSync(input).isDirectory();
  const root = isDir ? input : path.dirname(input);

  /* --detach: re-exec ourselves in a new session and exit, so the server is not a child of the
     caller any more. A server started from a terminal dies with that terminal, and one started by
     an agent or a CI step dies when its task is reaped — which is exactly the failure this exists
     to stop. detached:true gives the child its own process group and session leader, so a signal
     sent to the launcher's group (or the group being torn down wholesale) never reaches it;
     stdio:'ignore' and unref() cut the last two ties, the pipes and the event-loop reference. */
  if (detach) {
    const argv = process.argv.slice(2).filter((a) => a !== '--detach' && a !== '-d');
    const child = require('child_process').spawn(
      process.execPath, [require.main.filename || __filename].concat(argv),
      { detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env }
    );
    child.unref();
    // Wait for it to actually bind before claiming success — a detached child that dies on startup
    // would otherwise be reported as a running server.
    const deadline = Date.now() + 5000;
    for (;;) {
      const found = instances.read().find((i) => i.pid === child.pid);
      if (found && await instances.verify(found, 500)) {
        // the file's own URL, not the bare root — a folder of prototypes would otherwise land you
        // on the index when you named a specific file
        const at = isDir ? found.url + '/' : found.url + '/' + encodeURI(relKey(root, input));
        process.stdout.write(
          `protoserve ${VERSION} running detached\n` +
          `  at   ${at}\n` +
          `  pid  ${child.pid}\n\n` +
          `It will outlive this shell. Stop it with: protoserve kill\n`
        );
        return;
      }
      if (Date.now() > deadline) fail('the detached server did not come up within 5s');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const server = createServer(root, { host });
  const actual = await listen(server, port, host);
  const url = `http://${host}:${actual}`;
  const openUrl = isDir ? url + '/' : url + '/' + encodeURI(relKey(root, input));

  instances.register({ pid: process.pid, port: actual, url, root, started: new Date().toISOString() });
  const cleanup = () => { instances.unregister(process.pid); process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => instances.unregister(process.pid));

  process.stdout.write(
    `protoserve ${VERSION}\n` +
    `  serving  ${root}\n` +
    `  at       ${openUrl}\n` +
    `  comments ${path.join(root, DIR_NAME)}\n\n` +
    `Press C in the page to start commenting. Ctrl+C here to stop.\n`
  );
  if (open) openBrowser(openUrl);
}

// ---------------------------------------------------------------- entry
function main(argv) {
  const args = argv.slice(2);
  const first = args[0];

  if (first === '-h' || first === '--help' || first === 'help') { process.stdout.write(HELP + '\n'); return; }
  if (first === '-v' || first === '--version') { process.stdout.write(VERSION + '\n'); return; }

  const KNOWN = ['comments', 'resolve', 'unresolve', 'delete', 'reply', 'watch', 'list', 'kill'];
  if (first && !first.startsWith('-') && KNOWN.indexOf(first) === -1 && !fs.existsSync(first)) {
    fail(`protoserve: unknown command or missing path: ${first}\n` +
         `Commands: ${KNOWN.join(', ')}. Run 'protoserve --help' for usage.`);
  }

  const run = {
    comments: () => cmdComments(args.slice(1)),
    resolve: () => cmdSetResolved(args.slice(1), true, 'resolve'),
    unresolve: () => cmdSetResolved(args.slice(1), false, 'unresolve'),
    delete: () => cmdDelete(args.slice(1)),
    reply: () => cmdReply(args.slice(1)),
    watch: () => cmdWatch(args.slice(1)),
    list: () => cmdList(),
    kill: () => cmdKill(args.slice(1))
  }[first] || (() => cmdServe(args));

  try {
    const out = run();
    if (out && typeof out.catch === 'function') out.catch((e) => fail('protoserve: ' + e.message));
  } catch (e) {
    fail('protoserve: ' + e.message);
  }
}

module.exports = { main, hydrate, target, findRoot };
