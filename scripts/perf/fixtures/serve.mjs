import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'

import { installGracefulShutdown, parseServeArguments } from './cli-support.mjs'
import { createFixtureRangeServer } from './range-server.mjs'

export async function main(argumentsList = process.argv.slice(2)) {
  const { directory, port } = parseServeArguments(argumentsList)
  const fixtureServer = await createFixtureRangeServer({ directory, port })
  const shutdown = installGracefulShutdown({
    close: fixtureServer.close,
    onClosed: () => {
      process.stdout.write('Fixture range server stopped\n')
    },
    onError: (error) => {
      process.stderr.write(`Fixture range server shutdown failed: ${error.message}\n`)
      process.exitCode = 1
    },
  })
  process.stdout.write(`Fixture range server listening at ${fixtureServer.baseUrl}\n`)
  return { fixtureServer, shutdown }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(new URL(process.argv[1], `file://${process.cwd()}/`))
) {
  main().catch((error) => {
    process.stderr.write(`Fixture range server failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
