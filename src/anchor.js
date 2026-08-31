'use strict';
const { walk, findTag, isElement, elementChildren } = require('./annotate');

const SNIPPET_MAX = 120; // must match the client's text_snippet truncation
const MIN_SCORE = 1.5;   // below this there is no real evidence at all

function normText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function textOf(node) {
  let out = '';
  walk(node, (n) => {
    if (n.nodeName === '#text' && typeof n.value === 'string') out += n.value;
  });
  return normText(out);
}

function attr(node, name) {
  const a = (node.attrs || []).find((x) => x.name === name);
  return a ? a.value : null;
}

function locOf(node) {
  const l = node.sourceCodeLocation;
  if (!l || !l.startTag) return null;
  return { line: l.startLine, col: l.startCol };
}

function classSet(str) {
  return new Set(String(str || '').split(/\s+/).filter(Boolean));
}
function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
function overlaps(a, b) {
  for (const v of a) if (b.has(v)) return true;
  return false;
}
/**
 * The recorded classes come from the LIVE DOM, so a prototype that toggles
 * classes in JavaScript records more than the source has. A source element
 * whose classes are all present in the recording is therefore compatible —
 * but on its own that is weak evidence, never proof.
 */
function classesCompatible(nodeClasses, anchorClasses) {
  if (!nodeClasses.size || !anchorClasses.size) return false;
  for (const c of nodeClasses) if (!anchorClasses.has(c)) return false;
  return true;
}

/** The last `k` structural steps leading to this node, as the client records them. */
function tailOf(node, k) {
  const out = [];
  let n = node;
  while (n && n.tagName !== 'body' && out.length < k) {
    const par = n.parentNode;
    if (!par) break;
    const same = elementChildren(par).filter((c) => c.tagName === n.tagName);
    out.unshift({ tag: n.tagName, index: same.indexOf(n) });
    n = par;
  }
  return out;
}
function tailMatches(node, path, k) {
  if (!path || path.length < k) return false;
  const want = path.slice(-k);
  const got = tailOf(node, k);
  if (got.length !== k) return false;
  for (let i = 0; i < k; i++) {
    if (got[i].tag !== want[i].tag || got[i].index !== want[i].index) return false;
  }
  return true;
}

function resolvePath(body, path) {
  let node = body;
  for (const step of path || []) {
    if (!node) return null;
    node = elementChildren(node).filter((c) => c.tagName === step.tag)[step.index] || null;
  }
  return node === body ? null : node;
}

/**
 * Re-resolve a stored anchor against the CURRENT parsed document, so line
 * numbers stay right after the file has been edited.
 *
 * Every candidate element is weighed against ALL the recorded evidence at once
 * rather than through a ladder of single signals, because any one signal can
 * lie: text repeats across identical cards, a class set matches a sibling, a
 * structural index shifts when something is inserted above.
 *
 * `verified` is granted only when some matched signal identifies exactly one
 * element AND nothing else about the candidate contradicts the recording. A
 * confidently wrong line is far worse than a flagged one.
 */
function resolveAnchor(doc, anchor) {
  const body = findTag(doc, 'body');
  if (!body || !anchor) return { found: false, method: 'none', verified: false };

  const wantTag = anchor.tag || null;
  const wantText = anchor.text_snippet || null;
  const wantClasses = classSet((anchor.classes || []).join(' '));
  const wantAttrs = (anchor.attrs && typeof anchor.attrs === 'object') ? anchor.attrs : {};
  const attrKeys = Object.keys(wantAttrs);
  const wantLoc = (anchor.loc && anchor.loc.line) ? anchor.loc : null;
  const wantId = anchor.id || null;

  const els = [];
  walk(body, (n) => { if (isElement(n)) els.push(n); });

  const cache = new Map();
  const info = (n) => {
    let i = cache.get(n);
    if (!i) {
      i = { text: textOf(n).slice(0, SNIPPET_MAX), cls: classSet(attr(n, 'class')), loc: locOf(n) };
      cache.set(n, i);
    }
    return i;
  };

  // How discriminating is each signal? A value shared by five elements proves nothing.
  // Every ancestor of <button>Go</button> also "contains" the text Go, so the
  // meaningful comparison is among elements of the same tag; failing that (the
  // tag was renamed), among the innermost elements holding that text.
  const textMatch = (n) => !!wantText && info(n).text === wantText;
  let textCands = wantTag ? els.filter((n) => textMatch(n) && n.tagName === wantTag) : [];
  if (!textCands.length) {
    textCands = els.filter((n) => textMatch(n) &&
      !elementChildren(n).some((c) => info(c).text === wantText));
  }
  const textSet = new Set(textCands);
  const textCount = textCands.length;

  let idCount = 0, attrCount = 0, classExactCount = 0;
  for (const n of els) {
    const i = info(n);
    if (wantId && attr(n, 'id') === wantId) idCount++;
    if (wantClasses.size && sameSet(i.cls, wantClasses)) classExactCount++;
    if (attrKeys.length && attrKeys.every((k) => attr(n, k) === wantAttrs[k])) attrCount++;
  }

  const pathNode = (anchor.path && anchor.path.length) ? resolvePath(body, anchor.path) : null;

  // Is this element distinguishable from its peers by anything about itself?
  const ambiguous = (wantText && textCount > 1) ||
    (!wantText && wantClasses.size > 0 && classExactCount > 1);

  // Position relative to the nearest sibling that differs — the only thing that
  // separates the third of four identical cards from the second.
  const wantSibs = Array.isArray(anchor.sibs) ? anchor.sibs.filter((x) => x && x.text) : [];

  /** Climb `descent.length` levels and check the descent leads back to `node`. */
  const ancestorFor = (node, descent) => {
    let a = node;
    for (let i = 0; i < descent.length; i++) {
      a = a && a.parentNode;
      if (!a || !isElement(a)) return null;
    }
    if (!a) return null;
    let down = a;
    for (const step of descent) {
      if (!down) return null;
      down = elementChildren(down).filter((c) => c.tagName === step.tag)[step.index] || null;
    }
    return down === node ? a : null;
  };

  /** Does this element sit where the recording says, relative to a differing neighbour? */
  const sibCheck = (node, sig) => {
    const a = ancestorFor(node, sig.descent || []);
    if (!a) return null;
    const par = a.parentNode;
    if (!par) return null;
    const kids = elementChildren(par);
    const idx = kids.indexOf(a);
    if (idx < 0) return null;
    const mate = sig.dir === 'fwd' ? kids[idx + sig.offset] : kids[idx - sig.offset];
    if (!mate || info(mate).text !== sig.text) return null;
    // If the list itself grew or shrank, the position is suggestive, not proof:
    // deleting the third of four identical cards leaves the fourth in its place.
    return { intact: sig.total === kids.length };
  };

  // Candidates: anything with a reason to be considered.
  const pool = new Set();
  if (pathNode) pool.add(pathNode);
  for (const n of els) {
    const i = info(n);
    if (wantId && attr(n, 'id') === wantId) pool.add(n);
    if (textSet.has(n)) pool.add(n);
    if (attrKeys.length && attrKeys.some((k) => attr(n, k) === wantAttrs[k])) pool.add(n);
    if (wantClasses.size && (sameSet(i.cls, wantClasses) || classesCompatible(i.cls, wantClasses))) pool.add(n);
    if (wantLoc && i.loc && i.loc.line === wantLoc.line && i.loc.col === wantLoc.col) pool.add(n);
    // A wrapper added around the content shifts the path but keeps its tail.
    if (anchor.path && anchor.path.length >= 2 && (tailMatches(n, anchor.path, 3) || tailMatches(n, anchor.path, 2))) {
      pool.add(n);
    }
  }
  if (!pool.size) return { found: false, method: 'none', verified: false };

  const cands = [];
  for (const node of pool) {
    const i = info(node);
    if (!i.loc) continue; // nothing useful to report without a source position
    let score = 0;
    let contradicted = false;
    let unique = false;
    let method = 'path';

    const tagSame = !wantTag || node.tagName === wantTag;
    if (wantTag) score += tagSame ? 1 : -1.5;

    if (wantId) {
      const got = attr(node, 'id');
      if (got === wantId) {
        score += 6;
        method = 'id';
        if (idCount === 1) unique = true;
      } else if (got != null) {
        score -= 3; contradicted = true;   // it carries someone else's id
      }
      // no id at all: the attribute was removed, which proves nothing
    }

    if (attrKeys.length) {
      let hit = 0, miss = 0, absent = 0;
      for (const k of attrKeys) {
        const got = attr(node, k);
        if (got === wantAttrs[k]) hit++;
        else if (got == null) absent++;   // removed, not contradicted
        else miss++;
      }
      score += hit * 2 - miss * 2 - absent * 0.5;
      if (miss) contradicted = true;
      else if (hit) {
        if (method === 'path') method = 'attrs';
        if (attrCount === 1) unique = true;
      }
    }

    if (wantText) {
      if (textSet.has(node)) {
        score += 4;
        if (textCount === 1) { unique = true; if (method === 'path') method = 'tag+text'; }
      } else if (textMatch(node)) {
        score += 0.5;   // contains the text, but an inner element really holds it
      } else { score -= 2; contradicted = true; }
    }

    if (wantClasses.size) {
      if (sameSet(i.cls, wantClasses)) {
        score += 3;
        if (classExactCount === 1) { unique = true; if (method === 'path') method = 'tag+class'; }
      } else if (classesCompatible(i.cls, wantClasses)) {
        score += 1;      // weak: a plain .btn is "compatible" with .btn.primary
      } else if (overlaps(i.cls, wantClasses)) {
        score += 0.3;
      } else { score -= 1; }
    }

    if (node === pathNode) score += 3;
    else if (tailMatches(node, anchor.path, 3)) score += 1.6;
    else if (tailMatches(node, anchor.path, 2)) score += 0.8;

    // Sitting at the exact position it was recorded at means the file has not
    // shifted around this element — the strongest possible structural evidence.
    if (wantLoc && i.loc.line === wantLoc.line && i.loc.col === wantLoc.col) {
      score += 2.5;
      // Only trustworthy when the element is otherwise distinguishable: an
      // insertion above can slide a DIFFERENT element into the recorded spot.
      if (node === pathNode && !ambiguous) unique = true;
    }

    const sibHits = wantSibs.map((sig) => sibCheck(node, sig));
    const sibOk = sibHits.some((h) => h);
    if (sibOk) score += 2.5;

    cands.push({ node, score, contradicted, unique, sibHits, method, loc: i.loc, text: i.text });
  }

  // Among otherwise identical siblings, the one sitting in the recorded position
  // relative to a differing neighbour is the one that was commented on — as long
  // as exactly one candidate qualifies at that level and the list is unchanged.
  for (let level = 0; level < wantSibs.length; level++) {
    const hits = cands.filter((c) => !c.contradicted && c.sibHits[level]);
    if (hits.length !== 1) continue;
    // Decisive: when something was inserted or removed, structural indices and
    // line numbers have shifted and can land on a neighbour, but the recorded
    // position relative to a DIFFERING sibling still points at the right one.
    hits[0].score += 5;
    if (hits[0].sibHits[level].intact) hits[0].unique = true;
    break;
  }

  let best = null;
  let second = null;
  for (const cand of cands) {
    if (!best || cand.score > best.score) { second = best; best = cand; }
    else if (!second || cand.score > second.score) second = cand;
  }

  if (!best || best.score < MIN_SCORE) return { found: false, method: 'none', verified: false };
  // Two candidates that fit equally well mean we genuinely cannot tell which is
  // meant; reporting either one would be a coin toss dressed up as an answer.
  const isVerified = best.unique && !best.contradicted;
  if (!isVerified && second && best.score - second.score < 0.5) {
    return { found: false, method: 'none', verified: false };
  }
  return {
    found: true,
    method: best.method,
    verified: isVerified,
    line: best.loc.line,
    col: best.loc.col,
    tag: best.node.tagName,
    text: textOf(best.node).slice(0, 200)
  };
}

module.exports = { resolveAnchor, textOf, normText, attr, locOf, classesCompatible, SNIPPET_MAX };
