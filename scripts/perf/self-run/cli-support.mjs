import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

export const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
export const SELF_RUN_ROOT = resolve(REPOSITORY_ROOT, 'artifacts', 'perf', 'self-runs')
export const DEFAULT_FIXTURE_DIRECTORY = resolve(
  REPOSITORY_ROOT,
  'artifacts',
  'perf',
  'fixtures',
  'current',
)
export const DEFAULT_APP_BUNDLE = resolve(
  REPOSITORY_ROOT,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'macos',
  'Clarus Music.app',
)

// A self-run is evidence about the current checkout only.  Keep this path
// explicit and stable so an installed copy (or an app from another checkout)
// cannot accidentally be measured by passing --app-bundle.
export const MIN_RECOVERY_SECONDS = 600
export const MAX_RECOVERY_SECONDS = 900

export class SelfRunInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SelfRunInputError'
  }
}

function fail(message) {
  throw new SelfRunInputError(message)
}

function parseInteger(value, label, minimum, maximum) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    fail(`${label} must be a decimal integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${label} must be from ${minimum} to ${maximum}`)
  }
  return parsed
}

function parseOptions(argumentsList) {
  if (!Array.isArray(argumentsList) || argumentsList.some((value) => typeof value !== 'string')) {
    fail('CLI arguments must be strings')
  }
  const supported = new Set([
    '--app-bundle',
    '--fixture-directory',
    '--iterations',
    '--output',
    '--recovery-seconds',
    '--startup-timeout-seconds',
  ])
  const values = new Map()
  for (let index = 0; index < argumentsList.length; index += 1) {
    const option = argumentsList[index]
    if (!option.startsWith('--')) fail(`Unexpected positional argument: ${option}`)
    if (option.includes('=')) fail(`--key=value syntax is not supported: ${option}`)
    if (!supported.has(option)) fail(`Unknown option: ${option}`)
    if (values.has(option)) fail(`Duplicate option: ${option}`)
    const value = argumentsList[index + 1]
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      fail(`${option} requires a value`)
    }
    values.set(option, value)
    index += 1
  }
  return values
}

function pathValue(value, fallback, repositoryRoot, label) {
  const input = value ?? fallback
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.includes('\0') ||
    input.includes('\\') ||
    input.split('/').some((part) => part === '..') ||
    (win32.isAbsolute(input) && !isAbsolute(input))
  ) {
    fail(`${label} is not an unambiguous macOS path`)
  }
  return isAbsolute(input) ? resolve(input) : resolve(repositoryRoot, input)
}

function isStrictChild(root, candidate) {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  )
}

function defaultRunId(now, processId) {
  const timestamp = now().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `${timestamp}-p${processId}-artist-dfs`
}

export function parseSelfRunArguments(
  argumentsList,
  {
    now = () => new Date(),
    processId = process.pid,
    repositoryRoot = REPOSITORY_ROOT,
    selfRunRoot = resolve(repositoryRoot, 'artifacts', 'perf', 'self-runs'),
  } = {},
) {
  const values = parseOptions(argumentsList)
  const appBundle = pathValue(
    values.get('--app-bundle'),
    resolve(repositoryRoot, 'src-tauri/target/release/bundle/macos/Clarus Music.app'),
    repositoryRoot,
    '--app-bundle',
  )
  if (
    appBundle !== resolve(repositoryRoot, 'src-tauri/target/release/bundle/macos/Clarus Music.app')
  ) {
    fail('--app-bundle must be the current worktree canonical Release app bundle')
  }
  const fixtureDirectory = pathValue(
    values.get('--fixture-directory'),
    resolve(repositoryRoot, 'artifacts/perf/fixtures/current'),
    repositoryRoot,
    '--fixture-directory',
  )
  const output = pathValue(
    values.get('--output'),
    resolve(selfRunRoot, defaultRunId(now, processId)),
    repositoryRoot,
    '--output',
  )
  if (!isStrictChild(resolve(selfRunRoot), output)) {
    fail('--output must be a strict child of artifacts/perf/self-runs')
  }
  return {
    appBundle,
    fixtureDirectory,
    iterations: parseInteger(values.get('--iterations') ?? '50', '--iterations', 50, 100),
    output,
    recoverySeconds: parseInteger(
      values.get('--recovery-seconds') ?? String(MIN_RECOVERY_SECONDS),
      '--recovery-seconds',
      MIN_RECOVERY_SECONDS,
      MAX_RECOVERY_SECONDS,
    ),
    startupTimeoutSeconds: parseInteger(
      values.get('--startup-timeout-seconds') ?? '90',
      '--startup-timeout-seconds',
      30,
      180,
    ),
  }
}
