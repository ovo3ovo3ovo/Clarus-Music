import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

export const SCHEMA_VERSION = 2
export const GENERATOR_VERSION = '2.0.0'
export const AUDIO_SAMPLE_RATE_HZ = 44100
export const AUDIO_CHANNELS = 2
export const LOCK_FILENAME = 'fixtures.lock.json'
export const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
export const CANONICAL_FIXTURE_ROOT = resolve(REPOSITORY_ROOT, 'artifacts', 'perf', 'fixtures')
export const DEFAULT_OUTPUT_DIRECTORY = join(CANONICAL_FIXTURE_ROOT, 'current')
export const DEFAULT_RECIPE_MANIFEST_PATH = fileURLToPath(
  new URL('./fixture-recipes.json', import.meta.url),
)
export const FIXTURE_ROLES = Object.freeze([
  'tone-short-mp3',
  'tone-long-mp3',
  'tone-seek-mp3',
  'tone-flac',
  'word-timed-yrc',
])

const COMMON_RECIPE = Object.freeze({
  generatorVersion: GENERATOR_VERSION,
  license: 'CC0-1.0',
  schemaVersion: SCHEMA_VERSION,
  source: 'project-generated',
})

export const CANONICAL_RECIPES = Object.freeze({
  'tone-short-mp3': Object.freeze({
    ...COMMON_RECIPE,
    channels: AUDIO_CHANNELS,
    codec: 'mp3',
    durationSeconds: 12,
    expectedSeekMarkersSeconds: [],
    filename: 'tone-short-mp3.mp3',
    mimeType: 'audio/mpeg',
    role: 'tone-short-mp3',
    sampleRateHz: AUDIO_SAMPLE_RATE_HZ,
  }),
  'tone-long-mp3': Object.freeze({
    ...COMMON_RECIPE,
    channels: AUDIO_CHANNELS,
    codec: 'mp3',
    durationSeconds: 300,
    expectedSeekMarkersSeconds: [],
    filename: 'tone-long-mp3.mp3',
    mimeType: 'audio/mpeg',
    role: 'tone-long-mp3',
    sampleRateHz: AUDIO_SAMPLE_RATE_HZ,
  }),
  'tone-seek-mp3': Object.freeze({
    ...COMMON_RECIPE,
    channels: AUDIO_CHANNELS,
    codec: 'mp3',
    durationSeconds: 120,
    expectedSeekMarkersSeconds: Object.freeze([0, 30, 60, 90]),
    filename: 'tone-seek-mp3.mp3',
    mimeType: 'audio/mpeg',
    role: 'tone-seek-mp3',
    sampleRateHz: AUDIO_SAMPLE_RATE_HZ,
  }),
  'tone-flac': Object.freeze({
    ...COMMON_RECIPE,
    channels: AUDIO_CHANNELS,
    codec: 'flac',
    durationSeconds: 30,
    expectedSeekMarkersSeconds: [],
    filename: 'tone-flac.flac',
    mimeType: 'audio/flac',
    role: 'tone-flac',
    sampleRateHz: AUDIO_SAMPLE_RATE_HZ,
  }),
  'word-timed-yrc': Object.freeze({
    ...COMMON_RECIPE,
    codec: 'yrc',
    durationSeconds: 18,
    expectedSeekMarkersSeconds: [],
    filename: 'word-timed-yrc.yrc',
    mimeType: 'text/plain',
    role: 'word-timed-yrc',
  }),
})

const ROOT_MANIFEST_KEYS = Object.freeze(['generatorVersion', 'recipes', 'schemaVersion'])
const AUDIO_RECIPE_KEYS = Object.freeze([
  'channels',
  'codec',
  'durationSeconds',
  'expectedSeekMarkersSeconds',
  'filename',
  'generatorVersion',
  'license',
  'mimeType',
  'role',
  'sampleRateHz',
  'schemaVersion',
  'source',
])
const TEXT_RECIPE_KEYS = Object.freeze([
  'codec',
  'durationSeconds',
  'expectedSeekMarkersSeconds',
  'filename',
  'generatorVersion',
  'license',
  'mimeType',
  'role',
  'schemaVersion',
  'source',
])

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertExactKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys)
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(`${label} has unknown property: ${unknownKeys.join(', ')}`)
  }

  const missingKeys = allowedKeys.filter((key) => !(key in value))
  if (missingKeys.length > 0) {
    throw new Error(`${label} is missing property: ${missingKeys.join(', ')}`)
  }
}

function valuesMatch(actual, expected) {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((entry, index) => valuesMatch(entry, expected[index]))
    )
  }

  return actual === expected
}

function assertCanonicalValue(recipe, canonicalRecipe, key) {
  if (!valuesMatch(recipe[key], canonicalRecipe[key])) {
    throw new Error(
      `recipe ${recipe.role} has invalid ${key}; expected ${JSON.stringify(canonicalRecipe[key])}`,
    )
  }
}

function assertPcmRecipe(recipe) {
  assertPlainObject(recipe, 'PCM recipe')
  const { channels, durationSeconds, expectedSeekMarkersSeconds = [], sampleRateHz } = recipe
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new Error('PCM recipe channels must be one or two')
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('PCM recipe durationSeconds must be positive')
  }
  if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error('PCM recipe sampleRateHz must be a positive integer')
  }
  if (!Array.isArray(expectedSeekMarkersSeconds)) {
    throw new Error('PCM recipe expectedSeekMarkersSeconds must be an array')
  }
  if (
    expectedSeekMarkersSeconds.some(
      (marker) =>
        !Number.isFinite(marker) ||
        marker < 0 ||
        marker >= durationSeconds ||
        !Number.isInteger(marker * sampleRateHz),
    )
  ) {
    throw new Error('PCM recipe expectedSeekMarkersSeconds must be in the source duration')
  }
}

function normalizedPcmSample(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value * 32767)))
}

function isMarkerFrame(frame, sampleRateHz, markers) {
  const markerLengthFrames = Math.floor(sampleRateHz / 4)
  return markers.some((marker) => {
    const markerStart = marker * sampleRateHz
    return frame >= markerStart && frame < markerStart + markerLengthFrames
  })
}

function isContainedPath(root, candidate, { allowRoot = false } = {}) {
  const pathFromRoot = relative(root, candidate)
  return (
    (allowRoot || pathFromRoot.length > 0) &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    pathFromRoot !== '..' &&
    !isAbsolute(pathFromRoot)
  )
}

function assertNoTraversal(directory) {
  if (directory.includes('\\')) {
    throw new Error('Fixture directory must not contain backslash path separators')
  }
  if (directory.split('/').some((component) => component === '..')) {
    throw new Error('Fixture directory must not contain parent-directory traversal')
  }
}

function normalizePublicDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0')) {
    throw new Error('Fixture directory must be a non-empty path')
  }
  assertNoTraversal(directory)
  if (win32.isAbsolute(directory) && !isAbsolute(directory)) {
    throw new Error('Fixture directory must be a strict child of the canonical fixture root')
  }
  const candidate = isAbsolute(directory) ? resolve(directory) : resolve(REPOSITORY_ROOT, directory)
  if (!isContainedPath(CANONICAL_FIXTURE_ROOT, candidate)) {
    throw new Error('Fixture directory must be a strict child of the canonical fixture root')
  }
  return candidate
}

async function inspectDirectory(pathname, label, rootPath) {
  let details
  try {
    details = await lstat(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined
    }
    throw new Error(`Unable to inspect ${label}: ${error.message}`, { cause: error })
  }
  if (details.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`)
  }
  if (!details.isDirectory()) {
    throw new Error(`${label} must be a directory`)
  }
  let physicalPath
  try {
    physicalPath = await realpath(pathname)
  } catch (error) {
    throw new Error(`Unable to resolve ${label}: ${error.message}`, { cause: error })
  }
  if (!isContainedPath(rootPath, physicalPath, { allowRoot: true })) {
    throw new Error(`${label} resolves outside the canonical fixture root`)
  }
  return physicalPath
}

export async function ensureCanonicalFixtureRoot({ create = false } = {}) {
  let repositoryRoot
  try {
    repositoryRoot = await realpath(REPOSITORY_ROOT)
  } catch (error) {
    throw new Error(`Unable to resolve repository root: ${error.message}`, { cause: error })
  }

  let currentPath = repositoryRoot
  for (const component of ['artifacts', 'perf', 'fixtures']) {
    const nextPath = join(currentPath, component)
    let details = await inspectDirectory(
      nextPath,
      `fixture root component ${component}`,
      repositoryRoot,
    )
    if (!details) {
      if (!create) {
        throw new Error('Canonical fixture root does not exist')
      }
      try {
        await mkdir(nextPath)
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw new Error(
            `Unable to create fixture root component ${component}: ${error.message}`,
            {
              cause: error,
            },
          )
        }
      }
      details = await inspectDirectory(
        nextPath,
        `fixture root component ${component}`,
        repositoryRoot,
      )
      if (!details) {
        throw new Error(`Fixture root component ${component} was not created`)
      }
    }
    currentPath = details
  }
  return currentPath
}

export async function resolveFixtureDirectory(
  directory,
  { createParents = false, requireExists = true } = {},
) {
  const requestedDirectory = normalizePublicDirectory(directory)
  const relativeDirectory = relative(CANONICAL_FIXTURE_ROOT, requestedDirectory)
  const components = relativeDirectory.split(sep).filter(Boolean)
  const physicalRoot = await ensureCanonicalFixtureRoot({ create: createParents })
  let currentPath = physicalRoot

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]
    const nextPath = join(currentPath, component)
    let inspected = await inspectDirectory(
      nextPath,
      `fixture directory component ${component}`,
      physicalRoot,
    )
    if (!inspected) {
      const isTarget = index === components.length - 1
      if (createParents && !isTarget) {
        try {
          await mkdir(nextPath)
        } catch (error) {
          if (error?.code !== 'EEXIST') {
            throw new Error(
              `Unable to create fixture directory component ${component}: ${error.message}`,
              {
                cause: error,
              },
            )
          }
        }
        inspected = await inspectDirectory(
          nextPath,
          `fixture directory component ${component}`,
          physicalRoot,
        )
      } else if (isTarget && !requireExists) {
        return nextPath
      } else {
        throw new Error('Fixture directory does not exist')
      }
    }
    if (!inspected) {
      throw new Error(`Fixture directory component ${component} was not created`)
    }
    currentPath = inspected
  }

  if (!isContainedPath(physicalRoot, currentPath)) {
    throw new Error('Fixture directory must be a strict child of the canonical fixture root')
  }
  return currentPath
}

export async function openNoFollowRegularFile(pathname, label = 'fixture file') {
  const physicalRoot = await ensureCanonicalFixtureRoot()
  const resolvedPath = resolve(pathname)
  if (!isContainedPath(physicalRoot, resolvedPath)) {
    throw new Error(`${label} resolves outside the canonical fixture root`)
  }

  let before
  try {
    before = await lstat(resolvedPath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} is missing`, { cause: error })
    }
    throw new Error(`Unable to inspect ${label}: ${error.message}`, { cause: error })
  }
  if (before.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`)
  }
  if (!before.isFile()) {
    throw new Error(`${label} must be a regular file`)
  }

  let physicalPath
  try {
    physicalPath = await realpath(resolvedPath)
  } catch (error) {
    throw new Error(`Unable to resolve ${label}: ${error.message}`, { cause: error })
  }
  if (!isContainedPath(physicalRoot, physicalPath)) {
    throw new Error(`${label} resolves outside the canonical fixture root`)
  }
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('No-follow file opening is unavailable on this platform')
  }

  let handle
  try {
    handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isFile()) {
      throw new Error(`${label} must be a regular file`)
    }
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error(`${label} changed while it was being opened`)
    }
    return handle
  } catch (error) {
    await handle?.close().catch(() => {})
    if (
      error instanceof Error &&
      /must be a regular file|changed while it was being opened/.test(error.message)
    ) {
      throw error
    }
    throw new Error(`Unable to open ${label} without following links: ${error.message}`, {
      cause: error,
    })
  }
}

export function buildPcmWav(recipe) {
  assertPcmRecipe(recipe)
  const { channels, durationSeconds, expectedSeekMarkersSeconds = [], sampleRateHz } = recipe
  const frameCount = Math.round(durationSeconds * sampleRateHz)
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
    throw new Error('PCM recipe frame count is invalid')
  }

  const bytesPerSample = 2
  const dataByteLength = frameCount * channels * bytesPerSample
  if (dataByteLength > 0xffffffff - 36) {
    throw new Error('PCM WAV source exceeds the RIFF size limit')
  }

  const wav = Buffer.allocUnsafe(44 + dataByteLength)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + dataByteLength, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRateHz, 24)
  wav.writeUInt32LE(sampleRateHz * channels * bytesPerSample, 28)
  wav.writeUInt16LE(channels * bytesPerSample, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(dataByteLength, 40)

  let offset = 44
  for (let frame = 0; frame < frameCount; frame += 1) {
    const seconds = frame / sampleRateHz
    const baseTone = 0.18 * Math.sin(2 * Math.PI * 220 * seconds)
    const overtone = 0.1 * Math.sin(2 * Math.PI * 330 * seconds)
    const markerTone = isMarkerFrame(frame, sampleRateHz, expectedSeekMarkersSeconds)
      ? 0.54 * Math.sin(2 * Math.PI * 1760 * seconds)
      : 0
    const sample = normalizedPcmSample(baseTone + overtone + markerTone)
    for (let channel = 0; channel < channels; channel += 1) {
      wav.writeInt16LE(sample, offset)
      offset += bytesPerSample
    }
  }

  return wav
}

export function buildDeterministicYrc() {
  return [
    '[0,6000](0,1200,0)zavo(1200,1200,0)lumi(2400,1200,0)kera(3600,1200,0)nivo',
    '[6000,6000](0,1200,0)pela(1200,1200,0)soro(2400,1200,0)vim(3600,1200,0)talo',
    '[12000,6000](0,1200,0)reno(1200,1200,0)kavi(2400,1200,0)sumi(3600,1200,0)zelo',
    '',
  ].join('\n')
}

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

export function isSafeRelativeFilename(filename) {
  return (
    typeof filename === 'string' &&
    filename.length > 0 &&
    !filename.includes('\0') &&
    !filename.includes('/') &&
    !filename.includes('\\') &&
    !filename.includes('..') &&
    !isAbsolute(filename) &&
    !posix.isAbsolute(filename) &&
    !win32.isAbsolute(filename) &&
    /^[a-z0-9][a-z0-9.-]*\.(mp3|flac|yrc)$/.test(filename)
  )
}

export function resolveFixturePath(directory, filename) {
  if (!isSafeRelativeFilename(filename)) {
    throw new Error(`fixture filename must be a safe relative filename: ${filename}`)
  }

  const root = resolve(directory)
  const candidate = resolve(root, filename)
  if (!isContainedPath(root, candidate)) {
    throw new Error(`fixture filename escapes its directory: ${filename}`)
  }
  return candidate
}

export function validateRecipeManifest(manifest) {
  assertPlainObject(manifest, 'recipe manifest')
  assertExactKeys(manifest, ROOT_MANIFEST_KEYS, 'recipe manifest')
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`recipe manifest schemaVersion must be ${SCHEMA_VERSION}`)
  }
  if (manifest.generatorVersion !== GENERATOR_VERSION) {
    throw new Error(`recipe manifest generatorVersion must be ${GENERATOR_VERSION}`)
  }
  if (!Array.isArray(manifest.recipes)) {
    throw new Error('recipe manifest recipes must be an array')
  }

  const seenRoles = new Set()
  for (const recipe of manifest.recipes) {
    assertPlainObject(recipe, 'recipe')
    if (typeof recipe.role !== 'string' || !(recipe.role in CANONICAL_RECIPES)) {
      throw new Error(`recipe has unknown role: ${recipe.role}`)
    }
    if (seenRoles.has(recipe.role)) {
      throw new Error(`recipe manifest has duplicate role: ${recipe.role}`)
    }
    seenRoles.add(recipe.role)

    const canonicalRecipe = CANONICAL_RECIPES[recipe.role]
    const allowedKeys = canonicalRecipe.codec === 'yrc' ? TEXT_RECIPE_KEYS : AUDIO_RECIPE_KEYS
    assertExactKeys(recipe, allowedKeys, `recipe ${recipe.role}`)
    for (const key of allowedKeys) {
      assertCanonicalValue(recipe, canonicalRecipe, key)
    }
    if (!isSafeRelativeFilename(recipe.filename)) {
      throw new Error(`recipe ${recipe.role} has unsafe filename`)
    }
  }

  const missingRoles = FIXTURE_ROLES.filter((role) => !seenRoles.has(role))
  if (missingRoles.length > 0) {
    throw new Error(`recipe manifest is missing roles: ${missingRoles.join(', ')}`)
  }
  if (manifest.recipes.length !== FIXTURE_ROLES.length) {
    throw new Error('recipe manifest must contain exactly one recipe for each role')
  }

  return {
    generatorVersion: manifest.generatorVersion,
    recipes: manifest.recipes.map((recipe) => ({ ...recipe })),
    schemaVersion: manifest.schemaVersion,
  }
}
