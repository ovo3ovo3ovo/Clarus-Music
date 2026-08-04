import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { URL } from 'node:url'

import { CANONICAL_FIXTURE_ROOT, LOCK_FILENAME } from './fixture-spec.mjs'
import { generateFixtures } from './fixture-generator.mjs'
import { createFixtureRangeServer } from './range-server.mjs'

const temporaryDirectories = []
let realSetPromise

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function makeFixtureScope(label) {
  await mkdir(CANONICAL_FIXTURE_ROOT, { recursive: true })
  const directory = await mkdtemp(join(CANONICAL_FIXTURE_ROOT, `.r3-range-${label}-`))
  temporaryDirectories.push(directory)
  return directory
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

function requestFixture(baseUrl, { headers = {}, method = 'GET', path = '/' } = {}) {
  const serverUrl = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const clientRequest = request(
      {
        headers,
        hostname: serverUrl.hostname,
        method,
        path,
        port: serverUrl.port,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          resolve({
            body: Buffer.concat(chunks),
            headers: response.headers,
            statusCode: response.statusCode,
          })
        })
      },
    )
    clientRequest.on('error', reject)
    clientRequest.end()
  })
}

async function firstMp3(directory) {
  const lock = JSON.parse(await readFile(join(directory, LOCK_FILENAME), 'utf8'))
  return lock.files.find((file) => file.role === 'tone-short-mp3')
}

test('the range server permits only ephemeral 127.0.0.1 listeners', async () => {
  await assert.rejects(
    () =>
      createFixtureRangeServer({
        directory: 'artifacts/perf/fixtures/never-used',
        host: '0.0.0.0',
      }),
    /127\.0\.0\.1/i,
  )
  await assert.rejects(
    () => createFixtureRangeServer({ directory: tmpdir() }),
    /strict child.*canonical fixture root/i,
  )
})

test('the range server preserves the full GET/HEAD and single-range contract', async () => {
  const directory = await realSetDirectory()
  const target = await firstMp3(directory)
  const source = await readFile(join(directory, target.filename))
  const fixtureServer = await createFixtureRangeServer({ directory })
  try {
    assert.match(fixtureServer.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)

    const full = await requestFixture(fixtureServer.baseUrl, { path: `/${target.filename}` })
    assert.equal(full.statusCode, 200)
    assert.equal(full.headers['accept-ranges'], 'bytes')
    assert.equal(full.headers['content-type'], 'audio/mpeg')
    assert.equal(full.headers['content-length'], String(source.byteLength))
    assert.deepEqual(full.body, source)

    const head = await requestFixture(fixtureServer.baseUrl, {
      method: 'HEAD',
      path: `/${target.filename}`,
    })
    assert.equal(head.statusCode, 200)
    assert.equal(head.headers['content-length'], String(source.byteLength))
    assert.equal(head.body.byteLength, 0)

    const closed = await requestFixture(fixtureServer.baseUrl, {
      headers: { range: 'bytes=2-5' },
      path: `/${target.filename}`,
    })
    assert.equal(closed.statusCode, 206)
    assert.equal(closed.headers['content-range'], `bytes 2-5/${source.byteLength}`)
    assert.equal(closed.headers['content-length'], '4')
    assert.deepEqual(closed.body, source.subarray(2, 6))

    const openEnded = await requestFixture(fixtureServer.baseUrl, {
      headers: { range: 'bytes=5-' },
      path: `/${target.filename}`,
    })
    assert.equal(openEnded.statusCode, 206)
    assert.equal(
      openEnded.headers['content-range'],
      `bytes 5-${source.byteLength - 1}/${source.byteLength}`,
    )
    assert.deepEqual(openEnded.body, source.subarray(5))

    const suffix = await requestFixture(fixtureServer.baseUrl, {
      headers: { range: 'bytes=-3' },
      path: `/${target.filename}`,
    })
    assert.equal(suffix.statusCode, 206)
    assert.equal(
      suffix.headers['content-range'],
      `bytes ${source.byteLength - 3}-${source.byteLength - 1}/${source.byteLength}`,
    )
    assert.deepEqual(suffix.body, source.subarray(-3))

    const rangedHead = await requestFixture(fixtureServer.baseUrl, {
      headers: { range: 'bytes=0-2' },
      method: 'HEAD',
      path: `/${target.filename}`,
    })
    assert.equal(rangedHead.statusCode, 206)
    assert.equal(rangedHead.headers['content-range'], `bytes 0-2/${source.byteLength}`)
    assert.equal(rangedHead.body.byteLength, 0)

    for (const range of ['bytes=wat', 'bytes=0-1,3-4', `bytes=${source.byteLength}-`]) {
      const invalid = await requestFixture(fixtureServer.baseUrl, {
        headers: { range },
        path: `/${target.filename}`,
      })
      assert.equal(invalid.statusCode, 416)
      assert.equal(invalid.headers['content-range'], `bytes */${source.byteLength}`)
    }

    const unlisted = await requestFixture(fixtureServer.baseUrl, { path: '/not-in-lock.mp3' })
    assert.equal(unlisted.statusCode, 404)
    const traversal = await requestFixture(fixtureServer.baseUrl, {
      path: `/%2e%2e/${target.filename}`,
    })
    assert.equal(traversal.statusCode, 404)
    const method = await requestFixture(fixtureServer.baseUrl, {
      method: 'POST',
      path: `/${target.filename}`,
    })
    assert.equal(method.statusCode, 405)
  } finally {
    await fixtureServer.close()
  }

  assert.equal(fixtureServer.server.listening, false)
  await assert.rejects(() => requestFixture(fixtureServer.baseUrl, { path: `/${target.filename}` }))
  await fixtureServer.close()
})

test('verified no-follow handles keep serving the original bytes after a pathname becomes a symlink', async () => {
  const directory = await realSetDirectory()
  const target = await firstMp3(directory)
  const fixturePath = join(directory, target.filename)
  const originalContents = await readFile(fixturePath)
  const savedPath = join(directory, 'saved-original.mp3')
  const replacementPath = join(directory, 'replacement.mp3')
  const fixtureServer = await createFixtureRangeServer({ directory })
  await rename(fixturePath, savedPath)
  await writeFile(replacementPath, Buffer.alloc(originalContents.byteLength, 0x55))
  await symlink('replacement.mp3', fixturePath)
  try {
    const response = await requestFixture(fixtureServer.baseUrl, { path: `/${target.filename}` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.body, originalContents)
  } finally {
    await fixtureServer.close()
    await unlink(fixturePath)
    await rename(savedPath, fixturePath)
    await rm(replacementPath, { force: true })
  }
})

test('a listen failure closes its newly verified handles without affecting the active server', async () => {
  const directory = await realSetDirectory()
  const first = await createFixtureRangeServer({ directory })
  const port = Number(new URL(first.baseUrl).port)
  try {
    await assert.rejects(
      () => createFixtureRangeServer({ directory, port }),
      /EADDRINUSE|address already in use/i,
    )
    const target = await firstMp3(directory)
    assert.equal(
      (await requestFixture(first.baseUrl, { method: 'HEAD', path: `/${target.filename}` }))
        .statusCode,
      200,
    )
  } finally {
    await first.close()
  }
})
