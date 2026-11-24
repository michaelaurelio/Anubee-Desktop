#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './server.js'

async function main(): Promise<void> {
  await buildServer().connect(new StdioServerTransport())
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
