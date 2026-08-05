import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { link, lstat, mkdir, rename, unlink } from 'node:fs/promises'
import { totalmem, cpus } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'

import {
  METADATA_MAX_BYTES,
  PerfInputError,
  RUNS_ROOT,
  REPOSITORY_ROOT,
  createNewStrictOutputDirectory,
  readJsonNoFollow,
  readNoFollowRegularFile,
  resolveStrictNoFollowChildPath,
  writeNewFile,
} from './cli-support.mjs'
import {
  MACOS_FIXED_TOOLS,
  assertExpectedReleaseBundle,
  compareAttributionIdentity,
  captureMacosAttribution,
  isExecutableRegularFile,
  readReleaseBundle,
} from './pid-attribution.mjs'
import {
  METRIC_UNITS,
  PRODUCER,
  RUN_SCHEMA,
  SCHEMA_VERSION,
  canonicalJson,
  canonicalSha256,
  normalizeControlsMetadata,
  validateMetadata,
  validateRunReport,
} from './report-schema.mjs'
import { formatStatistic, computeStatistics } from './statistics.mjs'
import {
  AFCONVERT_EXECUTABLE,
  AFINFO_EXECUTABLE,
  verifyFixtureSet,
} from '../fixtures/fixture-verifier.mjs'

export const TOOL_PATHS = Object.freeze({
  ps: MACOS_FIXED_TOOLS.ps,
  lsappinfo: MACOS_FIXED_TOOLS.lsappinfo,
  plutil: MACOS_FIXED_TOOLS.plutil,
  git: '/usr/bin/git',
  sw_vers: '/usr/bin/sw_vers',
  top: '/usr/bin/top',
  footprint: '/usr/bin/footprint',
  sample: '/usr/bin/sample',
})

export const OUTPUT_LIMIT_BYTES = Object.freeze({
  stdout: 64 * 1024 * 1024,
  stderr: 8 * 1024 * 1024,
  total: 512 * 1024 * 1024,
})

export const TERMINATION_GRACE_MS = 2000

const FIXED_TOOL_EXECUTABLES = new Set([
  ...Object.values(TOOL_PATHS),
  AFINFO_EXECUTABLE,
  AFCONVERT_EXECUTABLE,
])

const ROLE_ORDER = Object.freeze(['main', 'web-content', 'gpu', 'networking', 'process-total'])
const METRIC_ORDER = Object.freeze([
  'cpu.percent',
  'process.thread_count',
  'memory.physical_footprint_bytes',
  'memory.physical_footprint_peak_bytes',
  'memory.total_physical_footprint_bytes',
])
const FIXED_ENVIRONMENT = Object.freeze({ LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' })

export class SamplingError extends Error {
  constructor(code, phase, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.code = code
    this.phase = phase
    this.name = 'SamplingError'
  }
}

class InterruptedError extends SamplingError {
  constructor(signal) {
    super('INTERRUPTED', 'signal', `sampling interrupted by ${signal}`)
    this.signal = signal
  }
}

function samplingError(code, phase, message, cause) {
  throw new SamplingError(code, phase, message, cause)
}

function timestampNow(now) {
  const value = typeof now === 'function' ? now() : new Date().toISOString()
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    samplingError('CLOCK_INVALID', 'clock', 'clock must return a valid ISO timestamp')
  }
  const date = new Date(value)
  return date.toISOString()
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value
  }
  if (value === undefined || value === null) {
    return Buffer.alloc(0)
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8')
  }
  samplingError('TOOL_OUTPUT_INVALID', 'tool', 'tool output must be a string or buffer')
}

function outputPrefix(contents, maximum) {
  return contents.byteLength <= maximum ? contents : contents.subarray(0, maximum)
}

function normalizeOutputLimits(value) {
  const limits = { ...OUTPUT_LIMIT_BYTES, ...(value ?? {}) }
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      samplingError(
        'OUTPUT_LIMIT_INVALID',
        'preflight',
        `${name} output limit must be a positive safe integer`,
      )
    }
  }
  return limits
}

function normalizeTerminationGraceMs(value) {
  const graceMs = value ?? TERMINATION_GRACE_MS
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    samplingError(
      'TERMINATION_GRACE_INVALID',
      'preflight',
      'termination grace must be a nonnegative safe integer',
    )
  }
  return graceMs
}

function createBoundedOutputCollector(maximum) {
  const chunks = []
  let byteLength = 0
  return {
    append(value, totalRemaining) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const retainedLength = Math.max(
        0,
        Math.min(chunk.byteLength, maximum - byteLength, totalRemaining),
      )
      if (retainedLength > 0) {
        chunks.push(Buffer.from(chunk.subarray(0, retainedLength)))
        byteLength += retainedLength
      }
      return { byteLength: retainedLength, limited: retainedLength !== chunk.byteLength }
    },
    toBuffer() {
      return Buffer.concat(chunks, byteLength)
    },
  }
}

function classifyToolFailure(result, phase, tool) {
  const stderr = asBuffer(result.stderr).toString('utf8')
  if (/permission denied|operation not permitted|not permitted|sip/i.test(stderr)) {
    samplingError('PERMISSION_DENIED', phase, `${tool} permission was denied`)
  }
  if (result.timedOut) {
    samplingError('TIMEOUT', phase, `${tool} timed out`)
  }
  if (result.signal) {
    samplingError('TOOL_SIGNAL', phase, `${tool} exited from signal ${result.signal}`)
  }
  if (result.exitCode !== 0) {
    samplingError('TOOL_FAILED', phase, `${tool} exited with ${String(result.exitCode)}`)
  }
}

function toolTimeoutMs(phase, options) {
  if (phase === 'top') {
    return (options.samples + 1) * options.intervalMs + 30000
  }
  if (phase === 'stack') {
    return Math.min(90 * 1000, options.stackDurationSeconds * 1000 + 30000)
  }
  return 30000
}

const childLifecycles = new WeakMap()

function createChildLifecycle(child, terminationGraceMs) {
  let resolveExit
  const lifecycle = {
    exited: false,
    exit: new Promise((resolvePromise) => {
      resolveExit = resolvePromise
    }),
    exitResult: null,
    onExit: undefined,
    resolveExit,
    termination: undefined,
    terminationGraceMs,
  }
  lifecycle.onExit = (exitCode, signal) => markChildExited(child, exitCode, signal)
  child.once?.('exit', lifecycle.onExit)
  childLifecycles.set(child, lifecycle)
  return lifecycle
}

function markChildExited(child, exitCode, signal) {
  const lifecycle = childLifecycles.get(child)
  if (!lifecycle || lifecycle.exited) {
    return
  }
  lifecycle.exited = true
  lifecycle.exitResult = { exitCode, signal: signal ?? null }
  child.off?.('exit', lifecycle.onExit)
  lifecycle.resolveExit(lifecycle.exitResult)
}

function waitForChildExitWithin(lifecycle, timeoutMs) {
  if (lifecycle.exited) {
    return Promise.resolve(true)
  }
  return new Promise((resolvePromise) => {
    let settled = false
    const settle = (exited) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolvePromise(exited)
      }
    }
    const timer = setTimeout(() => settle(false), timeoutMs)
    lifecycle.exit.then(() => settle(true))
  })
}

function signalToolChild(child, signal) {
  try {
    if (child && typeof child.kill === 'function') {
      child.kill(signal)
    }
  } catch {
    // Only direct sampler tool children are signal targets; an already-exited child is harmless.
  }
}

async function terminateChild(child) {
  const lifecycle = childLifecycles.get(child)
  if (!lifecycle || lifecycle.exited) {
    return
  }
  if (lifecycle.termination) {
    return lifecycle.termination
  }
  lifecycle.termination = (async () => {
    signalToolChild(child, 'SIGTERM')
    const exitedAfterTerm = await waitForChildExitWithin(lifecycle, lifecycle.terminationGraceMs)
    if (!exitedAfterTerm && !lifecycle.exited) {
      signalToolChild(child, 'SIGKILL')
    }
    await lifecycle.exit
  })()
  return lifecycle.termination
}

async function terminateToolChildren(children) {
  await Promise.all([...children].map((child) => terminateChild(child)))
}

export async function spawnFixedTool(
  executable,
  argv,
  {
    timeoutMs = 30000,
    activeChildren = new Set(),
    outputLimits,
    signalState,
    spawnProcess = spawn,
    terminationGraceMs,
  } = {},
) {
  if (!FIXED_TOOL_EXECUTABLES.has(executable)) {
    samplingError('TOOL_REFUSED', 'tool', `refusing non-fixed executable ${executable}`)
  }
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
    samplingError('TOOL_REFUSED', 'tool', 'tool argv must be a string array')
  }
  if (typeof spawnProcess !== 'function') {
    samplingError('TOOL_REFUSED', 'tool', 'tool spawn implementation must be a function')
  }
  const limits = normalizeOutputLimits(outputLimits)
  const graceMs = normalizeTerminationGraceMs(terminationGraceMs)
  return new Promise((resolvePromise, rejectPromise) => {
    if (signalState?.signal) {
      rejectPromise(new InterruptedError(signalState.signal))
      return
    }
    let child
    try {
      if (signalState?.signal) {
        throw new InterruptedError(signalState.signal)
      }
      child = spawnProcess(executable, argv, {
        shell: false,
        env: { ...FIXED_ENVIRONMENT },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      rejectPromise(error)
      return
    }
    if (!child || typeof child.once !== 'function') {
      rejectPromise(new Error('fixed tool spawn did not return a child process'))
      return
    }
    const lifecycle = createChildLifecycle(child, graceMs)
    activeChildren.add(child)
    const stdout = createBoundedOutputCollector(limits.stdout)
    const stderr = createBoundedOutputCollector(limits.stderr)
    let retainedBytes = 0
    let outputLimited = false
    let timedOut = false
    let settled = false
    let timeout
    let toolError
    const onStdout = (chunk) => {
      const appended = stdout.append(chunk, Math.max(0, limits.total - retainedBytes))
      retainedBytes += appended.byteLength
      if (appended.limited) {
        outputLimited = true
        void terminateChild(child)
      }
    }
    const onStderr = (chunk) => {
      const appended = stderr.append(chunk, Math.max(0, limits.total - retainedBytes))
      retainedBytes += appended.byteLength
      if (appended.limited) {
        outputLimited = true
        void terminateChild(child)
      }
    }
    const cleanup = () => {
      clearTimeout(timeout)
      activeChildren.delete(child)
      child.stdout?.off?.('data', onStdout)
      child.stderr?.off?.('data', onStderr)
      child.off?.('error', onError)
      child.off?.('close', onClose)
      child.off?.('exit', lifecycle.onExit)
    }
    const settle = (value) => {
      if (!settled) {
        settled = true
        cleanup()
        resolvePromise(value)
      }
    }
    const reject = (error) => {
      if (!settled) {
        settled = true
        cleanup()
        rejectPromise(error)
      }
    }
    const onError = (error) => {
      if (settled) {
        return
      }
      if (!child.pid) {
        markChildExited(child, null, null)
        reject(error)
        return
      }
      toolError = error
      void terminateChild(child)
    }
    const onClose = (exitCode, signal) => {
      markChildExited(child, exitCode, signal)
      if (toolError) {
        reject(toolError)
        return
      }
      settle({
        exitCode,
        signal: signal ?? null,
        timedOut,
        outputLimited,
        stdout: stdout.toBuffer(),
        stderr: stderr.toBuffer(),
      })
    }
    child.stdout?.on?.('data', onStdout)
    child.stderr?.on?.('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
    timeout = setTimeout(() => {
      timedOut = true
      void terminateChild(child)
    }, timeoutMs)
    timeout.unref?.()
    if (signalState?.signal) {
      void terminateChild(child)
    }
  })
}

function normalizeTopCpu(value) {
  const normalized = value.endsWith('%') ? value.slice(0, -1) : value
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    samplingError('PARSE_FAILURE', 'top', `top reported invalid CPU percentage ${value}`)
  }
  const numeric = Number(normalized)
  if (!Number.isFinite(numeric) || numeric < 0) {
    samplingError('PARSE_FAILURE', 'top', 'top CPU percentage must be finite and nonnegative')
  }
  return numeric
}

export function parseTopOutput(output, { pids } = {}) {
  if (
    !Array.isArray(pids) ||
    pids.length === 0 ||
    pids.some((pid) => !Number.isSafeInteger(pid) || pid < 2)
  ) {
    samplingError('PARSE_FAILURE', 'top', 'top parser requires fixed safe PIDs')
  }
  const text = String(output)
  if (/\btruncat(?:ed|ion)?\b/i.test(text)) {
    samplingError('PARSE_FAILURE', 'top', 'top output was truncated')
  }
  const expected = new Set(pids)
  const groups = []
  let current
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (/^\s*PID\s+.*\bCPU(?:%|\b).*\b(?:TH|THREADS?)\b/i.test(line)) {
      current = new Map()
      groups.push(current)
      continue
    }
    if (!current || !line.trim()) {
      continue
    }
    const row = /^\s*(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(line)
    if (!row) {
      continue
    }
    const pid = Number(row[1])
    if (!expected.has(pid)) {
      samplingError('PARSE_FAILURE', 'top', `top reported unexpected PID ${pid}`)
    }
    if (current.has(pid)) {
      samplingError('PARSE_FAILURE', 'top', `top reported duplicate PID ${pid}`)
    }
    const threadCount = Number(row[3])
    if (!Number.isSafeInteger(threadCount) || threadCount < 0) {
      samplingError('PARSE_FAILURE', 'top', `top reported invalid thread count for PID ${pid}`)
    }
    current.set(pid, { cpuPercent: normalizeTopCpu(row[2]), threadCount })
  }
  if (groups.length === 0) {
    samplingError('PARSE_FAILURE', 'top', 'top output had no process table')
  }
  for (const group of groups) {
    for (const pid of expected) {
      if (!group.has(pid)) {
        samplingError('PARSE_FAILURE', 'top', `top output is missing PID ${pid}`)
      }
    }
    if (group.size !== expected.size) {
      samplingError('PARSE_FAILURE', 'top', 'top output has an unexpected process count')
    }
  }
  return groups
}

function parseByteValue(value, label) {
  const compact = value.replace(/,/g, '').trim()
  if (!/^\d+$/.test(compact)) {
    samplingError('PARSE_FAILURE', 'footprint', `${label} must be a nonnegative integer byte count`)
  }
  const numeric = Number(compact)
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    samplingError('PARSE_FAILURE', 'footprint', `${label} is outside the safe byte range`)
  }
  return numeric
}

export function parseFootprintOutput(output) {
  const text = String(output)
  if (/\btruncat(?:ed|ion)?\b/i.test(text)) {
    samplingError('PARSE_FAILURE', 'footprint', 'footprint output was truncated')
  }
  const lines = text.split(/\r?\n/)
  let footprint
  let peak
  for (const line of lines) {
    const current =
      /^\s*(?:Physical\s+footprint|phys_footprint):\s*([0-9,]+)(?:\s+(?:bytes|B))?\s*$/i.exec(line)
    const maximum =
      /^\s*(?:Physical\s+footprint\s*\(peak\)|phys_footprint_peak):\s*([0-9,]+)(?:\s+(?:bytes|B))?\s*$/i.exec(
        line,
      )
    if (current) {
      if (footprint !== undefined) {
        samplingError(
          'PARSE_FAILURE',
          'footprint',
          'footprint output has duplicate physical footprint values',
        )
      }
      footprint = parseByteValue(current[1], 'physical footprint')
    }
    if (maximum) {
      if (peak !== undefined) {
        samplingError('PARSE_FAILURE', 'footprint', 'footprint output has duplicate peak values')
      }
      peak = parseByteValue(maximum[1], 'physical footprint peak')
    }
  }
  if (footprint === undefined || peak === undefined) {
    samplingError(
      'PARSE_FAILURE',
      'footprint',
      'footprint output is missing physical footprint or peak',
    )
  }
  return { physicalFootprintBytes: footprint, physicalFootprintPeakBytes: peak }
}

function csvCell(value) {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function compareMeasurements(left, right) {
  const phase = ['top', 'footprint'].indexOf(left.phase) - ['top', 'footprint'].indexOf(right.phase)
  if (phase !== 0) return phase
  if (left.sampleIndex !== right.sampleIndex) return left.sampleIndex - right.sampleIndex
  const role = ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role)
  if (role !== 0) return role
  const metric = METRIC_ORDER.indexOf(left.metric) - METRIC_ORDER.indexOf(right.metric)
  if (metric !== 0) return metric
  return left.pid - right.pid
}

export function renderMeasurementsCsv({ runId, scenario, runIndex, measurements }) {
  const header = [
    'schema_version',
    'run_id',
    'scenario',
    'run_index',
    'sample_index',
    'observed_at',
    'phase',
    'tool',
    'role',
    'pid',
    'metric',
    'unit',
    'value',
    'raw_file',
  ]
  const rows = [...measurements]
    .sort(compareMeasurements)
    .map((measurement) =>
      [
        SCHEMA_VERSION,
        runId,
        scenario,
        runIndex,
        measurement.sampleIndex,
        measurement.observedAt,
        measurement.phase,
        measurement.tool,
        measurement.role,
        measurement.pid,
        measurement.metric,
        measurement.unit,
        measurement.value,
        measurement.rawFile,
      ]
        .map(csvCell)
        .join(','),
    )
  return `${header.join(',')}\r\n${rows.join('\r\n')}\r\n`
}

export function renderRunSummary(report) {
  const lines = ['MEASUREMENT INFRASTRUCTURE OUTPUT — NOT EVIDENCE OF PRODUCT IMPROVEMENT.']
  lines.push(`run_id: ${report.run.runId}`)
  lines.push(`scenario: ${report.run.scenario}`)
  lines.push(`status: ${report.status}`)
  const groups = new Map()
  for (const measurement of report.measurements) {
    const key = `${measurement.role}\u0000${measurement.metric}\u0000${measurement.unit}`
    const group = groups.get(key) ?? { ...measurement, values: [] }
    group.values.push(measurement.value)
    groups.set(key, group)
  }
  for (const group of [...groups.values()].sort((left, right) =>
    `${left.role}/${left.metric}`.localeCompare(`${right.role}/${right.metric}`),
  )) {
    const statistics = computeStatistics(group.values, { scenarioClass: report.run.scenarioClass })
    lines.push(
      `${group.role} ${group.metric} (${group.unit}): n=${statistics.n} median=${formatStatistic(statistics.median)} p95=${formatStatistic(statistics.p95)} mean=${formatStatistic(statistics.mean)}`,
    )
  }
  return `${lines.join('\n')}\n`
}

function fixedToolEntries(available, stackRequested) {
  return Object.entries(TOOL_PATHS).map(([name, path]) => ({
    name,
    path,
    requested: name !== 'sample' || stackRequested,
    available: available.get(name) === true,
  }))
}

function normalizeFixtureRoles(lock) {
  if (!lock || !Array.isArray(lock.files) || lock.files.length === 0) {
    samplingError('FIXTURE_INVALID', 'fixture', 'verified fixture lock has no files')
  }
  return lock.files.map((file) => ({
    role: file.role,
    filename: file.filename,
    byteLength: file.byteLength,
    sha256: file.sha256,
  }))
}

function fixtureFingerprint(verified, lockBytes) {
  const files = normalizeFixtureRoles(verified.lock)
  return {
    directory: resolve(verified.directory),
    lockSha256: sha256(lockBytes),
    normalizedLockSha256: sha256(Buffer.from(canonicalJson(verified.lock), 'utf8')),
    files: files.map(
      (file) => `${file.role}\u0000${file.filename}\u0000${file.byteLength}\u0000${file.sha256}`,
    ),
  }
}

function assertFixtureLockBytesMatch(lockBytes, expectedLock, label) {
  let actualLock
  try {
    actualLock = JSON.parse(lockBytes.toString('utf8'))
    if (canonicalJson(actualLock) !== canonicalJson(expectedLock)) {
      throw new Error('lock contents differ from the verifier identity')
    }
  } catch (error) {
    samplingError(
      'FIXTURE_DRIFT',
      'fixture',
      `${label} changed during sampling: ${safeErrorMessage(error)}`,
      error,
    )
  }
}

function sameFixtureFingerprint(left, right) {
  return (
    left.directory === right.directory &&
    left.lockSha256 === right.lockSha256 &&
    left.normalizedLockSha256 === right.normalizedLockSha256 &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => file === right.files[index])
  )
}

function fixtureStatIdentity(stat) {
  return {
    ctime: typeof stat.ctimeNs === 'bigint' ? stat.ctimeNs : stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
    mtime: typeof stat.mtimeNs === 'bigint' ? stat.mtimeNs : stat.mtimeMs,
    size: stat.size,
  }
}

function sameFixtureStatIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.ctime === right.ctime &&
    left.mtime === right.mtime
  )
}

// Synchronous witnesses are required for the initial verifier: no async
// lstat/open gap may exist in which a fixture can change and be restored before
// its first identity is retained. ctime/mtime on the descriptor records the
// intervening write even when the pathname bytes are restored.
function retainFixtureIntegrityGuardSyncFromPaths(paths) {
  const witnesses = []
  try {
    for (const { label, pathname } of paths) {
      const before = lstatSync(pathname, { bigint: true })
      if (before.isSymbolicLink() || !before.isFile()) {
        samplingError('FIXTURE_DRIFT', 'fixture', `${label} is no longer a regular no-follow file`)
      }
      const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = fstatSync(fd, { bigint: true })
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
          samplingError(
            'FIXTURE_DRIFT',
            'fixture',
            `${label} changed while its integrity witness opened`,
          )
        }
        witnesses.push({ baseline: fixtureStatIdentity(opened), fd, label, pathname })
      } catch (error) {
        closeSync(fd)
        throw error
      }
    }
  } catch (error) {
    for (const witness of witnesses) {
      try {
        closeSync(witness.fd)
      } catch {
        // Best effort cleanup; the original fixture failure is authoritative.
      }
    }
    if (error instanceof SamplingError) {
      throw error
    }
    samplingError(
      'FIXTURE_DRIFT',
      'fixture',
      `could not retain fixture integrity witnesses: ${safeErrorMessage(error)}`,
      error,
    )
  }

  let closed = false
  return {
    async assertUnchanged(phase) {
      for (const witness of witnesses) {
        let opened
        let current
        try {
          opened = fstatSync(witness.fd, { bigint: true })
          current = lstatSync(witness.pathname, { bigint: true })
        } catch (error) {
          samplingError(
            'FIXTURE_DRIFT',
            'fixture',
            `${witness.label} could not be verified after ${phase}: ${safeErrorMessage(error)}`,
            error,
          )
        }
        if (
          current.isSymbolicLink() ||
          !current.isFile() ||
          !sameFixtureStatIdentity(witness.baseline, fixtureStatIdentity(opened)) ||
          !sameFixtureStatIdentity(witness.baseline, fixtureStatIdentity(current))
        ) {
          samplingError(
            'FIXTURE_DRIFT',
            'fixture',
            `${witness.label} changed during ${phase} sampling`,
          )
        }
      }
    },
    async close() {
      if (!closed) {
        closed = true
        for (const witness of witnesses) {
          try {
            closeSync(witness.fd)
          } catch {
            // The descriptor may already have been closed during failure cleanup.
          }
        }
      }
    },
  }
}

function retainFixtureIntegrityGuardSync(verified) {
  return retainFixtureIntegrityGuardSyncFromPaths([
    { label: 'fixture lock', pathname: join(verified.directory, 'fixtures.lock.json') },
    ...normalizeFixtureRoles(verified.lock).map((fixture) => ({
      label: `fixture file ${fixture.filename}`,
      pathname: join(verified.directory, fixture.filename),
    })),
  ])
}

// Read and witness the lock plus every filename it names before the first
// asynchronous fixture verifier starts. If the lock is unavailable or
// malformed, return null and let the verifier produce the authoritative input
// error; valid fixtures always get a pre-verifier witness set.
function retainInitialFixtureIntegrityGuard(directory) {
  const resolvedDirectory = resolve(directory)
  const lockPath = join(resolvedDirectory, 'fixtures.lock.json')
  let lockFd
  try {
    lockFd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const lockContents = readFileSync(lockFd)
    const parsed = JSON.parse(lockContents.toString('utf8'))
    if (!Array.isArray(parsed?.files) || parsed.files.length === 0) {
      closeSync(lockFd)
      return null
    }
    const names = parsed.files.map((file) => file?.filename)
    if (
      names.some(
        (filename) =>
          typeof filename !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.(mp3|flac|yrc)$/.test(filename),
      )
    ) {
      closeSync(lockFd)
      return null
    }
    for (const filename of names) {
      try {
        lstatSync(join(resolvedDirectory, filename), { bigint: true })
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new PerfInputError(`Fixture input is missing: ${filename}`)
        }
        throw error
      }
    }
    const guard = retainFixtureIntegrityGuardSyncFromPaths([
      { label: 'fixture lock', pathname: lockPath },
      ...names.map((filename) => ({
        label: `fixture file ${filename}`,
        pathname: join(resolvedDirectory, filename),
      })),
    ])
    // The helper opens its own descriptor for the lock; close the preliminary
    // reader now so it does not leak alongside the retained witness.
    closeSync(lockFd)
    return guard
  } catch (error) {
    if (lockFd !== undefined) {
      try {
        closeSync(lockFd)
      } catch {
        // Best effort cleanup before verifier-owned validation runs.
      }
    }
    if (error instanceof SamplingError || error instanceof PerfInputError) {
      throw error
    }
    return null
  }
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return [...message]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f ? ' ' : character
    })
    .join('')
    .slice(0, 1024)
}

function validateMetadataInput(value, options) {
  try {
    return validateMetadata(value, options)
  } catch (error) {
    throw new PerfInputError(`Metadata is invalid: ${safeErrorMessage(error)}`)
  }
}

function defaultHost() {
  let cpu = { model: null, cores: null }
  let memoryBytes = null
  try {
    const availableCpus = cpus()
    cpu = {
      model: availableCpus[0]?.model ?? null,
      cores: availableCpus.length || null,
    }
  } catch {
    // Host metadata records null when a host field cannot be read.
  }
  try {
    memoryBytes = totalmem()
  } catch {
    // Host metadata records null when a host field cannot be read.
  }
  return {
    platform: 'darwin',
    osVersion: null,
    osBuild: null,
    arch: process.arch || null,
    nodeVersion: process.version || null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    cpu,
    memoryBytes,
  }
}

async function defaultReadGit({ repositoryRoot, run }) {
  const revision = await run('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], 'git-revision')
  const dirty = await run('git', ['-C', repositoryRoot, 'status', '--porcelain=v1'], 'git-dirty')
  const commit = String(revision.stdout).trim()
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    samplingError('GIT_INVALID', 'source', 'git did not report a full lowercase commit SHA')
  }
  return { commit, dirty: String(dirty.stdout).trim().length > 0 }
}

const FAILURE_HASH = '0'.repeat(64)
const FAILURE_COMMIT = '0'.repeat(40)
const FAILURE_ROLE = 'unavailable'
const FAILURE_BUNDLE_ID = 'com.ovo3ovo3ovo.clarusmusic'

const DEFAULT_REQUESTED = Object.freeze({
  samples: 5,
  intervalMs: 1000,
  stackDurationSeconds: 0,
  stackIntervalMs: 1,
})

function requestedForReport(options) {
  const candidate = {
    samples: options?.samples,
    intervalMs: options?.intervalMs,
    stackDurationSeconds: options?.stackDurationSeconds,
    stackIntervalMs: options?.stackIntervalMs,
  }
  if (
    Number.isSafeInteger(candidate.samples) &&
    candidate.samples >= 5 &&
    candidate.samples <= 3600 &&
    Number.isSafeInteger(candidate.intervalMs) &&
    candidate.intervalMs >= 1000 &&
    candidate.intervalMs % 1000 === 0 &&
    candidate.intervalMs <= 60000 &&
    candidate.samples * candidate.intervalMs <= 3600000 &&
    Number.isSafeInteger(candidate.stackDurationSeconds) &&
    candidate.stackDurationSeconds >= 0 &&
    candidate.stackDurationSeconds <= 60 &&
    Number.isSafeInteger(candidate.stackIntervalMs) &&
    candidate.stackIntervalMs >= 1 &&
    candidate.stackIntervalMs <= 1000
  ) {
    return candidate
  }
  return { ...DEFAULT_REQUESTED }
}

function failureMetadata(state) {
  if (state.metadata) {
    if (state.fixture?.roles?.length > 0) {
      const verifiedRoles = new Set(state.fixture.roles.map((role) => role.role))
      return {
        ...state.metadata,
        fixtureRoles: state.metadata.fixtureRoles.filter((role) => verifiedRoles.has(role)),
      }
    }
    return state.metadata
  }
  const fixtureRoles =
    state.fixture?.roles?.length > 0 ? state.fixture.roles.map((role) => role.role) : [FAILURE_ROLE]
  return {
    scenario: 'failure',
    scenarioClass: 'runtime',
    runId: 'failure',
    runIndex: 1,
    buildKind: 'release',
    coldWarm: 'warm',
    cacheState: 'not-applicable',
    windowCssPx: { width: 1, height: 1 },
    displayScale: 1,
    powerSource: 'unknown',
    powerMode: 'unknown',
    volume: null,
    outputDevice: null,
    networkProfile: 'offline',
    settingsFixture: null,
    queueFixture: null,
    fixtureRoles,
    notes: null,
  }
}

function failureSource(state) {
  if (state.source) {
    return state.source
  }
  const bundlePath = join(
    state.repositoryRoot,
    'src-tauri',
    'target',
    'release',
    'bundle',
    'macos',
    'Clarus Music.app',
  )
  return {
    repositoryRoot: state.repositoryRoot,
    gitCommit: FAILURE_COMMIT,
    dirty: false,
    appBundlePath: bundlePath,
    appExecutablePath: join(bundlePath, 'Contents', 'MacOS', 'simplemusic'),
    bundleId: FAILURE_BUNDLE_ID,
    bundleVersion: 'unavailable',
    executableSha256: FAILURE_HASH,
    release: true,
  }
}

function failureFixture(state, metadata) {
  if (state.fixture) {
    return state.fixture
  }
  const roles =
    metadata.fixtureRoles.length > 0
      ? metadata.fixtureRoles.map((role, index) => ({
          role,
          filename: `${FAILURE_ROLE}-${index}.fixture`,
          byteLength: 1,
          sha256: FAILURE_HASH,
        }))
      : [
          {
            role: FAILURE_ROLE,
            filename: `${FAILURE_ROLE}.fixture`,
            byteLength: 1,
            sha256: FAILURE_HASH,
          },
        ]
  return {
    directory: join(state.repositoryRoot, 'artifacts', 'perf', 'fixtures', FAILURE_ROLE),
    lockSha256: FAILURE_HASH,
    schemaVersion: 1,
    recipeVersion: 'unavailable',
    roles,
  }
}

function failureAttribution(state) {
  if (state.attribution) {
    return state.attribution
  }
  const rootPid = Number.isSafeInteger(state.rootPid) && state.rootPid >= 2 ? state.rootPid : 2
  return {
    method: 'posix-descendant',
    rootPid,
    coalition: null,
    preSnapshot: [],
    postSnapshot: [],
    selected: [],
    unselected: [],
  }
}

function makeFailureReport(state, error, status) {
  const metadata = failureMetadata(state)
  const source = failureSource(state)
  const fixture = failureFixture(state, metadata)
  const controls = state.controls ?? {
    metadata,
    sha256: canonicalSha256(normalizeControlsMetadata(metadata)),
  }
  const now = state.endedAt ?? state.startedAt ?? state.requestedAt
  const report = {
    $schema: RUN_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    producer: { ...PRODUCER },
    status,
    usable: false,
    failure: {
      code: error.code ?? 'SAMPLING_FAILED',
      phase: error.phase ?? 'unknown',
      message: safeErrorMessage(error),
    },
    run: {
      scenario: metadata.scenario,
      scenarioClass: metadata.scenarioClass,
      runId: metadata.runId,
      runIndex: metadata.runIndex,
      requestedAt: state.requestedAt,
      startedAt: state.startedAt,
      endedAt: now,
      requested: state.requested,
    },
    source,
    controls,
    fixture,
    host: state.host ?? defaultHost(),
    attribution: failureAttribution(state),
    tools: state.tools ?? [],
    commands: state.commands,
    measurements: state.measurements,
    rawFiles: state.rawFiles,
  }
  validateRunReport(report)
  return report
}

function makeCompletedReport(state) {
  return {
    $schema: RUN_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    producer: { ...PRODUCER },
    status: 'completed',
    usable: true,
    failure: null,
    run: {
      scenario: state.metadata.scenario,
      scenarioClass: state.metadata.scenarioClass,
      runId: state.metadata.runId,
      runIndex: state.metadata.runIndex,
      requestedAt: state.requestedAt,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      requested: state.requested,
    },
    source: state.source,
    controls: state.controls,
    fixture: state.fixture,
    host: state.host,
    attribution: state.attribution,
    tools: state.tools,
    commands: state.commands,
    measurements: state.measurements,
    rawFiles: state.rawFiles,
  }
}

export async function runExternalSampler(options, dependencies = {}) {
  const repositoryRoot = resolve(dependencies.repositoryRoot ?? REPOSITORY_ROOT)
  const roots = { runsRoot: dependencies.roots?.runsRoot ?? RUNS_ROOT }
  const now = dependencies.now ?? (() => new Date().toISOString())
  const signalSource = dependencies.signalSource ?? process
  const activeChildren = new Set()
  const signalState = { signal: null }
  const outputLimits = normalizeOutputLimits(dependencies.outputLimits)
  const writeArtifact = dependencies.writeNewFile ?? writeNewFile
  const renameArtifact = dependencies.rename ?? rename
  const linkArtifact = dependencies.link ?? link
  const unlinkArtifact = dependencies.unlink ?? unlink
  let retainedToolOutputBytes = 0
  const state = {
    requestedAt: timestampNow(now),
    startedAt: null,
    endedAt: null,
    requested: {
      ...requestedForReport(options),
    },
    repositoryRoot,
    rootPid: options?.rootPid,
    metadata: null,
    source: null,
    controls: null,
    fixture: null,
    host: null,
    attribution: null,
    tools: [],
    commands: [],
    measurements: [],
    rawFiles: [],
  }
  let outputPath
  let rawDirectory
  let fixtureBefore
  let fixtureBaselineVerified = false
  let fixtureVerifierClose
  let fixtureIntegrityGuard
  let completedRunContents
  let completedRunReport
  let runReportOwned = false
  let reportCleanupError
  let disposed = false
  const removeSignalListeners = () => {
    if (!disposed && signalSource && typeof signalSource.off === 'function') {
      signalSource.off('SIGINT', onSigint)
      signalSource.off('SIGTERM', onSigterm)
      disposed = true
    }
  }
  const interrupt = (signal) => {
    if (!signalState.signal) {
      signalState.signal = signal
      terminateToolChildren(activeChildren)
    }
  }
  const onSigint = () => interrupt('SIGINT')
  const onSigterm = () => interrupt('SIGTERM')
  if (signalSource && typeof signalSource.once === 'function') {
    signalSource.once('SIGINT', onSigint)
    signalSource.once('SIGTERM', onSigterm)
  }
  const assertNotInterrupted = () => {
    if (signalState.signal) {
      throw new InterruptedError(signalState.signal)
    }
  }
  const rawPaths = new Set()
  const writeRaw = async (relativePath, purpose, contents) => {
    if (!rawDirectory) {
      samplingError('OUTPUT_INVALID', 'output', 'raw output directory is unavailable')
    }
    if (rawPaths.has(relativePath)) {
      samplingError('OUTPUT_INVALID', 'output', `raw path would be overwritten: ${relativePath}`)
    }
    const bytes = asBuffer(contents)
    await writeArtifact(join(outputPath, relativePath), bytes)
    rawPaths.add(relativePath)
    const record = {
      path: relativePath,
      purpose,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    }
    state.rawFiles.push(record)
    return record
  }
  const runPath = () => join(outputPath, 'run.json')
  const inspectRunReportOwnership = async () => {
    let details
    try {
      details = await lstat(runPath())
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return 'absent'
      }
      return 'unowned'
    }
    if (!details.isFile() || details.isSymbolicLink()) {
      return 'unowned'
    }
    if (!runReportOwned || !completedRunContents) {
      return 'unowned'
    }
    try {
      const current = await readNoFollowRegularFile(runPath(), {
        label: 'run report',
        maxBytes: OUTPUT_LIMIT_BYTES.total,
      })
      return current.equals(completedRunContents) ? 'owned' : 'unowned'
    } catch {
      return 'unowned'
    }
  }
  const commitRunReport = async (
    contents,
    { requireNoSignal = false, recordCompleted = false } = {},
  ) => {
    const expectedOwnership = runReportOwned ? 'owned' : 'absent'
    if ((await inspectRunReportOwnership()) !== expectedOwnership) {
      return false
    }
    const stagingPath = join(outputPath, `.run.json.${randomUUID()}.staging`)
    const preparedPath = join(outputPath, `.run.json.${randomUUID()}.prepared`)
    let staged = true
    let prepared = false
    let publicationAttempted = false
    try {
      await writeArtifact(stagingPath, contents)
      if (requireNoSignal && signalState.signal) {
        return false
      }
      await renameArtifact(stagingPath, preparedPath)
      staged = false
      prepared = true
      if (requireNoSignal && signalState.signal) {
        return false
      }
      if (expectedOwnership === 'owned') {
        return false
      }
      publicationAttempted = true
      await linkArtifact(preparedPath, runPath())
      runReportOwned = true
      if (recordCompleted) {
        completedRunContents = Buffer.from(contents, 'utf8')
      }
      return true
    } catch {
      if (publicationAttempted) {
        try {
          const [preparedDetails, publishedDetails] = await Promise.all([
            lstat(preparedPath),
            lstat(runPath()),
          ])
          if (
            preparedDetails.isFile() &&
            publishedDetails.isFile() &&
            preparedDetails.dev === publishedDetails.dev &&
            preparedDetails.ino === publishedDetails.ino
          ) {
            const published = await readNoFollowRegularFile(runPath(), {
              label: 'run report after publish failure',
              maxBytes: OUTPUT_LIMIT_BYTES.total,
            })
            if (published.equals(Buffer.from(contents, 'utf8'))) {
              runReportOwned = true
              if (recordCompleted) {
                completedRunContents = Buffer.from(contents, 'utf8')
              }
              return true
            }
          }
        } catch {
          // The target remains unowned when it cannot be proven to contain this report.
        }
      }
      return false
    } finally {
      if (staged) {
        try {
          await unlinkArtifact(stagingPath)
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            reportCleanupError ??= error
          }
        }
      }
      if (prepared) {
        try {
          await unlinkArtifact(preparedPath)
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            reportCleanupError ??= error
          }
        }
      }
    }
  }
  const writeCompletedRunReport = async (report) => {
    const contents = `${JSON.stringify(report, null, 2)}\n`
    if (!(await commitRunReport(contents, { requireNoSignal: true, recordCompleted: true }))) {
      samplingError('OUTPUT_COMMIT', 'output', 'could not atomically commit completed run report')
    }
    completedRunReport = report
    if (reportCleanupError) {
      samplingError(
        'OUTPUT_CLEANUP',
        'output',
        `completed run report cleanup failed: ${safeErrorMessage(reportCleanupError)}`,
        reportCleanupError,
      )
    }
  }
  const replaceOwnedRunReport = async (contents) => {
    if ((await inspectRunReportOwnership()) !== 'owned') {
      return false
    }
    const stagingPath = join(outputPath, `.run.json.${randomUUID()}.staging`)
    const preparedPath = join(outputPath, `.run.json.${randomUUID()}.prepared`)
    const backupPath = join(outputPath, `.run.json.${randomUUID()}.owned-backup`)
    let staged = true
    let prepared = false
    let backupMoved = false
    let backupOwned = false
    try {
      if ((await inspectRunReportOwnership()) !== 'owned') {
        return false
      }
      // Move the currently-owned inode out of the public name. If another
      // writer wins the race between the ownership check and this rename, the
      // moved inode will not match completedRunContents; restore it without
      // deleting the foreign report and leave the replacement unpublished.
      await renameArtifact(runPath(), backupPath)
      backupMoved = true
      const backupContents = await readNoFollowRegularFile(backupPath, {
        label: 'owned completed run report backup',
        maxBytes: OUTPUT_LIMIT_BYTES.total,
      })
      backupOwned = Boolean(completedRunContents && backupContents.equals(completedRunContents))
      if (!backupOwned) {
        try {
          await linkArtifact(backupPath, runPath())
          await unlinkArtifact(backupPath)
          backupMoved = false
        } catch {
          // A foreign report may already occupy run.json. Never remove it or
          // the backup when ownership cannot be proven.
        }
        return false
      }
      await writeArtifact(stagingPath, contents)
      await renameArtifact(stagingPath, preparedPath)
      staged = false
      prepared = true
      // `link` is a no-replace publication primitive. A foreign creator that
      // appears after the rename therefore causes publication to fail rather
      // than being overwritten.
      await linkArtifact(preparedPath, runPath())
      await unlinkArtifact(backupPath)
      backupMoved = false
      runReportOwned = false
      completedRunContents = null
      return true
    } catch (error) {
      reportCleanupError ??= error
      return false
    } finally {
      if (staged) {
        try {
          await unlinkArtifact(stagingPath)
        } catch (error) {
          if (error?.code !== 'ENOENT') reportCleanupError ??= error
        }
      }
      if (prepared) {
        try {
          await unlinkArtifact(preparedPath)
        } catch (error) {
          if (error?.code !== 'ENOENT') reportCleanupError ??= error
        }
      }
      if (backupMoved && backupOwned) {
        try {
          await unlinkArtifact(backupPath)
        } catch (error) {
          if (error?.code !== 'ENOENT') reportCleanupError ??= error
        }
      }
    }
  }
  const writeFailureRunReport = async (report, { replaceOwned = false } = {}) => {
    const contents = `${JSON.stringify(report, null, 2)}\n`
    if (replaceOwned && runReportOwned) {
      return replaceOwnedRunReport(contents)
    }
    return commitRunReport(contents)
  }
  const executeTool = async (
    phase,
    tool,
    argv,
    rawStem,
    perturbing = false,
    parse = (value) => value,
  ) => {
    assertNotInterrupted()
    const path = TOOL_PATHS[tool]
    if (!path) {
      samplingError('TOOL_REFUSED', phase, `unknown fixed tool ${tool}`)
    }
    const stdoutPath = `raw/${rawStem}.stdout.txt`
    const stderrPath = `raw/${rawStem}.stderr.txt`
    const command = {
      phase,
      tool,
      argv: [...argv],
      start: timestampNow(now),
      end: null,
      exit: null,
      signal: null,
      timeout: false,
      stdout: stdoutPath,
      stderr: stderrPath,
      parse: { ok: false, message: null },
      perturbing,
    }
    state.commands.push(command)
    let result
    try {
      const commandRunner = dependencies.commandRunner ?? spawnFixedTool
      result = await commandRunner(path, argv, {
        shell: false,
        env: { ...FIXED_ENVIRONMENT },
        timeoutMs: toolTimeoutMs(phase, options),
        activeChildren,
        outputLimits,
        signalState,
        spawnProcess: dependencies.spawnProcess,
        terminationGraceMs: dependencies.terminationGraceMs,
      })
    } catch (error) {
      command.end = timestampNow(now)
      command.parse.message = safeErrorMessage(error)
      if (
        /permission denied|operation not permitted|not permitted|sip/i.test(safeErrorMessage(error))
      ) {
        samplingError('PERMISSION_DENIED', phase, `${tool} permission was denied`, error)
      }
      samplingError(
        'TOOL_ERROR',
        phase,
        `${tool} could not be started: ${safeErrorMessage(error)}`,
        error,
      )
    }
    const stdout = asBuffer(result?.stdout)
    const stderr = asBuffer(result?.stderr)
    command.end = timestampNow(now)
    command.exit = result?.exitCode ?? null
    command.signal = result?.signal ?? null
    command.timeout = result?.timedOut === true
    const retainedStdout = outputPrefix(stdout, outputLimits.stdout)
    const retainedStderr = outputPrefix(stderr, outputLimits.stderr)
    const totalRemaining = Math.max(0, outputLimits.total - retainedToolOutputBytes)
    const savedStdout = outputPrefix(retainedStdout, totalRemaining)
    const savedStderr = outputPrefix(
      retainedStderr,
      Math.max(0, totalRemaining - savedStdout.byteLength),
    )
    await writeRaw(stdoutPath, `${phase}:${tool}:stdout`, savedStdout)
    await writeRaw(stderrPath, `${phase}:${tool}:stderr`, savedStderr)
    retainedToolOutputBytes += savedStdout.byteLength + savedStderr.byteLength
    if (
      result?.outputLimited ||
      stdout.byteLength > outputLimits.stdout ||
      stderr.byteLength > outputLimits.stderr ||
      retainedStdout.byteLength + retainedStderr.byteLength > totalRemaining
    ) {
      command.parse.message = 'tool output exceeded the configured retention limit'
      samplingError('OUTPUT_LIMIT', phase, `${tool} output exceeded the configured limit`)
    }
    assertNotInterrupted()
    classifyToolFailure(result ?? {}, phase, tool)
    try {
      const parsed = parse({ stdout, stderr, result })
      command.parse.ok = true
      return { ...result, stdout, stderr, parsed, stdoutPath, stderrPath }
    } catch (error) {
      command.parse.message = safeErrorMessage(error)
      if (error instanceof SamplingError) {
        throw error
      }
      samplingError(
        'PARSE_FAILURE',
        phase,
        `${tool} output could not be parsed: ${safeErrorMessage(error)}`,
        error,
      )
    }
  }
  const closeFixture = async () => {
    if (typeof fixtureVerifierClose === 'function') {
      await Promise.resolve(fixtureVerifierClose()).catch(() => {})
    }
    fixtureVerifierClose = undefined
  }
  const closeFixtureIntegrityGuard = async () => {
    if (fixtureIntegrityGuard) {
      await fixtureIntegrityGuard.close()
    }
    fixtureIntegrityGuard = undefined
  }
  const fixtureToolRunnerImplementation =
    dependencies.fixtureToolRunner ??
    dependencies.fixtureCommandRunner ??
    ((executable, argv, options = {}) =>
      spawnFixedTool(executable, argv, {
        ...options,
        timeoutMs: options.timeoutMs ?? options.timeout ?? 30000,
        activeChildren,
        outputLimits,
        signalState,
        spawnProcess: dependencies.spawnProcess,
        terminationGraceMs: dependencies.terminationGraceMs,
      }))
  const fixtureToolRunner = async (...argumentsList) => {
    assertNotInterrupted()
    const result = await fixtureToolRunnerImplementation(...argumentsList)
    assertNotInterrupted()
    return result
  }
  const verifyFixtures = async (verifier, directory) => {
    assertNotInterrupted()
    let verified
    try {
      verified = await verifier({ directory, activeChildren, run: fixtureToolRunner })
    } catch (error) {
      if (signalState.signal) {
        throw new InterruptedError(signalState.signal)
      }
      if (fixtureBaselineVerified) {
        samplingError(
          'FIXTURE_DRIFT',
          'fixture',
          `fixture verification failed during sampling: ${safeErrorMessage(error)}`,
          error,
        )
      }
      if (error instanceof SamplingError) {
        throw error
      }
      if (error instanceof PerfInputError) {
        throw error
      }
      throw new PerfInputError(`Fixture verification refused: ${safeErrorMessage(error)}`)
    }
    try {
      if (signalState.signal) {
        await Promise.resolve(verified?.close?.()).catch(() => {})
      }
      assertNotInterrupted()
      if (fixtureIntegrityGuard) {
        await fixtureIntegrityGuard.assertUnchanged('fixture-verifier')
      }
    } catch (error) {
      await Promise.resolve(verified?.close?.()).catch(() => {})
      throw error
    }
    return verified
  }
  const readFixtureLock = async (pathname, label) => {
    assertNotInterrupted()
    try {
      const contents = await readNoFollowRegularFile(pathname, { label })
      assertNotInterrupted()
      return contents
    } catch (error) {
      if (signalState.signal) {
        throw new InterruptedError(signalState.signal)
      }
      if (fixtureBaselineVerified) {
        samplingError(
          'FIXTURE_DRIFT',
          'fixture',
          `${label} could not be read during sampling: ${safeErrorMessage(error)}`,
          error,
        )
      }
      throw error
    }
  }
  const captureAttribution = async (baseline, label) => {
    assertNotInterrupted()
    let result
    if (dependencies.captureAttribution) {
      result = await dependencies.captureAttribution({
        rootPid: options.rootPid,
        bundle: state.bundle,
        baseline,
        label,
      })
    } else {
      result = await captureMacosAttribution({
        rootPid: options.rootPid,
        bundle: state.bundle,
        helperPaths: dependencies.helperPaths,
        runCommand: async (file, argv) => {
          const tool = Object.entries(TOOL_PATHS).find(([, path]) => path === file)?.[0]
          if (!tool)
            samplingError('TOOL_REFUSED', 'attribution', `unexpected attribution tool ${file}`)
          const entry = await executeTool(
            'attribution',
            tool,
            argv,
            `${tool}-${state.commands.length}`,
          )
          return {
            stdout: entry.stdout.toString('utf8'),
            stderr: entry.stderr.toString('utf8'),
            exitCode: entry.exitCode,
          }
        },
      })
    }
    assertNotInterrupted()
    return result
  }
  const revalidate = async (baseline, label) => {
    assertNotInterrupted()
    let result
    if (dependencies.revalidateAttribution) {
      result = await dependencies.revalidateAttribution({
        rootPid: options.rootPid,
        baseline,
        bundle: state.bundle,
        label,
      })
    } else {
      const current = await captureAttribution(undefined, label)
      result = compareAttributionIdentity(baseline, current)
    }
    assertNotInterrupted()
    return result
  }
  try {
    if (!options || typeof options !== 'object') {
      throw new PerfInputError('Sampler options are required')
    }
    if (
      dependencies.platform !== undefined
        ? dependencies.platform !== 'darwin'
        : process.platform !== 'darwin'
    ) {
      throw new PerfInputError('External sampling is supported only on macOS')
    }
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1000 ||
      options.intervalMs % 1000 !== 0
    ) {
      throw new PerfInputError(
        'External sampling requires --interval-ms to be a whole number of seconds (>= 1000ms)',
      )
    }
    const metadataPath = await resolveStrictNoFollowChildPath(options.metadata, {
      label: 'Metadata path',
      root: repositoryRoot,
      repositoryRoot,
    })
    assertNotInterrupted()
    const metadataRead = await readJsonNoFollow(metadataPath, {
      label: 'metadata',
      maxBytes: METADATA_MAX_BYTES,
    })
    assertNotInterrupted()
    state.metadata = validateMetadataInput(metadataRead.value)
    if (state.metadata.scenarioClass === 'startup') {
      throw new PerfInputError('perf:sample refuses startup scenarioClass measurements')
    }
    outputPath = await createNewStrictOutputDirectory(options.output, {
      root: roots.runsRoot,
      repositoryRoot,
    })
    assertNotInterrupted()
    rawDirectory = join(outputPath, 'raw')
    await mkdir(rawDirectory)
    assertNotInterrupted()
    await writeRaw('raw/metadata.json', 'metadata', metadataRead.contents)
    assertNotInterrupted()
    state.startedAt = timestampNow(now)
    assertNotInterrupted()

    const availability = new Map()
    const available = dependencies.toolAvailable ?? isExecutableRegularFile
    let unavailableTool
    for (const [name, path] of Object.entries(TOOL_PATHS)) {
      assertNotInterrupted()
      const present = await available(path)
      assertNotInterrupted()
      availability.set(name, present === true)
      const requested = name !== 'sample' || options.stackDurationSeconds > 0
      if (requested && present !== true && !unavailableTool) {
        unavailableTool = { name, path }
      }
    }
    state.tools = fixedToolEntries(availability, options.stackDurationSeconds > 0)
    if (unavailableTool) {
      samplingError(
        'TOOL_UNAVAILABLE',
        'preflight',
        `${unavailableTool.name} is unavailable at ${unavailableTool.path}`,
      )
    }

    const expectedBundlePath = join(
      repositoryRoot,
      'src-tauri',
      'target',
      'release',
      'bundle',
      'macos',
      'Clarus Music.app',
    )
    const expectedReleaseBundlePath = dependencies.expectedBundlePath ?? expectedBundlePath
    const appBundlePath = resolve(repositoryRoot, options.appBundle)
    const bundleReader = dependencies.readBundle ?? readReleaseBundle
    assertNotInterrupted()
    state.bundle = await bundleReader({
      appBundlePath,
      expectedBundlePath: expectedReleaseBundlePath,
      runCommand: async (file, argv) => {
        const entry = await executeTool('bundle', 'plutil', argv, `plutil-${state.commands.length}`)
        return {
          stdout: entry.stdout.toString('utf8'),
          stderr: entry.stderr.toString('utf8'),
          exitCode: entry.exitCode,
        }
      },
    })
    assertNotInterrupted()
    const bundle = assertExpectedReleaseBundle(state.bundle)
    if (bundle.expectedBundlePath !== resolve(expectedBundlePath)) {
      samplingError(
        'BUNDLE_PATH',
        'preflight',
        'app bundle did not resolve exactly to this worktree release bundle',
      )
    }
    state.source = {
      repositoryRoot,
      gitCommit: '0'.repeat(40),
      dirty: false,
      appBundlePath: bundle.appBundlePath,
      appExecutablePath: bundle.executablePath,
      bundleId: bundle.bundleId,
      bundleVersion: bundle.bundleVersion,
      executableSha256: state.bundle.executableSha256,
      release: true,
    }

    const verifier = dependencies.fixtureVerifier ?? verifyFixtureSet
    // Retain the synchronous guard before entering the asynchronous verifier
    // and publish it to the outer lifecycle immediately. If verification
    // rejects, the catch/finally path must still close every descriptor.
    fixtureIntegrityGuard = retainInitialFixtureIntegrityGuard(options.fixtureDirectory)
    const verified = await verifyFixtures(verifier, options.fixtureDirectory)
    assertNotInterrupted()
    fixtureVerifierClose = verified.close
    fixtureIntegrityGuard ??= retainFixtureIntegrityGuardSync(verified)
    assertNotInterrupted()
    fixtureBaselineVerified = true
    const lockPath = join(verified.directory, 'fixtures.lock.json')
    const lockBytes = await readFixtureLock(lockPath, 'fixture lock')
    assertFixtureLockBytesMatch(lockBytes, verified.lock, 'fixture lock')
    await writeRaw('raw/fixtures.lock.json', 'fixture-lock', lockBytes)
    assertNotInterrupted()
    fixtureBefore = fixtureFingerprint(verified, lockBytes)
    state.fixture = {
      directory: fixtureBefore.directory,
      lockSha256: fixtureBefore.lockSha256,
      schemaVersion: verified.lock.schemaVersion,
      recipeVersion: verified.lock.recipeVersion,
      roles: normalizeFixtureRoles(verified.lock),
    }
    await fixtureIntegrityGuard.assertUnchanged('initial-baseline')
    assertNotInterrupted()
    state.metadata = validateMetadataInput(state.metadata, {
      fixtureRoles: new Set(state.fixture.roles.map((role) => role.role)),
    })
    await closeFixture()
    assertNotInterrupted()
    state.controls = {
      metadata: state.metadata,
      sha256: canonicalSha256(normalizeControlsMetadata(state.metadata)),
    }
    const hostReader =
      dependencies.readHost ??
      (async () => {
        const productVersion = await executeTool(
          'host',
          'sw_vers',
          ['-productVersion'],
          `sw-vers-product-${state.commands.length}`,
          false,
          ({ stdout }) => stdout.toString('utf8').trim(),
        )
        const buildVersion = await executeTool(
          'host',
          'sw_vers',
          ['-buildVersion'],
          `sw-vers-build-${state.commands.length}`,
          false,
          ({ stdout }) => stdout.toString('utf8').trim(),
        )
        const host = defaultHost()
        return {
          ...host,
          osVersion: productVersion.parsed || null,
          osBuild: buildVersion.parsed || null,
        }
      })
    assertNotInterrupted()
    state.host = await hostReader()
    assertNotInterrupted()
    const gitReader = dependencies.readGit
      ? dependencies.readGit
      : async () =>
          defaultReadGit({
            repositoryRoot,
            run: async (_name, argv, label) =>
              executeTool('source', 'git', argv, `${label}-${state.commands.length}`),
          })
    assertNotInterrupted()
    const git = await gitReader()
    assertNotInterrupted()
    state.source.gitCommit = git.commit
    state.source.dirty = git.dirty

    assertNotInterrupted()
    state.attribution = await captureAttribution(undefined, 'preflight')
    assertNotInterrupted()
    const attributionPreSnapshot = state.attribution.preSnapshot
    state.attribution = await revalidate(state.attribution, 'before-numeric')
    assertNotInterrupted()
    const selectedByRole = new Map(state.attribution.selected.map((entry) => [entry.role, entry]))
    const numericRoles = ['main', 'web-content', 'gpu', 'networking']
    if (numericRoles.some((role) => !selectedByRole.has(role))) {
      samplingError(
        'ATTRIBUTION_INVALID',
        'attribution',
        'attribution did not select exactly the four numeric roles',
      )
    }
    const fixedPids = numericRoles.map((role) => selectedByRole.get(role).pid)
    if (new Set(fixedPids).size !== fixedPids.length) {
      samplingError('ATTRIBUTION_INVALID', 'attribution', 'attributed role PIDs must be unique')
    }
    const verifiedBeforeTop = await verifyFixtures(verifier, options.fixtureDirectory)
    assertNotInterrupted()
    fixtureVerifierClose = verifiedBeforeTop.close
    const beforeTopLockBytes = await readFixtureLock(
      join(verifiedBeforeTop.directory, 'fixtures.lock.json'),
      'fixture lock before numeric sampling',
    )
    assertFixtureLockBytesMatch(
      beforeTopLockBytes,
      verifiedBeforeTop.lock,
      'fixture lock before numeric sampling',
    )
    const fixtureBeforeTop = fixtureFingerprint(verifiedBeforeTop, beforeTopLockBytes)
    if (!sameFixtureFingerprint(fixtureBefore, fixtureBeforeTop)) {
      samplingError('FIXTURE_DRIFT', 'fixture', 'fixture changed before numeric sampling')
    }
    await fixtureIntegrityGuard.assertUnchanged('before-top')
    await closeFixture()
    const topArguments = [
      '-l',
      String(options.samples + 1),
      '-s',
      String(options.intervalMs / 1000),
      '-stats',
      'pid,cpu,threads',
      '-pid',
    ]
    for (const pid of fixedPids) {
      topArguments.push(String(pid))
      topArguments.push('-pid')
    }
    topArguments.pop()
    const top = await executeTool('top', 'top', topArguments, 'top', false, ({ stdout }) =>
      parseTopOutput(stdout.toString('utf8'), { pids: fixedPids }),
    )
    await fixtureIntegrityGuard.assertUnchanged('top')
    if (top.parsed.length !== options.samples + 1) {
      samplingError(
        'PARSE_FAILURE',
        'top',
        `top must report exactly ${options.samples + 1} snapshots including warmup`,
      )
    }
    for (let index = 1; index < top.parsed.length; index += 1) {
      const observedAt = timestampNow(now)
      for (const role of numericRoles) {
        const pid = selectedByRole.get(role).pid
        const sample = top.parsed[index].get(pid)
        state.measurements.push(
          {
            sampleIndex: index - 1,
            observedAt,
            phase: 'top',
            tool: 'top',
            role,
            pid,
            metric: 'cpu.percent',
            unit: METRIC_UNITS['cpu.percent'],
            value: sample.cpuPercent,
            rawFile: top.stdoutPath,
          },
          {
            sampleIndex: index - 1,
            observedAt,
            phase: 'top',
            tool: 'top',
            role,
            pid,
            metric: 'process.thread_count',
            unit: METRIC_UNITS['process.thread_count'],
            value: sample.threadCount,
            rawFile: top.stdoutPath,
          },
        )
      }
    }
    state.attribution = await revalidate(state.attribution, 'between-top-footprint')
    const reselected = new Map(state.attribution.selected.map((entry) => [entry.role, entry]))
    for (const role of numericRoles) {
      if (!reselected.has(role) || reselected.get(role).pid !== selectedByRole.get(role).pid) {
        samplingError(
          'ATTRIBUTION_DRIFT',
          'attribution',
          `${role} PID changed before footprint sampling`,
        )
      }
    }
    for (let sampleIndex = 0; sampleIndex < options.samples; sampleIndex += 1) {
      let pointTotal = 0
      const totalSources = []
      for (const role of numericRoles) {
        const pid = selectedByRole.get(role).pid
        const stem = `footprint-${String(sampleIndex).padStart(3, '0')}-${role}`
        const footprint = await executeTool(
          'footprint',
          'footprint',
          ['--format', 'bytes', '-p', String(pid)],
          stem,
          false,
          ({ stdout }) => parseFootprintOutput(stdout.toString('utf8')),
        )
        const observedAt = timestampNow(now)
        const values = footprint.parsed
        pointTotal += values.physicalFootprintBytes
        totalSources.push({
          pid,
          physicalFootprintBytes: values.physicalFootprintBytes,
          rawFile: footprint.stdoutPath,
        })
        state.measurements.push(
          {
            sampleIndex,
            observedAt,
            phase: 'footprint',
            tool: 'footprint',
            role,
            pid,
            metric: 'memory.physical_footprint_bytes',
            unit: METRIC_UNITS['memory.physical_footprint_bytes'],
            value: values.physicalFootprintBytes,
            rawFile: footprint.stdoutPath,
          },
          {
            sampleIndex,
            observedAt,
            phase: 'footprint',
            tool: 'footprint',
            role,
            pid,
            metric: 'memory.physical_footprint_peak_bytes',
            unit: METRIC_UNITS['memory.physical_footprint_peak_bytes'],
            value: values.physicalFootprintPeakBytes,
            rawFile: footprint.stdoutPath,
          },
        )
      }
      const totalRawPath = `raw/footprint-${String(sampleIndex).padStart(3, '0')}-total.json`
      await writeRaw(
        totalRawPath,
        'footprint-point-total',
        `${canonicalJson({ sources: totalSources })}\n`,
      )
      state.measurements.push({
        sampleIndex,
        observedAt: timestampNow(now),
        phase: 'footprint',
        tool: 'footprint',
        role: 'process-total',
        pid: selectedByRole.get('main').pid,
        metric: 'memory.total_physical_footprint_bytes',
        unit: METRIC_UNITS['memory.total_physical_footprint_bytes'],
        value: pointTotal,
        rawFile: totalRawPath,
      })
    }
    await fixtureIntegrityGuard.assertUnchanged('footprint')
    state.attribution = await revalidate(state.attribution, 'between-footprint-stack')
    if (options.stackDurationSeconds > 0) {
      for (const role of ['main', 'web-content']) {
        const pid = selectedByRole.get(role).pid
        await executeTool(
          'stack',
          'sample',
          [
            String(pid),
            String(options.stackDurationSeconds),
            '-interval',
            String(options.stackIntervalMs),
          ],
          `sample-${role}`,
          true,
        )
      }
      await fixtureIntegrityGuard.assertUnchanged('stack')
    }
    const finalAttribution = await revalidate(state.attribution, 'after')
    state.attribution = {
      ...finalAttribution,
      preSnapshot: attributionPreSnapshot,
      postSnapshot: finalAttribution.postSnapshot,
    }
    assertNotInterrupted()
    await fixtureIntegrityGuard.assertUnchanged('post-collection')
    const verifiedAfter = await verifyFixtures(verifier, options.fixtureDirectory)
    fixtureVerifierClose = verifiedAfter.close
    await fixtureIntegrityGuard.assertUnchanged('final-verifier')
    const afterLockBytes = await readFixtureLock(
      join(verifiedAfter.directory, 'fixtures.lock.json'),
      'fixture lock after sampling',
    )
    assertFixtureLockBytesMatch(afterLockBytes, verifiedAfter.lock, 'fixture lock after sampling')
    await fixtureIntegrityGuard.assertUnchanged('final-lock')
    const fixtureAfter = fixtureFingerprint(verifiedAfter, afterLockBytes)
    await closeFixture()
    assertNotInterrupted()
    if (!sameFixtureFingerprint(fixtureBefore, fixtureAfter)) {
      samplingError(
        'FIXTURE_DRIFT',
        'fixture',
        'fixture directory, lock, bytes, or hashes changed during sampling',
      )
    }
    state.endedAt = timestampNow(now)
    assertNotInterrupted()
    const report = makeCompletedReport(state)
    validateRunReport(report)
    assertNotInterrupted()
    await writeArtifact(
      join(outputPath, 'measurements.csv'),
      renderMeasurementsCsv({
        runId: state.metadata.runId,
        scenario: state.metadata.scenario,
        runIndex: state.metadata.runIndex,
        measurements: state.measurements,
      }),
    )
    assertNotInterrupted()
    await writeArtifact(join(outputPath, 'summary.txt'), renderRunSummary(report))
    assertNotInterrupted()
    await writeCompletedRunReport(report)
    assertNotInterrupted()
    return { exitCode: 0, outputPath, report }
  } catch (error) {
    state.endedAt ??= timestampNow(now)
    await closeFixture()
    await closeFixtureIntegrityGuard()
    const isInputOrPreflightRefusal =
      error instanceof PerfInputError ||
      (error instanceof SamplingError && error.phase === 'preflight')
    const signal = error instanceof InterruptedError ? error.signal : signalState.signal
    const status = signal ? 'interrupted' : 'failed'
    const exitCode =
      signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : isInputOrPreflightRefusal ? 2 : 3
    const report = makeFailureReport(state, error, status)
    if (outputPath) {
      const failurePublished = await writeFailureRunReport(report, {
        replaceOwned: Boolean(signal),
      })
      if (signal) {
        return { exitCode, outputPath, report, error }
      }
      if (
        !failurePublished &&
        completedRunReport &&
        (await inspectRunReportOwnership()) === 'owned'
      ) {
        return {
          exitCode: 0,
          outputPath,
          report: completedRunReport,
          error,
          ...(reportCleanupError ? { cleanupError: reportCleanupError } : {}),
        }
      }
    }
    return { exitCode, outputPath, report, error }
  } finally {
    try {
      await terminateToolChildren(activeChildren)
    } finally {
      try {
        await closeFixtureIntegrityGuard()
      } finally {
        removeSignalListeners()
      }
    }
  }
}
