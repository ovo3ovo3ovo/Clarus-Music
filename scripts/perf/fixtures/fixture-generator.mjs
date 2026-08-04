import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE_HZ,
  DEFAULT_OUTPUT_DIRECTORY,
  DEFAULT_RECIPE_MANIFEST_PATH,
  LOCK_FILENAME,
  buildDeterministicYrc,
  buildPcmWav,
  openNoFollowRegularFile,
  resolveFixtureDirectory,
  resolveFixturePath,
  sha256,
  validateRecipeManifest,
} from './fixture-spec.mjs'
import {
  FLAC_ENCODER_SETTINGS,
  MP3_ENCODER_SETTINGS,
  inspectAudioFile,
  verifyFixtureSet,
} from './fixture-verifier.mjs'

export const LAME_EXECUTABLE = '/opt/homebrew/bin/lame'
export const AFCONVERT_EXECUTABLE = '/usr/bin/afconvert'

const execFileAsync = promisify(execFile)

function processErrorDetails(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
  const message = error instanceof Error ? error.message : String(error)
  return `${stderr}\n${message}`.trim().replace(/(?:[A-Za-z]:)?\/[^\s'"]+/g, '[path]')
}

async function runProcess(executable, argumentsList, { timeout = 120000 } = {}) {
  return execFileAsync(executable, argumentsList, {
    maxBuffer: 1024 * 1024,
    timeout,
  })
}

function assertCodec(recipe, codec, encoderName) {
  if (!recipe || recipe.codec !== codec) {
    throw new Error(`${encoderName} encoder only supports ${codec.toUpperCase()} recipes`)
  }
}

function assertEncoderPaths(inputPath, outputPath, encoderName) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new Error(`${encoderName} encoder requires an input path`)
  }
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new Error(`${encoderName} encoder requires an output path`)
  }
}

async function assertEncoderOutput(outputPath, codec, encoderName) {
  let details
  try {
    details = await lstat(outputPath)
  } catch (error) {
    throw new Error(`${encoderName} did not create a ${codec.toUpperCase()} fixture`, {
      cause: error,
    })
  }
  if (details.isSymbolicLink() || !details.isFile() || details.size === 0) {
    throw new Error(
      `${encoderName} did not create a non-empty regular ${codec.toUpperCase()} fixture`,
    )
  }
}

function normalizeLameVersion(output) {
  const version = output.match(/\bversion\s+(\d+(?:\.\d+)+)\b/i)?.[1]
  if (version !== '4.0') {
    throw new Error('Fixture generation requires Homebrew LAME 4.0 exactly')
  }
  return version
}

function normalizeAfconvertVersion(output) {
  const version = output.match(/\bVersion:\s*(\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?)/i)?.[1]
  if (!version) {
    throw new Error('afconvert did not report a normalized version')
  }
  return version
}

export async function getLameVersion({ executable = LAME_EXECUTABLE, run = runProcess } = {}) {
  if (executable !== LAME_EXECUTABLE) {
    throw new Error('Fixture generation requires /opt/homebrew/bin/lame')
  }
  let result
  try {
    result = await run(executable, ['--version'], { timeout: 30000 })
  } catch (error) {
    throw new Error(`Unable to run Homebrew LAME 4.0: ${processErrorDetails(error)}`, {
      cause: error,
    })
  }
  return normalizeLameVersion(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`)
}

export async function getAfconvertVersion({
  executable = AFCONVERT_EXECUTABLE,
  run = runProcess,
} = {}) {
  if (executable !== AFCONVERT_EXECUTABLE) {
    throw new Error('Fixture generation requires /usr/bin/afconvert')
  }
  let result
  try {
    result = await run(executable, ['-h'], { timeout: 30000 })
  } catch (error) {
    const helpOutput = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`
    try {
      return normalizeAfconvertVersion(helpOutput)
    } catch {
      // afconvert intentionally exits nonzero for -h; only its version-bearing output is accepted.
    }
    throw new Error(`Unable to run afconvert: ${processErrorDetails(error)}`, { cause: error })
  }
  return normalizeAfconvertVersion(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`)
}

export async function encodeWithLame({ inputPath, outputPath, recipe, run = runProcess } = {}) {
  assertCodec(recipe, 'mp3', 'LAME')
  assertEncoderPaths(inputPath, outputPath, 'LAME')
  try {
    await run(LAME_EXECUTABLE, [...MP3_ENCODER_SETTINGS, inputPath, outputPath])
  } catch (error) {
    throw new Error(`LAME failed to encode MP3: ${processErrorDetails(error)}`, { cause: error })
  }
  await assertEncoderOutput(outputPath, 'mp3', 'LAME')
}

export async function encodeWithAfconvert({
  inputPath,
  outputPath,
  recipe,
  run = runProcess,
} = {}) {
  assertCodec(recipe, 'flac', 'afconvert')
  assertEncoderPaths(inputPath, outputPath, 'afconvert')
  try {
    await run(AFCONVERT_EXECUTABLE, [...FLAC_ENCODER_SETTINGS, inputPath, outputPath])
  } catch (error) {
    throw new Error(`afconvert failed to encode FLAC: ${processErrorDetails(error)}`, {
      cause: error,
    })
  }
  await assertEncoderOutput(outputPath, 'flac', 'afconvert')
}

export async function encodeFixtureAudio({ recipe, run = runProcess, ...paths } = {}) {
  if (recipe?.codec === 'mp3') {
    return encodeWithLame({ ...paths, recipe, run })
  }
  if (recipe?.codec === 'flac') {
    return encodeWithAfconvert({ ...paths, recipe, run })
  }
  throw new Error(`No audio encoder is configured for fixture codec: ${recipe?.codec}`)
}

export async function preflightToolchain({ encoder = encodeFixtureAudio, run = runProcess } = {}) {
  const lameVersion = await getLameVersion({ run })
  const afconvertVersion = await getAfconvertVersion({ run })
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'clarus-fixture-preflight-'))
  const wavPath = join(temporaryDirectory, 'preflight.wav')
  const preflightRecipe = {
    channels: AUDIO_CHANNELS,
    durationSeconds: 0.25,
    expectedSeekMarkersSeconds: [],
    sampleRateHz: AUDIO_SAMPLE_RATE_HZ,
  }
  try {
    await writeFile(wavPath, buildPcmWav(preflightRecipe))
    for (const recipe of [
      { ...preflightRecipe, codec: 'mp3', filename: 'preflight.mp3' },
      { ...preflightRecipe, codec: 'flac', filename: 'preflight.flac' },
    ]) {
      const outputPath = join(temporaryDirectory, recipe.filename)
      await encoder({ inputPath: wavPath, outputPath, recipe, run })
      const inspected = await inspectAudioFile({
        channels: recipe.channels,
        codec: recipe.codec,
        filePath: outputPath,
        run,
        sampleRateHz: recipe.sampleRateHz,
      })
      if (
        recipe.codec === 'mp3' &&
        Math.abs(inspected.durationSeconds - recipe.durationSeconds) > 0.1
      ) {
        throw new Error('LAME preflight MP3 duration is outside the required ±0.10s tolerance')
      }
      if (
        recipe.codec === 'flac' &&
        Math.abs(inspected.decoded.frameCount - recipe.durationSeconds * recipe.sampleRateHz) > 1
      ) {
        throw new Error('afconvert preflight FLAC duration is outside one decoded sample')
      }
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
  return {
    encoders: [
      {
        codec: 'mp3',
        name: 'lame',
        settings: [...MP3_ENCODER_SETTINGS],
        version: lameVersion,
      },
      {
        codec: 'flac',
        name: 'afconvert',
        settings: [...FLAC_ENCODER_SETTINGS],
        version: afconvertVersion,
      },
    ],
  }
}

async function readAndValidateRecipeManifest(recipeManifestPath) {
  if (recipeManifestPath !== DEFAULT_RECIPE_MANIFEST_PATH) {
    throw new Error('Fixture generation must use the canonical recipe manifest')
  }
  let parsed
  try {
    parsed = JSON.parse(await readFile(DEFAULT_RECIPE_MANIFEST_PATH, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read canonical recipe manifest: ${processErrorDetails(error)}`, {
      cause: error,
    })
  }
  return validateRecipeManifest(parsed)
}

async function lockedFileFor(stagingDirectory, recipe) {
  const fixturePath = resolveFixturePath(stagingDirectory, recipe.filename)
  const handle = await openNoFollowRegularFile(fixturePath, `generated fixture ${recipe.filename}`)
  try {
    const contents = await handle.readFile()
    if (contents.byteLength === 0) {
      throw new Error(`Generated fixture is empty: ${recipe.filename}`)
    }
    return {
      byteLength: contents.byteLength,
      filename: recipe.filename,
      role: recipe.role,
      sha256: sha256(contents),
    }
  } finally {
    await handle.close()
  }
}

async function ownedDirectoryExists(pathname, label) {
  let details
  try {
    details = await lstat(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw new Error(`Unable to inspect ${label}: ${error.message}`, { cause: error })
  }
  if (details.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`)
  }
  if (!details.isDirectory()) {
    throw new Error(`${label} must be a directory`)
  }
  await resolveFixtureDirectory(pathname)
  return true
}

async function removeOwnedDirectory(pathname, label) {
  if (await ownedDirectoryExists(pathname, label)) {
    await rm(pathname, { force: false, recursive: true })
  }
}

async function renameOwnedDirectory(fromPath, toPath, fromLabel, toLabel) {
  if (!(await ownedDirectoryExists(fromPath, fromLabel))) {
    throw new Error(`${fromLabel} is missing`)
  }
  if (await ownedDirectoryExists(toPath, toLabel)) {
    throw new Error(`${toLabel} already exists`)
  }
  try {
    await rename(fromPath, toPath)
  } catch (error) {
    throw new Error(`Unable to rename ${fromLabel}: ${error.message}`, { cause: error })
  }
}

export function fixtureTransactionPaths(targetDirectory) {
  const targetName = basename(targetDirectory)
  const parentDirectory = dirname(targetDirectory)
  return {
    backupDirectory: join(parentDirectory, `.${targetName}.fixture-backup`),
    stagingDirectory: join(parentDirectory, `.${targetName}.fixture-staging`),
  }
}

async function recoverResolvedTransaction(targetDirectory, recipeManifestPath) {
  const { backupDirectory, stagingDirectory } = fixtureTransactionPaths(targetDirectory)
  let hasTarget = await ownedDirectoryExists(targetDirectory, 'fixture target')
  let hasStaging = await ownedDirectoryExists(stagingDirectory, 'fixture staging directory')
  const hasBackup = await ownedDirectoryExists(backupDirectory, 'fixture backup directory')

  if (hasBackup) {
    if (hasTarget) {
      const targetIsVerified = await verifyFixtureSet({
        directory: targetDirectory,
        recipeManifestPath,
      }).then(
        () => true,
        () => false,
      )
      if (targetIsVerified) {
        if (hasStaging) {
          await removeOwnedDirectory(stagingDirectory, 'fixture staging directory')
        }
        await removeOwnedDirectory(backupDirectory, 'fixture backup directory')
        return
      }
      if (hasStaging) {
        await removeOwnedDirectory(stagingDirectory, 'fixture staging directory')
      }
      await renameOwnedDirectory(
        targetDirectory,
        stagingDirectory,
        'fixture target',
        'fixture staging directory',
      )
      await renameOwnedDirectory(
        backupDirectory,
        targetDirectory,
        'fixture backup directory',
        'fixture target',
      )
      await removeOwnedDirectory(stagingDirectory, 'fixture staging directory')
      return
    }
    if (hasStaging) {
      await removeOwnedDirectory(stagingDirectory, 'fixture staging directory')
    }
    await verifyFixtureSet({ directory: backupDirectory, recipeManifestPath })
    await renameOwnedDirectory(
      backupDirectory,
      targetDirectory,
      'fixture backup directory',
      'fixture target',
    )
    return
  }

  if (hasStaging) {
    if (hasTarget) {
      await removeOwnedDirectory(stagingDirectory, 'fixture staging directory')
      return
    }
    try {
      await verifyFixtureSet({ directory: stagingDirectory, recipeManifestPath })
    } catch {
      await removeOwnedDirectory(stagingDirectory, 'fixture staging directory')
      return
    }
    await renameOwnedDirectory(
      stagingDirectory,
      targetDirectory,
      'fixture staging directory',
      'fixture target',
    )
  }
}

export async function recoverFixtureTransaction({
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  recipeManifestPath = DEFAULT_RECIPE_MANIFEST_PATH,
} = {}) {
  const targetDirectory = await resolveFixtureDirectory(outputDirectory, {
    createParents: true,
    requireExists: false,
  })
  await recoverResolvedTransaction(targetDirectory, recipeManifestPath)
  return { directory: targetDirectory, ...fixtureTransactionPaths(targetDirectory) }
}

function transactionHook(transactionHooks, name) {
  const hook = transactionHooks?.[name]
  if (hook !== undefined && typeof hook !== 'function') {
    throw new Error(`Fixture transaction hook ${name} must be a function`)
  }
  return hook
}

async function restoreBackup({ backupDirectory, stagingDirectory, targetDirectory }) {
  const hasTarget = await ownedDirectoryExists(targetDirectory, 'fixture target')
  const hasStaging = await ownedDirectoryExists(stagingDirectory, 'fixture staging directory')
  const hasBackup = await ownedDirectoryExists(backupDirectory, 'fixture backup directory')
  if (hasTarget && !hasStaging) {
    await renameOwnedDirectory(
      targetDirectory,
      stagingDirectory,
      'fixture target',
      'fixture staging directory',
    )
  }
  if (hasBackup) {
    await renameOwnedDirectory(
      backupDirectory,
      targetDirectory,
      'fixture backup directory',
      'fixture target',
    )
  }
  if (await ownedDirectoryExists(stagingDirectory, 'fixture staging directory')) {
    await removeOwnedDirectory(stagingDirectory, 'fixture staging directory')
  }
}

async function publishResolvedFixtureDirectory({
  recipeManifestPath,
  stagingDirectory,
  targetDirectory,
  transactionHooks,
}) {
  const { backupDirectory, stagingDirectory: expectedStagingDirectory } =
    fixtureTransactionPaths(targetDirectory)
  if (stagingDirectory !== expectedStagingDirectory) {
    throw new Error('Fixture staging directory does not match the target transaction path')
  }
  await verifyFixtureSet({ directory: stagingDirectory, recipeManifestPath })
  const hasTarget = await ownedDirectoryExists(targetDirectory, 'fixture target')

  if (!hasTarget) {
    await renameOwnedDirectory(
      stagingDirectory,
      targetDirectory,
      'fixture staging directory',
      'fixture target',
    )
    try {
      await verifyFixtureSet({ directory: targetDirectory, recipeManifestPath })
      return
    } catch (error) {
      await renameOwnedDirectory(
        targetDirectory,
        stagingDirectory,
        'fixture target',
        'fixture staging directory',
      )
      await removeOwnedDirectory(stagingDirectory, 'fixture staging directory')
      throw error
    }
  }

  if (await ownedDirectoryExists(backupDirectory, 'fixture backup directory')) {
    throw new Error(
      'Fixture backup directory already exists; recover the interrupted transaction first',
    )
  }
  await renameOwnedDirectory(
    targetDirectory,
    backupDirectory,
    'fixture target',
    'fixture backup directory',
  )
  try {
    await transactionHook(transactionHooks, 'afterBackup')?.()
    await renameOwnedDirectory(
      stagingDirectory,
      targetDirectory,
      'fixture staging directory',
      'fixture target',
    )
    await verifyFixtureSet({ directory: targetDirectory, recipeManifestPath })
    await removeOwnedDirectory(backupDirectory, 'fixture backup directory')
  } catch (error) {
    try {
      await restoreBackup({ backupDirectory, stagingDirectory, targetDirectory })
    } catch (restoreError) {
      throw new Error(`Fixture publication failed and restore failed: ${restoreError.message}`, {
        cause: restoreError,
      })
    }
    throw error
  }
}

export async function publishFixtureDirectory({
  force = false,
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  recipeManifestPath = DEFAULT_RECIPE_MANIFEST_PATH,
  stagingDirectory,
  transactionHooks,
} = {}) {
  const targetDirectory = await resolveFixtureDirectory(outputDirectory, {
    createParents: true,
    requireExists: false,
  })
  const expectedPaths = fixtureTransactionPaths(targetDirectory)
  const resolvedStagingDirectory = await resolveFixtureDirectory(
    stagingDirectory ?? expectedPaths.stagingDirectory,
  )
  if (resolvedStagingDirectory !== expectedPaths.stagingDirectory) {
    throw new Error('Fixture staging directory does not match the target transaction path')
  }
  if ((await ownedDirectoryExists(targetDirectory, 'fixture target')) && !force) {
    throw new Error('Refusing to replace an existing fixture set without --force')
  }
  await publishResolvedFixtureDirectory({
    recipeManifestPath,
    stagingDirectory: resolvedStagingDirectory,
    targetDirectory,
    transactionHooks,
  })
  return { directory: targetDirectory, ...expectedPaths }
}

async function createStagingDirectory(stagingDirectory) {
  try {
    await mkdir(stagingDirectory)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        'Fixture staging directory already exists; recover the interrupted transaction first',
        { cause: error },
      )
    }
    throw new Error(`Unable to create fixture staging directory: ${error.message}`, {
      cause: error,
    })
  }
  return resolveFixtureDirectory(stagingDirectory)
}

export async function generateFixtures({
  encoder = encodeFixtureAudio,
  force = false,
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  pcmBuilder = buildPcmWav,
  recipeManifestPath = DEFAULT_RECIPE_MANIFEST_PATH,
  run = runProcess,
  transactionHooks,
} = {}) {
  const manifest = await readAndValidateRecipeManifest(recipeManifestPath)
  const targetDirectory = await resolveFixtureDirectory(outputDirectory, {
    createParents: true,
    requireExists: false,
  })
  await recoverResolvedTransaction(targetDirectory, recipeManifestPath)
  if ((await ownedDirectoryExists(targetDirectory, 'fixture target')) && !force) {
    throw new Error('Refusing to replace an existing fixture set without --force')
  }

  const toolchain = await preflightToolchain({ encoder, run })
  const { stagingDirectory } = fixtureTransactionPaths(targetDirectory)
  const resolvedStagingDirectory = await createStagingDirectory(stagingDirectory)
  try {
    const lockedFiles = []
    for (const recipe of manifest.recipes) {
      const stagedOutputPath = resolveFixturePath(resolvedStagingDirectory, recipe.filename)
      if (recipe.codec === 'yrc') {
        await writeFile(stagedOutputPath, buildDeterministicYrc(), 'utf8')
      } else {
        const wavPath = join(resolvedStagingDirectory, `.${recipe.role}.source.wav`)
        try {
          await writeFile(wavPath, pcmBuilder(recipe))
          await encoder({ inputPath: wavPath, outputPath: stagedOutputPath, recipe, run })
        } finally {
          await rm(wavPath, { force: true })
        }
      }
      lockedFiles.push(await lockedFileFor(resolvedStagingDirectory, recipe))
    }
    const lock = {
      encoders: toolchain.encoders,
      files: lockedFiles,
      recipeVersion: manifest.generatorVersion,
      schemaVersion: manifest.schemaVersion,
    }
    await writeFile(
      join(resolvedStagingDirectory, LOCK_FILENAME),
      `${JSON.stringify(lock, null, 2)}\n`,
      'utf8',
    )

    await verifyFixtureSet({ directory: resolvedStagingDirectory, recipeManifestPath })
    await publishFixtureDirectory({
      force,
      outputDirectory: targetDirectory,
      recipeManifestPath,
      stagingDirectory: resolvedStagingDirectory,
      transactionHooks,
    })
    return { directory: targetDirectory, lock, manifest }
  } finally {
    await removeOwnedDirectory(stagingDirectory, 'fixture staging directory')
  }
}
