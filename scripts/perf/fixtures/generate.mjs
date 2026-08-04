import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'

import { parseGenerateArguments } from './cli-support.mjs'
import { generateFixtures } from './fixture-generator.mjs'

export async function main(argumentsList = process.argv.slice(2)) {
  const { force, outputDirectory } = parseGenerateArguments(argumentsList)
  const result = await generateFixtures({ force, outputDirectory })
  process.stdout.write(`Generated ${result.lock.files.length} fixtures in ${outputDirectory}\n`)
  return result
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(new URL(process.argv[1], `file://${process.cwd()}/`))
) {
  main().catch((error) => {
    process.stderr.write(`Fixture generation failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
