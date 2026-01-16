# Claude Dock

Hammerspoon-based terminal dock for managing Claude Code sessions.

## Key Files
- `init.lua` - Main Hammerspoon config (source)
- `~/.hammerspoon/init.lua` - Active config Hammerspoon loads

## Dev Workflow
After editing `init.lua`, sync and reload:
```bash
cp init.lua ~/.hammerspoon/init.lua && hs -c "hs.reload()"
```

## Tests
```bash
hs -c "runTests()"
```

## Hotkeys
- `⌘⌥T` - Toggle dock
- `⌘⌥N` - New terminal
- `⌘⌥M` - Minimize all
- `⌘⌥R` - Reload config
