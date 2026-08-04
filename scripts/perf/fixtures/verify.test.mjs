import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, test } from 'node:test'

import {
  CANONICAL_FIXTURE_ROOT,
  LOCK_FILENAME,
  buildDeterministicYrc,
  buildPcmWav,
  sha256,
} from './fixture-spec.mjs'
import { generateFixtures } from './fixture-generator.mjs'
import {
  validateFixtureLock,
  verifyDeterministicYrc,
  verifyFixtureSet,
  AFCONVERT_EXECUTABLE,
  AFINFO_EXECUTABLE,
  inspectAudioFile,
} from './fixture-verifier.mjs'

const temporaryDirectories = []
let realSetPromise

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function makeFixtureScope(label) {
  await mkdir(CANONICAL_FIXTURE_ROOT, { recursive: true })
  const directory = await mkdtemp(join(CANONICAL_FIXTURE_ROOT, `.r3-verify-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

async function copyCompleteSet(sourceDirectory, targetDirectory) {
  const lock = JSON.parse(await readFile(join(sourceDirectory, LOCK_FILENAME), 'utf8'))
  await mkdir(targetDirectory)
  for (const name of [LOCK_FILENAME, ...lock.files.map((file) => file.filename)]) {
    await copyFile(join(sourceDirectory, name), join(targetDirectory, name))
  }
}

async function realSetDirectory() {
  if (!realSetPromise) {
    realSetPromise = (async () => {
      const scope = await makeFixtureScope('real')
      const directory = join(scope, 'fixture-set')
      await generateFixtures({ outputDirectory: directory })
      return directory
    })()
  }
  return realSetPromise
}

async function clonedRealSet(label) {
  const scope = await makeFixtureScope(label)
  const directory = join(scope, 'fixture-set')
  await copyCompleteSet(await realSetDirectory(), directory)
  return directory
}

test('the verifier accepts a complete real fixture set and a strict path-free encoder lock', async () => {
  const verified = await verifyFixtureSet({ directory: await realSetDirectory() })
  assert.equal(verified.filesByName.size, 5)
  assert.deepEqual(
    verified.lock.encoders.map((encoder) => [encoder.codec, encoder.name, encoder.version]),
    [
      ['mp3', 'lame', '4.0'],
      ['flac', 'afconvert', '2.0'],
    ],
  )
  assert.deepEqual(verified.lock.encoders[0].settings, ['--cbr', '-b', '128', '--noreplaygain'])
  assert.equal(JSON.stringify(verified.lock).includes('/opt/homebrew'), false)
  assert.equal(JSON.stringify(verified.lock).includes('/usr/bin'), false)
})

test('verification rejects an outside absolute directory before it reads a lock', async () => {
  await assert.rejects(
    () => verifyFixtureSet({ directory: tmpdir() }),
    /strict child.*canonical fixture root/i,
  )
})

test('wrong lock byte length is rejected before a SHA comparison', async () => {
  const directory = await clonedRealSet('wrong-size')
  const lockPath = join(directory, LOCK_FILENAME)
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  lock.files[0].byteLength += 1
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

  await assert.rejects(() => verifyFixtureSet({ directory }), /byte size mismatch/i)
})

test('a locked fixture that is missing from the directory is rejected', async () => {
  const directory = await clonedRealSet('missing-fixture')
  const lock = JSON.parse(await readFile(join(directory, LOCK_FILENAME), 'utf8'))
  await unlink(join(directory, lock.files[0].filename))

  await assert.rejects(() => verifyFixtureSet({ directory }), /locked set.*missing/i)
})

test('a lock file that duplicates an existing fixture role is rejected', async () => {
  const directory = await clonedRealSet('duplicate-role')
  const lockPath = join(directory, LOCK_FILENAME)
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  lock.files[1].role = lock.files[0].role
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

  await assert.rejects(() => verifyFixtureSet({ directory }), /(unexpected|duplicate) role/i)
})

test('an unsafe locked fixture filename is rejected before filesystem access', async () => {
  const directory = await clonedRealSet('unsafe-filename')
  const lockPath = join(directory, LOCK_FILENAME)
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  lock.files[0].filename = '../outside.mp3'
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

  await assert.rejects(() => verifyFixtureSet({ directory }), /safe relative filename/i)
})

test('same-size fixture corruption is rejected by SHA-256', async () => {
  const directory = await clonedRealSet('sha')
  const lock = JSON.parse(await readFile(join(directory, LOCK_FILENAME), 'utf8'))
  const filename = lock.files[0].filename
  const fixturePath = join(directory, filename)
  const contents = await readFile(fixturePath)
  const corrupted = Buffer.from(contents)
  corrupted[corrupted.byteLength - 1] ^= 1
  await writeFile(fixturePath, corrupted)

  await assert.rejects(() => verifyFixtureSet({ directory }), /SHA-256 mismatch/i)
})

test('fake header bytes cannot pass real audio verification even when lock hashes match', async () => {
  const directory = await clonedRealSet('fake-header')
  const lockPath = join(directory, LOCK_FILENAME)
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  const file = lock.files.find((entry) => entry.role === 'tone-short-mp3')
  const fakeMp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x01, 0x02, 0x03, 0x04])
  await writeFile(join(directory, file.filename), fakeMp3)
  file.byteLength = fakeMp3.byteLength
  file.sha256 = sha256(fakeMp3)
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

  await assert.rejects(
    () => verifyFixtureSet({ directory }),
    /afinfo could not identify|afinfo did not report|unexpected mp3/i,
  )
})

test('audio inspection invokes fixed tools with shell disabled and a controlled environment', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'clarus-audio-inspect-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const inputPath = join(temporary, 'fixture.mp3')
  await writeFile(inputPath, Buffer.from('fixture'))
  const decoded = buildPcmWav({
    channels: 2,
    durationSeconds: 1,
    expectedSeekMarkersSeconds: [],
    sampleRateHz: 44100,
  })
  const calls = []
  const inspected = await inspectAudioFile({
    channels: 2,
    codec: 'mp3',
    filePath: inputPath,
    sampleRateHz: 44100,
    run: async (executable, argv, options) => {
      calls.push({ executable, argv, options })
      if (executable === AFINFO_EXECUTABLE) {
        return {
          stdout: 'File type ID: mpg3\nData format: 2 ch, 44100 Hz\nestimated duration: 1 sec\n',
          stderr: '',
        }
      }
      assert.equal(executable, AFCONVERT_EXECUTABLE)
      await writeFile(argv.at(-1), decoded)
      return { stdout: '', stderr: '' }
    },
  })
  assert.equal(inspected.channels, 2)
  assert.deepEqual(calls.map(({ executable, argv }) => [executable, argv]), [
    [AFINFO_EXECUTABLE, [inputPath]],
    [AFCONVERT_EXECUTABLE, ['-f', 'WAVE', '-d', 'LEI16@44100', inputPath, calls[1]?.argv.at(-1)]],
  ])
  for (const call of calls) {
    assert.equal(call.options.shell, false)
    assert.deepEqual(call.options.env, { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' })
  }
})

test('lock, fixture, and fixture-directory symlinks are rejected without following them', async () => {
  const directory = await clonedRealSet('symlink')
  const lockPath = join(directory, LOCK_FILENAME)
  const savedLockPath = join(directory, 'saved-lock.json')
  await rename(lockPath, savedLockPath)
  await symlink(basename(savedLockPath), lockPath)
  try {
    await assert.rejects(() => verifyFixtureSet({ directory }), /fixture lock.*symbolic link/i)
  } finally {
    await unlink(lockPath)
    await rename(savedLockPath, lockPath)
  }

  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  const fixturePath = join(directory, lock.files[0].filename)
  const savedFixturePath = join(dirname(directory), 'saved-fixture.mp3')
  await rename(fixturePath, savedFixturePath)
  await symlink(`../${basename(savedFixturePath)}`, fixturePath)
  try {
    await assert.rejects(() => verifyFixtureSet({ directory }), /fixture file.*symbolic link/i)
  } finally {
    await unlink(fixturePath)
    await rename(savedFixturePath, fixturePath)
  }

  const savedDirectory = join(dirname(directory), 'saved-fixture-set')
  await rename(directory, savedDirectory)
  await symlink(basename(savedDirectory), directory)
  try {
    await assert.rejects(
      () => verifyFixtureSet({ directory }),
      /fixture directory component.*symbolic link/i,
    )
  } finally {
    await unlink(directory)
    await rename(savedDirectory, directory)
  }
})

test('YRC content is exact deterministic bytes with an 18000ms timeline', () => {
  assert.deepEqual(verifyDeterministicYrc(Buffer.from(buildDeterministicYrc())), {
    timelineEnd: 18000,
  })
  assert.throws(
    () => verifyDeterministicYrc(Buffer.from('[0,1](0,1,0)x\n')),
    /deterministic canonical content/i,
  )
})

test('strict locks reject path-bearing encoder metadata independently of files', async () => {
  const verified = await verifyFixtureSet({ directory: await realSetDirectory() })
  const lock = JSON.parse(JSON.stringify(verified.lock))
  lock.encoders[1].version = '/usr/bin/afconvert 2.0'
  assert.throws(
    () => validateFixtureLock(lock, verified.manifest),
    /normalized non-path version string/i,
  )
})
