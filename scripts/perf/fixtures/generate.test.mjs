import assert from 'node:assert/strict'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { URL } from 'node:url'

import {
  CANONICAL_FIXTURE_ROOT,
  DEFAULT_OUTPUT_DIRECTORY,
  FIXTURE_ROLES,
  LOCK_FILENAME,
  buildDeterministicYrc,
  buildPcmWav,
  resolveFixtureDirectory,
  validateRecipeManifest,
} from './fixture-spec.mjs'
import {
  fixtureTransactionPaths,
  generateFixtures,
  getAfconvertVersion,
  getLameVersion,
  publishFixtureDirectory,
  recoverFixtureTransaction,
} from './fixture-generator.mjs'
import { verifyFixtureSet } from './fixture-verifier.mjs'
import {
  parseGenerateArguments,
  parseServeArguments,
  parseVerifyArguments,
} from './cli-support.mjs'

const temporaryDirectories = []

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function makeFixtureScope(label) {
  await mkdir(CANONICAL_FIXTURE_ROOT, { recursive: true })
  const directory = await mkdtemp(join(CANONICAL_FIXTURE_ROOT, `.r3-generate-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

async function readCompleteSet(directory) {
  const lock = JSON.parse(await readFile(join(directory, LOCK_FILENAME), 'utf8'))
  const entries = [LOCK_FILENAME, ...lock.files.map((file) => file.filename)]
  const contents = new Map()
  for (const entry of entries) {
    contents.set(entry, await readFile(join(directory, entry)))
  }
  return contents
}

function assertCompleteSetEqual(expected, actual) {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort())
  for (const [name, contents] of expected) {
    assert.deepEqual(actual.get(name), contents, `${name} changed`)
  }
}

async function copyCompleteSet(sourceDirectory, targetDirectory) {
  const lock = JSON.parse(await readFile(join(sourceDirectory, LOCK_FILENAME), 'utf8'))
  await mkdir(targetDirectory)
  for (const entry of [LOCK_FILENAME, ...lock.files.map((file) => file.filename)]) {
    await copyFile(join(sourceDirectory, entry), join(targetDirectory, entry))
  }
}

async function assertNoTransactionResidue(targetDirectory) {
  const { backupDirectory, stagingDirectory } = fixtureTransactionPaths(targetDirectory)
  for (const pathname of [backupDirectory, stagingDirectory]) {
    await assert.rejects(
      () => lstat(pathname),
      (error) => error?.code === 'ENOENT',
      `unexpected transaction residue: ${pathname}`,
    )
  }
}

test('CLI defaults and parsers use the canonical import-derived fixture directory', () => {
  assert.deepEqual(parseGenerateArguments([]), {
    force: false,
    outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
  })
  assert.deepEqual(parseVerifyArguments([]), { directory: DEFAULT_OUTPUT_DIRECTORY })
  assert.deepEqual(parseServeArguments([]), { directory: DEFAULT_OUTPUT_DIRECTORY, port: 0 })
  assert.throws(() => parseGenerateArguments(['--output']), /requires a value/i)
  assert.throws(() => parseVerifyArguments(['--directory', 'one', '--directory', 'two']), /once/i)
  assert.throws(() => parseServeArguments(['--port', '70000']), /0 to 65535/i)
})

test('fixture directories must be strict canonical children without traversal or symlink components', async () => {
  await assert.rejects(
    () => resolveFixtureDirectory(CANONICAL_FIXTURE_ROOT, { requireExists: false }),
    /strict child.*canonical fixture root/i,
  )
  await assert.rejects(
    () => resolveFixtureDirectory(tmpdir(), { requireExists: false }),
    /strict child.*canonical fixture root/i,
  )
  await assert.rejects(
    () =>
      generateFixtures({
        encoder: async () => {
          throw new Error('encoder must not run for an unsafe output directory')
        },
        outputDirectory: tmpdir(),
      }),
    /strict child.*canonical fixture root/i,
  )
  await assert.rejects(
    () =>
      resolveFixtureDirectory('artifacts/perf/fixtures/current/../escaped', {
        requireExists: false,
      }),
    /parent-directory traversal/i,
  )

  const scope = await makeFixtureScope('symlink')
  const linkedOutput = join(scope, 'linked-output')
  await symlink(tmpdir(), linkedOutput)
  await assert.rejects(
    () => resolveFixtureDirectory(join(linkedOutput, 'child'), { createParents: true }),
    /symbolic link/i,
  )
})

test('PCM/YRC builders and the canonical five-recipe manifest are deterministic', async () => {
  const pcmRecipe = {
    channels: 2,
    durationSeconds: 0.02,
    expectedSeekMarkersSeconds: [0.01],
    sampleRateHz: 8000,
  }
  const first = buildPcmWav(pcmRecipe)
  assert.deepEqual(first, buildPcmWav(pcmRecipe))
  assert.equal(first.toString('ascii', 0, 4), 'RIFF')
  assert.equal(first.readUInt32LE(24), 8000)
  assert.equal(buildDeterministicYrc(), buildDeterministicYrc())

  const manifest = JSON.parse(
    await readFile(new URL('./fixture-recipes.json', import.meta.url), 'utf8'),
  )
  const validated = validateRecipeManifest(manifest)
  assert.deepEqual(
    validated.recipes.map((recipe) => recipe.role),
    FIXTURE_ROLES,
  )
})

test('tool version preflight accepts afconvert help output but rejects non-4.0 LAME', async () => {
  const helpStatus = new Error('afconvert help exits with status 2')
  helpStatus.stderr = 'Audio File Convert\nVersion: 2.0\nUsage: afconvert [option...]'
  assert.equal(
    await getAfconvertVersion({
      run: async () => {
        throw helpStatus
      },
    }),
    '2.0',
  )
  await assert.rejects(
    () =>
      getLameVersion({
        run: async () => ({ stdout: 'LAME 64bits version 3.100\n', stderr: '' }),
      }),
    /LAME 4\.0 exactly/i,
  )
})

test('real generation is transactional under encoder and publish failures, then recovers cleanly', async () => {
  const scope = await makeFixtureScope('transaction')
  const targetDirectory = join(scope, 'target')
  const first = await generateFixtures({ outputDirectory: targetDirectory })
  assert.equal(first.lock.files.length, FIXTURE_ROLES.length)
  assert.deepEqual(first.lock.encoders, [
    {
      codec: 'mp3',
      name: 'lame',
      settings: ['--cbr', '-b', '128', '--noreplaygain'],
      version: '4.0',
    },
    {
      codec: 'flac',
      name: 'afconvert',
      settings: ['-f', 'flac', '-d', 'flac'],
      version: '2.0',
    },
  ])
  await verifyFixtureSet({ directory: targetDirectory })
  const oldSet = await readCompleteSet(targetDirectory)

  await assert.rejects(
    () => generateFixtures({ outputDirectory: targetDirectory }),
    /without --force/i,
  )
  await assert.rejects(
    () =>
      generateFixtures({
        encoder: async () => {
          throw new Error('injected encoder failure')
        },
        force: true,
        outputDirectory: targetDirectory,
      }),
    /injected encoder failure/i,
  )
  assertCompleteSetEqual(oldSet, await readCompleteSet(targetDirectory))

  const paths = fixtureTransactionPaths(targetDirectory)
  await copyCompleteSet(targetDirectory, paths.stagingDirectory)
  await assert.rejects(
    () =>
      publishFixtureDirectory({
        force: true,
        outputDirectory: targetDirectory,
        stagingDirectory: paths.stagingDirectory,
        transactionHooks: {
          afterBackup: async () => {
            throw new Error('injected publish failure')
          },
        },
      }),
    /injected publish failure/i,
  )
  assertCompleteSetEqual(oldSet, await readCompleteSet(targetDirectory))
  await assertNoTransactionResidue(targetDirectory)

  await copyCompleteSet(targetDirectory, paths.stagingDirectory)
  await publishFixtureDirectory({
    force: true,
    outputDirectory: targetDirectory,
    stagingDirectory: paths.stagingDirectory,
  })
  assertCompleteSetEqual(oldSet, await readCompleteSet(targetDirectory))
  await assertNoTransactionResidue(targetDirectory)

  await rename(targetDirectory, paths.backupDirectory)
  await recoverFixtureTransaction({ outputDirectory: targetDirectory })
  await verifyFixtureSet({ directory: targetDirectory })
  assertCompleteSetEqual(oldSet, await readCompleteSet(targetDirectory))
  await assertNoTransactionResidue(targetDirectory)

  await rename(targetDirectory, paths.stagingDirectory)
  await recoverFixtureTransaction({ outputDirectory: targetDirectory })
  await verifyFixtureSet({ directory: targetDirectory })
  assertCompleteSetEqual(oldSet, await readCompleteSet(targetDirectory))
  await assertNoTransactionResidue(targetDirectory)
})
