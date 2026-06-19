// The browser driver: self-contained JavaScript injected into a browser card's
// page to produce a BrowserSnapshot (read) and perform actions. It runs in the
// guest's own context — pure DOM, no app code — and returns JSON-cloneable
// values. Shared because BOTH transports use it: the renderer Tier-A path via
// `webview.executeJavaScript` (fallback), and main's Tier-B CDP path via
// `Runtime.evaluate` (primary). It lives in `shared` precisely so the one driver
// is the single source for both — the module itself has no DOM/Electron
// dependency (it is just strings + pure builders).
//
// `ref` is the set-of-marks index, stamped onto each interactive element as a
// `data-canvas-ref` attribute during read; actions resolve it back with a plain
// attribute selector. Refs are snapshot-scoped — a read clears prior refs first,
// so an action after a DOM mutation that dropped its element returns 'stale-ref'.
// See BROWSER_AGENCY_PLAN.md §2 for the contract these strings satisfy.
import type { BrowserAction } from './types'

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

/** The stale-ref failure message, shared verbatim by both tiers (the Tier-A
 *  action script below and browserController's Tier-B branches) so the re-read
 *  hint reads identically whichever path drove the action. */
export function staleRefMessage(ref: string): string {
  return `stale-ref: no element ${ref} on the page — read again first`
}

/** Tier-A action (renderer fallback): resolves the ref and performs the action
 *  entirely in-page via synthetic DOM events. The scroll/history/select branches
 *  below deliberately mirror the standalone Tier-B helpers (scrollScript /
 *  historyScript / selectScript) — same logic, but this tier is one self-contained
 *  IIFE returning `{ ok, message }` while Tier B returns bare values for CDP to
 *  interleave, so the duplication is owned, not extracted. Keep the two in sync. */
export function buildActionScript(action: BrowserAction): string {
  return `(function (action) {
  if (action.kind === 'scroll') {
    var dy = (window.innerHeight || 600) * 0.8 * (action.direction === 'up' ? -1 : 1)
    window.scrollBy({ top: dy })
    return { ok: true, message: 'scrolled ' + action.direction }
  }
  if (action.kind === 'history') {
    if (action.action === 'back') history.back()
    else if (action.action === 'forward') history.forward()
    else location.reload()
    return { ok: true, message: action.action }
  }
  var el = document.querySelector('[data-canvas-ref="' + action.ref + '"]')
  if (!el) return { ok: false, message: ${JSON.stringify(staleRefMessage('ref' in action ? action.ref : ''))} }
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' })
  if (action.kind === 'select') {
    el.value = action.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, message: 'selected ' + action.value + ' in ' + action.ref }
  }
  if (action.kind === 'click') {
    el.click()
    return { ok: true, message: 'clicked ' + action.ref }
  }
  if (action.kind === 'type') {
    if (el.click) el.click() // focus via a click first, like a real user
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

// ── Tier-B (CDP) helpers ─────────────────────────────────────────────────────
// Main resolves the ref to coordinates / focuses it in-page via Runtime.evaluate,
// then issues the actual click/keystroke as a real, trusted Input.* event over
// CDP — which (unlike sendInputEvent) works while the app is in the background.

/** Resolve a ref to its on-screen centre after scrolling it into view.
 *  Returns `{x, y}` (CSS px, viewport-relative) or `null` if the ref is stale. */
export function resolveRefScript(ref: string): string {
  const sel = JSON.stringify(`[data-canvas-ref="${ref}"]`)
  return `(function () {
  var el = document.querySelector(${sel})
  if (!el) return null
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' })
  var r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`
}

/** Select all text in a (just-clicked, focused) field so the next keystrokes
 *  replace it. Works for input/textarea (el.select) and contenteditable.
 *  Returns `false` if the ref is stale. */
export function selectAllScript(ref: string): string {
  const sel = JSON.stringify(`[data-canvas-ref="${ref}"]`)
  return `(function () {
  var el = document.querySelector(${sel})
  if (!el) return false
  if (typeof el.select === 'function') { el.select(); return true }
  if (el.isContentEditable) {
    var r = document.createRange(); r.selectNodeContents(el)
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
  }
  return true
})()`
}

/** Scroll the page ~one viewport in a direction. */
export function scrollScript(direction: 'up' | 'down'): string {
  return `(function () {
  var dy = (window.innerHeight || 600) * 0.8 * (${direction === 'up' ? -1 : 1})
  window.scrollBy({ top: dy })
  return true
})()`
}

/** Set a <select>/value-bearing control to `value`. Returns `false` if stale. */
export function selectScript(ref: string, value: string): string {
  const sel = JSON.stringify(`[data-canvas-ref="${ref}"]`)
  return `(function () {
  var el = document.querySelector(${sel})
  if (!el) return false
  el.value = ${JSON.stringify(value)}
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`
}

/** History navigation — back / forward / reload (no ref). */
export function historyScript(action: 'back' | 'forward' | 'reload'): string {
  const call = action === 'back' ? 'history.back()' : action === 'forward' ? 'history.forward()' : 'location.reload()'
  return `(function () { ${call}; return true })()`
}
