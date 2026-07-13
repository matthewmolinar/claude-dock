/**
 * The dock harness's Anthropic API key, stored owner-read-only at
 * `userData/dock-credentials.json`. Ported from claude-dock `keystore.js`.
 *
 * Deliberately NOT Electron's `safeStorage` (matches the rest of this app:
 * Lore's own session store also encrypts app-side specifically to avoid the
 * macOS confidential-storage Keychain prompt). A 0600 file in the user's own
 * home directory is the same protection the Anthropic SDK and Claude Code
 * give their credentials.
 *
 * This key is completely independent of Lore's WorkOS auth — it only powers
 * the dock's in-process agent harness.
 */
import fs from 'node:fs'
import path from 'node:path'

export class KeyStore {
  private file: string

  constructor(file: string) {
    this.file = file
  }

  has(): boolean {
    return Boolean(this.get())
  }

  get(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { apiKey?: unknown }
      const key = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
      return key || null
    } catch {
      return null
    }
  }

  set(key: string | null | undefined): void {
    const trimmed = (key || '').trim()
    if (!trimmed) {
      this.clear()
      return
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    // Write-then-rename so an interrupted save cannot truncate the real file.
    // The temp file is created 0600 too — never briefly world-readable.
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ apiKey: trimmed }, null, 2), { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, this.file)
  }

  clear(): void {
    try {
      fs.unlinkSync(this.file)
    } catch {
      /* already gone */
    }
  }
}
