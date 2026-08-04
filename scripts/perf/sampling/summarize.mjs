import { lstat, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

import {
  PerfInputError,
  REPOSITORY_ROOT,
  SUMMARIES_ROOT,
  createNewStrictOutputDirectory,
  readJsonNoFollow,
  writeNewFile,
} from './cli-support.mjs'
import {
  PRODUCER,
  REQUIRED_MEASUREMENT_DESCRIPTORS,
  SCHEMA_VERSION,
  SUMMARY_SCHEMA,
  validateRunReport,
  validateSummaryReport,
} from './report-schema.mjs'
import { formatStatistic, median, summarizeCohortMeasurements } from './statistics.mjs'

const INPUT_MAX_BYTES = 64 * 1024 * 1024

function refusal(message) {
  throw new PerfInputError(message)
}

function isStrictChild(root, candidate) {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot.length > 0 &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot) &&
    !win32.isAbsolute(fromRoot)
  )
}

function isContainedPath(root, candidate) {
  return candidate === root || isStrictChild(root, candidate)
}

function assertSafeSummarizerInputPath(pathname) {
  if (
    typeof pathname !== 'string' ||
    pathname.length === 0 ||
    pathname.includes('\0') ||
    pathname.includes('\\') ||
    pathname.split('/').some((component) => component === '..')
  ) {
    refusal('Summarizer input paths must be unambiguous paths without parent traversal')
  }
}

async function assertNoRepositorySymlinkComponents(pathname, physicalRepositoryRoot) {
  const components = resolve(pathname).split(sep).filter(Boolean)
  let current = sep
  for (const component of components) {
    const parent = current
    current = join(current, component)
    let details
    let physicalParent
    try {
      details = await lstat(current)
      physicalParent = await realpath(parent)
    } catch (error) {
      refusal(`Unable to inspect summarizer input path ${pathname}: ${error.message}`)
    }
    if (isContainedPath(physicalRepositoryRoot, physicalParent) && details.isSymbolicLink()) {
      refusal(
        `Summarizer input ${pathname} must not traverse symbolic link components within the repository`,
      )
    }
  }
}

async function resolveCanonicalRunInputPath(pathname, repositoryRoot) {
  assertSafeSummarizerInputPath(pathname)
  const candidate = resolve(repositoryRoot, pathname)
  if (basename(candidate) !== 'run.json') {
    refusal('Summarizer input paths must name run.json files')
  }
  const canonicalRunsRoot = resolve(repositoryRoot, 'artifacts', 'perf', 'runs')
  let physicalRepositoryRoot
  let physicalRunsRoot
  let physicalInput
  try {
    physicalRepositoryRoot = await realpath(repositoryRoot)
    physicalRunsRoot = await realpath(canonicalRunsRoot)
    await assertNoRepositorySymlinkComponents(candidate, physicalRepositoryRoot)
    physicalInput = await realpath(candidate)
  } catch (error) {
    if (error instanceof PerfInputError) {
      throw error
    }
    refusal(`Unable to resolve summarizer input ${pathname}: ${error.message}`)
  }
  if (!isStrictChild(physicalRunsRoot, physicalInput)) {
    refusal(
      `Summarizer input ${pathname} must be a strict realpath-contained child of artifacts/perf/runs`,
    )
  }
  return physicalInput
}

function descriptorKey(value) {
  return `${value.role}\u0000${value.metric}\u0000${value.unit}`
}

function compareDescriptor(left, right) {
  return descriptorKey(left).localeCompare(descriptorKey(right))
}

function descriptorFromMeasurement(measurement) {
  return { role: measurement.role, metric: measurement.metric, unit: measurement.unit }
}

function exactSet(values) {
  return [...values].sort(compareDescriptor)
}

function equalDescriptorSets(left, right) {
  return (
    left.length === right.length &&
    left.every((entry, index) => descriptorKey(entry) === descriptorKey(right[index]))
  )
}

const REQUIRED_DESCRIPTOR_SET = exactSet(REQUIRED_MEASUREMENT_DESCRIPTORS)

function assertRequiredDescriptors(descriptors, pathname) {
  if (equalDescriptorSets(descriptors, REQUIRED_DESCRIPTOR_SET)) {
    return
  }
  const actual = new Set(descriptors.map(descriptorKey))
  const missing = REQUIRED_DESCRIPTOR_SET.filter(
    (descriptor) => !actual.has(descriptorKey(descriptor)),
  )
  const unexpected = descriptors.filter(
    (descriptor) =>
      !REQUIRED_DESCRIPTOR_SET.some(
        (required) => descriptorKey(required) === descriptorKey(descriptor),
      ),
  )
  const missingText = missing.map(descriptorKey).join(', ') || 'none'
  const unexpectedText = unexpected.map(descriptorKey).join(', ') || 'none'
  refusal(
    `Input ${pathname} is missing required normalized measurement descriptors (missing: ${missingText}; unexpected: ${unexpectedText})`,
  )
}

function sourcePathFor(pathname, repositoryRoot, run) {
  const pathFromRoot = relative(repositoryRoot, resolve(pathname))
  if (
    pathFromRoot.length > 0 &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !pathFromRoot.startsWith('/') &&
    !pathFromRoot.includes('\\')
  ) {
    return pathFromRoot.split(sep).join('/')
  }
  return `inputs/${run.runId}/run.json`
}

function assertUsableCompletedRun(report, pathname) {
  try {
    validateRunReport(report)
  } catch (error) {
    refusal(`Input ${pathname} is not a usable supported v1 run.json: ${error.message}`)
  }
  if (
    report.schemaVersion !== 1 ||
    report.status !== 'completed' ||
    report.usable !== true ||
    report.failure !== null
  ) {
    refusal(`Input ${pathname} is not a usable completed v1 run.json`)
  }
  if (!Array.isArray(report.measurements) || report.measurements.length === 0) {
    refusal(`Input ${pathname} is missing normalized measurements`)
  }
}

function runDescriptors(report, pathname) {
  const descriptors = new Map()
  for (const measurement of report.measurements) {
    const descriptor = descriptorFromMeasurement(measurement)
    const key = descriptorKey(descriptor)
    descriptors.set(key, descriptor)
  }
  if (descriptors.size === 0) {
    refusal(`Input ${pathname} is missing normalized role/metric/unit measurements`)
  }
  return exactSet(descriptors.values())
}

function cohortIdentity(report, descriptors) {
  return {
    scenario: report.run.scenario,
    scenarioClass: report.run.scenarioClass,
    controlsSha256: report.controls.sha256,
    fixtureLockSha256: report.fixture.lockSha256,
    appExecutableSha256: report.source.executableSha256,
    gitCommit: report.source.gitCommit,
    measurementSet: descriptors,
  }
}

function sameIdentity(left, right) {
  return (
    left.scenario === right.scenario &&
    left.scenarioClass === right.scenarioClass &&
    left.controlsSha256 === right.controlsSha256 &&
    left.fixtureLockSha256 === right.fixtureLockSha256 &&
    left.appExecutableSha256 === right.appExecutableSha256 &&
    left.gitCommit === right.gitCommit &&
    equalDescriptorSets(left.measurementSet, right.measurementSet)
  )
}

function runMedians(report, descriptors) {
  const byDescriptor = new Map()
  for (const measurement of report.measurements) {
    const key = descriptorKey(measurement)
    const values = byDescriptor.get(key) ?? []
    values.push(measurement.value)
    byDescriptor.set(key, values)
  }
  return descriptors.map((descriptor) => {
    const values = byDescriptor.get(descriptorKey(descriptor))
    if (!values || values.length === 0) {
      refusal(`Run ${report.run.runId} is missing metric ${descriptorKey(descriptor)}`)
    }
    return { ...descriptor, value: median(values) }
  })
}

function validateInputs(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 1000) {
    refusal('Summarization requires from one to 1000 run inputs')
  }
  const runIds = new Set()
  const runIndexes = new Set()
  let identity
  const normalized = []
  for (const entry of entries) {
    if (!entry || typeof entry.pathname !== 'string') {
      refusal('Summarization input entries must include a pathname')
    }
    const report = entry.value
    assertUsableCompletedRun(report, entry.pathname)
    if (runIds.has(report.run.runId) || runIndexes.has(report.run.runIndex)) {
      refusal('Summarization rejects duplicate run IDs or run indexes')
    }
    runIds.add(report.run.runId)
    runIndexes.add(report.run.runIndex)
    const descriptors = runDescriptors(report, entry.pathname)
    assertRequiredDescriptors(descriptors, entry.pathname)
    const candidateIdentity = cohortIdentity(report, descriptors)
    if (!identity) {
      identity = candidateIdentity
    } else if (!sameIdentity(identity, candidateIdentity)) {
      refusal('Summarization rejects mixed cohort identity or normalized measurement sets')
    }
    normalized.push({
      value: report,
      pathname: entry.pathname,
      descriptors,
      medians: runMedians(report, descriptors),
    })
  }
  return { identity, normalized }
}

export function buildCohortSummary(entries, { repositoryRoot = REPOSITORY_ROOT } = {}) {
  const { identity, normalized } = validateInputs(entries)
  const ordered = [...normalized].sort(
    (left, right) =>
      left.value.run.runIndex - right.value.run.runIndex ||
      left.value.run.runId.localeCompare(right.value.run.runId),
  )
  const flattened = []
  for (const entry of ordered) {
    for (const measurement of entry.value.measurements) {
      flattened.push({
        runId: entry.value.run.runId,
        runIndex: entry.value.run.runIndex,
        role: measurement.role,
        metric: measurement.metric,
        unit: measurement.unit,
        value: measurement.value,
      })
    }
  }
  const computed = summarizeCohortMeasurements(flattened, {
    scenarioClass: identity.scenarioClass,
  })
  const requiredRuns = identity.scenarioClass === 'runtime' ? 5 : 10
  const actualRuns = ordered.length
  const complete = actualRuns >= requiredRuns
  const statistics = computed.map((computedStatistic) => {
    const statistic = { ...computedStatistic }
    delete statistic.sourceStatistic
    return statistic
  })
  const report = {
    $schema: SUMMARY_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    producer: { ...PRODUCER },
    cohort: {
      ...identity,
      sourceStatistic: 'per-run-median',
      requiredRuns,
      actualRuns,
    },
    runs: ordered.map((entry) => ({
      runId: entry.value.run.runId,
      runIndex: entry.value.run.runIndex,
      sourcePath: sourcePathFor(entry.pathname, repositoryRoot, entry.value.run),
      medians: entry.medians,
    })),
    compliance: {
      complete,
      requiredRuns,
      actualRuns,
      status: complete ? 'ok' : 'insufficient-n',
    },
    statistics,
  }
  try {
    validateSummaryReport(report)
  } catch (error) {
    refusal(`Cohort summary failed schema validation: ${error.message}`)
  }
  return report
}

function csvCell(value) {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function renderCohortCsv(report) {
  const header = [
    'schema_version',
    'scenario',
    'scenario_class',
    'source_statistic',
    'required_runs',
    'actual_runs',
    'compliance_status',
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
    'sample_standard_deviation',
    'coefficient_of_variation_percent',
    'cv_status',
    'runtime_status',
  ]
  const rows = report.statistics.map((statistic) =>
    [
      report.schemaVersion,
      report.cohort.scenario,
      report.cohort.scenarioClass,
      report.cohort.sourceStatistic,
      report.cohort.requiredRuns,
      report.cohort.actualRuns,
      report.compliance.status,
      statistic.role,
      statistic.metric,
      statistic.unit,
      statistic.n,
      statistic.median,
      statistic.p95,
      statistic.min,
      statistic.max,
      statistic.span,
      statistic.mean,
      statistic.sampleStandardDeviation ?? 'NA',
      statistic.coefficientOfVariationPercent ?? 'NA',
      statistic.cvStatus,
      statistic.runtimeStatus,
    ]
      .map(csvCell)
      .join(','),
  )
  return `${header.join(',')}\r\n${rows.join('\r\n')}\r\n`
}

export function renderCohortText(report) {
  const lines = ['MEASUREMENT INFRASTRUCTURE OUTPUT — NOT EVIDENCE OF PRODUCT IMPROVEMENT.']
  lines.push(`scenario: ${report.cohort.scenario}`)
  lines.push(`scenario_class: ${report.cohort.scenarioClass}`)
  lines.push(`source_statistic: ${report.cohort.sourceStatistic}`)
  lines.push(
    `runs: ${report.cohort.actualRuns}/${report.cohort.requiredRuns} (${report.compliance.status})`,
  )
  for (const statistic of report.statistics) {
    lines.push(
      `${statistic.role} ${statistic.metric} (${statistic.unit}): n=${statistic.n} median=${formatStatistic(statistic.median)} p95=${formatStatistic(statistic.p95)} min=${formatStatistic(statistic.min)} max=${formatStatistic(statistic.max)} span=${formatStatistic(statistic.span)} mean=${formatStatistic(statistic.mean)} sd=${formatStatistic(statistic.sampleStandardDeviation)} cv=${formatStatistic(statistic.coefficientOfVariationPercent)} (${statistic.cvStatus}; ${statistic.runtimeStatus})`,
    )
  }
  return `${lines.join('\n')}\n`
}

export async function runSummarizer(options, dependencies = {}) {
  const repositoryRoot = resolve(dependencies.repositoryRoot ?? REPOSITORY_ROOT)
  const summariesRoot = dependencies.roots?.summariesRoot ?? SUMMARIES_ROOT
  try {
    if (!options || !Array.isArray(options.inputs) || typeof options.output !== 'string') {
      refusal('Summarizer options require input paths and an output path')
    }
    if (options.inputs.length < 1 || options.inputs.length > 1000) {
      refusal('Summarizer accepts from one to 1000 inputs')
    }
    const uniquePaths = new Set()
    const entries = []
    for (const pathname of options.inputs) {
      const resolvedPath = await resolveCanonicalRunInputPath(pathname, repositoryRoot)
      if (uniquePaths.has(resolvedPath)) {
        refusal('Summarizer input paths must be non-empty and distinct')
      }
      uniquePaths.add(resolvedPath)
      const input = await readJsonNoFollow(resolvedPath, {
        label: `run input ${resolvedPath}`,
        maxBytes: INPUT_MAX_BYTES,
      })
      entries.push({ pathname: resolvedPath, value: input.value })
    }
    const report = buildCohortSummary(entries, { repositoryRoot })
    const outputPath = await createNewStrictOutputDirectory(options.output, {
      root: summariesRoot,
      repositoryRoot,
    })
    await writeNewFile(join(outputPath, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    await writeNewFile(join(outputPath, 'summary.csv'), renderCohortCsv(report))
    await writeNewFile(join(outputPath, 'summary.txt'), renderCohortText(report))
    return { exitCode: 0, outputPath, report }
  } catch (error) {
    return { exitCode: 2, error }
  }
}

export async function main(argumentsList = process.argv.slice(2)) {
  const { parseSummarizeArguments } = await import('./cli-support.mjs')
  const result = await runSummarizer(parseSummarizeArguments(argumentsList))
  if (result.exitCode !== 0) {
    throw result.error ?? new PerfInputError('Summarization refused')
  }
  process.stdout.write(`Wrote summary cohort to ${result.outputPath}\n`)
  return result
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(new URL(process.argv[1], `file://${process.cwd()}/`))
) {
  main().catch((error) => {
    process.stderr.write(`Performance summarization refused: ${error.message}\n`)
    process.exitCode = 2
  })
}
