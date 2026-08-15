import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  attributeNewWebKitProcessSet,
  compactFixtureRequestMetrics,
  computeSelfRunSummary,
  evaluatePerformanceGates,
  hashReleaseBundle,
  parseLaunchServicesApplicationList,
  parseProcessStatistics,
  parseResidentSetOutput,
  readPerformanceCheckpoint,
  renderSelfRunCsv,
  renderSelfRunSummary,
  validatePerformanceCheckpoint,
} from './self-runner.mjs'

function telemetry(playback = {}) {
  return {
    images: {
      elements: 1,
      visibleElements: 1,
      loaded: 1,
      failed: 0,
      blank: 0,
      blankEvents: 0,
      loadEvents: 1,
      errorEvents: 0,
      reloads: 0,
      activeRequests: 0,
      requestStarts: 1,
      requestCompletions: 1,
      requestFailures: 0,
    },
    requests: { active: 0, started: 1, completed: 1, failed: 0 },
    playback: {
      state: 'playing',
      repeatMode: 'one',
      sourceKind: 'remote',
      sourceUrl: 'http://127.0.0.1:43123/tone-long-mp3.mp3',
      sourceProvenance: 'performance-fixture',
      fallbackReason: null,
      currentTime: 60,
      duration: 300,
      samples: 10,
      advancingSamples: 8,
      maximumAdvanceSeconds: 1,
      firstProgressAt: '2026-08-08T00:00:01.000Z',
      lastProgressAt: '2026-08-08T00:01:00.000Z',
      recoverySamples: 600,
      recoveryExactFixtureSamples: 600,
      recoveryPlayingSamples: 600,
      recoveryRepeatOneSamples: 600,
      recoveryAdvancingSamples: 598,
      recoveryWraps: 1,
      recoveryStalledSamples: 0,
      ...playback,
    },
    routeTransitions: 1,
    events: [],
  }
}

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 1,
    scenario: 'artist-dfs-v1',
    phase: 'complete',
    startedAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:02:00.000Z',
    iterationsRequested: 50,
    iterationsCompleted: 50,
    recoverySecondsElapsed: 60,
    frames: {
      sampleCount: 120,
      meanMs: 8.5,
      p50Ms: 8.3,
      p95Ms: 9.8,
      p99Ms: 16.9,
      over16ms: 2,
      over32ms: 0,
    },
    runtime: {
      domNodes: 100,
      imageElements: 0,
      mediaElements: 1,
      coverElements: 0,
      loadedCoverElements: 0,
      failedCoverElements: 0,
      route: '#/daily/songs',
    },
    failure: null,
    ...overrides,
  }
}

function sample(index, phase, footprint, elapsedMilliseconds = index * 1_000) {
  return {
    index,
    observedAt: new Date(1_786_147_200_000 + elapsedMilliseconds).toISOString(),
    elapsedMilliseconds,
    phase,
    iterationsCompleted: phase === 'ready' ? 0 : 50,
    recoverySecondsElapsed: phase === 'recovery' || phase === 'complete' ? index : 0,
    physicalFootprintBytes: footprint,
    physicalFootprintPeakBytes: footprint + 10,
    cpuPercent: index + 0.5,
    threadCount: 10 + index,
  }
}

test('validates atomic frontend checkpoints and rejects malformed frame data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clarus-self-run-checkpoint-'))
  try {
    const pathname = join(directory, 'checkpoint.json')
    await writeFile(pathname, JSON.stringify(checkpoint()))
    assert.equal((await readPerformanceCheckpoint(pathname)).phase, 'complete')
    assert.throws(
      () => validatePerformanceCheckpoint(checkpoint({ frames: { sampleCount: -1 } })),
      /checkpoint/i,
    )
    assert.equal(await readPerformanceCheckpoint(join(directory, 'missing.json')), null)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('preserves validated playback URL and provenance in schema-v2 telemetry', () => {
  const valid = validatePerformanceCheckpoint(
    checkpoint({ schemaVersion: 2, telemetry: telemetry() }),
  )
  assert.equal(valid.telemetry.playback.sourceUrl, 'http://127.0.0.1:43123/tone-long-mp3.mp3')
  assert.equal(valid.telemetry.playback.sourceProvenance, 'performance-fixture')
  assert.equal(valid.telemetry.playback.repeatMode, 'unknown')
  assert.equal(valid.telemetry.playback.recoverySamples, 0)
  assert.throws(
    () =>
      validatePerformanceCheckpoint(
        checkpoint({ schemaVersion: 2, telemetry: telemetry({ sourceUrl: 'not a URL' }) }),
      ),
    /sourceUrl/i,
  )
  assert.throws(
    () =>
      validatePerformanceCheckpoint(
        checkpoint({ schemaVersion: 2, telemetry: telemetry({ sourceProvenance: 'cache' }) }),
      ),
    /sourceProvenance/i,
  )
})

test('schema-v3 requires bounded recovery playback evidence', () => {
  const { recoveryWraps, ...withoutWraps } = telemetry().playback
  assert.equal(recoveryWraps, 1)
  assert.throws(
    () =>
      validatePerformanceCheckpoint(
        checkpoint({ schemaVersion: 3, telemetry: { ...telemetry(), playback: withoutWraps } }),
      ),
    /recoveryWraps/i,
  )
  assert.throws(
    () =>
      validatePerformanceCheckpoint(
        checkpoint({ schemaVersion: 3, telemetry: telemetry({ recoverySamples: -1 }) }),
      ),
    /recoverySamples/i,
  )
})

test('performance gates require a full recovery of exact fixture repeat-one playback across a wrap', () => {
  const expectedAudioUrl = 'http://127.0.0.1:43123/tone-long-mp3.mp3'
  const completed = validatePerformanceCheckpoint(
    checkpoint({
      schemaVersion: 3,
      recoverySecondsElapsed: 600,
      frames: {
        sampleCount: 1_000,
        meanMs: 8,
        p50Ms: 8,
        p95Ms: 10,
        p99Ms: 12,
        over16ms: 0,
        over32ms: 0,
      },
      telemetry: telemetry({ sourceUrl: expectedAudioUrl }),
    }),
  )
  const summary = {
    recoveryDurationSeconds: 600,
    recoveryStableWindowSeconds: 60,
    dfsPeakBytes: 100 * 1024 * 1024,
    recoveryStableBytes: 90 * 1024 * 1024,
    recoverySlopeBytesPerSecond: 0,
  }
  const fixtureMetrics = {
    rangeRequests: 1,
    byFilename: {
      'tone-long-mp3.mp3': { requests: 1, failures: 0, bytesSent: 65_536 },
    },
  }
  const evidence = {
    telemetry: completed.telemetry,
    expectedAudioUrl,
    expectedAudioFilename: 'tone-long-mp3.mp3',
    fixtureMetrics,
  }

  assert.equal(evaluatePerformanceGates(summary, completed, evidence).pass, true)
  assert.equal(
    evaluatePerformanceGates(summary, completed, evidence).gates.recoveryPlaybackCoverage,
    true,
  )
  assert.equal(
    evaluatePerformanceGates(summary, completed, evidence).gates.recoveryExactFixture,
    true,
  )
  assert.equal(
    evaluatePerformanceGates(summary, completed, evidence).gates.recoveryProgressAndWrap,
    true,
  )
  assert.equal(evaluatePerformanceGates(summary, completed, evidence).gates.recoveryWraps, true)
  assert.equal(
    evaluatePerformanceGates(summary, completed, {
      ...evidence,
      expectedAudioUrl: 'http://127.0.0.1:43123/another.mp3',
    }).gates.playbackSourceUrl,
    false,
  )
  assert.equal(
    evaluatePerformanceGates(summary, completed, {
      ...evidence,
      fixtureMetrics: { ...fixtureMetrics, rangeRequests: 0 },
    }).gates.fixtureRangeRequests,
    false,
  )
  assert.equal(
    evaluatePerformanceGates(summary, completed, {
      ...evidence,
      fixtureMetrics: {
        ...fixtureMetrics,
        byFilename: {
          'tone-long-mp3.mp3': { requests: 1, failures: 1, bytesSent: 65_536 },
        },
      },
    }).gates.fixtureAudioIdentity,
    false,
  )
  assert.equal(
    evaluatePerformanceGates(summary, completed, completed.telemetry).gates.playbackSourceUrl,
    false,
  )

  const legacy = validatePerformanceCheckpoint(
    checkpoint({
      schemaVersion: 2,
      recoverySecondsElapsed: 600,
      telemetry: telemetry({ sourceUrl: expectedAudioUrl }),
    }),
  )
  assert.equal(
    evaluatePerformanceGates(summary, legacy, evidence).gates.recoveryPlaybackCoverage,
    false,
  )
  assert.equal(evaluatePerformanceGates(summary, legacy, evidence).pass, false)
})

test('a 300-second stop fails recovery playback gates even if final fixture identity looks valid', () => {
  const expectedAudioUrl = 'http://127.0.0.1:43123/tone-long-mp3.mp3'
  const completed = validatePerformanceCheckpoint(
    checkpoint({
      schemaVersion: 3,
      recoverySecondsElapsed: 600,
      frames: {
        sampleCount: 1_000,
        meanMs: 8,
        p50Ms: 8,
        p95Ms: 10,
        p99Ms: 12,
        over16ms: 0,
        over32ms: 0,
      },
      telemetry: telemetry({
        sourceUrl: expectedAudioUrl,
        // It advanced to the 300-second fixture boundary, then stayed there
        // for the rest of the 600-second recovery. Final URL/provenance and
        // even a stale `playing` state still look healthy without this gate.
        recoveryAdvancingSamples: 299,
        recoveryWraps: 0,
        recoveryStalledSamples: 300,
      }),
    }),
  )
  const summary = {
    recoveryDurationSeconds: 600,
    recoveryStableWindowSeconds: 60,
    dfsPeakBytes: 100 * 1024 * 1024,
    recoveryStableBytes: 90 * 1024 * 1024,
    recoverySlopeBytesPerSecond: 0,
  }
  const evidence = {
    telemetry: completed.telemetry,
    expectedAudioUrl,
    expectedAudioFilename: 'tone-long-mp3.mp3',
    fixtureMetrics: {
      rangeRequests: 1,
      byFilename: {
        'tone-long-mp3.mp3': { requests: 1, failures: 0, bytesSent: 65_536 },
      },
    },
  }

  const result = evaluatePerformanceGates(summary, completed, evidence)
  assert.equal(result.gates.playbackSource, true)
  assert.equal(result.gates.fixtureRangeRequests, true)
  assert.equal(result.gates.fixtureAudioIdentity, true)
  assert.equal(result.gates.recoveryExactFixture, true)
  assert.equal(result.gates.recoveryPlaying, true)
  assert.equal(result.gates.recoveryRepeatOne, true)
  assert.equal(result.gates.recoveryNoStalls, false)
  assert.equal(result.gates.recoveryProgressAndWrap, false)
  assert.equal(result.gates.recoveryWraps, false)
  assert.equal(result.pass, false)
})

test('bundle provenance hashing changes when a Release resource changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clarus-self-run-bundle-'))
  try {
    await mkdir(join(directory, 'Contents', 'Resources'), { recursive: true })
    await writeFile(join(directory, 'Contents', 'Info.plist'), 'plist')
    await writeFile(join(directory, 'Contents', 'Resources', 'marker'), 'one')
    const first = await hashReleaseBundle(directory)
    await writeFile(join(directory, 'Contents', 'Resources', 'marker'), 'two')
    const second = await hashReleaseBundle(directory)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.notEqual(first, second)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('summarizes DFS peak, recovery stable window, slope and frame cadence', () => {
  const mib = 1024 * 1024
  const samples = [
    sample(0, 'ready', 120 * mib),
    sample(1, 'dfs', 180 * mib),
    sample(2, 'dfs', 210 * mib),
    sample(3, 'recovery', 200 * mib),
    sample(4, 'recovery', 180 * mib),
    sample(5, 'complete', 160 * mib),
  ]
  const summary = computeSelfRunSummary(samples, validatePerformanceCheckpoint(checkpoint()))
  assert.equal(summary.dfsPeakBytes, 210 * mib + 10)
  assert.equal(summary.recoveryStableBytes, 180 * mib)
  assert.equal(summary.recoveryDropBytes, 20 * mib)
  assert.equal(summary.recoverySlopeBytesPerSecond, -20 * mib)
  assert.equal(summary.frameP50Ms, 8.3)
  assert.equal(summary.frameP95Ms, 9.8)
  assert.equal(summary.dfsPeakAtOrBelow200MiB, false)
  assert.equal(summary.recoveryStableAtOrBelow200MiB, true)
})

test('reports each physical-footprint role and keeps absent process values null', () => {
  const process = (
    physicalFootprintBytes,
    physicalFootprintPeakBytes = physicalFootprintBytes,
  ) => ({
    physicalFootprintBytes,
    physicalFootprintPeakBytes,
    rssBytes: physicalFootprintBytes,
  })
  const processSample = (index, phase, webContentBytes) => ({
    ...sample(index, phase, webContentBytes),
    processes: {
      main: process(30, 35),
      'web-content': process(webContentBytes, phase === 'dfs' ? 140 : webContentBytes),
      gpu: null,
      networking: process(20, 25),
    },
    totalPhysicalFootprintBytes: null,
    totalRssBytes: null,
  })
  const samples = [processSample(0, 'dfs', 100)]
  for (let index = 1; index <= 60; index += 1) {
    samples.push(processSample(index, index === 60 ? 'complete' : 'recovery', 90))
  }

  const summary = computeSelfRunSummary(samples, validatePerformanceCheckpoint(checkpoint()))

  assert.deepEqual(summary.physicalFootprints.webContent, {
    peakBytes: 140,
    final60MedianBytes: 90,
    tailSlopeBytesPerSecond: 0,
    recoveryDropBytes: 0,
    recoveryStartBytes: 90,
    observedSampleCount: 61,
    missingSampleCount: 0,
    recoveryObservedSampleCount: 60,
    recoveryMissingSampleCount: 0,
    final60WindowSampleCount: 60,
    final60MissingSampleCount: 0,
  })
  assert.equal(summary.physicalFootprints.main.final60MedianBytes, 30)
  assert.equal(summary.physicalFootprints.networking.peakBytes, 25)
  assert.equal(summary.physicalFootprints.gpu.peakBytes, null)
  assert.equal(summary.physicalFootprints.gpu.final60MedianBytes, null)
  assert.equal(summary.physicalFootprints.total.peakBytes, null)
  assert.equal(summary.processPeaks.gpu, null)
  assert.match(
    renderSelfRunSummary({
      status: 'complete',
      outputDirectory: '/tmp/clarus-perf',
      application: {},
      summary,
      checkpoint: null,
      failure: null,
    }),
    /GPU footprint peak\/final-60 median\/tail slope\/recovery drop: NA \/ NA \/ NA \/ NA/,
  )
})

test('keeps periodic fixture evidence bounded and preserves final request metrics', () => {
  const byCacheKey = Object.fromEntries(
    Array.from({ length: 13_000 }, (_, index) => [
      `/clarus-perf/cover/${index}.png?param=96x96`,
      { requests: 1, failures: 0, bytesSent: 512 },
    ]),
  )
  const fullMetrics = {
    activeRequests: 0,
    totalRequests: 13_000,
    completedRequests: 13_000,
    failedRequests: 0,
    rangeRequests: 0,
    bytesSent: 6_656_000,
    byFilename: { 'tone-long.mp3': { requests: 1, failures: 0, bytesSent: 123 } },
    byCacheKey,
    performanceImageCache: { bytes: 1024, entries: 2, hits: 3, misses: 2 },
  }
  const compact = compactFixtureRequestMetrics(fullMetrics)
  const serializedSamples = JSON.stringify(
    Array.from({ length: 600 }, () => ({ fixtureRequests: compact })),
  )
  const serializedReport = JSON.stringify({
    samples: Array.from({ length: 600 }, () => ({ fixtureRequests: compact })),
    fixture: { requestMetrics: fullMetrics },
  })
  const serializedFinalMetrics = JSON.stringify(fullMetrics)

  assert.deepEqual(compact, {
    activeRequests: 0,
    totalRequests: 13_000,
    completedRequests: 13_000,
    failedRequests: 0,
    rangeRequests: 0,
    bytesSent: 6_656_000,
    performanceImageCache: { bytes: 1024, entries: 2, hits: 3, misses: 2 },
  })
  assert.equal(Object.hasOwn(compact, 'byCacheKey'), false)
  assert.equal(Object.hasOwn(compact, 'byFilename'), false)
  assert.ok(serializedSamples.length < 200_000)
  assert.equal((serializedReport.match(/"byCacheKey"/g) ?? []).length, 1)
  assert.ok(
    serializedReport.length < serializedSamples.length + serializedFinalMetrics.length + 1_000,
  )
})

test('summary retains the latest compact fixture request evidence', () => {
  const firstMetrics = compactFixtureRequestMetrics({
    activeRequests: 1,
    totalRequests: 2,
    completedRequests: 1,
    failedRequests: 0,
    rangeRequests: 1,
    bytesSent: 100,
    performanceImageCache: { bytes: 10, entries: 1, hits: 0, misses: 1 },
  })
  const latestMetrics = compactFixtureRequestMetrics({
    activeRequests: 0,
    totalRequests: 4,
    completedRequests: 4,
    failedRequests: 0,
    rangeRequests: 2,
    bytesSent: 400,
    byCacheKey: { '/large-map-entry': { requests: 1, failures: 0, bytesSent: 1 } },
    performanceImageCache: { bytes: 20, entries: 2, hits: 1, misses: 2 },
  })
  const latestMetricsWithMap = {
    ...latestMetrics,
    byCacheKey: { '/large-map-entry': { requests: 1, failures: 0, bytesSent: 1 } },
  }
  const samples = [
    { ...sample(0, 'ready', 100), fixtureRequests: firstMetrics },
    { ...sample(1, 'complete', 90), fixtureRequests: latestMetricsWithMap },
  ]
  const summary = computeSelfRunSummary(samples, validatePerformanceCheckpoint(checkpoint()))

  assert.deepEqual(summary.fixtureRequestMetrics, latestMetrics)
  assert.equal(Object.hasOwn(summary.fixtureRequestMetrics, 'byCacheKey'), false)
})

test('summary receives injected fixture evidence without retaining final resource maps', () => {
  const expectedAudioUrl = 'http://127.0.0.1:53123/tone-long-mp3.mp3'
  const fixtureMetrics = {
    activeRequests: 0,
    totalRequests: 1,
    completedRequests: 1,
    failedRequests: 0,
    rangeRequests: 1,
    bytesSent: 65_536,
    byFilename: {
      'tone-long-mp3.mp3': { requests: 1, failures: 0, bytesSent: 65_536 },
    },
    byCacheKey: {
      'tone-long-mp3.mp3': { requests: 1, failures: 0, bytesSent: 65_536 },
    },
  }
  const completed = validatePerformanceCheckpoint(
    checkpoint({ schemaVersion: 2, telemetry: telemetry({ sourceUrl: expectedAudioUrl }) }),
  )
  const summary = computeSelfRunSummary([sample(0, 'complete', 90)], completed, {
    expectedAudioUrl,
    expectedAudioFilename: 'tone-long-mp3.mp3',
    fixtureMetrics,
  })

  assert.equal(summary.fixturePlaybackEvidence.expectedAudioUrl, expectedAudioUrl)
  assert.equal(summary.fixturePlaybackEvidence.audioResourceMatched, true)
  assert.equal(JSON.stringify(summary).includes('byFilename'), false)
  assert.equal(JSON.stringify(summary).includes('byCacheKey'), false)
})

test('renders RFC 4180-compatible samples and parses exact ps statistics', () => {
  const threads = [
    'USER PID TT %CPU STAT PRI STIME UTIME COMMAND',
    'oo 4102 ?? 0.0 S 2T 0:00.1 0:00.1 /System/WebContent',
    '   4102    0.0 S 2T 0:00.0 0:00.0',
  ].join('\n')
  const parsed = parseProcessStatistics('  4102 12.5\n', threads, 4102)
  assert.deepEqual(parsed, { cpuPercent: 12.5, threadCount: 2 })
  assert.throws(() => parseProcessStatistics('4103 12.5\n', threads, 4102), /mismatched/i)
  assert.equal(parseResidentSetOutput('  4102 2048\n', 4102), 2 * 1024 * 1024)
  assert.throws(() => parseResidentSetOutput('4103 2048\n', 4102), /mismatched/i)

  const csv = renderSelfRunCsv([sample(0, 'ready', 123)])
  assert.match(csv, /^index,observedAt,elapsedMilliseconds,phase,/)
  assert.match(csv, /,ready,0,0,123,133,,,,0\.5,10,0,0,0,0,0,0\r\n$/)
})

test('strictly attributes only the new LaunchServices WebKit helper set', () => {
  const app = '/private/release/Clarus Music.app'
  const executable = `${app}/Contents/MacOS/clarus-music`
  const web = '/System/WebKit/com.apple.WebKit.WebContent'
  const gpu = '/System/WebKit/com.apple.WebKit.GPU'
  const networking = '/System/WebKit/com.apple.WebKit.Networking'
  const applications = parseLaunchServicesApplicationList(`
1) "Clarus Music" ASN:0x0-0x101:
    bundleID="com.ovo3ovo3ovo.clarusmusic"
    executable path="${executable}"
    pid = 4101 type="Foreground"
2) "Clarus Music Networking" ASN:0x0-0x102:
    bundleID="com.apple.WebKit.Networking"
    executable path="${networking}"
    pid = 4103
    childASNs: ASN:0x0-0x104:
3) "Clarus Music Graphics and Media" ASN:0x0-0x103:
    bundleID="com.apple.WebKit.GPU"
    executable path="${gpu}"
    pid = 4102
4) "Clarus Music Web Content" ASN:0x0-0x104:
    bundleID="com.apple.WebKit.WebContent"
    executable path="com.apple.WebKit.WebContent"
    pid = 4104
    parentASN="Clarus Music Networking" ASN:0x0-0x102:
`)
  const started = 'Sat Aug  8 23:26:25 2026'
  const snapshot = [
    { pid: 4101, ppid: 4000, start: started, path: executable, realpath: executable },
    { pid: 4102, ppid: 1, start: started, path: gpu, realpath: gpu },
    { pid: 4103, ppid: 1, start: started, path: networking, realpath: networking },
    { pid: 4104, ppid: 1, start: started, path: web, realpath: web },
  ]
  const attribution = attributeNewWebKitProcessSet({
    rootPid: 4101,
    bundle: {
      appBundlePath: app,
      executablePath: executable,
      executableRealpath: executable,
      bundleId: 'com.ovo3ovo3ovo.clarusmusic',
    },
    baselinePids: new Set([4000]),
    snapshot,
    applications,
    helperPaths: { 'web-content': web, gpu, networking },
  })
  assert.equal(attribution.method, 'launchservices-new-helper-set')
  assert.deepEqual(
    attribution.selected.map(({ role, pid }) => [role, pid]),
    [
      ['main', 4101],
      ['web-content', 4104],
      ['gpu', 4102],
      ['networking', 4103],
    ],
  )
  assert.throws(
    () =>
      attributeNewWebKitProcessSet({
        rootPid: 4101,
        bundle: {
          appBundlePath: app,
          executablePath: executable,
          executableRealpath: executable,
          bundleId: 'com.ovo3ovo3ovo.clarusmusic',
        },
        baselinePids: new Set([4104]),
        snapshot,
        applications,
        helperPaths: { 'web-content': web, gpu, networking },
      }),
    /one exact new web-content/i,
  )
})
