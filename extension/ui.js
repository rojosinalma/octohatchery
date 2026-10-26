// Shared helpers for the popup and the options page.

import { getJson } from './lib/api.js'

/** @param {unknown} s */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** An icon from the vendored tailor sprite. @param {string} id */
export const icon = (id) => `<svg class="t-icon" aria-hidden="true"><use href="tailor/icons.svg#${id}"/></svg>`

/** @param {string} sel @param {ParentNode} [root] */
export const $ = (sel, root = document) => /** @type {HTMLElement} */ (root.querySelector(sel))

/** Waits for tailor.js (loaded with `defer`). */
export function tailorReady() {
  return new Promise((resolve) => {
    if (/** @type {any} */ (window).Tailor) resolve(/** @type {any} */ (window).Tailor)
    else document.addEventListener('DOMContentLoaded', () => resolve(/** @type {any} */ (window).Tailor))
  })
}

/**
 * With `themeFromHatchery` on, the extension pages use the look the hatchery is set to (its skin, palette and
 * mode settings); off, the pickers on the options page decide. Either way the choice is kept in localStorage,
 * so the next page paints with it at once.
 * @param {string} base
 * @param {{ themeFromHatchery: boolean }} settings
 */
export async function followTheme(base, settings) {
  if (!settings.themeFromHatchery) return
  const r = await getJson(base, '/api/settings')
  if (r.kind !== 'ok') return
  const s = r.data.settings ?? {}
  const T = /** @type {any} */ (await tailorReady())
  const next = { skin: s.ui_skin || undefined, palette: s.ui_palette || undefined, mode: s.ui_mode || undefined }
  T?.theme?.set(next)
}

/**
 * @param {'success' | 'warning' | 'danger' | 'info'} tone
 * @param {string} message
 */
export async function toast(tone, message) {
  const T = /** @type {any} */ (await tailorReady())
  T?.toast(tone, message)
}
