import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

export const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
export const PERFORMANCE_ROOT = resolve(REPOSITORY_ROOT, 'artifacts', 'perf')
export const RUNS_ROOT = resolve(PERFORMANCE_ROOT, 'runs')
export const SUMMARIES_ROOT = resolve(PERFORMANCE_ROOT, 'summaries')
export const METADATA_MAX_BYTES = 16 * 1024

export class PerfInputError extends Error {
  constructor(message, code = 'INPUT_REFUSAL') {
    super(message)
    this.code = code
    this.name = 'PerfInputError'
  }
}

function inputError(message, code) {
  throw new PerfInputError(message, code)
}

function assertArgumentList(argumentsList) {
  if (
    !Array.isArray(argumentsList) ||
    argumentsList.some((argument) => typeof argument !== 'string')
  ) {
    inputError('CLI arguments must be strings')
  }
}

function parseDecimal(value, label, { minimum, maximum } = {}) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    inputError(`${label} must be a decimal integer`)
  }
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric)) {
    inputError(`${label} must be a safe integer`)
  }
  if (minimum !== undefined && numeric < minimum) {
    inputError(`${label} must be at least ${minimum}`)
  }
  if (maximum !== undefined && numeric > maximum) {
    inputError(`${label} must be no greater than ${maximum}`)
  }
  return numeric
}

function parseKnownOptions(argumentsList, specification) {
  assertArgumentList(argumentsList)
  const values = new Map()
  const rawArguments = [...argumentsList]
  for (let index = 0; index < argumentsList.length; index += 1) {
    const option = argumentsList[index]
    if (!option.startsWith('--')) {
      inputError(`Unexpected positional argument: ${option}`)
    }
    if (option.includes('=')) {
      inputError(`--key=value syntax is not supported: ${option}`)
    }
    const definition = specification[option]
    if (!definition) {
      inputError(`Unknown option: ${option}`)
    }
    const prior = values.get(option)
    if (prior && !definition.repeatable) {
      inputError(`${option} is a duplicate option and may only be provided once`)
    }
    const value = argumentsList[index + 1]
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      inputError(`${option} requires a value`)
    }
    const entries = prior ?? []
    entries.push(value)
    values.set(option, entries)
    index += 1
  }
  for (const [option, definition] of Object.entries(specification)) {
    if (definition.required && !values.has(option)) {
      inputError(`${option} is required`)
    }
  }
  return { rawArguments, values }
}

function singleValue(values, option, defaultValue) {
  const entries = values.get(option)
  return entries ? entries[0] : defaultValue
}

export function parseSampleArguments(argumentsList) {
  const { rawArguments, values } = parseKnownOptions(argumentsList, {
    '--app-bundle': { required: true },
    '--root-pid': { required: true },
    '--fixture-directory': { required: true },
    '--metadata': { required: true },
    '--output': { required: true },
    '--samples': { required: true },
    '--interval-ms': { required: true },
    '--stack-duration-seconds': { required: false },
    '--stack-interval-ms': { required: false },
  })
  const rootPid = parseDecimal(singleValue(values, '--root-pid'), '--root-pid', { minimum: 2 })
  const samples = parseDecimal(singleValue(values, '--samples'), '--samples', {
    minimum: 5,
    maximum: 3600,
  })
  const intervalMs = parseDecimal(singleValue(values, '--interval-ms'), '--interval-ms', {
    minimum: 1000,
    maximum: 60000,
  })
  if (samples * intervalMs > 3600000) {
    inputError('--samples × --interval-ms must be no greater than 3600000')
  }
  if (intervalMs % 1000 !== 0) {
    inputError('--interval-ms must be a whole number of seconds on macOS')
  }
  const stackDurationSeconds = parseDecimal(
    singleValue(values, '--stack-duration-seconds', '0'),
    '--stack-duration-seconds',
    { minimum: 0, maximum: 60 },
  )
  const stackIntervalMs = parseDecimal(
    singleValue(values, '--stack-interval-ms', '1'),
    '--stack-interval-ms',
    { minimum: 1, maximum: 1000 },
  )
  return {
    appBundle: singleValue(values, '--app-bundle'),
    rootPid,
    fixtureDirectory: singleValue(values, '--fixture-directory'),
    metadata: singleValue(values, '--metadata'),
    output: singleValue(values, '--output'),
    samples,
    intervalMs,
    stackDurationSeconds,
    stackIntervalMs,
    rawArguments,
  }
}

export function parseSummarizeArguments(argumentsList) {
  const { rawArguments, values } = parseKnownOptions(argumentsList, {
    '--input': { required: true, repeatable: true },
    '--output': { required: true },
  })
  const inputs = values.get('--input')
  if (inputs.length < 1 || inputs.length > 1000) {
    inputError('--input must be provided from one to 1000 times')
  }
  const seen = new Set()
  for (const input of inputs) {
    if (seen.has(input)) {
      inputError('--input values must be distinct')
    }
    seen.add(input)
  }
  return {
    inputs: [...inputs],
    output: singleValue(values, '--output'),
    rawArguments,
  }
}

function assertUnambiguousPathText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    inputError(`${label} must be a non-empty path`)
  }
  if (value.includes('\\')) {
    inputError(`${label} must not contain backslash path separators`)
  }
  if (value.split('/').some((component) => component === '..')) {
    inputError(`${label} must not contain parent-directory traversal`)
  }
  if (win32.isAbsolute(value) && !isAbsolute(value)) {
    inputError(`${label} must be under the required root`)
  }
}

function isStrictChild(root, candidate) {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot.length > 0 &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot) &&
    !win32.isAbsolute(fromRoot)
  )
}

export function resolveStrictChildPath(requested, { root, repositoryRoot = REPOSITORY_ROOT } = {}) {
  assertUnambiguousPathText(requested, 'Path')
  if (typeof root !== 'string' || root.length === 0 || typeof repositoryRoot !== 'string') {
    inputError('Strict child resolution requires a root and repository root')
  }
  const resolvedRoot = resolve(root)
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(repositoryRoot, requested)
  if (!isStrictChild(resolvedRoot, candidate)) {
    inputError('Path must be a strict child of the required root')
  }
  return candidate
}

async function assertNoSymlinkPathComponents(pathname, repositoryRoot, label, filesystem) {
  const absolutePath = resolve(pathname)
  const scopedRoot = resolve(repositoryRoot)
  let current = scopedRoot
  const components = relative(scopedRoot, absolutePath).split(sep).filter(Boolean)
  for (const component of components) {
    current = resolve(current, component)
    const details = await inspectPath(current, filesystem)
    if (details?.isSymbolicLink()) {
      inputError(`${label} must not traverse symbolic link components`)
    }
    if (!details) {
      break
    }
  }
}

export async function resolveStrictNoFollowChildPath(
  requested,
  { root, repositoryRoot = REPOSITORY_ROOT, label = 'Path', filesystem = { lstat } } = {},
) {
  assertUnambiguousPathText(requested, label)
  if (isAbsolute(requested) || win32.isAbsolute(requested)) {
    inputError(`${label} must be a relative path`)
  }
  const candidate = resolveStrictChildPath(requested, { root, repositoryRoot })
  await assertNoSymlinkPathComponents(candidate, repositoryRoot, label, filesystem)
  return candidate
}

async function inspectPath(pathname, filesystem = { lstat }) {
  try {
    return await filesystem.lstat(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

async function assertExistingDirectory(pathname, label, filesystem) {
  const details = await inspectPath(pathname, filesystem)
  if (!details) {
    inputError(`${label} does not exist`)
  }
  if (details.isSymbolicLink()) {
    inputError(`${label} must not be a symbolic link`)
  }
  if (!details.isDirectory()) {
    inputError(`${label} must be a directory`)
  }
  return details
}

async function makeDirectoryNoFollow(pathname, label, filesystem) {
  const existing = await inspectPath(pathname, filesystem)
  if (existing) {
    if (existing.isSymbolicLink()) {
      inputError(`${label} must not be a symbolic link`)
    }
    if (!existing.isDirectory()) {
      inputError(`${label} must be a directory`)
    }
    return
  }
  try {
    await filesystem.mkdir(pathname)
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      inputError(`Unable to create ${label}: ${error.message}`)
    }
  }
  await assertExistingDirectory(pathname, label, filesystem)
}

async function ensureRootPath(root, repositoryRoot, filesystem) {
  const resolvedRepository = resolve(repositoryRoot)
  await assertExistingDirectory(resolvedRepository, 'Repository root', filesystem)
  const resolvedRoot = resolve(root)
  if (resolvedRoot !== resolvedRepository && !isStrictChild(resolvedRepository, resolvedRoot)) {
    inputError('Required root must be within the repository root')
  }
  const components = relative(resolvedRepository, resolvedRoot).split(sep).filter(Boolean)
  let current = resolvedRepository
  for (const component of components) {
    current = resolve(current, component)
    await makeDirectoryNoFollow(current, `output root component ${component}`, filesystem)
  }
  return resolvedRoot
}

export async function createNewStrictOutputDirectory(
  requested,
  { root, repositoryRoot = REPOSITORY_ROOT, filesystem = { lstat, mkdir, realpath } } = {},
) {
  const candidate = resolveStrictChildPath(requested, { root, repositoryRoot })
  const resolvedRoot = await ensureRootPath(root, repositoryRoot, filesystem)
  const relativeCandidate = relative(resolvedRoot, candidate)
  const components = relativeCandidate.split(sep).filter(Boolean)
  let current = resolvedRoot
  for (const [index, component] of components.entries()) {
    current = resolve(current, component)
    const details = await inspectPath(current, filesystem)
    const isTarget = index === components.length - 1
    if (isTarget) {
      if (details) {
        if (details.isSymbolicLink()) {
          inputError('Output path must not be a symbolic link')
        }
        inputError('Output path already exists')
      }
      try {
        await filesystem.mkdir(current)
      } catch (error) {
        if (error?.code === 'EEXIST') {
          inputError('Output path already exists')
        }
        inputError(`Unable to create output path: ${error.message}`)
      }
      await assertExistingDirectory(current, 'Output path', filesystem)
    } else if (details) {
      if (details.isSymbolicLink()) {
        inputError(`Output path component ${component} must not be a symbolic link`)
      }
      if (!details.isDirectory()) {
        inputError(`Output path component ${component} must be a directory`)
      }
    } else {
      await makeDirectoryNoFollow(current, `output path component ${component}`, filesystem)
    }
  }
  let physical
  try {
    physical = await filesystem.realpath(candidate)
  } catch (error) {
    inputError(`Unable to resolve output path: ${error.message}`)
  }
  let physicalRoot
  try {
    physicalRoot = await filesystem.realpath(resolvedRoot)
  } catch (error) {
    inputError(`Unable to resolve output root: ${error.message}`)
  }
  if (!isStrictChild(physicalRoot, physical)) {
    inputError('Output path resolves outside the required root')
  }
  return physical
}

export async function readNoFollowRegularFile(
  pathname,
  { label = 'file', maxBytes = Number.MAX_SAFE_INTEGER, filesystem = { lstat, open } } = {},
) {
  if (typeof pathname !== 'string' || pathname.length === 0) {
    inputError(`${label} path must be non-empty`)
  }
  let before
  try {
    before = await filesystem.lstat(pathname)
  } catch (error) {
    inputError(`Unable to inspect ${label}: ${error.message}`)
  }
  if (before.isSymbolicLink()) {
    inputError(`${label} must not be a symbolic link`)
  }
  if (!before.isFile()) {
    inputError(`${label} must be a regular file`)
  }
  if (before.size > maxBytes) {
    inputError(`${label} exceeds the maximum size of ${maxBytes} bytes`)
  }
  if (typeof constants.O_NOFOLLOW !== 'number') {
    inputError('No-follow file opening is unavailable on this platform')
  }
  let handle
  try {
    handle = await filesystem.open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
      inputError(`${label} changed while it was being opened`)
    }
    if (opened.size > maxBytes) {
      inputError(`${label} exceeds the maximum size of ${maxBytes} bytes`)
    }
    const contents = await handle.readFile()
    if (contents.byteLength !== opened.size) {
      inputError(`${label} changed while it was being read`)
    }
    return contents
  } catch (error) {
    if (error instanceof PerfInputError) {
      throw error
    }
    inputError(`Unable to open ${label} without following links: ${error.message}`)
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function readJsonNoFollow(pathname, options = {}) {
  const contents = await readNoFollowRegularFile(pathname, options)
  try {
    return { contents, value: JSON.parse(contents.toString('utf8')) }
  } catch (error) {
    inputError(`${options.label ?? 'JSON file'} is not valid JSON: ${error.message}`)
  }
}

export async function writeNewFile(pathname, contents, { filesystem = { writeFile } } = {}) {
  try {
    await filesystem.writeFile(pathname, contents, { flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      inputError(`Refusing to overwrite existing file: ${pathname}`)
    }
    throw error
  }
}
