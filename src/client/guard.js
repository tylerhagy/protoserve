/* protoserve interaction guard.
   Loaded first, before any of the prototype's own scripts, so that in comment
   mode our capture-phase listeners run ahead of anything the page registers.
   It only ever acts while comment mode is on. */
(function () {
  'use strict';
  if (window.__psGuard) return;
  var g = window.__psGuard = { mode: 'interact', onClick: null };

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
})();
