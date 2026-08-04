function fail(message) {
  throw new Error(message)
}

function assertScenarioClass(scenarioClass) {
  if (scenarioClass !== 'runtime' && scenarioClass !== 'startup') {
    fail('scenarioClass must be runtime or startup')
  }
}

function assertValues(values) {
  if (!Array.isArray(values) || values.length === 0) {
    fail('statistics require at least one value')
  }
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    fail('statistics values must be finite numbers')
  }
}

export function median(values) {
  assertValues(values)
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export function computeStatistics(values, { scenarioClass = 'runtime' } = {}) {
  assertValues(values)
  assertScenarioClass(scenarioClass)
  const sorted = [...values].sort((left, right) => left - right)
  const n = sorted.length
  const min = sorted[0]
  const max = sorted[n - 1]
  const mean = sorted.reduce((total, value) => total + value, 0) / n
  const medianValue = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)]
  const p95 = sorted[Math.ceil(0.95 * n) - 1]
  const requiredRuns = scenarioClass === 'runtime' ? 5 : 10
  let sampleStandardDeviation = null
  let coefficientOfVariationPercent = null
  let cvStatus = 'insufficient-n'
  if (n >= 2) {
    sampleStandardDeviation = Math.sqrt(
      sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1),
    )
    if (sampleStandardDeviation === 0) {
      coefficientOfVariationPercent = 0
      cvStatus = 'ok'
    } else if (mean === 0) {
      cvStatus = 'zero-mean'
    } else {
      coefficientOfVariationPercent = (sampleStandardDeviation / Math.abs(mean)) * 100
      cvStatus = 'ok'
    }
  }
  return {
    n,
    median: medianValue,
    p95,
    min,
    max,
    span: max - min,
    mean,
    sampleStandardDeviation,
    coefficientOfVariationPercent,
    cvStatus,
    runtimeStatus: n >= requiredRuns ? 'ok' : 'insufficient-n',
  }
}

function descriptorKey(value) {
  return `${value.role}\u0000${value.metric}\u0000${value.unit}`
}

function assertMeasurementEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('cohort measurement must be an object')
  }
  for (const key of ['runId', 'runIndex', 'role', 'metric', 'unit', 'value']) {
    if (!(key in value)) {
      fail(`cohort measurement is missing ${key}`)
    }
  }
  if (typeof value.runId !== 'string' || !Number.isSafeInteger(value.runIndex) || value.runIndex < 1) {
    fail('cohort measurement run identity is invalid')
  }
  if (typeof value.role !== 'string' || typeof value.metric !== 'string' || typeof value.unit !== 'string') {
    fail('cohort measurement descriptor is invalid')
  }
  if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
    fail('cohort measurement value must be finite')
  }
}

export function medianByRun(entries) {
  if (!Array.isArray(entries)) {
    fail('entries must be an array')
  }
  const grouped = new Map()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('entry must be an object')
    }
    if (typeof entry.runId !== 'string' || !Number.isSafeInteger(entry.runIndex) || entry.runIndex < 1) {
      fail('entry run identity is invalid')
    }
    if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) {
      fail('entry value must be finite')
    }
    const key = `${entry.runIndex}\u0000${entry.runId}`
    const existing = grouped.get(key)
    if (existing) {
      existing.values.push(entry.value)
    } else {
      grouped.set(key, { runId: entry.runId, runIndex: entry.runIndex, values: [entry.value] })
    }
  }
  return [...grouped.values()]
    .sort((left, right) => left.runIndex - right.runIndex || left.runId.localeCompare(right.runId))
    .map(({ runId, runIndex, values }) => ({ runId, runIndex, value: median(values) }))
}

export function summarizeCohortMeasurements(entries, { scenarioClass = 'runtime' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('cohort measurements require at least one entry')
  }
  assertScenarioClass(scenarioClass)
  const grouped = new Map()
  for (const entry of entries) {
    assertMeasurementEntry(entry)
    const key = descriptorKey(entry)
    const group = grouped.get(key) ?? {
      role: entry.role,
      metric: entry.metric,
      unit: entry.unit,
      entries: [],
    }
    group.entries.push(entry)
    grouped.set(key, group)
  }
  return [...grouped.values()]
    .sort((left, right) => descriptorKey(left).localeCompare(descriptorKey(right)))
    .map((group) => ({
      role: group.role,
      metric: group.metric,
      unit: group.unit,
      sourceStatistic: 'per-run-median',
      ...computeStatistics(
        medianByRun(group.entries).map((entry) => entry.value),
        { scenarioClass },
      ),
    }))
}

export function formatStatistic(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'NA'
  }
  return Number(value).toPrecision(6)
}
