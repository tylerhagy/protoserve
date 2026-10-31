'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { annotate, injectScript, parseDoc } = require('../src/annotate');
const { resolveAnchor } = require('../src/anchor');
const { Store } = require('../src/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'protoserve-test-'));
}

test('annotate marks every element with its exact source line and column', () => {
  const html = '<!doctype html>\n<html><body>\n<div class="a">\n  <button id="go">Go</button>\n</div>\n</body></html>';
  const out = annotate(html);
  assert.match(out, /<div data-ps-loc="3:1" class="a">/);
  assert.match(out, /<button data-ps-loc="4:3" id="go">/);
});

test('annotate never touches head, script or style content', () => {
  const html = '<html><head><style>.x{color:red}</style><script>var a="<div>"</script></head><body><p>hi</p></body></html>';
  const out = annotate(html);
  assert.ok(out.includes('<style>.x{color:red}</style>'), 'style content preserved');
  assert.ok(out.includes('var a="<div>"'), 'script content preserved');
  assert.ok(!/<style data-ps-loc/.test(out), 'style not annotated');
});

test('annotate handles self-closing tags and uppercase tag names', () => {
  const html = '<html><body>\n<BR/>\n<IMG src="x.png"/>\n</body></html>';
  const out = annotate(html);
  assert.match(out, /<BR data-ps-loc="2:1"\/>/);
  assert.match(out, /<IMG data-ps-loc="3:1" src="x.png"\/>/);
});

test('annotated output still parses to the same element count', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures/proto/index.html'), 'utf8');
  const count = (doc) => {
    let n = 0;
    (function walk(x) { if (x.tagName) n++; (x.childNodes || []).forEach(walk); })(doc);
    return n;
  };
  assert.strictEqual(count(parseDoc(annotate(html))), count(parseDoc(html)));
});

test('injectScript puts the tag in <head>, never in <body>', () => {
  const out = injectScript('<html><head><title>t</title></head><body><p>x</p></body></html>', '<script>1</script>');
  assert.match(out, /<head>\n<script>1<\/script><title>/);
  assert.ok(!/<body>[^]*<script>1/.test(out), 'nothing was added to the body');
});

test('injectScript falls back sensibly with no head or body', () => {
  assert.match(injectScript('<html><p>x</p></html>', '<script>1</script>'), /<html>\n<script>1<\/script>/);
  assert.match(injectScript('<p>x</p>', '<script>1</script>'), /^<script>1<\/script>\n<p>x<\/p>/);
});

test('anchor re-resolves to the NEW line after the file is edited above it', () => {
  const before = '<html><body>\n<div>\n<button id="go">Go</button>\n</div>\n</body></html>';
  const anchor = { id: 'go', tag: 'button', text_snippet: 'Go', path: [{ tag: 'div', index: 0 }, { tag: 'button', index: 0 }], loc: { line: 3, col: 1 } };
  assert.strictEqual(resolveAnchor(parseDoc(before), anchor).line, 3);

  const after = '<html><body>\n<header>New</header>\n<p>Another line</p>\n<div>\n<button id="go">Go</button>\n</div>\n</body></html>';
  const r = resolveAnchor(parseDoc(after), anchor);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.line, 5, 'line number follows the element');
  assert.strictEqual(r.method, 'id');
});

test('anchor still resolves when the id is gone', () => {
  const anchor = { id: 'gone', tag: 'button', text_snippet: 'Go', path: [{ tag: 'div', index: 0 }, { tag: 'button', index: 0 }] };
  const html = '<html><body>\n<div>\n<button>Go</button>\n</div>\n</body></html>';
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.line, 3);
});

test('a structural match is REJECTED when the element no longer looks the same', () => {
  // The review case: an agent inserts a sibling above, shifting every index.
  const anchor = { tag: 'div', classes: ['card'], text_snippet: 'Card C', path: [{ tag: 'div', index: 2 }] };
  const after = '<html><body>\n<div class="card">Card NEW</div>\n<div class="card">Card A</div>\n' +
                '<div class="card">Card B</div>\n<div class="card">Card C</div>\n</body></html>';
  const r = resolveAnchor(parseDoc(after), anchor);
  assert.strictEqual(r.line, 5, 'follows the real Card C, not the shifted index');
  assert.strictEqual(r.verified, true);
});

test('an unverifiable structural match is flagged rather than trusted', () => {
  // Nothing to compare against: the path hit is reported, but marked unverified.
  const anchor = { tag: 'div', classes: [], text_snippet: '', path: [{ tag: 'div', index: 0 }], id: null };
  const html = '<html><body>\n<div><img src="a.png"></div>\n</body></html>';
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.verified, false, 'caller is told not to trust this line');
});

test('a structural match contradicted by the evidence is discarded, not reported', () => {
  // The element at that position is demonstrably a different one.
  const anchor = { tag: 'p', classes: ['eta'], text_snippet: 'Arrives in 3-5 days', path: [{ tag: 'p', index: 0 }] };
  const html = '<html><body>\n<p id="total">Something else entirely</p>\n</body></html>';
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.found, false, 'no line beats a wrong line');
});

test('an element found by its classes after its text was rewritten', () => {
  // Exactly what happens once an agent has acted on a different comment.
  const anchor = { tag: 'p', classes: ['eta'], text_snippet: 'Arrives in 3-5 business days.', path: [{ tag: 'p', index: 4 }] };
  const html = '<html><body>\n<div class="promo">New</div>\n<div>\n<p id="total">Total</p>\n' +
               '<p class="eta">Arrives by Thursday.</p>\n</div>\n</body></html>';
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.method, 'tag+class');
  assert.strictEqual(r.line, 5);
});

test('hydrate reports the verified flag to callers', () => {
  const { hydrate } = require('../src/cli.js');
  const d = tmpdir();
  const file = path.join(d, 'p.html');
  fs.writeFileSync(file, '<html><body>\n<button id="go">Go</button>\n</body></html>');
  const s = new Store(d);
  s.add('p.html', { text: 'x', anchor: { id: 'go', tag: 'button', text_snippet: 'Go', path: [{ tag: 'button', index: 0 }] } });
  const out = hydrate({ abs: file, root: d, key: 'p.html', store: s }, s.list('p.html'));
  assert.strictEqual(out[0].anchor.verified, true);
  assert.strictEqual(out[0].anchor.line, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

test('ambiguous text never resolves to an arbitrary element', () => {
  const anchor = { tag: 'a', text_snippet: 'Submit', path: [{ tag: 'form', index: 9 }] };
  const html = '<html><body>\n<form><button class="primary">Submit</button></form>\n' +
               '<div><p>Submit</p><span>Submit</span></div>\n</body></html>';
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.found, false, 'three candidates means no confident answer');
});

test('long text still matches despite the 120-character snippet limit', () => {
  const long = 'x'.repeat(300);
  const anchor = { tag: 'p', text_snippet: long.slice(0, 120), path: [{ tag: 'p', index: 0 }] };
  const html = `<html><body>\n<main>\n<p>${long}</p>\n</main>\n</body></html>`;
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.line, 3);
});

test('anchor falls back to text when the structure changed', () => {
  const anchor = { id: null, tag: 'button', text_snippet: 'Go', path: [{ tag: 'div', index: 9 }] };
  const html = '<html><body>\n<section>\n<span>\n<button>Go</button>\n</span>\n</section>\n</body></html>';
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.method, 'tag+text');
  assert.strictEqual(r.line, 4);
});

test('anchor reports not_found when the element is truly gone', () => {
  const anchor = { id: 'nope', tag: 'button', text_snippet: 'Vanished', path: [{ tag: 'div', index: 4 }] };
  const r = resolveAnchor(parseDoc('<html><body><p>nothing</p></body></html>'), anchor);
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.method, 'none');
});

test('anchor ignores a path hit whose tag no longer matches', () => {
  const anchor = { tag: 'button', text_snippet: 'Go', path: [{ tag: 'div', index: 0 }] };
  const html = '<html><body>\n<div>not a button</div>\n</body></html>';
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.found, false);
});

test('duplicate ids are not trusted for resolution', () => {
  const anchor = { id: 'dup', tag: 'p', text_snippet: 'second', path: [{ tag: 'p', index: 1 }] };
  const html = '<html><body>\n<p id="dup">first</p>\n<p id="dup">second</p>\n</body></html>';
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.line, 3, 'the right one, found by its text');
  assert.strictEqual(r.verified, true);
});

test('<image> is annotated without corrupting the tag name', () => {
  // The parser rewrites <image> to img; the source name is two characters longer.
  const out = annotate('<html><body>\n<image src="c.png">\n</body></html>');
  assert.match(out, /<image data-ps-loc="2:1" src="c\.png">/);
});

test('injectScript survives a character whose lowercase is longer', () => {
  const out = injectScript('<html><body>\n<p>Merhaba \u0130stanbul</p>\n</body></html>', '<script>1</script>');
  assert.ok(out.includes('</body>'), 'the closing body tag is intact');
  assert.ok(!out.includes('<<script'), 'nothing spliced into the middle of a tag');
});

test('annotation never emits a duplicate data-ps-loc attribute', () => {
  const already = annotate('<html><body><div data-ps-loc="9:9">x</div></body></html>');
  const div = already.match(/<div[^>]*>/)[0];
  assert.strictEqual((div.match(/data-ps-loc/g) || []).length, 1, 'the source attribute is left alone');
  // Misnested formatting elements are cloned by the parser and share a location.
  const misnest = annotate('<html><body>\n<p>1<b>2<i>3</p>4</i>5</b>\n</body></html>');
  assert.ok(!/<b [^>]*data-ps-loc="[^"]*" data-ps-loc=/.test(misnest));
});

test('<template> contents are left alone — they are never rendered', () => {
  const out = annotate('<html><body>\n<template><div class="row">hi</div></template>\n</body></html>');
  assert.ok(!/<div data-ps-loc/.test(out), 'inert markup is not annotated');
});

test('a template does not steal a match from the real element', () => {
  const html = '<html><body>\n<template id="tpl">\n<p class="btn">Save</p>\n</template>\n' +
               '<div class="list">\n<p class="btn">Save now</p>\n</div>\n</body></html>';
  const anchor = { tag: 'p', classes: ['btn'], text_snippet: 'Save now', path: [{ tag: 'div', index: 0 }, { tag: 'p', index: 0 }] };
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.line, 6, 'the rendered element, not the template copy');
});

test('store numbers top-level comments and leaves replies unnumbered', () => {
  const d = tmpdir();
  const s = new Store(d);
  const a = s.add('i.html', { text: 'a' });
  const b = s.add('i.html', { text: 'b' });
  const r = s.add('i.html', { text: 'r', parent_id: a.id });
  assert.deepStrictEqual([a.number, b.number, r.number], [1, 2, null]);
  fs.rmSync(d, { recursive: true, force: true });
});

test('deleting a thread removes its replies and can be restored', () => {
  const d = tmpdir();
  const s = new Store(d);
  const a = s.add('i.html', { text: 'a' });
  s.add('i.html', { text: 'r', parent_id: a.id });
  const removed = s.remove('i.html', a.id);
  assert.strictEqual(removed.length, 2);
  assert.strictEqual(s.list('i.html').length, 0);
  removed.forEach((c) => s.restore('i.html', c));
  assert.strictEqual(s.list('i.html').length, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

test('restore is idempotent and does not duplicate', () => {
  const d = tmpdir();
  const s = new Store(d);
  const a = s.add('i.html', { text: 'a' });
  s.remove('i.html', a.id);
  s.restore('i.html', a);
  s.restore('i.html', a);
  assert.strictEqual(s.list('i.html').length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('numbering never reuses a number after deletion', () => {
  const d = tmpdir();
  const s = new Store(d);
  const a = s.add('i.html', { text: 'a' });
  s.remove('i.html', a.id);
  const b = s.add('i.html', { text: 'b' });
  assert.strictEqual(b.number, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

test('resolving a thread resolves its replies', () => {
  const d = tmpdir();
  const s = new Store(d);
  const a = s.add('i.html', { text: 'a' });
  const r = s.add('i.html', { text: 'r', parent_id: a.id });
  s.update('i.html', a.id, { resolved: true });
  assert.strictEqual(s.list('i.html').find((c) => c.id === r.id).resolved, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a corrupt comments file is preserved, never silently overwritten', () => {
  const d = tmpdir();
  const s = new Store(d);
  fs.mkdirSync(s.dir, { recursive: true });
  fs.writeFileSync(s.file, '{"files":{"i.html":{"comments":[{"id":"a","text":"IRREPLACEABLE"');
  assert.deepStrictEqual(s.list('i.html'), []);
  s.add('i.html', { text: 'ok' });
  const saved = fs.readdirSync(s.dir).filter((f) => f.startsWith('comments.corrupt-'));
  assert.strictEqual(saved.length, 1, 'the damaged file was kept');
  assert.match(fs.readFileSync(path.join(s.dir, saved[0]), 'utf8'), /IRREPLACEABLE/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('an unreadable store raises instead of pretending to be empty', () => {
  const d = tmpdir();
  const s = new Store(d);
  fs.mkdirSync(s.file, { recursive: true }); // a directory where the file should be
  assert.throws(() => s.list('i.html'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('concurrent writers do not lose comments', () => {
  const d = tmpdir();
  const s = new Store(d);
  const { execFileSync } = require('child_process');
  const script = `const {Store}=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'store.js'))});
const s=new Store(${JSON.stringify(d)});
for(let i=0;i<25;i++) s.add('i.html',{text:process.argv[2]+i});`;
  const file = path.join(d, 'writer.js');
  fs.writeFileSync(file, script);
  const kids = ['a', 'b', 'c'].map((tag) =>
    require('child_process').spawn(process.execPath, [file, tag], { stdio: 'ignore' }));
  return new Promise((resolve) => {
    let left = kids.length;
    kids.forEach((k) => k.on('exit', () => {
      if (--left === 0) {
        assert.strictEqual(s.list('i.html').length, 75, 'every comment survived');
        fs.rmSync(d, { recursive: true, force: true });
        resolve();
      }
    }));
  });
});

test('comment ids are unique across files, so screenshots cannot collide', () => {
  const d = tmpdir();
  const s = new Store(d);
  const ids = new Set();
  for (let i = 0; i < 40; i++) {
    ids.add(s.add('a.html', { text: 'a' + i }).id);
    ids.add(s.add('b.html', { text: 'b' + i }).id);
  }
  assert.strictEqual(ids.size, 80);
  fs.rmSync(d, { recursive: true, force: true });
});

test('repeated identical siblings never produce a confident wrong line', () => {
  // A price that appears on three cards cannot identify which card was meant,
  // so an inserted sibling must downgrade the answer, not misreport it.
  const after = '<html><body>\n<div class="grid">\n' +
    '<div class="card"><h3>Free</h3><p class="price">$0</p></div>\n' +
    '<div class="card"><h3>Plan</h3><p class="price">$10</p></div>\n' +
    '<div class="card"><h3>Plan</h3><p class="price">$10</p></div>\n</div>\n</body></html>';
  const anchor = { tag: 'p', classes: ['price'], text_snippet: '$10',
    path: [{ tag: 'div', index: 0 }, { tag: 'div', index: 1 }, { tag: 'p', index: 0 }] };
  const r = resolveAnchor(parseDoc(after), anchor);
  assert.strictEqual(r.verified, false, 'ambiguous text cannot confirm a structural match');
});

test('a class the prototype adds at runtime does not break matching', () => {
  // The client records classList from the live DOM, which may hold JS-added classes.
  const anchor = { tag: 'button', classes: ['btn', 'is-active'], text_snippet: 'Save',
    path: [{ tag: 'button', index: 0 }] };
  const html = '<html><body>\n<button class="btn">Save changes</button>\n</body></html>';
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.found, true, 'the source class set is a subset of what was recorded');
  assert.strictEqual(r.line, 2);
});

test('a text-only match must still agree on the tag', () => {
  const anchor = { tag: 'div', text_snippet: 'Unique Copy' };
  const html = '<html><body>\n<div class="wrap">\n<span>Unique Copy</span>\n</div>\n</body></html>';
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.notStrictEqual(r.tag, 'span', 'never reports a span for a div anchor');
});

test('a live lock is refused rather than stolen', () => {
  const d = tmpdir();
  const s = new Store(d);
  fs.mkdirSync(s.dir, { recursive: true });
  fs.mkdirSync(path.join(s.dir, '.lock'));            // a fresh lock = a live holder
  fs.writeFileSync(path.join(s.dir, '.lock', 'owner'), 'another-process');
  assert.throws(() => s.add('i.html', { text: 'x' }), /another protoserve process/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('an unremovable lock fails fast instead of spinning forever', () => {
  const d = tmpdir();
  const s = new Store(d);
  fs.mkdirSync(s.dir, { recursive: true });
  const lock = path.join(s.dir, '.lock');
  fs.mkdirSync(lock);
  const old = Date.now() / 1000 - 60;
  fs.utimesSync(lock, old, old);   // stale, so it would be broken...
  fs.chmodSync(s.dir, 0o555);      // ...but it cannot be removed
  const started = Date.now();
  assert.throws(() => s.add('i.html', { text: 'x' }), /stale lock/);
  assert.ok(Date.now() - started < 2000, 'gave up quickly rather than freezing the server');
  fs.chmodSync(s.dir, 0o755);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a doctored screenshot path cannot point outside the store', () => {
  const d = tmpdir();
  const s = new Store(d);
  assert.strictEqual(s.shotPath({ screenshot: '../../../etc/passwd' }), null);
  assert.ok(s.shotPath({ screenshot: 'screenshots/abc.png' }));
  fs.rmSync(d, { recursive: true, force: true });
});

test('adding a modifier class does not move a comment to a sibling', () => {
  // Two icon buttons, identical but for their aria-label; the commented one
  // gains a modifier class. It must not resolve to its neighbour.
  const html = '<html><body>\n<div class="bar">\n' +
    '<button class="icon-btn icon-btn--search" aria-label="search"><svg></svg></button>\n' +
    '<button class="icon-btn" aria-label="bell"><svg></svg></button>\n</div>\n</body></html>';
  const anchor = { tag: 'button', classes: ['icon-btn'], text_snippet: '',
    attrs: { 'aria-label': 'search' }, path: [{ tag: 'div', index: 0 }, { tag: 'button', index: 0 }] };
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.line, 3, 'stays on the search button');
});

test('a text-less element that was deleted is never reported as verified', () => {
  const html = '<html><body>\n<div class="bar">\n<button class="icon-btn" aria-label="bell"><svg></svg></button>\n</div>\n</body></html>';
  const anchor = { tag: 'button', classes: ['icon-btn'], text_snippet: '',
    attrs: { 'aria-label': 'search' }, path: [{ tag: 'div', index: 0 }, { tag: 'button', index: 0 }] };
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.verified, false, 'the remaining button is a different one');
});

test('a class match cannot override an outright text contradiction', () => {
  const html = '<html><body>\n<table><tbody>\n<tr class="row"><td>Globex</td></tr>\n' +
    '<tr class="row alt"><td>Initech</td></tr>\n</tbody></table>\n</body></html>';
  const anchor = { tag: 'tr', classes: ['row'], text_snippet: 'Acme Co',
    path: [{ tag: 'table', index: 0 }, { tag: 'tbody', index: 0 }, { tag: 'tr', index: 0 }] };
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.verified, false, 'the recorded text appears nowhere');
});

test('an unclassed paragraph whose copy was rewritten is still located', () => {
  const html = '<html><body>\n<article>\n<p>Meters report every five minutes.</p>\n</article>\n</body></html>';
  const anchor = { tag: 'p', classes: [], text_snippet: 'Readings are captured every fifteen minutes.',
    path: [{ tag: 'article', index: 0 }, { tag: 'p', index: 0 }], loc: { line: 3, col: 1 } };
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.found, true, 'rewriting copy must not lose the anchor');
  assert.strictEqual(r.line, 3);
  assert.strictEqual(r.verified, false, 'but the caller is told the text changed');
});

test('renaming the tag keeps the anchor when the text is distinctive', () => {
  const html = '<html><body>\n<section class="card">Revenue $1.2M</section>\n</body></html>';
  const anchor = { tag: 'article', classes: ['card'], text_snippet: 'Revenue $1.2M',
    path: [{ tag: 'article', index: 0 }] };
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.line, 2);
});

test('the third of four identical cards is found by its position after an edit', () => {
  const html = '<html><body>\n<section class="cards">\n' +
    '<article class="card">Revenue</article>\n' +
    '<article class="card">Plan</article>\n' +
    '<article class="card">Plan</article>\n' +
    '<article class="card">Plan</article>\n</section>\n</body></html>';
  // Recorded on the card two places after the one reading "Revenue".
  const anchor = { tag: 'article', classes: ['card'], text_snippet: 'Plan',
    path: [{ tag: 'section', index: 0 }, { tag: 'article', index: 2 }],
    sibs: [{ text: 'Revenue', offset: 2, dir: 'back', total: 4, descent: [] }] };
  const r = resolveAnchor(parseDoc(html), anchor);
  assert.strictEqual(r.line, 5, 'the third card, not the second or fourth');
  assert.strictEqual(r.verified, true, 'the list is unchanged, so this is certain');
});

test('injectScript ignores an <html> that only appears inside a script string', () => {
  const page = '<!doctype html>\n<title>t</title>\n<script>const x = "<html>";</script>\n<p>x</p>';
  const out = injectScript(page, '<script>1</script>');
  assert.ok(out.includes('const x = "<html>";'), 'the page\'s own string is untouched');
  assert.ok(out.indexOf('<script>1</script>') < out.indexOf('const x'), 'injected before the page script');
});
