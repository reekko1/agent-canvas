// The Tier-A browser driver: self-contained JavaScript injected into a browser
// card's <webview> guest via `webview.executeJavaScript(...)` to produce a
// BrowserSnapshot (read) and perform actions (click/type/scroll). It runs in the
// guest page's own context — pure DOM, no access to app code — and returns
// JSON-cloneable values across the process boundary.
//
// `ref` is the set-of-marks index, stamped onto each interactive element as a
// `data-canvas-ref` attribute during read; actions resolve it back with a plain
// attribute selector. Refs are snapshot-scoped — a read clears prior refs first,
// so an action after a DOM mutation that dropped its element returns 'stale-ref'.
// See BROWSER_AGENCY_PLAN.md §2 for the contract these strings must satisfy.
import type { BrowserAction } from '@shared/types'

/** Injected read: returns a BrowserSnapshot for the guest's current page. */
export const READ_SCRIPT = `(function () {
  var MAX_ELEMENTS = 150
  var MAX_TEXT = 8000
  var norm = function (s) { return (s || '').replace(/\\s+/g, ' ').trim().slice(0, 200) }

  function roleOf(el) {
    var explicit = el.getAttribute('role')
    if (explicit) return explicit
    var tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return 'generic'
  }

  function nameOf(el) {
    var aria = el.getAttribute('aria-label')
    if (aria) return norm(aria)
    var labelledby = el.getAttribute('aria-labelledby')
    if (labelledby) { var r = document.getElementById(labelledby); if (r) return norm(r.textContent) }
    if (el.id) { var lf = document.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]'); if (lf) return norm(lf.textContent) }
    var cl = el.closest && el.closest('label'); if (cl) return norm(cl.textContent)
    var txt = norm(el.textContent); if (txt) return txt
    return norm(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.value || '')
  }

  function stateOf(el) {
    var s = {}
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.disabled = true
    if (typeof el.checked === 'boolean' && (el.type === 'checkbox' || el.type === 'radio')) s.checked = el.checked
    var exp = el.getAttribute('aria-expanded'); if (exp != null) s.expanded = exp === 'true'
    if (el.getAttribute('aria-selected') === 'true') s.selected = true
    if (document.activeElement === el) s.focused = true
    if (el.required || el.getAttribute('aria-required') === 'true') s.required = true
    return Object.keys(s).length ? s : undefined
  }

  var SELECTOR = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=combobox], [role=menuitem], [role=tab], [role=switch], [role=option], [contenteditable=""], [contenteditable=true], [tabindex]:not([tabindex="-1"])'

  var prior = document.querySelectorAll('[data-canvas-ref]')
  for (var p = 0; p < prior.length; p++) prior[p].removeAttribute('data-canvas-ref')

  var vh = window.innerHeight || document.documentElement.clientHeight
  var vw = window.innerWidth || document.documentElement.clientWidth
  var raw = Array.prototype.slice.call(document.querySelectorAll(SELECTOR))
  var visible = []
  for (var i = 0; i < raw.length; i++) {
    var el = raw[i]
    var rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    var st = window.getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none') continue
    var inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw
    visible.push({ el: el, inViewport: inViewport })
  }
  visible.sort(function (a, b) { return a.inViewport === b.inViewport ? 0 : a.inViewport ? -1 : 1 })
  var capped = visible.slice(0, MAX_ELEMENTS)
  var elements = capped.map(function (v, idx) {
    var ref = String(idx)
    v.el.setAttribute('data-canvas-ref', ref)
    var value = (v.el.value != null ? String(v.el.value) : '').slice(0, 200)
    return { ref: ref, role: roleOf(v.el), name: nameOf(v.el), value: value || undefined, state: stateOf(v.el), inViewport: v.inViewport }
  })

  var bodyText = (document.body ? document.body.innerText : '') || ''
  var text = bodyText.replace(/\\n{3,}/g, '\\n\\n').trim()
  var truncated = visible.length > MAX_ELEMENTS || text.length > MAX_TEXT
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT)

  return {
    url: location.href,
    title: document.title,
    scroll: { x: window.scrollX, y: window.scrollY, maxY: Math.max(0, document.documentElement.scrollHeight - vh), viewportH: vh },
    elements: elements,
    text: text,
    truncated: truncated,
  }
})()`

/** Injected action: resolves the ref and performs the click/type/scroll. */
export function buildActionScript(action: BrowserAction): string {
  return `(function (action) {
  if (action.kind === 'scroll') {
    var dy = (window.innerHeight || 600) * 0.8 * (action.direction === 'up' ? -1 : 1)
    window.scrollBy({ top: dy })
    return { ok: true, message: 'scrolled ' + action.direction }
  }
  var el = document.querySelector('[data-canvas-ref="' + action.ref + '"]')
  if (!el) return { ok: false, message: 'stale-ref: no element ' + action.ref + ' on the page — read again first' }
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' })
  if (action.kind === 'click') {
    el.click()
    return { ok: true, message: 'clicked ' + action.ref }
  }
  if (action.kind === 'type') {
    if (el.focus) el.focus()
    if (el.isContentEditable) {
      if (action.clear) el.textContent = ''
      document.execCommand('insertText', false, action.text)
    } else {
      if (action.clear) el.value = ''
      el.value = (el.value || '') + action.text
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    if (action.submit) {
      var down = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
      el.dispatchEvent(down)
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
      if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit()
    }
    return { ok: true, message: 'typed into ' + action.ref }
  }
  return { ok: false, message: 'unknown action' }
})(${JSON.stringify(action)})`
}
