#!/usr/bin/env node
'use strict';

// Copy xterm's browser bundles next to the terminal renderer.
//
// The renderer loads them with plain <script src="vendor/...">, which means a
// path relative to src/renderer/terminal/. We cannot hardcode ../../node_modules
// because npm hoists dependencies to whichever node_modules dir it likes, so we
// resolve each file through require.resolve and copy it in.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'src', 'renderer', 'terminal', 'vendor');

const FILES = [
  '@xterm/xterm/lib/xterm.js',
  '@xterm/xterm/css/xterm.css',
  '@xterm/addon-fit/lib/addon-fit.js',
  '@xterm/addon-webgl/lib/addon-webgl.js',
  '@xterm/addon-web-links/lib/addon-web-links.js',
];

fs.mkdirSync(OUT, { recursive: true });

let copied = 0;
for (const spec of FILES) {
  let src;
  try {
    src = require.resolve(spec);
  } catch {
    console.error(`[vendor] cannot resolve ${spec} - is it installed?`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(OUT, path.basename(spec)));
  copied++;
}

console.log(`[vendor] copied ${copied} xterm asset(s) to ${path.relative(process.cwd(), OUT)}`);
