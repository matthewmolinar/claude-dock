'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * The Anthropic API key, stored owner-read-only in the app's data directory.
 *
 * We deliberately do NOT use Electron's `safeStorage`. It backs onto the macOS
 * Keychain, and because the app is launched through an unsigned Electron binary
 * the Keychain does not recognise it — so macOS prompts the user to allow access
 * to "Electron Safe Storage" on every launch. That prompt is unacceptable for a
 * non-technical audience, and clicking "Deny" once silently breaks the app.
 *
 * A 0600 file in the user's own home directory is the same protection the
 * Anthropic SDK, the `ant` CLI, and Claude Code give their credentials.
 */
class KeyStore {
  constructor(file) {
    this.file = file || path.join(app.getPath('userData'), 'credentials.json');
  }

  has() {
    return Boolean(this.get());
  }

  get() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const key = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
      return key || null;
    } catch {
      return null;
    }
  }

  set(key) {
    const trimmed = (key || '').trim();
    if (!trimmed) {
      this.clear();
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Write-then-rename so an interrupted save cannot truncate the real file.
    // The temp file is created 0600 too — never briefly world-readable.
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ apiKey: trimmed }, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }

  clear() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }
}

module.exports = { KeyStore };
