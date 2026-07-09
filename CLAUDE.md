# Claude Dock

Electron terminal dock for managing AI coding agent sessions (Claude Code, Amp, Codex).
The app owns its terminals: each slot is a real PTY rendered with xterm.js in a
frameless window. No Hammerspoon, no AppleScript, no Accessibility permission.

## Layout
- `src/main/` - main process: `index.js` (lifecycle, IPC, hotkeys),
  `session-manager.js` (slot + PTY state), `windows.js` (window factories)
- `src/preload/` - contextBridge APIs; renderers have no Node access
- `src/renderer/dock/` - dock UI
- `src/renderer/terminal/` - xterm.js terminal + custom title bar
- `src/shared/` - pure, unit-tested logic: layout math, title parsing, session
  index reader, persisted store
- `scripts/vendor.js` - postinstall step copying xterm's browser bundles into
  `src/renderer/terminal/vendor/` (gitignored). Run `npm run vendor` if the
  terminal window comes up blank.

## Dev Workflow
```bash
npm start      # run the app
npm run dev    # foreground + logs
npm test       # unit tests (node:test)
```

`electron` sits in `dependencies` (not `devDependencies`) so `npx claude-dock`
can launch it. Consequence: electron-builder cannot package this app, so there
is no `.dmg` target. Do not "fix" this by moving electron to devDependencies -
that breaks the npx install path.

## Gotchas
- The preload exposes `window.term`, so a top-level `const term` in the terminal
  renderer is a redeclaration SyntaxError. The xterm instance is named `xterm`.
- The dock window is `focusable: false` so it never steals focus. Inline rename
  temporarily flips it via the `dock:setFocusable` IPC.
- `@lydell/node-pty` ships N-API prebuilds, so it loads under Electron's ABI with
  no `electron-rebuild`. Do not swap it for stock `node-pty` without checking that.
- PTY output is flow-controlled: the renderer acks each chunk after xterm parses
  it, and main pauses the PTY above the high-water mark.

## Commits
This repo uses [conventional commits](https://www.conventionalcommits.org/) and semantic-release for automated versioning.
- `fix:` → patch release
- `feat:` → minor release
- `feat!:` / `BREAKING CHANGE:` → major release
- `docs:`, `chore:`, `ci:`, `test:`, `refactor:` → no release

## Hotkeys
- `⌘⌥T` - Toggle dock
- `⌘⌥N` - New terminal
- `⌘⌥M` - Minimize all
- `⌘⌥R` - Reload dock
- `⌥+Click` - Rename slot
- `⇧+Click` - Open in a chosen folder
