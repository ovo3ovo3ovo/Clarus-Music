import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import { FIXTURE_ROLES } from '../fixtures/fixture-spec.mjs'

export const SCENARIO_MANIFEST_PATH = fileURLToPath(
  new URL('./scenario-manifest.json', import.meta.url),
)
export const SCENARIO_MANIFEST = Object.freeze(
  JSON.parse(readFileSync(SCENARIO_MANIFEST_PATH, 'utf8')),
)

export const SCENARIO_IDS = Object.freeze([
  'startup',
  'idle',
  'interaction',
  'animation',
  'audio',
  'combined',
  'long-soak',
  'lifecycle-cycle',
])
const SCENARIO_CLASSES = new Set(['runtime', 'startup'])
const AUTOMATION_MODES = new Set(['external-sampler', 'native-manual-required'])
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label)
  const allowed = new Set(expected)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  const missing = expected.filter((key) => !(key in value))
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(', ')}`)
  if (missing.length > 0) throw new Error(`${label} is missing keys: ${missing.join(', ')}`)
}

function assertUniqueIdentifiers(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`)
  }
  const seen = new Set()
  for (const value of values) {
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
      throw new Error(`${label} contains an invalid identifier`)
    }
    if (seen.has(value)) throw new Error(`${label} contains duplicate ${value}`)
    seen.add(value)
  }
}

function assertFixtureRoles(values, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new Error(`${label} must be an array of fixture roles`)
  }
  const seen = new Set()
  for (const role of values) {
    if (!FIXTURE_ROLES.includes(role)) throw new Error(`${label} contains unknown role ${role}`)
    if (seen.has(role)) throw new Error(`${label} contains duplicate role ${role}`)
    seen.add(role)
  }
}

export function validateScenarioManifest(value) {
  assertExactKeys(value, ['$schema', 'schemaVersion', 'fixtureRoles', 'requiredMetrics', 'scenarios'], 'manifest')
  if (value.$schema !== 'clarus.perf.scenarios' || value.schemaVersion !== 1) {
    throw new Error('manifest schema identity is unsupported')
  }
  if (JSON.stringify(value.fixtureRoles) !== JSON.stringify(FIXTURE_ROLES)) {
    throw new Error('manifest fixtureRoles must match the canonical fixture role order')
  }
  assertUniqueIdentifiers(value.requiredMetrics, 'manifest.requiredMetrics')
  if (!Array.isArray(value.scenarios) || value.scenarios.length !== SCENARIO_IDS.length) {
    throw new Error(`manifest.scenarios must contain exactly ${SCENARIO_IDS.length} entries`)
  }
  const ids = value.scenarios.map((scenario) => scenario?.id)
  if (JSON.stringify(ids) !== JSON.stringify(SCENARIO_IDS)) {
    throw new Error('manifest.scenarios must use the canonical ordered scenario IDs')
  }
  value.scenarios.forEach((scenario, index) => {
    const label = `manifest.scenarios[${index}]`
    assertExactKeys(
      scenario,
      ['id', 'scenarioClass', 'automation', 'requiredRuns', 'durationSeconds', 'fixtureRoles', 'steps'],
      label,
    )
    if (scenario.id !== SCENARIO_IDS[index] || !SCENARIO_CLASSES.has(scenario.scenarioClass)) {
      throw new Error(`${label} has an invalid scenario identity`)
    }
    if (!AUTOMATION_MODES.has(scenario.automation)) {
      throw new Error(`${label}.automation is unsupported`)
    }
    if (!Number.isSafeInteger(scenario.requiredRuns) || scenario.requiredRuns < 1) {
      throw new Error(`${label}.requiredRuns must be a positive integer`)
    }
    if (!Number.isSafeInteger(scenario.durationSeconds) || scenario.durationSeconds < 1) {
      throw new Error(`${label}.durationSeconds must be a positive integer`)
    }
    assertFixtureRoles(scenario.fixtureRoles, `${label}.fixtureRoles`, { allowEmpty: true })
    if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
      throw new Error(`${label}.steps must be non-empty`)
    }
    if (scenario.steps.some((step) => typeof step !== 'string' || step.length === 0)) {
      throw new Error(`${label}.steps must contain non-empty strings`)
    }
    if (scenario.scenarioClass === 'startup' && scenario.requiredRuns !== 10) {
      throw new Error('startup requires exactly ten cold-start runs')
    }
    if (scenario.scenarioClass === 'runtime' && scenario.id !== 'long-soak' && scenario.id !== 'lifecycle-cycle' && scenario.requiredRuns !== 5) {
      throw new Error(`${label} requires exactly five runtime runs`)
    }
    if (scenario.automation === 'external-sampler' && scenario.id !== 'idle') {
      throw new Error('only idle is currently executable by the external sampler')
    }
  })
  return value
}

validateScenarioManifest(SCENARIO_MANIFEST)

export function getScenario(id) {
  return SCENARIO_MANIFEST.scenarios.find((scenario) => scenario.id === id) ?? null
}
