import { defineConfig } from 'electron-vite'

// Three build targets, mirroring the Lore desktop app's dock layout so the
// synced files work identically in both repos: the main process, one preload
// per window kind, and the three renderers.
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts' },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          dock: 'src/preload/dock.ts',
          session: 'src/preload/session.ts',
          settings: 'src/preload/settings.ts',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          dock: 'src/renderer/dock/index.html',
          session: 'src/renderer/session/index.html',
          settings: 'src/renderer/settings/index.html',
        },
      },
    },
  },
})
