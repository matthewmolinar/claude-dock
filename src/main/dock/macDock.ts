/**
 * Move the *system* macOS Dock — a port of the original claude-dock
 * feature: `defaults write com.apple.dock orientation <side>` followed by
 * `killall Dock` to apply. The work-area change that follows fires
 * `display-metrics-changed`, so the strip repositions itself through the
 * existing listener with no extra wiring here.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  parseMacDockOrientation,
  type MacDockOrientation,
  type MoveMacDockResult,
} from '../../shared/dockMacDock'
import { dockLog } from './log'

const execFileAsync = promisify(execFile)

type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>

const defaultExec: Exec = (file, args) => execFileAsync(file, args)

export async function readMacDockOrientation(exec: Exec = defaultExec): Promise<MacDockOrientation> {
  try {
    const { stdout } = await exec('/usr/bin/defaults', ['read', 'com.apple.dock', 'orientation'])
    return parseMacDockOrientation(stdout)
  } catch {
    // Key absent on a fresh install — the system default is bottom.
    return parseMacDockOrientation(null)
  }
}

export async function setMacDockOrientation(
  orientation: MacDockOrientation,
  exec: Exec = defaultExec,
  platform: NodeJS.Platform = process.platform,
): Promise<MoveMacDockResult> {
  if (platform !== 'darwin') {
    return { ok: false, message: 'Only available on macOS.' }
  }
  try {
    await exec('/usr/bin/defaults', ['write', 'com.apple.dock', 'orientation', orientation])
    await exec('/usr/bin/killall', ['Dock'])
    dockLog.info('macos_dock_moved', { orientation })
    return { ok: true, orientation }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    dockLog.warn('macos_dock_move_failed', { message })
    return { ok: false, message: 'Could not move the macOS Dock.' }
  }
}
