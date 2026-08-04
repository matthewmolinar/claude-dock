/**
 * The Lore orb — the homepage's pixel aurora poured into a sphere (ported
 * from apps/web LoreOrb), now the mic pill's single mark. One orb, many
 * moods: instead of swapping glyphs the paint itself shifts between states,
 * easing from one to the next so the pill feels alive rather than switched.
 *
 *   idle       — calm night blues, slow shimmer, softly lit
 *   recording  — holding to talk: coral heat, and the voice level feeds the
 *                light and the drift (setLevel)
 *   processing — awake: brighter, quicker, the ribbons hurry
 *   working    — the background agent's turn: the aurora warms to gold
 *   denied     — ashen and still (no mic permission)
 *
 * Vanilla and dependency-free so it runs in the mic renderer as-is.
 */

const LEVELS = 8
const STEP = 255 / (LEVELS - 1)
const DITHER_STRENGTH = 0.7
/** Logical pixel grid — small, then scaled up with image-rendering: pixelated. */
const ORB_RES = 24

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

export type LoreOrbMode = 'idle' | 'recording' | 'processing' | 'working' | 'denied'

interface OrbParams {
  /** Time multiplier — how fast the aurora drifts. */
  speed: number
  /** Overall light multiplier. */
  energy: number
  /** 0..1 mix of the ribbons and glow toward the agent's gold. */
  gold: number
  /** 0..1 mix of the ribbons toward the accent coral (recording). */
  heat: number
  /** 0..1 desaturation toward ash (denied). */
  grey: number
}

const MODES: Record<LoreOrbMode, OrbParams> = {
  idle: { speed: 0.55, energy: 1.1, gold: 0, heat: 0, grey: 0 },
  // Recording has almost no autonomous drift: the mic level supplies the
  // motion instead, so silence settles rather than playing a generic loop.
  recording: { speed: 0.04, energy: 1.15, gold: 0, heat: 1, grey: 0 },
  processing: { speed: 1.7, energy: 1.25, gold: 0, heat: 0, grey: 0 },
  working: { speed: 1.1, energy: 1.2, gold: 1, heat: 0, grey: 0 },
  denied: { speed: 0, energy: 0.55, gold: 0, heat: 0, grey: 1 },
}

function starHash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return n - Math.floor(n)
}

function quantize(channel: number, dither: number): number {
  const stepped = Math.round((channel + dither) / STEP) * STEP
  return stepped < 0 ? 0 : stepped > 255 ? 255 : stepped
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export interface LoreOrbController {
  setMode(mode: LoreOrbMode): void
  /** Live input level (0..1) — feeds the light and the drift while recording. */
  setLevel(level: number): void
  stop(): void
}

/** Start painting the orb; returns a controller with setMode/stop. */
export function initLoreOrb(canvas: HTMLCanvasElement): LoreOrbController {
  const ctx = canvas.getContext('2d')
  if (!ctx) return { setMode: () => {}, setLevel: () => {}, stop: () => {} }

  const R = ORB_RES
  canvas.width = R
  canvas.height = R
  const image = ctx.createImageData(R, R)
  const data = image.data

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // Current params ease toward the active mode's targets each paint tick, so
  // a state change is a ~1s dissolve (gold blooms in, speed ramps) instead of
  // a hard swap.
  let mode: LoreOrbMode = 'idle'
  let target = MODES.idle
  const cur: OrbParams = { ...MODES.idle }
  /** Smoothed live input level; only recording feeds it. */
  let level = 0
  let levelTarget = 0
  // The aurora's own clock: advanced by `speed` so slow modes truly drift
  // slower rather than sampling the same absolute time.
  let clock = 2.5
  let lastNow = 0

  const paint = (): void => {
    let i = 0
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++, i += 4) {
        // Sphere coordinates: (-1..1) with z the outward normal.
        const u = ((x + 0.5) / R) * 2 - 1
        const v = ((y + 0.5) / R) * 2 - 1
        const d2 = u * u + v * v
        if (d2 > 1) {
          data[i + 3] = 0
          continue
        }
        const z = Math.sqrt(1 - d2)
        const t = clock

        // Project the aurora onto the sphere: coordinates bulge near the rim
        // (divide by z) so the ribbons wrap instead of lying flat.
        const su = (u / (z + 0.42)) * 0.36 + 0.5 + t * 0.045
        const sv = (v / (z + 0.42)) * 0.36 + 0.5

        const drift = Math.sin(su * 2.4 + t * 0.22) * 1.55
        const ribbon1 = Math.exp(
          -((sv - (0.4 + Math.sin(su * 5.8 + t * 0.35 + drift) * 0.1)) ** 2) * 46,
        )
        const ribbon2 = Math.exp(
          -((sv - (0.62 + Math.sin(su * 9.2 - t * 0.27 + 1.7) * 0.07)) ** 2) * 70,
        )
        // The gold underglow doubles while the agent works — the warmth
        // rises from the bottom of the sphere.
        const glow = Math.exp(-((1 - sv) ** 2) * 10) * (1 + cur.gold * 1.4)

        let r = 10 + 22 * sv
        let g = 12 + 26 * sv
        let b = 38 + 66 * sv

        // Ribbon tints ease from cobalt/teal toward the agent's gold, or
        // toward the accent coral while a recording is held.
        r += ribbon1 * lerp(lerp(58, 205, cur.gold), 217, cur.heat)
        g += ribbon1 * lerp(lerp(78, 148, cur.gold), 119, cur.heat)
        b += ribbon1 * lerp(lerp(196, 62, cur.gold), 87, cur.heat)

        r += ribbon2 * lerp(lerp(18, 150, cur.gold), 190, cur.heat)
        g += ribbon2 * lerp(lerp(92, 108, cur.gold), 96, cur.heat)
        b += ribbon2 * lerp(lerp(88, 40, cur.gold), 70, cur.heat)

        r += glow * 96
        g += glow * 60
        b += glow * 16

        const s = starHash(x, y)
        if (s > 0.99) {
          const twinkle = 0.55 + 0.45 * Math.sin(t * 2.1 + s * 60)
          r += 150 * twinkle
          g += 148 * twinkle
          b += 142 * twinkle
        }

        // Glassy-orb lighting: a soft key light from the upper left, limb
        // darkening at the rim, and a small specular catch.
        // The held voice brightens the whole sphere. The ambient floor sits
        // higher than the homepage orb's — this sphere lives on a dark pill.
        const energy = cur.energy * (1 + level * 0.7)
        const light = (0.55 + 0.62 * Math.max(0, -u * 0.35 - v * 0.5 + z * 0.75)) * energy
        const spec = Math.max(0, -u * 0.42 - v * 0.52 + z * 0.74) ** 16 * 90 * energy
        r = r * light + spec
        g = g * light + spec
        b = b * light + spec

        // Denied: collapse toward luma — the orb turns to ash but keeps its form.
        if (cur.grey > 0.01) {
          const luma = r * 0.3 + g * 0.5 + b * 0.2
          r = lerp(r, luma, cur.grey)
          g = lerp(g, luma, cur.grey)
          b = lerp(b, luma, cur.grey)
        }

        const dither = (BAYER[y & 3][x & 3] / 16 - 0.5) * STEP * DITHER_STRENGTH
        data[i] = quantize(r, dither)
        data[i + 1] = quantize(g, dither)
        data[i + 2] = quantize(b, dither)
        data[i + 3] = 255
      }
    }
    ctx.putImageData(image, 0, 0)
  }

  const tick = (): void => {
    cur.speed = lerp(cur.speed, target.speed, 0.14)
    cur.energy = lerp(cur.energy, target.energy, 0.14)
    cur.gold = lerp(cur.gold, target.gold, 0.14)
    cur.heat = lerp(cur.heat, target.heat, 0.14)
    cur.grey = lerp(cur.grey, target.grey, 0.14)
    // The level reacts faster than the mood — it's tracking a voice.
    level = lerp(level, levelTarget, 0.45)
    paint()
  }

  if (reduceMotion) {
    // One static frame per mode — no shimmer, but the mood still reads.
    paint()
    return {
      setMode(nextMode) {
        mode = nextMode
        target = MODES[nextMode]
        Object.assign(cur, MODES[nextMode])
        paint()
      },
      setLevel: () => {},
      stop: () => {},
    }
  }

  let frame = 0
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop)
    if (lastNow === 0) lastNow = now
    // Same chunky ~9fps shimmer as the landing wallpaper.
    if (now - lastNow < 110) return
    // While recording, the voice envelope is the shimmer's clock: quiet
    // input nearly stops it and louder speech moves the ribbons farther.
    // Other moods retain their own ambient time-based drift.
    const shimmerSpeed = mode === 'recording' ? target.speed + level * 4 : cur.speed
    clock += ((now - lastNow) / 1000) * shimmerSpeed
    lastNow = now
    tick()
  }
  frame = requestAnimationFrame(loop)

  return {
    setMode(nextMode) {
      mode = nextMode
      target = MODES[nextMode]
      if (target.heat === 0) levelTarget = 0
    },
    setLevel(next) {
      // A trailing VAD frame can arrive just after push-to-talk is released;
      // never let that stale level animate an idle/processing orb.
      levelTarget = mode === 'recording' ? Math.min(1, Math.max(0, next)) : 0
    },
    stop: () => cancelAnimationFrame(frame),
  }
}
