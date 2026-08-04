import process from 'node:process'

import { DEFAULT_OUTPUT_DIRECTORY } from './fixture-spec.mjs'

function assertArgumentArray(argumentsList) {
  if (
    !Array.isArray(argumentsList) ||
    argumentsList.some((argument) => typeof argument !== 'string')
  ) {
    throw new Error('CLI arguments must be strings')
  }
}

function parseDirectoryOption(
  argumentsList,
  { allowForce = false, allowPort = false, outputName },
) {
  assertArgumentArray(argumentsList)
  const result =
    outputName === 'outputDirectory'
      ? { force: false, outputDirectory: DEFAULT_OUTPUT_DIRECTORY }
      : { directory: DEFAULT_OUTPUT_DIRECTORY }
  const seenOptions = new Set()

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${argument}`)
    }
    if (seenOptions.has(argument)) {
      throw new Error(`${argument} may only be provided once`)
    }
    seenOptions.add(argument)

    if (allowForce && argument === '--force') {
      result.force = true
      continue
    }
    if (argument === '--output' || argument === '--directory') {
      const expectedOption = outputName === 'outputDirectory' ? '--output' : '--directory'
      if (argument !== expectedOption) {
        throw new Error(`Unknown option: ${argument}`)
      }
      const value = argumentsList[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`)
      }
      result[outputName] = value
      index += 1
      continue
    }
    if (allowPort && argument === '--port') {
      const value = argumentsList[index + 1]
      if (!value || !/^\d+$/.test(value)) {
        throw new Error('--port requires an integer from 0 to 65535')
      }
      const port = Number(value)
      if (!Number.isSafeInteger(port) || port > 65535) {
        throw new Error('--port requires an integer from 0 to 65535')
      }
      result.port = port
      index += 1
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }

  return result
}

export function parseGenerateArguments(argumentsList) {
  return parseDirectoryOption(argumentsList, { allowForce: true, outputName: 'outputDirectory' })
}

export function parseVerifyArguments(argumentsList) {
  return parseDirectoryOption(argumentsList, { outputName: 'directory' })
}

export function parseServeArguments(argumentsList) {
  const parsed = parseDirectoryOption(argumentsList, { allowPort: true, outputName: 'directory' })
  return { ...parsed, port: parsed.port ?? 0 }
}

export function installGracefulShutdown({
  close,
  onClosed = () => {},
  onError = () => {},
  signalSource = process,
} = {}) {
  if (typeof close !== 'function') {
    throw new Error('Graceful shutdown requires a close function')
  }
  if (
    !signalSource ||
    typeof signalSource.once !== 'function' ||
    typeof signalSource.off !== 'function'
  ) {
    throw new Error('Graceful shutdown requires an EventEmitter-like signal source')
  }

  let closing
  let resolveClosed
  let rejectClosed
  const closed = new Promise((resolve, reject) => {
    resolveClosed = resolve
    rejectClosed = reject
  })
  const removeListeners = () => {
    signalSource.off('SIGINT', onSignal)
    signalSource.off('SIGTERM', onSignal)
  }
  const beginClose = () => {
    if (!closing) {
      closing = Promise.resolve()
        .then(close)
        .then(onClosed)
        .then(() => {
          removeListeners()
          resolveClosed()
        })
        .catch((error) => {
          removeListeners()
          onError(error)
          rejectClosed(error)
        })
    }
    return closing
  }
  const onSignal = () => {
    void beginClose()
  }

  signalSource.once('SIGINT', onSignal)
  signalSource.once('SIGTERM', onSignal)
  return {
    close: beginClose,
    closed,
    dispose: removeListeners,
  }
}
