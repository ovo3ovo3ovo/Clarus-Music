import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'

import { parseVerifyArguments } from './cli-support.mjs'
import { verifyFixtureSet } from './fixture-verifier.mjs'

export async function main(argumentsList = process.argv.slice(2)) {
  const { directory } = parseVerifyArguments(argumentsList)
  const verified = await verifyFixtureSet({ directory })
  process.stdout.write(`Verified ${verified.filesByName.size} fixtures in ${directory}\n`)
  return verified
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(new URL(process.argv[1], `file://${process.cwd()}/`))
) {
  main().catch((error) => {
    process.stderr.write(`Fixture verification failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
