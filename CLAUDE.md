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
- `⌘⌥R` - Reload config
