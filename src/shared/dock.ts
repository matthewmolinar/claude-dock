/**
 * Pure dock-widget domain logic and DTO types shared by the main process,
 * the dock/session/settings preloads, and their renderers.
 *
 * Ported from claude-dock `src/shared/{layout,title}.js`. Must stay free of
 * Node imports: `tsconfig.web.json` compiles this file for the renderer.
 */

/**
 * Layout constants shared by the main process (window sizing) and the dock
 * renderer (CSS custom properties). Kept in sync via the `Init` IPC payload
 * rather than duplicated literals.
 */
export const LAYOUT = {
  slotWidth: 150,
  slotHeight: 62,
  gap: 8,
  margin: 12,
  bottomOffset: 8,
  addButtonWidth: 44,
  headerHeight: 26,
  initialSlots: 3,
} as const

export type DockLayout = typeof LAYOUT

export interface DockFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

export function getDockWidth(slotCount: number, layout: DockLayout = LAYOUT): number {
  const { slotWidth, gap, addButtonWidth, margin } = layout
  return slotWidth * slotCount + gap * (slotCount - 1) + gap + addButtonWidth + margin * 2
}

export function getDockHeight(layout: DockLayout = LAYOUT): number {
  return layout.headerHeight + layout.slotHeight + layout.margin * 2
}

/**
 * Compute the dock's on-screen frame.
 *
 * `workArea` already excludes the macOS menu bar and the system Dock, whichever
 * edge it lives on. That is why the widget needs no Accessibility permission and
 * no `defaults write com.apple.dock orientation` workaround.
 */
export function computeDockFrame(
  workArea: WorkArea,
  slotCount: number,
  layout: DockLayout = LAYOUT,
): DockFrame {
  const width = getDockWidth(slotCount, layout)
  const height = getDockHeight(layout)
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - layout.bottomOffset),
    width,
    height,
  }
}

// The artifact pane adds a fixed panel beside the chat column; never grow past
// the display's work area (with a small margin so the window stays grabbable).
export const ARTIFACT_PANE_WIDTH = 480

export function expandedSessionWidth(chatWidth: number, workAreaWidth: number): number {
  return Math.min(chatWidth + ARTIFACT_PANE_WIDTH, workAreaWidth - 40)
}

export const MAX_LABEL = 22

/** Truncate to `max` chars total, with an ellipsis occupying the last character. */
export function truncate(text: string, max: number = MAX_LABEL): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1).trimEnd()}…`
}

/** Last path segment without importing node:path (renderer-safe). */
function basename(folder: string): string {
  const trimmed = folder.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

export interface SlotLabelInput {
  customName?: string | null
  firstPrompt?: string | null
  folder?: string | null
  index: number
}

/**
 * Resolve the label shown on a dock slot.
 *
 * Priority: user rename > what they first asked for > folder name > "Session 2".
 */
export function slotLabel({ customName, firstPrompt, folder, index }: SlotLabelInput): string {
  if (customName) return truncate(customName)
  if (firstPrompt) return truncate(firstPrompt)
  if (folder) {
    const base = basename(folder)
    if (base) return truncate(base)
  }
  return `Session ${index}`
}

/** "/Users/molinar/lore" -> "~/lore" */
export function prettyFolder(folder: string | null | undefined, home = ''): string {
  if (!folder) return ''
  if (home && folder.startsWith(home)) return `~${folder.slice(home.length)}`
  return folder
}

export type SlotStatus = 'empty' | 'idle' | 'working' | 'minimized' | 'active'

/** What the dock renderer needs to draw one slot. */
export interface SlotSnapshot {
  index: number
  label: string
  status: SlotStatus
  hasWindow: boolean
  hasNotification: boolean
  folder: string | null
}

export interface DockSnapshot {
  slots: SlotSnapshot[]
}

export interface DockInitPayload {
  layout: DockLayout
  state: DockSnapshot
}

/** One tool call rendered as an activity chip inside an assistant bubble. */
export interface TranscriptTool {
  id: string
  label: string
  input?: unknown
  output: string | null
  ok?: boolean
}

/** One replayable transcript entry, mirrored to session windows on (re)open. */
export type SessionEntry =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; tools: TranscriptTool[] }
  | { role: 'error'; text: string }

/** What the session renderer needs to show the artifact pane. */
export interface ArtifactPayload {
  url: string
  title: string
  /** Bumped when the agent edits the shown file, forcing an iframe reload. */
  version: number
}

export interface SessionInitPayload {
  index: number
  folder: string | null
  busy: boolean
  transcript: SessionEntry[]
  artifact: ArtifactPayload | null
  hasKey: boolean
}

export interface ToolStartPayload {
  id: string
  label: string
}

export interface ToolResultPayload {
  id: string
  ok: boolean
  output: string
}

export interface KeyStatePayload {
  hasKey: boolean
}

export interface SettingsInitPayload {
  hasKey: boolean
}

export interface SaveKeyResult {
  ok: boolean
  hasKey?: boolean
  message?: string
}

/**
 * The three preload bridges. Defined here (renderer-safe) so the preloads can
 * `satisfies` them and the renderers can type `window.dock` etc. without
 * importing across tsconfig project boundaries.
 */
export interface DockBridge {
  init(): Promise<DockInitPayload>
  onState(cb: (state: DockSnapshot) => void): () => void
  activate(index: number): void
  activateIn(index: number): void
  close(index: number): void
  minimize(index: number): void
  rename(index: number, name: string): void
  setFocusable(focusable: boolean): void
  addSlot(): void
  minimizeAll(): void
  openSettings(): void
}

export interface SessionBridge {
  slotIndex: number
  folder: string
  init(): Promise<SessionInitPayload | null>
  prompt(text: string): void
  stop(): void
  openSettings(): void
  revealFolder(): void
  closeArtifact(): void
  onAssistantStart(cb: () => void): () => void
  onText(cb: (delta: string) => void): () => void
  onTool(cb: (call: ToolStartPayload) => void): () => void
  onToolResult(cb: (r: ToolResultPayload) => void): () => void
  onEntry(cb: (entry: SessionEntry) => void): () => void
  onDone(cb: () => void): () => void
  onArtifact(cb: (a: ArtifactPayload | null) => void): () => void
  onKeyState(cb: (s: KeyStatePayload) => void): () => void
  minimizeWindow(): void
  closeWindow(): void
  zoomWindow(): void
}

export interface SettingsBridge {
  init(): Promise<SettingsInitPayload>
  saveKey(key: string): Promise<SaveKeyResult>
  clearKey(): Promise<SaveKeyResult>
  openConsole(): void
  close(): void
}
