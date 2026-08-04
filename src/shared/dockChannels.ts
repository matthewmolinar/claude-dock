/**
 * IPC contract for the dock widget (ported from claude-dock).
 *
 * Four channel groups, one per surface: the dock strip, session (chat)
 * windows, the dock settings window, and shared frameless-window chrome.
 * Main registers all handlers in `registerDockWidget()`; the matching
 * preloads (`src/preload/{dock,session,settings}.ts`) expose them as
 * `window.dock` / `window.session` / `window.settings` — deliberately NOT on
 * `window.lore`, which is injected into the remote hosted app.
 */

export const DockIpcChannel = {
  /** Renderer → main (invoke): fetch layout constants + initial snapshot. */
  Init: 'lore:dock:init',
  /** Main → dock: full snapshot pushed on every state change. */
  State: 'lore:dock:state',
  /** Renderer → main: open/focus the session for a slot. */
  SlotActivate: 'lore:dock:slot-activate',
  /** Renderer → main: activate after re-picking the slot's folder. */
  SlotActivateIn: 'lore:dock:slot-activate-in',
  SlotClose: 'lore:dock:slot-close',
  SlotMinimize: 'lore:dock:slot-minimize',
  SlotRename: 'lore:dock:slot-rename',
  /** Inline rename needs the (normally non-activating) dock to take focus. */
  SetFocusable: 'lore:dock:set-focusable',
  AddSlot: 'lore:dock:add-slot',
  MinimizeAll: 'lore:dock:minimize-all',
  /** Hide every piece of dock UI: minimize all session windows, hide the strip. */
  Dismiss: 'lore:dock:dismiss',
  OpenSettings: 'lore:dock:open-settings',
  /** Renderer → main: request the host open its quests panel (host-defined). */
  OpenQuests: 'lore:dock:open-quests',
  /** Main → dock: host-fed shelf cards per slot (SlotCardsSnapshot). */
  SlotCards: 'lore:dock:slot-cards',
  /** Renderer → main (invoke): move a card between slots; resolves false on refusal. */
  MoveSlotCard: 'lore:dock:move-slot-card',
  /** Renderer → main: a shelf card was clicked (host-defined action). */
  ActivateSlotCard: 'lore:dock:activate-slot-card',
  /** Renderer → main: shelf opened/closed — grow/shrink the strip window. */
  SetShelf: 'lore:dock:set-shelf',
  /** Renderer → main: reveal/tuck the strip around its resting edge handle. */
  SetExpanded: 'lore:dock:set-expanded',
  /** Renderer → main: persist compact versus pinned presentation. */
  SetPinned: 'lore:dock:set-pinned',
  /** Main → renderer: authoritative expanded/pinned presentation. */
  Presentation: 'lore:dock:presentation',
  /** Main → renderer: native window movement started. */
  WindowMove: 'lore:dock:window-move',
  /** Renderer → main (invoke): cycle the system macOS Dock left → right → bottom. */
  MoveMacDock: 'lore:dock:move-mac-dock',
} as const

export const DockSessionIpcChannel = {
  /** Renderer → main (invoke): slot index, folder, transcript replay, key state. */
  Init: 'lore:dock-session:init',
  Prompt: 'lore:dock-session:prompt',
  Stop: 'lore:dock-session:stop',
  /** Renderer → main: pick and ingest a reference document for the sending session. */
  AddReferenceDocument: 'lore:dock-session:add-reference-document',
  RefreshSources: 'lore:dock-session:refresh-sources',
  RetrySources: 'lore:dock-session:retry-sources',
  PreviewSource: 'lore:dock-session:preview-source',
  CloseInspector: 'lore:dock-session:close-inspector',
  OpenSourceLink: 'lore:dock-session:open-source-link',
  DismissSourceNotice: 'lore:dock-session:dismiss-source-notice',
  OpenSettings: 'lore:dock-session:open-settings',
  RevealFolder: 'lore:dock-session:reveal-folder',
  CloseArtifact: 'lore:dock-session:close-artifact',
  SelectOutput: 'lore:dock-session:select-output',
  DemoteOutput: 'lore:dock-session:demote-output',
  SaveOutputCopy: 'lore:dock-session:save-output-copy',
  /** Renderer → main: open one server-validated Lore citation target. */
  OpenLoreSource: 'lore:dock-session:open-lore-source',
  /** Renderer → main (invoke): publish the shown artifact to Lore, copy its URL. */
  ShareArtifact: 'lore:dock-session:share-artifact',
  DecideApproval: 'lore:dock-session:decide-approval',
  FetchEvidence: 'lore:dock-session:fetch-evidence',
  ShareEvidence: 'lore:dock-session:share-evidence',
  // Main → session pushes, one streaming turn:
  AssistantStart: 'lore:dock-session:assistant-start',
  Progress: 'lore:dock-session:progress',
  Text: 'lore:dock-session:text',
  Tool: 'lore:dock-session:tool',
  ToolResult: 'lore:dock-session:tool-result',
  Terminal: 'lore:dock-session:terminal',
  Entry: 'lore:dock-session:entry',
  /** The turn ended, carrying a `SessionDonePayload` — `{}` when no host outcome. */
  Done: 'lore:dock-session:done',
  Artifact: 'lore:dock-session:artifact',
  Outputs: 'lore:dock-session:outputs',
  Sources: 'lore:dock-session:sources',
  SourceNotice: 'lore:dock-session:source-notice',
  KeyState: 'lore:dock-session:key-state',
  Compatibility: 'lore:dock-session:compatibility',
  /** Renderer → main: run the host update flow for the sending window. */
  CheckForUpdates: 'lore:dock-session:check-for-updates',
  Approvals: 'lore:dock-session:approvals',
  EvidenceAnnotations: 'lore:dock-session:evidence-annotations',
  /** Main → session: complete ephemeral author-private reviews keyed by Outcome reference. */
  Reviews: 'lore:dock-session:reviews',
  Resume: 'lore:dock-session:resume',
  RefreshResume: 'lore:dock-session:refresh-resume',
  UpdateObjective: 'lore:dock-session:update-objective',
  UpdateNextStep: 'lore:dock-session:update-next-step',
  PreviewResumeSource: 'lore:dock-session:preview-resume-source',
} as const

export const DockMacDockIpcChannel = {
  /** Renderer → main (invoke): the current macOS Dock orientation. */
  Init: 'lore:dock-macdock:init',
  /** Renderer → main (invoke): move the macOS Dock to the given side. */
  Set: 'lore:dock-macdock:set',
} as const

export const DockSettingsIpcChannel = {
  /** Renderer → main (invoke): whether an Anthropic API key is stored. */
  Init: 'lore:dock-settings:init',
  SaveKey: 'lore:dock-settings:save-key',
  ClearKey: 'lore:dock-settings:clear-key',
  OpenConsole: 'lore:dock-settings:open-console',
} as const

/** Custom traffic-light chrome shared by the frameless dock windows. */
export const DockWinIpcChannel = {
  Minimize: 'lore:dock-win:minimize',
  Close: 'lore:dock-win:close',
  Zoom: 'lore:dock-win:zoom',
} as const
