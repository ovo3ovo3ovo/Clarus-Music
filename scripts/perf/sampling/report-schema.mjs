import { createHash } from 'node:crypto'
import { isAbsolute, posix, win32 } from 'node:path'

export const RUN_SCHEMA = 'clarus.perf.run'
export const SUMMARY_SCHEMA = 'clarus.perf.summary'
export const SCHEMA_VERSION = 1
export const PRODUCER = Object.freeze({
  name: 'clarus-perf-external-sampler',
  version: 1,
})

export const MEASUREMENT_ROLES = Object.freeze([
  'main',
  'web-content',
  'gpu',
  'networking',
  'process-total',
])

export const METRIC_UNITS = Object.freeze({
  'cpu.percent': 'percent',
  'process.thread_count': 'count',
  'memory.physical_footprint_bytes': 'bytes',
  'memory.physical_footprint_peak_bytes': 'bytes',
  'memory.total_physical_footprint_bytes': 'bytes',
})

// A completed sampler run must expose every descriptor emitted by the fixed
// top/footprint collection plan.  Keep this contract independent from whatever
// metrics happen to be present in an input run so a partial set cannot become a
// complete cohort by inference.
export const REQUIRED_MEASUREMENT_DESCRIPTORS = Object.freeze([
  ...['main', 'web-content', 'gpu', 'networking'].flatMap((role) => [
    Object.freeze({ role, metric: 'cpu.percent', unit: 'percent' }),
    Object.freeze({ role, metric: 'process.thread_count', unit: 'count' }),
    Object.freeze({ role, metric: 'memory.physical_footprint_bytes', unit: 'bytes' }),
    Object.freeze({ role, metric: 'memory.physical_footprint_peak_bytes', unit: 'bytes' }),
  ]),
  Object.freeze({
    role: 'process-total',
    metric: 'memory.total_physical_footprint_bytes',
    unit: 'bytes',
  }),
])

const REQUIRED_MEASUREMENT_DESCRIPTOR_KEYS = new Set(
  REQUIRED_MEASUREMENT_DESCRIPTORS.map(descriptorKey),
)

const METADATA_KEYS = Object.freeze([
  'scenario',
  'scenarioClass',
  'runId',
  'runIndex',
  'buildKind',
  'coldWarm',
  'cacheState',
  'windowCssPx',
  'displayScale',
  'powerSource',
  'powerMode',
  'volume',
  'outputDevice',
  'networkProfile',
  'settingsFixture',
  'queueFixture',
  'fixtureRoles',
  'notes',
])

const RUN_TOP_LEVEL_KEYS = Object.freeze([
  '$schema',
  'schemaVersion',
  'producer',
  'status',
  'usable',
  'failure',
  'run',
  'source',
  'controls',
  'fixture',
  'host',
  'attribution',
  'tools',
  'commands',
  'measurements',
  'rawFiles',
])

const SUMMARY_TOP_LEVEL_KEYS = Object.freeze([
  '$schema',
  'schemaVersion',
  'producer',
  'cohort',
  'runs',
  'compliance',
  'statistics',
])

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}$/
function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function fail(message) {
  throw new Error(message)
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label)
  const expected = new Set(keys)
  const unknown = Object.keys(value).filter((key) => !expected.has(key))
  const missing = keys.filter((key) => !(key in value))
  if (unknown.length > 0) {
    fail(`${label} has unknown property: ${unknown.join(', ')}`)
  }
  if (missing.length > 0) {
    fail(`${label} is missing property: ${missing.join(', ')}`)
  }
}

function assertString(value, label, { maxLength = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
  if (nullable && value === null) {
    return
  }
  if (typeof value !== 'string') {
    fail(`${label} must be a string${nullable ? ' or null' : ''}`)
  }
  if (value.length > maxLength) {
    fail(`${label} must be at most ${maxLength} characters`)
  }
  if (hasControlCharacters(value)) {
    fail(`${label} must not contain control characters`)
  }
}

function assertFiniteNumber(value, label, { minimum = -Infinity, nullable = false } = {}) {
  if (nullable && value === null) {
    return
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} must be a finite number${nullable ? ' or null' : ''}`)
  }
  if (value < minimum) {
    fail(`${label} must be at least ${minimum}`)
  }
}

function assertSafeInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be a safe integer${minimum > 0 ? ` >= ${minimum}` : ''}`)
  }
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hash`)
  }
}

function assertTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) {
    return
  }
  assertString(value, label)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be an ISO-8601 UTC millisecond timestamp`)
  }
}

export function assertSafeRelativeArtifactPath(value, label = 'artifact path') {
  assertString(value, label)
  if (
    value.length === 0 ||
    value.includes('\\') ||
    isAbsolute(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split('/').some((component) => component.length === 0 || component === '.' || component === '..')
  ) {
    fail(`${label} must be a safe relative path`)
  }
  return value
}

function assertAbsolutePath(value, label) {
  assertString(value, label)
  if (!isAbsolute(value) || value.includes('\\') || value.split('/').some((component) => component === '..')) {
    fail(`${label} must be an absolute non-traversing path`)
  }
}

function assertProducer(value) {
  assertExactKeys(value, ['name', 'version'], 'producer')
  if (value.name !== PRODUCER.name || value.version !== PRODUCER.version) {
    fail('producer is unsupported')
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail(`${label} must match ${IDENTIFIER_PATTERN}`)
  }
}

function assertNullableShortString(value, label) {
  assertString(value, label, { maxLength: 256, nullable: true })
}

export function validateMetadata(value, { fixtureRoles } = {}) {
  assertExactKeys(value, METADATA_KEYS, 'metadata')
  assertIdentifier(value.scenario, 'metadata.scenario')
  if (value.scenarioClass !== 'runtime' && value.scenarioClass !== 'startup') {
    fail('metadata.scenarioClass must be runtime or startup')
  }
  assertIdentifier(value.runId, 'metadata.runId')
  assertSafeInteger(value.runIndex, 'metadata.runIndex', { minimum: 1 })
  if (value.buildKind !== 'release') {
    fail('metadata.buildKind must be release')
  }
  if (value.coldWarm !== 'cold' && value.coldWarm !== 'warm') {
    fail('metadata.coldWarm must be cold or warm')
  }
  if (!['hit', 'miss', 'empty', 'not-applicable'].includes(value.cacheState)) {
    fail('metadata.cacheState is invalid')
  }
  assertExactKeys(value.windowCssPx, ['width', 'height'], 'metadata.windowCssPx')
  assertSafeInteger(value.windowCssPx.width, 'metadata.windowCssPx.width', { minimum: 1 })
  assertSafeInteger(value.windowCssPx.height, 'metadata.windowCssPx.height', { minimum: 1 })
  assertFiniteNumber(value.displayScale, 'metadata.displayScale', { minimum: Number.MIN_VALUE })
  if (!['ac', 'battery', 'unknown'].includes(value.powerSource)) {
    fail('metadata.powerSource is invalid')
  }
  if (!['normal', 'low-power', 'unknown'].includes(value.powerMode)) {
    fail('metadata.powerMode is invalid')
  }
  if (value.volume !== null) {
    assertFiniteNumber(value.volume, 'metadata.volume', { minimum: 0 })
    if (value.volume > 1) {
      fail('metadata.volume must be no greater than 1')
    }
  }
  assertNullableShortString(value.outputDevice, 'metadata.outputDevice')
  if (!['loopback', 'offline', 'controlled-remote'].includes(value.networkProfile)) {
    fail('metadata.networkProfile is invalid')
  }
  assertNullableShortString(value.settingsFixture, 'metadata.settingsFixture')
  assertNullableShortString(value.queueFixture, 'metadata.queueFixture')
  if (!Array.isArray(value.fixtureRoles)) {
    fail('metadata.fixtureRoles must be an array')
  }
  const verifiedRoles = fixtureRoles === undefined ? undefined : new Set(fixtureRoles)
  const seenRoles = new Set()
  for (const role of value.fixtureRoles) {
    assertString(role, 'metadata.fixtureRoles entry', { maxLength: 256 })
    if (seenRoles.has(role)) {
      fail('metadata.fixtureRoles must be unique')
    }
    if (verifiedRoles && !verifiedRoles.has(role)) {
      fail('metadata.fixtureRoles must be present in the verified lock')
    }
    seenRoles.add(role)
  }
  assertString(value.notes, 'metadata.notes', { maxLength: 1024, nullable: true })
  return value
}

export function normalizeControlsMetadata(value) {
  validateMetadata(value)
  const controls = { ...value }
  delete controls.runId
  delete controls.runIndex
  return {
    ...controls,
    windowCssPx: { ...controls.windowCssPx },
    fixtureRoles: [...controls.fixtureRoles],
  }
}

function assertRequested(value) {
  assertExactKeys(value, ['samples', 'intervalMs', 'stackDurationSeconds', 'stackIntervalMs'], 'run.requested')
  assertSafeInteger(value.samples, 'run.requested.samples', { minimum: 5 })
  if (value.samples > 3600) {
    fail('run.requested.samples must be no greater than 3600')
  }
  assertSafeInteger(value.intervalMs, 'run.requested.intervalMs', { minimum: 250 })
  if (value.intervalMs > 60000) {
    fail('run.requested.intervalMs must be no greater than 60000')
  }
  if (value.samples * value.intervalMs > 3600000) {
    fail('run.requested samples × intervalMs must be no greater than 3600000')
  }
  assertSafeInteger(value.stackDurationSeconds, 'run.requested.stackDurationSeconds', { minimum: 0 })
  if (value.stackDurationSeconds > 60) {
    fail('run.requested.stackDurationSeconds must be no greater than 60')
  }
  assertSafeInteger(value.stackIntervalMs, 'run.requested.stackIntervalMs', { minimum: 1 })
  if (value.stackIntervalMs > 1000) {
    fail('run.requested.stackIntervalMs must be no greater than 1000')
  }
}

function assertRoleMetricUnit(value, label) {
  if (!MEASUREMENT_ROLES.includes(value.role)) {
    fail(`${label}.role is invalid`)
  }
  if (!(value.metric in METRIC_UNITS)) {
    fail(`${label}.metric is invalid`)
  }
  if (value.unit !== METRIC_UNITS[value.metric]) {
    fail(`${label}.unit is invalid for metric`)
  }
}

export function validateMeasurement(value) {
  assertExactKeys(
    value,
    ['sampleIndex', 'observedAt', 'phase', 'tool', 'role', 'pid', 'metric', 'unit', 'value', 'rawFile'],
    'measurement',
  )
  assertSafeInteger(value.sampleIndex, 'measurement.sampleIndex', { minimum: 0 })
  assertTimestamp(value.observedAt, 'measurement.observedAt')
  if (value.phase !== 'top' && value.phase !== 'footprint') {
    fail('measurement.phase is invalid')
  }
  if (value.tool !== 'top' && value.tool !== 'footprint') {
    fail('measurement.tool is invalid')
  }
  assertRoleMetricUnit(value, 'measurement')
  if (!REQUIRED_MEASUREMENT_DESCRIPTOR_KEYS.has(descriptorKey(value))) {
    fail('measurement role/metric/unit combination is not in the fixed collection plan')
  }
  if (value.tool !== value.phase) {
    fail('measurement phase and tool must match')
  }
  const expectedPhase = ['cpu.percent', 'process.thread_count'].includes(value.metric)
    ? 'top'
    : 'footprint'
  if (value.phase !== expectedPhase) {
    fail(`measurement ${value.metric} must use the ${expectedPhase} phase and tool`)
  }
  assertSafeInteger(value.pid, 'measurement.pid', { minimum: 2 })
  assertFiniteNumber(value.value, 'measurement.value', { minimum: 0 })
  assertSafeRelativeArtifactPath(value.rawFile, 'measurement.rawFile')
  return value
}

function assertFailure(value) {
  assertExactKeys(value, ['code', 'phase', 'message'], 'failure')
  assertString(value.code, 'failure.code', { maxLength: 128 })
  assertString(value.phase, 'failure.phase', { maxLength: 128 })
  assertString(value.message, 'failure.message', { maxLength: 1024 })
}

function assertRunIdentity(value) {
  assertExactKeys(
    value,
    ['scenario', 'scenarioClass', 'runId', 'runIndex', 'requestedAt', 'startedAt', 'endedAt', 'requested'],
    'run',
  )
  assertIdentifier(value.scenario, 'run.scenario')
  if (value.scenarioClass !== 'runtime' && value.scenarioClass !== 'startup') {
    fail('run.scenarioClass is invalid')
  }
  assertIdentifier(value.runId, 'run.runId')
  assertSafeInteger(value.runIndex, 'run.runIndex', { minimum: 1 })
  assertTimestamp(value.requestedAt, 'run.requestedAt')
  assertTimestamp(value.startedAt, 'run.startedAt', { nullable: true })
  assertTimestamp(value.endedAt, 'run.endedAt', { nullable: true })
  if (value.startedAt !== null && value.endedAt !== null && value.startedAt > value.endedAt) {
    fail('run timestamps are inconsistent')
  }
  assertRequested(value.requested)
}

function assertSource(value) {
  assertExactKeys(
    value,
    [
      'repositoryRoot',
      'gitCommit',
      'dirty',
      'appBundlePath',
      'appExecutablePath',
      'bundleId',
      'bundleVersion',
      'executableSha256',
      'release',
    ],
    'source',
  )
  assertAbsolutePath(value.repositoryRoot, 'source.repositoryRoot')
  if (typeof value.gitCommit !== 'string' || !COMMIT_PATTERN.test(value.gitCommit)) {
    fail('source.gitCommit must be a full lowercase commit SHA')
  }
  if (typeof value.dirty !== 'boolean') {
    fail('source.dirty must be boolean')
  }
  assertAbsolutePath(value.appBundlePath, 'source.appBundlePath')
  assertAbsolutePath(value.appExecutablePath, 'source.appExecutablePath')
  if (!value.appBundlePath.endsWith('.app')) {
    fail('source.appBundlePath must end in .app')
  }
  assertString(value.bundleId, 'source.bundleId', { maxLength: 256 })
  assertString(value.bundleVersion, 'source.bundleVersion', { maxLength: 256 })
  assertHash(value.executableSha256, 'source.executableSha256')
  if (value.release !== true) {
    fail('source.release must be true')
  }
}

function assertControls(value) {
  assertExactKeys(value, ['metadata', 'sha256'], 'controls')
  validateMetadata(value.metadata)
  assertHash(value.sha256, 'controls.sha256')
  if (canonicalSha256(normalizeControlsMetadata(value.metadata)) !== value.sha256) {
    fail('controls.sha256 does not match canonical metadata')
  }
}

function assertFixtureRole(value) {
  assertExactKeys(value, ['role', 'filename', 'byteLength', 'sha256'], 'fixture.roles entry')
  assertString(value.role, 'fixture.roles role', { maxLength: 256 })
  assertString(value.filename, 'fixture.roles filename', { maxLength: 256 })
  if (value.filename.includes('/') || value.filename.includes('\\') || value.filename.includes('..')) {
    fail('fixture.roles filename is unsafe')
  }
  assertSafeInteger(value.byteLength, 'fixture.roles byteLength', { minimum: 1 })
  assertHash(value.sha256, 'fixture.roles sha256')
}

function assertFixture(value) {
  assertExactKeys(value, ['directory', 'lockSha256', 'schemaVersion', 'recipeVersion', 'roles'], 'fixture')
  assertAbsolutePath(value.directory, 'fixture.directory')
  assertHash(value.lockSha256, 'fixture.lockSha256')
  assertSafeInteger(value.schemaVersion, 'fixture.schemaVersion', { minimum: 1 })
  assertString(value.recipeVersion, 'fixture.recipeVersion', { maxLength: 256 })
  if (!Array.isArray(value.roles) || value.roles.length === 0) {
    fail('fixture.roles must be a non-empty array')
  }
  const roles = new Set()
  for (const role of value.roles) {
    assertFixtureRole(role)
    if (roles.has(role.role)) {
      fail('fixture.roles must not contain duplicate roles')
    }
    roles.add(role.role)
  }
}

function assertHost(value) {
  assertExactKeys(
    value,
    ['platform', 'osVersion', 'osBuild', 'arch', 'nodeVersion', 'timezone', 'cpu', 'memoryBytes'],
    'host',
  )
  if (value.platform !== 'darwin') {
    fail('host.platform must be darwin')
  }
  assertNullableShortString(value.osVersion, 'host.osVersion')
  assertNullableShortString(value.osBuild, 'host.osBuild')
  assertNullableShortString(value.arch, 'host.arch')
  assertNullableShortString(value.nodeVersion, 'host.nodeVersion')
  assertNullableShortString(value.timezone, 'host.timezone')
  assertExactKeys(value.cpu, ['model', 'cores'], 'host.cpu')
  assertNullableShortString(value.cpu.model, 'host.cpu.model')
  if (value.cpu.cores !== null) {
    assertSafeInteger(value.cpu.cores, 'host.cpu.cores', { minimum: 1 })
  }
  if (value.memoryBytes !== null) {
    assertSafeInteger(value.memoryBytes, 'host.memoryBytes', { minimum: 0 })
  }
}

function assertSnapshotProcess(value, label) {
  assertExactKeys(value, ['pid', 'ppid', 'start', 'path', 'realpath'], label)
  assertSafeInteger(value.pid, `${label}.pid`, { minimum: 2 })
  assertSafeInteger(value.ppid, `${label}.ppid`, { minimum: 0 })
  assertString(value.start, `${label}.start`, { maxLength: 256 })
  assertAbsolutePath(value.path, `${label}.path`)
  assertAbsolutePath(value.realpath, `${label}.realpath`)
}

function assertSelectedProcess(value) {
  assertExactKeys(value, ['role', 'pid', 'start', 'path', 'realpath'], 'attribution.selected entry')
  if (!['main', 'web-content', 'gpu', 'networking'].includes(value.role)) {
    fail('attribution.selected role is invalid')
  }
  assertSafeInteger(value.pid, 'attribution.selected pid', { minimum: 2 })
  assertString(value.start, 'attribution.selected start', { maxLength: 256 })
  assertAbsolutePath(value.path, 'attribution.selected path')
  assertAbsolutePath(value.realpath, 'attribution.selected realpath')
}

function assertAttribution(value) {
  assertExactKeys(
    value,
    ['method', 'rootPid', 'coalition', 'preSnapshot', 'postSnapshot', 'selected', 'unselected'],
    'attribution',
  )
  if (!['posix-descendant', 'launchservices-coalition'].includes(value.method)) {
    fail('attribution.method is invalid')
  }
  assertSafeInteger(value.rootPid, 'attribution.rootPid', { minimum: 2 })
  if (value.coalition !== null) {
    assertExactKeys(value.coalition, ['id', 'asn'], 'attribution.coalition')
    assertString(value.coalition.id, 'attribution.coalition.id', { maxLength: 256 })
    assertString(value.coalition.asn, 'attribution.coalition.asn', { maxLength: 256 })
  }
  for (const [name, processes] of [
    ['attribution.preSnapshot', value.preSnapshot],
    ['attribution.postSnapshot', value.postSnapshot],
  ]) {
    if (!Array.isArray(processes)) {
      fail(`${name} must be an array`)
    }
    const pids = new Set()
    for (const process of processes) {
      assertSnapshotProcess(process, `${name} entry`)
      if (pids.has(process.pid)) {
        fail(`${name} must not contain duplicate PIDs`)
      }
      pids.add(process.pid)
    }
  }
  if (!Array.isArray(value.selected) || !Array.isArray(value.unselected)) {
    fail('attribution selected and unselected must be arrays')
  }
  const selectedRoles = new Set()
  const selectedPids = new Set()
  for (const process of value.selected) {
    assertSelectedProcess(process)
    if (selectedRoles.has(process.role) || selectedPids.has(process.pid)) {
      fail('attribution.selected must have unique roles and PIDs')
    }
    selectedRoles.add(process.role)
    selectedPids.add(process.pid)
  }
  for (const process of value.unselected) {
    assertExactKeys(process, ['pid', 'ppid', 'start', 'path', 'realpath', 'reason'], 'attribution.unselected entry')
    assertSnapshotProcess(
      {
        pid: process.pid,
        ppid: process.ppid,
        start: process.start,
        path: process.path,
        realpath: process.realpath,
      },
      'attribution.unselected entry',
    )
    assertString(process.reason, 'attribution.unselected reason', { maxLength: 256 })
  }
}

function assertTools(value) {
  if (!Array.isArray(value)) {
    fail('tools must be an array')
  }
  const names = new Set()
  for (const tool of value) {
    assertExactKeys(tool, ['name', 'path', 'requested', 'available'], 'tools entry')
    if (!['ps', 'lsappinfo', 'plutil', 'git', 'sw_vers', 'top', 'footprint', 'sample'].includes(tool.name)) {
      fail('tools entry has an unsupported name')
    }
    assertAbsolutePath(tool.path, 'tools entry path')
    if (typeof tool.requested !== 'boolean' || typeof tool.available !== 'boolean') {
      fail('tools requested and available must be boolean')
    }
    if (names.has(tool.name)) {
      fail('tools must not contain duplicate names')
    }
    names.add(tool.name)
  }
}

function assertCommand(value) {
  assertExactKeys(
    value,
    ['phase', 'tool', 'argv', 'start', 'end', 'exit', 'signal', 'timeout', 'stdout', 'stderr', 'parse', 'perturbing'],
    'commands entry',
  )
  assertString(value.phase, 'commands phase', { maxLength: 128 })
  assertString(value.tool, 'commands tool', { maxLength: 128 })
  if (!Array.isArray(value.argv) || value.argv.some((argument) => typeof argument !== 'string' || hasControlCharacters(argument))) {
    fail('commands argv must be a string array without control characters')
  }
  assertTimestamp(value.start, 'commands start')
  assertTimestamp(value.end, 'commands end', { nullable: true })
  if (value.exit !== null) {
    assertSafeInteger(value.exit, 'commands exit', { minimum: 0 })
  }
  if (value.signal !== null && !['SIGINT', 'SIGTERM', 'SIGKILL'].includes(value.signal)) {
    fail('commands signal is invalid')
  }
  if (typeof value.timeout !== 'boolean' || typeof value.perturbing !== 'boolean') {
    fail('commands timeout and perturbing must be boolean')
  }
  assertSafeRelativeArtifactPath(value.stdout, 'commands stdout')
  assertSafeRelativeArtifactPath(value.stderr, 'commands stderr')
  assertExactKeys(value.parse, ['ok', 'message'], 'commands parse')
  if (typeof value.parse.ok !== 'boolean') {
    fail('commands parse.ok must be boolean')
  }
  assertString(value.parse.message, 'commands parse.message', { maxLength: 1024, nullable: true })
}

function assertRawFile(value) {
  assertExactKeys(value, ['path', 'purpose', 'byteLength', 'sha256'], 'rawFiles entry')
  assertSafeRelativeArtifactPath(value.path, 'rawFiles path')
  assertString(value.purpose, 'rawFiles purpose', { maxLength: 256 })
  assertSafeInteger(value.byteLength, 'rawFiles byteLength', { minimum: 0 })
  assertHash(value.sha256, 'rawFiles sha256')
}

export function validateRunReport(value) {
  assertExactKeys(value, RUN_TOP_LEVEL_KEYS, 'run report')
  if (value.$schema !== RUN_SCHEMA || value.schemaVersion !== SCHEMA_VERSION) {
    fail('run report has an unsupported $schema or schemaVersion')
  }
  assertProducer(value.producer)
  if (!['completed', 'failed', 'interrupted'].includes(value.status)) {
    fail('run report status is invalid')
  }
  if (typeof value.usable !== 'boolean') {
    fail('run report usable must be boolean')
  }
  if (value.status === 'completed') {
    if (value.usable !== true || value.failure !== null) {
      fail('completed run report must be usable with null failure')
    }
  } else {
    if (value.usable !== false || value.failure === null) {
      fail('failed or interrupted run report must be unusable with a failure')
    }
  }
  if (value.failure !== null) {
    assertFailure(value.failure)
  }
  assertRunIdentity(value.run)
  assertSource(value.source)
  assertControls(value.controls)
  if (
    value.run.scenario !== value.controls.metadata.scenario ||
    value.run.scenarioClass !== value.controls.metadata.scenarioClass ||
    value.run.runId !== value.controls.metadata.runId ||
    value.run.runIndex !== value.controls.metadata.runIndex
  ) {
    fail('run identity must match controls metadata')
  }
  assertFixture(value.fixture)
  validateMetadata(value.controls.metadata, {
    fixtureRoles: new Set(value.fixture.roles.map((role) => role.role)),
  })
  assertHost(value.host)
  assertAttribution(value.attribution)
  assertTools(value.tools)
  if (!Array.isArray(value.commands)) {
    fail('commands must be an array')
  }
  for (const command of value.commands) {
    assertCommand(command)
  }
  if (!Array.isArray(value.measurements)) {
    fail('measurements must be an array')
  }
  if (value.status === 'completed' && value.measurements.length === 0) {
    fail('completed run reports must contain normalized measurements')
  }
  for (const measurement of value.measurements) {
    validateMeasurement(measurement)
  }
  if (value.status === 'completed') {
    const actualDescriptors = new Set(value.measurements.map(descriptorKey))
    if (
      actualDescriptors.size !== REQUIRED_MEASUREMENT_DESCRIPTOR_KEYS.size ||
      [...REQUIRED_MEASUREMENT_DESCRIPTOR_KEYS].some(
        (descriptor) => !actualDescriptors.has(descriptor),
      )
    ) {
      fail('completed run reports must contain the exact fixed-plan measurement descriptor set')
    }
  }
  if (!Array.isArray(value.rawFiles)) {
    fail('rawFiles must be an array')
  }
  const rawPaths = new Set()
  for (const rawFile of value.rawFiles) {
    assertRawFile(rawFile)
    if (rawPaths.has(rawFile.path)) {
      fail('rawFiles must not contain duplicate paths')
    }
    rawPaths.add(rawFile.path)
  }
  return value
}

function assertMeasurementDescriptor(value, label) {
  assertExactKeys(value, ['role', 'metric', 'unit'], label)
  assertRoleMetricUnit(value, label)
}

function descriptorKey(value) {
  return `${value.role}\u0000${value.metric}\u0000${value.unit}`
}

function assertSummaryCohort(value) {
  assertExactKeys(
    value,
    [
      'scenario',
      'scenarioClass',
      'controlsSha256',
      'fixtureLockSha256',
      'appExecutableSha256',
      'gitCommit',
      'measurementSet',
      'sourceStatistic',
      'requiredRuns',
      'actualRuns',
    ],
    'summary cohort',
  )
  assertIdentifier(value.scenario, 'summary cohort scenario')
  if (!['runtime', 'startup'].includes(value.scenarioClass)) {
    fail('summary cohort scenarioClass is invalid')
  }
  assertHash(value.controlsSha256, 'summary cohort controlsSha256')
  assertHash(value.fixtureLockSha256, 'summary cohort fixtureLockSha256')
  assertHash(value.appExecutableSha256, 'summary cohort appExecutableSha256')
  if (typeof value.gitCommit !== 'string' || !COMMIT_PATTERN.test(value.gitCommit)) {
    fail('summary cohort gitCommit must be a full lowercase commit SHA')
  }
  if (!Array.isArray(value.measurementSet) || value.measurementSet.length === 0) {
    fail('summary cohort measurementSet must be non-empty')
  }
  const seen = new Set()
  let previous = ''
  for (const descriptor of value.measurementSet) {
    assertMeasurementDescriptor(descriptor, 'summary cohort measurementSet entry')
    const key = descriptorKey(descriptor)
    if (seen.has(key)) {
      fail('summary cohort measurementSet has duplicate descriptors')
    }
    if (previous && key < previous) {
      fail('summary cohort measurementSet must be normalized and ordered')
    }
    seen.add(key)
    previous = key
  }
  if (value.sourceStatistic !== 'per-run-median') {
    fail('summary cohort sourceStatistic must be per-run-median')
  }
  const required = value.scenarioClass === 'runtime' ? 5 : 10
  if (value.requiredRuns !== required) {
    fail(`summary cohort requiredRuns must be ${required}`)
  }
  assertSafeInteger(value.actualRuns, 'summary cohort actualRuns', { minimum: 1 })
}

function assertSummaryRun(value, descriptors) {
  assertExactKeys(value, ['runId', 'runIndex', 'sourcePath', 'medians'], 'summary runs entry')
  assertIdentifier(value.runId, 'summary runs runId')
  assertSafeInteger(value.runIndex, 'summary runs runIndex', { minimum: 1 })
  assertSafeRelativeArtifactPath(value.sourcePath, 'summary runs sourcePath')
  if (!Array.isArray(value.medians) || value.medians.length !== descriptors.size) {
    fail('summary runs medians must match cohort measurementSet')
  }
  const seen = new Set()
  for (const median of value.medians) {
    assertExactKeys(median, ['role', 'metric', 'unit', 'value'], 'summary runs medians entry')
    assertRoleMetricUnit(median, 'summary runs medians entry')
    assertFiniteNumber(median.value, 'summary runs medians value', { minimum: 0 })
    const key = descriptorKey(median)
    if (!descriptors.has(key) || seen.has(key)) {
      fail('summary runs medians must be a unique cohort measurement set')
    }
    seen.add(key)
  }
}

function assertCompliance(value, cohort) {
  assertExactKeys(value, ['complete', 'requiredRuns', 'actualRuns', 'status'], 'summary compliance')
  if (typeof value.complete !== 'boolean') {
    fail('summary compliance.complete must be boolean')
  }
  if (value.requiredRuns !== cohort.requiredRuns || value.actualRuns !== cohort.actualRuns) {
    fail('summary compliance run counts must match cohort')
  }
  const expectedComplete = cohort.actualRuns >= cohort.requiredRuns
  if (value.complete !== expectedComplete) {
    fail('summary compliance.complete is inconsistent')
  }
  const expectedStatus = expectedComplete ? 'ok' : 'insufficient-n'
  if (value.status !== expectedStatus) {
    fail('summary compliance.status is inconsistent')
  }
}

function assertSummaryStatistic(value, descriptors, cohort) {
  assertExactKeys(
    value,
    [
      'role',
      'metric',
      'unit',
      'n',
      'median',
      'p95',
      'min',
      'max',
      'span',
      'mean',
      'sampleStandardDeviation',
      'coefficientOfVariationPercent',
      'cvStatus',
      'runtimeStatus',
    ],
    'summary statistics entry',
  )
  assertRoleMetricUnit(value, 'summary statistics entry')
  if (!descriptors.has(descriptorKey(value))) {
    fail('summary statistics entry is not in the cohort measurementSet')
  }
  assertSafeInteger(value.n, 'summary statistics n', { minimum: 1 })
  if (value.n !== cohort.actualRuns) {
    fail('summary statistics n must equal actualRuns')
  }
  for (const name of ['median', 'p95', 'min', 'max', 'span', 'mean']) {
    assertFiniteNumber(value[name], `summary statistics ${name}`, { minimum: 0 })
  }
  if (value.max < value.min || value.span !== value.max - value.min) {
    fail('summary statistics range is inconsistent')
  }
  if (value.n === 1) {
    if (value.sampleStandardDeviation !== null || value.coefficientOfVariationPercent !== null || value.cvStatus !== 'insufficient-n') {
      fail('summary singleton statistics must have unavailable SD and CV')
    }
  } else {
    assertFiniteNumber(value.sampleStandardDeviation, 'summary statistics sampleStandardDeviation', {
      minimum: 0,
    })
    if (value.cvStatus === 'ok') {
      assertFiniteNumber(value.coefficientOfVariationPercent, 'summary statistics coefficientOfVariationPercent', {
        minimum: 0,
      })
    } else if (value.cvStatus === 'zero-mean') {
      if (value.coefficientOfVariationPercent !== null) {
        fail('summary zero-mean CV must be null')
      }
    } else {
      fail('summary statistics cvStatus is invalid')
    }
  }
  const required = cohort.scenarioClass === 'runtime' ? 5 : 10
  const expectedRuntimeStatus = value.n >= required ? 'ok' : 'insufficient-n'
  if (value.runtimeStatus !== expectedRuntimeStatus) {
    fail('summary statistics runtimeStatus is inconsistent')
  }
}

export function validateSummaryReport(value) {
  assertExactKeys(value, SUMMARY_TOP_LEVEL_KEYS, 'summary report')
  if (value.$schema !== SUMMARY_SCHEMA || value.schemaVersion !== SCHEMA_VERSION) {
    fail('summary report has an unsupported $schema or schemaVersion')
  }
  assertProducer(value.producer)
  assertSummaryCohort(value.cohort)
  if (!Array.isArray(value.runs) || value.runs.length !== value.cohort.actualRuns) {
    fail('summary runs must exactly match cohort actualRuns')
  }
  const descriptors = new Set(value.cohort.measurementSet.map(descriptorKey))
  const runIds = new Set()
  const runIndexes = new Set()
  let priorIndex = 0
  for (const run of value.runs) {
    assertSummaryRun(run, descriptors)
    if (runIds.has(run.runId) || runIndexes.has(run.runIndex)) {
      fail('summary runs contain duplicate run IDs or indexes')
    }
    if (run.runIndex <= priorIndex) {
      fail('summary runs must be ordered by runIndex')
    }
    runIds.add(run.runId)
    runIndexes.add(run.runIndex)
    priorIndex = run.runIndex
  }
  assertCompliance(value.compliance, value.cohort)
  if (!Array.isArray(value.statistics) || value.statistics.length !== descriptors.size) {
    fail('summary statistics must exactly match cohort measurementSet')
  }
  const seen = new Set()
  for (const statistic of value.statistics) {
    assertSummaryStatistic(statistic, descriptors, value.cohort)
    const key = descriptorKey(statistic)
    if (seen.has(key)) {
      fail('summary statistics contain duplicate descriptors')
    }
    seen.add(key)
  }
  return value
}

function canonicalize(value, label = 'value') {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(`${label} must contain only finite numbers`)
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    assertString(value, label)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => canonicalize(entry, `${label}[${index}]`)).join(',')}]`
  }
  assertPlainObject(value, label)
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], `${label}.${key}`)}`).join(',')}}`
}

export function canonicalJson(value) {
  return canonicalize(value)
}

export function canonicalSha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function isMeasurementDescriptor(value) {
  try {
    assertMeasurementDescriptor(value, 'measurement descriptor')
    return true
  } catch {
    return false
  }
}
