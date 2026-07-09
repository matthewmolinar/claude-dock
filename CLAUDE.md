# Lore

An Electron dock of AI assistant sessions for macOS, aimed at **non-technical
users**. Lore runs its own agent loop against the Claude API — it does not shell
out to Claude Code, Amp, or Codex, and there is no terminal anywhere in the UI.

## Layout
- `src/main/harness/agent.js` — the agent loop (stream → tool_use → execute → tool_result → repeat)
- `src/main/harness/tools.js` — the five tools + path confinement
- `src/main/` — `index.js` (lifecycle, IPC, hotkeys), `session-manager.js` (slots, transcripts), `windows.js`, `keystore.js`
- `src/preload/` — contextBridge APIs; renderers have no Node access
- `src/renderer/dock|session|settings/` — the three windows
- `src/shared/` — pure, unit-tested logic: layout math, slot labels, persisted store

## Dev Workflow
```bash
npm start      # run the app
npm run dev    # foreground + logs
npm test       # unit + agent-loop tests (hermetic — no key, no network)
```

## Product rules
- **The audience is not technical.** No terminal aesthetics, no jargon in UI copy,
  no raw paths or commands in the assistant's prose. Tool activity renders as
  plain-language chips ("Read groceries.txt"), collapsed by default.
- The system prompt in `agent.js` enforces the assistant's voice. Change it there,
  not by post-processing output.

## Gotchas
- **`safeStorage` is banned.** It hits the macOS Keychain, and on an unsigned
  Electron binary macOS prompts for "Electron Safe Storage" on every launch. The
  key lives in a `0600` `credentials.json` instead. Do not "improve" this.
- **`[hidden] { display: none !important }` is load-bearing.** An id rule with
  `display` outranks the `hidden` attribute's UA style, so `#needsKey` would never
  hide. Both `session.css` and `settings.css` carry the override.
- **Opus 4.8 rejects `budget_tokens`, `temperature`, `top_p`, `top_k`** with a 400.
  Use `thinking: {type:'adaptive'}` + `output_config.effort`. A test asserts this.
- **Echo the assistant turn back verbatim.** `response.content` (thinking and
  tool_use blocks included) must be appended unmodified, or the next request 400s.
- The dock window is `focusable: false` so it never steals focus. Inline rename
  temporarily flips it via the `dock:setFocusable` IPC.
- `electron` sits in `dependencies` (not `devDependencies`) so `npx claude-dock`
  can launch it. Consequence: electron-builder cannot package this app, so there
  is no `.dmg` target. Do not "fix" this by moving electron to devDependencies.

## Testing the agent without a key
`test/agent.test.js` starts a local HTTP server that emits Anthropic's SSE wire
format and points the SDK at it via `ANTHROPIC_BASE_URL`. This exercises the real
streaming parser, message shapes, and tool loop with no network and no API key.

## Commits
Conventional commits + semantic-release.
- `fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major
- `docs:`, `chore:`, `ci:`, `test:`, `refactor:` → no release

## Hotkeys
`⌘⌥T` toggle dock · `⌘⌥N` new session · `⌘⌥M` hide all · `⌘⌥R` reload dock
`⌥+Click` rename · `⇧+Click` change folder
