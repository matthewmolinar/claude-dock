'use strict';

/* globals Terminal, FitAddon, WebglAddon, WebLinksAddon */

// NOTE: the preload exposes `window.term`, so the xterm instance must not be
// called `term` — a top-level `const term` would collide and fail to parse.
const api = window.term;
const titleEl = document.getElementById('title');

const THEME = {
  background: '#0d0d0d',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#0d0d0d',
  selectionBackground: 'rgba(120, 170, 255, 0.32)',
  black: '#1c1c1c',
  red: '#ff6157',
  green: '#28c840',
  yellow: '#febc2e',
  blue: '#6ba6ff',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d0d0d0',
  brightBlack: '#6b6b6b',
  brightRed: '#ff8a80',
  brightGreen: '#63d97b',
  brightYellow: '#ffd479',
  brightBlue: '#9cc8ff',
  brightMagenta: '#dda3ec',
  brightCyan: '#84dbe4',
  brightWhite: '#ffffff',
};

const xterm = new Terminal({
  fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 10000,
  allowProposedApi: true,
  macOptionIsMeta: true,
  theme: THEME,
});

const fit = new FitAddon.FitAddon();
xterm.loadAddon(fit);
xterm.loadAddon(
  new WebLinksAddon.WebLinksAddon((_event, uri) => api.openExternal(uri))
);

xterm.open(document.getElementById('terminal'));

// WebGL is a large win on agent output, but it throws on some GPUs/VMs.
try {
  const webgl = new WebglAddon.WebglAddon();
  webgl.onContextLoss(() => webgl.dispose());
  xterm.loadAddon(webgl);
} catch {
  /* fall back to the DOM renderer */
}

// ---- window <-> pty plumbing ----------------------------------------------

api.onData((chunk) => {
  // Ack only after xterm has parsed the chunk. Main uses this to release
  // backpressure, so a `find /` cannot outrun the renderer.
  xterm.write(chunk, () => api.ack(chunk.length));
});

xterm.onData((data) => api.input(data));

xterm.onTitleChange((title) => {
  const clean = (title || '').trim();
  if (!clean) return;
  titleEl.textContent = clean;
  document.title = clean;
  api.setTitle(clean);
});

function sync() {
  try {
    fit.fit();
  } catch {
    return;
  }
  api.resize(xterm.cols, xterm.rows);
}

new ResizeObserver(sync).observe(document.getElementById('terminal'));

// The first fit runs before the terminal font has loaded, so cell metrics (and
// therefore cols/rows) are wrong until it does. Refit once it lands.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(sync);

// ---- keyboard --------------------------------------------------------------

xterm.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown' || !e.metaKey) return true;

  switch (e.key) {
    case 'c': {
      const sel = xterm.getSelection();
      if (sel) {
        api.copy(sel);
        return false; // handled; do not send ^C
      }
      return true;
    }
    case 'v':
      Promise.resolve(api.paste()).then((text) => text && xterm.paste(text));
      return false;
    case 'k':
      xterm.clear();
      return false;
    case 'a':
      xterm.selectAll();
      return false;
    default:
      return true;
  }
});

// ---- chrome ----------------------------------------------------------------

document.getElementById('close').addEventListener('click', () => api.closeWindow());
document.getElementById('min').addEventListener('click', () => api.minimizeWindow());
document.getElementById('zoom').addEventListener('click', () => api.zoomWindow());

window.addEventListener('focus', () => {
  document.body.classList.remove('blurred');
  xterm.focus();
});
window.addEventListener('blur', () => document.body.classList.add('blurred'));

if (!document.hasFocus()) document.body.classList.add('blurred');

// ---- boot ------------------------------------------------------------------

const initialLabel = api.cwd ? api.cwd.replace(/^\/Users\/[^/]+/, '~') : 'Terminal';
titleEl.textContent = initialLabel;
document.title = initialLabel;

sync();
xterm.focus();
api.ready();
