'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createServer, listen } = require('../src/server');
const { Store } = require('../src/store');

// Playwright is a dev dependency; skip the browser suite rather than fail when
// it (or its browser) is not installed.
let chromium = null;
try { chromium = require('playwright').chromium; } catch { chromium = null; }
if (!chromium) {
  test('browser tests skipped — run `npm install` to enable them', { skip: true }, () => {});
  return;
}

let root, server, port, browser, page, store;
const CLI = path.join(__dirname, '..', 'bin', 'protoserve.js');

function cli(args) {
  return execFileSync(process.execPath, [CLI].concat(args), { encoding: 'utf8' });
}
const host = (sel) => page.locator('#__protoserve_host ' + sel);
const comments = () => store.list('index.html');
const indexPath = () => path.join(root, 'index.html');

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'protoserve-e2e-'));
  for (const f of ['index.html', 'about.html', 'generated.html']) {
    fs.copyFileSync(path.join(__dirname, 'fixtures/proto', f), path.join(root, f));
  }
  store = new Store(root);
  server = createServer(root);
  port = await listen(server, 8390, 'localhost');
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://localhost:${port}/index.html`);
  await host('.ps-bar').waitFor({ timeout: 10000 });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('the prototype renders untouched — no layout shift from the overlay', async () => {
  const m = await page.evaluate(() => ({
    bodyMargin: document.body.style.marginLeft || getComputedStyle(document.body).marginLeft,
    appbarWidth: document.querySelector('.appbar').getBoundingClientRect().width,
    innerWidth: window.innerWidth,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    cardTop: document.querySelector('#acct').getBoundingClientRect().top
  }));
  assert.strictEqual(m.bodyMargin, '0px', 'body margin untouched');
  assert.strictEqual(m.appbarWidth, m.innerWidth, 'fixed app bar still spans the viewport');
  assert.strictEqual(m.horizontalOverflow, false, 'no horizontal scrollbar introduced');
  assert.ok(m.cardTop > 0);
});

test('the overlay adds nothing to the prototype\'s <body>', async () => {
  const m = await page.evaluate(() => ({
    lastChild: document.body.lastElementChild.tagName + '.' + document.body.lastElementChild.className,
    bodyDivs: document.querySelectorAll('body > div').length,
    scripts: document.querySelectorAll('body script[data-protoserve]').length,
    hostParent: document.getElementById('__protoserve_host').parentElement.tagName
  }));
  assert.strictEqual(m.scripts, 0, 'no injected script sits in the body');
  assert.strictEqual(m.hostParent, 'HTML', 'the overlay host lives outside the body');
  assert.ok(!/protoserve/i.test(m.lastChild), "body's last child is the prototype's own");
  assert.strictEqual(m.bodyDivs, 2, 'body > div counts only the prototype\'s divs');
});

test('comment mode blocks every interaction path, not just click', async () => {
  await page.evaluate(() => {
    window.__fired = [];
    const b = document.getElementById('pay');
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'dragstart']
      .forEach((t) => b.addEventListener(t, () => window.__fired.push(t)));
    window.__protoserve.setMode('inspect');
  });
  await page.click('#pay');
  await host('.ps-card textarea').waitFor({ timeout: 5000 });
  const fired = await page.evaluate(() => window.__fired);
  assert.deepStrictEqual(fired, [], 'the prototype saw none of it');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__protoserve.setMode('interact'));
});

test('the overlay comes back if the prototype re-renders its container', async () => {
  await page.evaluate(() => { window.__savedBody = document.body.innerHTML; document.body.innerHTML = '<div id="app">v2</div>'; });
  await page.waitForFunction(() => {
    const h = document.getElementById('__protoserve_host');
    return !!h && h.isConnected;
  }, null, { timeout: 8000 });
  await page.evaluate(() => { document.body.innerHTML = window.__savedBody; });
  await page.reload();
  await host('.ps-bar').waitFor({ timeout: 10000 });
});

test('the prototype stays interactive while comment mode is off', async () => {
  await page.click('#pay');
  assert.strictEqual(await page.evaluate(() => window.__paid), true, 'onclick ran normally');
  await page.evaluate(() => { window.__paid = undefined; document.title = 'Billing Prototype'; });
});

test('pressing C turns on comment mode', async () => {
  await page.keyboard.press('c');
  await host('.ps-hint').waitFor({ timeout: 3000 });
  assert.strictEqual(await page.evaluate(() => window.__protoserve.mode), 'inspect');
});

test('hovering an element shows a highlight labelled with its selector', async () => {
  await page.hover('#pay');
  await host('.ps-tag').waitFor({ timeout: 3000 });
  assert.strictEqual((await host('.ps-tag').textContent()).trim(), '#pay');
});

test('clicking a button in comment mode comments instead of firing its handler', async () => {
  await page.click('#pay');
  await host('.ps-card textarea').waitFor({ timeout: 3000 });
  assert.strictEqual(await page.evaluate(() => window.__paid), undefined, 'onclick did NOT run');
  assert.strictEqual(await page.title(), 'Billing Prototype', 'title unchanged');
});

test('a comment saves with an exact source anchor, state and screenshot', async () => {
  await host('.ps-card textarea').fill('Button should say Make a payment');
  await page.keyboard.press('Control+Enter');
  await host('.ps-pin').first().waitFor({ timeout: 15000 });

  const list = comments();
  assert.strictEqual(list.length, 1);
  const c = list[0];
  assert.strictEqual(c.number, 1);
  assert.strictEqual(c.anchor.id, 'pay');
  assert.strictEqual(c.anchor.tag, 'button');
  assert.strictEqual(c.anchor.text_snippet, 'Pay now');
  assert.strictEqual(c.anchor.selector, '#pay');
  assert.ok(c.anchor.loc && c.anchor.loc.line > 0, 'has a source line');
  assert.ok(!/data-ps-loc/.test(c.anchor.outer_html), 'stored markup is clean');
  assert.deepStrictEqual(c.state.active_tabs, ['Overview'], 'captured which tab was active');
  assert.strictEqual(c.state.viewport.w, 1200);
  assert.ok(c.screenshot, 'a screenshot was captured');
  const shot = store.shotPath(c);
  assert.ok(fs.existsSync(shot), 'screenshot file exists');
  assert.ok(fs.statSync(shot).size > 5000, 'screenshot is a real image');
});

test('the anchor points at the true source line of the button', () => {
  const out = JSON.parse(cli(['comments', indexPath()]));
  assert.strictEqual(out.open, 1);
  const c = out.comments[0];
  const srcLine = fs.readFileSync(indexPath(), 'utf8').split('\n')[c.anchor.line - 1];
  assert.match(srcLine, /id="pay"/, 'reported line really contains the button');
  assert.strictEqual(c.anchor.resolution, 'id');
});

test('links do not navigate while comment mode is on', async () => {
  await page.click('#details');
  await host('.ps-card textarea').waitFor({ timeout: 3000 });
  assert.match(page.url(), /index\.html/, 'still on the same page');
  await page.keyboard.press('Escape');
});

test('selecting text anchors the comment to that copy', async () => {
  await page.evaluate(() => {
    const p = document.querySelector('#acct .hint');
    const r = document.createRange();
    r.selectNodeContents(p);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.click('#acct .hint');
  await host('.ps-card textarea').waitFor({ timeout: 3000 });
  await host('.ps-card textarea').fill('Say the actual due date here');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => window.__protoserve.comments.length === 2, null, { timeout: 15000 });

  const c = comments().find((x) => x.number === 2);
  assert.strictEqual(c.anchor.kind, 'selection');
  assert.strictEqual(c.anchor.selected_text, 'Your next payment is due soon.');
  assert.strictEqual(c.anchor.tag, 'p');
});

test('state capture records an open modal', async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.openModal());
  await page.keyboard.press('c');
  await page.click('#confirm p');
  await host('.ps-card textarea').waitFor({ timeout: 3000 });
  await host('.ps-card textarea').fill('Confirm copy is too terse');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => window.__protoserve.comments.length === 3, null, { timeout: 15000 });

  const c = comments().find((x) => x.number === 3);
  assert.deepStrictEqual(c.state.open_dialogs, ['#confirm'], 'recorded which dialog was open');
  await page.evaluate(() => document.getElementById('confirm').close());
});

test('resolving from the UI hides the pin and offers undo', async () => {
  await page.keyboard.press('Escape');
  await host('.ps-pin').first().click();
  await host('.ps-card').waitFor({ timeout: 3000 });
  await host('.ps-card .ps-icons button.done').click();
  await host('.ps-toast').waitFor({ timeout: 5000 });
  assert.strictEqual(comments().find((c) => c.number === 1).resolved, true);

  await host('.ps-toast button').click();
  await page.waitForFunction(
    () => window.__protoserve.comments.find((c) => c.number === 1).resolved === false,
    null, { timeout: 5000 }
  );
  assert.strictEqual(comments().find((c) => c.number === 1).resolved, false, 'undo reopened it');
});

test('deleting from the UI removes it and undo brings it back intact', async () => {
  await host('.ps-pin').first().click();
  await host('.ps-card').waitFor({ timeout: 3000 });
  const before = comments().find((c) => c.number === 1);
  await host('.ps-card .ps-icons button.danger').click();
  await page.waitForFunction(() => window.__protoserve.comments.length === 2, null, { timeout: 5000 });
  assert.strictEqual(comments().find((c) => c.number === 1), undefined);

  await host('.ps-toast button').click();
  await page.waitForFunction(() => window.__protoserve.comments.length === 3, null, { timeout: 5000 });
  const after = comments().find((c) => c.number === 1);
  assert.strictEqual(after.text, before.text);
  assert.strictEqual(after.id, before.id, 'same id restored');
  assert.strictEqual(after.anchor.selector, before.anchor.selector);
});

test('a comment can be resolved and deleted straight from the list', async () => {
  await host('.ps-bar button').nth(1).click();
  await host('.ps-panel').waitFor({ timeout: 5000 });
  const targetId = await host('.ps-item').first().getAttribute('data-id');
  const target = comments().find((c) => c.id === targetId);
  assert.ok(target, 'the first row maps to a real comment');

  await host('.ps-item').first().hover();
  await host('.ps-item .ps-row-actions button.done').first().click();
  await page.waitForFunction(
    (id) => (window.__protoserve.comments.find((c) => c.id === id) || {}).resolved === true,
    target.id, { timeout: 5000 }
  );

  await host('.ps-toast button').click(); // undo, back to open
  await page.waitForFunction(
    (id) => (window.__protoserve.comments.find((c) => c.id === id) || {}).resolved === false,
    target.id, { timeout: 5000 }
  );

  const before = comments().length;
  await host('.ps-item').first().hover();
  await host('.ps-item .ps-row-actions button.danger').first().click();
  await page.waitForFunction((n) => window.__protoserve.comments.length === n - 1, before, { timeout: 5000 });
  await host('.ps-toast button').click();
  await page.waitForFunction((n) => window.__protoserve.comments.length === n, before, { timeout: 5000 });
  assert.ok(comments().find((c) => c.id === target.id), 'undo restored it');
  await host('.ps-panel .ps-panel-title button').click();
});

test('CLI resolve updates the live page without a reload', async () => {
  const id = comments().find((c) => c.number === 1).id;
  cli(['resolve', indexPath(), id]);
  await page.waitForFunction(
    () => window.__protoserve.comments.find((c) => c.number === 1).resolved === true,
    null, { timeout: 8000 }
  );
  cli(['unresolve', indexPath(), id]);
});

test('CLI reply threads under the comment', async () => {
  const id = comments().find((c) => c.number === 1).id;
  cli(['reply', indexPath(), id, 'Changed to Make a payment.']);
  const out = JSON.parse(cli(['comments', indexPath()]));
  const c = out.comments.find((x) => x.number === 1);
  assert.strictEqual(c.replies.length, 1);
  assert.strictEqual(c.replies[0].text, 'Changed to Make a payment.');
});

test('line numbers stay correct after the file is edited above the anchor', () => {
  const before = JSON.parse(cli(['comments', indexPath()])).comments.find((c) => c.number === 1);
  const src = fs.readFileSync(indexPath(), 'utf8');
  fs.writeFileSync(indexPath(), src.replace('<div class="appbar">', '<!-- new banner -->\n<div class="promo">Save 10%</div>\n<div class="appbar">'));

  const after = JSON.parse(cli(['comments', indexPath()])).comments.find((c) => c.number === 1);
  assert.strictEqual(after.anchor.line, before.anchor.line + 2, 'line shifted by exactly the inserted lines');
  const srcLine = fs.readFileSync(indexPath(), 'utf8').split('\n')[after.anchor.line - 1];
  assert.match(srcLine, /id="pay"/, 'still points at the button');
});

test('a comment whose element is deleted reports not_found rather than a wrong line', () => {
  const src = fs.readFileSync(indexPath(), 'utf8');
  fs.writeFileSync(indexPath(), src.replace(/<button class="cta" id="pay"[^>]*>Pay now<\/button>/, ''));
  const c = JSON.parse(cli(['comments', indexPath()])).comments.find((x) => x.number === 1);
  assert.strictEqual(c.anchor.line, null);
  assert.strictEqual(c.anchor.resolution, 'not_found');
  assert.ok(c.anchor.outer_html.includes('Pay now'), 'still carries the original markup to match on');
  fs.writeFileSync(indexPath(), src);
});

test('--open filters to unresolved and --text renders a readable report', () => {
  const id = comments().find((c) => c.number === 2).id;
  cli(['resolve', indexPath(), id]);
  const out = JSON.parse(cli(['comments', indexPath(), '--open']));
  assert.strictEqual(out.comments.every((c) => !c.resolved), true);
  assert.strictEqual(out.resolved, 1, 'counts still report the whole file');
  const text = cli(['comments', indexPath(), '--text']);
  assert.match(text, /#1 \[/);
  cli(['unresolve', indexPath(), id]);
});

test('CLI delete removes the comment and its screenshot', () => {
  const c = comments().find((x) => x.number === 3);
  const shot = store.shotPath(c);
  assert.ok(fs.existsSync(shot));
  cli(['delete', indexPath(), c.id]);
  assert.strictEqual(comments().find((x) => x.number === 3), undefined);
  assert.strictEqual(fs.existsSync(shot), false, 'screenshot cleaned up');
});

test('the comment store is never written into the prototype source', () => {
  const src = fs.readFileSync(indexPath(), 'utf8');
  assert.ok(!src.includes('data-ps-loc'), 'no annotation leaked to disk');
  assert.ok(!src.includes('protoserve'), 'no overlay leaked to disk');
});

test('a framed prototype does not grow a second toolbar', async () => {
  fs.writeFileSync(path.join(root, 'framed.html'),
    '<!doctype html><html><head><title>Framed</title></head><body>' +
    '<iframe src="/about.html" width="400" height="200"></iframe></body></html>');
  await page.goto(`http://localhost:${port}/framed.html`);
  await host('.ps-bar').waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  const inner = await page.frames()[1].evaluate(() => !!document.getElementById('__protoserve_host'));
  assert.strictEqual(inner, false, 'the frame has no overlay of its own');
  fs.rmSync(path.join(root, 'framed.html'));
});

test('a page that paints no background is treated as light', async () => {
  fs.writeFileSync(path.join(root, 'bare.html'),
    '<!doctype html><html><head><title>Bare</title></head><body><p>plain</p></body></html>');
  await page.goto(`http://localhost:${port}/bare.html`);
  await host('.ps-bar').waitFor({ timeout: 10000 });
  const theme = await page.evaluate(() =>
    document.getElementById('__protoserve_host').shadowRoot.querySelector('.ps-root').getAttribute('data-theme'));
  assert.strictEqual(theme, 'light', 'a transparent page renders white, not black');
  fs.rmSync(path.join(root, 'bare.html'));
});

test('the second prototype in the folder keeps its own comments', async () => {
  await page.goto(`http://localhost:${port}/about.html`);
  await host('.ps-bar').waitFor({ timeout: 10000 });
  assert.strictEqual(await page.evaluate(() => window.__protoserve.comments.length), 0);
  assert.ok(comments().length > 0, 'index.html comments untouched');
});

test('a comment on JS-built markup points at the template that generates it', async () => {
  await page.goto(`http://localhost:${port}/generated.html`);
  await host('.ps-bar').waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__protoserve.setMode('inspect'));

  const hasLoc = await page.evaluate(() =>
    !!document.querySelector('.meter-row').getAttribute('data-ps-loc'));
  assert.strictEqual(hasLoc, false, 'the element genuinely has no source line');

  await page.click('.meter-row');
  await host('.ps-card textarea').waitFor({ timeout: 5000 });
  await host('.ps-card textarea').fill('Say kilowatt-hours in full on first use.');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => window.__protoserve.comments.length === 1, null, { timeout: 15000 });

  const out = JSON.parse(cli(['comments', path.join(root, 'generated.html')]));
  const a = out.comments[0].anchor;
  assert.strictEqual(a.line, null, 'no line is claimed for runtime markup');
  assert.strictEqual(a.resolution, 'not_found');
  assert.ok(a.source_matches.length > 0, 'candidate locations are offered instead');
  const tpl = a.source_matches.find((m) => /meter-row/.test(m.preview));
  assert.ok(tpl, 'one candidate is the template line');
  const srcLine = fs.readFileSync(path.join(root, 'generated.html'), 'utf8').split('\n')[tpl.line - 1];
  assert.match(srcLine, /meter-row/, 'the reported line really contains the template');
  await page.evaluate(() => window.__protoserve.setMode('interact'));
  await page.goto(`http://localhost:${port}/index.html`);
  await host('.ps-bar').waitFor({ timeout: 10000 });
});

test('the served page is blocked from reading the comment store over HTTP', async () => {
  const res = await page.request.get(`http://localhost:${port}/.protoserve/comments.json`);
  assert.strictEqual(res.status(), 403);
});

test('path traversal outside the served folder is refused', async () => {
  const res = await page.request.get(`http://localhost:${port}/../../etc/passwd`);
  assert.ok(res.status() === 403 || res.status() === 404, 'traversal blocked');
});

test('the resolver never reports a wrong line as verified', async () => {
  // 22 anchors built by the real client, put through 20 realistic edits.
  const { run } = require('../bench/matrix');
  const { tally, total } = await run(null);
  const rate = tally.correctVerified / total;
  assert.strictEqual(tally.wrongVerified, 0, 'a confidently wrong line is the one unacceptable failure');
  assert.strictEqual(tally.goneBad, 0, 'a deleted element is never reported as verified');
  assert.ok(rate > 0.9, `verified-and-correct should stay above 90%, got ${(rate * 100).toFixed(1)}%`);
});

test('the directory route cannot serve a symlink pointing outside the folder', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'protoserve-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.html'), '<h1>OUTSIDE THE ROOT</h1>');
  const sub = path.join(root, 'linked');
  fs.mkdirSync(sub);
  fs.symlinkSync(path.join(outside, 'secret.html'), path.join(sub, 'index.html'));
  const res = await page.request.get(`http://localhost:${port}/linked/`);
  const body = res.status() === 200 ? await res.text() : '';
  assert.ok(!/OUTSIDE THE ROOT/.test(body), 'the outside file was not served');
  fs.rmSync(sub, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('the server shuts down cleanly while a page is still connected', async () => {
  const spare = createServer(root);
  const sparePort = await listen(spare, 0, 'localhost');
  const probe = await browser.newPage();
  await probe.goto(`http://localhost:${sparePort}/index.html`);
  await probe.locator('#__protoserve_host .ps-bar').waitFor({ timeout: 10000 });
  const closed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    spare.close(() => { clearTimeout(timer); resolve(true); });
  });
  await probe.close();
  assert.strictEqual(closed, true, 'close() completed despite the live-reload connection');
});

test('a malformed percent escape does not crash the server', async () => {
  for (const bad of ['/%', '/%zz', '/%c0%ae%c0%ae/etc/passwd']) {
    const res = await page.request.get(`http://localhost:${port}${bad}`);
    assert.ok(res.status() >= 400, `${bad} rejected`);
  }
  const ok = await page.request.get(`http://localhost:${port}/__protoserve/ping`);
  assert.strictEqual(ok.status(), 200, 'server still alive');
});

test('the comment store cannot be read by changing the case of the folder', async () => {
  for (const p of ['/.protoserve/comments.json', '/.PROTOSERVE/comments.json', '/.Protoserve/comments.json']) {
    const res = await page.request.get(`http://localhost:${port}${p}`);
    assert.strictEqual(res.status(), 403, `${p} blocked`);
  }
});

test('a symlink cannot be used to escape the served folder', async () => {
  const link = path.join(root, 'etclink');
  try { fs.symlinkSync('/etc', link); } catch { return; }
  const res = await page.request.get(`http://localhost:${port}/etclink/hosts`);
  fs.unlinkSync(link);
  assert.strictEqual(res.status(), 403);
});

function raw(opts, body) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.request(Object.assign({ host: '127.0.0.1', port }, opts), (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    if (body) req.write(body);
    req.end();
  });
}

test('another website cannot write comments into the store', async () => {
  const before = comments().length;
  const res = await raw({
    method: 'POST', path: '/__protoserve/api/comments?file=index.html',
    headers: { Host: `localhost:${port}`, Origin: 'https://evil.example', 'Content-Type': 'application/json' }
  }, JSON.stringify({ text: 'CSRF' }));
  assert.strictEqual(res.status, 403);
  assert.strictEqual(comments().length, before, 'nothing was written');
});

test('a rebound hostname is refused', async () => {
  const res = await raw({ method: 'GET', path: '/index.html', headers: { Host: 'evil.example' } });
  assert.strictEqual(res.status, 403);
});

test('a form-style POST is refused (no JSON content type)', async () => {
  const before = comments().length;
  const res = await raw({
    method: 'POST', path: '/__protoserve/api/comments?file=index.html',
    headers: { Host: `localhost:${port}`, 'Content-Type': 'text/plain;charset=UTF-8' }
  }, JSON.stringify({ text: 'sneaky' }));
  assert.strictEqual(res.status, 415);
  assert.strictEqual(comments().length, before);
});

test('editing the prototype live-reloads the open page', async () => {
  await page.goto(`http://localhost:${port}/index.html`);
  await host('.ps-bar').waitFor({ timeout: 10000 });
  await page.evaluate(() => { window.__reloadProbe = true; });
  const src = fs.readFileSync(indexPath(), 'utf8');
  fs.writeFileSync(indexPath(), src.replace('Deep section', 'Deeper section'));
  await page.waitForFunction(() => window.__reloadProbe === undefined, null, { timeout: 8000 });
  assert.match(await page.content(), /Deeper section/);
  fs.writeFileSync(indexPath(), src);
});

test('writing a comment does not reload the page', async () => {
  await page.goto(`http://localhost:${port}/index.html`);
  await host('.ps-bar').waitFor({ timeout: 10000 });
  await page.waitForTimeout(700); // let any reload from the previous edit settle
  await page.evaluate(() => { window.__noReload = true; window.__protoserve.setMode('inspect'); });
  await page.click('#deep h2');
  await host('.ps-card textarea').waitFor({ timeout: 5000 });
  await host('.ps-card textarea').fill('Heading needs context.');
  await page.keyboard.press('Control+Enter');
  await host('.ps-pin').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  assert.strictEqual(await page.evaluate(() => window.__noReload), true, 'page state survived');
});

test('comment mode survives a live reload so a review is not interrupted', async () => {
  await page.goto(`http://localhost:${port}/index.html`);
  await host('.ps-bar').waitFor({ timeout: 10000 });
  await page.waitForTimeout(700);
  await page.evaluate(() => window.__protoserve.setMode('inspect'));
  await page.evaluate(() => { window.__beforeReload = true; });

  const src = fs.readFileSync(indexPath(), 'utf8');
  fs.writeFileSync(indexPath(), src.replace('Usage', 'Usage summary'));
  await page.waitForFunction(() => window.__beforeReload === undefined, null, { timeout: 8000 });
  await host('.ps-bar').waitFor({ timeout: 8000 });
  assert.strictEqual(await page.evaluate(() => window.__protoserve.mode), 'inspect',
    'still in comment mode after the agent edited the file');
  fs.writeFileSync(indexPath(), src);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__protoserve.setMode('interact'));
});

test('the overlay stays usable above a native modal dialog', async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.openModal());
  await page.keyboard.press('c');
  await page.click('#confirm p');
  await host('.ps-card textarea').waitFor({ timeout: 5000 });
  await host('.ps-card textarea').fill('Modal copy needs the amount.');
  assert.strictEqual(await host('.ps-card textarea').inputValue(), 'Modal copy needs the amount.',
    'the comment box accepts text even though the dialog makes the page inert');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const d = document.getElementById('confirm'); if (d.open) d.close(); });
});
