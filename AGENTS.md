# Claude Dock

Native Swift/SwiftUI macOS app for managing AI coding agent terminal sessions.

## Architecture

- **Wispr Flow pattern**: `NSPanel` with `.nonactivatingPanel` — floating dock that doesn't steal focus
- **Menu bar app**: `LSUIElement = true`, `NSStatusItem` — no Dock icon
- **Swift Package Manager**: `swift build` to compile, `make build` for .app bundle

## Key Files

- `Sources/ClaudeDock/AppDelegate.swift` - App lifecycle, menu bar, hotkeys, panel positioning
- `Sources/ClaudeDock/FloatingPanel.swift` - NSPanel subclass (non-activating, floating)
- `Sources/ClaudeDock/DockView.swift` - Main SwiftUI dock UI
- `Sources/ClaudeDock/SlotView.swift` - Individual slot view + color palette
- `Sources/ClaudeDock/TerminalManager.swift` - Terminal launching, window tracking
- `Sources/ClaudeDock/HotkeyManager.swift` - Carbon global hotkeys
- `Sources/ClaudeDock/Config.swift` - Configuration, dock placement, agent enum
- `Sources/ClaudeDock/Models.swift` - Slot, Project, ProjectManager models
- `Resources/Info.plist` - App metadata with LSUIElement
- `init.lua` - Legacy Hammerspoon version (kept for reference)

## Dev Workflow

```bash
# Build and run
killall ClaudeDock 2>/dev/null; swift build -c release && cp .build/release/ClaudeDock .build/ClaudeDock.app/Contents/MacOS/ && open .build/ClaudeDock.app

# Or use make
make run

# Tail logs (must use full path — zsh has a builtin `log` that conflicts)
/usr/bin/log show --process ClaudeDock --last 30s | grep "com.molinar"
```

## Hotkeys

- `⌘⌥T` - Toggle dock visibility
- `⌘⌥N` - New terminal slot
- `⌘⌥M` - Minimize all terminals
- `⌘⌥L` - Move macOS Dock to left
- `⌘⌥R` - Move macOS Dock to right
- `⌘⌥B` - Move macOS Dock to bottom

## Critical Lessons (Do NOT repeat these mistakes)

### NSPanel + SwiftUI Click Handling

- **`Button` does NOT work inside a non-activating `NSPanel`**. Use `onTapGesture` on the view instead. Buttons silently fail to fire their actions.
- **`NSHostingView` must override `acceptsFirstMouse`** to return `true`, otherwise the first click activates the panel instead of triggering the tap. See `ClickThroughHostingView`.
- **`.sheet()` does NOT work inside a non-activating panel**. Use `NSAlert.runModal()` for dialogs instead. Call `NSApp.activate(ignoringOtherApps: true)` before `runModal()` so the dialog appears in front.

### SwiftUI State + NSPanel Sizing

- **`NSHostingView.fittingSize` does NOT update** when `@Published` properties change. You cannot rely on it to auto-resize the panel.
- **Rebuild the entire panel** when content changes (slot count, active project). Delete old panel, create new one with fresh `NSHostingView`. This matches the original Hammerspoon approach (`dock:delete()` then `createDock()`).
- **Guard against rebuild loops**: `@Published` changes trigger Combine sinks, which rebuild the panel, which creates new SwiftUI views that re-subscribe. Use an `isRebuilding` flag and compare old vs new values before triggering rebuild.
- **`@ObservedObject` must be explicitly passed** — a computed property like `var pm: ProjectManager { manager.projectManager }` won't trigger SwiftUI re-renders. Pass it as a separate `@ObservedObject` parameter.

### Logging

- **`print()` does NOT appear in macOS unified logs**. Use `os.log.Logger` with a custom subsystem (e.g., `com.molinar.ClaudeDock`) for proper logging.
- **`/usr/bin/log`** must be used (full path) because zsh has a builtin `log` command that conflicts.
- **Privacy redaction**: `os_log` redacts string interpolations by default in release builds. Values show as `<private>`. Use `\(value, privacy: .public)` if you need to see values.

### AXUIElement / Window Tracking

- **`_AXUIElementGetWindow` is a private API**. Declare it with `@_silgen_name("_AXUIElementGetWindow")`. Discard the return value with `_ =`.
- **Accessibility permission required** for window tracking via AXUIElement APIs.

### Carbon Hotkey API

- Use `RegisterEventHotKey` with `GetApplicationEventTarget()` for global hotkeys.
- Key codes are hardware codes (T=17, N=45, M=46, R=15, L=37, B=11).
- Modifiers use Carbon constants: `Carbon.cmdKey`, `Carbon.optionKey`.

### macOS Dock Interaction

- Read position: `defaults read com.apple.dock orientation`
- Change position: `defaults write com.apple.dock orientation left && killall Dock`
- `killall Dock` causes a brief `XPC_ERROR_CONNECTION_INTERRUPTED` in logs — this is normal.
- Use `NSScreen.visibleFrame` (excludes Dock/menu bar) vs `NSScreen.frame` (full screen) to detect Dock height.
