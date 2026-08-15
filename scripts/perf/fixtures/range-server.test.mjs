import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { URL } from 'node:url'
import { inflateSync } from 'node:zlib'

import { CANONICAL_FIXTURE_ROOT, LOCK_FILENAME } from './fixture-spec.mjs'
import { generateFixtures } from './fixture-generator.mjs'
import {
  PERFORMANCE_IMAGE_MAX_CACHE_BYTES,
  PERFORMANCE_IMAGE_MAX_DIMENSION,
  createFixtureRangeServer,
} from './range-server.mjs'

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

function pngDimensions(body) {
  assert.deepEqual(body.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'))
  let offset = 8
  let width
  let height
  const idat = []
  while (offset < body.byteLength) {
    const length = body.readUInt32BE(offset)
    const type = body.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    assert.ok(dataEnd + 4 <= body.byteLength, `PNG ${type} chunk is truncated`)
    const data = body.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      assert.equal(length, 13)
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      assert.equal(data[8], 8)
      assert.equal(data[9], 6)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      assert.equal(length, 0)
      assert.equal(dataEnd + 4, body.byteLength)
      break
    }
    offset = dataEnd + 4
  }
  assert.ok(Number.isSafeInteger(width) && width > 0)
  assert.ok(Number.isSafeInteger(height) && height > 0)
  const decoded = inflateSync(Buffer.concat(idat))
  assert.equal(decoded.byteLength, (width * 4 + 1) * height)
  for (let row = 0; row < height; row += 1) {
    assert.equal(decoded[row * (width * 4 + 1)], 0)
  }
  return { height, width }
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
    const metrics = fixtureServer.metrics.snapshot()
    assert.equal(metrics.activeRequests, 0)
    assert.ok(metrics.totalRequests >= 10)
    assert.ok(metrics.failedRequests >= 4)
    assert.ok(metrics.rangeRequests >= 4)
    assert.ok(metrics.bytesSent >= source.byteLength)
  } finally {
    await fixtureServer.close()
  }

  assert.equal(fixtureServer.server.listening, false)
  await assert.rejects(() => requestFixture(fixtureServer.baseUrl, { path: `/${target.filename}` }))
  await fixtureServer.close()
})

test('performance image fixtures use the requested dimensions and a canonical bounded cache key', async () => {
  const directory = await realSetDirectory()
  const fixtureServer = await createFixtureRangeServer({ directory })
  const pathname = '/clarus-perf/album/42/0.png'
  try {
    const first = await requestFixture(fixtureServer.baseUrl, {
      path: `${pathname}?param=64y32`,
    })
    assert.equal(first.statusCode, 200)
    assert.equal(first.headers['content-type'], 'image/png')
    assert.equal(first.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.equal(first.headers['content-length'], String(first.body.byteLength))
    assert.deepEqual(pngDimensions(first.body), { height: 32, width: 64 })

    const xAlias = await requestFixture(fixtureServer.baseUrl, {
      path: `${pathname}?param=64x32`,
    })
    assert.equal(xAlias.statusCode, 200)
    assert.deepEqual(xAlias.body, first.body)

    const retry = await requestFixture(fixtureServer.baseUrl, {
      path: `${pathname}?param=64y32&clarus_retry=1`,
    })
    assert.equal(retry.statusCode, 200)
    assert.deepEqual(retry.body, first.body)

    const differentlySized = await requestFixture(fixtureServer.baseUrl, {
      path: `${pathname}?param=32y64`,
    })
    assert.equal(differentlySized.statusCode, 200)
    assert.deepEqual(pngDimensions(differentlySized.body), { height: 64, width: 32 })
    assert.notDeepEqual(differentlySized.body, first.body)

    const differentArtwork = await requestFixture(fixtureServer.baseUrl, {
      path: '/clarus-perf/album/42/1.png?param=64y32',
    })
    assert.equal(differentArtwork.statusCode, 200)
    assert.notDeepEqual(differentArtwork.body, first.body)

    const metrics = fixtureServer.metrics.snapshot()
    const firstKey = `${pathname}?param=64x32`
    assert.deepEqual(metrics.byFilename[firstKey], {
      bytesSent: first.body.byteLength * 3,
      failures: 0,
      requests: 3,
    })
    assert.deepEqual(metrics.byCacheKey[firstKey], metrics.byFilename[firstKey])
    assert.equal(metrics.byCacheKey[`${pathname}?param=32x64`]?.requests, 1)
    assert.equal(metrics.byCacheKey['/clarus-perf/album/42/1.png?param=64x32']?.requests, 1)
    assert.equal(metrics.performanceImageCache?.entries, 3)
    assert.equal(metrics.performanceImageCache?.hits, 2)
    assert.equal(metrics.performanceImageCache?.misses, 3)
    assert.ok(
      (metrics.performanceImageCache?.bytes ?? Infinity) <= PERFORMANCE_IMAGE_MAX_CACHE_BYTES,
    )
  } finally {
    await fixtureServer.close()
  }
})

test('performance image fixtures reject missing, malformed, and over-limit dimensions before generation', async () => {
  const directory = await realSetDirectory()
  const fixtureServer = await createFixtureRangeServer({ directory })
  const pathname = '/clarus-perf/cover.png'
  const invalidPaths = [
    pathname,
    `${pathname}?param=`,
    `${pathname}?param=0y1`,
    `${pathname}?param=1y0`,
    `${pathname}?param=-1y1`,
    `${pathname}?param=1.5y1`,
    `${pathname}?param=1z1`,
    `${pathname}?param=1y1&param=2y2`,
    `${pathname}?param=${PERFORMANCE_IMAGE_MAX_DIMENSION + 1}y1`,
    `${pathname}?param=1y${PERFORMANCE_IMAGE_MAX_DIMENSION + 1}`,
    // Both axes meet the dimension cap, but the conservative aggregate
    // allocation estimate exceeds the generation-memory cap.
    `${pathname}?param=${PERFORMANCE_IMAGE_MAX_DIMENSION}y${PERFORMANCE_IMAGE_MAX_DIMENSION}`,
  ]
  try {
    for (const path of invalidPaths) {
      const response = await requestFixture(fixtureServer.baseUrl, { path })
      assert.equal(response.statusCode, 400, path)
      assert.equal(response.headers['cache-control'], 'no-store', path)
      assert.equal(response.headers['content-length'], '0', path)
      assert.equal(response.body.byteLength, 0, path)
    }

    const atDimensionLimit = await requestFixture(fixtureServer.baseUrl, {
      path: `${pathname}?param=${PERFORMANCE_IMAGE_MAX_DIMENSION}y1`,
    })
    assert.equal(atDimensionLimit.statusCode, 200)
    assert.deepEqual(pngDimensions(atDimensionLimit.body), {
      height: 1,
      width: PERFORMANCE_IMAGE_MAX_DIMENSION,
    })

    const metrics = fixtureServer.metrics.snapshot()
    assert.equal(metrics.failedRequests, invalidPaths.length)
    assert.equal(metrics.performanceImageCache?.entries, 1)
    assert.equal(metrics.performanceImageCache?.hits, 0)
    assert.equal(metrics.performanceImageCache?.misses, 1)
  } finally {
    await fixtureServer.close()
  }
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
