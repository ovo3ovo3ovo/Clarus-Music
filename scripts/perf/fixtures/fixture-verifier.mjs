import { execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { readdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE_HZ,
  DEFAULT_RECIPE_MANIFEST_PATH,
  FIXTURE_ROLES,
  LOCK_FILENAME,
  buildDeterministicYrc,
  isSafeRelativeFilename,
  openNoFollowRegularFile,
  resolveFixtureDirectory,
  resolveFixturePath,
  sha256,
  validateRecipeManifest,
} from './fixture-spec.mjs'

export const AFCONVERT_EXECUTABLE = '/usr/bin/afconvert'
export const AFINFO_EXECUTABLE = '/usr/bin/afinfo'
export const MP3_ENCODER_SETTINGS = Object.freeze(['--cbr', '-b', '128', '--noreplaygain'])
export const FLAC_ENCODER_SETTINGS = Object.freeze(['-f', 'flac', '-d', 'flac'])
export const FIXED_AUDIO_ENVIRONMENT = Object.freeze({ LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' })
export const SEEK_MARKER_FREQUENCY_HZ = 1760
export const SEEK_MARKER_WINDOW_SECONDS = 0.2
export const SEEK_MARKER_MINIMUM_DB = 10
export const SEEK_CONTROL_SECONDS = Object.freeze([15, 45, 75, 105])

const execFileAsync = promisify(execFile)
const LOCK_KEYS = Object.freeze(['encoders', 'files', 'recipeVersion', 'schemaVersion'])
const LOCK_ENCODER_KEYS = Object.freeze(['codec', 'name', 'settings', 'version'])
const LOCK_FILE_KEYS = Object.freeze(['byteLength', 'filename', 'role', 'sha256'])
const EXPECTED_ENCODERS = Object.freeze([
  Object.freeze({ codec: 'mp3', name: 'lame', settings: MP3_ENCODER_SETTINGS }),
  Object.freeze({ codec: 'flac', name: 'afconvert', settings: FLAC_ENCODER_SETTINGS }),
])

function errorDetails(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
  const message = error instanceof Error ? error.message : String(error)
  return `${stderr}\n${message}`.trim().replace(/(?:[A-Za-z]:)?\/[^\s'"]+/g, '[path]')
}

async function runProcess(
  executable,
  argumentsList,
  { timeout = 120000 } = {},
) {
  if (executable !== AFINFO_EXECUTABLE && executable !== AFCONVERT_EXECUTABLE) {
    throw new Error(`Fixture verification refuses non-fixed audio tool ${executable}`)
  }
  if (!Array.isArray(argumentsList) || argumentsList.some((argument) => typeof argument !== 'string')) {
    throw new Error('Fixture verification audio tool argv must be a string array')
  }
  return execFileAsync(executable, argumentsList, {
    maxBuffer: 1024 * 1024,
    timeout,
    shell: false,
    env: { ...FIXED_AUDIO_ENVIRONMENT },
  })
}

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
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  )
}

function assertNormalizedVersion(version, label) {
  if (
    typeof version !== 'string' ||
    version.trim() !== version ||
    !/^\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?$/.test(version) ||
    version.includes('/') ||
    version.includes('\\') ||
    version.includes('\0')
  ) {
    throw new Error(`${label} must be a normalized non-path version string`)
  }
}

function assertCanonicalManifestPath(recipeManifestPath) {
  if (resolve(recipeManifestPath) !== resolve(DEFAULT_RECIPE_MANIFEST_PATH)) {
    throw new Error('Fixture verification must use the canonical recipe manifest')
  }
}

async function readRecipeManifest(recipeManifestPath) {
  assertCanonicalManifestPath(recipeManifestPath)
  let contents
  try {
    contents = await readFile(DEFAULT_RECIPE_MANIFEST_PATH, 'utf8')
  } catch (error) {
    throw new Error(`Unable to read canonical recipe manifest: ${errorDetails(error)}`, {
      cause: error,
    })
  }
  try {
    return validateRecipeManifest(JSON.parse(contents))
  } catch (error) {
    throw new Error(`Canonical recipe manifest is invalid: ${errorDetails(error)}`, {
      cause: error,
    })
  }
}

async function readJsonNoFollow(pathname, label) {
  const handle = await openNoFollowRegularFile(pathname, label)
  try {
    const contents = await handle.readFile({ encoding: 'utf8' })
    try {
      return JSON.parse(contents)
    } catch (error) {
      throw new Error(`${label} is not valid JSON: ${errorDetails(error)}`, { cause: error })
    }
  } finally {
    await handle.close()
  }
}

function parseAfinfo(output, codec) {
  const fileType = output
    .match(/^\s*File type ID:\s*([^\r\n]+)/im)?.[1]
    ?.trim()
    .toLowerCase()
  const dataFormat = output.match(/^\s*Data format:\s*(\d+)\s+ch,\s*([0-9.]+)\s+Hz/im)
  const duration = output.match(/(?:estimated\s+)?duration:\s*([0-9.]+)\s*sec/im)?.[1]

  if (!fileType || !dataFormat || duration === undefined) {
    throw new Error('afinfo did not report file type, channel count, sample rate, and duration')
  }
  const expectedTypes = codec === 'mp3' ? new Set(['mpg3', 'mp3']) : new Set(['flac'])
  if (!expectedTypes.has(fileType.replace(/[.'"]/g, ''))) {
    throw new Error(`afinfo reported unexpected ${codec} file type: ${fileType}`)
  }
  const channels = Number(dataFormat[1])
  const sampleRateHz = Number(dataFormat[2])
  const durationSeconds = Number(duration)
  if (
    !Number.isInteger(channels) ||
    !Number.isFinite(sampleRateHz) ||
    !Number.isFinite(durationSeconds)
  ) {
    throw new Error('afinfo reported invalid audio metadata')
  }
  return { channels, durationSeconds, sampleRateHz }
}

function parsePcmWav(contents) {
  if (contents.byteLength < 44 || contents.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Decoded audio is not a RIFF WAV file')
  }
  if (contents.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Decoded audio is not a WAVE file')
  }

  let format
  let data
  let offset = 12
  while (offset + 8 <= contents.byteLength) {
    const chunkName = contents.toString('ascii', offset, offset + 4)
    const chunkLength = contents.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkLength
    if (chunkEnd > contents.byteLength) {
      throw new Error('Decoded WAV has a truncated chunk')
    }
    if (chunkName === 'fmt ') {
      if (chunkLength < 16) {
        throw new Error('Decoded WAV fmt chunk is too short')
      }
      format = {
        audioFormat: contents.readUInt16LE(chunkStart),
        bitsPerSample: contents.readUInt16LE(chunkStart + 14),
        channels: contents.readUInt16LE(chunkStart + 2),
        pcmSubformat:
          chunkLength >= 40 && contents.readUInt16LE(chunkStart) === 0xfffe
            ? contents.readUInt16LE(chunkStart + 24)
            : undefined,
        sampleRateHz: contents.readUInt32LE(chunkStart + 4),
      }
    }
    if (chunkName === 'data') {
      data = contents.subarray(chunkStart, chunkEnd)
    }
    offset = chunkEnd + (chunkLength % 2)
  }
  if (!format || !data) {
    throw new Error('Decoded WAV is missing fmt or data chunks')
  }
  const isPcm =
    format.audioFormat === 1 || (format.audioFormat === 0xfffe && format.pcmSubformat === 1)
  if (!isPcm || format.bitsPerSample !== 16) {
    throw new Error('Decoded WAV is not 16-bit PCM')
  }
  const bytesPerFrame = format.channels * 2
  if (format.channels < 1 || data.byteLength % bytesPerFrame !== 0) {
    throw new Error('Decoded WAV has an invalid PCM frame layout')
  }
  return {
    channels: format.channels,
    data,
    frameCount: data.byteLength / bytesPerFrame,
    sampleRateHz: format.sampleRateHz,
  }
}

async function decodeAudioToPcm(filePath, { run = runProcess } = {}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'clarus-fixture-decode-'))
  const decodedPath = join(temporaryDirectory, 'decoded.wav')
  try {
    try {
      await run(
        AFCONVERT_EXECUTABLE,
        ['-f', 'WAVE', '-d', `LEI16@${AUDIO_SAMPLE_RATE_HZ}`, filePath, decodedPath],
        { timeout: 120000, shell: false, env: FIXED_AUDIO_ENVIRONMENT },
      )
    } catch (error) {
      throw new Error(`afconvert could not decode fixture audio: ${errorDetails(error)}`, {
        cause: error,
      })
    }
    return parsePcmWav(await readFile(decodedPath))
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

export async function inspectAudioFile({
  channels = AUDIO_CHANNELS,
  codec,
  filePath,
  run = runProcess,
  sampleRateHz = AUDIO_SAMPLE_RATE_HZ,
} = {}) {
  if (codec !== 'mp3' && codec !== 'flac') {
    throw new Error('Audio inspection requires an MP3 or FLAC codec')
  }
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Audio inspection requires a file path')
  }

  let afinfo
  try {
    afinfo = await run(AFINFO_EXECUTABLE, [filePath], {
      timeout: 30000,
      shell: false,
      env: FIXED_AUDIO_ENVIRONMENT,
    })
  } catch (error) {
    throw new Error(`afinfo could not identify fixture audio: ${errorDetails(error)}`, {
      cause: error,
    })
  }
  const metadata = parseAfinfo(`${afinfo?.stdout ?? ''}\n${afinfo?.stderr ?? ''}`, codec)
  if (metadata.channels !== channels || metadata.sampleRateHz !== sampleRateHz) {
    throw new Error(
      `afinfo reported ${metadata.channels} channels at ${metadata.sampleRateHz}Hz; expected ${channels} channels at ${sampleRateHz}Hz`,
    )
  }

  const decoded = await decodeAudioToPcm(filePath, { run })
  if (decoded.channels !== channels || decoded.sampleRateHz !== sampleRateHz) {
    throw new Error(
      `Decoded PCM has ${decoded.channels} channels at ${decoded.sampleRateHz}Hz; expected ${channels} channels at ${sampleRateHz}Hz`,
    )
  }
  return { ...metadata, decoded }
}

function coherentAmplitude(pcm, seconds) {
  const startFrame = Math.max(0, Math.round(seconds * pcm.sampleRateHz))
  const requestedFrames = Math.round(SEEK_MARKER_WINDOW_SECONDS * pcm.sampleRateHz)
  const frameCount = Math.min(requestedFrames, pcm.frameCount - startFrame)
  if (frameCount !== requestedFrames) {
    throw new Error(`Decoded PCM is too short to analyze marker at ${seconds}s`)
  }

  let cosine = 0
  let sine = 0
  const bytesPerFrame = pcm.channels * 2
  for (let index = 0; index < frameCount; index += 1) {
    const frame = startFrame + index
    const sample = pcm.data.readInt16LE(frame * bytesPerFrame) / 32768
    const phase = (2 * Math.PI * SEEK_MARKER_FREQUENCY_HZ * frame) / pcm.sampleRateHz
    cosine += sample * Math.cos(phase)
    sine += sample * Math.sin(phase)
  }
  return Math.hypot(cosine, sine) / frameCount
}

export function analyzeSeekMarkers(pcm, markers) {
  const markerEnergy = markers.map((seconds) => coherentAmplitude(pcm, seconds))
  const controlEnergy = SEEK_CONTROL_SECONDS.map((seconds) => coherentAmplitude(pcm, seconds))
  const quietestMarker = Math.min(...markerEnergy)
  const loudestControl = Math.max(...controlEnergy)
  const ratioDb =
    loudestControl === 0
      ? Number.POSITIVE_INFINITY
      : 20 * Math.log10(quietestMarker / loudestControl)
  if (!Number.isFinite(ratioDb) && ratioDb !== Number.POSITIVE_INFINITY) {
    throw new Error('Decoded marker energy ratio is invalid')
  }
  if (ratioDb < SEEK_MARKER_MINIMUM_DB) {
    throw new Error(
      `Decoded marker energy ratio is ${ratioDb.toFixed(2)}dB; expected at least ${SEEK_MARKER_MINIMUM_DB}dB`,
    )
  }
  return { controlEnergy, markerEnergy, ratioDb }
}

export function verifyDeterministicYrc(contents) {
  const expected = Buffer.from(buildDeterministicYrc(), 'utf8')
  if (!Buffer.isBuffer(contents) || !contents.equals(expected)) {
    throw new Error('YRC fixture bytes do not match the deterministic canonical content')
  }
  const timelineEnd = expected
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .reduce((latestEnd, line) => {
      const match = /^\[(\d+),(\d+)\]/.exec(line)
      if (!match) {
        throw new Error('Deterministic YRC line has an invalid timeline')
      }
      return Math.max(latestEnd, Number(match[1]) + Number(match[2]))
    }, 0)
  if (timelineEnd !== 18000) {
    throw new Error(`Deterministic YRC timeline must end at 18000ms, got ${timelineEnd}ms`)
  }
  return { timelineEnd }
}

async function verifyAudioContents(contents, recipe, { run }) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'clarus-fixture-inspect-'))
  const copiedFixturePath = join(temporaryDirectory, basename(recipe.filename))
  try {
    await writeFile(copiedFixturePath, contents)
    const inspected = await inspectAudioFile({
      channels: recipe.channels,
      codec: recipe.codec,
      filePath: copiedFixturePath,
      run,
      sampleRateHz: recipe.sampleRateHz,
    })
    if (recipe.codec === 'mp3') {
      const difference = Math.abs(inspected.durationSeconds - recipe.durationSeconds)
      if (difference > 0.1) {
        throw new Error(
          `MP3 duration is ${inspected.durationSeconds}s; expected ${recipe.durationSeconds}s ±0.10s`,
        )
      }
      if (recipe.expectedSeekMarkersSeconds.length > 0) {
        analyzeSeekMarkers(inspected.decoded, recipe.expectedSeekMarkersSeconds)
      }
    }
    if (recipe.codec === 'flac') {
      const expectedFrames = recipe.durationSeconds * recipe.sampleRateHz
      if (Math.abs(inspected.decoded.frameCount - expectedFrames) > 1) {
        throw new Error(
          `FLAC decoded frame count is ${inspected.decoded.frameCount}; expected ${expectedFrames} ±1 sample`,
        )
      }
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

function closeHandles(handles) {
  return Promise.all(handles.map((handle) => handle.close().catch(() => {})))
}

function assertFixtureDirectoryEntries(entries, lock) {
  const expectedNames = new Set([LOCK_FILENAME, ...lock.files.map((file) => file.filename)])
  const actualNames = new Set(entries.map((entry) => entry.name))
  const unexpected = [...actualNames].filter((name) => !expectedNames.has(name))
  const missing = [...expectedNames].filter((name) => !actualNames.has(name))
  if (unexpected.length > 0 || missing.length > 0 || actualNames.size !== expectedNames.size) {
    throw new Error(
      `Fixture directory must contain exactly the locked set (unexpected: ${unexpected.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`,
    )
  }
}

export function validateFixtureLock(lock, recipeManifest) {
  const manifest = validateRecipeManifest(recipeManifest)
  assertPlainObject(lock, 'fixture lock')
  assertExactKeys(lock, LOCK_KEYS, 'fixture lock')
  if (lock.schemaVersion !== manifest.schemaVersion) {
    throw new Error(`fixture lock schemaVersion must be ${manifest.schemaVersion}`)
  }
  if (lock.recipeVersion !== manifest.generatorVersion) {
    throw new Error(`fixture lock recipeVersion must be ${manifest.generatorVersion}`)
  }
  if (!Array.isArray(lock.encoders) || lock.encoders.length !== EXPECTED_ENCODERS.length) {
    throw new Error('fixture lock must contain exactly the two required encoders')
  }

  const normalizedEncoders = lock.encoders.map((encoder, index) => {
    assertPlainObject(encoder, 'fixture lock encoder')
    assertExactKeys(encoder, LOCK_ENCODER_KEYS, 'fixture lock encoder')
    const expected = EXPECTED_ENCODERS[index]
    if (!expected || encoder.codec !== expected.codec || encoder.name !== expected.name) {
      throw new Error('fixture lock encoder does not match the required codec and name')
    }
    if (!valuesMatch(encoder.settings, expected.settings)) {
      throw new Error(`fixture lock ${encoder.codec} encoder settings are not fixed and canonical`)
    }
    assertNormalizedVersion(encoder.version, `fixture lock ${encoder.codec} encoder version`)
    if (encoder.codec === 'mp3' && encoder.version !== '4.0') {
      throw new Error('fixture lock must record Homebrew LAME version 4.0 exactly')
    }
    return { ...encoder, settings: [...encoder.settings] }
  })

  if (!Array.isArray(lock.files)) {
    throw new Error('fixture lock files must be an array')
  }
  const recipesByRole = new Map(manifest.recipes.map((recipe) => [recipe.role, recipe]))
  const seenRoles = new Set()
  const normalizedFiles = []
  for (const [index, file] of lock.files.entries()) {
    assertPlainObject(file, 'fixture lock file')
    assertExactKeys(file, LOCK_FILE_KEYS, 'fixture lock file')
    const expectedRecipe = manifest.recipes[index]
    if (!expectedRecipe || file.role !== expectedRecipe.role || !recipesByRole.has(file.role)) {
      throw new Error(`fixture lock has an unexpected role at position ${index}`)
    }
    if (seenRoles.has(file.role)) {
      throw new Error(`fixture lock has duplicate role: ${file.role}`)
    }
    seenRoles.add(file.role)
    if (!isSafeRelativeFilename(file.filename)) {
      throw new Error(`fixture lock role ${file.role} must use a safe relative filename`)
    }
    if (file.filename !== expectedRecipe.filename) {
      throw new Error(`fixture lock role ${file.role} has an unexpected filename`)
    }
    if (!Number.isSafeInteger(file.byteLength) || file.byteLength <= 0) {
      throw new Error(`fixture lock role ${file.role} must have a positive byteLength`)
    }
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`fixture lock role ${file.role} must have a lowercase SHA-256 hash`)
    }
    normalizedFiles.push({ ...file })
  }

  const missingRoles = FIXTURE_ROLES.filter((role) => !seenRoles.has(role))
  if (missingRoles.length > 0 || lock.files.length !== FIXTURE_ROLES.length) {
    throw new Error(`fixture lock is missing roles: ${missingRoles.join(', ')}`)
  }
  return {
    encoders: normalizedEncoders,
    files: normalizedFiles,
    recipeVersion: lock.recipeVersion,
    schemaVersion: lock.schemaVersion,
  }
}

export async function verifyFixtureSet({
  directory,
  recipeManifestPath = DEFAULT_RECIPE_MANIFEST_PATH,
  retainFileHandles = false,
  run = runProcess,
} = {}) {
  const resolvedDirectory = await resolveFixtureDirectory(directory)
  const retainedHandles = []
  try {
    const manifest = await readRecipeManifest(recipeManifestPath)
    const lockPath = join(resolvedDirectory, LOCK_FILENAME)
    const lock = validateFixtureLock(await readJsonNoFollow(lockPath, 'fixture lock'), manifest)
    assertFixtureDirectoryEntries(await readdir(resolvedDirectory, { withFileTypes: true }), lock)
    const recipesByRole = new Map(manifest.recipes.map((recipe) => [recipe.role, recipe]))
    const filesByName = new Map()

    for (const lockFile of lock.files) {
      const fixturePath = resolveFixturePath(resolvedDirectory, lockFile.filename)
      const handle = await openNoFollowRegularFile(fixturePath, `fixture file ${lockFile.filename}`)
      let retained = false
      try {
        const fixtureStat = await handle.stat()
        if (fixtureStat.size !== lockFile.byteLength) {
          throw new Error(
            `Fixture byte size mismatch for ${lockFile.filename}: expected ${lockFile.byteLength}, got ${fixtureStat.size}`,
          )
        }
        const contents = await handle.readFile()
        if (contents.byteLength !== lockFile.byteLength) {
          throw new Error(`Fixture byte size changed while reading: ${lockFile.filename}`)
        }
        if (sha256(contents) !== lockFile.sha256) {
          throw new Error(`Fixture SHA-256 mismatch for ${lockFile.filename}`)
        }

        const recipe = recipesByRole.get(lockFile.role)
        if (recipe.codec === 'yrc') {
          verifyDeterministicYrc(contents)
        } else {
          await verifyAudioContents(contents, recipe, { run })
        }
        const fixture = {
          ...lockFile,
          path: fixturePath,
          recipe,
        }
        if (retainFileHandles) {
          fixture.fileHandle = handle
          retainedHandles.push(handle)
          retained = true
        }
        filesByName.set(lockFile.filename, fixture)
      } finally {
        if (!retained) {
          await handle.close()
        }
      }
    }

    let closed = false
    return {
      close: async () => {
        if (!closed) {
          closed = true
          await closeHandles(retainedHandles)
        }
      },
      directory: resolvedDirectory,
      filesByName,
      lock,
      manifest,
    }
  } catch (error) {
    await closeHandles(retainedHandles)
    throw error
  }
}
