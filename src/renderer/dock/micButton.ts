/**
 * The strip's push-to-talk mic button — the add button's left-side mirror.
 * The Lore orb is its single mark: hold to record (coral, riding the live
 * input level), and between holds it carries the ambient loop's state —
 * hurried while transcribing or waiting on the agent, gold during the
 * background agent's model turn, ash when the microphone is denied.
 *
 * Only mounted when the host exposes `window.loreMic` (see preload/dock.ts);
 * the standalone dock has no audio loop and renders no mic button.
 */
import type { AmbientChip } from '../../shared/ambient'
import type { AudioLoopState, MicBridge } from '../../shared/audio'
import { initLoreOrb, type LoreOrbMode } from './loreOrb'

function titleFor(visual: string, shortcut: string | null): string {
  const toggle = shortcut ? ` — or press ${shortcut} to toggle` : ''
  switch (visual) {
    case 'recording':
      return `Recording — release${shortcut ? ` (or press ${shortcut})` : ''} to stop`
    case 'denied':
      return 'Microphone access denied — press to open System Settings'
    case 'not-determined':
      return `Hold to talk${toggle} — the first press asks for the microphone`
    default:
      return `Hold to talk${toggle}`
  }
}

// After transcription finishes there's a quiet stretch before the background
// agent's next tick picks the lines up (it polls every 10 s) — bridge it so
// the hurried orb eases straight into the gold one instead of dropping calm
// in between. Capped: if no gold ever comes, fall back to calm.
const BRIDGE_MS = 15_000

// When a run ends, the orb dissolves into specks — gold for a save, ink for
// "nothing to keep" (a dissipation, deliberately not a failure flash).
const BURST_MS = 900
const SPECK_COUNT = 10

/** Mount the mic button into `host` (before its first child). */
export function initMicButton(host: HTMLElement, bridge: MicBridge): void {
  const btn = document.createElement('button')
  btn.id = 'micBtn'
  btn.dataset.orb = 'idle'
  btn.setAttribute('aria-label', 'Hold to talk')

  const canvas = document.createElement('canvas')
  canvas.className = 'mic-orb'
  canvas.setAttribute('aria-hidden', 'true')
  btn.append(canvas)

  const burst = document.createElement('span')
  burst.className = 'mic-burst'
  burst.setAttribute('aria-hidden', 'true')
  burst.hidden = true
  btn.append(burst)

  host.insertBefore(btn, host.firstChild)

  const orb = initLoreOrb(canvas)

  let lastState: AudioLoopState | null = null
  let workingChip: AmbientChip | null = null
  let bridging = false
  let bridgeTimer: number | null = null
  let bursting = false
  let burstTimer: number | null = null

  function clearBurst(): void {
    bursting = false
    if (burstTimer !== null) {
      clearTimeout(burstTimer)
      burstTimer = null
    }
    burst.hidden = true
    burst.replaceChildren()
  }

  function burstSpecks(tone: 'gold' | 'ink'): void {
    clearBurst()
    bursting = true
    burst.classList.toggle('gold', tone === 'gold')
    for (let i = 0; i < SPECK_COUNT; i++) {
      const speck = document.createElement('span')
      speck.className = 'speck'
      // Evenly fanned with a little jitter; distances stay inside the button.
      const angle = (i / SPECK_COUNT) * 2 * Math.PI + Math.random() * 0.6
      const dist = 10 + Math.random() * 8
      speck.style.setProperty('--dx', `${Math.cos(angle) * dist}px`)
      speck.style.setProperty('--dy', `${Math.sin(angle) * dist}px`)
      speck.style.setProperty('--delay', `${Math.round(Math.random() * 120)}ms`)
      burst.append(speck)
    }
    burst.hidden = false
    burstTimer = window.setTimeout(() => {
      clearBurst()
      apply()
    }, BURST_MS)
  }

  function stopBridge(): void {
    bridging = false
    if (bridgeTimer !== null) {
      clearTimeout(bridgeTimer)
      bridgeTimer = null
    }
  }

  function startBridge(): void {
    stopBridge()
    bridging = true
    bridgeTimer = window.setTimeout(() => {
      bridging = false
      bridgeTimer = null
      apply()
    }, BRIDGE_MS)
  }

  function apply(): void {
    const s = lastState
    const visual = !s
      ? 'idle'
      : s.permission === 'granted'
        ? (s.capturing ? 'recording' : 'idle')
        : s.permission
    const working = workingChip !== null
    const processing = Boolean(s?.processing)
    const recording = visual === 'recording'
    const mode: LoreOrbMode = recording
      ? 'recording'
      : working
        ? 'working'
        : processing || bridging
          ? 'processing'
          : visual === 'denied'
            ? 'denied'
            : 'idle'
    orb.setMode(mode)
    btn.dataset.orb = mode
    canvas.hidden = bursting
    btn.title = working
      ? workingChip!.label
      : processing
        ? 'Transcribing…'
        : bridging
          ? 'Thinking…'
          : titleFor(visual, s?.shortcutLabel ?? null)
    if (recording && bursting) clearBurst()
    if (!recording) btn.style.setProperty('--level', '0')
  }

  function render(state: AudioLoopState): void {
    const wasProcessing = Boolean(lastState?.processing)
    lastState = state
    // Transcription just finished → hold the hurried orb until the agent's
    // gold takes over. A fresh utterance restarts the cycle.
    if (state.processing) stopBridge()
    else if (wasProcessing) startBridge()
    apply()
  }

  // Push-to-talk: pointer capture keeps the release delivered even when the
  // cursor drifts off the button mid-hold.
  btn.addEventListener('pointerdown', (e) => {
    btn.setPointerCapture(e.pointerId)
    void bridge.setPtt(true).then(render)
  })
  const release = (): void => {
    void bridge.setPtt(false).then(render)
  }
  btn.addEventListener('pointerup', release)
  btn.addEventListener('pointercancel', release)

  bridge.onState(render)

  // Raw RMS is tiny for speech (~0.02–0.2); boost into a 0..1 range. The
  // level drives both the orb's paint (light + drift) and a CSS scale pulse.
  bridge.onLevel((level) => {
    const boosted = Math.min(1, level * 7)
    btn.style.setProperty('--level', String(boosted))
    orb.setLevel(boosted)
  })

  bridge.onAgentChip((chip: AmbientChip | null) => {
    // Gold mood strictly while a model turn is in flight. Any chip ends the
    // bridge: `working` hands off to gold, and a terminal chip means the
    // agent already ran and finished.
    const wasWorking = workingChip !== null
    workingChip = chip?.state === 'working' ? chip : null
    if (chip) stopBridge()
    if (chip?.state === 'working') {
      clearBurst()
    } else if (chip && wasWorking) {
      // The run just ended: dissolve the orb into specks — gold if it saved
      // a capture, ink if it simply had nothing to keep.
      burstSpecks(chip.state === 'saved' ? 'gold' : 'ink')
    }
    apply()
  })

  void bridge.getState().then(render).catch(() => {})
}
