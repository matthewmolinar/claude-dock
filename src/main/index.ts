/**
 * Standalone app lifecycle. The dock IS the app: it shows at launch, closing
 * every session window leaves it alive, and quitting the app is the only way
 * out. All dock behavior lives in `./dock`, which is kept host-agnostic and
 * synced with the Lore desktop app's embedded copy.
 */
import { app } from 'electron'

import { disposeDockWidget, registerDockProtocolSchemes, registerDockWidget, showDock } from './dock'

// A second instance would fight the first over global hotkeys and the dock.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // The artifact:// scheme must be declared before the app is ready.
  registerDockProtocolSchemes()

  void app.whenReady().then(() => {
    registerDockWidget()
    showDock()

    app.on('activate', () => showDock())
  })

  app.on('second-instance', () => showDock())

  // The dock is the app. Registering any listener here suppresses Electron's
  // default quit-on-last-window, so closing every session leaves the dock alive.
  app.on('window-all-closed', () => {})

  app.on('will-quit', () => {
    disposeDockWidget()
  })
}
