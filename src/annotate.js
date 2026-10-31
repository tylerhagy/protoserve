'use strict';
const parse5 = require('parse5');

// Elements we never annotate: they are not commentable UI.
const SKIP = new Set(['html', 'head', 'meta', 'link', 'title', 'base', 'script', 'style']);
const LOC_ATTR = 'data-ps-loc';

function parseDoc(html) {
  return parse5.parse(html, { sourceCodeLocationInfo: true });
}

/**
 * Depth-first walk over rendered content only. <template> contents are
 * deliberately skipped: they are inert, can never be clicked, and letting them
 * compete with real elements makes anchor resolution point at the wrong place.
 */
function walk(node, fn) {
  fn(node);
  const kids = node.childNodes || [];
  for (let i = 0; i < kids.length; i++) walk(kids[i], fn);
}

function findTag(root, tagName) {
  let found = null;
  walk(root, (n) => { if (!found && n.tagName === tagName) found = n; });
  return found;
}

function isElement(node) {
  return typeof node.tagName === 'string';
}

function elementChildren(node) {
  return (node.childNodes || []).filter(isElement);
}

function hasAttr(node, name) {
  return (node.attrs || []).some((a) => a.name === name);
}

/**
 * Insert data-ps-loc="line:col" into the start tag of every commentable element
 * inside <body>, immediately after the tag name as it appears IN THE SOURCE.
 * The source name is measured rather than taken from node.tagName, because the
 * HTML tree builder rewrites some names (<image> becomes img) and a length
 * mismatch would splice the attribute into the middle of the tag.
 */
function annotate(html) {
  const doc = parseDoc(html);
  const body = findTag(doc, 'body');
  const inserts = [];
  const seen = new Set();

  if (body) {
    walk(body, (node) => {
      if (!isElement(node)) return;
      if (SKIP.has(node.tagName)) return;
      if (hasAttr(node, LOC_ATTR)) return; // never emit a duplicate attribute
      const loc = node.sourceCodeLocation;
      if (!loc || !loc.startTag) return; // implied or synthesized element
      const start = loc.startTag.startOffset;
      // Misnested formatting elements are cloned by the parser and the clones
      // share one source location; annotate the position only once.
      if (seen.has(start)) return;
      seen.add(start);
      const name = /^[^\s/>]+/.exec(html.slice(start + 1, start + 1 + 512));
      const nameLen = name ? name[0].length : node.tagName.length;
      inserts.push({ offset: start + 1 + nameLen, text: ` ${LOC_ATTR}="${loc.startLine}:${loc.startCol}"` });
    });
  }

  inserts.sort((a, b) => b.offset - a.offset);
  let out = html;
  for (const ins of inserts) out = out.slice(0, ins.offset) + ins.text + out.slice(ins.offset);
  return out;
}

/**
 * Insert our scripts at the very top of <head>, so that nothing is ever added
 * to <body>. A prototype's own `body > div`, `:last-child` and `body.children`
 * logic then behaves exactly as it would standalone, and our interaction guard
 * registers its listeners before any of the page's scripts run.
 * Matched case-insensitively on the original string — lowercasing first can
 * change the string's length (U+0130).
 */
function injectScript(html, scriptTag) {
  // Find the REAL start tags with the parser, not with a regex over the text: a
  // page whose own JavaScript contains the string '<html>' (an export that
  // rebuilds the document, say) and which has no explicit <head> would
  // otherwise get the tag spliced into the middle of that string.
  const doc = parseDoc(html);
  const explicit = (tag) => {
    const n = findTag(doc, tag);
    return n && n.sourceCodeLocation && n.sourceCodeLocation.startTag
      ? n.sourceCodeLocation.startTag.endOffset : -1;
  };
  let at = explicit('head');
  if (at < 0) at = explicit('html');
  if (at >= 0) return html.slice(0, at) + '\n' + scriptTag + html.slice(at);
  // Neither is written out (an implied head): go straight after the doctype if
  // there is one, else the very top — still before any of the page's scripts.
  const dt = (doc.childNodes || []).find((n) => n.nodeName === '#documentType');
  if (!dt || !dt.sourceCodeLocation) return scriptTag + '\n' + html;
  const end = dt.sourceCodeLocation.endOffset;
  return html.slice(0, end) + '\n' + scriptTag + html.slice(end);
}

module.exports = { annotate, injectScript, parseDoc, walk, findTag, isElement, elementChildren, LOC_ATTR };
