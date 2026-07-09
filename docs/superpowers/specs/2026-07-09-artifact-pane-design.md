# Artifact pane

2026-07-09 · approved by Matt

## What

A sixth harness tool, `show_artifact`, plus a split pane in the session window.
When the agent builds something visual — a dashboard, a chart, a poster — it
calls `show_artifact(path, title)` and the session window widens: conversation
on the left, rendered artifact on the right (Claude.ai Artifacts pattern).

Prior art checked: `ultraworkers/claw-code` is a terminal-only Rust CLI harness
with no artifact/preview concept; nothing to borrow.

## Decisions

- **Content source:** explicit agent tool only. No auto-preview of HTML writes.
- **Placement:** split pane inside the session window. No fourth window type.
- **Sharing:** out of scope for v1. The artifact is a self-contained file in the
  user's folder; share affordances come later.
- **Chat-first:** the pane exists only after the agent shows something. No empty
  artifact pane.
- **One artifact per session:** a new `show_artifact` replaces the current one.
  No gallery or history in v1.

## The tool (`src/main/harness/tools.js`)

- Input: `{ path, title }`. `path` is relative to the session folder and goes
  through the same confinement checks as every other tool (resolve, reject
  escapes/symlinks). `title` is a short human label.
- Accepted extensions in v1: `.html`, `.htm`, `.png`, `.jpg`, `.jpeg`, `.svg`,
  `.gif`. Wrong extension or missing file → tool error so the model corrects
  itself.
- Tool result tells the model the artifact is now visible to the user.
- A plain-language chip lands in the thread: "Showed *Team dashboard*".

## System prompt (`src/main/harness/agent.js`)

Add a paragraph: when the user asks for something visual, build it as a single
self-contained HTML file (inline CSS/JS, no CDNs or external requests) in the
session folder, then call `show_artifact`. Self-contained = renders offline in
the sandboxed pane and is the exact file the user can email to their team.

## Rendering (session window)

- A sandboxed `<iframe>` — `sandbox="allow-scripts"`, no `allow-same-origin`,
  no network — pointing at the file. Artifact JS runs; it cannot reach Node,
  the preload bridge, or the rest of the disk. Session CSP gains `frame-src`
  for local files; `default-src 'none'` stays for the app page itself.
- Pane header: artifact title + close button. Closing collapses the window
  back to chat width.
- Main process widens the window on open (bounded by the display work area)
  and restores it on close. Sizing math is a pure function in `src/shared/`.

## Live updates

No file watcher. The tool executor already sees every `write_file` /
`edit_file`; if one touches the currently-shown path, the pane reloads.

## Persistence

The shown artifact `{ path, title }` is stored with the session and restored
when the session reopens (only if the file still exists). Re-pointing the
session at a new folder clears it, same as the transcript.

## Errors

- Bad path / extension / missing file: tool error back to the model.
- Iframe load failure at render time: pane shows a plain-language fallback
  ("Couldn't display this file") instead of a blank frame.

## Testing (hermetic, no key, no network)

- `test/tools.test.js`: confinement, extension allowlist, missing file, happy
  path for `show_artifact`.
- `test/agent.test.js`: mock SSE turn that calls `show_artifact`; assert the
  tool result shape and the event emitted to the renderer; assert a later
  `write_file` to the shown path emits a reload.
- `src/shared/` sizing/label logic unit tested.
- One manual drive of the real UI against the mock server before PR.
