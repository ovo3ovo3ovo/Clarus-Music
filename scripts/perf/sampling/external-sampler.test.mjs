import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { setTimeout } from 'node:timers'
import test from 'node:test'

import {
  parseSampleArguments,
  resolveStrictChildPath,
  resolveStrictNoFollowChildPath,
} from './cli-support.mjs'
import {
  OUTPUT_LIMIT_BYTES,
  parseFootprintOutput,
  parseTopOutput,
  runExternalSampler,
  spawnFixedTool,
} from './external-sampler.mjs'
import { AFINFO_EXECUTABLE } from '../fixtures/fixture-verifier.mjs'
import { validateRunReport } from './report-schema.mjs'
import { main as sampleMain } from './sample.mjs'

const HASH = 'a'.repeat(64)
const COMMIT = 'b'.repeat(40)
const HELPER_PATHS = {
  'web-content': '/System/Library/Frameworks/WebKit.framework/WebContent',
  gpu: '/System/Library/Frameworks/WebKit.framework/GPU',
  networking: '/System/Library/Frameworks/WebKit.framework/Networking',
}

function metadata(overrides = {}) {
  return {
    scenario: 'idle',
    scenarioClass: 'runtime',
    runId: 'idle-r01',
    runIndex: 1,
    buildKind: 'release',
    coldWarm: 'warm',
    cacheState: 'hit',
    windowCssPx: { width: 1280, height: 800 },
    displayScale: 2,
    powerSource: 'ac',
    powerMode: 'normal',
    volume: 0.4,
    outputDevice: 'Built-in; $(must-not-run)',
    networkProfile: 'offline',
    settingsFixture: null,
    queueFixture: null,
    fixtureRoles: ['tone-short-mp3', 'word-timed-yrc'],
    notes: 'argv-only metacharacters: ; $() `',
    ...overrides,
  }
}

function lock() {
  return {
    schemaVersion: 2,
    recipeVersion: '2.0.0',
    files: [
      { role: 'tone-short-mp3', filename: 'tone-short-mp3.mp3', byteLength: 1, sha256: HASH },
      { role: 'word-timed-yrc', filename: 'word-timed-yrc.yrc', byteLength: 1, sha256: HASH },
    ],
  }
}

function topOutput() {
  return Array.from({ length: 6 }, (_, sample) =>
    [
      'PID CPU% TH',
      `4101 ${sample === 0 ? 99 : sample}% ${10 + sample}`,
      `4102 ${sample === 0 ? 99 : sample + 1}% ${20 + sample}`,
      `4103 ${sample === 0 ? 99 : sample + 2}% ${30 + sample}`,
      `4104 ${sample === 0 ? 99 : sample + 3}% ${40 + sample}`,
    ].join('\n'),
  ).join('\n\n')
}

function attribution() {
  const mainPath = '/private/release/Clarus Music.app/Contents/MacOS/simplemusic'
  const records = [
    { role: 'main', pid: 4101, start: '1', path: mainPath, realpath: mainPath },
    {
      role: 'web-content',
      pid: 4102,
      start: '2',
      path: HELPER_PATHS['web-content'],
      realpath: HELPER_PATHS['web-content'],
    },
    { role: 'gpu', pid: 4103, start: '3', path: HELPER_PATHS.gpu, realpath: HELPER_PATHS.gpu },
    {
      role: 'networking',
      pid: 4104,
      start: '4',
      path: HELPER_PATHS.networking,
      realpath: HELPER_PATHS.networking,
    },
  ]
  return {
    method: 'launchservices-coalition',
    rootPid: 4101,
    coalition: { id: '17', asn: '0x17' },
    preSnapshot: records.map(({ pid, start, path, realpath }) => ({ pid, ppid: 1, start, path, realpath })),
    postSnapshot: records.map(({ pid, start, path, realpath }) => ({ pid, ppid: 1, start, path, realpath })),
    selected: records,
    unselected: [],
  }
}

function fakeToolChild({ exitOnSigkill = true } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kills = []
  let exited = false
  let resolveSigkill
  child.sigkill = new Promise((resolvePromise) => {
    resolveSigkill = resolvePromise
  })
  child.exit = () => {
    if (!exited) {
      exited = true
      child.emit('exit', null, 'SIGKILL')
      child.emit('close', null, 'SIGKILL')
    }
  }
  child.kill = (signal) => {
    child.kills.push(signal)
    if (signal === 'SIGTERM') {
      child.killed = true
    }
    if (signal === 'SIGKILL') {
      resolveSigkill()
      if (exitOnSigkill) {
        Promise.resolve().then(() => child.exit())
      }
    }
    return true
  }
  return child
}

async function createHarness({
  afterLock = lock(),
  fixtureLocks,
  metadataValue = metadata(),
  onCommand,
  signalSource = new EventEmitter(),
} = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'clarus-sampler-test-'))
  const repositoryRoot = join(temporary, 'repo with spaces')
  const runsRoot = join(repositoryRoot, 'artifacts', 'perf', 'runs')
  const fixtureDirectory = join(repositoryRoot, 'artifacts', 'perf', 'fixtures', 'current')
  const metadataPath = join(repositoryRoot, 'artifacts', 'perf', 'metadata', 'idle-r01.json')
  const output = join(runsRoot, 'idle-r01')
  const appBundlePath = join(
    repositoryRoot,
    'src-tauri',
    'target',
    'release',
    'bundle',
    'macos',
    'Clarus Music.app',
  )
  await mkdir(fixtureDirectory, { recursive: true })
  await mkdir(join(repositoryRoot, 'artifacts', 'perf', 'metadata'), { recursive: true })
  await writeFile(metadataPath, JSON.stringify(metadataValue))
  await writeFile(join(fixtureDirectory, 'fixtures.lock.json'), JSON.stringify(lock()))
  const calls = []
  let fixtureCalls = 0
  let fixtureCloses = 0
  const revalidationLabels = []
  const fixtureVerifier = async () => {
    fixtureCalls += 1
    const fixtureLock =
      fixtureLocks?.[Math.min(fixtureCalls - 1, fixtureLocks.length - 1)] ??
      (fixtureCalls === 1 ? lock() : afterLock)
    return {
      close: async () => {
        fixtureCloses += 1
      },
      directory: fixtureDirectory,
      lock: fixtureLock,
      manifest: { schemaVersion: 2, generatorVersion: '2.0.0' },
      filesByName: new Map(),
    }
  }
  const options = parseSampleArguments([
    '--app-bundle',
    appBundlePath,
    '--root-pid',
    '4101',
    '--fixture-directory',
    fixtureDirectory,
    '--metadata',
    metadataPath,
    '--output',
    output,
    '--samples',
    '5',
    '--interval-ms',
    '250',
    '--stack-duration-seconds',
    '1',
    '--stack-interval-ms',
    '1',
  ])
  options.metadata = relative(repositoryRoot, metadataPath)
  const runner = async (file, argv, options) => {
    calls.push({ file, argv, options })
    if (onCommand) {
      const custom = await onCommand(file, argv, options, calls)
      if (custom) {
        return custom
      }
    }
    if (file === '/usr/bin/top') {
      return { exitCode: 0, stdout: topOutput(), stderr: '' }
    }
    if (file === '/usr/bin/footprint') {
      const pid = Number(argv.at(-1))
      return {
        exitCode: 0,
        stdout: `Physical footprint: ${pid}\nPhysical footprint (peak): ${pid + 10}\n`,
        stderr: '',
      }
    }
    if (file === '/usr/bin/sample') {
      return { exitCode: 0, stdout: `sample ${argv[0]}`, stderr: '' }
    }
    throw new Error(`unexpected executable ${file}`)
  }
  const dependencies = {
    repositoryRoot,
    roots: { runsRoot },
    platform: 'darwin',
    signalSource,
    commandRunner: runner,
    fixtureVerifier,
    toolAvailable: async () => true,
    readBundle: async () => ({
      appBundlePath,
      expectedBundlePath: appBundlePath,
      executablePath: `${appBundlePath}/Contents/MacOS/simplemusic`,
      executableRealpath: `${appBundlePath}/Contents/MacOS/simplemusic`,
      bundleId: 'com.ovo3ovo3ovo.clarusmusic',
      bundleVersion: '0.1.0',
      executableSha256: HASH,
    }),
    captureAttribution: async () => attribution(),
    revalidateAttribution: async ({ baseline, label }) => {
      revalidationLabels.push(label)
      return baseline
    },
    readGit: async () => ({ commit: COMMIT, dirty: false }),
    readHost: async () => ({
      platform: 'darwin',
      osVersion: '14.0',
      osBuild: '23A1',
      arch: 'arm64',
      nodeVersion: 'v26.5.0',
      timezone: 'UTC',
      cpu: { model: null, cores: null },
      memoryBytes: null,
    }),
    now: (() => {
      let tick = 0
      return () => new Date(Date.UTC(2026, 7, 5, 0, 0, tick++)).toISOString()
    })(),
  }
  return {
    temporary,
    repositoryRoot,
    calls,
    dependencies,
    fixtureCalls: () => fixtureCalls,
    fixtureCloses: () => fixtureCloses,
    options,
    output,
    metadataPath,
    appBundlePath,
    revalidationLabels,
    signalSource,
  }
}

test('sample CLI rejects unknown, duplicate, positional, equals, invalid number, and unsafe output forms', () => {
  const valid = parseSampleArguments([
    '--app-bundle',
    'src-tauri/target/release/bundle/macos/Clarus Music.app',
    '--root-pid',
    '12345',
    '--fixture-directory',
    'artifacts/perf/fixtures/current',
    '--metadata',
    'artifacts/perf/metadata/idle-r01.json',
    '--output',
    'artifacts/perf/runs/idle-r01',
    '--samples',
    '5',
    '--interval-ms',
    '250',
  ])
  assert.equal(valid.stackDurationSeconds, 0)
  assert.equal(valid.stackIntervalMs, 1)
  for (const argumentsList of [
    [...valid.rawArguments, '--unknown', 'x'],
    [...valid.rawArguments, '--samples', '5'],
    [...valid.rawArguments, 'positional'],
    [...valid.rawArguments.slice(0, 2), '--root-pid=2', ...valid.rawArguments.slice(2)],
  ]) {
    assert.throws(() => parseSampleArguments(argumentsList), /option|duplicate|positional|equals|key=value/i)
  }
  assert.throws(() => parseSampleArguments([...valid.rawArguments, '--root-pid', '1']), /duplicate/i)
  const emptyBundle = [...valid.rawArguments]
  emptyBundle[1] = ''
  assert.throws(() => parseSampleArguments(emptyBundle), /requires a value/i)
  assert.throws(() => parseSampleArguments(valid.rawArguments.slice(0, -1)), /requires a value/i)
  assert.throws(
    () =>
      parseSampleArguments([
        '--app-bundle', 'a', '--root-pid', '2', '--fixture-directory', 'f', '--metadata', 'm', '--output', 'o',
        '--samples', '3600', '--interval-ms', '60000',
      ]),
    /3600000/i,
  )
  assert.throws(
    () => resolveStrictChildPath('../outside', { root: '/tmp/perf/runs', repositoryRoot: '/tmp/perf' }),
    /traversal|strict child/i,
  )
})

test('strict no-follow child paths ignore symlinked prefixes outside the repository but reject internal symlinked parents', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'clarus-cli-support-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))

  const realRepositoryRoot = join(temporary, 'real-repository')
  const repositoryRoot = join(temporary, 'repository-link')
  await mkdir(realRepositoryRoot)
  await symlink(realRepositoryRoot, repositoryRoot)

  const normalPath = await resolveStrictNoFollowChildPath('metadata.json', {
    root: repositoryRoot,
    repositoryRoot,
  })
  assert.equal(normalPath, join(repositoryRoot, 'metadata.json'))

  await symlink(realRepositoryRoot, join(realRepositoryRoot, 'linked-parent'))
  await assert.rejects(
    resolveStrictNoFollowChildPath('linked-parent/metadata.json', {
      root: repositoryRoot,
      repositoryRoot,
    }),
    /symbolic link components/i,
  )
})

test('metadata paths must stay under the repository without absolute, traversal, or parent symlink paths', async (t) => {
  const absoluteHarness = await createHarness()
  t.after(() => rm(absoluteHarness.temporary, { recursive: true, force: true }))
  const absoluteMetadata = join(absoluteHarness.temporary, 'absolute-metadata.json')
  await writeFile(absoluteMetadata, JSON.stringify(metadata()))
  absoluteHarness.options.metadata = absoluteMetadata
  const absoluteResult = await runExternalSampler(absoluteHarness.options, absoluteHarness.dependencies)
  assert.equal(absoluteResult.exitCode, 2)

  const traversalHarness = await createHarness()
  t.after(() => rm(traversalHarness.temporary, { recursive: true, force: true }))
  const traversalMetadata = join(traversalHarness.temporary, 'traversal-metadata.json')
  await writeFile(traversalMetadata, JSON.stringify(metadata()))
  traversalHarness.options.metadata = '../traversal-metadata.json'
  const traversalResult = await runExternalSampler(traversalHarness.options, traversalHarness.dependencies)
  assert.equal(traversalResult.exitCode, 2)

  const symlinkHarness = await createHarness()
  t.after(() => rm(symlinkHarness.temporary, { recursive: true, force: true }))
  const outsideDirectory = join(symlinkHarness.temporary, 'outside-metadata')
  await mkdir(outsideDirectory)
  await writeFile(join(outsideDirectory, 'metadata.json'), JSON.stringify(metadata()))
  await symlink(
    outsideDirectory,
    join(symlinkHarness.repositoryRoot, 'artifacts', 'perf', 'metadata', 'linked-parent'),
  )
  symlinkHarness.options.metadata = 'artifacts/perf/metadata/linked-parent/metadata.json'
  const symlinkResult = await runExternalSampler(symlinkHarness.options, symlinkHarness.dependencies)
  assert.equal(symlinkResult.exitCode, 2)
})

test('top and footprint parsers require complete fixed-PID numeric evidence and discard no data themselves', () => {
  const groups = parseTopOutput(topOutput(), { pids: [4101, 4102, 4103, 4104] })
  assert.equal(groups.length, 6)
  assert.equal(groups[0].get(4101).cpuPercent, 99)
  assert.equal(groups[1].get(4101).threadCount, 11)
  assert.deepEqual(parseFootprintOutput('Physical footprint: 10\nPhysical footprint (peak): 20\n'), {
    physicalFootprintBytes: 10,
    physicalFootprintPeakBytes: 20,
  })
  assert.throws(() => parseTopOutput('PID CPU% TH\n4101 1% 1', { pids: [4101, 4102] }), /missing/i)
  assert.throws(() => parseFootprintOutput('Physical footprint: 10'), /peak/i)
  assert.throws(
    () => parseTopOutput(`${topOutput()}\noutput truncated`, { pids: [4101, 4102, 4103, 4104] }),
    /truncat/i,
  )
})

test('fixed tool termination waits for an actual exit before escalating and cleans listeners', async () => {
  const child = fakeToolChild()
  let spawned = false
  const result = await spawnFixedTool('/usr/bin/git', ['--version'], {
    timeoutMs: 1,
    terminationGraceMs: 0,
    spawnProcess: () => {
      spawned = true
      return child
    },
  })

  assert.equal(spawned, true)
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(result.signal, 'SIGKILL')
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
})

test('fixed tool output collection remains bounded while terminating an over-limit child', async () => {
  const child = fakeToolChild()
  const resultPromise = spawnFixedTool('/usr/bin/git', ['--version'], {
    timeoutMs: 1000,
    terminationGraceMs: 0,
    outputLimits: { stdout: 4, stderr: 4, total: 6 },
    spawnProcess: () => {
      Promise.resolve().then(() => child.stdout.emit('data', Buffer.from('abcdef')))
      return child
    },
  })

  const result = await resultPromise
  assert.equal(result.outputLimited, true)
  assert.deepEqual(result.stdout, Buffer.from('abcd'))
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
})

test('sampler awaits active tool child exits before returning a failed result', async (t) => {
  const harness = await createHarness()
  t.after(() => rm(harness.temporary, { recursive: true, force: true }))
  const child = fakeToolChild({ exitOnSigkill: false })
  const commandRunner = harness.dependencies.commandRunner
  let childRun
  harness.dependencies.terminationGraceMs = 0
  harness.dependencies.commandRunner = async (file, argv, options) => {
    if (file === '/usr/bin/top') {
      childRun = spawnFixedTool('/usr/bin/git', ['--version'], {
        activeChildren: options.activeChildren,
        spawnProcess: () => child,
        terminationGraceMs: 0,
        timeoutMs: 1000,
      })
      return { exitCode: 1, stdout: '', stderr: 'top failed' }
    }
    return commandRunner(file, argv, options)
  }

  let samplerReturned = false
  const sampler = runExternalSampler(harness.options, harness.dependencies).then((result) => {
    samplerReturned = true
    return result
  })
  await child.sigkill
  try {
    assert.equal(samplerReturned, false)
  } finally {
    child.exit()
  }
  const result = await sampler
  assert.equal(result.exitCode, 3)
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
  await childRun
})

test('sampler registers fixture verifier children and waits for their signal cleanup', async (t) => {
  const harness = await createHarness()
  t.after(() => rm(harness.temporary, { recursive: true, force: true }))
  const child = fakeToolChild({ exitOnSigkill: false })
  let observedActiveChildren
  let spawned = false
  harness.dependencies.terminationGraceMs = 0
  harness.dependencies.spawnProcess = () => {
    spawned = true
    return child
  }
  harness.dependencies.fixtureVerifier = async ({ activeChildren, run }) => {
    observedActiveChildren = activeChildren
    const running = run(AFINFO_EXECUTABLE, ['/tmp/fixture.mp3'], { timeout: 1000 })
    harness.signalSource.emit('SIGINT')
    const result = await running
    assert.equal(result.signal, 'SIGKILL')
    throw new Error('fixture verifier interrupted')
  }

  const sampler = runExternalSampler(harness.options, harness.dependencies)
  const killObserved = await Promise.race([
    child.sigkill.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250)),
  ])
  assert.equal(spawned, true)
  assert.equal(killObserved, true)
  assert.equal(observedActiveChildren.has(child), true)
  assert.equal(child.kills[0], 'SIGTERM')
  assert.equal(child.kills[1], 'SIGKILL')
  let samplerReturned = false
  const observedResult = sampler.then((result) => {
    samplerReturned = true
    return result
  })
  assert.equal(samplerReturned, false)
  child.exit()
  const result = await observedResult
  assert.equal(result.exitCode, 130)
  assert.equal(result.report.status, 'interrupted')
  assert.equal(observedActiveChildren.size, 0)
})

test('runs deterministic external sampling with fixture verification, warmup removal, fixed argv, raw evidence, and raw-only stacks', async (t) => {
  const harness = await createHarness()
  t.after(() => rm(harness.temporary, { recursive: true, force: true }))
  harness.options.appBundle = relative(harness.repositoryRoot, harness.appBundlePath)
  harness.options.metadata = relative(harness.repositoryRoot, harness.metadataPath)
  const result = await runExternalSampler(harness.options, harness.dependencies)
  assert.equal(result.exitCode, 0)
  assert.equal(harness.fixtureCalls(), 3)
  assert.equal(harness.fixtureCloses(), 3)
  assert.deepEqual(harness.revalidationLabels, [
    'before-numeric',
    'between-top-footprint',
    'between-footprint-stack',
    'after',
  ])
  const topCall = harness.calls.find((call) => call.file === '/usr/bin/top')
  assert.deepEqual(topCall.argv, [
    '-l', '6', '-s', '0.25', '-stats', 'pid,cpu,threads', '-pid', '4101,4102,4103,4104',
  ])
  for (const call of harness.calls) {
    assert.equal(call.options.shell, false)
    assert.deepEqual(call.options.env, { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' })
  }
  const footprintCalls = harness.calls.filter((call) => call.file === '/usr/bin/footprint')
  assert.equal(footprintCalls.length, 20)
  assert.deepEqual(footprintCalls[0].argv, ['--format', 'bytes', '-p', '4101'])
  assert.deepEqual(
    harness.calls.filter((call) => call.file === '/usr/bin/sample').map((call) => call.argv[0]),
    ['4101', '4102'],
  )
  const report = JSON.parse(await readFile(join(harness.output, 'run.json'), 'utf8'))
  validateRunReport(report)
  assert.equal(report.status, 'completed')
  assert.equal(report.measurements.filter((entry) => entry.phase === 'top').length, 40)
  assert.equal(report.measurements.find((entry) => entry.phase === 'top' && entry.sampleIndex === 0 && entry.pid === 4101).value, 1)
  assert.equal(report.measurements.filter((entry) => entry.role === 'process-total').length, 5)
  assert.match(await readFile(join(harness.output, 'summary.txt'), 'utf8'), /^MEASUREMENT INFRASTRUCTURE OUTPUT — NOT EVIDENCE OF PRODUCT IMPROVEMENT\./)
  assert.match(await readFile(join(harness.output, 'measurements.csv'), 'utf8'), /^schema_version,run_id,scenario,run_index,sample_index,/)
  assert.match(await readFile(join(harness.output, 'raw', 'sample-main.stdout.txt'), 'utf8'), /sample 4101/)
})

test('sampling and fixture-drift failures retain partial raw evidence and are unusable', async (t) => {
  const failedHarness = await createHarness({
    onCommand: async (file) =>
      file === '/usr/bin/top' ? { exitCode: 1, stdout: 'partial top', stderr: 'denied' } : undefined,
  })
  t.after(() => rm(failedHarness.temporary, { recursive: true, force: true }))
  const failed = await runExternalSampler(failedHarness.options, failedHarness.dependencies)
  assert.equal(failed.exitCode, 3)
  const failedReport = JSON.parse(await readFile(join(failedHarness.output, 'run.json'), 'utf8'))
  assert.equal(failedReport.usable, false)
  assert.equal(failedReport.status, 'failed')
  assert.match(await readFile(join(failedHarness.output, 'raw', 'top.stdout.txt'), 'utf8'), /partial top/)

  const driftHarness = await createHarness({ afterLock: { ...lock(), recipeVersion: 'changed' } })
  t.after(() => rm(driftHarness.temporary, { recursive: true, force: true }))
  const drift = await runExternalSampler(driftHarness.options, driftHarness.dependencies)
  assert.equal(drift.exitCode, 3)
  const driftReport = JSON.parse(await readFile(join(driftHarness.output, 'run.json'), 'utf8'))
  assert.equal(driftReport.failure.code, 'FIXTURE_DRIFT')
})

test('invalid metadata inputs emit schema-valid exit-2 unusable returned and on-disk reports', async (t) => {
  const invalidSchemaHarness = await createHarness({
    metadataValue: metadata({ buildKind: 'debug' }),
  })
  t.after(() => rm(invalidSchemaHarness.temporary, { recursive: true, force: true }))

  const invalidSchema = await runExternalSampler(
    invalidSchemaHarness.options,
    invalidSchemaHarness.dependencies,
  )

  assert.equal(invalidSchema.exitCode, 2)
  assert.equal(invalidSchema.report.failure.code, 'INPUT_REFUSAL')
  assert.doesNotThrow(() => validateRunReport(invalidSchema.report))

  const harness = await createHarness({
    metadataValue: metadata({ fixtureRoles: ['unknown-fixture-role'] }),
  })
  t.after(() => rm(harness.temporary, { recursive: true, force: true }))

  const result = await runExternalSampler(harness.options, harness.dependencies)

  assert.equal(result.exitCode, 2)
  assert.equal(result.report.status, 'failed')
  assert.equal(result.report.usable, false)
  assert.equal(result.report.failure.code, 'INPUT_REFUSAL')
  assert.doesNotThrow(() => validateRunReport(result.report))
  const emitted = JSON.parse(await readFile(join(harness.output, 'run.json'), 'utf8'))
  assert.equal(emitted.status, 'failed')
  assert.equal(emitted.usable, false)
  assert.doesNotThrow(() => validateRunReport(emitted))
})

test('pre-top fixture verification stops changed-then-restored fixture drift before numeric sampling', async (t) => {
  const harness = await createHarness({
    fixtureLocks: [lock(), { ...lock(), recipeVersion: 'changed-before-top' }, lock()],
  })
  t.after(() => rm(harness.temporary, { recursive: true, force: true }))

  const result = await runExternalSampler(harness.options, harness.dependencies)

  assert.equal(result.exitCode, 3)
  assert.equal(result.report.failure.code, 'FIXTURE_DRIFT')
  assert.equal(harness.fixtureCalls(), 2)
  assert.equal(harness.calls.some((call) => call.file === '/usr/bin/top'), false)
})

test('a signal after before-numeric attribution stops pre-top fixture work from being scheduled', async (t) => {
  const harness = await createHarness()
  t.after(() => rm(harness.temporary, { recursive: true, force: true }))
  const revalidateAttribution = harness.dependencies.revalidateAttribution
  harness.dependencies.revalidateAttribution = async ({ baseline, label }) => {
    const result = await revalidateAttribution({ baseline, label })
    if (label === 'before-numeric') {
      harness.signalSource.emit('SIGTERM')
    }
    return result
  }

  const result = await runExternalSampler(harness.options, harness.dependencies)

  assert.equal(result.exitCode, 143)
  assert.equal(result.report.status, 'interrupted')
  assert.equal(harness.fixtureCalls(), 1)
  assert.equal(harness.calls.some((call) => call.file === '/usr/bin/top'), false)
})

test('fails closed for unavailable tools, permission denial, parser drift, and attribution drift', async (t) => {
  const optionalSampleHarness = await createHarness()
  t.after(() => rm(optionalSampleHarness.temporary, { recursive: true, force: true }))
  optionalSampleHarness.options.stackDurationSeconds = 0
  optionalSampleHarness.dependencies.toolAvailable = async (pathname) =>
    pathname !== '/usr/bin/sample'
  const optionalSample = await runExternalSampler(
    optionalSampleHarness.options,
    optionalSampleHarness.dependencies,
  )
  assert.equal(optionalSample.exitCode, 0)
  assert.deepEqual(
    optionalSample.report.tools.find((tool) => tool.name === 'sample'),
    {
      name: 'sample',
      path: '/usr/bin/sample',
      requested: false,
      available: false,
    },
  )
  assert.equal(
    optionalSampleHarness.calls.some((call) => call.file === '/usr/bin/sample'),
    false,
  )

  const unavailableHarness = await createHarness()
  t.after(() => rm(unavailableHarness.temporary, { recursive: true, force: true }))
  unavailableHarness.dependencies.toolAvailable = async (pathname) => pathname !== '/usr/bin/top'
  const unavailable = await runExternalSampler(unavailableHarness.options, unavailableHarness.dependencies)
  assert.equal(unavailable.exitCode, 3)
  assert.equal(unavailable.report.failure.code, 'TOOL_UNAVAILABLE')
  assert.doesNotThrow(() => validateRunReport(unavailable.report))
  const unavailableRun = JSON.parse(await readFile(join(unavailableHarness.output, 'run.json'), 'utf8'))
  assert.doesNotThrow(() => validateRunReport(unavailableRun))
  assert.deepEqual(unavailableRun.failure, unavailable.report.failure)

  const permissionHarness = await createHarness({
    onCommand: async (file) =>
      file === '/usr/bin/top'
        ? { exitCode: 1, stdout: '', stderr: 'Operation not permitted' }
        : undefined,
  })
  t.after(() => rm(permissionHarness.temporary, { recursive: true, force: true }))
  const permission = await runExternalSampler(permissionHarness.options, permissionHarness.dependencies)
  assert.equal(permission.exitCode, 3)
  assert.equal(permission.report.failure.code, 'PERMISSION_DENIED')

  const parserHarness = await createHarness({
    onCommand: async (file) =>
      file === '/usr/bin/top' ? { exitCode: 0, stdout: 'PID CPU% TH\n4101 1% 1', stderr: '' } : undefined,
  })
  t.after(() => rm(parserHarness.temporary, { recursive: true, force: true }))
  const parser = await runExternalSampler(parserHarness.options, parserHarness.dependencies)
  assert.equal(parser.exitCode, 3)
  assert.equal(parser.report.failure.code, 'PARSE_FAILURE')

  const attributionHarness = await createHarness()
  t.after(() => rm(attributionHarness.temporary, { recursive: true, force: true }))
  attributionHarness.dependencies.revalidateAttribution = async ({ baseline, label }) => {
    if (label !== 'between-top-footprint') {
      return baseline
    }
    return {
      ...baseline,
      selected: baseline.selected.map((entry) =>
        entry.role === 'web-content' ? { ...entry, pid: 9999 } : entry,
      ),
    }
  }
  const attributionDrift = await runExternalSampler(
    attributionHarness.options,
    attributionHarness.dependencies,
  )
  assert.equal(attributionDrift.exitCode, 3)
  assert.equal(attributionDrift.report.failure.code, 'ATTRIBUTION_DRIFT')
})

test('timeout, output limit, and signals stop scheduling without signaling an attributed target', async (t) => {
  const timeoutHarness = await createHarness({
    onCommand: async (file) =>
      file === '/usr/bin/top' ? { exitCode: null, timedOut: true, stdout: 'partial', stderr: '' } : undefined,
  })
  t.after(() => rm(timeoutHarness.temporary, { recursive: true, force: true }))
  const timeout = await runExternalSampler(timeoutHarness.options, timeoutHarness.dependencies)
  assert.equal(timeout.exitCode, 3)
  assert.equal(timeout.report.failure.code, 'TIMEOUT')

  const limitHarness = await createHarness({
    onCommand: async (file) =>
      file === '/usr/bin/top'
        ? { exitCode: 0, stdout: 'x'.repeat(OUTPUT_LIMIT_BYTES.stdout + 1), stderr: '' }
        : undefined,
  })
  t.after(() => rm(limitHarness.temporary, { recursive: true, force: true }))
  const limit = await runExternalSampler(limitHarness.options, limitHarness.dependencies)
  assert.equal(limit.exitCode, 3)
  assert.equal(limit.report.failure.code, 'OUTPUT_LIMIT')

  const aggregateHarness = await createHarness({
    onCommand: async (file) =>
      file === '/usr/bin/top' ? { exitCode: 0, stdout: '12345678901', stderr: '' } : undefined,
  })
  aggregateHarness.dependencies.outputLimits = { stdout: 1024, stderr: 1024, total: 10 }
  t.after(() => rm(aggregateHarness.temporary, { recursive: true, force: true }))
  const aggregate = await runExternalSampler(aggregateHarness.options, aggregateHarness.dependencies)
  assert.equal(aggregate.exitCode, 3)
  assert.equal(aggregate.report.failure.code, 'OUTPUT_LIMIT')
  assert.equal(
    (await readFile(join(aggregateHarness.output, 'raw', 'top.stdout.txt'))).byteLength,
    10,
  )

  const signals = new EventEmitter()
  const signalHarness = await createHarness({
    signalSource: signals,
    onCommand: async (file) => {
      if (file === '/usr/bin/top') {
        signals.emit('SIGINT')
        return { exitCode: null, signal: 'SIGTERM', stdout: 'partial', stderr: '' }
      }
      return undefined
    },
  })
  t.after(() => rm(signalHarness.temporary, { recursive: true, force: true }))
  const interrupted = await runExternalSampler(signalHarness.options, signalHarness.dependencies)
  assert.equal(interrupted.exitCode, 130)
  assert.equal(interrupted.report.status, 'interrupted')
  assert.ok(signalHarness.calls.every((call) => call.file !== '/bin/kill'))
})

test('a signal observed during final closeout cannot return a completed usable report', async (t) => {
  const harness = await createHarness()
  t.after(() => rm(harness.temporary, { recursive: true, force: true }))
  const revalidateAttribution = harness.dependencies.revalidateAttribution
  harness.dependencies.revalidateAttribution = async ({ baseline, label }) => {
    const result = await revalidateAttribution({ baseline, label })
    if (label === 'after') {
      harness.signalSource.emit('SIGTERM')
    }
    return result
  }

  const result = await runExternalSampler(harness.options, harness.dependencies)

  assert.equal(result.exitCode, 143)
  assert.equal(result.report.status, 'interrupted')
  assert.equal(result.report.usable, false)
  assert.doesNotThrow(() => validateRunReport(result.report))
  const emitted = JSON.parse(await readFile(join(harness.output, 'run.json'), 'utf8'))
  assert.equal(emitted.status, 'interrupted')
  assert.equal(emitted.usable, false)
  assert.doesNotThrow(() => validateRunReport(emitted))
})

test('sample CLI wrapper passes parsed options to the external-only sampler and preserves its exit code', async () => {
  const calls = []
  const result = await sampleMain(
    [
      '--app-bundle', 'src-tauri/target/release/bundle/macos/Clarus Music.app',
      '--root-pid', '4101', '--fixture-directory', 'artifacts/perf/fixtures/current',
      '--metadata', 'artifacts/perf/metadata/idle-r01.json', '--output', 'artifacts/perf/runs/idle-r01',
      '--samples', '5', '--interval-ms', '250',
    ],
    {
      sampler: async (options) => {
        calls.push(options)
        return { exitCode: 3, report: { failure: { code: 'PERMISSION_DENIED' } } }
      },
      write: () => {},
    },
  )
  assert.equal(result.exitCode, 3)
  assert.equal(calls[0].rootPid, 4101)
})
