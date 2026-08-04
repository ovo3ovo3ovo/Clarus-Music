import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PRODUCER,
  REQUIRED_MEASUREMENT_DESCRIPTORS,
  RUN_SCHEMA,
  SCHEMA_VERSION,
  SUMMARY_SCHEMA,
  canonicalJson,
  canonicalSha256,
  normalizeControlsMetadata,
  validateMeasurement,
  validateMetadata,
  validateRunReport,
  validateSummaryReport,
} from './report-schema.mjs'

const HASH = 'a'.repeat(64)
const COMMIT = 'b'.repeat(40)

function metadata(overrides = {}) {
  return {
    scenario: 'idle',
    scenarioClass: 'runtime',
    runId: 'idle-r01',
    runIndex: 1,
    buildKind: 'release',
    coldWarm: 'warm',
    cacheState: 'hit',
    windowCssPx: { width: 1440, height: 900 },
    displayScale: 2,
    powerSource: 'ac',
    powerMode: 'normal',
    volume: 0.5,
    outputDevice: 'Built-in Output',
    networkProfile: 'loopback',
    settingsFixture: 'baseline-settings',
    queueFixture: 'tone-short-mp3',
    fixtureRoles: ['tone-short-mp3', 'word-timed-yrc'],
    notes: null,
    ...overrides,
  }
}

function roleRecord(role = 'tone-short-mp3') {
  return {
    role,
    filename: `${role}.${role === 'word-timed-yrc' ? 'yrc' : 'mp3'}`,
    byteLength: 12,
    sha256: HASH,
  }
}

function completedMeasurements() {
  const pids = {
    main: 12345,
    'web-content': 12346,
    gpu: 12347,
    networking: 12348,
    'process-total': 12345,
  }
  return REQUIRED_MEASUREMENT_DESCRIPTORS.map((descriptor) => {
    const phase = ['cpu.percent', 'process.thread_count'].includes(descriptor.metric)
      ? 'top'
      : 'footprint'
    return {
      sampleIndex: 0,
      observedAt: '2026-08-05T00:00:02.000Z',
      phase,
      tool: phase,
      role: descriptor.role,
      pid: pids[descriptor.role],
      metric: descriptor.metric,
      unit: descriptor.unit,
      value: 1,
      rawFile: `raw/${phase}.stdout.txt`,
    }
  })
}

function runReport(overrides = {}) {
  const controlsMetadata = metadata()
  const report = {
    $schema: RUN_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    producer: { ...PRODUCER },
    status: 'completed',
    usable: true,
    failure: null,
    run: {
      scenario: 'idle',
      scenarioClass: 'runtime',
      runId: 'idle-r01',
      runIndex: 1,
      requestedAt: '2026-08-05T00:00:00.000Z',
      startedAt: '2026-08-05T00:00:01.000Z',
      endedAt: '2026-08-05T00:00:02.000Z',
      requested: {
        samples: 5,
        intervalMs: 250,
        stackDurationSeconds: 0,
        stackIntervalMs: 1,
      },
    },
    source: {
      repositoryRoot: '/private/repo',
      gitCommit: COMMIT,
      dirty: false,
      appBundlePath: '/private/repo/src-tauri/target/release/bundle/macos/Clarus Music.app',
      appExecutablePath:
        '/private/repo/src-tauri/target/release/bundle/macos/Clarus Music.app/Contents/MacOS/simplemusic',
      bundleId: 'com.ovo3ovo3ovo.clarusmusic',
      bundleVersion: '0.1.0',
      executableSha256: HASH,
      release: true,
    },
    controls: {
      metadata: controlsMetadata,
      sha256: canonicalSha256(normalizeControlsMetadata(controlsMetadata)),
    },
    fixture: {
      directory: '/private/repo/artifacts/perf/fixtures/current',
      lockSha256: HASH,
      schemaVersion: 2,
      recipeVersion: '2.0.0',
      roles: [roleRecord(), roleRecord('word-timed-yrc')],
    },
    host: {
      platform: 'darwin',
      osVersion: '14.0',
      osBuild: '23A1',
      arch: 'arm64',
      nodeVersion: 'v26.5.0',
      timezone: 'UTC',
      cpu: { model: null, cores: null },
      memoryBytes: null,
    },
    attribution: {
      method: 'posix-descendant',
      rootPid: 12345,
      coalition: { id: '42', asn: '0x1' },
      preSnapshot: [
        { pid: 12345, ppid: 1, start: '123', path: '/private/app', realpath: '/private/app' },
      ],
      postSnapshot: [
        { pid: 12345, ppid: 1, start: '123', path: '/private/app', realpath: '/private/app' },
      ],
      selected: [
        { role: 'main', pid: 12345, start: '123', path: '/private/app', realpath: '/private/app' },
      ],
      unselected: [],
    },
    tools: [
      { name: 'ps', path: '/bin/ps', requested: true, available: true },
      { name: 'top', path: '/usr/bin/top', requested: true, available: true },
    ],
    commands: [],
    measurements: completedMeasurements(),
    rawFiles: [
      { path: 'raw/metadata.json', purpose: 'metadata', byteLength: 1, sha256: HASH },
      { path: 'raw/top.stdout.txt', purpose: 'top:top:stdout', byteLength: 1, sha256: HASH },
    ],
  }
  return { ...report, ...overrides }
}

test('metadata accepts only the strict release measurement controls', () => {
  const validated = validateMetadata(metadata(), {
    fixtureRoles: new Set(['tone-short-mp3', 'word-timed-yrc']),
  })
  assert.deepEqual(validated, metadata())

  assert.throws(() => validateMetadata(metadata({ extra: true })), /unknown/i)
  assert.throws(() => validateMetadata(metadata({ buildKind: 'debug' })), /buildKind/)
  assert.throws(() => validateMetadata(metadata({ runIndex: 0 })), /runIndex/)
  assert.throws(() => validateMetadata(metadata({ notes: 'line\nfeed' })), /control/i)
  assert.throws(
    () => validateMetadata(metadata({ fixtureRoles: ['tone-short-mp3', 'tone-short-mp3'] })),
    /unique/i,
  )
  assert.throws(
    () =>
      validateMetadata(metadata({ fixtureRoles: ['tone-long-mp3'] }), { fixtureRoles: new Set() }),
    /verified lock/i,
  )
})

test('canonical controls hashing is deterministic and rejects unsafe values', () => {
  assert.equal(canonicalJson({ z: 1, a: ['x', true] }), '{"a":["x",true],"z":1}')
  assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }))
  assert.throws(() => canonicalJson({ number: Number.NaN }), /finite/i)
  assert.throws(() => canonicalJson({ unsafe: 'a\u0000b' }), /control/i)
})

test('measurements enforce the exact allowed role metric and unit combinations', () => {
  const measurement = {
    sampleIndex: 0,
    observedAt: '2026-08-05T00:00:02.000Z',
    phase: 'top',
    tool: 'top',
    role: 'main',
    pid: 12345,
    metric: 'cpu.percent',
    unit: 'percent',
    value: 101.25,
    rawFile: 'raw/top-000.stdout.txt',
  }
  assert.deepEqual(validateMeasurement(measurement), measurement)
  assert.throws(() => validateMeasurement({ ...measurement, unit: 'bytes' }), /unit/i)
  assert.throws(() => validateMeasurement({ ...measurement, value: -1 }), /at least 0/i)
  assert.throws(() => validateMeasurement({ ...measurement, rawFile: '../secret' }), /path/i)
  assert.throws(
    () => validateMeasurement({ ...measurement, role: 'process-total' }),
    /fixed.*plan|combination/i,
  )
  assert.throws(
    () => validateMeasurement({ ...measurement, phase: 'top', tool: 'footprint' }),
    /phase.*tool|tool.*phase/i,
  )
})

test('run reports require the literal $schema top-level key', () => {
  const valid = runReport()

  assert.deepEqual(validateRunReport(valid), valid)
  assert.throws(() => validateRunReport({ ...valid, schema: RUN_SCHEMA }), /unknown/i)
  const missingSchema = { ...valid }
  delete missingSchema.$schema
  assert.throws(() => validateRunReport(missingSchema), /missing/i)
})

test('run reports require schema identity and status consistency', () => {
  const valid = runReport()
  assert.deepEqual(validateRunReport(valid), valid)
  assert.throws(() => validateRunReport({ ...valid, schemaVersion: 2 }), /schemaVersion/i)
  assert.throws(() => validateRunReport({ ...valid, unexpected: true }), /unknown/i)
  assert.throws(() => validateRunReport({ ...valid, usable: false }), /completed/i)
  assert.throws(() => validateRunReport({ ...valid, measurements: [] }), /completed.*measurement/i)
  assert.throws(
    () => validateRunReport({ ...valid, measurements: valid.measurements.slice(0, -1) }),
    /exact|required.*descriptor|fixed.*plan/i,
  )
  assert.throws(
    () => validateRunReport({ ...valid, rawFiles: [{ ...valid.rawFiles[0], path: '/tmp/nope' }] }),
    /path/i,
  )

  const failed = runReport({
    status: 'failed',
    usable: false,
    failure: { code: 'TOOL_UNAVAILABLE', phase: 'preflight', message: 'top unavailable' },
  })
  assert.deepEqual(validateRunReport(failed), failed)
  assert.throws(() => validateRunReport({ ...failed, failure: null }), /failure/i)
})

function descriptorKey(descriptor) {
  return `${descriptor.role}\u0000${descriptor.metric}\u0000${descriptor.unit}`
}

function orderedDescriptors(descriptors = REQUIRED_MEASUREMENT_DESCRIPTORS) {
  return descriptors
    .map((descriptor) => ({ ...descriptor }))
    .sort((left, right) => {
      const leftKey = descriptorKey(left)
      const rightKey = descriptorKey(right)
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
}

function summaryReport(descriptors = orderedDescriptors()) {
  const statistic = (descriptor) => ({
    ...descriptor,
    n: 5,
    median: 1,
    p95: 1,
    min: 1,
    max: 1,
    span: 0,
    mean: 1,
    sampleStandardDeviation: 0,
    coefficientOfVariationPercent: 0,
    cvStatus: 'ok',
    runtimeStatus: 'ok',
  })
  const report = {
    $schema: SUMMARY_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    producer: { ...PRODUCER },
    cohort: {
      scenario: 'idle',
      scenarioClass: 'runtime',
      controlsSha256: HASH,
      fixtureLockSha256: HASH,
      appExecutableSha256: HASH,
      gitCommit: COMMIT,
      measurementSet: descriptors,
      sourceStatistic: 'per-run-median',
      requiredRuns: 5,
      actualRuns: 5,
    },
    runs: Array.from({ length: 5 }, (_, index) => ({
      runId: `idle-r0${index + 1}`,
      runIndex: index + 1,
      sourcePath: `runs/idle-r0${index + 1}/run.json`,
      medians: descriptors.map((descriptor) => ({ ...descriptor, value: 1 })),
    })),
    compliance: { complete: true, requiredRuns: 5, actualRuns: 5, status: 'ok' },
    statistics: descriptors.map(statistic),
  }
  return report
}

test('summary reports require the canonical descriptor set across cohort, medians, and statistics', () => {
  const report = summaryReport()
  assert.deepEqual(validateSummaryReport(report), report)
  assert.throws(() => validateSummaryReport({ ...report, schema: SUMMARY_SCHEMA }), /unknown/i)
  const missingSchema = { ...report }
  delete missingSchema.$schema
  assert.throws(() => validateSummaryReport(missingSchema), /missing/i)
  assert.throws(
    () => validateSummaryReport({ ...report, cohort: { ...report.cohort, actualRuns: 4 } }),
    /actualRuns/i,
  )
  assert.throws(
    () =>
      validateSummaryReport({
        ...report,
        runs: [report.runs[0], report.runs[0], ...report.runs.slice(2)],
      }),
    /duplicate/i,
  )

  const missingDescriptorReport = summaryReport(orderedDescriptors().slice(1))
  assert.throws(
    () => validateSummaryReport(missingDescriptorReport),
    /canonical|exact.*fixed.*descriptor|measurementSet/i,
  )

  const illegalCrossRoleDescriptor = {
    role: 'process-total',
    metric: 'cpu.percent',
    unit: 'percent',
  }
  const extraDescriptorReport = summaryReport(
    orderedDescriptors([...REQUIRED_MEASUREMENT_DESCRIPTORS, illegalCrossRoleDescriptor]),
  )
  assert.throws(
    () => validateSummaryReport(extraDescriptorReport),
    /canonical|exact.*fixed.*descriptor|measurementSet/i,
  )

  const missingMedianReport = summaryReport()
  missingMedianReport.runs = missingMedianReport.runs.map((run) => ({
    ...run,
    medians: run.medians.slice(1),
  }))
  assert.throws(() => validateSummaryReport(missingMedianReport), /medians.*measurementSet/i)

  const unexpectedStatisticReport = summaryReport()
  unexpectedStatisticReport.statistics = [
    ...unexpectedStatisticReport.statistics.slice(0, -1),
    {
      ...unexpectedStatisticReport.statistics.at(-1),
      ...illegalCrossRoleDescriptor,
    },
  ]
  assert.throws(
    () => validateSummaryReport(unexpectedStatisticReport),
    /statistics.*cohort measurementSet/i,
  )
})
