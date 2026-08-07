import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseSummarizeArguments } from './cli-support.mjs'
import {
  canonicalSha256,
  normalizeControlsMetadata,
  validateSummaryReport,
} from './report-schema.mjs'
import { buildCohortSummary, runSummarizer } from './summarize.mjs'

const HASH = 'a'.repeat(64)
const COMMIT = 'b'.repeat(40)

function makeRun({
  runId,
  runIndex,
  values = [runIndex],
  scenario = 'idle',
  scenarioClass = 'runtime',
  controls = undefined,
  lockSha256 = HASH,
  executableSha256 = HASH,
  gitCommit = COMMIT,
  status = 'completed',
  usable = true,
  measurements = undefined,
} = {}) {
  const metadata = {
    scenario,
    scenarioClass,
    runId,
    runIndex,
    buildKind: 'release',
    coldWarm: 'warm',
    cacheState: 'hit',
    windowCssPx: { width: 1280, height: 800 },
    displayScale: 2,
    powerSource: 'ac',
    powerMode: 'normal',
    volume: null,
    outputDevice: null,
    networkProfile: 'offline',
    settingsFixture: null,
    queueFixture: null,
    fixtureRoles: ['tone-short-mp3'],
    notes: null,
  }
  const selected = {
    role: 'main',
    pid: 101,
    start: '1',
    path: '/private/app',
    realpath: '/private/app',
  }
  return {
    $schema: 'clarus.perf.run',
    schemaVersion: 1,
    producer: { name: 'clarus-perf-external-sampler', version: 1 },
    status,
    usable,
    failure:
      status === 'completed' ? null : { code: 'TOOL_FAILED', phase: 'top', message: 'failed' },
    run: {
      scenario,
      scenarioClass,
      runId,
      runIndex,
      requestedAt: '2026-08-05T00:00:00.000Z',
      startedAt: '2026-08-05T00:00:01.000Z',
      endedAt: '2026-08-05T00:00:02.000Z',
      requested: { samples: 5, intervalMs: 250, stackDurationSeconds: 0, stackIntervalMs: 1 },
    },
    source: {
      repositoryRoot: '/private/repo',
      gitCommit,
      dirty: false,
      appBundlePath: '/private/repo/src-tauri/target/release/bundle/macos/Clarus Music.app',
      appExecutablePath:
        '/private/repo/src-tauri/target/release/bundle/macos/Clarus Music.app/Contents/MacOS/clarus-music',
      bundleId: 'com.ovo3ovo3ovo.clarusmusic',
      bundleVersion: '0.1.0',
      executableSha256,
      release: true,
    },
    controls: {
      metadata,
      sha256: controls ?? canonicalSha256(normalizeControlsMetadata(metadata)),
    },
    fixture: {
      directory: '/private/repo/artifacts/perf/fixtures/current',
      lockSha256,
      schemaVersion: 2,
      recipeVersion: '2.0.0',
      roles: [
        { role: 'tone-short-mp3', filename: 'tone-short-mp3.mp3', byteLength: 1, sha256: HASH },
      ],
    },
    host: {
      platform: 'darwin',
      osVersion: null,
      osBuild: null,
      arch: 'arm64',
      nodeVersion: 'v26.5.0',
      timezone: 'UTC',
      cpu: { model: null, cores: null },
      memoryBytes: null,
    },
    attribution: {
      method: 'posix-descendant',
      rootPid: 101,
      coalition: { id: '1', asn: '0x1' },
      preSnapshot: [
        { pid: 101, ppid: 1, start: '1', path: '/private/app', realpath: '/private/app' },
      ],
      postSnapshot: [
        { pid: 101, ppid: 1, start: '1', path: '/private/app', realpath: '/private/app' },
      ],
      selected: [selected],
      unselected: [],
    },
    tools: [],
    commands: [],
    measurements:
      measurements ??
      values.flatMap((value, sampleIndex) => [
        ...['main', 'web-content', 'gpu', 'networking'].flatMap((role, roleIndex) => [
          {
            sampleIndex,
            observedAt: '2026-08-05T00:00:02.000Z',
            phase: 'top',
            tool: 'top',
            role,
            pid: 101 + roleIndex,
            metric: 'cpu.percent',
            unit: 'percent',
            value,
            rawFile: 'raw/top.stdout.txt',
          },
          {
            sampleIndex,
            observedAt: '2026-08-05T00:00:02.000Z',
            phase: 'top',
            tool: 'top',
            role,
            pid: 101 + roleIndex,
            metric: 'process.thread_count',
            unit: 'count',
            value,
            rawFile: 'raw/top.stdout.txt',
          },
          {
            sampleIndex,
            observedAt: '2026-08-05T00:00:02.000Z',
            phase: 'footprint',
            tool: 'footprint',
            role,
            pid: 101 + roleIndex,
            metric: 'memory.physical_footprint_bytes',
            unit: 'bytes',
            value,
            rawFile: 'raw/footprint.stdout.txt',
          },
          {
            sampleIndex,
            observedAt: '2026-08-05T00:00:02.000Z',
            phase: 'footprint',
            tool: 'footprint',
            role,
            pid: 101 + roleIndex,
            metric: 'memory.physical_footprint_peak_bytes',
            unit: 'bytes',
            value,
            rawFile: 'raw/footprint.stdout.txt',
          },
        ]),
        {
          sampleIndex,
          observedAt: '2026-08-05T00:00:02.000Z',
          phase: 'footprint',
          tool: 'footprint',
          role: 'process-total',
          pid: 101,
          metric: 'memory.total_physical_footprint_bytes',
          unit: 'bytes',
          value,
          rawFile: 'raw/footprint.stdout.txt',
        },
      ]),
    rawFiles: [],
  }
}

async function setupRuns(runs) {
  const temporary = await mkdtemp(join(tmpdir(), 'clarus-summarize-test-'))
  const repositoryRoot = join(temporary, 'repo')
  const runsRoot = join(repositoryRoot, 'artifacts', 'perf', 'runs')
  const summariesRoot = join(repositoryRoot, 'artifacts', 'perf', 'summaries')
  const inputs = []
  for (const run of runs) {
    const directory = join(runsRoot, run.run.runId)
    await mkdir(directory, { recursive: true })
    const pathname = join(directory, 'run.json')
    await writeFile(pathname, JSON.stringify(run))
    inputs.push(pathname)
  }
  return { temporary, repositoryRoot, runsRoot, summariesRoot, inputs }
}

test('summarize CLI requires distinct repeated no-equals inputs and a new output', () => {
  const parsed = parseSummarizeArguments([
    '--input',
    'artifacts/perf/runs/idle-r01/run.json',
    '--input',
    'artifacts/perf/runs/idle-r02/run.json',
    '--output',
    'artifacts/perf/summaries/idle',
  ])
  assert.equal(parsed.inputs.length, 2)
  assert.throws(
    () => parseSummarizeArguments(['--input', 'a', '--input', 'a', '--output', 'o']),
    /distinct/i,
  )
  assert.throws(() => parseSummarizeArguments(['--input=a', '--output', 'o']), /key=value/i)
  assert.throws(
    () => parseSummarizeArguments(['--input', 'a', 'extra', '--output', 'o']),
    /positional/i,
  )
  assert.throws(() => parseSummarizeArguments(['--input', 'a', '--output']), /requires a value/i)
})

test('builds cohort statistics from one median per run and exposes incomplete runtime compliance', () => {
  const reports = [
    makeRun({ runId: 'idle-r01', runIndex: 1, values: [1, 100, 100] }),
    makeRun({ runId: 'idle-r02', runIndex: 2, values: [2, 2] }),
    makeRun({ runId: 'idle-r03', runIndex: 3, values: [3, 3] }),
    makeRun({ runId: 'idle-r04', runIndex: 4, values: [4, 4] }),
  ]
  const report = buildCohortSummary(
    reports.map((value, index) => ({ value, pathname: `runs/idle-r0${index + 1}/run.json` })),
  )
  assert.equal(report.cohort.sourceStatistic, 'per-run-median')
  assert.equal(report.cohort.requiredRuns, 5)
  assert.equal(report.cohort.actualRuns, 4)
  assert.equal(report.compliance.status, 'insufficient-n')
  assert.equal(report.statistics[0].median, 3.5)
  assert.equal(report.statistics[0].p95, 100)
  assert.equal(report.statistics[0].runtimeStatus, 'insufficient-n')
})

test('uses the ten-run startup compliance threshold without pooling periodic samples', () => {
  const entries = Array.from({ length: 9 }, (_, index) => {
    const runIndex = index + 1
    return {
      pathname: `runs/startup-r${runIndex}/run.json`,
      value: makeRun({
        runId: `startup-r${runIndex}`,
        runIndex,
        scenario: 'startup',
        scenarioClass: 'startup',
        values: [runIndex, runIndex],
      }),
    }
  })
  const insufficient = buildCohortSummary(entries)
  assert.equal(insufficient.cohort.requiredRuns, 10)
  assert.equal(insufficient.compliance.status, 'insufficient-n')
  assert.equal(insufficient.statistics[0].runtimeStatus, 'insufficient-n')
  const complete = buildCohortSummary([
    ...entries,
    {
      pathname: 'runs/startup-r10/run.json',
      value: makeRun({
        runId: 'startup-r10',
        runIndex: 10,
        scenario: 'startup',
        scenarioClass: 'startup',
        values: [10, 10],
      }),
    },
  ])
  assert.equal(complete.compliance.status, 'ok')
  assert.equal(complete.statistics[0].runtimeStatus, 'ok')
})

test('refuses a complete-sized cohort when every run omits a required descriptor', async (t) => {
  const reports = Array.from({ length: 5 }, (_, index) => {
    const runIndex = index + 1
    const report = makeRun({ runId: `idle-r0${runIndex}`, runIndex, values: [runIndex] })
    report.measurements = report.measurements.filter(
      (measurement) => measurement.metric !== 'memory.total_physical_footprint_bytes',
    )
    return report
  })
  const setup = await setupRuns(reports)
  t.after(() => rm(setup.temporary, { recursive: true, force: true }))
  const result = await runSummarizer(
    { inputs: setup.inputs, output: join(setup.summariesRoot, 'missing-required-descriptor') },
    { repositoryRoot: setup.repositoryRoot, roots: { summariesRoot: setup.summariesRoot } },
  )
  assert.equal(result.exitCode, 2)
  assert.match(
    result.error?.message ?? '',
    /required.*descriptor|fixed-plan|total_physical_footprint/i,
  )
})

test('writes schema-valid json/csv/txt for a complete cohort without pooling periodic samples', async (t) => {
  const setup = await setupRuns(
    Array.from({ length: 5 }, (_, index) =>
      makeRun({
        runId: `idle-r0${index + 1}`,
        runIndex: index + 1,
        values: index === 0 ? [1, 100, 100] : [index + 1, index + 1],
      }),
    ),
  )
  t.after(() => rm(setup.temporary, { recursive: true, force: true }))
  const output = join(setup.summariesRoot, 'idle')
  const result = await runSummarizer(
    { inputs: setup.inputs, output },
    { repositoryRoot: setup.repositoryRoot, roots: { summariesRoot: setup.summariesRoot } },
  )
  assert.equal(result.exitCode, 0)
  const report = JSON.parse(await readFile(join(output, 'summary.json'), 'utf8'))
  validateSummaryReport(report)
  assert.equal(report.compliance.status, 'ok')
  assert.equal(report.statistics[0].n, 5)
  assert.equal(report.statistics[0].median, 4)
  assert.match(
    await readFile(join(output, 'summary.txt'), 'utf8'),
    /^MEASUREMENT INFRASTRUCTURE OUTPUT — NOT EVIDENCE OF PRODUCT IMPROVEMENT\./,
  )
  assert.match(
    await readFile(join(output, 'summary.csv'), 'utf8'),
    /^schema_version,scenario,scenario_class,/,
  )
})

test('rejects failed, duplicate, unsupported/missing, and mixed-cohort inputs without a conclusion', async (t) => {
  const failedSetup = await setupRuns([
    makeRun({ runId: 'idle-r01', runIndex: 1, status: 'failed', usable: false }),
  ])
  t.after(() => rm(failedSetup.temporary, { recursive: true, force: true }))
  const failed = await runSummarizer(
    { inputs: failedSetup.inputs, output: join(failedSetup.summariesRoot, 'failed') },
    {
      repositoryRoot: failedSetup.repositoryRoot,
      roots: { summariesRoot: failedSetup.summariesRoot },
    },
  )
  assert.equal(failed.exitCode, 2)

  const mixedSetup = await setupRuns([
    makeRun({ runId: 'idle-r01', runIndex: 1 }),
    makeRun({ runId: 'idle-r02', runIndex: 2, gitCommit: 'c'.repeat(40) }),
  ])
  t.after(() => rm(mixedSetup.temporary, { recursive: true, force: true }))
  const mixed = await runSummarizer(
    { inputs: mixedSetup.inputs, output: join(mixedSetup.summariesRoot, 'mixed') },
    {
      repositoryRoot: mixedSetup.repositoryRoot,
      roots: { summariesRoot: mixedSetup.summariesRoot },
    },
  )
  assert.equal(mixed.exitCode, 2)

  const duplicateSetup = await setupRuns([
    makeRun({ runId: 'idle-r01', runIndex: 1 }),
    makeRun({ runId: 'idle-r01', runIndex: 2 }),
  ])
  t.after(() => rm(duplicateSetup.temporary, { recursive: true, force: true }))
  const duplicate = await runSummarizer(
    { inputs: duplicateSetup.inputs, output: join(duplicateSetup.summariesRoot, 'duplicate') },
    {
      repositoryRoot: duplicateSetup.repositoryRoot,
      roots: { summariesRoot: duplicateSetup.summariesRoot },
    },
  )
  assert.equal(duplicate.exitCode, 2)

  const missingSetup = await setupRuns([
    makeRun({ runId: 'idle-r01', runIndex: 1 }),
    makeRun({ runId: 'idle-r02', runIndex: 2, measurements: [] }),
  ])
  t.after(() => rm(missingSetup.temporary, { recursive: true, force: true }))
  const missing = await runSummarizer(
    { inputs: missingSetup.inputs, output: join(missingSetup.summariesRoot, 'missing') },
    {
      repositoryRoot: missingSetup.repositoryRoot,
      roots: { summariesRoot: missingSetup.summariesRoot },
    },
  )
  assert.equal(missing.exitCode, 2)
})

test('refuses symlinked inputs and traversal/existing summary outputs', async (t) => {
  const setup = await setupRuns([makeRun({ runId: 'idle-r01', runIndex: 1 })])
  t.after(() => rm(setup.temporary, { recursive: true, force: true }))
  const linked = join(setup.repositoryRoot, 'linked-run.json')
  await symlink(setup.inputs[0], linked)
  const linkResult = await runSummarizer(
    { inputs: [linked], output: join(setup.summariesRoot, 'link') },
    { repositoryRoot: setup.repositoryRoot, roots: { summariesRoot: setup.summariesRoot } },
  )
  assert.equal(linkResult.exitCode, 2)
  const output = join(setup.summariesRoot, 'existing')
  await mkdir(output, { recursive: true })
  const existing = await runSummarizer(
    { inputs: setup.inputs, output },
    { repositoryRoot: setup.repositoryRoot, roots: { summariesRoot: setup.summariesRoot } },
  )
  assert.equal(existing.exitCode, 2)
})

test('refuses a run input outside the canonical artifacts/perf/runs root', async (t) => {
  const setup = await setupRuns([makeRun({ runId: 'idle-r01', runIndex: 1 })])
  t.after(() => rm(setup.temporary, { recursive: true, force: true }))
  const externalDirectory = join(setup.temporary, 'external-run')
  const externalInput = join(externalDirectory, 'run.json')
  await mkdir(externalDirectory)
  await writeFile(externalInput, JSON.stringify(makeRun({ runId: 'idle-r02', runIndex: 2 })))

  const result = await runSummarizer(
    { inputs: [externalInput], output: join(setup.summariesRoot, 'external-input') },
    { repositoryRoot: setup.repositoryRoot, roots: { summariesRoot: setup.summariesRoot } },
  )

  assert.equal(result.exitCode, 2)
  assert.match(result.error?.message ?? '', /runs|strict child|outside|canonical/i)
})

test('refuses a repository-internal parent-directory symlink escape for a run input', async (t) => {
  const setup = await setupRuns([makeRun({ runId: 'idle-r01', runIndex: 1 })])
  t.after(() => rm(setup.temporary, { recursive: true, force: true }))
  const externalDirectory = join(setup.temporary, 'escaped-run')
  await mkdir(externalDirectory)
  await writeFile(
    join(externalDirectory, 'run.json'),
    JSON.stringify(makeRun({ runId: 'idle-r02', runIndex: 2 })),
  )
  const linkedDirectory = join(setup.runsRoot, 'linked-run')
  await symlink(externalDirectory, linkedDirectory)

  const result = await runSummarizer(
    {
      inputs: [join(linkedDirectory, 'run.json')],
      output: join(setup.summariesRoot, 'symlink-escape'),
    },
    { repositoryRoot: setup.repositoryRoot, roots: { summariesRoot: setup.summariesRoot } },
  )

  assert.equal(result.exitCode, 2)
  assert.match(result.error?.message ?? '', /symbolic link|runs|outside|canonical/i)
})

test('accepts a canonical run input through a symlinked ancestor outside the repository', async (t) => {
  const setup = await setupRuns([makeRun({ runId: 'idle-r01', runIndex: 1 })])
  t.after(() => rm(setup.temporary, { recursive: true, force: true }))
  const outsideAncestorLink = join(setup.temporary, 'outside-ancestor-link')
  await symlink(setup.temporary, outsideAncestorLink)
  const inputThroughOutsideAncestor = join(
    outsideAncestorLink,
    'repo',
    'artifacts',
    'perf',
    'runs',
    'idle-r01',
    'run.json',
  )

  const result = await runSummarizer(
    {
      inputs: [inputThroughOutsideAncestor],
      output: join(setup.summariesRoot, 'outside-ancestor'),
    },
    { repositoryRoot: setup.repositoryRoot, roots: { summariesRoot: setup.summariesRoot } },
  )

  assert.equal(result.exitCode, 0)
})

test('rejects repo-external leaf and parent symlinks that resolve into canonical runs', async (t) => {
  const setup = await setupRuns([makeRun({ runId: 'idle-r01', runIndex: 1 })])
  t.after(() => rm(setup.temporary, { recursive: true, force: true }))

  const externalLeafDirectory = join(setup.temporary, 'external-leaf')
  await mkdir(externalLeafDirectory)
  const externalLeaf = join(externalLeafDirectory, 'run.json')
  await symlink(setup.inputs[0], externalLeaf)
  const leafResult = await runSummarizer(
    { inputs: [externalLeaf], output: join(setup.summariesRoot, 'external-leaf-input') },
    { repositoryRoot: setup.repositoryRoot, roots: { summariesRoot: setup.summariesRoot } },
  )
  assert.equal(leafResult.exitCode, 2)
  assert.match(leafResult.error?.message ?? '', /symbolic link|symlink|outside|runs/i)

  const externalParent = join(setup.temporary, 'external-runs-link')
  await symlink(setup.runsRoot, externalParent)
  const parentResult = await runSummarizer(
    {
      inputs: [join(externalParent, 'idle-r01', 'run.json')],
      output: join(setup.summariesRoot, 'external-parent'),
    },
    { repositoryRoot: setup.repositoryRoot, roots: { summariesRoot: setup.summariesRoot } },
  )
  assert.equal(parentResult.exitCode, 2)
  assert.match(parentResult.error?.message ?? '', /symbolic link|symlink|outside|runs/i)
})
