// Small text helpers shared by the popup, the alerts and the worker. Pure.

/**
 * `45s`, `3m 12s`, `1h 05m`.
 * @param {number} ms
 */
export function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

/**
 * `just now`, `5 min ago`, `3 h ago`, `2 d ago`.
 * @param {string | null | undefined} iso
 * @param {number} now epoch ms
 */
export function agoText(iso, now) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}
