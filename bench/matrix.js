/* Resolver accuracy matrix: build anchors the way the real client does, apply
   realistic edits, and score every anchor against ground truth. */
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');
const { createServer, listen } = require('../src/server');
const { parseDoc, walk } = require('../src/annotate');
const { resolveAnchor, attr } = require('../src/anchor');

const SRC = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');

const EDITS = {
  'unedited': (h) => h,
  'insert banner at top': (h) => h.replace('<nav class="nav">', '<div class="promo">Save 10%</div>\n<nav class="nav">'),
  'insert card at front': (h) => h.replace('<article class="card" data-truth="c1">',
    '<article class="card"><h3>New</h3><p class="price">$0</p></article>\n<article class="card" data-truth="c1">'),
  'wrap cards in a grid div': (h) => h.replace('<section class="cards">', '<section class="cards"><div class="grid">')
    .replace('</section>', '</div></section>'),
  'rename article to section': (h) => h.replace(/<article class="card"/g, '<section class="card"').replace(/<\/article>/g, '</section>'),
  'rewrite prose copy': (h) => h
    .replace('Readings are captured every fifteen minutes and reconciled overnight.', 'Meters report every five minutes.')
    .replace('Any gap longer than an hour is flagged for manual review.', 'Gaps over ten minutes are flagged.')
    .replace('Accuracy beats speed here.', 'Correctness first.'),
  'reorder nav': (h) => h.replace(/(<a class="nav-link" data-truth="n1"[^>]*>Overview<\/a>\n)(<a class="nav-link" data-truth="n2"[^>]*>Meters<\/a>\n)/, '$2$1'),
  'delete first two table rows': (h) => h.replace(/<tr class="row" data-truth="r1">.*?<\/tr>\n<tr class="row" data-truth="r2">.*?<\/tr>\n/s, ''),
  'add modifier classes to buttons': (h) => h.replace('class="icon-btn" data-truth="b1"', 'class="icon-btn icon-btn--search" data-truth="b1"')
    .replace('class="btn" data-truth="b3"', 'class="btn btn-primary" data-truth="b3"'),
  'strip button classes': (h) => h.replace('class="btn" data-truth="b3"', 'data-truth="b3"').replace('class="btn btn-ghost" data-truth="b4"', 'data-truth="b4"'),
  'swap button labels': (h) => h.replace('data-truth="b3">Apply<', 'data-truth="b3">Reset<').replace('data-truth="b4">Reset<', 'data-truth="b4">Apply<'),
  'change one card heading': (h) => h.replace('data-truth="c2h">Plan<', 'data-truth="c2h">Starter<'),
  'wrap each card body': (h) => h.replace(/(<article class="card" data-truth="c\d">)(<h3)/g, '$1<div class="inner">$2')
    .replace(/(<\/p>)(<\/article>)/g, '$1</div>$2'),
  'move todo item to a new list': (h) => h.replace('<li data-truth="t3">Close the ticket</li>\n', '')
    .replace('</ul>', '</ul>\n<ul class="done"><li data-truth="t3">Close the ticket</li></ul>'),
  'add decoy with duplicate text': (h) => h.replace('<table>', '<p class="decoy">Acme Co</p>\n<table>'),
  'delete the search button': (h) => h.replace(/<button class="icon-btn" data-truth="b1"[^]*?<\/button>\n/, ''),
  'reindent everything': (h) => h.split('\n').map((l) => '  ' + l).join('\n'),
  'add aria-labels to nav': (h) => h.replace(/<a class="nav-link" data-truth="(n\d)"/g, '<a class="nav-link" aria-label="nav-$1" data-truth="$1"'),
  'delete a whole card': (h) => h.replace(/<article class="card" data-truth="c3">[^]*?<\/article>\n/, ''),
  'change table row classes': (h) => h.replace(/class="row"/g, 'class="table-row"').replace('class="row alt"', 'class="table-row alt"')
};

function truthLine(html, id) {
  const doc = parseDoc(html);
  let line = null;
  walk(doc, (n) => {
    if (!line && n.tagName && attr(n, 'data-truth') === id && n.sourceCodeLocation && n.sourceCodeLocation.startTag) {
      line = n.sourceCodeLocation.startLine;
    }
  });
  return line;
}

async function run(log) {
  const say = log || (() => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  fs.writeFileSync(path.join(root, 'index.html'), SRC);
  const srv = createServer(root);
  const port = await listen(srv, 0, 'localhost');
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${port}/index.html`);
  await page.locator('#__protoserve_host .ps-bar').waitFor({ timeout: 15000 });

  const anchors = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-truth]').forEach((el) => {
      out.push({ id: el.getAttribute('data-truth'), anchor: window.__protoserve.anchorFor(el) });
    });
    return out;
  });
  await b.close(); srv.close(); fs.rmSync(root, { recursive: true, force: true });

  const tally = { correctVerified: 0, correctUnverified: 0, wrongVerified: 0, wrongUnverified: 0, miss: 0, goneOk: 0, goneBad: 0 };
  const worst = [];
  for (const [name, fn] of Object.entries(EDITS)) {
    const edited = fn(SRC);
    const doc = parseDoc(edited);
    let rowWrongVerified = 0, rowMiss = 0, rowUnverified = 0;
    for (const { id, anchor } of anchors) {
      const truth = truthLine(edited, id);
      const r = resolveAnchor(doc, anchor);
      if (truth === null) { // the element was deleted on purpose
        if (!r.found || !r.verified) tally.goneOk++; else { tally.goneBad++; worst.push(`${name}/${id}: deleted but verified -> line ${r.line}`); }
        continue;
      }
      if (!r.found) { tally.miss++; rowMiss++; worst.push(`${name}/${id}: MISS (truth line ${truth})`); continue; }
      const right = r.line === truth;
      if (right && r.verified) tally.correctVerified++;
      else if (right) { tally.correctUnverified++; rowUnverified++; }
      else if (r.verified) { tally.wrongVerified++; rowWrongVerified++; worst.push(`${name}/${id}: WRONG+VERIFIED line ${r.line} != ${truth}`); }
      else { tally.wrongUnverified++; worst.push(`${name}/${id}: wrong but flagged (${r.line} != ${truth})`); }
    }
    say(`${name.padEnd(32)} wrongVerified=${rowWrongVerified}  miss=${rowMiss}  unverified=${rowUnverified}`);
  }
  const total = Object.values(tally).reduce((a, c) => a + c, 0);
  say('\n=== totals over ' + total + ' cases ===');
  for (const [k, v] of Object.entries(tally)) say(`  ${k.padEnd(18)} ${v}  (${(v / total * 100).toFixed(1)}%)`);
  if (worst.length) { say('\n--- violations ---'); worst.slice(0, 12).forEach((w) => say('  ' + w)); }
  return { tally, total, worst };
}

module.exports = { run };
if (require.main === module) run(console.log.bind(console));
