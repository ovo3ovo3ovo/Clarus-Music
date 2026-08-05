import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SCENARIO_IDS,
  SCENARIO_MANIFEST,
  getScenario,
  validateScenarioManifest,
} from './scenario-manifest.mjs'

function cloneManifest() {
  return JSON.parse(JSON.stringify(SCENARIO_MANIFEST))
}

test('the scenario manifest covers every required release scenario', () => {
  assert.deepEqual(
    SCENARIO_MANIFEST.scenarios.map((scenario) => scenario.id),
    SCENARIO_IDS,
  )
  assert.equal(getScenario('startup').requiredRuns, 10)
  assert.equal(getScenario('idle').automation, 'external-sampler')
  assert.equal(getScenario('combined').fixtureRoles.includes('word-timed-yrc'), true)
  assert.equal(getScenario('long-soak').durationSeconds, 3600)
  assert.equal(getScenario('lifecycle-cycle').durationSeconds, 600)
})

test('scenario validation rejects duplicate, unknown, or misclassified entries', () => {
  const duplicateRole = cloneManifest()
  duplicateRole.fixtureRoles.push('tone-short-mp3')
  assert.throws(() => validateScenarioManifest(duplicateRole), /fixtureRoles.*canonical/i)

  const unknownRole = cloneManifest()
  unknownRole.scenarios[2].fixtureRoles = ['not-a-fixture']
  assert.throws(() => validateScenarioManifest(unknownRole), /unknown role/i)

  const wrongStartupCount = cloneManifest()
  wrongStartupCount.scenarios[0].requiredRuns = 5
  assert.throws(() => validateScenarioManifest(wrongStartupCount), /startup.*ten/i)

  const wrongAutomation = cloneManifest()
  wrongAutomation.scenarios[1].automation = 'unsupported-mode'
  assert.throws(() => validateScenarioManifest(wrongAutomation), /automation.*unsupported/i)
})
