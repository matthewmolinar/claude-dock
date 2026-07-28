/**
 * Dock slot/session state: which folder each slot points at, its chat window,
 * its agent, and the in-memory transcript that session windows replay on
 * (re)open. Ported from claude-dock `src/main/session-manager.js`.
 *
 * Host integration: each conversation can be mirrored through an injected
 * `TranscriptMirror` (Lore desktop injects its Claude-Code-format JSONL
 * writer so the embedded upload watch loop ships sessions to Lore; the
 * standalone app injects nothing).
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dialog, type BrowserWindow } from 'electron'

import { slotLabel, type ArtifactPayload, type DockSnapshot, type SessionEntry, type SessionInitPayload, type TranscriptTool } from '../../shared/dock'
import { artifactAction, artifactUrl, type SlotArtifact } from '../../shared/dockArtifact'
import { DockSessionIpcChannel } from '../../shared/dockChannels'
import { registerArtifact, unregisterArtifact } from './artifactProtocol'
import { Agent, type AgentToolEvent, type AgentToolResultEvent } from './harness/agent'
import { resolveInRoot } from './harness/tools'
import type { KeyStore } from './keystore'
import type { DockStore } from './store'

const MAX_SLOTS = 12

/**
 * Where a session starts when the user has not picked a folder. A dedicated
 * folder, not the home dircetory >> an unpicked sesion should not hand the
 * agent everything the user owns.
 */
function defaultFolder(): string {
  const dir = path.join(os.homedir(), 'Lore')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Optional per-conversation mirror. The agent's verbatim Anthropic message
 * blocks are forwarded so a host can persist the conversation however it
 * likes (Lore writes Claude-Code-format JSONL for its upload pipeline).
 */
export interface TranscriptMirror {
  appendUser(content: unknown): void
  appendAssistant(content: unknown[]): void
  appendToolResults(results: unknown[]): void
}

interface Slot {
  customName: string | null
  folder: string | null
  artifact: SlotArtifact | null
  firstPrompt: string | null
  agent: Agent | null
  mirror: TranscriptMirror | null
  win: BrowserWindow | null
  /** Everything the session window needs to re-render after a reload. */
  transcript: SessionEntry[]
  busy: boolean
  hasNotification: boolean
}

export interface SessionManagerOptions {
  store: DockStore
  keyStore: KeyStore
  createSessionWindow: (opts: { slotIndex: number; folder: string }) => BrowserWindow
  /** Widen/restore a session window when its artifact pane opens/closes. */
  resizeForArtifact: (win: BrowserWindow | null, open: boolean) => void
  /** Optional host hook: mirror each conversation (one mirror per agent). */
  createTranscriptMirror?: (cwd: string) => TranscriptMirror
}

export class SessionManager extends EventEmitter {
  private store: DockStore
  private keyStore: KeyStore
  private createSessionWindow: SessionManagerOptions['createSessionWindow']
  private resizeForArtifact: SessionManagerOptions['resizeForArtifact']
  private createTranscriptMirror?: (cwd: string) => TranscriptMirror
  private slots: Slot[] = []

  constructor({ store, keyStore, createSessionWindow, resizeForArtifact, createTranscriptMirror }: SessionManagerOptions) {
    super()
    this.store = store
    this.keyStore = keyStore
    this.createSessionWindow = createSessionWindow
    this.resizeForArtifact = resizeForArtifact
    this.createTranscriptMirror = createTranscriptMirror

    const persisted = store.get()
    for (let i = 0; i < persisted.slotCount; i++) {
      const saved = persisted.slots[i] || { customName: null, folder: null, artifact: null }
      this.slots.push(this.blankSlot(saved.customName ?? null, saved.folder ?? null, saved.artifact ?? null))
    }
  }

  private blankSlot(
    customName: string | null = null,
    folder: string | null = null,
    artifact: SlotArtifact | null = null,
  ): Slot {
    return {
      customName,
      folder,
      artifact,
      firstPrompt: null,
      agent: null,
      mirror: null,
      win: null,
      transcript: [],
      busy: false,
      hasNotification: false,
    }
  }

  get slotCount(): number {
    return this.slots.length
  }

  persist(): void {
    this.store.set({
      slotCount: this.slots.length,
      slots: this.slots.map((s) => ({
        customName: s.customName,
        folder: s.folder,
        artifact: s.artifact,
      })),
    })
  }

  // ---- derived view ------------------------------------------------------

  private liveWindow(slot: Slot): BrowserWindow | null {
    return slot.win && !slot.win.isDestroyed() ? slot.win : null
  }

  private slotStatus(slot: Slot): 'empty' | 'idle' | 'working' | 'minimized' | 'active' {
    const win = this.liveWindow(slot)
    if (!win) return slot.folder ? 'idle' : 'empty'
    if (slot.busy) return 'working'
    return win.isMinimized() ? 'minimized' : 'active'
  }

  snapshot(): DockSnapshot {
    return {
      slots: this.slots.map((slot, i) => ({
        index: i,
        label: slotLabel({
          customName: slot.customName,
          firstPrompt: slot.firstPrompt,
          folder: slot.folder,
          index: i + 1,
        }),
        status: this.slotStatus(slot),
        hasWindow: Boolean(this.liveWindow(slot)),
        hasNotification: slot.hasNotification,
        folder: slot.folder,
      })),
    }
  }

  private changed(): void {
    this.emit('changed', this.snapshot())
  }

  private pushWindow(slot: Slot, channel: string, payload: unknown): void {
    const win = this.liveWindow(slot)
    if (win) win.webContents.send(channel, payload)
  }

  /** Tell every open session window about something, e.g. the key changing. */
  broadcast(channel: string, payload: unknown): void {
    for (const slot of this.slots) this.pushWindow(slot, channel, payload)
  }

  // ---- slot lifecycle ----------------------------------------------------

  addSlot(): number | null {
    if (this.slots.length >= MAX_SLOTS) return null
    this.slots.push(this.blankSlot())
    this.persist()
    this.changed()
    return this.slots.length - 1
  }

  rename(index: number, name: string): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.customName = name && name.trim() ? name.trim() : null
    this.persist()
    this.changed()
  }

  /** Focus an existing window, or open one for this slot. */
  activate(index: number, { folder }: { folder?: string } = {}): void {
    const slot = this.slots[index]
    if (!slot) return

    slot.hasNotification = false

    const win = this.liveWindow(slot)

    // Pointing an open session at a new folder means a new agent and a new
    // transcript — the old agent's tools are bound to the old root.
    if (win && folder && folder !== slot.folder) {
      if (slot.agent) slot.agent.abort()
      slot.agent = null
      slot.mirror = null
      slot.transcript = []
      slot.firstPrompt = null
      slot.artifact = null
      unregisterArtifact(this.slots.indexOf(slot))
      slot.busy = false
      win.destroy()
      slot.win = null
    } else if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      this.changed()
      return
    }

    // A session starts in its own folder unless the user points it somewhere
    // else. Nobody should have to answer a file-picker before saying hello.
    if (folder) slot.folder = folder
    if (!slot.folder) slot.folder = defaultFolder()

    slot.win = this.createSessionWindow({ slotIndex: index, folder: slot.folder })
    this.wireWindow(slot)
    if (this.artifactPayload(index, slot)) this.resizeForArtifact(slot.win, true)
    this.persist()
    this.changed()
  }

  private wireWindow(slot: Slot): void {
    const win = slot.win
    if (!win) return
    win.on('focus', () => {
      slot.hasNotification = false
      this.changed()
    })
    win.on('minimize', () => this.changed())
    win.on('restore', () => this.changed())
    win.on('closed', () => {
      slot.win = null
      if (slot.agent) slot.agent.abort()
      slot.busy = false
      this.changed()
    })
  }

  /** Everything the session renderer needs on load, including past messages. */
  sessionState(index: number): SessionInitPayload | null {
    const slot = this.slots[index]
    if (!slot) return null
    return {
      index,
      folder: slot.folder,
      busy: slot.busy,
      transcript: slot.transcript,
      artifact: this.artifactPayload(index, slot),
      hasKey: this.keyStore.has(),
    }
  }

  // ---- artifact pane -----------------------------------------------------

  /** null when there is no artifact or its file has gone missing. */
  private artifactPayload(index: number, slot: Slot): ArtifactPayload | null {
    if (!slot.artifact || !slot.folder) return null
    try {
      const file = resolveInRoot(slot.folder, slot.artifact.path)
      if (!fs.existsSync(file)) throw new Error('gone')
      // The artifact:// handler serves exactly this file for this slot.
      registerArtifact(index, file)
      return { url: artifactUrl(index), title: slot.artifact.title, version: slot.artifact.version || 0 }
    } catch {
      unregisterArtifact(index)
      return null
    }
  }

  private applyArtifactAction(
    index: number,
    slot: Slot,
    call: { name: string; input: { path?: unknown; title?: unknown } },
    ok: boolean,
  ): void {
    const action = artifactAction(slot.artifact, call.name, call.input || {}, ok)
    if (!action) return

    if (action.type === 'show') {
      const opening = !slot.artifact
      slot.artifact = { path: action.path, title: action.title, version: 1 }
      this.persist()
      const win = this.liveWindow(slot)
      if (win && opening) this.resizeForArtifact(win, true)
    } else if (slot.artifact) {
      slot.artifact.version = (slot.artifact.version || 0) + 1
    }
    this.pushWindow(slot, DockSessionIpcChannel.Artifact, this.artifactPayload(index, slot))
  }

  closeArtifact(index: number): void {
    const slot = this.slots[index]
    if (!slot || !slot.artifact) return
    slot.artifact = null
    unregisterArtifact(index)
    this.persist()
    this.pushWindow(slot, DockSessionIpcChannel.Artifact, null)
    const win = this.liveWindow(slot)
    if (win) this.resizeForArtifact(win, false)
  }

  // ---- the agent ---------------------------------------------------------

  private ensureAgent(slot: Slot): Agent {
    if (slot.agent) return slot.agent

    const apiKey = this.keyStore.get()
    if (!apiKey) throw new Error('NO_API_KEY')

    const folder = slot.folder ?? defaultFolder()
    slot.agent = new Agent({
      apiKey,
      root: folder,
      folderName: folder === os.homedir() ? 'your home folder' : path.basename(folder),
      confirmCommand: (command) => this.confirmCommand(slot, command),
    })

    // One mirror per agent: a new agent is a new conversation.
    const mirror = this.createTranscriptMirror?.(folder)
    if (mirror) {
      slot.mirror = mirror
      slot.agent.on('assistant_message', (content: unknown[]) => mirror.appendAssistant(content))
      slot.agent.on('tool_results_message', (results: unknown[]) => mirror.appendToolResults(results))
    }

    return slot.agent
  }


  private async confirmCommand(slot: Slot, command: string): Promise<boolean> {
    const win = this.liveWindow(slot)
    if (!win) return false
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      message: 'Run this on your Mac?',
      detail: command,
      buttons: ['Run', "Don't run"],
      defaultId: 1,
      cancelId: 1,
    })
    return response === 0
  }

  async prompt(index: number, text: string): Promise<void> {
    const slot = this.slots[index]
    if (!slot || slot.busy || !text.trim()) return

    let agent: Agent
    try {
      agent = this.ensureAgent(slot)
    } catch (err) {
      const message =
        err instanceof Error && err.message === 'NO_API_KEY'
          ? 'Add your Anthropic API key in Settings to get started.'
          : err instanceof Error
            ? err.message
            : String(err)
      this.appendTranscript(slot, { role: 'error', text: message })
      return
    }

    if (!slot.firstPrompt) {
      slot.firstPrompt = text
      this.persist()
    }

    slot.busy = true
    this.appendTranscript(slot, { role: 'user', text })
    slot.mirror?.appendUser(text)
    this.changed()

    // One assistant bubble per turn; deltas append into it.
    const bubble: SessionEntry & { role: 'assistant' } = { role: 'assistant', text: '', tools: [] }
    // Tool calls in flight this turn, so a result can be matched to its input.
    const liveCalls = new Map<string, { name: string; input: { path?: unknown; title?: unknown } }>()
    slot.transcript.push(bubble)
    this.pushWindow(slot, DockSessionIpcChannel.AssistantStart, {})

    const onText = (delta: string): void => {
      bubble.text += delta
      this.pushWindow(slot, DockSessionIpcChannel.Text, delta)
    }
    const onTool = (call: AgentToolEvent): void => {
      const tool: TranscriptTool = { id: call.id, label: call.label, input: call.input, output: null }
      bubble.tools.push(tool)
      liveCalls.set(call.id, { name: call.name, input: (call.input ?? {}) as { path?: unknown; title?: unknown } })
      this.pushWindow(slot, DockSessionIpcChannel.Tool, { id: call.id, label: call.label })
    }
    const onToolResult = ({ id, ok, output }: AgentToolResultEvent): void => {
      const entry = bubble.tools.find((t) => t.id === id)
      if (entry) {
        entry.output = output
        entry.ok = ok
      }
      this.pushWindow(slot, DockSessionIpcChannel.ToolResult, { id, ok, output })

      const call = liveCalls.get(id)
      if (call) this.applyArtifactAction(index, slot, call, ok)
    }

    agent.on('text', onText)
    agent.on('tool', onTool)
    agent.on('tool_result', onToolResult)

    const finish = (): void => {
      agent.off('text', onText)
      agent.off('tool', onTool)
      agent.off('tool_result', onToolResult)
      slot.busy = false
      this.notifyIfAway(slot)
      this.pushWindow(slot, DockSessionIpcChannel.Done, {})
      this.changed()
    }

    agent.once('error', ({ message }: { message: string }) => {
      this.appendTranscript(slot, { role: 'error', text: message })
      finish()
    })
    agent.once('done', finish)

    await agent.send(text)
  }

  stop(index: number): void {
    const slot = this.slots[index]
    if (slot && slot.agent) slot.agent.abort()
  }

  slotFolder(index: number): string | null {
    return this.slots[index]?.folder ?? null
  }

  /**
   * Agents hold the key they were built with; drop them when it changes.
   * An in-flight turn is left to finish on the old key, as the source did.
   */
  resetAgents(): void {
    for (const slot of this.slots) {
      slot.agent = null
      slot.mirror = null
    }
  }

  private appendTranscript(slot: Slot, entry: SessionEntry): void {
    slot.transcript.push(entry)
    this.pushWindow(slot, DockSessionIpcChannel.Entry, entry)
  }

  /** The agent finished while the user was looking elsewhere: badge the slot. */
  private notifyIfAway(slot: Slot): void {
    const win = this.liveWindow(slot)
    if (win && !win.isFocused()) slot.hasNotification = true
  }

  // ---- bulk actions ------------------------------------------------------

  closeSlot(index: number): boolean {
    const slot = this.slots[index]
    if (!slot) return false
    const win = this.liveWindow(slot)
    unregisterArtifact(index)
    if (slot.agent) slot.agent.abort()
    if (win) win.destroy()
    this.slots[index] = this.blankSlot()
    this.persist()
    this.changed()
    return true
  }

  minimizeSlot(index: number): boolean {
    const slot = this.slots[index]
    const win = slot && this.liveWindow(slot)
    if (!win || win.isMinimized()) return false
    win.minimize()
    this.changed()
    return true
  }

  minimizeAll(): number {
    let count = 0
    for (const slot of this.slots) {
      const win = this.liveWindow(slot)
      if (win && !win.isMinimized()) {
        win.minimize()
        count++
      }
    }
    this.changed()
    return count
  }

  disposeAll(): void {
    for (const slot of this.slots) {
      if (slot.agent) slot.agent.abort()
      const win = this.liveWindow(slot)
      if (win) win.destroy()
    }
  }
}
