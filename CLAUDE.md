# Lore (claude-dock)

An Electron dock of AI assistant sessions for macOS, aimed at **non-technical
users**. Lore runs its own agent loop against the Claude API — it does not shell
out to Claude Code, Amp, or Codex, and there is no terminal anywhere in the UI.

TypeScript, built with electron-vite. The dock also ships embedded inside the
Lore desktop app (`tanagram/lore` `apps/desktop`).

## Synced with the Lore desktop app — read this first

`src/main/dock/`, `src/preload/`, `src/renderer/`, and `src/shared/` are the
**synced surface**: byte-identical with the copies in `tanagram/lore`
`apps/desktop/src`. The lore monorepo is the source of truth; changes there
arrive here as automated PRs. If you change these files here, the change must
be ported upstream or the next sync will overwrite it.

Repo-specific files (safe to edit freely): `src/main/index.ts` (standalone
lifecycle), `bin/cli.js`, `electron.vite.config.ts`, `package.json`, docs.

The synced surface must stay **host-agnostic**: no imports from outside these
directories except `electron`, `node:*`, and `@anthropic-ai/sdk`. Host hooks
(like Lore's transcript mirror) are injected via `registerDockWidget` options.

## Layout
- `src/main/dock/harness/agent.ts` — the agent loop (stream → tool_use → execute → tool_result → repeat)
- `src/main/dock/harness/tools.ts` — the five tools + path confinement
- `src/main/dock/` — `index.ts` (controller: IPC, hotkeys, visibility), `sessionManager.ts`, `windows.ts`, `keystore.ts`, `store.ts`
- `src/main/index.ts` — thin standalone lifecycle (single-instance, show dock, dispose)
- `src/preload/` — contextBridge APIs; renderers have no Node access
- `src/renderer/dock|session|settings/` — the three windows
- `src/shared/` — pure, unit-tested logic: layout math, slot labels, IPC contract, DTO types

## Dev Workflow
```bash
npm run dev        # electron-vite dev server with live reload
npm run build      # compile to out/
npm start          # run the built app (electron-vite preview)
npm test           # tsx --test: unit + agent-loop tests (hermetic — no key, no network)
npm run typecheck  # strict tsc
```

## Product rules
- **The audience is not technical.** No terminal aesthetics, no jargon in UI copy,
  no raw paths or commands in the assistant's prose. Tool activity renders as
  plain-language chips ("Read groceries.txt"), collapsed by default.
- The system prompt in `agent.ts` enforces the assistant's voice. Change it there,
  not by post-processing output.

## Gotchas
- **`safeStorage` is banned.** It hits the macOS Keychain, and on an unsigned
  Electron binary macOS prompts for "Electron Safe Storage" on every launch. The
  key lives in a `0600` `dock-credentials.json` instead. Do not "improve" this.
- **`[hidden] { display: none !important }` is load-bearing.** An id rule with
  `display` outranks the `hidden` attribute's UA style, so `#needsKey` would never
  hide. Both `session.css` and `settings.css` carry the override.
- **Opus 4.8 rejects `budget_tokens`, `temperature`, `top_p`, `top_k`** with a 400.
  Use `thinking: {type:'adaptive'}` + `output_config.effort`. A test asserts this.
- **Echo the assistant turn back verbatim.** `response.content` (thinking and
  tool_use blocks included) must be appended unmodified, or the next request 400s.
- The dock window is `focusable: false` so it never steals focus. Inline rename
  temporarily flips it via the SetFocusable IPC.
- `run_command` uses `/bin/zsh` on macOS and `/bin/sh` elsewhere (the app is
  macOS-only, but the hermetic tests also run on Linux CI).
- `electron` sits in `dependencies` (not `devDependencies`) so `npx claude-dock`
  can launch it; published tarballs ship the prebuilt `out/` via `prepack`.
  Consequence: electron-builder cannot package this app, so there is no `.dmg`
  target. Do not "fix" this by moving electron to devDependencies.

## Testing the agent without a key
`src/main/dock/harness/agent.test.ts` starts a local HTTP server that emits
Anthropic's SSE wire format and points the SDK at it via `ANTHROPIC_BASE_URL`.
This exercises the real streaming parser, message shapes, and tool loop with no
network and no API key.

## Commits
Conventional commits + semantic-release.
- `fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major
- `docs:`, `chore:`, `ci:`, `test:`, `refactor:` → no release

## Hotkeys
`⌘⌥T` toggle dock · `⌘⌥N` new session · `⌘⌥M` hide all · `⌘⌥R` reload dock
`⌥+Click` rename · `⇧+Click` change folder
