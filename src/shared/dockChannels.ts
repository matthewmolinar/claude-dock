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
  OpenSettings: 'lore:dock:open-settings',
} as const

export const DockSessionIpcChannel = {
  /** Renderer → main (invoke): slot index, folder, transcript replay, key state. */
  Init: 'lore:dock-session:init',
  Prompt: 'lore:dock-session:prompt',
  Stop: 'lore:dock-session:stop',
  OpenSettings: 'lore:dock-session:open-settings',
  RevealFolder: 'lore:dock-session:reveal-folder',
  // Main → session pushes, one streaming turn:
  AssistantStart: 'lore:dock-session:assistant-start',
  Text: 'lore:dock-session:text',
  Tool: 'lore:dock-session:tool',
  ToolResult: 'lore:dock-session:tool-result',
  Entry: 'lore:dock-session:entry',
  Done: 'lore:dock-session:done',
  KeyState: 'lore:dock-session:key-state',
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
