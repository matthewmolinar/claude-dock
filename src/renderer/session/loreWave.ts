/**
 * The Lore wave — the empty session window's mark, ported from the
 * homepage demo (apps/web LoreWave). A free-floating ribbon of the
 * landing wallpaper's aurora: posterized brand palette, Bayer dither,
 * deliberately chunky ~9fps shimmer, edges dissolving through the same
 * dither. Vanilla and dependency-free so it runs in the session
 * renderer as-is.
 */

const LEVELS = 8
const STEP = 255 / (LEVELS - 1)
const DITHER_STRENGTH = 0.7
/** Logical pixel grid — small, then scaled up with image-rendering: pixelated. */
const WAVE_W = 128
const WAVE_H = 48

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

function starHash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return n - Math.floor(n)
}

function quantize(channel: number, dither: number): number {
  const stepped = Math.round((channel + dither) / STEP) * STEP
  return stepped < 0 ? 0 : stepped > 255 ? 255 : stepped
}

/** Start painting the wave; returns a stop function. */
export function initLoreWave(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}

  const W = WAVE_W
  const H = WAVE_H
  canvas.width = W
  canvas.height = H
  const image = ctx.createImageData(W, H)
  const data = image.data

  const paint = (t: number): void => {
    let i = 0
    for (let y = 0; y < H; y++) {
      const v = y / H
      for (let x = 0; x < W; x++, i += 4) {
        const u = x / W

        // The ribbon dissolves before it reaches the canvas edges.
        const fade =
          Math.min(1, Math.min(u, 1 - u) * 6.5) * Math.min(1, Math.min(v, 1 - v) * 5)

        // Two aurora ribbons braided around a common drift.
        const drift = Math.sin(u * 2.4 + t * 0.22) * 1.55
        const c1 = 0.42 + Math.sin(u * 4.6 + t * 0.5 + drift) * 0.17
        const c2 = 0.6 + Math.sin(u * 7.4 - t * 0.38 + 1.7) * 0.12
        const i1 = Math.exp(-((v - c1) ** 2) * 34)
        const i2 = Math.exp(-((v - c2) ** 2) * 55)
        // A faint gold underglow trailing the lower ribbon.
        const gold = Math.exp(-((v - c2 - 0.14) ** 2) * 70) * 0.8

        const body = i1 * 1.1 + i2 * 0.95 + gold * 0.5
        const alpha = Math.min(1, body) * fade
        if (alpha < 0.04) {
          data[i + 3] = 0
          continue
        }

        let r = 6 + i1 * 62 + i2 * 20 + gold * 176
        let g = 8 + i1 * 84 + i2 * 96 + gold * 112
        let b = 24 + i1 * 202 + i2 * 92 + gold * 30

        const s = starHash(x, y)
        if (s > 0.995 && body > 0.35) {
          const twinkle = 0.55 + 0.45 * Math.sin(t * 2.1 + s * 60)
          r += 150 * twinkle
          g += 148 * twinkle
          b += 142 * twinkle
        }

        const dither = (BAYER[y & 3][x & 3] / 16 - 0.5) * STEP * DITHER_STRENGTH
        data[i] = quantize(r, dither)
        data[i + 1] = quantize(g, dither)
        data[i + 2] = quantize(b, dither)
        // Posterized alpha so the edges dither instead of feathering.
        data[i + 3] = quantize(alpha * 255, dither * 2)
      }
    }
    ctx.putImageData(image, 0, 0)
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    paint(2.5)
    return () => {}
  }

  let frame = 0
  let last = 0
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop)
    // ~9fps on purpose — the shimmer should feel chunky, not smooth.
    if (now - last < 110) return
    last = now
    paint(now / 1000)
  }
  frame = requestAnimationFrame(loop)
  return () => cancelAnimationFrame(frame)
}
