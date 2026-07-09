# Lore

A quiet dock of AI assistants for macOS. Point one at a folder, ask it for something in plain English, and watch it work.

![Lore](https://img.shields.io/badge/macOS-Electron-blue)
[![npm version](https://img.shields.io/npm/v/claude-dock.svg)](https://www.npmjs.com/package/claude-dock)

Lore is built for people who are not programmers. There is no terminal, no
command line, and nothing to configure beyond an API key. It has its own agent
harness — it does not shell out to Claude Code, Amp, or Codex.

## Features

- **Ask in plain English** — "what's in this folder?", "clean up these notes", "add butter to my grocery list"
- **A dock of sessions** — each session is one folder, remembered between launches
- **See what it did** — every file it reads, edits, or runs shows up as a plain-language chip you can expand
- **Nothing hidden** — the assistant can only touch the folder you picked
- **Stays out of the way** — a floating dock, a badge when work finishes while you're elsewhere

## Installation

```bash
npx claude-dock
```

Then paste an [Anthropic API key](https://console.anthropic.com/settings/keys) when Lore asks. That's the only setup.

### From source

```bash
git clone https://github.com/matthewmolinar/claude-dock.git
cd claude-dock
npm install
npm start
```

## Usage

Click an empty slot and start typing. A new session works in your home folder;
Shift-click a slot (or the folder name in its title bar) to point it somewhere
narrower. Lore reads, edits, and creates files there, and can run commands.

| Shortcut | Action |
|----------|--------|
| `Cmd+Option+T` | Show or hide the dock |
| `Cmd+Option+N` | New session |
| `Cmd+Option+M` | Hide all sessions |
| `Cmd+Option+R` | Reload the dock |
| `Option+Click` | Rename a session |
| `Shift+Click` | Point a session at a different folder |

In a session, `Enter` sends and `Shift+Enter` starts a new line. **Stop** interrupts
a run mid-thought.

### Session states

| Dot | Meaning |
|-----|---------|
| Gray, dashed slot | Empty — click to start |
| Green | Session is open |
| Amber, pulsing | The assistant is working |
| Blue | Hidden |
| Orange badge | It finished while you were elsewhere |

## The harness

Lore runs its own agent loop against the Claude API — no CLI in the middle.

- **Model** — `claude-opus-4-8` with adaptive thinking and `effort: high`, streamed.
- **Loop** — ask Claude, run any tools it requests, feed the results back, repeat until it stops asking. Capped at 50 round trips so a confused run can't spin forever.
- **Tools** — `list_files`, `read_file`, `edit_file`, `write_file`, `run_command`.
- **Scope** — a session starts in your home folder. Shift-click a slot to narrow it to one project.
- **Confinement** — every path a tool touches is resolved and checked against the session folder. `..`, absolute paths, and symlinks that escape the folder are all rejected. Commands run with the folder as their working directory and time out after 60 seconds.
- **Truncation** — tool output over 20,000 characters is cut, with a note saying how much was dropped.

Nothing is sent anywhere except Anthropic.

## Where your API key lives

`~/Library/Application Support/claude-dock/credentials.json`, owner-read-only (`0600`).

Lore deliberately does **not** use Electron's `safeStorage` / macOS Keychain. Because
the app runs on an unsigned Electron binary, the Keychain does not recognise it and
macOS prompts for "Electron Safe Storage" access on every launch — an unacceptable
first-run experience, and one denial silently breaks the app. A `0600` file in your
own home directory is the same protection the Anthropic SDK, the `ant` CLI, and
Claude Code give their credentials.

If a file in your home directory is not good enough for your threat model, don't
put a production key in it.

## Development

```bash
npm start        # run the app
npm run dev      # run in the foreground with logs
npm test         # unit + agent-loop tests (no network, no API key)
```

The agent tests stand up a local HTTP server that speaks Anthropic's SSE wire
format, so the whole tool loop is exercised without a key or a network call.

Architecture:

- `src/main/harness/` — the agent loop (`agent.js`) and its tools (`tools.js`)
- `src/main/` — windows, session state, the key store, IPC
- `src/preload/` — context-isolated bridges; renderers get no Node access
- `src/renderer/dock|session|settings/` — the three windows
- `src/shared/` — pure logic (layout math, labels, persisted state), unit tested

`electron` is a runtime dependency rather than a devDependency, so that
`npx claude-dock` can launch it. That is also why there is no `.dmg` build:
electron-builder refuses to package an app whose `dependencies` include electron.

## License

MIT License - see [LICENSE](LICENSE) for details.
