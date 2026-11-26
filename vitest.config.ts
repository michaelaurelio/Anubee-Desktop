import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Node 25+ defines its own globalThis.localStorage, which is undefined unless
// --localstorage-file is given, and it shadows jsdom's Storage in
// `@vitest-environment jsdom` test files. Turn Node's off where the flag
// exists; older Node (no web storage, no flag) would reject it as a bad option.
const webstorageOff = process.allowedNodeEnvironmentFlags.has('--no-experimental-webstorage')
  ? ['--no-experimental-webstorage']
  : []

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'], execArgv: webstorageOff },
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
})
