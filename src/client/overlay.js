/* protoserve overlay — runs inside the served prototype. */
(function () {
  'use strict';
  if (window.__protoserveLoaded) return;
  try { if (window.top !== window.self) return; } catch (e) { return; }
  window.__protoserveLoaded = true;

  var CFG = window.__PS || {};
  var MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '\u2318' : 'Ctrl+';
  var FILE = CFG.file;
  var BASE = '/__protoserve';

  var comments = [];
  var mode = 'interact';
  var filter = 'open';
  var panelOpen = false;
  var activeId = null;
  var hoverEl = null;
  var elCache = new Map();
  var missGen = 0;
  var toastTimer = null;
  var listening = 0;       // live `protoserve watch --sent` processes, as reported by the server
  var barPos = null;       // where the toolbar was dragged to; null means its home corner
  var dragging = false;
  var scopeOpen = false;   // the file menu in the panel header
  var pinEls = new Map();  // comment id -> its pin element, kept across renders

  // Comment mode and the panel survive a live reload, so an agent editing the
  // file mid-review does not knock the user out of what they were doing.
  function remember(key, value) {
    try { sessionStorage.setItem('protoserve:' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  function recall(key, fallback) {
    try {
      var raw = sessionStorage.getItem('protoserve:' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  /* remember/recall are sessionStorage: they carry UI state across a live reload and are meant to
     die with the tab. A PREFERENCE has to outlive the tab, so it gets localStorage instead. */
  function keep(key, value) {
    try { localStorage.setItem('protoserve:' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  function kept(key, fallback) {
    try {
      var raw = localStorage.getItem('protoserve:' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  /* Pin colours. Six, because the point is to get clear of whatever colour the prototype already
     uses, and six well-separated hues do that without turning into a colour picker. Green and red
     are absent on purpose: this UI already spends them on resolved and delete. Every one of these
     carries white text at >=4.5:1, since the pin number sits on top of it and at 11px/600 it is not
     large text. Measured, not assumed — orange and teal both started brighter and both failed
     (3.51 and 3.95), so they are deepened here rather than left as a claim the code did not meet. */
  var PIN_COLORS = [
    { name: 'Blue',     hex: '#0071e3' },
    { name: 'Violet',   hex: '#6c3ce9' },
    { name: 'Magenta',  hex: '#d81b7a' },
    { name: 'Orange',   hex: '#c25208' },
    { name: 'Teal',     hex: '#0d7a76' },
    { name: 'Graphite', hex: '#3a3a3c' }
  ];
  /* CFG.files arrives as [{name, open, resolved}]. Normalised here so a plain array of names (an
     older server, a hand-built config) still renders rather than throwing. */
  var scopes = (CFG.files || []).map(function (f) {
    return typeof f === 'string' ? { name: f, open: 0, resolved: 0 } : f;
  });
  function refreshScopes() {
    // nothing renders these unless the panel is open on a folder holding more than one prototype
    if (scopes.length < 2 || !panelOpen) return Promise.resolve();
    return fetch(BASE + '/files').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.files) { scopes = d.files; render(); }
    }).catch(function () { /* the names we already have still work */ });
  }

  /* Validated, not trusted: a value from an older build or a hand-edited entry would be handed
     straight to setProperty, silently rejected as an invalid colour, and leave no swatch marked —
     the pins would be blue with nothing in the UI saying why. */
  var pinColor = (function () {
    var stored = kept('pin', null);
    return PIN_COLORS.some(function (c) { return c.hex === stored; }) ? stored : PIN_COLORS[0].hex;
  })();
  function applyPin() {
    root.style.setProperty('--ps-pin', pinColor);
    root.style.setProperty('--ps-pin-ink', '#ffffff');
  }
  function setPin(hex) { pinColor = hex; keep('pin', hex); applyPin(); render(); }

  var ICON = {
    cursor: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-9 8.4 8.9 8.9 0 01-3.8-.9L3 20.5l1.6-4.8A8.4 8.4 0 1121 11.5z"/></svg>',
    list: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    undo: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 106-6.7"/></svg>',
    trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
    edit: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
    reply: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17l-5-5 5-5"/><path d="M4 12h11a5 5 0 015 5v2"/></svg>',
    close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    grip: '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg>',
    chev: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    tick: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    camera: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>'
  };

  // ---------------------------------------------------------------- shadow host
  var host = document.createElement('div');
  host.id = '__protoserve_host';
  host.setAttribute('data-protoserve', 'ui');
  // Neutralise the popover user-agent styles we inherit by joining the top layer.
  host.style.cssText = 'position:fixed;top:0;left:0;inset:auto;width:0;height:0;border:0;margin:0;' +
    'padding:0;background:transparent;overflow:visible;color:inherit;z-index:2147483647';
  /* To the prototype, a click or focus inside our UI looks like one OUTSIDE its dialog: our host is
     a different subtree, so a dialog that closes on outside-pointerdown, an outside-click handler,
     or a focus trap reacts the moment you reach for the comment box. That is why commenting on
     overlays kept dismissing them. Stopping these at the host, in the bubble phase, means our own
     handlers (which sit below it) still run and nothing above us is told. */
  ['pointerdown', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'focusin', 'focusout']
    .forEach(function (t) { host.addEventListener(t, function (e) { e.stopPropagation(); }); });
  var shadow = host.attachShadow({ mode: 'open' });
  var styleEl = document.createElement('style');
  styleEl.textContent = CFG.css || '';
  var root = document.createElement('div');
  root.className = 'ps-root';
  shadow.appendChild(styleEl);
  shadow.appendChild(root);

  // A prototype's <dialog open> or [popover] renders in the browser's top layer,
  // which sits above every z-index. The overlay joins the top layer too, and
  // re-asserts itself whenever the page opens something new up there.
  var topLayer = false;
  // The overlay should harmonise with the prototype underneath it, not with
  // whatever theme the viewer's OS happens to be set to.
  function opaqueBg(el) {
    if (!el) return null;
    var bg = window.getComputedStyle(el).backgroundColor;
    if (!bg) return null;
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(bg);
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) < 0.5) return null; // see-through
    return [+m[1], +m[2], +m[3]];
  }
  function pageTheme() {
    // A page that paints no background renders white, so light is the default.
    var rgb = opaqueBg(document.body) || opaqueBg(document.documentElement);
    if (!rgb) return 'light';
    var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    return lum < 0.5 ? 'dark' : 'light';
  }
  function applyTheme() {
    try {
      var next = pageTheme();
      if (root.getAttribute('data-theme') !== next) root.setAttribute('data-theme', next);
    } catch (e) { /* keep default */ }
  }

  function homeFor() {
    return topmostModal() || document.documentElement || document.body;
  }
  function mount() {
    homeFor().appendChild(host);
    applyTheme();
    try {
      if (typeof host.showPopover === 'function' && 'popover' in HTMLElement.prototype) {
        host.setAttribute('popover', 'manual');
        host.showPopover();
        topLayer = true;
      }
    } catch (e) {
      host.removeAttribute('popover');
      topLayer = false;
    }
    watchTopLayer();
    render();
  }
  function raise() {
    if (!topLayer) return;
    try { host.hidePopover(); } catch (e) { /* not open */ }
    try { host.showPopover(); } catch (e) { topLayer = false; host.removeAttribute('popover'); }
  }

  // A modal <dialog> makes the whole document outside it inert, so our UI would
  // render but refuse focus and clicks. Living inside the topmost modal while one
  // is open keeps the overlay usable; we move back out when it closes.
  var CUSTOM_MODAL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  function topmostModal() {
    var found = null;
    try {
      var open = document.querySelectorAll('dialog[open]');
      for (var i = 0; i < open.length; i++) {
        var d = open[i];
        var modal = true;
        try { modal = d.matches(':modal'); } catch (e) { modal = true; }
        if (modal && !d.contains(host)) found = d;
        else if (modal && d.contains(host)) found = d;
      }
      if (found) return found; // a native modal sits above anything a framework can build
      /* Frameworks (MUI, Radix, Headless UI) build their own dialogs out of divs. Those trap focus
         and treat anything outside them as outside, so the overlay has to live inside the one that
         is open, the same as it does for a native modal. Last in document order is the topmost:
         portals append to the end of the body. */
      var custom = document.querySelectorAll(CUSTOM_MODAL);
      for (var j = 0; j < custom.length; j++) {
        var c = custom[j];
        if (c.localName === 'dialog') continue;
        if (c.contains(host) || isVisible(c)) found = c;
      }
    } catch (e) { found = null; }
    return found;
  }
  function syncHome() {
    var want = homeFor();
    if (!want) return;
    // A prototype that re-renders its container can take the overlay with it.
    if (host.parentElement === want && host.isConnected) return;
    want.appendChild(host);
    raise(); // moving in the DOM drops us out of the top layer
  }
  function watchTopLayer() {
    if (typeof MutationObserver !== 'function') return;
    var mo = new MutationObserver(function (muts) {
      // A dialog that unmounts takes the overlay with it; come back at once, not on the next tick.
      if (!host.isConnected) { syncHome(); raise(); return; }
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.target === host || (host.contains && host.contains(m.target))) continue;
        if (m.type === 'attributes') { syncHome(); raise(); return; }
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType !== 1) continue;
          var isModal = false;
          try { isModal = !!(n.matches && (n.matches(CUSTOM_MODAL) || n.querySelector(CUSTOM_MODAL))); } catch (e) { isModal = false; }
          if (n.tagName === 'DIALOG' || n.hasAttribute('popover') || isModal) { syncHome(); raise(); return; }
        }
      }
    });
    try {
      mo.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'popover']
      });
    } catch (e) { /* observation is best effort */ }
  }

  // ---------------------------------------------------------------- helpers
  function h(tag, props, kids) {
    var el = document.createElement(tag);
    if (props) {
      for (var k in props) {
        var v = props[k];
        if (v == null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      }
    }
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function normText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function inHost(e) {
    var p = e.composedPath ? e.composedPath() : [];
    return p.indexOf(host) !== -1;
  }
  function ago(iso) {
    var d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!isFinite(d)) return '';
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  function api(method, path, body) {
    var url = BASE + '/api/comments' + (path || '');
    url += (url.indexOf('?') >= 0 ? '&' : '?') + 'file=' + encodeURIComponent(FILE);
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || ('HTTP ' + r.status)); });
      return r.json();
    });
  }

  // ---------------------------------------------------------------- anchors
  function pathOf(el) {
    var p = [], n = el;
    while (n && n !== document.body) {
      var par = n.parentElement;
      if (!par) return null;
      var same = [], ch = par.children;
      for (var i = 0; i < ch.length; i++) if (ch[i].localName === n.localName) same.push(ch[i]);
      p.unshift({ tag: n.localName, index: same.indexOf(n) });
      n = par;
    }
    return n === document.body ? p : null;
  }
  function resolvePath(path) {
    var n = document.body;
    for (var i = 0; i < path.length; i++) {
      if (!n) return null;
      var step = path[i], same = [], ch = n.children;
      for (var j = 0; j < ch.length; j++) if (ch[j].localName === step.tag) same.push(ch[j]);
      n = same[step.index] || null;
    }
    return n;
  }
  function selectorOf(el) {
    if (el.id) return '#' + el.id;
    var s = el.localName;
    var cls = Array.prototype.slice.call(el.classList).filter(Boolean).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  }
  function cleanHtml(el) {
    return el.outerHTML.replace(/\sdata-ps-loc="[^"]*"/g, '');
  }

  // Icons, buttons and images often carry no text at all, so these attributes
  // are what actually identify them after the markup around them changes.
  var IDENT_ATTRS = ['aria-label', 'title', 'alt', 'name', 'type', 'role', 'for',
    'placeholder', 'href', 'src', 'value', 'data-testid', 'data-test-id', 'data-test'];
  function identAttrs(el) {
    var out = {};
    if (!el || !el.getAttribute) return out;
    for (var i = 0; i < IDENT_ATTRS.length; i++) {
      var k = IDENT_ATTRS[i];
      var v = el.getAttribute(k);
      if (v != null && v !== '') out[k] = String(v).slice(0, 120);
    }
    return out;
  }
  // Identical siblings — cards, table rows, list items — cannot be told apart by
  // anything about themselves. Their position relative to the nearest sibling
  // that DOES differ survives insertions and deletions, and can. Signatures are
  // recorded at this element's level and at its ancestors', because the h3
  // inside the third identical card is only identifiable via the card.
  function sigAt(node) {
    var par = node.parentElement;
    if (!par) return null;
    var kids = Array.prototype.slice.call(par.children);
    var idx = kids.indexOf(node);
    if (idx < 0) return null;
    var mine = normText(node.textContent).slice(0, 120);
    for (var i = idx - 1; i >= 0; i--) {
      var back = normText(kids[i].textContent).slice(0, 120);
      if (back && back !== mine) return { text: back, offset: idx - i, dir: 'back', total: kids.length };
    }
    for (var j = idx + 1; j < kids.length; j++) {
      var fwd = normText(kids[j].textContent).slice(0, 120);
      if (fwd && fwd !== mine) return { text: fwd, offset: j - idx, dir: 'fwd', total: kids.length };
    }
    return null;
  }
  function siblingSignatures(el) {
    var out = [];
    var node = el;
    var descent = [];
    for (var depth = 0; node && node !== document.body && depth < 4; depth++) {
      var sig = sigAt(node);
      if (sig) {
        sig.descent = descent.slice();
        out.push(sig);
      }
      var par = node.parentElement;
      if (!par) break;
      var same = [], ch = par.children;
      for (var i = 0; i < ch.length; i++) if (ch[i].localName === node.localName) same.push(ch[i]);
      descent.unshift({ tag: node.localName, index: same.indexOf(node) });
      node = par;
    }
    return out;
  }

  function anchorFrom(el, extra) {
    var raw = el.getAttribute ? el.getAttribute('data-ps-loc') : null;
    var parts = raw ? raw.split(':') : null;
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    var a = {
      kind: extra && extra.selected_text ? 'selection' : 'element',
      loc: parts ? { line: +parts[0], col: +parts[1] } : null,
      id: el.id || null,
      tag: el.localName,
      classes: Array.prototype.slice.call(el.classList),
      path: pathOf(el),
      selector: selectorOf(el),
      text_snippet: normText(el.textContent).slice(0, 120),
      attrs: identAttrs(el),
      sibs: siblingSignatures(el),
      outer_html: cleanHtml(el).slice(0, 400),
      box: {
        x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY),
        w: Math.round(r.width), h: Math.round(r.height)
      },
      computed: {
        display: cs.display, margin: cs.margin, padding: cs.padding,
        fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily,
        color: cs.color, backgroundColor: cs.backgroundColor,
        width: cs.width, height: cs.height, gap: cs.gap, borderRadius: cs.borderRadius
      }
    };
    if (extra) for (var k in extra) a[k] = extra[k];
    return a;
  }
  function anchorFromSelection(sel) {
    var range = sel.getRangeAt(0);
    var node = range.commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentElement;
    if (!node || node.nodeType !== 1) return null;
    return anchorFrom(node, { selected_text: normText(sel.toString()).slice(0, 300) });
  }
  function anchorEl(a) {
    var wrap = h('div', { class: 'ps-anchor' });
    if (!a) return wrap;
    if (a.selected_text) {
      wrap.appendChild(h('span', { class: 'ps-snip', text: '\u201c' + a.selected_text.slice(0, 50) + '\u201d' }));
      return wrap;
    }
    wrap.appendChild(h('span', { class: 'ps-sel', text: a.selector || a.tag || '' }));
    if (a.text_snippet) wrap.appendChild(h('span', { class: 'ps-snip', text: ' \u00b7 ' + a.text_snippet.slice(0, 34) }));
    return wrap;
  }

  function isVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var cs = window.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function captureState() {
    var dialogs = [], tabs = [];
    try {
      document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]').forEach(function (d) {
        if (isVisible(d)) dialogs.push(selectorOf(d));
      });
      document.querySelectorAll('[role="tab"][aria-selected="true"]').forEach(function (t) {
        tabs.push(normText(t.textContent).slice(0, 60));
      });
    } catch (e) { /* best effort */ }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      path: location.pathname, hash: location.hash || null, title: document.title,
      open_dialogs: dialogs, active_tabs: tabs
    };
  }

  // ---------------------------------------------------------------- screenshot
  var htiPromise = null;
  function loadHTI() {
    if (htiPromise) return htiPromise;
    htiPromise = new Promise(function (res, rej) {
      if (window.htmlToImage) return res(window.htmlToImage);
      var s = document.createElement('script');
      s.src = BASE + '/html-to-image.js';
      s.onload = function () { res(window.htmlToImage); };
      s.onerror = function () { rej(new Error('html-to-image failed to load')); };
      document.head.appendChild(s);
    });
    return htiPromise;
  }
  function capture() {
    return loadHTI().then(function (hti) {
      if (!hti || !hti.toPng) return null;
      var bg = window.getComputedStyle(document.body).backgroundColor;
      if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = '#ffffff';
      var opts = {
        filter: function (n) { return n !== host; },
        width: window.innerWidth, height: window.innerHeight,
        style: {
          transform: 'translate(' + (-window.scrollX) + 'px,' + (-window.scrollY) + 'px)',
          transformOrigin: 'top left'
        },
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        backgroundColor: bg
      };
      return hti.toPng(document.documentElement, opts).catch(function () {
        opts.skipFonts = true;
        return hti.toPng(document.documentElement, opts);
      });
    }).catch(function () { return null; });
  }
  function captureSoon(ms) {
    return Promise.race([
      capture(),
      new Promise(function (r) { setTimeout(function () { r(null); }, ms || 5000); })
    ]).catch(function () { return null; });
  }

  // ---------------------------------------------------------------- mode
  var cursorStyle = null;
  function setMode(next) {
    mode = next;
    if (window.__psGuard) window.__psGuard.mode = mode;
    remember('mode', mode);
    clearHover();
    syncHome();
    raise();
    if (mode === 'inspect') {
      if (!cursorStyle) {
        cursorStyle = document.createElement('style');
        cursorStyle.setAttribute('data-protoserve', 'cursor');
        /* A disabled control swallows the click: the browser never fires it at the control or at
           anything above it, so a disabled button could not be commented on at all. Making them
           transparent to the pointer sends the click to whatever is behind, and pointTarget()
           below finds the control again from where the pointer is. */
        cursorStyle.textContent = 'body, body * { cursor: crosshair !important; }' +
          ' :disabled { pointer-events: none !important; }';
        document.head.appendChild(cursorStyle);
      }
    } else if (cursorStyle) {
      cursorStyle.remove();
      cursorStyle = null;
    }
    render();
  }

  /* The element under the pointer, disabled controls included. e.target is the parent when the
     pointer is over a disabled button (see the style in setMode), so look for a disabled control
     inside it that actually contains the pointer and take the smallest, which is the innermost. */
  function pointTarget(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return el;
    var best = null, bestArea = Infinity;
    try {
      var ds = el.querySelectorAll(':disabled');
      for (var i = 0; i < ds.length; i++) {
        var r = ds[i].getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
        if (!isVisible(ds[i])) continue;
        var area = r.width * r.height;
        if (area < bestArea) { best = ds[i]; bestArea = area; }
      }
    } catch (err) { best = null; }
    return best || el;
  }

  function onClickCapture(e) {
    if (mode !== 'inspect' || inHost(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    /* In comment mode this IS the outside-click path for the scope menu. The document-level
       listener below cannot serve it: guard.js binds on window (capture), which precedes document,
       and stops the event dead before it ever reaches us. A dismissing click dismisses and does
       nothing else — otherwise one click both closed the menu and opened a compose card under it,
       leaving two things to Escape out of. */
    if (scopeOpen) { scopeOpen = false; render(); return; }
    var sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed && normText(sel.toString())) {
      var a = anchorFromSelection(sel);
      if (a) {
        var rect = sel.getRangeAt(0).getBoundingClientRect();
        sel.removeAllRanges();
        return openCompose(a, rect, null);
      }
    }
    var el = pointTarget(e);
    if (!el || el.nodeType !== 1) return;
    openCompose(anchorFrom(el), el.getBoundingClientRect(), null);
  }
  function blockIt(e) {
    if (mode !== 'inspect' || inHost(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function onMove(e) {
    if (mode !== 'inspect') return;
    if (inHost(e)) return clearHover();
    var el = pointTarget(e);
    if (!el || el.nodeType !== 1 || el === hoverEl) return;
    hoverEl = el;
    drawHover(el);
  }
  function clearHover() {
    hoverEl = null;
    var a = root.querySelector('.ps-hi'), b = root.querySelector('.ps-tag');
    if (a) a.remove();
    if (b) b.remove();
  }
  function drawHover(el) {
    clearHover();
    var r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return;
    var cs = window.getComputedStyle(el);
    var hi = h('div', { class: 'ps-hi' });
    hi.style.left = r.left + 'px'; hi.style.top = r.top + 'px';
    hi.style.width = r.width + 'px'; hi.style.height = r.height + 'px';
    hi.style.borderRadius = cs.borderRadius && cs.borderRadius !== '0px' ? cs.borderRadius : '3px';
    root.appendChild(hi);
    if (r.width < 26 || r.height < 13) return;
    var tag = h('div', { class: 'ps-tag', text: selectorOf(el) });
    root.appendChild(tag);
    var ty = r.top - 23;
    tag.style.left = Math.max(2, Math.min(r.left, window.innerWidth - tag.offsetWidth - 2)) + 'px';
    tag.style.top = (ty < 2 ? r.top + 4 : ty) + 'px';
  }

  if (window.__psGuard) {
    window.__psGuard.onClick = onClickCapture;
  } else {
    // The guard normally loads first, ahead of the page's own scripts.
    window.addEventListener('click', onClickCapture, true);
    window.addEventListener('submit', blockIt, true);
    ['auxclick', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
      'contextmenu', 'dragstart'].forEach(function (t) {
      window.addEventListener(t, function (e) {
        if (mode !== 'inspect' || inHost(e)) return;
        e.stopImmediatePropagation();
        if (t === 'dragstart' || t === 'dblclick' || t === 'auxclick') e.preventDefault();
      }, true);
    });
  }
  /* Whatever card is open owns the keys while you are typing in it. These live here rather than on
     the textarea because the guard stops key events at window — ahead of the prototype's shortcuts,
     and therefore ahead of our own listeners too — and calls this instead. */
  var cardKeys = null;
  var cardInput = null;   // called after every edit to the open card's text, so a draft can be kept
  var FIELD_EVENTS = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input',
    'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'cut', 'copy'];
  function inField(e) {
    if (!inHost(e)) return false;
    var p = e.composedPath ? e.composedPath() : [];
    var t = p.length ? p[0] : e.target;
    if (!t || t.nodeType !== 1) return false;
    var n = t.localName || '';
    return n === 'textarea' || n === 'input' || t.isContentEditable === true;
  }
  function onFieldKey(e) {
    // `input` is stopped at window by the guard like every other key event, so a listener on the
    // textarea itself never hears it; this is the route a draft learns that the text changed.
    if (e.type === 'input') { if (cardInput) cardInput(); return; }
    if (e.type !== 'keydown') return;
    if (e.key === 'Escape') { closeCards(); e.preventDefault(); return; }
    if (cardKeys) cardKeys(e);
  }
  if (window.__psGuard) {
    window.__psGuard.onKey = onFieldKey;
  } else {
    // No guard: same job, one caveat — a page script that loaded before us and registered its own
    // capture listener on window would still get the keystroke first.
    FIELD_EVENTS.forEach(function (t) {
      window.addEventListener(t, function (e) {
        if (!inField(e)) return;
        e.stopImmediatePropagation();   // never preventDefault: the character must still be typed
        onFieldKey(e);
      }, true);
    });
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('scroll', function () { if (mode === 'inspect') clearHover(); layoutPins(); }, true);
  window.addEventListener('resize', function () {
    clearHover(); layoutPins();
    var b = root.querySelector('.ps-bar');
    if (b) placeBar(b);
  });

  /* Clicks that reach document: everything inside our own host, plus clicks on the prototype while
     comment mode is OFF. Comment mode's out-of-host clicks are handled in onClickCapture instead,
     because guard.js stops them at window before document ever sees them. */
  document.addEventListener('click', function (e) {
    if (!scopeOpen) return;
    var path = e.composedPath ? e.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var el = path[i];
      if (el && el.classList && (el.classList.contains('ps-menu') || el.classList.contains('ps-scope'))) return;
    }
    scopeOpen = false;
    render();
  }, true);

  document.addEventListener('keydown', function (e) {
    var t = (e.composedPath && e.composedPath()[0]) || e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === 'Escape') {
      if (scopeOpen) { scopeOpen = false; render(); e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (root.querySelector('.ps-card')) { closeCards(); e.preventDefault(); e.stopImmediatePropagation(); }
      else if (mode === 'inspect') { setMode('interact'); e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    if (typing) return;
    if (e.key === 'c' || e.key === 'C') {
      setMode(mode === 'inspect' ? 'interact' : 'inspect');
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // ---------------------------------------------------------------- pins
  function findEl(c) {
    var cached = elCache.get(c.id);
    if (cached) {
      if (cached.el && cached.el.isConnected) return cached.el;
      if (cached.el === null && cached.gen === missGen) return null; // known miss
    }
    var a = c.anchor || {};
    var el = null;
    if (a.id) { try { el = document.getElementById(a.id); } catch (e) { el = null; } }
    if (!el && a.path) { try { el = resolvePath(a.path); } catch (e) { el = null; } }
    if (!el && a.loc) {
      try { el = document.querySelector('[data-ps-loc="' + a.loc.line + ':' + a.loc.col + '"]'); } catch (e) { el = null; }
    }
    if (!el && a.text_snippet && a.tag) {
      try {
        var all = document.getElementsByTagName(a.tag);
        for (var i = 0; i < all.length; i++) {
          if (normText(all[i].textContent).slice(0, 120) === a.text_snippet) { el = all[i]; break; }
        }
      } catch (e) { el = null; }
    }
    elCache.set(c.id, { el: el || null, gen: missGen });
    return el;
  }

  function roots() {
    return comments.filter(function (c) { return !c.parent_id; });
  }
  function repliesOf(id) {
    return comments.filter(function (c) { return c.parent_id === id; });
  }
  function visibleRoots() {
    return roots().filter(function (c) { return filter === 'all' || (filter === 'open' ? !c.resolved : c.resolved); });
  }

  /* Where a comment's anchor is, right now. Two different absences get confused if this answers a
     bare yes/no. A prototype that swaps screens inside ONE file leaves the anchor in the document
     and merely hides it: that is 'away', and the pin comes off the canvas, because a pin hovering
     over a screen the comment was never made on is worse than no pin at all. 'lost' is the other
     case — the element is not in the document any more, usually because an edit removed it — and
     that one the reviewer does need told about, so it keeps the parked marker. */
  function placement(c) {
    var el = findEl(c);
    if (!el) return 'lost';
    return isVisible(el) ? 'here' : 'away';
  }
  function placements() {
    var out = Object.create(null);
    visibleRoots().forEach(function (c) { out[c.id] = placement(c); });
    return out;
  }

  /* The pin goes away with its screen; the panel row must not, or the comment reads as deleted. It
     stays listed, dimmed, and says which of the two absences it is. */
  var WHERE = { away: 'on another screen', lost: 'element no longer on the page' };
  function syncRows(state) {
    var items = root.querySelectorAll('.ps-item');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var w = state[it.getAttribute('data-id')] || 'here';
      it.classList.toggle('off', w !== 'here');
      var note = it.querySelector('.ps-where');
      if (note) note.textContent = w === 'here' ? '' : ' · ' + WHERE[w];
    }
  }

  function layoutPins() {
    var pins = root.querySelectorAll('.ps-pin');
    var taken = [];
    var lost = 0;
    var state = placements();
    for (var i = 0; i < pins.length; i++) {
      var pin = pins[i];
      var c = null;
      for (var k = 0; k < comments.length; k++) if (comments[k].id === pin.dataset.id) { c = comments[k]; break; }
      if (!c) { pin.style.display = 'none'; continue; }
      var where = state[c.id] || placement(c);
      if (where === 'away') {
        // Another screen of this same file. The panel still lists it; the canvas stays clean.
        pin.classList.remove('lost');
        pin.style.display = 'none';
        continue;
      }
      var el = findEl(c);
      if (where === 'lost' || !el) {
        pin.classList.add('lost');
        pin.style.display = 'flex';
        pin.style.left = '8px';
        pin.style.top = (56 + lost * 28) + 'px';
        pin.title = 'Anchor is gone from the page — comment ' + (c.number ? '#' + c.number : '');
        lost++;
        continue;
      }
      var r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
        pin.style.display = 'none'; // scrolled away; the list still shows it
        continue;
      }
      pin.classList.remove('lost');
      pin.style.display = 'flex';
      var x = Math.min(Math.max(2, r.left - 11), window.innerWidth - 30);
      var y = Math.min(Math.max(2, r.top - 11), window.innerHeight - 30);
      // Several comments on one element would otherwise stack invisibly.
      for (var t = 0; t < taken.length; t++) {
        if (Math.abs(taken[t][0] - x) < 8 && Math.abs(taken[t][1] - y) < 8) {
          x = Math.min(x + 15, window.innerWidth - 30);
          t = -1;
        }
      }
      taken.push([x, y]);
      pin.style.left = x + 'px';
      pin.style.top = y + 'px';
      pin.title = c.text.slice(0, 80);
    }
    syncRows(state);
  }

  // ---------------------------------------------------------------- cards
  /* A half-written comment survives a reload. An agent editing the file makes the page reload under
     you, and retyping what you had was the single most annoying part of working alongside one. The
     draft is kept per tab (sessionStorage), per keystroke, and goes the moment its card is closed
     any other way: saved, cancelled, or replaced by another card. */
  function keepDraft(d) { remember('draft', d); }
  function dropDraft() { remember('draft', null); }
  function rectOf(r) { return { left: r.left, top: r.top, bottom: r.bottom }; }

  function closeCards() {
    var cards = root.querySelectorAll('.ps-card');
    for (var i = 0; i < cards.length; i++) cards[i].remove();
    cardKeys = null;
    cardInput = null;
    dropDraft();
    activeId = null;
    renderPanel();
    renderPins();
  }
  function place(card, rect) {
    syncHome();
    raise();
    card.style.visibility = 'hidden';
    root.appendChild(card);
    var w = card.offsetWidth, ht = card.offsetHeight;
    var pad = 8;
    var left = Math.min(Math.max(pad, rect.left), window.innerWidth - w - pad - (panelOpen ? 336 : 0));
    var top = rect.bottom + pad;
    if (top + ht > window.innerHeight - pad) top = Math.max(pad, rect.top - ht - pad);
    if (top + ht > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - ht - pad);
    card.style.left = Math.max(pad, left) + 'px';
    card.style.top = top + 'px';
    card.style.visibility = 'visible';
  }

  function openCompose(anchor, rect, parentId, initial) {
    if (panelOpen && window.innerWidth < 720) { panelOpen = false; remember('panel', false); }
    closeCards();
    var shot = captureSoon(5000);
    var ta = h('textarea', { placeholder: parentId ? 'Write a reply…' : 'What should change here?' });
    if (initial) ta.value = initial;
    var btn = h('button', { class: 'ps-btn primary', text: parentId ? 'Reply' : 'Comment' });
    var card = h('div', { class: 'ps-card' }, [
      h('div', { class: 'ps-head' }, [
        anchorEl(anchor),
        h('div', { class: 'ps-icons' }, [h('button', { html: ICON.close, title: 'Cancel (Esc)', onclick: closeCards })])
      ]),
      ta,
      h('div', { class: 'ps-actions' }, [
        h('span', { class: 'ps-kbd', text: MOD + '\u21a9 to save' }),
        h('button', { class: 'ps-btn ghost', text: 'Cancel', onclick: closeCards }),
        btn
      ])
    ]);

    function submit() {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      shot.then(function (dataUrl) {
        return api('POST', '', {
          text: text, anchor: anchor, state: captureState(),
          screenshot: dataUrl || null, parent_id: parentId || null
        });
      }).then(function () {
        closeCards();
        return refresh();
      }).catch(function (err) {
        btn.disabled = false; btn.textContent = parentId ? 'Reply' : 'Comment';
        toast('Could not save comment: ' + err.message);
      });
    }
    btn.addEventListener('click', submit);
    function onKey(e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    }
    // Both: the guard route normally fires, the direct one is the fallback if it never runs.
    cardKeys = onKey;
    ta.addEventListener('keydown', onKey);
    var anchorRect = rectOf(rect);
    function remind() {
      if (!ta.value.trim()) return dropDraft();
      keepDraft({ file: FILE, kind: 'compose', parentId: parentId || null, anchor: anchor, rect: anchorRect, text: ta.value });
    }
    cardInput = remind;
    place(card, rect);
    ta.focus();
    if (initial) { ta.setSelectionRange(ta.value.length, ta.value.length); remind(); }
  }

  function openThread(id) {
    var c = comments.find(function (x) { return x.id === id; });
    if (!c) return;
    if (panelOpen && window.innerWidth < 720) { panelOpen = false; remember('panel', false); }
    closeCards();
    activeId = id;
    var el = findEl(c);
    var rect = el && isVisible(el) ? el.getBoundingClientRect() : { left: 20, top: 70, bottom: 70 };
    if (el && isVisible(el)) {
      var r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) {
        // Instant, not smooth: the card is positioned from the rect we read
        // straight afterwards, and a smooth scroll would make that stale.
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
        rect = el.getBoundingClientRect();
      }
    }

    var card = h('div', { class: 'ps-card' });
    card.appendChild(threadHead(c));
    card.appendChild(h('div', { class: 'ps-body', text: c.text }));
    card.appendChild(h('div', { class: 'ps-meta', text: ago(c.created_at) + (c.resolved ? ' · resolved' : '') }));
    if (c.screenshot) card.appendChild(h('div', { class: 'ps-shot', html: ICON.camera + '<span>screenshot captured</span>' }));
    repliesOf(id).forEach(function (r) {
      card.appendChild(h('div', { class: 'ps-reply' }, [
        h('div', { class: 'ps-body', text: r.text }),
        h('div', { class: 'ps-meta', text: ago(r.created_at) })
      ]));
    });
    card.appendChild(h('div', { class: 'ps-actions' }, [
      h('button', {
        class: 'ps-btn ghost', text: 'Reply',
        onclick: function () { openCompose(c.anchor, rect, c.id); }
      }),
      h('button', { class: 'ps-btn primary', text: c.resolved ? 'Reopen' : 'Resolve', onclick: function () { toggleResolve(c); } })
    ]));
    place(card, rect);
    renderPins();
    renderPanel();
  }

  function threadHead(c) {
    return h('div', { class: 'ps-head' }, [
      h('div', { class: 'ps-num' + (c.resolved ? ' resolved' : ''), text: String(c.number || '·') }),
      anchorEl(c.anchor),
      h('div', { class: 'ps-icons' }, [
        h('button', { class: 'done' + (c.resolved ? ' on' : ''), html: c.resolved ? ICON.undo : ICON.check, title: c.resolved ? 'Reopen' : 'Resolve', onclick: function () { toggleResolve(c); } }),
        h('button', { html: ICON.edit, title: 'Edit', onclick: function () { editComment(c); } }),
        h('button', { class: 'danger', html: ICON.trash, title: 'Delete', onclick: function () { deleteComment(c); } }),
        h('button', { html: ICON.close, title: 'Close (Esc)', onclick: closeCards })
      ])
    ]);
  }

  function editComment(c, initial) {
    var el = findEl(c);
    var rect = el && isVisible(el) ? el.getBoundingClientRect() : { left: 20, top: 70, bottom: 70 };
    closeCards();
    var ta = h('textarea');
    ta.value = initial != null ? initial : c.text;
    var btn = h('button', { class: 'ps-btn primary', text: 'Save' });
    var card = h('div', { class: 'ps-card' }, [
      h('div', { class: 'ps-head' }, [
        h('div', { class: 'ps-num', text: String(c.number || '·') }),
        anchorEl(c.anchor)
      ]),
      ta,
      h('div', { class: 'ps-actions' }, [
        h('button', { class: 'ps-btn ghost', text: 'Cancel', onclick: function () { openThread(c.id); } }),
        btn
      ])
    ]);
    function save() {
      var text = ta.value.trim();
      if (!text) return;
      btn.disabled = true;
      api('PATCH', '/' + c.id, { text: text })
        .then(refresh)
        .then(function () { closeCards(); })
        .catch(function (e) { btn.disabled = false; toast('Could not save: ' + e.message); });
    }
    btn.addEventListener('click', save);
    function onKey(e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    }
    cardKeys = onKey;
    ta.addEventListener('keydown', onKey);
    var editRect = rectOf(rect);
    function remind() {
      if (!ta.value.trim() || ta.value === c.text) return dropDraft();
      keepDraft({ file: FILE, kind: 'edit', id: c.id, rect: editRect, text: ta.value });
    }
    cardInput = remind;
    place(card, rect);
    ta.focus();
    if (initial != null) { ta.setSelectionRange(ta.value.length, ta.value.length); remind(); }
  }

  /* Put a draft back after a reload. Whatever it was attached to may have moved or gone, so the
     element is looked for again and the old position is only the fallback. */
  function restoreDraft(d) {
    if (!d || d.file !== FILE || !d.text || !String(d.text).trim()) return;
    var rect = d.rect || { left: 20, top: 70, bottom: 70 };
    if (d.kind === 'edit') {
      var c = comments.find(function (x) { return x.id === d.id; });
      if (c) editComment(c, d.text);
      return;
    }
    var probe = { id: '__draft__', anchor: d.anchor || {} };
    elCache.delete('__draft__');
    var el = findEl(probe);
    elCache.delete('__draft__');
    if (el && isVisible(el)) rect = el.getBoundingClientRect();
    var parent = d.parentId && comments.some(function (x) { return x.id === d.parentId; }) ? d.parentId : null;
    openCompose(d.anchor, rect, parent, d.text);
  }

  function toggleResolve(c) {
    var next = !c.resolved;
    api('PATCH', '/' + c.id, { resolved: next })
      .then(refresh)
      .then(function () {
        closeCards();
        toast(next ? 'Comment #' + c.number + ' resolved' : 'Comment #' + c.number + ' reopened', function () {
          api('PATCH', '/' + c.id, { resolved: !next }).then(refresh);
        });
      })
      .catch(function (e) { toast('Could not update: ' + e.message); });
  }

  function deleteComment(c) {
    api('DELETE', '/' + c.id)
      .then(function (res) {
        closeCards();
        return refresh().then(function () {
          toast('Comment #' + c.number + ' deleted', function () {
            api('POST', '/restore', { comments: res.removed }).then(refresh);
          });
        });
      })
      .catch(function (e) { toast('Could not delete: ' + e.message); });
  }

  function deleteResolved() {
    var done = roots().filter(function (c) { return c.resolved; });
    if (!done.length) return;
    var payload = [];
    comments.forEach(function (c) {
      if (c.resolved) payload.push(c);
    });
    Promise.all(done.map(function (c) { return api('DELETE', '/' + c.id); }))
      .then(refresh)
      .then(function () {
        toast(done.length + ' resolved comment' + (done.length > 1 ? 's' : '') + ' deleted', function () {
          api('POST', '/restore', { comments: payload }).then(refresh);
        });
      })
      .catch(function (e) { toast('Could not delete: ' + e.message); });
  }

  // ---------------------------------------------------------------- toast
  function toast(msg, undoFn) {
    clearTimeout(toastTimer);
    var old = root.querySelector('.ps-toast');
    if (old) old.remove();
    syncHome();
    raise();
    var t = h('div', { class: 'ps-toast' }, [h('span', { text: msg })]);
    if (undoFn) {
      t.appendChild(h('button', {
        text: 'Undo',
        onclick: function () { t.remove(); undoFn(); }
      }));
    }
    root.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, 8000);
  }

  // ---------------------------------------------------------------- render
  /* Where the toolbar sits is the reviewer's call: it lands on a prototype's own action buttons
     often enough that it has to be movable. The position is a preference, so it outlives the tab. */
  var storedBar = kept('bar', null);
  if (storedBar && typeof storedBar.x === 'number' && typeof storedBar.y === 'number') barPos = storedBar;

  function placeBar(bar) {
    if (!barPos) return;
    var x = Math.min(Math.max(4, barPos.x), Math.max(4, window.innerWidth - bar.offsetWidth - 4));
    var y = Math.min(Math.max(4, barPos.y), Math.max(4, window.innerHeight - bar.offsetHeight - 4));
    bar.style.left = x + 'px'; bar.style.top = y + 'px';
    bar.style.right = 'auto'; bar.style.bottom = 'auto';
  }
  function barGrip(bar) {
    var grip = h('div', {
      class: 'ps-grip', title: 'Drag to move \u00b7 double-click to reset',
      'aria-label': 'Move toolbar', html: ICON.grip
    });
    grip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var r = bar.getBoundingClientRect();
      var dx = e.clientX - r.left, dy = e.clientY - r.top;
      dragging = true;
      bar.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* the window still gets the moves */ }
      function move(ev) {
        barPos = { x: ev.clientX - dx, y: ev.clientY - dy };
        placeBar(bar);
      }
      function up() {
        dragging = false;
        bar.classList.remove('dragging');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
        if (barPos) {
          var b = bar.getBoundingClientRect();
          barPos = { x: Math.round(b.left), y: Math.round(b.top) };   // keep what is on screen, not the raw pointer
          keep('bar', barPos);
        }
      }
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', function () {
      barPos = null; keep('bar', null);
      bar.style.left = bar.style.top = bar.style.right = bar.style.bottom = '';
    });
    return grip;
  }

  function renderBar() {
    if (dragging) return;            // a re-render mid-drag would drop the pointer capture
    var old = root.querySelector('.ps-bar');
    if (old) old.remove();
    var open = roots().filter(function (c) { return !c.resolved; }).length;
    var total = roots().length;
    var bar = h('div', { class: 'ps-bar' }, [
      h('span', { class: 'ps-grip-slot' }),
      h('button', {
        class: mode === 'inspect' ? 'on' : '',
        title: 'Toggle comment mode (C)',
        html: ICON.cursor + '<span>' + (mode === 'inspect' ? 'Commenting' : 'Comment') + '</span>',
        onclick: function () { setMode(mode === 'inspect' ? 'interact' : 'inspect'); }
      }),
      h('button', {
        class: panelOpen ? 'on' : '',
        title: 'Toggle comment list',
        html: ICON.list + (total ? '<span class="ps-count">' + open + '</span>' : ''),
        onclick: function () {
          panelOpen = !panelOpen; remember('panel', panelOpen); render();
          if (panelOpen) { refreshScopes(); refresh(); }   // the scope gate above skips it while the panel is shut
        }
      })
    ]);
    bar.replaceChild(barGrip(bar), bar.firstChild);
    root.appendChild(bar);
    placeBar(bar);
  }

  /* Pins are PATCHED, not rebuilt. Recreating them on every render replayed the ps-pop entrance
     animation on every pin each time you touched a tab or a swatch, which read as the whole
     annotation layer flickering. A pin now animates once, when its comment first appears. */
  function renderPins() {
    var live = Object.create(null);
    visibleRoots().forEach(function (c) {
      live[c.id] = true;
      var pin = pinEls.get(c.id);
      if (!pin || !pin.isConnected) {
        var id = c.id;
        pin = h('button', { onclick: function (e) { e.stopPropagation(); openThread(id); } });
        pin.dataset.id = id;
        pinEls.set(id, pin);
        // before the panel, so a pin created while the panel is open cannot land on top of it
        root.insertBefore(pin, root.querySelector('.ps-panel'));
      }
      // .lost is owned by layoutPins, which runs immediately after and re-decides it
      pin.className = 'ps-pin' + (c.resolved ? ' resolved' : '') + (activeId === c.id ? ' active' : '');
      pin.textContent = String(c.number || '\u00b7');
      pin.title = c.text.slice(0, 80);
    });
    pinEls.forEach(function (pin, id) {
      if (!live[id]) { pin.remove(); pinEls.delete(id); }
    });
    layoutPins();
  }

  function renderPanel() {
    var panel = root.querySelector('.ps-panel');
    if (!panelOpen) { if (panel) panel.remove(); return; }
    var openCount = roots().filter(function (c) { return !c.resolved; }).length;
    var doneCount = roots().filter(function (c) { return c.resolved; }).length;

    var list = h('div', { class: 'ps-list' });
    var items = visibleRoots();
    if (!items.length) {
      list.appendChild(h('div', { class: 'ps-empty', text: filter === 'resolved' ? 'Nothing resolved yet.' : 'No comments yet. Press C, then click anything.' }));
    }
    items.forEach(function (c) {
      var replies = repliesOf(c.id).length;
      // Resolve and delete are reachable straight from the row, so working
      // through a list of feedback never needs a detour into each thread.
      var actions = h('div', { class: 'ps-row-actions' }, [
        h('button', {
          class: 'done' + (c.resolved ? ' on' : ''),
          html: c.resolved ? ICON.undo : ICON.check,
          title: c.resolved ? 'Reopen' : 'Resolve',
          onclick: function (e) { e.stopPropagation(); toggleResolve(c); }
        }),
        h('button', {
          class: 'danger', html: ICON.trash, title: 'Delete',
          onclick: function (e) { e.stopPropagation(); deleteComment(c); }
        })
      ]);
      list.appendChild(h('div', {
        class: 'ps-item' + (activeId === c.id ? ' active' : ''),
        'data-id': c.id,
        onclick: function () { openThread(c.id); }
      }, [
        h('div', { class: 'ps-num' + (c.resolved ? ' resolved' : ''), text: String(c.number || '·') }),
        h('div', {}, [
          h('div', { class: 'ps-body', text: c.text }),
          anchorEl(c.anchor),
          h('div', { class: 'ps-meta' }, [
            h('span', { text: ago(c.created_at) + (replies ? ' · ' + replies + ' repl' + (replies > 1 ? 'ies' : 'y') : '') + (c.sent_at && !c.resolved ? ' · sent' : '') }),
            /* filled in by syncRows when the anchor is not on the screen being looked at */
            h('span', { class: 'ps-where' })
          ])
        ]),
        actions
      ]));
    });

    /* The footer used to hold the file <select>; that moved up into the title, where the question
       "which prototype is this?" actually belongs. What sits here now is the pin colour, which is
       the one preference in this UI and reads better as a quiet row of swatches than as a menu. */
    var foot = h('div', { class: 'ps-panel-foot' });
    var unsent = unsentRoots().length;
    var send = openCount ? h('div', { class: 'ps-send' }, [
      h('button', {
        class: 'ps-btn primary', text: unsent ? 'Send ' + unsent + ' to Claude' : 'All sent',
        disabled: unsent ? null : 'true', onclick: sendToClaude
      }),
      h('span', {
        class: 'ps-listen' + (listening ? ' on' : ''),
        title: listening
          ? 'Claude is watching this file and will start on what you send.'
          : 'Nothing is watching yet. Ask Claude to run: protoserve watch ' + FILE + ' --sent',
        text: listening ? 'Claude is watching' : 'Not watching'
      })
    ]) : null;
    var swatches = h('div', { class: 'ps-swatches' });
    PIN_COLORS.forEach(function (c) {
      swatches.appendChild(h('button', {
        class: 'ps-swatch' + (c.hex === pinColor ? ' on' : ''),
        style: 'background:' + c.hex + ';color:' + c.hex,
        title: c.name + ' pins',
        'aria-label': c.name + ' pins',
        'aria-pressed': String(c.hex === pinColor),
        onclick: function (e) { e.stopPropagation(); setPin(c.hex); }
      }));
    });
    foot.appendChild(swatches);
    if (doneCount) {
      foot.appendChild(h('button', { class: 'ps-link', text: 'Delete ' + doneCount + ' resolved', onclick: deleteResolved }));
    }

    var multi = scopes.length > 1;
    var title = multi
      ? h('button', {
          class: 'ps-scope', title: FILE,
          'aria-haspopup': 'true', 'aria-expanded': String(scopeOpen),
          onclick: function (e) {
            e.stopPropagation(); scopeOpen = !scopeOpen; render();
            if (scopeOpen) refreshScopes();
          }
        }, [
          h('span', { class: 'ps-scope-name', text: FILE }),
          h('span', { class: 'ps-scope-n' + (openCount ? '' : ' none'), text: String(openCount) }),
          h('span', { class: 'ps-scope-chev', html: ICON.chev })
        ])
      : h('div', { class: 'ps-scope', title: FILE }, [
          h('span', { class: 'ps-scope-name', text: FILE }),
          h('span', { class: 'ps-scope-n' + (openCount ? '' : ' none'), text: String(openCount) })
        ]);

    var menu = null;
    if (multi && scopeOpen) {
      menu = h('div', { class: 'ps-menu' });
      scopes.forEach(function (f) {
        var here = f.name === FILE;
        menu.appendChild(h('button', {
          class: here ? 'on' : '', title: f.name,
          onclick: function (e) {
            e.stopPropagation();
            if (here) { scopeOpen = false; return render(); }
            location.href = '/' + f.name.split('/').map(encodeURIComponent).join('/');
          }
        }, [
          h('span', { class: 'ps-tick', html: here ? ICON.tick : '' }),
          h('span', { class: 'ps-mname', text: f.name }),
          /* the same badge as the header, deliberately — the count you rely on when you land on a
             prototype is the count you want when deciding whether to go there at all. Muted at
             zero rather than hidden, so the column stays scannable down the list. */
          h('span', {
            class: 'ps-scope-n' + (f.open ? '' : ' none'),
            text: String(f.open),
            title: f.open + ' open, ' + f.resolved + ' resolved'
          })
        ]));
      });
    }

    var kids = [
      menu,
      h('div', { class: 'ps-panel-head' }, [
        h('div', { class: 'ps-panel-title' }, [
          title,
          h('button', { class: 'ps-x', html: ICON.close, title: 'Close', onclick: function () { panelOpen = false; remember('panel', false); render(); } })
        ]),
        h('div', { class: 'ps-tabs' }, [
          h('button', { class: filter === 'open' ? 'on' : '', text: 'Open ' + openCount, onclick: function () { filter = 'open'; render(); } }),
          h('button', { class: filter === 'resolved' ? 'on' : '', text: 'Resolved ' + doneCount, onclick: function () { filter = 'resolved'; render(); } }),
          h('button', { class: filter === 'all' ? 'on' : '', text: 'All', onclick: function () { filter = 'all'; render(); } })
        ])
      ]),
      list,
      send,
      foot
    ].filter(Boolean);

    /* The panel ELEMENT survives a re-render; only its contents are swapped. Rebuilding the whole
       thing re-ran `animation: ps-in` every time, so switching a tab, opening the scope menu or
       picking a swatch made the panel visibly blink out and back — it looked like it had closed and
       reopened. Keeping the node means the entrance plays once, on open. The list's scroll position
       is carried over for the same reason: a re-render is not a reason to lose your place. */
    if (panel) {
      var prevList = panel.querySelector('.ps-list');
      var scrolled = prevList ? prevList.scrollTop : 0;
      // a menu that was already up must not re-animate underneath a click that did not close it
      if (menu && panel.querySelector('.ps-menu')) menu.classList.add('settled');
      while (panel.firstChild) panel.removeChild(panel.firstChild);
      kids.forEach(function (k) { panel.appendChild(k); });
      list.scrollTop = scrolled;
    } else {
      root.appendChild(h('div', { class: 'ps-panel' }, kids));
    }
    // rows are built fresh here, so the off-screen marking has to be re-applied to them
    syncRows(placements());
  }

  function render() {
    renderBar();
    renderPins();
    renderPanel();
  }

  function unsentRoots() {
    return roots().filter(function (c) { return !c.resolved && !c.sent_at; });
  }
  /* Nothing here is automatic. Comments sit until you press this; the press stamps them as sent,
     and a `protoserve watch --sent` running in the agent's session turns that into work. */
  function sendToClaude() {
    var ids = unsentRoots().map(function (c) { return c.id; });
    if (!ids.length) return;
    api('POST', '/send', { ids: ids })
      .then(function (res) { return refresh().then(function () { return res; }); })
      .then(function (res) {
        var n = (res.sent || []).length;
        toast(n + (n === 1 ? ' comment' : ' comments') + (listening ? ' sent to Claude' : ' sent. Nothing is watching yet'));
      })
      .catch(function (e) { toast('Could not send: ' + e.message); });
  }

  function refresh() {
    return api('GET', '').then(function (res) {
      comments = res.comments || [];
      listening = res.listening || 0;
      elCache.clear();
      render();
      return comments;
    }).catch(function () { return comments; });
  }

  // ---------------------------------------------------------------- live events
  function connect() {
    try {
      var es = new EventSource(BASE + '/events');
      es.addEventListener('reload', function () { location.reload(); });
      es.addEventListener('comments', function (ev) {
        try {
          var d = JSON.parse(ev.data || '{}');
          /* another file's comments changed: our own list is unaffected, but the scope menu's
             counts are not, so refresh those and stop there. */
          if (d.file && d.file !== FILE) { refreshScopes(); return; }
        } catch (e) { /* refresh anyway */ }
        refreshScopes();
        refresh();
      });
    } catch (e) { /* live updates unavailable */ }
  }

  /* A single-file prototype changes screens by flipping a class or a style, and nothing announces
     it. Without watching for that, a pin belonging to the screen you just left would hang around
     until the next half-second tick — which is exactly long enough to read as a bug. Attribute
     churn is cheap to re-lay-out; a childList change may have built the anchor we had given up on,
     so only that case retries missed anchors. */
  var domPending = false;
  function watchDom() {
    if (typeof MutationObserver !== 'function') return;
    var ob = new MutationObserver(function (records) {
      var touched = false, structural = false;
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        if (t === host || (host.contains && host.contains(t))) continue; // our own UI
        touched = true;
        if (records[i].type === 'childList') structural = true;
      }
      if (!touched || domPending) return;
      domPending = true;
      requestAnimationFrame(function () {
        domPending = false;
        if (structural) missGen++;
        layoutPins();
      });
    });
    try {
      ob.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open', 'data-active', 'data-screen', 'data-page']
      });
    } catch (e) { /* the tick still catches up within 500ms */ }
  }

  function boot() {
    var pendingDraft = recall('draft', null);   // before anything below can close a card and drop it
    mount();
    applyPin();
    panelOpen = recall('panel', false) === true;
    if (recall('mode', 'interact') === 'inspect') setMode('inspect');
    refresh().then(function () { restoreDraft(pendingDraft); });
    refreshScopes();
    connect();
    watchDom();
    var tick = 0;
    setInterval(function () {
      tick++;
      syncHome();                                          // a dialog that hides must not strand us in it
      if (tick % 4 === 0) applyTheme();                    // follow theme changes
      if (tick % 10 === 0) missGen++;                      // retry unresolved anchors
      layoutPins();
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__protoserve = {
    setMode: setMode, refresh: refresh, get comments() { return comments; },
    openThread: openThread, get mode() { return mode; },
    anchorFor: function (el) { return anchorFrom(el); }  // used by the resolver test matrix
  };
})();
