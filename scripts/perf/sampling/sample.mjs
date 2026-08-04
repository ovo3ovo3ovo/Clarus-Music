import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

import { PerfInputError, parseSampleArguments } from './cli-support.mjs'
import { runExternalSampler } from './external-sampler.mjs'

export async function main(
  argumentsList = process.argv.slice(2),
  { sampler = runExternalSampler, write = (text) => process.stdout.write(text) } = {},
) {
  const options = parseSampleArguments(argumentsList)
  const result = await sampler(options)
  if (result.exitCode === 0) {
    write(`Wrote external measurement infrastructure output to ${result.outputPath}\n`)
  }
  return result
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], `file://${process.cwd()}/`))
) {
  main()
    .then((result) => {
      if (result.exitCode !== 0) {
        process.stderr.write(`Performance sampling stopped: ${result.report?.failure?.message ?? 'sampling failed'}\n`)
        process.exitCode = result.exitCode
      }
    })
    .catch((error) => {
      const exitCode = error instanceof PerfInputError ? 2 : 3
      process.stderr.write(`Performance sampling refused: ${error.message}\n`)
      process.exitCode = exitCode
    })
}
