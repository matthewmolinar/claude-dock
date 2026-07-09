#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
};

const log = (m) => console.log(m);
const error = (m) => console.log(`${colors.red}✗${colors.reset} ${m}`);

const APP_ROOT = path.join(__dirname, '..');

function shortcuts() {
  log('Shortcuts:');
  log(`  ${colors.dim}⌘⌥T${colors.reset}  Toggle dock`);
  log(`  ${colors.dim}⌘⌥N${colors.reset}  Add new terminal`);
  log(`  ${colors.dim}⌘⌥M${colors.reset}  Minimize all terminals`);
  log(`  ${colors.dim}⌘⌥R${colors.reset}  Reload dock`);
  log('');
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    log('');
    log(`${colors.blue}Claude Dock${colors.reset} - terminal dock for AI coding agents`);
    log('');
    log('Usage: claude-dock [options]');
    log('');
    log('Options:');
    log('  --dev     Run in the foreground and stream logs');
    log('  --help    Show this message');
    log('');
    shortcuts();
    return;
  }

  if (process.platform !== 'darwin') {
    error('Claude Dock only works on macOS');
    process.exit(1);
  }

  let electron;
  try {
    // The electron package's main export is the absolute path to its binary.
    electron = require('electron');
  } catch {
    electron = null;
  }

  if (typeof electron !== 'string') {
    error('Could not locate the Electron runtime.');
    log(`  Try reinstalling: ${colors.dim}npm install -g claude-dock${colors.reset}`);
    process.exit(1);
  }

  if (args.includes('--dev')) {
    const child = spawn(electron, [APP_ROOT, '--dev'], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  // Detach so the dock outlives the shell that launched it.
  const child = spawn(electron, [APP_ROOT], { detached: true, stdio: 'ignore' });
  child.unref();

  log('');
  log(`${colors.green}✓${colors.reset} Claude Dock is running.`);
  log('');
  shortcuts();
}

main();
