// Draws the toolbar icon with counters: coloured tiles with a number each on the dark plate of the logo.
// One lit counter fills the icon, two split it in halves, three or four take a quarter each in a fixed place
// (running top left, started top right, succeeded bottom left, failed bottom right). Works on any 2D context
// (OffscreenCanvas in the worker, a canvas in tests).

import { COLORS, countText } from './counters.js'

/** @typedef {import('./counters.js').Cell} Cell */

const QUADRANT = { running: [0, 0], started: [1, 0], succeeded: [0, 1], failed: [1, 1] }

/**
 * Tile boxes in a unit square for the lit cells.
 * @param {Cell[]} lit
 * @returns {{ cell: Cell, x: number, y: number, w: number, h: number }[]}
 */
export function layout(lit) {
  if (lit.length === 1) return [{ cell: /** @type {Cell} */ (lit[0]), x: 0, y: 0, w: 1, h: 1 }]
  if (lit.length === 2) return lit.map((cell, i) => ({ cell, x: i * 0.5, y: 0, w: 0.5, h: 1 }))
  return lit.map((cell) => {
    const [qx, qy] = QUADRANT[cell.key]
    return { cell, x: qx * 0.5, y: qy * 0.5, w: 0.5, h: 0.5 }
  })
}

/**
 * @param {OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D} ctx
 * @param {number} size pixel size of the square
 * @param {Cell[]} lit cells with a value above zero (one to four)
 */
export function drawCounters(ctx, size, lit) {
  ctx.clearRect(0, 0, size, size)
  const r = size * 0.19
  ctx.fillStyle = COLORS.plate
  roundRect(ctx, 0, 0, size, size, r)
  ctx.fill()
  const gap = Math.max(1, Math.round(size / 16))
  for (const box of layout(lit)) {
    const x = box.x * size + gap / 2
    const y = box.y * size + gap / 2
    const w = box.w * size - gap
    const h = box.h * size - gap
    ctx.fillStyle = COLORS[box.cell.key]
    roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.22)
    ctx.fill()
    const text = countText(box.cell.value, 2)
    let font = Math.floor(h * (box.h === 1 ? 0.62 : 0.86))
    ctx.font = `700 ${font}px sans-serif`
    while (font > 6 && ctx.measureText(text).width > w * 0.92) {
      font -= 1
      ctx.font = `700 ${font}px sans-serif`
    }
    ctx.fillStyle = COLORS.ink
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x + w / 2, y + h / 2 + font * 0.06)
  }
}

/**
 * @param {OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D} ctx
 * @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r
 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
