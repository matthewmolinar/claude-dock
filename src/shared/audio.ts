/**
 * Shared contract for the ambient audio loop: IPC channels, bridge types, and
 * the handful of constants the capture renderer and main process must agree
 * on. Design doc: docs/plans/2026-07-14-dock-audio-loop-prd.md
 */
import type { AmbientChip } from './ambient'

/** All audio PCM is 16 kHz mono Int16 — the shape whisper.cpp expects. */
export const AUDIO_SAMPLE_RATE = 16000

/** Rolling-window segments: one WAV per minute, keep the newest two. */
export const AUDIO_SEGMENT_SECONDS = 60
export const AUDIO_RETAIN_SEGMENTS = 2

/**
 * Whisper transcribes in a 30 s sliding window; utterances longer than this
 * are split so no tail is silently dropped inside one inference call.
 */
export const UTTERANCE_MAX_SECONDS = 28

/** Utterances shorter than this are clicks/breaths — never transcribed. */
export const UTTERANCE_MIN_MS = 300

/**
 * VAD/ONNX assets are served locally by the main process at this fake host
 * (https interception on the capture session — see main/audio/assetProtocol).
 */
export const AUDIO_ASSET_HOST = 'vad-assets.lore.internal'
export const AUDIO_ASSET_BASE = `https://${AUDIO_ASSET_HOST}/`

export enum AudioIpcChannel {
  /** Capture renderer → main: am I allowed to start? */
  CaptureInit = 'audio:capture-init',
  /** Capture renderer → main: a batch of raw PCM for the rolling window. */
  Pcm = 'audio:pcm',
  /** Capture renderer → main: a VAD-complete utterance for transcription. */
  Utterance = 'audio:utterance',
  /** Main → capture renderer: pause/resume push. */
  CaptureState = 'audio:capture-state',
  /**
   * Capture renderer → main → dock strip: per-frame input level (RMS 0..1)
   * while recording — feeds the mic button's orb.
   */
  Level = 'audio:level',
  /** Mic button (dock strip) → main: state snapshot. */
  GetState = 'audio:get-state',
  /** Mic button → main (invoke): push-to-talk held/released (or request permission / open settings). */
  SetPtt = 'audio:set-ptt',
  /** Main → all windows: state push (only the mic button listens). */
  StateChanged = 'audio:state-changed',
}

export type AudioPermissionState = 'granted' | 'denied' | 'not-determined'

/** State the dock strip's mic button renders. */
export interface AudioLoopState {
  permission: AudioPermissionState
  /** True while push-to-talk is held and the mic is actually recording. */
  capturing: boolean
  /** True while captured utterances are still transcribing (post-release). */
  processing: boolean
  /** The toggle shortcut's display label (e.g. `⌥Space`), null when off. */
  shortcutLabel: string | null
}

/** Exposed as `window.loreAudioCapture` in the hidden capture renderer. */
export interface AudioCaptureBridge {
  init: () => Promise<{ shouldCapture: boolean }>
  sendPcm: (pcm: ArrayBuffer) => void
  sendUtterance: (pcm: ArrayBuffer, startedAt: number) => void
  sendLevel: (level: number) => void
  onCaptureState: (cb: (state: { shouldCapture: boolean }) => void) => void
}

/**
 * Exposed as `window.loreMic` by the dock preload for the strip's mic button.
 * Hosts without an audio loop simply don't expose it; the dock renderer
 * feature-detects and renders no mic button.
 */
export interface MicBridge {
  getState: () => Promise<AudioLoopState>
  /** Push-to-talk: true on press, false on release. */
  setPtt: (active: boolean) => Promise<AudioLoopState>
  onState: (cb: (state: AudioLoopState) => void) => void
  /** Input level (RMS 0..1) per VAD frame while recording. */
  onLevel: (cb: (level: number) => void) => void
  /**
   * Background-agent activity (the `AmbientIpcChannel.Chip` push) — drives
   * the mic orb's gold mood while the agent works.
   */
  onAgentChip: (cb: (chip: AmbientChip | null) => void) => void
}
