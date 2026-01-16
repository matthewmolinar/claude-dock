# Claude Dock

A lightweight, expandable terminal dock for macOS built with [Hammerspoon](https://www.hammerspoon.org/). Designed for managing multiple Claude Code terminal sessions.

![Claude Dock](https://img.shields.io/badge/macOS-Hammerspoon-blue)

## Features

- **Expandable dock** - Start with 3 slots, add more with "+" button or hotkey
- **Terminal management** - Each slot tracks a specific terminal window
- **Auto-launch Claude** - New terminals automatically run `claude` command
- **Custom naming** - Name your terminals for easy identification
- **Visual status** - See which terminals are active, minimized, or empty
- **Quick access** - Click to focus/unminimize terminals
- **Keyboard shortcuts** - Full hotkey support

## Installation

### Prerequisites

1. Install [Hammerspoon](https://www.hammerspoon.org/):
   ```bash
   brew install --cask hammerspoon
   ```

2. Grant Accessibility permissions:
   - System Settings > Privacy & Security > Accessibility
   - Enable Hammerspoon

### Setup

1. Clone this repo (or download the ZIP from GitHub)

2. Copy to Hammerspoon config:
   ```bash
   cp claude-dock/init.lua ~/.hammerspoon/init.lua
   ```

3. Launch Hammerspoon (or reload if already running)

## Usage

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Option+T` | Toggle dock visibility |
| `Cmd+Option+N` | Add new slot + launch terminal |
| `Cmd+Option+R` | Reload configuration |
| `Option+Click` | Rename a slot |

### Slot States

| Color | Status |
|-------|--------|
| Gray | Empty - click to open new terminal |
| Green | Active terminal |
| Blue | Minimized terminal |

### Click Actions

- **Click empty slot** - Prompts for name, opens terminal, runs `claude`
- **Click active slot** - Focuses that terminal window
- **Click minimized slot** - Unminimizes and focuses
- **Click "+" button** - Adds new slot and launches terminal
- **Option+Click any slot** - Rename it

## Configuration

Edit `init.lua` to customize:

```lua
-- Configuration
local slotWidth = 140      -- Width of each slot
local slotHeight = 60      -- Height of each slot
local gap = 8              -- Gap between slots
local margin = 10          -- Dock padding
local bottomOffset = 5     -- Distance from screen bottom
local slotCount = 3        -- Initial number of slots
```

### Using a Different Terminal

To use iTerm instead of Terminal.app, modify the `onSlotClick` function:

```lua
-- Change this:
hs.applescript([[
    tell application "Terminal"
        do script "claude"
        activate
    end tell
]])

-- To this:
hs.applescript([[
    tell application "iTerm"
        create window with default profile command "claude"
        activate
    end tell
]])
```

## Running Tests

```bash
hs -c "runTests()"
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please open an issue or PR.
