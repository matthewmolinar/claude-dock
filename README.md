# Claude Dock

A lightweight, expandable terminal dock for macOS built with [Hammerspoon](https://www.hammerspoon.org/). Manage multiple AI coding agent sessions - **Claude Code**, **Amp**, and **Codex**.

![Claude Dock](https://img.shields.io/badge/macOS-Hammerspoon-blue)
[![npm version](https://img.shields.io/npm/v/claude-dock.svg)](https://www.npmjs.com/package/claude-dock)

## Features

- **Multi-agent support** - Works with Claude Code, Sourcegraph Amp, and OpenAI Codex
- **Expandable dock** - Start with 3 slots, add more with "+" button or hotkey
- **Terminal management** - Each slot tracks a specific terminal window
- **Auto-launch** - New terminals automatically run your configured agent
- **Custom naming** - Name your terminals for easy identification
- **Visual status** - See which terminals are active, minimized, or on other spaces
- **Notification badges** - Red dot appears when a terminal has activity while unfocused
- **Quick access** - Click to focus/unminimize terminals
- **Keyboard shortcuts** - Full hotkey support

## Installation

```bash
npx claude-dock
```

That's it! The installer will:
- Install Hammerspoon (if needed)
- Set up the dock configuration
- Launch Hammerspoon

**Note:** You'll need to grant Accessibility permissions when prompted:
System Settings → Privacy & Security → Accessibility → Enable Hammerspoon

### Manual Installation

<details>
<summary>Click to expand manual setup instructions</summary>

1. Install [Hammerspoon](https://www.hammerspoon.org/):
   ```bash
   brew install --cask hammerspoon
   ```

2. Grant Accessibility permissions:
   - System Settings > Privacy & Security > Accessibility
   - Enable Hammerspoon

3. Clone this repo and copy the config:
   ```bash
   git clone https://github.com/matthewmolinar/claude-dock.git
   cp claude-dock/init.lua ~/.hammerspoon/init.lua
   ```

4. Launch Hammerspoon (or reload if already running)

</details>

## Usage

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Option+T` | Toggle dock visibility |
| `Cmd+Option+N` | Add new slot + launch terminal |
| `Cmd+Option+M` | Minimize all terminals |
| `Cmd+Option+R` | Reload configuration |
| `Option+Click` | Rename a slot |

### Slot States

| Color | Status |
|-------|--------|
| Gray | Empty - click to open new terminal |
| Green | Active terminal |
| Blue | Minimized or on other space |
| Red dot | Terminal has new activity |

### Click Actions

- **Click empty slot** - Prompts for name, opens terminal, runs agent
- **Click active slot** - Focuses that terminal window
- **Click minimized slot** - Unminimizes and focuses
- **Click "+" button** - Adds new slot and launches terminal
- **Option+Click any slot** - Rename it

## Configuration

Edit `~/.hammerspoon/init.lua` to customize.

### Changing the Agent

By default, claude-dock launches `claude`. To use a different agent:

```lua
local config = {
    -- Agent to launch: "claude", "amp", or "codex"
    agent = "amp",  -- Change to your preferred agent
    ...
}
```

Supported agents:
- `"claude"` - [Claude Code](https://claude.ai/code) (default)
- `"amp"` - [Sourcegraph Amp](https://ampcode.com/)
- `"codex"` - [OpenAI Codex](https://openai.com/codex/)

### Other Options

```lua
local config = {
    agent = "claude",      -- Which AI agent to launch
    slotWidth = 140,       -- Width of each slot
    slotHeight = 60,       -- Height of each slot
    gap = 8,               -- Gap between slots
    margin = 10,           -- Dock padding
    bottomOffset = 5,      -- Distance from screen bottom
    initialSlots = 3,      -- Starting number of slots
}
```

## Running Tests

```bash
hs -c "runTests()"
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please open an issue or PR.
