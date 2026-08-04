import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeStatistics,
  formatStatistic,
  medianByRun,
  summarizeCohortMeasurements,
} from './statistics.mjs'

test('computes exact unrounded statistics with nearest-rank p95', () => {
  const statistics = computeStatistics([1, 2, 3, 4, 5], { scenarioClass: 'runtime' })
  assert.equal(statistics.n, 5)
  assert.equal(statistics.median, 3)
  assert.equal(statistics.p95, 5)
  assert.equal(statistics.mean, 3)
  assert.equal(statistics.sampleStandardDeviation, Math.sqrt(2.5))
  assert.equal(statistics.coefficientOfVariationPercent, 52.70462766947299)
  assert.equal(statistics.min, 1)
  assert.equal(statistics.max, 5)
  assert.equal(statistics.span, 4)
  assert.equal(statistics.runtimeStatus, 'ok')
  assert.equal(statistics.cvStatus, 'ok')
})

test('marks cohorts below the runtime repeat count insufficient without changing statistics', () => {
  const statistics = computeStatistics([1, 2, 3, 4], { scenarioClass: 'runtime' })
  assert.equal(statistics.median, 2.5)
  assert.equal(statistics.p95, 4)
  assert.equal(statistics.runtimeStatus, 'insufficient-n')
  assert.equal(statistics.sampleStandardDeviation, Math.sqrt(5 / 3))

  const startup = computeStatistics([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], {
    scenarioClass: 'startup',
  })
  assert.equal(startup.runtimeStatus, 'ok')
})

test('uses nearest rank and handles singleton, zeros, zero mean, and invalid samples', () => {
  assert.equal(computeStatistics(Array.from({ length: 20 }, (_, index) => index + 1)).p95, 19)

  const singleton = computeStatistics([7], { scenarioClass: 'runtime' })
  assert.deepEqual(
    {
      median: singleton.median,
      p95: singleton.p95,
      mean: singleton.mean,
      min: singleton.min,
      max: singleton.max,
      span: singleton.span,
      sampleStandardDeviation: singleton.sampleStandardDeviation,
      coefficientOfVariationPercent: singleton.coefficientOfVariationPercent,
      cvStatus: singleton.cvStatus,
    },
    {
      median: 7,
      p95: 7,
      mean: 7,
      min: 7,
      max: 7,
      span: 0,
      sampleStandardDeviation: null,
      coefficientOfVariationPercent: null,
      cvStatus: 'insufficient-n',
    },
  )
  assert.equal(computeStatistics([0, 0], { scenarioClass: 'runtime' }).coefficientOfVariationPercent, 0)
  const zeroMean = computeStatistics([-1, 1], { scenarioClass: 'runtime' })
  assert.equal(zeroMean.coefficientOfVariationPercent, null)
  assert.equal(zeroMean.cvStatus, 'zero-mean')
  assert.throws(() => computeStatistics([], { scenarioClass: 'runtime' }), /at least one/i)
  assert.throws(() => computeStatistics([1, Number.NaN]), /finite/i)
})

test('calculates each run median before cohort statistics and never pools periodic samples', () => {
  const byRun = medianByRun([
    { runId: 'r01', runIndex: 1, value: 1 },
    { runId: 'r01', runIndex: 1, value: 100 },
    { runId: 'r01', runIndex: 1, value: 100 },
    { runId: 'r02', runIndex: 2, value: 2 },
    { runId: 'r02', runIndex: 2, value: 2 },
  ])
  assert.deepEqual(byRun, [
    { runId: 'r01', runIndex: 1, value: 100 },
    { runId: 'r02', runIndex: 2, value: 2 },
  ])

  const cohort = summarizeCohortMeasurements(
    [
      { runId: 'r01', runIndex: 1, role: 'main', metric: 'cpu.percent', unit: 'percent', value: 1 },
      { runId: 'r01', runIndex: 1, role: 'main', metric: 'cpu.percent', unit: 'percent', value: 100 },
      { runId: 'r01', runIndex: 1, role: 'main', metric: 'cpu.percent', unit: 'percent', value: 100 },
      { runId: 'r02', runIndex: 2, role: 'main', metric: 'cpu.percent', unit: 'percent', value: 2 },
      { runId: 'r02', runIndex: 2, role: 'main', metric: 'cpu.percent', unit: 'percent', value: 2 },
    ],
    { scenarioClass: 'runtime' },
  )
  assert.equal(cohort[0].median, 51)
  assert.equal(cohort[0].n, 2)
  assert.equal(cohort[0].sourceStatistic, 'per-run-median')
})

test('formats human statistics with no more than six significant digits and NA for unavailable', () => {
  assert.equal(formatStatistic(null), 'NA')
  assert.equal(formatStatistic(52.70462766947299), '52.7046')
  assert.equal(formatStatistic(1000000), '1.00000e+6')
})
