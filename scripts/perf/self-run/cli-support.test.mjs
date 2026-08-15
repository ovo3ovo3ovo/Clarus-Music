import assert from 'node:assert/strict'
import test from 'node:test'

import { parseSelfRunArguments, SelfRunInputError } from './cli-support.mjs'

const ROOT = '/private/tmp/clarus-self-run-test'
const SELF_RUN_ROOT = `${ROOT}/artifacts/perf/self-runs`

test('self-run CLI defaults to a bounded unattended DFS run', () => {
  const options = parseSelfRunArguments([], {
    now: () => new Date('2026-08-08T12:34:56.789Z'),
    processId: 42,
    repositoryRoot: ROOT,
    selfRunRoot: SELF_RUN_ROOT,
  })
  assert.deepEqual(options, {
    appBundle: `${ROOT}/src-tauri/target/release/bundle/macos/Clarus Music.app`,
    fixtureDirectory: `${ROOT}/artifacts/perf/fixtures/current`,
    iterations: 50,
    output: `${SELF_RUN_ROOT}/2026-08-08_12-34-56-789-p42-artist-dfs`,
    recoverySeconds: 600,
    startupTimeoutSeconds: 90,
  })
})

test('self-run CLI accepts only bounded values and a scoped new output path', () => {
  const options = parseSelfRunArguments(
    [
      '--iterations',
      '100',
      '--recovery-seconds',
      '900',
      '--startup-timeout-seconds',
      '180',
      '--output',
      'artifacts/perf/self-runs/manual-r01',
    ],
    { repositoryRoot: ROOT, selfRunRoot: SELF_RUN_ROOT },
  )
  assert.equal(options.iterations, 100)
  assert.equal(options.recoverySeconds, 900)
  assert.equal(options.startupTimeoutSeconds, 180)
  assert.equal(options.output, `${SELF_RUN_ROOT}/manual-r01`)

  for (const argumentsList of [
    ['--iterations', '49'],
    ['--recovery-seconds', '599'],
    ['--recovery-seconds', '901'],
    ['--app-bundle', '/Applications/Clarus Music.app'],
    ['--output', `${ROOT}/outside`],
    ['--output', 'artifacts/perf/self-runs/../escape'],
    ['--iterations=50'],
    ['--iterations', '50', '--iterations', '51'],
    ['positional'],
  ]) {
    assert.throws(
      () =>
        parseSelfRunArguments(argumentsList, {
          repositoryRoot: ROOT,
          selfRunRoot: SELF_RUN_ROOT,
        }),
      SelfRunInputError,
    )
  }
})
