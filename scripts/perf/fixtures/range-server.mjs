import { createServer } from 'node:http'

import { verifyFixtureSet } from './fixture-verifier.mjs'

function requestedFilename(requestUrl) {
  const rawPath = (requestUrl ?? '/').split('?')[0]
  if (!rawPath.startsWith('/')) {
    return null
  }

  let decodedPath
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  const filename = decodedPath.slice(1)
  if (
    filename.length === 0 ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0') ||
    filename === '.' ||
    filename === '..'
  ) {
    return null
  }
  return filename
}

export function parseByteRange(rangeHeader, size) {
  if (typeof rangeHeader !== 'string' || rangeHeader.includes(',')) {
    return null
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
  if (!match || (match[1].length === 0 && match[2].length === 0)) {
    return null
  }

  const [, startText, endText] = match
  const toSafeInteger = (value) => {
    if (value.length === 0 || !/^\d+$/.test(value)) {
      return null
    }
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }

  if (startText.length === 0) {
    const suffixLength = toSafeInteger(endText)
    if (suffixLength === null || suffixLength === 0) {
      return null
    }
    return {
      end: size - 1,
      start: Math.max(0, size - suffixLength),
    }
  }

  const start = toSafeInteger(startText)
  if (start === null || start >= size) {
    return null
  }
  if (endText.length === 0) {
    return { end: size - 1, start }
  }

  const requestedEnd = toSafeInteger(endText)
  if (requestedEnd === null || requestedEnd < start) {
    return null
  }
  return { end: Math.min(size - 1, requestedEnd), start }
}

function endNotFound(response) {
  response.writeHead(404, { 'Content-Length': '0' })
  response.end()
}

function endRangeNotSatisfiable(response, size) {
  response.writeHead(416, {
    'Accept-Ranges': 'bytes',
    'Content-Length': '0',
    'Content-Range': `bytes */${size}`,
  })
  response.end()
}

function serveFile(request, response, fixture) {
  const { recipe } = fixture
  const rangeHeader = request.headers.range
  const range =
    rangeHeader === undefined ? undefined : parseByteRange(rangeHeader, fixture.byteLength)
  if (rangeHeader !== undefined && range === null) {
    endRangeNotSatisfiable(response, fixture.byteLength)
    return
  }

  const start = range?.start ?? 0
  const end = range?.end ?? fixture.byteLength - 1
  const contentLength = end - start + 1
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(contentLength),
    'Content-Type': recipe.mimeType,
  }
  if (range) {
    headers['Content-Range'] = `bytes ${start}-${end}/${fixture.byteLength}`
  }

  response.writeHead(range ? 206 : 200, headers)
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  if (!fixture.fileHandle || typeof fixture.fileHandle.createReadStream !== 'function') {
    response.destroy(new Error('Verified fixture file handle is unavailable'))
    return
  }

  const stream = fixture.fileHandle.createReadStream({ autoClose: false, end, start })
  stream.on('error', () => {
    response.destroy()
  })
  stream.pipe(response)
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host, port })
  })
}

function closeServer(server) {
  if (!server.listening) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

export async function createFixtureRangeServer({
  directory,
  host = '127.0.0.1',
  port = 0,
  recipeManifestPath,
} = {}) {
  if (host !== '127.0.0.1') {
    throw new Error('Fixture range server must bind only to 127.0.0.1')
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Fixture range server port must be an integer from 0 to 65535')
  }

  const verifiedFixtureSet = await verifyFixtureSet({
    directory,
    recipeManifestPath,
    retainFileHandles: true,
  })
  let server
  let closePromise
  try {
    server = createServer((request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': '0' })
        response.end()
        return
      }

      const filename = requestedFilename(request.url)
      const fixture = filename ? verifiedFixtureSet.filesByName.get(filename) : undefined
      if (!fixture) {
        endNotFound(response)
        return
      }
      serveFile(request, response, fixture)
    })
    await listen(server, host, port)
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Fixture range server did not receive a TCP address')
    }

    const close = () => {
      if (!closePromise) {
        closePromise = closeServer(server).finally(() => verifiedFixtureSet.close())
      }
      return closePromise
    }
    return {
      baseUrl: `http://${host}:${address.port}`,
      close,
      server,
      verifiedFixtureSet,
    }
  } catch (error) {
    await closeServer(server ?? { listening: false }).catch(() => {})
    await verifiedFixtureSet.close().catch(() => {})
    throw error
  }
}
