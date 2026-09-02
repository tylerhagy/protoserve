/* protoserve interaction guard.
   Loaded first, before any of the prototype's own scripts, so that in comment
   mode our capture-phase listeners run ahead of anything the page registers.
   It only ever acts while comment mode is on. */
(function () {
  'use strict';
  if (window.__psGuard) return;
  var g = window.__psGuard = { mode: 'interact', onClick: null, onKey: null };

  var FORM = /^(input|textarea|select|button|option|label|summary)$/;
  var TYPES = ['click', 'auxclick', 'dblclick', 'mousedown', 'mouseup',
    'pointerdown', 'pointerup', 'contextmenu', 'dragstart', 'submit'];

  function inHost(e) {
    var p = e.composedPath ? e.composedPath() : [];
    for (var i = 0; i < p.length; i++) {
      if (p[i] && p[i].id === '__protoserve_host') return true;
    }
    return false;
  }

  function block(e) {
    if (g.mode !== 'inspect' || inHost(e)) return;
    // Stop the prototype's own handlers from seeing the interaction.
    e.stopImmediatePropagation();

    var t = e.target;
    var formish = t && t.nodeType === 1 && FORM.test(t.localName || '');
    // Suppress default behaviour for anything that would activate, navigate or
    // steal focus. Plain mousedown on ordinary content is left alone so that
    // dragging to select text still works.
    if (e.type === 'click' || e.type === 'auxclick' || e.type === 'dblclick' ||
        e.type === 'submit' || e.type === 'dragstart' || formish) {
      e.preventDefault();
    }
    if (e.type === 'click' && typeof g.onClick === 'function') g.onClick(e);
  }

  for (var i = 0; i < TYPES.length; i++) {
    window.addEventListener(TYPES[i], block, true);
  }

  /* Typing a comment must not also drive the prototype. A prototype's own shortcuts are usually
     bound to document or window, and the comment box lives in a shadow root inside this page, so
     every keystroke bubbles straight out to them: writing "close the drawer" would open a drawer,
     jump a tab and delete a row on the way through.

     So while the focus is in one of our own text fields, key and clipboard events are stopped here,
     at window capture, before anything the page registered can see them. Propagation is all that
     stops — preventDefault is never called — so the character is still typed, paste still pastes,
     and the caret keys still move the caret; those are default actions, not listeners.

     Stopping at window also stops our OWN listeners further down the path, which is why the overlay
     hands its shortcuts (Escape to cancel, Cmd/Ctrl+Enter to save) to g.onKey instead of binding
     them to the textarea. Same arrangement as onClick above. */
  var KEYS = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input',
    'compositionstart', 'compositionupdate', 'compositionend',
    'paste', 'cut', 'copy'];

  function typing(e) {
    var p = e.composedPath ? e.composedPath() : [];
    var t = p.length ? p[0] : e.target;   // the real target inside our open shadow root
    if (!t || t.nodeType !== 1) return false;
    var name = t.localName || '';
    return name === 'textarea' || name === 'input' || t.isContentEditable === true;
  }

  function blockKey(e) {
    // Keys outside our UI belong to the prototype, in either mode.
    if (!inHost(e) || !typing(e)) return;
    e.stopImmediatePropagation();
    if (typeof g.onKey === 'function') g.onKey(e);
  }

  for (var j = 0; j < KEYS.length; j++) {
    window.addEventListener(KEYS[j], blockKey, true);
  }
})();
