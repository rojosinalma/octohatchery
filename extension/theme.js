// Pre-paint theme switch for the extension pages (the inline snippet tailor ships is not allowed by the
// extension's content security policy). Reads the choice from localStorage and writes the skin and palette
// links before the body paints, like tailor-head.html does. `tailor/config.js` (generated at build time
// from the vendored tailor-head.html) defines window.TAILOR_CONFIG.
;(function () {
  var C = window.TAILOR_CONFIG
  if (!C) return
  var P = C.project
  function pick(k) {
    try {
      return localStorage.getItem(P + '.' + k) || C.defaults[k]
    } catch (e) {
      return C.defaults[k]
    }
  }
  var h = document.documentElement
  var s = pick('skin')
  var p = pick('palette')
  var m = pick('mode')
  if (C.skins.indexOf(s) < 0) s = C.defaults.skin
  if (C.palettes.indexOf(p) < 0) p = C.defaults.palette
  if (m === 'auto') m = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  var modes = C.modes[p] || ['dark']
  if (modes.indexOf(m) < 0) m = modes[0]
  h.dataset.skin = s
  h.dataset.palette = p
  h.dataset.mode = m
  function link(id, base, href, off) {
    var l = document.createElement('link')
    l.id = id
    l.rel = 'stylesheet'
    l.dataset.base = base
    if (href) l.href = href
    if (off) l.disabled = true
    document.head.appendChild(l)
  }
  link('t-skin', C.base + 'skins/', s === 'none' ? '' : C.base + 'skins/' + s + '/skin.css', s === 'none')
  link('t-palette', C.base + 'palettes/', C.base + 'palettes/' + p + '.css', false)
  document.addEventListener('DOMContentLoaded', function () {
    if (window.Tailor) window.Tailor.theme.init(C)
  })
})()
