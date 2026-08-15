import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  lstat,
  open,
  mkdir,
  readFile,
  readdir,
  realpath,
  readlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { URL } from 'node:url'

import { createFixtureRangeServer } from '../fixtures/range-server.mjs'
import { DEFAULT_RECIPE_MANIFEST_PATH } from '../fixtures/fixture-spec.mjs'
import { parseFootprintOutput } from '../sampling/external-sampler.mjs'
import {
  captureMacosAttribution,
  DEFAULT_HELPER_PATHS,
  parsePsSnapshot,
  readReleaseBundle,
} from '../sampling/pid-attribution.mjs'
import {
  DEFAULT_APP_BUNDLE,
  MAX_RECOVERY_SECONDS,
  MIN_RECOVERY_SECONDS,
  REPOSITORY_ROOT,
} from './cli-support.mjs'

export const SELF_RUN_SCHEMA_VERSION = 2
export const SAMPLE_INTERVAL_MS = 1_000
export const PERFORMANCE_GATES = Object.freeze({
  maximumWebContentPeakBytes: 200 * 1024 * 1024,
  maximumRecoveryStableBytes: 200 * 1024 * 1024,
  maximumRecoverySlopeBytesPerSecond: 64 * 1024,
  maximumImageFailures: 0,
  maximumImageReloads: 0,
  maximumVisibleBlankCovers: 0,
  maximumActiveImageRequestsAtCompletion: 0,
  maximumActiveRequestsAtCompletion: 0,
  minimumPlaybackAdvancingSamples: 8,
  minimumRecoveryPlaybackWraps: 1,
  requiredPlaybackSourceKind: 'remote',
  requiredPlaybackSourceProvenance: 'performance-fixture',
  requiredPlaybackFallbackReason: null,
  minimumFixtureRangeRequests: 1,
  maximumFrameP95Ms: 12.5,
  minimumRecoverySeconds: MIN_RECOVERY_SECONDS,
  stableWindowSeconds: 60,
})
const PHYSICAL_FOOTPRINT_SUMMARY_ROLES = Object.freeze([
  { key: 'webContent', role: 'web-content', label: 'WebContent' },
  { key: 'gpu', role: 'gpu', label: 'GPU' },
  { key: 'networking', role: 'networking', label: 'Networking' },
  { key: 'main', role: 'main', label: 'main' },
  { key: 'total', role: 'total', label: 'total' },
])
const ATTRIBUTED_PROCESS_ROLES = Object.freeze(['main', 'web-content', 'gpu', 'networking'])
const FIXED_ENVIRONMENT = Object.freeze({ LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' })
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024
const PHASES = new Set(['ready', 'dfs', 'recovery', 'complete', 'failed'])
const START_SIGNAL_CONTENTS = 'start\n'

export class SelfRunError extends Error {
  constructor(message, { cause, reportPath } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'SelfRunError'
    this.reportPath = reportPath
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorDetails(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'Error',
  }
}

function appendBounded(chunks, chunk, state, label) {
  const value = Buffer.from(chunk)
  state.bytes += value.byteLength
  if (state.bytes > MAX_COMMAND_OUTPUT_BYTES) {
    throw new SelfRunError(`${label} exceeded the bounded output limit`)
  }
  chunks.push(value)
}

export function runFixedCommand(executable, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd: options.cwd,
      env: options.env ?? FIXED_ENVIRONMENT,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    const stdoutState = { bytes: 0 }
    const stderrState = { bytes: 0 }
    let outputFailure
    child.stdout.on('data', (chunk) => {
      try {
        appendBounded(stdout, chunk, stdoutState, `${executable} stdout`)
      } catch (error) {
        outputFailure = error
        child.kill('SIGKILL')
      }
    })
    child.stderr.on('data', (chunk) => {
      try {
        appendBounded(stderr, chunk, stderrState, `${executable} stderr`)
      } catch (error) {
        outputFailure = error
        child.kill('SIGKILL')
      }
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (outputFailure) {
        reject(outputFailure)
        return
      }
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code !== 0) {
        reject(
          new SelfRunError(
            `${executable} exited with ${signal ?? `status ${String(code)}`}: ${result.stderr.trim()}`,
          ),
        )
        return
      }
      resolve(result)
    })
  })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Request metrics contain potentially unbounded per-resource maps.  Samples
// are retained once per second for the whole run, so only keep the fixed-size
// counters (and the fixed-size image-cache counters) in each sample.  The
// complete snapshot is captured separately for report.fixture.requestMetrics.
const FIXTURE_REQUEST_SCALAR_KEYS = Object.freeze([
  'activeRequests',
  'totalRequests',
  'completedRequests',
  'failedRequests',
  'rangeRequests',
  'bytesSent',
])
const PERFORMANCE_IMAGE_CACHE_SCALAR_KEYS = Object.freeze(['bytes', 'entries', 'hits', 'misses'])

function compactMetricScalar(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Keep only bounded scalar fixture evidence for one periodic sample.
 *
 * In particular, do not copy `byFilename` or `byCacheKey`: those maps are
 * cumulative and may contain one entry for every image resource visited.
 */
export function compactFixtureRequestMetrics(metrics) {
  if (!isRecord(metrics)) return null
  const compact = Object.fromEntries(
    FIXTURE_REQUEST_SCALAR_KEYS.map((key) => [key, compactMetricScalar(metrics[key])]),
  )
  const imageCache = metrics.performanceImageCache
  compact.performanceImageCache = isRecord(imageCache)
    ? Object.fromEntries(
        PERFORMANCE_IMAGE_CACHE_SCALAR_KEYS.map((key) => [
          key,
          compactMetricScalar(imageCache[key]),
        ]),
      )
    : null
  return compact
}

function finiteOrNull(value, label) {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SelfRunError(`Performance checkpoint ${label} is invalid`)
  }
  return value
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SelfRunError(`Performance checkpoint ${label} is invalid`)
  }
  return value
}

function validateTelemetryCounter(value, label) {
  return boundedInteger(value, label, 0, 1_000_000_000)
}

function validatePlaybackSourceUrl(value, schemaVersion) {
  if (value === undefined && schemaVersion === 1) return null
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new SelfRunError('Performance checkpoint playback sourceUrl is invalid')
  }
  try {
    new URL(value)
  } catch {
    throw new SelfRunError('Performance checkpoint playback sourceUrl is invalid')
  }
  return value
}

function validatePlaybackSourceProvenance(value, schemaVersion) {
  if (value === undefined && schemaVersion === 1) return null
  if (value === null) return null
  if (value !== 'performance-fixture') {
    throw new SelfRunError('Performance checkpoint playback sourceProvenance is invalid')
  }
  return value
}

function validatePlaybackRepeatMode(value, schemaVersion) {
  if (schemaVersion < 3) return 'unknown'
  if (!['off', 'all', 'one', 'unknown'].includes(value)) {
    throw new SelfRunError('Performance checkpoint playback repeatMode is invalid')
  }
  return value
}

function validateRecoveryPlaybackCounter(value, label, schemaVersion) {
  // Checkpoint schemas v1/v2 predate recovery playback evidence. Preserve
  // their ability to be read, but normalize absent evidence to values that
  // cannot satisfy the v3 continuity gate.
  return schemaVersion < 3 ? 0 : validateTelemetryCounter(value, label)
}

function defaultTelemetry() {
  return {
    images: {
      elements: 0,
      visibleElements: 0,
      loaded: 0,
      failed: 0,
      blank: 0,
      blankEvents: 0,
      loadEvents: 0,
      errorEvents: 0,
      reloads: 0,
      activeRequests: 0,
      requestStarts: 0,
      requestCompletions: 0,
      requestFailures: 0,
    },
    requests: { active: 0, started: 0, completed: 0, failed: 0 },
    playback: {
      state: 'unknown',
      repeatMode: 'unknown',
      sourceKind: 'none',
      sourceUrl: null,
      sourceProvenance: null,
      fallbackReason: null,
      currentTime: 0,
      duration: 0,
      samples: 0,
      advancingSamples: 0,
      maximumAdvanceSeconds: 0,
      firstProgressAt: null,
      lastProgressAt: null,
      recoverySamples: 0,
      recoveryExactFixtureSamples: 0,
      recoveryPlayingSamples: 0,
      recoveryRepeatOneSamples: 0,
      recoveryAdvancingSamples: 0,
      recoveryWraps: 0,
      recoveryStalledSamples: 0,
    },
    routeTransitions: 0,
    events: [],
  }
}

function validatePerformanceTelemetry(value, schemaVersion) {
  if (value === undefined && schemaVersion === 1) return defaultTelemetry()
  if (
    !isRecord(value) ||
    !isRecord(value.images) ||
    !isRecord(value.requests) ||
    !isRecord(value.playback)
  ) {
    throw new SelfRunError('Performance checkpoint telemetry is invalid')
  }
  const imageKeys = [
    'elements',
    'visibleElements',
    'loaded',
    'failed',
    'blank',
    'blankEvents',
    'loadEvents',
    'errorEvents',
    'reloads',
    'activeRequests',
    'requestStarts',
    'requestCompletions',
    'requestFailures',
  ]
  const images = Object.fromEntries(
    imageKeys.map((key) => [
      key,
      validateTelemetryCounter(value.images[key], `telemetry.images.${key}`),
    ]),
  )
  if (
    images.loaded > images.elements ||
    images.failed > images.elements ||
    images.visibleElements > images.elements
  ) {
    throw new SelfRunError('Performance checkpoint image telemetry is inconsistent')
  }
  const requests = {
    active: validateTelemetryCounter(value.requests.active, 'telemetry.requests.active'),
    started: validateTelemetryCounter(value.requests.started, 'telemetry.requests.started'),
    completed: validateTelemetryCounter(value.requests.completed, 'telemetry.requests.completed'),
    failed: validateTelemetryCounter(value.requests.failed, 'telemetry.requests.failed'),
  }
  if (requests.active > requests.started || requests.completed > requests.started) {
    throw new SelfRunError('Performance checkpoint request telemetry is inconsistent')
  }
  const playback = value.playback
  if (
    typeof playback.state !== 'string' ||
    !['managed-url', 'remote', 'none'].includes(playback.sourceKind) ||
    (typeof playback.fallbackReason !== 'string' && playback.fallbackReason !== null) ||
    typeof playback.currentTime !== 'number' ||
    !Number.isFinite(playback.currentTime) ||
    playback.currentTime < 0 ||
    typeof playback.duration !== 'number' ||
    !Number.isFinite(playback.duration) ||
    playback.duration < 0 ||
    typeof playback.maximumAdvanceSeconds !== 'number' ||
    !Number.isFinite(playback.maximumAdvanceSeconds) ||
    playback.maximumAdvanceSeconds < 0 ||
    (typeof playback.firstProgressAt !== 'string' && playback.firstProgressAt !== null) ||
    (typeof playback.lastProgressAt !== 'string' && playback.lastProgressAt !== null)
  ) {
    throw new SelfRunError('Performance checkpoint playback telemetry is invalid')
  }
  const normalizedPlayback = {
    state: playback.state,
    repeatMode: validatePlaybackRepeatMode(playback.repeatMode, schemaVersion),
    sourceKind: playback.sourceKind,
    sourceUrl: validatePlaybackSourceUrl(playback.sourceUrl, schemaVersion),
    sourceProvenance: validatePlaybackSourceProvenance(playback.sourceProvenance, schemaVersion),
    fallbackReason: playback.fallbackReason,
    currentTime: playback.currentTime,
    duration: playback.duration,
    samples: validateTelemetryCounter(playback.samples, 'telemetry.playback.samples'),
    advancingSamples: validateTelemetryCounter(
      playback.advancingSamples,
      'telemetry.playback.advancingSamples',
    ),
    maximumAdvanceSeconds: playback.maximumAdvanceSeconds,
    firstProgressAt: playback.firstProgressAt,
    lastProgressAt: playback.lastProgressAt,
    recoverySamples: validateRecoveryPlaybackCounter(
      playback.recoverySamples,
      'telemetry.playback.recoverySamples',
      schemaVersion,
    ),
    recoveryExactFixtureSamples: validateRecoveryPlaybackCounter(
      playback.recoveryExactFixtureSamples,
      'telemetry.playback.recoveryExactFixtureSamples',
      schemaVersion,
    ),
    recoveryPlayingSamples: validateRecoveryPlaybackCounter(
      playback.recoveryPlayingSamples,
      'telemetry.playback.recoveryPlayingSamples',
      schemaVersion,
    ),
    recoveryRepeatOneSamples: validateRecoveryPlaybackCounter(
      playback.recoveryRepeatOneSamples,
      'telemetry.playback.recoveryRepeatOneSamples',
      schemaVersion,
    ),
    recoveryAdvancingSamples: validateRecoveryPlaybackCounter(
      playback.recoveryAdvancingSamples,
      'telemetry.playback.recoveryAdvancingSamples',
      schemaVersion,
    ),
    recoveryWraps: validateRecoveryPlaybackCounter(
      playback.recoveryWraps,
      'telemetry.playback.recoveryWraps',
      schemaVersion,
    ),
    recoveryStalledSamples: validateRecoveryPlaybackCounter(
      playback.recoveryStalledSamples,
      'telemetry.playback.recoveryStalledSamples',
      schemaVersion,
    ),
  }
  const recoveryTransitions = Math.max(0, normalizedPlayback.recoverySamples - 1)
  if (
    normalizedPlayback.advancingSamples > normalizedPlayback.samples ||
    normalizedPlayback.recoveryExactFixtureSamples > normalizedPlayback.recoverySamples ||
    normalizedPlayback.recoveryPlayingSamples > normalizedPlayback.recoverySamples ||
    normalizedPlayback.recoveryRepeatOneSamples > normalizedPlayback.recoverySamples ||
    normalizedPlayback.recoveryAdvancingSamples > recoveryTransitions ||
    normalizedPlayback.recoveryWraps > recoveryTransitions ||
    normalizedPlayback.recoveryStalledSamples > recoveryTransitions ||
    normalizedPlayback.recoveryAdvancingSamples +
      normalizedPlayback.recoveryWraps +
      normalizedPlayback.recoveryStalledSamples >
      recoveryTransitions
  ) {
    throw new SelfRunError('Performance checkpoint playback telemetry is inconsistent')
  }
  if (!Array.isArray(value.events) || value.events.length > 256) {
    throw new SelfRunError('Performance checkpoint telemetry trace is invalid')
  }
  const events = value.events.map((event) => {
    if (
      !isRecord(event) ||
      typeof event.at !== 'string' ||
      Number.isNaN(Date.parse(event.at)) ||
      typeof event.type !== 'string' ||
      typeof event.route !== 'string'
    ) {
      throw new SelfRunError('Performance checkpoint telemetry trace is invalid')
    }
    let detail
    if (event.detail !== undefined) {
      if (!isRecord(event.detail))
        throw new SelfRunError('Performance checkpoint telemetry trace is invalid')
      detail = Object.fromEntries(
        Object.entries(event.detail).filter(
          ([, item]) =>
            item === null ||
            typeof item === 'string' ||
            typeof item === 'number' ||
            typeof item === 'boolean',
        ),
      )
    }
    return {
      at: new Date(event.at).toISOString(),
      type: event.type,
      route: event.route,
      ...(detail === undefined ? {} : { detail }),
    }
  })
  return {
    images,
    requests,
    playback: normalizedPlayback,
    routeTransitions: validateTelemetryCounter(
      value.routeTransitions,
      'telemetry.routeTransitions',
    ),
    events,
  }
}

export function validatePerformanceCheckpoint(value) {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) ||
    value.scenario !== 'artist-dfs-v1' ||
    !PHASES.has(value.phase) ||
    typeof value.startedAt !== 'string' ||
    Number.isNaN(Date.parse(value.startedAt)) ||
    typeof value.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(value.updatedAt)) ||
    (typeof value.failure !== 'string' && value.failure !== null) ||
    !isRecord(value.frames) ||
    !isRecord(value.runtime)
  ) {
    throw new SelfRunError('Performance checkpoint is malformed')
  }
  const iterationsRequested = boundedInteger(
    value.iterationsRequested,
    'iterationsRequested',
    50,
    100,
  )
  const iterationsCompleted = boundedInteger(
    value.iterationsCompleted,
    'iterationsCompleted',
    0,
    iterationsRequested,
  )
  const recoverySecondsElapsed = boundedInteger(
    value.recoverySecondsElapsed,
    'recoverySecondsElapsed',
    0,
    MAX_RECOVERY_SECONDS,
  )
  const frames = {
    sampleCount: boundedInteger(value.frames.sampleCount, 'frames.sampleCount', 0, 1_000_000),
    meanMs: finiteOrNull(value.frames.meanMs, 'frames.meanMs'),
    p50Ms: finiteOrNull(value.frames.p50Ms, 'frames.p50Ms'),
    p95Ms: finiteOrNull(value.frames.p95Ms, 'frames.p95Ms'),
    p99Ms: finiteOrNull(value.frames.p99Ms, 'frames.p99Ms'),
    over16ms: boundedInteger(value.frames.over16ms, 'frames.over16ms', 0, 1_000_000),
    over32ms: boundedInteger(value.frames.over32ms, 'frames.over32ms', 0, 1_000_000),
  }
  if (
    typeof value.runtime.domNodes !== 'number' ||
    !Number.isSafeInteger(value.runtime.domNodes) ||
    value.runtime.domNodes < 0 ||
    typeof value.runtime.imageElements !== 'number' ||
    !Number.isSafeInteger(value.runtime.imageElements) ||
    value.runtime.imageElements < 0 ||
    typeof value.runtime.mediaElements !== 'number' ||
    !Number.isSafeInteger(value.runtime.mediaElements) ||
    value.runtime.mediaElements < 0 ||
    typeof value.runtime.coverElements !== 'number' ||
    !Number.isSafeInteger(value.runtime.coverElements) ||
    value.runtime.coverElements < 0 ||
    typeof value.runtime.loadedCoverElements !== 'number' ||
    !Number.isSafeInteger(value.runtime.loadedCoverElements) ||
    value.runtime.loadedCoverElements < 0 ||
    value.runtime.loadedCoverElements > value.runtime.coverElements ||
    typeof value.runtime.failedCoverElements !== 'number' ||
    !Number.isSafeInteger(value.runtime.failedCoverElements) ||
    value.runtime.failedCoverElements < 0 ||
    value.runtime.failedCoverElements > value.runtime.coverElements ||
    typeof value.runtime.route !== 'string'
  ) {
    throw new SelfRunError('Performance checkpoint runtime snapshot is invalid')
  }
  const telemetry = validatePerformanceTelemetry(value.telemetry, value.schemaVersion)
  return {
    schemaVersion: value.schemaVersion,
    scenario: 'artist-dfs-v1',
    phase: value.phase,
    startedAt: new Date(value.startedAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
    iterationsRequested,
    iterationsCompleted,
    recoverySecondsElapsed,
    frames,
    runtime: {
      domNodes: value.runtime.domNodes,
      imageElements: value.runtime.imageElements,
      mediaElements: value.runtime.mediaElements,
      coverElements: value.runtime.coverElements,
      loadedCoverElements: value.runtime.loadedCoverElements,
      failedCoverElements: value.runtime.failedCoverElements,
      route: value.runtime.route,
    },
    telemetry,
    failure: value.failure,
  }
}

export async function readPerformanceCheckpoint(pathname) {
  let contents
  try {
    contents = await readFile(pathname, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    throw new SelfRunError('Performance checkpoint was not valid JSON', { cause: error })
  }
  return validatePerformanceCheckpoint(parsed)
}

export function parseProcessStatistics(cpuOutput, threadOutput, expectedPid) {
  const lines = String(cpuOutput)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  if (lines.length !== 1) throw new SelfRunError('ps returned an unexpected process count')
  const match = /^\s*(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s*$/.exec(lines[0])
  if (!match || Number(match[1]) !== expectedPid) {
    throw new SelfRunError('ps returned malformed or mismatched process statistics')
  }
  const cpuPercent = Number(match[2])
  const threadLines = String(threadOutput)
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim().length > 0)
  const threadCount = threadLines.filter((line) => {
    const fields = line.trim().split(/\s+/)
    const pid = /^\d+$/.test(fields[0] ?? '') ? Number(fields[0]) : Number(fields[1])
    return pid === expectedPid
  }).length
  if (!Number.isFinite(cpuPercent) || threadCount < 1) {
    throw new SelfRunError('ps returned invalid process statistics')
  }
  return { cpuPercent, threadCount }
}

/** Parse `ps -o pid= -o rss=` where RSS is reported in KiB on macOS. */
export function parseResidentSetOutput(output, expectedPid) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length !== 1) throw new SelfRunError('ps returned an unexpected resident-set count')
  const match = /^(\d+)\s+(\d+)$/.exec(lines[0])
  if (!match || Number(match[1]) !== expectedPid) {
    throw new SelfRunError('ps returned malformed or mismatched resident-set statistics')
  }
  const kib = Number(match[2])
  if (!Number.isSafeInteger(kib) || kib < 0 || kib > Math.floor(Number.MAX_SAFE_INTEGER / 1024)) {
    throw new SelfRunError('ps returned an invalid resident-set value')
  }
  return kib * 1024
}

export function parseLaunchServicesApplicationList(output) {
  const blocks = String(output)
    .split(/(?=^\s*\d+\)\s)/m)
    .filter((block) => block.trim().length > 0)
  const records = []
  for (const block of blocks) {
    const header = /^\s*\d+\)\s+"([^"]+)"\s+ASN:([^:\s]+):/m.exec(block)
    const pid = /(?:^|\n)\s*pid\s*=\s*(\d+)/m.exec(block)
    const bundleId = /(?:^|\n)\s*bundleID="([^"]+)"/m.exec(block)
    const executablePath = /(?:^|\n)\s*executable path="([^"]+)"/m.exec(block)
    if (!header || !pid || !bundleId) continue
    const parentAsn = /(?:^|\n)\s*parentASN=.*?\sASN:([^:\s]+):/m.exec(block)?.[1] ?? null
    const childLine = /(?:^|\n)\s*childASNs:\s*([^\n]+)/m.exec(block)?.[1] ?? ''
    const childAsns = [...childLine.matchAll(/ASN:([^:\s]+):/g)].map((match) => match[1])
    records.push({
      name: header[1],
      asn: header[2],
      pid: Number(pid[1]),
      bundleId: bundleId[1],
      executablePath: executablePath?.[1] ?? null,
      parentAsn,
      childAsns,
    })
  }
  if (records.length === 0) {
    throw new SelfRunError('lsappinfo list contained no attributable application records')
  }
  return records
}

function processStartMilliseconds(value) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new SelfRunError('Process start identity was not parseable')
  return parsed
}

export function attributeNewWebKitProcessSet({
  rootPid,
  bundle,
  baselinePids,
  snapshot,
  applications,
  helperPaths,
}) {
  const appName = basename(bundle.appBundlePath, '.app')
  const root = snapshot.find(({ pid }) => pid === rootPid)
  if (
    !root ||
    root.path !== bundle.executableRealpath ||
    root.realpath !== bundle.executableRealpath
  ) {
    throw new SelfRunError('Launched root process no longer matches the exact Release executable')
  }
  const rootApplications = applications.filter(
    (record) =>
      record.pid === rootPid &&
      record.name === appName &&
      record.bundleId === bundle.bundleId &&
      record.executablePath === bundle.executablePath,
  )
  if (rootApplications.length !== 1) {
    throw new SelfRunError('LaunchServices did not expose one exact launched root application')
  }
  const rootApplication = rootApplications[0]
  const rootStarted = processStartMilliseconds(root.start)
  const specifications = [
    {
      role: 'web-content',
      name: `${appName} Web Content`,
      bundleId: 'com.apple.WebKit.WebContent',
    },
    {
      role: 'gpu',
      name: `${appName} Graphics and Media`,
      bundleId: 'com.apple.WebKit.GPU',
    },
    {
      role: 'networking',
      name: `${appName} Networking`,
      bundleId: 'com.apple.WebKit.Networking',
    },
  ]
  const selected = [{ role: 'main', ...root }]
  const selectedApplications = new Map()
  for (const specification of specifications) {
    const expectedPath = helperPaths[specification.role]
    const candidates = applications.filter((application) => {
      if (
        baselinePids.has(application.pid) ||
        application.name !== specification.name ||
        application.bundleId !== specification.bundleId
      ) {
        return false
      }
      const processRecord = snapshot.find(({ pid }) => pid === application.pid)
      if (
        !processRecord ||
        processRecord.path !== expectedPath ||
        processRecord.realpath !== expectedPath
      ) {
        return false
      }
      const startDelta = processStartMilliseconds(processRecord.start) - rootStarted
      return startDelta >= 0 && startDelta <= 5_000
    })
    if (candidates.length !== 1) {
      throw new SelfRunError(
        `LaunchServices did not expose one exact new ${specification.role} helper for the launched app`,
      )
    }
    const application = candidates[0]
    const processRecord = snapshot.find(({ pid }) => pid === application.pid)
    selectedApplications.set(specification.role, application)
    selected.push({ role: specification.role, ...processRecord })
  }
  const networking = selectedApplications.get('networking')
  const webContent = selectedApplications.get('web-content')
  if (webContent.parentAsn !== networking.asn || !networking.childAsns.includes(webContent.asn)) {
    throw new SelfRunError(
      'LaunchServices networking/WebContent parent-child evidence did not match the launched app',
    )
  }
  return {
    method: 'launchservices-new-helper-set',
    rootPid,
    coalition: { id: `launch-group:${rootApplication.asn}`, asn: rootApplication.asn },
    selected,
    unselected: [],
  }
}

async function captureProcessSnapshot(runCommand) {
  const ps = await runCommand('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,comm='], {
    env: FIXED_ENVIRONMENT,
  })
  return parsePsSnapshot(ps.stdout)
}

async function captureLaunchedAttribution({ rootPid, bundle, baselinePids, runCommand }) {
  const rawSnapshot = await captureProcessSnapshot(runCommand)
  const relevantBasenames = new Set([
    basename(bundle.executablePath),
    ...Object.values(DEFAULT_HELPER_PATHS).map((pathname) => basename(pathname)),
  ])
  const snapshot = []
  for (const processRecord of rawSnapshot) {
    if (processRecord.pid !== rootPid && !relevantBasenames.has(basename(processRecord.path))) {
      continue
    }
    const resolvedPath = await realpath(processRecord.path)
    snapshot.push({ ...processRecord, path: resolvedPath, realpath: resolvedPath })
  }
  const helperPaths = {}
  for (const [role, pathname] of Object.entries(DEFAULT_HELPER_PATHS)) {
    helperPaths[role] = await realpath(pathname)
  }
  const listed = await runCommand('/usr/bin/lsappinfo', ['list'], { env: FIXED_ENVIRONMENT })
  return attributeNewWebKitProcessSet({
    rootPid,
    bundle,
    baselinePids,
    snapshot,
    applications: parseLaunchServicesApplicationList(listed.stdout),
    helperPaths,
  })
}

async function assertProcessIdentities(attribution, runCommand) {
  const selected = attribution.selected
  const ps = await runCommand(
    '/bin/ps',
    [
      '-ww',
      ...selected.flatMap(({ pid }) => ['-p', String(pid)]),
      '-o',
      'pid=,ppid=,lstart=,comm=',
    ],
    { env: FIXED_ENVIRONMENT },
  )
  const current = parsePsSnapshot(ps.stdout)
  for (const expected of selected) {
    const observed = current.find(({ pid }) => pid === expected.pid)
    if (!observed || observed.start !== expected.start) {
      throw new SelfRunError(`${expected.role} process identity changed during sampling`)
    }
    let resolvedPath
    try {
      resolvedPath = await realpath(observed.path)
    } catch (error) {
      throw new SelfRunError(`Unable to resolve ${expected.role} process path`, { cause: error })
    }
    if (resolvedPath !== expected.realpath) {
      throw new SelfRunError(`${expected.role} executable changed during sampling`)
    }
  }
}

async function sampleWebContent({
  attribution,
  checkpoint,
  index,
  startedMilliseconds,
  runCommand,
  fixtureMetricsProvider,
}) {
  const selected = attribution.selected
  const webContent = selected.find(({ role }) => role === 'web-content')
  if (!webContent) throw new SelfRunError('Attributed WebContent process is missing')
  await assertProcessIdentities(attribution, runCommand)
  const sampleStarted = Date.now()
  const processSamples = await Promise.all(
    selected.map(async (process) => {
      const [cpuResult, threadResult, rssResult, footprintResult] = await Promise.all([
        runCommand('/bin/ps', ['-p', String(process.pid), '-o', 'pid=', '-o', '%cpu='], {
          env: FIXED_ENVIRONMENT,
        }),
        runCommand('/bin/ps', ['-M', '-p', String(process.pid)], {
          env: FIXED_ENVIRONMENT,
        }),
        runCommand('/bin/ps', ['-p', String(process.pid), '-o', 'pid=', '-o', 'rss='], {
          env: FIXED_ENVIRONMENT,
        }),
        runCommand('/usr/bin/footprint', ['--format', 'bytes', '-p', String(process.pid)], {
          env: FIXED_ENVIRONMENT,
        }),
      ])
      const statistics = parseProcessStatistics(cpuResult.stdout, threadResult.stdout, process.pid)
      const footprint = parseFootprintOutput(footprintResult.stdout)
      return {
        role: process.role,
        processName:
          process.role === 'main'
            ? 'Clarus Music'
            : process.role === 'web-content'
              ? 'Clarus Music Web Content'
              : process.role === 'gpu'
                ? 'Clarus Music Graphics and Media'
                : 'Clarus Music Networking',
        pid: process.pid,
        rssBytes: parseResidentSetOutput(rssResult.stdout, process.pid),
        physicalFootprintBytes: footprint.physicalFootprintBytes,
        physicalFootprintPeakBytes: footprint.physicalFootprintPeakBytes,
        cpuPercent: statistics.cpuPercent,
        threadCount: statistics.threadCount,
      }
    }),
  )
  await assertProcessIdentities(attribution, runCommand)
  const byRole = Object.fromEntries(processSamples.map((process) => [process.role, process]))
  for (const role of ATTRIBUTED_PROCESS_ROLES) byRole[role] ??= null
  const webSample = byRole['web-content']
  if (!webSample) throw new SelfRunError('WebContent process sample is missing')
  const physicalFootprints = processSamples.map((process) => process.physicalFootprintBytes)
  const residentSets = processSamples.map((process) => process.rssBytes)
  return {
    index,
    observedAt: new Date(sampleStarted).toISOString(),
    elapsedMilliseconds: Date.now() - startedMilliseconds,
    phase: checkpoint.phase,
    iterationsCompleted: checkpoint.iterationsCompleted,
    recoverySecondsElapsed: checkpoint.recoverySecondsElapsed,
    physicalFootprintBytes: webSample.physicalFootprintBytes,
    physicalFootprintPeakBytes: webSample.physicalFootprintPeakBytes,
    rssBytes: webSample.rssBytes,
    cpuPercent: webSample.cpuPercent,
    threadCount: webSample.threadCount,
    processes: byRole,
    totalPhysicalFootprintBytes: physicalFootprints.every(Number.isFinite)
      ? physicalFootprints.reduce((total, value) => total + value, 0)
      : null,
    totalRssBytes: residentSets.every(Number.isFinite)
      ? residentSets.reduce((total, value) => total + value, 0)
      : null,
    checkpointTelemetry: checkpoint.telemetry,
    fixtureRequests: compactFixtureRequestMetrics(
      typeof fixtureMetricsProvider === 'function' ? fixtureMetricsProvider() : null,
    ),
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function isNonNegativeFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function maximumOrNull(values) {
  const known = values.filter(isNonNegativeFiniteNumber)
  return known.length > 0 ? Math.max(...known) : null
}

function leastSquaresSlope(
  samples,
  selectValue = ({ physicalFootprintBytes }) => physicalFootprintBytes,
) {
  if (samples.length < 2) return null
  const origin = samples[0].elapsedMilliseconds
  const points = samples.map((sample) => ({
    x: (sample.elapsedMilliseconds - origin) / 1_000,
    y: selectValue(sample),
  }))
  if (points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)) {
    return null
  }
  const xMean = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const yMean = points.reduce((sum, point) => sum + point.y, 0) / points.length
  const denominator = points.reduce((sum, point) => sum + (point.x - xMean) ** 2, 0)
  if (denominator === 0) return null
  return points.reduce((sum, point) => sum + (point.x - xMean) * (point.y - yMean), 0) / denominator
}

function peakPhysicalFootprint(sample) {
  return maximumOrNull([sample.physicalFootprintBytes, sample.physicalFootprintPeakBytes])
}

function sampleTelemetry(samples, checkpoint) {
  const latest = [...samples].reverse().find((sample) => sample.checkpointTelemetry)
  return latest?.checkpointTelemetry ?? checkpoint.telemetry ?? defaultTelemetry()
}

function normalizePerformanceEvidence(evidence) {
  if (!isRecord(evidence)) {
    return {
      telemetry: null,
      expectedAudioUrl: null,
      expectedAudioFilename: null,
      fixtureMetrics: null,
    }
  }
  // Keep the previous direct-telemetry argument accepted for callers that
  // consume this helper outside the runner. It cannot satisfy fixture gates
  // because it intentionally does not guess an injected fixture URL.
  if (isRecord(evidence.images) && isRecord(evidence.playback)) {
    return {
      telemetry: evidence,
      expectedAudioUrl: null,
      expectedAudioFilename: null,
      fixtureMetrics: null,
    }
  }
  return {
    telemetry: evidence.telemetry ?? null,
    expectedAudioUrl:
      typeof evidence.expectedAudioUrl === 'string' && evidence.expectedAudioUrl.length > 0
        ? evidence.expectedAudioUrl
        : null,
    expectedAudioFilename:
      typeof evidence.expectedAudioFilename === 'string' &&
      evidence.expectedAudioFilename.length > 0
        ? evidence.expectedAudioFilename
        : null,
    fixtureMetrics: isRecord(evidence.fixtureMetrics) ? evidence.fixtureMetrics : null,
  }
}

function fixtureAudioMetricEvidence(fixtureMetrics, expectedAudioFilename) {
  const rangeRequests = fixtureMetrics?.rangeRequests
  const byFilename = fixtureMetrics?.byFilename
  const audio =
    typeof expectedAudioFilename === 'string' &&
    isRecord(byFilename) &&
    Object.hasOwn(byFilename, expectedAudioFilename) &&
    isRecord(byFilename[expectedAudioFilename])
      ? byFilename[expectedAudioFilename]
      : null
  const requests = audio?.requests
  const failures = audio?.failures
  const bytesSent = audio?.bytesSent
  return {
    rangeRequests: isNonNegativeFiniteNumber(rangeRequests) ? rangeRequests : null,
    audioRequests: isNonNegativeFiniteNumber(requests) ? requests : null,
    audioFailures: isNonNegativeFiniteNumber(failures) ? failures : null,
    audioBytesSent: isNonNegativeFiniteNumber(bytesSent) ? bytesSent : null,
    audioResourceMatched:
      audio !== null &&
      isNonNegativeFiniteNumber(requests) &&
      requests > 0 &&
      isNonNegativeFiniteNumber(failures) &&
      // Terminating the app can cancel a speculative follow-up read. Require
      // at least one successful request for this exact fixture, rather than
      // incorrectly treating that shutdown-side cancellation as cache proof.
      failures < requests &&
      isNonNegativeFiniteNumber(bytesSent) &&
      bytesSent > 0,
  }
}

function playbackFixtureEvidence(telemetry, evidence) {
  const playback = telemetry.playback
  const fixture = fixtureAudioMetricEvidence(
    evidence.fixtureMetrics,
    evidence.expectedAudioFilename,
  )
  return {
    expectedAudioUrl: evidence.expectedAudioUrl,
    expectedAudioFilename: evidence.expectedAudioFilename,
    sourceKind: playback.sourceKind,
    sourceUrl: playback.sourceUrl,
    sourceProvenance: playback.sourceProvenance,
    fallbackReason: playback.fallbackReason,
    repeatMode: playback.repeatMode,
    recoverySamples: playback.recoverySamples,
    recoveryExactFixtureSamples: playback.recoveryExactFixtureSamples,
    recoveryPlayingSamples: playback.recoveryPlayingSamples,
    recoveryRepeatOneSamples: playback.recoveryRepeatOneSamples,
    recoveryAdvancingSamples: playback.recoveryAdvancingSamples,
    recoveryWraps: playback.recoveryWraps,
    recoveryStalledSamples: playback.recoveryStalledSamples,
    ...fixture,
  }
}

function currentFootprintForRole(sample, role) {
  if (role === 'total') {
    return isNonNegativeFiniteNumber(sample.totalPhysicalFootprintBytes)
      ? sample.totalPhysicalFootprintBytes
      : null
  }
  if (isRecord(sample.processes)) {
    const process = sample.processes[role]
    return isRecord(process) && isNonNegativeFiniteNumber(process.physicalFootprintBytes)
      ? process.physicalFootprintBytes
      : null
  }
  // Schema-v1 samples only exposed WebContent at the top level.
  return role === 'web-content' && isNonNegativeFiniteNumber(sample.physicalFootprintBytes)
    ? sample.physicalFootprintBytes
    : null
}

function peakFootprintForRole(sample, role) {
  if (role === 'total') return currentFootprintForRole(sample, role)
  if (isRecord(sample.processes)) {
    const process = sample.processes[role]
    if (!isRecord(process)) return null
    return maximumOrNull([process.physicalFootprintBytes, process.physicalFootprintPeakBytes])
  }
  return role === 'web-content'
    ? maximumOrNull([sample.physicalFootprintBytes, sample.physicalFootprintPeakBytes])
    : null
}

function summarizePhysicalFootprintRole({ samples, recoverySamples, stableWindow, role }) {
  const allValues = samples.map((sample) => peakFootprintForRole(sample, role))
  const recoveryValues = recoverySamples.map((sample) => currentFootprintForRole(sample, role))
  const finalWindowValues = stableWindow.map((sample) => currentFootprintForRole(sample, role))
  const finalWindowComplete =
    stableWindow.length === PERFORMANCE_GATES.stableWindowSeconds &&
    finalWindowValues.every(isNonNegativeFiniteNumber)
  const final60MedianBytes = finalWindowComplete ? median(finalWindowValues) : null
  const recoveryStartBytes = recoveryValues[0] ?? null
  return {
    peakBytes: maximumOrNull(allValues),
    final60MedianBytes,
    tailSlopeBytesPerSecond: finalWindowComplete
      ? leastSquaresSlope(stableWindow, (sample) => currentFootprintForRole(sample, role))
      : null,
    recoveryDropBytes:
      recoveryStartBytes === null || final60MedianBytes === null
        ? null
        : recoveryStartBytes - final60MedianBytes,
    recoveryStartBytes,
    observedSampleCount: allValues.filter(isNonNegativeFiniteNumber).length,
    missingSampleCount: allValues.filter((value) => value === null).length,
    recoveryObservedSampleCount: recoveryValues.filter(isNonNegativeFiniteNumber).length,
    recoveryMissingSampleCount: recoveryValues.filter((value) => value === null).length,
    final60WindowSampleCount: stableWindow.length,
    final60MissingSampleCount: finalWindowValues.filter((value) => value === null).length,
  }
}

function summarizePhysicalFootprints(samples, recoverySamples, stableWindow) {
  return Object.fromEntries(
    PHYSICAL_FOOTPRINT_SUMMARY_ROLES.map(({ key, role }) => [
      key,
      summarizePhysicalFootprintRole({ samples, recoverySamples, stableWindow, role }),
    ]),
  )
}

function maximumProcessRss(samples, role) {
  return maximumOrNull(
    samples.map((sample) => {
      if (!isRecord(sample.processes)) return role === 'web-content' ? sample.rssBytes : null
      const process = sample.processes[role]
      return isRecord(process) ? process.rssBytes : null
    }),
  )
}

export function evaluatePerformanceGates(summary, checkpoint, evidence = null) {
  const normalizedEvidence = normalizePerformanceEvidence(evidence)
  const telemetry = normalizedEvidence.telemetry ?? sampleTelemetry([], checkpoint)
  const images = telemetry.images
  const playback = telemetry.playback
  const fixturePlayback = playbackFixtureEvidence(telemetry, normalizedEvidence)
  const playbackSourceKind = playback.sourceKind === PERFORMANCE_GATES.requiredPlaybackSourceKind
  const playbackSourceProvenance =
    playback.sourceProvenance === PERFORMANCE_GATES.requiredPlaybackSourceProvenance
  const playbackSourceUrl =
    fixturePlayback.expectedAudioUrl !== null &&
    playback.sourceUrl === fixturePlayback.expectedAudioUrl
  const playbackNoFallback =
    playback.fallbackReason === PERFORMANCE_GATES.requiredPlaybackFallbackReason
  const recoveryPlaybackCoverage =
    checkpoint.schemaVersion === 3 &&
    playback.recoverySamples === checkpoint.recoverySecondsElapsed &&
    playback.recoverySamples >= PERFORMANCE_GATES.minimumRecoverySeconds
  const recoveryExactFixture =
    recoveryPlaybackCoverage &&
    playback.recoveryExactFixtureSamples === playback.recoverySamples &&
    playbackSourceKind &&
    playbackSourceProvenance &&
    playbackSourceUrl
  const recoveryPlaying =
    recoveryPlaybackCoverage &&
    playback.recoveryPlayingSamples === playback.recoverySamples &&
    playback.state === 'playing'
  const recoveryRepeatOne =
    recoveryPlaybackCoverage &&
    playback.recoveryRepeatOneSamples === playback.recoverySamples &&
    playback.repeatMode === 'one'
  const recoveryNoStalls = recoveryPlaybackCoverage && playback.recoveryStalledSamples === 0
  const recoveryProgressAndWrap =
    recoveryPlaybackCoverage &&
    playback.recoveryAdvancingSamples + playback.recoveryWraps === playback.recoverySamples - 1
  const recoveryWraps =
    recoveryPlaybackCoverage &&
    playback.recoveryWraps >= PERFORMANCE_GATES.minimumRecoveryPlaybackWraps
  const gates = {
    recoveryDuration: summary.recoveryDurationSeconds >= PERFORMANCE_GATES.minimumRecoverySeconds,
    stableWindow: summary.recoveryStableWindowSeconds >= PERFORMANCE_GATES.stableWindowSeconds,
    webContentPeak:
      summary.dfsPeakBytes !== null &&
      summary.dfsPeakBytes <= PERFORMANCE_GATES.maximumWebContentPeakBytes,
    recoveryStable:
      summary.recoveryStableBytes !== null &&
      summary.recoveryStableBytes <= PERFORMANCE_GATES.maximumRecoveryStableBytes,
    recoverySlope:
      summary.recoverySlopeBytesPerSecond !== null &&
      summary.recoverySlopeBytesPerSecond <= PERFORMANCE_GATES.maximumRecoverySlopeBytesPerSecond,
    imageFailures:
      images.failed + images.errorEvents + images.requestFailures <=
      PERFORMANCE_GATES.maximumImageFailures,
    imageReloads: images.reloads <= PERFORMANCE_GATES.maximumImageReloads,
    visibleBlankCovers:
      images.blank + images.blankEvents <= PERFORMANCE_GATES.maximumVisibleBlankCovers,
    activeImageRequests:
      images.activeRequests <= PERFORMANCE_GATES.maximumActiveImageRequestsAtCompletion,
    activeRequests:
      telemetry.requests.active <= PERFORMANCE_GATES.maximumActiveRequestsAtCompletion,
    playbackSource:
      playbackSourceKind && playbackSourceProvenance && playbackSourceUrl && playbackNoFallback,
    playbackSourceKind,
    playbackSourceProvenance,
    playbackSourceUrl,
    playbackNoFallback,
    fixtureRangeRequests:
      fixturePlayback.rangeRequests !== null &&
      fixturePlayback.rangeRequests >= PERFORMANCE_GATES.minimumFixtureRangeRequests,
    fixtureAudioIdentity: fixturePlayback.audioResourceMatched,
    playbackProgress:
      playback.advancingSamples >= PERFORMANCE_GATES.minimumPlaybackAdvancingSamples,
    recoveryPlaybackCoverage,
    recoveryExactFixture,
    recoveryPlaying,
    recoveryRepeatOne,
    recoveryNoStalls,
    recoveryProgressAndWrap,
    recoveryWraps,
    frameCadence:
      checkpoint.frames.p95Ms !== null &&
      checkpoint.frames.p95Ms <= PERFORMANCE_GATES.maximumFrameP95Ms &&
      checkpoint.frames.over16ms === 0,
  }
  return { pass: Object.values(gates).every(Boolean), gates, fixturePlayback }
}

export function computeSelfRunSummary(samples, checkpoint, evidence = null) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new SelfRunError('A self-run report requires at least one sample')
  }
  const dfsSamples = samples.filter(({ phase }) => phase === 'dfs')
  const recoverySamples = samples.filter(
    ({ phase }) => phase === 'recovery' || phase === 'complete',
  )
  const stableWindow = recoverySamples.slice(-Math.min(60, recoverySamples.length))
  const overallPeakBytes = maximumOrNull(samples.map(peakPhysicalFootprint))
  const dfsPeakBytes = dfsSamples.length
    ? maximumOrNull(dfsSamples.map(peakPhysicalFootprint))
    : null
  const stableBytes = median(
    stableWindow
      .map(({ physicalFootprintBytes }) => physicalFootprintBytes)
      .filter(isNonNegativeFiniteNumber),
  )
  const recoveryStartBytes = isNonNegativeFiniteNumber(recoverySamples[0]?.physicalFootprintBytes)
    ? recoverySamples[0].physicalFootprintBytes
    : null
  const recoveryDropBytes =
    recoveryStartBytes === null || stableBytes === null ? null : recoveryStartBytes - stableBytes
  const recoveryStableWindowSeconds =
    stableWindow.length > 1
      ? (stableWindow.at(-1).elapsedMilliseconds - stableWindow[0].elapsedMilliseconds) / 1_000 +
        SAMPLE_INTERVAL_MS / 1_000
      : 0
  const physicalFootprints = summarizePhysicalFootprints(samples, recoverySamples, stableWindow)
  const processPeaks = Object.fromEntries(
    PHYSICAL_FOOTPRINT_SUMMARY_ROLES.filter(({ role }) => role !== 'total').map(({ key, role }) => [
      role,
      physicalFootprints[key].peakBytes,
    ]),
  )
  const processRssPeaks = Object.fromEntries(
    ATTRIBUTED_PROCESS_ROLES.map((role) => [role, maximumProcessRss(samples, role)]),
  )
  const latestFixtureRequests =
    [...samples].reverse().find((sample) => sample.fixtureRequests)?.fixtureRequests ?? null
  const fixtureRequestMetrics = compactFixtureRequestMetrics(latestFixtureRequests)
  const summary = {
    sampleCount: samples.length,
    sampleIntervalTargetMs: SAMPLE_INTERVAL_MS,
    overallPeakBytes,
    dfsPeakBytes,
    recoveryStartBytes,
    recoveryStableBytes: stableBytes,
    recoveryStableWindowSamples: stableWindow.length,
    recoveryStableWindowSeconds,
    recoveryDurationSeconds: recoverySamples.length
      ? (recoverySamples.at(-1).elapsedMilliseconds - recoverySamples[0].elapsedMilliseconds) /
        1_000
      : 0,
    recoveryDropBytes,
    recoverySlopeBytesPerSecond: leastSquaresSlope(stableWindow),
    cpuP50Percent: percentile(
      samples.map(({ cpuPercent }) => cpuPercent).filter(isNonNegativeFiniteNumber),
      0.5,
    ),
    cpuP95Percent: percentile(
      samples.map(({ cpuPercent }) => cpuPercent).filter(isNonNegativeFiniteNumber),
      0.95,
    ),
    maximumThreadCount: maximumOrNull(samples.map(({ threadCount }) => threadCount)),
    maximumRssBytes: maximumOrNull(samples.map(({ rssBytes }) => rssBytes)),
    maximumTotalRssBytes: maximumOrNull(samples.map(({ totalRssBytes }) => totalRssBytes)),
    maximumTotalPhysicalFootprintBytes: physicalFootprints.total.peakBytes,
    physicalFootprints,
    processPeaks,
    processRssPeaks,
    fixtureRequestMetrics,
    frameP50Ms: checkpoint.frames.p50Ms,
    frameP95Ms: checkpoint.frames.p95Ms,
    frameP99Ms: checkpoint.frames.p99Ms,
    frameSampleCount: checkpoint.frames.sampleCount,
  }
  const performance = evaluatePerformanceGates(summary, checkpoint, {
    ...normalizePerformanceEvidence(evidence),
    telemetry: sampleTelemetry(samples, checkpoint),
  })
  return {
    ...summary,
    fixturePlaybackEvidence: performance.fixturePlayback,
    performancePass: performance.pass,
    performanceGates: performance.gates,
    // Keep the old names in machine reports for consumers of schema v1.
    dfsPeakAtOrBelow200MiB:
      dfsPeakBytes === null ? null : dfsPeakBytes <= PERFORMANCE_GATES.maximumWebContentPeakBytes,
    recoveryStableAtOrBelow200MiB:
      stableBytes === null ? null : stableBytes <= PERFORMANCE_GATES.maximumRecoveryStableBytes,
  }
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function renderSelfRunCsv(samples) {
  const keys = [
    'index',
    'observedAt',
    'elapsedMilliseconds',
    'phase',
    'iterationsCompleted',
    'recoverySecondsElapsed',
    'physicalFootprintBytes',
    'physicalFootprintPeakBytes',
    'rssBytes',
    'totalPhysicalFootprintBytes',
    'totalRssBytes',
    'cpuPercent',
    'threadCount',
    'imageFailed',
    'imageBlankEvents',
    'imageReloads',
    'activeImageRequests',
    'playbackCurrentTime',
    'playbackAdvancingSamples',
  ]
  return `${keys.join(',')}\r\n${samples
    .map((sample) => {
      const telemetry = sample.checkpointTelemetry ?? defaultTelemetry()
      const values = {
        ...sample,
        imageFailed: telemetry.images.failed + telemetry.images.errorEvents,
        imageBlankEvents: telemetry.images.blank + telemetry.images.blankEvents,
        imageReloads: telemetry.images.reloads,
        activeImageRequests: telemetry.images.activeRequests,
        playbackCurrentTime: telemetry.playback.currentTime,
        playbackAdvancingSamples: telemetry.playback.advancingSamples,
      }
      return keys.map((key) => csvCell(values[key])).join(',')
    })
    .join('\r\n')}\r\n`
}

function formatMiB(bytes) {
  return isNonNegativeFiniteNumber(bytes) ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : 'NA'
}

function formatBytesPerSecond(bytesPerSecond) {
  return typeof bytesPerSecond === 'number' && Number.isFinite(bytesPerSecond)
    ? `${bytesPerSecond.toFixed(1)} bytes/s`
    : 'NA'
}

function renderPhysicalFootprintSummary(summary) {
  return PHYSICAL_FOOTPRINT_SUMMARY_ROLES.map(({ key, label }) => {
    const metric = summary?.physicalFootprints?.[key]
    return `${label} footprint peak/final-60 median/tail slope/recovery drop: ${formatMiB(metric?.peakBytes)} / ${formatMiB(metric?.final60MedianBytes)} / ${formatBytesPerSecond(metric?.tailSlopeBytesPerSecond)} / ${formatMiB(metric?.recoveryDropBytes)} (missing samples: ${metric?.missingSampleCount ?? 'NA'}, final-60 missing: ${metric?.final60MissingSampleCount ?? 'NA'})`
  })
}

export function renderSelfRunSummary(report) {
  const { summary } = report
  const fixturePlayback = summary?.fixturePlaybackEvidence
  return [
    'Clarus Music unattended artist DFS performance run',
    `status: ${report.status}`,
    `scenario complete: ${report.scenarioComplete ?? false}`,
    `performance pass: ${report.performancePass ?? 'NA'}`,
    `output: ${report.outputDirectory}`,
    `source commit: ${report.source?.commit ?? 'NA'}`,
    `source dirty: ${report.source?.dirty ?? 'NA'}`,
    `bundle sha256: ${report.application.bundleSha256 ?? 'NA'}`,
    `release executable sha256: ${report.application.executableSha256}`,
    `WebContent pid: ${report.application.webContentPid ?? 'NA'}`,
    `samples: ${summary?.sampleCount ?? 0}`,
    `DFS current-footprint peak: ${formatMiB(summary?.dfsPeakBytes ?? null)}`,
    `recovery stable footprint: ${formatMiB(summary?.recoveryStableBytes ?? null)}`,
    `recovery drop: ${formatMiB(summary?.recoveryDropBytes ?? null)}`,
    `recovery slope: ${summary?.recoverySlopeBytesPerSecond?.toFixed(1) ?? 'NA'} bytes/s`,
    ...renderPhysicalFootprintSummary(summary),
    `image failures/reloads: ${report.checkpoint?.telemetry?.images?.failed ?? 'NA'} / ${report.checkpoint?.telemetry?.images?.reloads ?? 'NA'}`,
    `playback source/repeat/provenance/url: ${fixturePlayback?.sourceKind ?? 'NA'} / ${fixturePlayback?.repeatMode ?? 'NA'} / ${fixturePlayback?.sourceProvenance ?? 'NA'} / ${fixturePlayback?.sourceUrl ?? 'NA'}`,
    `playback expected fixture url: ${fixturePlayback?.expectedAudioUrl ?? 'NA'}`,
    `fixture range requests/audio identity: ${fixturePlayback?.rangeRequests ?? 'NA'} / ${fixturePlayback?.audioResourceMatched ?? false}`,
    `playback progress: ${report.checkpoint?.telemetry?.playback?.advancingSamples ?? 'NA'}`,
    `recovery playback samples/exact/playing/repeat-one/advancing/wraps/stalls: ${fixturePlayback?.recoverySamples ?? 'NA'} / ${fixturePlayback?.recoveryExactFixtureSamples ?? 'NA'} / ${fixturePlayback?.recoveryPlayingSamples ?? 'NA'} / ${fixturePlayback?.recoveryRepeatOneSamples ?? 'NA'} / ${fixturePlayback?.recoveryAdvancingSamples ?? 'NA'} / ${fixturePlayback?.recoveryWraps ?? 'NA'} / ${fixturePlayback?.recoveryStalledSamples ?? 'NA'}`,
    `frame p50/p95: ${summary?.frameP50Ms?.toFixed(2) ?? 'NA'} / ${summary?.frameP95Ms?.toFixed(2) ?? 'NA'} ms`,
    `failure: ${report.failure?.message ?? 'none'}`,
    '',
  ].join('\n')
}

function childCompletion(child) {
  return new Promise((resolve) => {
    child.once('error', (error) => resolve({ error, code: null, signal: null }))
    child.once('exit', (code, signal) => resolve({ error: null, code, signal }))
  })
}

async function launchApplication({ bundle, environment, outputDirectory, spawnProcess }) {
  const stdoutHandle = await open(join(outputDirectory, 'app.stdout.log'), 'wx', 0o600)
  const stderrHandle = await open(join(outputDirectory, 'app.stderr.log'), 'wx', 0o600)
  try {
    const child = spawnProcess(bundle.executablePath, [], {
      cwd: dirname(bundle.executablePath),
      env: environment,
      shell: false,
      stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
    })
    return { child, completion: childCompletion(child) }
  } finally {
    await Promise.all([stdoutHandle.close(), stderrHandle.close()])
  }
}

async function terminateExactChild(application) {
  if (!application?.child || application.child.exitCode !== null) return application?.completion
  application.child.kill('SIGTERM')
  const completed = await Promise.race([application.completion, delay(5_000).then(() => null)])
  if (completed) return completed
  application.child.kill('SIGKILL')
  return application.completion
}

async function waitForReady({ checkpointPath, application, timeoutSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1_000
  while (Date.now() < deadline) {
    const checkpoint = await readPerformanceCheckpoint(checkpointPath)
    if (checkpoint?.phase === 'ready') return checkpoint
    if (checkpoint?.phase === 'failed') {
      throw new SelfRunError(`Application failed before readiness: ${checkpoint.failure}`)
    }
    if (application.child.exitCode !== null) {
      const exit = await application.completion
      throw new SelfRunError(`Application exited before readiness: ${JSON.stringify(exit)}`)
    }
    await delay(100)
  }
  throw new SelfRunError('Timed out waiting for the application readiness checkpoint')
}

async function waitForAttribution({
  application,
  baselinePids,
  bundle,
  runCommand,
  timeoutSeconds,
}) {
  const deadline = Date.now() + timeoutSeconds * 1_000
  let lastError
  while (Date.now() < deadline) {
    if (application.child.exitCode !== null) {
      throw new SelfRunError('Application exited before WebContent attribution completed')
    }
    try {
      return await captureMacosAttribution({
        rootPid: application.child.pid,
        bundle,
        runCommand,
      })
    } catch {
      // Older macOS builds may omit a shared coalition ASN; the launched-set
      // attribution below uses the exact pre-launch PID witness instead.
    }
    try {
      return await captureLaunchedAttribution({
        rootPid: application.child.pid,
        baselinePids,
        bundle,
        runCommand,
      })
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new SelfRunError('Timed out strictly attributing the application WebContent process', {
    cause: lastError,
  })
}

function canonicalFixtureHash(lock) {
  return createHash('sha256')
    .update(`${JSON.stringify(lock)}\n`)
    .digest('hex')
}

function fixtureForRole(server, role) {
  return [...server.verifiedFixtureSet.filesByName.values()].find(
    ({ recipe }) => recipe.role === role,
  )
}

function selectedAttribution(attribution) {
  const appName = 'Clarus Music'
  const processNames = {
    main: appName,
    'web-content': `${appName} Web Content`,
    gpu: `${appName} Graphics and Media`,
    networking: `${appName} Networking`,
  }
  return {
    method: attribution.method,
    coalition: attribution.coalition,
    selected: attribution.selected.map(({ role, pid, start, path, realpath }) => ({
      role,
      processName: processNames[role] ?? role,
      pid,
      start,
      path,
      realpath,
    })),
  }
}

function commandOutputText(result) {
  return String(result?.stdout ?? '').trim()
}

export async function captureSourceProvenance({
  runCommand = runFixedCommand,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  const commit = commandOutputText(
    await runCommand('/usr/bin/git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], {
      env: FIXED_ENVIRONMENT,
    }),
  )
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new SelfRunError('Unable to record the current worktree commit')
  }
  const branch = commandOutputText(
    await runCommand('/usr/bin/git', ['-C', repositoryRoot, 'branch', '--show-current'], {
      env: FIXED_ENVIRONMENT,
    }),
  )
  const status = commandOutputText(
    await runCommand('/usr/bin/git', ['-C', repositoryRoot, 'status', '--porcelain=v1'], {
      env: FIXED_ENVIRONMENT,
    }),
  )
  return {
    commit: commit.toLowerCase(),
    branch: branch || null,
    dirty: status.length > 0,
    statusSha256: createHash('sha256').update(`${status}\n`).digest('hex'),
  }
}

export function bundleFingerprint(bundle) {
  if (!bundle || typeof bundle !== 'object') return null
  return createHash('sha256')
    .update(
      `${JSON.stringify({
        appBundlePath: bundle.appBundlePath,
        appBundleRealpath: bundle.appBundleRealpath,
        bundleId: bundle.bundleId,
        bundleVersion: bundle.bundleVersion,
        executablePath: bundle.executablePath,
        executableRealpath: bundle.executableRealpath,
        executableSha256: bundle.executableSha256,
      })}\n`,
    )
    .digest('hex')
}

/** Hash every bundle entry (including symlink targets) in deterministic order. */
export async function hashReleaseBundle(bundlePath) {
  const hash = createHash('sha256')
  async function visit(pathname, relativePath) {
    const entries = await readdir(pathname, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const childPath = join(pathname, entry.name)
      const childRelativePath = join(relativePath, entry.name)
      const metadata = await lstat(childPath)
      hash.update(`${childRelativePath}\0${metadata.mode}\0`)
      if (metadata.isSymbolicLink()) {
        hash.update(`symlink:${await readlink(childPath)}\n`)
      } else if (metadata.isDirectory()) {
        hash.update('directory\n')
        await visit(childPath, childRelativePath)
      } else if (metadata.isFile()) {
        hash.update('file\n')
        hash.update(await readFile(childPath))
        hash.update('\n')
      } else {
        throw new SelfRunError(`Unsupported entry in Release bundle: ${childRelativePath}`)
      }
    }
  }
  await visit(bundlePath, '')
  return hash.digest('hex')
}

export async function runSelfDrivenPerformance(options, dependencies = {}) {
  const runCommand = dependencies.runCommand ?? runFixedCommand
  const bundleReader = dependencies.readReleaseBundle ?? readReleaseBundle
  const rangeServerFactory = dependencies.createFixtureRangeServer ?? createFixtureRangeServer
  const spawnProcess = dependencies.spawnProcess ?? spawn
  const sourceProvenanceReader = dependencies.captureSourceProvenance ?? captureSourceProvenance
  const bundleHasher = dependencies.hashReleaseBundle ?? hashReleaseBundle
  const outputDirectory = options.output
  const canonicalBundlePath = resolve(DEFAULT_APP_BUNDLE)
  if (
    !Number.isSafeInteger(options.recoverySeconds) ||
    options.recoverySeconds < MIN_RECOVERY_SECONDS ||
    options.recoverySeconds > MAX_RECOVERY_SECONDS
  ) {
    throw new SelfRunError(
      `Recovery must be from ${MIN_RECOVERY_SECONDS} to ${MAX_RECOVERY_SECONDS} seconds`,
    )
  }
  if (
    !Number.isSafeInteger(options.iterations) ||
    options.iterations < 50 ||
    options.iterations > 100
  ) {
    throw new SelfRunError('Iterations must be from 50 to 100')
  }
  if (
    !Number.isSafeInteger(options.startupTimeoutSeconds) ||
    options.startupTimeoutSeconds < 30 ||
    options.startupTimeoutSeconds > 180
  ) {
    throw new SelfRunError('Startup timeout must be from 30 to 180 seconds')
  }
  if (typeof options.appBundle !== 'string' || resolve(options.appBundle) !== canonicalBundlePath) {
    throw new SelfRunError(
      'Self-driven performance runs may only use the current worktree canonical Release app',
    )
  }
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 })
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 })

  const checkpointPath = join(outputDirectory, 'checkpoint.json')
  const startSignalPath = join(outputDirectory, 'start.signal')
  const reportPath = join(outputDirectory, 'report.json')
  const samples = []
  let application
  let bundle
  let rangeServer
  let attribution
  let baselinePids
  let checkpoint
  let summary
  let failure
  let sourceProvenance
  let sourceProvenanceAfter
  let bundleSha256
  let bundleSha256After
  let fixtureMetrics
  let audioFixture
  let audioUrl
  const startedAt = new Date().toISOString()
  const startedMilliseconds = Date.now()

  try {
    sourceProvenance = await sourceProvenanceReader({ runCommand, repositoryRoot: REPOSITORY_ROOT })
    bundle = await bundleReader({
      appBundlePath: options.appBundle,
      expectedBundlePath: canonicalBundlePath,
      runCommand,
    })
    bundleSha256 = await bundleHasher(bundle.appBundlePath)
    rangeServer = await rangeServerFactory({
      directory: options.fixtureDirectory,
      recipeManifestPath: DEFAULT_RECIPE_MANIFEST_PATH,
    })
    audioFixture = fixtureForRole(rangeServer, 'tone-long-mp3')
    if (!audioFixture) throw new SelfRunError('Verified tone-long-mp3 fixture is missing')
    audioUrl = `${rangeServer.baseUrl}/${encodeURIComponent(audioFixture.recipe.filename)}`
    baselinePids = new Set((await captureProcessSnapshot(runCommand)).map(({ pid }) => pid))
    application = await launchApplication({
      bundle,
      outputDirectory,
      spawnProcess,
      environment: {
        ...process.env,
        CLARUS_PERF_AUDIO_URL: audioUrl,
        CLARUS_PERF_AUDIO_MIME: audioFixture.recipe.mimeType,
        CLARUS_PERF_AUDIO_SIZE_BYTES: String(audioFixture.byteLength),
        CLARUS_PERF_ITERATIONS: String(options.iterations),
        CLARUS_PERF_RECOVERY_SECONDS: String(options.recoverySeconds),
        CLARUS_PERF_REPORT: checkpointPath,
        CLARUS_PERF_SCENARIO: 'artist-dfs-v1',
        CLARUS_PERF_START_SIGNAL: startSignalPath,
      },
    })
    checkpoint = await waitForReady({
      application,
      checkpointPath,
      timeoutSeconds: options.startupTimeoutSeconds,
    })
    attribution = await waitForAttribution({
      application,
      baselinePids,
      bundle,
      runCommand,
      timeoutSeconds: options.startupTimeoutSeconds,
    })
    samples.push(
      await sampleWebContent({
        attribution,
        checkpoint,
        index: samples.length,
        runCommand,
        startedMilliseconds,
        fixtureMetricsProvider: () => rangeServer?.metrics?.snapshot?.() ?? null,
      }),
    )
    await writeFile(startSignalPath, START_SIGNAL_CONTENTS, { flag: 'wx', mode: 0o600 })

    const scenarioDeadline =
      Date.now() +
      options.iterations * 35_000 +
      options.recoverySeconds * 1_000 +
      Math.max(120_000, options.startupTimeoutSeconds * 1_000)
    let nextSampleAt = Date.now() + SAMPLE_INTERVAL_MS
    while (Date.now() < scenarioDeadline) {
      await delay(Math.max(0, nextSampleAt - Date.now()))
      nextSampleAt += SAMPLE_INTERVAL_MS
      const before = await readPerformanceCheckpoint(checkpointPath)
      if (!before) throw new SelfRunError('Application checkpoint disappeared during sampling')
      samples.push(
        await sampleWebContent({
          attribution,
          checkpoint: before,
          index: samples.length,
          runCommand,
          startedMilliseconds,
          fixtureMetricsProvider: () => rangeServer?.metrics?.snapshot?.() ?? null,
        }),
      )
      checkpoint = (await readPerformanceCheckpoint(checkpointPath)) ?? before
      if (checkpoint.phase === 'complete' || checkpoint.phase === 'failed') break
      if (application.child.exitCode !== null) {
        throw new SelfRunError('Application exited before the performance scenario completed')
      }
    }
    if (checkpoint?.phase !== 'complete') {
      if (checkpoint?.phase === 'failed') {
        throw new SelfRunError(`Application scenario failed: ${checkpoint.failure}`)
      }
      throw new SelfRunError('Timed out waiting for the performance scenario to complete')
    }
    if (samples.at(-1)?.phase !== 'complete') {
      samples.push(
        await sampleWebContent({
          attribution,
          checkpoint,
          index: samples.length,
          runCommand,
          startedMilliseconds,
          fixtureMetricsProvider: () => rangeServer?.metrics?.snapshot?.() ?? null,
        }),
      )
    }
    if (
      checkpoint.iterationsCompleted !== options.iterations ||
      checkpoint.recoverySecondsElapsed < options.recoverySeconds ||
      checkpoint.failure !== null
    ) {
      throw new SelfRunError('Completed checkpoint did not satisfy the requested scenario bounds')
    }
  } catch (error) {
    failure = errorDetails(error)
  } finally {
    await terminateExactChild(application).catch((error) => {
      failure ??= errorDetails(error)
    })
    await rangeServer?.close().catch((error) => {
      failure ??= errorDetails(error)
    })
    if (typeof rangeServer?.metrics?.snapshot === 'function') {
      fixtureMetrics = rangeServer.metrics.snapshot()
    }
  }

  let finalBundle = bundle
  if (bundle) {
    try {
      finalBundle = await bundleReader({
        appBundlePath: options.appBundle,
        expectedBundlePath: canonicalBundlePath,
        runCommand,
      })
      bundleSha256After = await bundleHasher(finalBundle.appBundlePath)
      if (
        finalBundle.executableSha256 !== bundle.executableSha256 ||
        bundleSha256After !== bundleSha256
      ) {
        throw new SelfRunError('Release executable changed during the performance run')
      }
    } catch (error) {
      failure ??= errorDetails(error)
    }
  }

  if (sourceProvenance) {
    try {
      sourceProvenanceAfter = await sourceProvenanceReader({
        runCommand,
        repositoryRoot: REPOSITORY_ROOT,
      })
      if (
        sourceProvenanceAfter.commit !== sourceProvenance.commit ||
        sourceProvenanceAfter.statusSha256 !== sourceProvenance.statusSha256
      ) {
        failure ??= errorDetails(
          new SelfRunError('Worktree source changed while the performance run was executing'),
        )
      }
    } catch (error) {
      failure ??= errorDetails(error)
    }
  }

  if (samples.length > 0 && checkpoint) {
    try {
      summary = computeSelfRunSummary(samples, checkpoint, {
        expectedAudioUrl: audioUrl ?? null,
        expectedAudioFilename: audioFixture?.recipe?.filename ?? null,
        fixtureMetrics,
      })
    } catch (error) {
      failure ??= errorDetails(error)
    }
  }

  const webContent = attribution?.selected.find(({ role }) => role === 'web-content')
  const attributedProcessPids = attribution
    ? Object.fromEntries(attribution.selected.map(({ role, pid }) => [role, pid]))
    : null
  const scenarioComplete = !failure && checkpoint?.phase === 'complete'
  const performancePass = scenarioComplete ? (summary?.performancePass ?? false) : null
  const report = {
    $schema: 'clarus.perf.self-run',
    schemaVersion: SELF_RUN_SCHEMA_VERSION,
    status: failure ? 'failed' : 'complete',
    scenarioComplete,
    performancePass,
    startedAt,
    finishedAt: new Date().toISOString(),
    outputDirectory,
    configuration: {
      scenario: 'artist-dfs-v1',
      iterations: options.iterations,
      recoverySeconds: options.recoverySeconds,
      sampleIntervalMilliseconds: SAMPLE_INTERVAL_MS,
      keychainRestoreEnabled: false,
      accountRestoreEnabled: false,
      networkProfile: 'loopback-fixtures-only',
      performanceGates: PERFORMANCE_GATES,
    },
    application: {
      appBundlePath: bundle?.appBundlePath ?? options.appBundle,
      bundleId: bundle?.bundleId ?? null,
      bundleVersion: bundle?.bundleVersion ?? null,
      executablePath: bundle?.executablePath ?? null,
      executableSha256: bundle?.executableSha256 ?? null,
      executableSha256After: finalBundle?.executableSha256 ?? null,
      bundleSha256: bundleSha256 ?? null,
      bundleSha256After: bundleSha256After ?? null,
      rootPid: application?.child?.pid ?? null,
      webContentPid: webContent?.pid ?? null,
      processPids: attributedProcessPids,
      attribution: attribution ? selectedAttribution(attribution) : null,
    },
    source: sourceProvenance
      ? {
          commit: sourceProvenance.commit,
          branch: sourceProvenance.branch,
          dirty: sourceProvenance.dirty,
          statusSha256: sourceProvenance.statusSha256,
          commitAfter: sourceProvenanceAfter?.commit ?? null,
          dirtyAfter: sourceProvenanceAfter?.dirty ?? null,
          statusSha256After: sourceProvenanceAfter?.statusSha256 ?? null,
        }
      : null,
    fixture: rangeServer
      ? {
          directory: options.fixtureDirectory,
          lockSha256: canonicalFixtureHash(rangeServer.verifiedFixtureSet.lock),
          audioRole: 'tone-long-mp3',
          audioFilename: audioFixture?.recipe?.filename ?? null,
          audioUrl: audioUrl ?? null,
          audioSizeBytes: audioFixture?.byteLength ?? null,
          audioSha256: audioFixture?.sha256 ?? null,
          audioMimeType: audioFixture?.recipe.mimeType ?? null,
          requestMetrics: fixtureMetrics,
        }
      : null,
    checkpoint,
    samples,
    summary,
    failure,
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  await writeFile(join(outputDirectory, 'samples.csv'), renderSelfRunCsv(samples), {
    flag: 'wx',
    mode: 0o600,
  })
  await writeFile(join(outputDirectory, 'summary.txt'), renderSelfRunSummary(report), {
    flag: 'wx',
    mode: 0o600,
  })
  if (failure) {
    throw new SelfRunError(`Self-driven performance run failed: ${failure.message}`, {
      reportPath,
    })
  }
  return report
}

export function outputSummaryLine(report) {
  return [
    `report=${join(report.outputDirectory, 'report.json')}`,
    `scenario_complete=${report.scenarioComplete ?? false}`,
    `performance_pass=${report.performancePass ?? 'NA'}`,
    `dfs_peak=${formatMiB(report.summary?.dfsPeakBytes ?? null)}`,
    `recovery_stable=${formatMiB(report.summary?.recoveryStableBytes ?? null)}`,
    `frame_p95=${report.summary?.frameP95Ms?.toFixed(2) ?? 'NA'}ms`,
  ].join(' ')
}
