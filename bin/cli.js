#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const HAMMERSPOON_DIR = path.join(process.env.HOME, '.hammerspoon');
const INIT_LUA_PATH = path.join(HAMMERSPOON_DIR, 'init.lua');
const BACKUP_PATH = path.join(HAMMERSPOON_DIR, 'init.lua.backup');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
};

function log(msg) {
  console.log(msg);
}

function success(msg) {
  console.log(`${colors.green}✓${colors.reset} ${msg}`);
}

function warn(msg) {
  console.log(`${colors.yellow}!${colors.reset} ${msg}`);
}

function info(msg) {
  console.log(`${colors.blue}→${colors.reset} ${msg}`);
}

function error(msg) {
  console.log(`${colors.red}✗${colors.reset} ${msg}`);
}

function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hammerspoonInstalled() {
  return fs.existsSync('/Applications/Hammerspoon.app');
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase());
    });
  });
}

async function installHammerspoon() {
  if (!commandExists('brew')) {
    error('Homebrew is required to install Hammerspoon.');
    log('  Install it from: https://brew.sh');
    process.exit(1);
  }

  info('Installing Hammerspoon via Homebrew...');
  try {
    execSync('brew install --cask hammerspoon', { stdio: 'inherit' });
    success('Hammerspoon installed');
  } catch (e) {
    error('Failed to install Hammerspoon');
    process.exit(1);
  }
}

function backupExistingConfig() {
  if (fs.existsSync(INIT_LUA_PATH)) {
    fs.copyFileSync(INIT_LUA_PATH, BACKUP_PATH);
    success(`Backed up existing config to ${colors.dim}${BACKUP_PATH}${colors.reset}`);
  }
}

function installConfig() {
  // Ensure .hammerspoon directory exists
  if (!fs.existsSync(HAMMERSPOON_DIR)) {
    fs.mkdirSync(HAMMERSPOON_DIR, { recursive: true });
  }

  // Copy init.lua from package
  const sourcePath = path.join(__dirname, '..', 'init.lua');
  fs.copyFileSync(sourcePath, INIT_LUA_PATH);
  success('Installed Claude Dock config');
}

function launchHammerspoon() {
  try {
    // Try to reload if already running
    execSync('hs -c "hs.reload()"', { stdio: 'ignore', timeout: 3000 });
    success('Reloaded Hammerspoon');
  } catch {
    // Not running, launch it
    info('Launching Hammerspoon...');
    spawn('open', ['-a', 'Hammerspoon'], { detached: true, stdio: 'ignore' }).unref();
    success('Hammerspoon launched');
  }
}

async function main() {
  log('');
  log(`${colors.blue}Claude Dock${colors.reset} - Terminal dock for Claude Code sessions`);
  log('');

  // Check platform
  if (process.platform !== 'darwin') {
    error('Claude Dock only works on macOS');
    process.exit(1);
  }

  // Check/install Hammerspoon
  if (!hammerspoonInstalled()) {
    warn('Hammerspoon is not installed');
    const answer = await prompt('  Install it now? (Y/n) ');
    if (answer === 'n' || answer === 'no') {
      log('');
      log('Install Hammerspoon manually:');
      log('  brew install --cask hammerspoon');
      log('');
      process.exit(0);
    }
    await installHammerspoon();
    log('');
  } else {
    success('Hammerspoon found');
  }

  // Backup and install config
  backupExistingConfig();
  installConfig();

  // Launch/reload Hammerspoon
  launchHammerspoon();

  // Final instructions
  log('');
  log(`${colors.yellow}Important:${colors.reset} Grant Accessibility permissions to Hammerspoon`);
  log(`  System Settings → Privacy & Security → Accessibility → Enable Hammerspoon`);
  log('');
  log(`${colors.green}Done!${colors.reset} Claude Dock is ready.`);
  log('');
  log(`Shortcuts:`);
  log(`  ${colors.dim}⌘⌥T${colors.reset}  Toggle dock`);
  log(`  ${colors.dim}⌘⌥N${colors.reset}  Add new terminal`);
  log(`  ${colors.dim}⌘⌥R${colors.reset}  Reload config`);
  log('');
}

main().catch((e) => {
  error(e.message);
  process.exit(1);
});
