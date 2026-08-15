#!/usr/bin/env node
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { parseSelfRunArguments } from './cli-support.mjs'
import { outputSummaryLine, runSelfDrivenPerformance } from './self-runner.mjs'

export async function main(argumentsList = process.argv.slice(2)) {
  const options = parseSelfRunArguments(argumentsList)
  const report = await runSelfDrivenPerformance(options)
  process.stdout.write(`${outputSummaryLine(report)}\n`)
  return report
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    if (error?.reportPath) process.stderr.write(`report=${error.reportPath}\n`)
    process.exitCode = 1
  })
}
