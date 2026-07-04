import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

const shared = { alias: { '@shared': resolve(__dirname, 'src/shared') } }

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // Native module - keep it out of the bundle; loaded at runtime.
        external: ['@duckdb/node-api'],
      },
    },
    resolve: shared,
  },
  preload: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } },
    resolve: shared,
  },
  renderer: {
    root: 'src/renderer',
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    resolve: shared,
  },
})
