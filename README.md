# Claude Dock

A lightweight, expandable terminal dock for macOS. Manage multiple AI coding agent sessions - **Claude Code**, **Amp**, and **Codex** - each in its own built-in terminal.

![Claude Dock](https://img.shields.io/badge/macOS-Electron-blue)
[![npm version](https://img.shields.io/npm/v/claude-dock.svg)](https://www.npmjs.com/package/claude-dock)

Claude Dock is a standalone app. It has no Hammerspoon dependency, needs no
Accessibility permission, and never drives Terminal.app over AppleScript - it
owns the terminals it shows.

## Features

- **Multi-agent support** - Claude Code, Sourcegraph Amp, and OpenAI Codex
- **Built-in terminals** - a real PTY in a native window, not a remote-controlled Terminal.app
- **Expandable dock** - start with 3 slots, add more with "+" or a hotkey
- **Live slot names** - slots follow the agent's own terminal title, falling back to its session summary
- **Visual status** - see which terminals are active or minimized
- **Notification badges** - a pulsing dot when an agent produces output while you're elsewhere
- **Quick access** - click to focus, ⌥-click to rename, ⇧-click to pick a folder
- **Keyboard shortcuts** - full hotkey support

## Installation

```bash
npx claude-dock
```

That's it. No permissions to grant, no system settings to change.

### From source

```bash
git clone https://github.com/matthewmolinar/claude-dock.git
cd claude-dock
npm install
npm start
```

## Usage

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Option+T` | Toggle dock visibility |
| `Cmd+Option+N` | Add new slot + launch terminal |
| `Cmd+Option+M` | Minimize all terminals |
| `Cmd+Option+R` | Reload the dock |
| `Option+Click` | Rename a slot |
| `Shift+Click` | Open a terminal in a chosen folder |

Inside a terminal: `Cmd+C` / `Cmd+V` copy and paste, `Cmd+K` clears, `Cmd+A` selects all.

### Slot states

| Color | Status |
|-------|--------|
| Gray | Empty - click to open a terminal |
| Green | Active terminal |
| Blue | Minimized |
| Red dot | Agent produced output while unfocused |

### Click actions

- **Click empty slot** - opens a terminal in your home directory and starts the selected agent
- **Shift+Click empty slot** - pick the folder to start in
- **Click active slot** - focus that terminal
- **Click minimized slot** - restore and focus it
- **Click "+"** - add a slot and launch a terminal
- **Option+Click a slot** - rename it inline
- **Red / yellow dot on a slot** - close / minimize that terminal

## Configuration

Pick the agent with the tabs in the dock's top-left. That choice, your slot
count, and any slot names persist across restarts in
`~/Library/Application Support/claude-dock/state.json`.

Supported agents:

- `claude` - [Claude Code](https://claude.ai/code) (default)
- `amp` - [Sourcegraph Amp](https://ampcode.com/)
- `codex` - [OpenAI Codex](https://openai.com/codex/)

Each terminal runs your login shell (`$SHELL -l`), so the agent resolves through
your normal `PATH` and your usual shell config applies.

Layout constants (slot size, gaps, margins) live in `src/shared/layout.js`.

## How slot names are chosen

In priority order:

1. A name you set with ⌥-click
2. The terminal title the agent sets (e.g. `✳ Claude Code`)
3. The most recent session summary from `~/.claude/projects/<project>/sessions-index.json`
4. The working directory's name
5. `Claude 2`, `Codex 3`, …

## Positioning

The dock centers itself along the bottom of your primary display's *work area*,
which already excludes the menu bar and the macOS Dock on whichever edge it
lives. Earlier versions shipped hotkeys to move the system Dock out of the way;
that workaround is no longer needed and has been removed.

## Development

```bash
npm start        # run the app
npm run dev      # run in the foreground with logs
npm test         # unit tests for the pure logic
```

`electron` is a runtime dependency rather than a devDependency, so that
`npx claude-dock` can launch it. That is also why there is no `.dmg` build:
electron-builder refuses to package an app whose `dependencies` include
electron, and the npx install path is the one this project ships.

Architecture:

- `src/main/` - Electron main process: PTY lifecycle, windows, IPC, hotkeys
- `src/preload/` - context-isolated bridges; renderers get no Node access
- `src/renderer/dock/` - the dock UI
- `src/renderer/terminal/` - xterm.js terminal + custom title bar
- `src/shared/` - pure logic (layout math, title parsing, state store), unit tested

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please open an issue or PR. This project uses [conventional commits](https://www.conventionalcommits.org/) - releases are published automatically when PRs merge to `main`.
