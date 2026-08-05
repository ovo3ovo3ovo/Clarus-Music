import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

export const EXPECTED_BUNDLE_ID = 'com.ovo3ovo3ovo.clarusmusic'
export const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
export const EXPECTED_RELEASE_BUNDLE_PATH = join(
  REPOSITORY_ROOT,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'macos',
  'Clarus Music.app',
)

export const DEFAULT_HELPER_PATHS = Object.freeze({
  'web-content':
    '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent',
  gpu: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU',
  networking:
    '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking',
})

const HELPER_BUNDLE_IDS = Object.freeze({
  'web-content': 'com.apple.WebKit.WebContent',
  gpu: 'com.apple.WebKit.GPU',
  networking: 'com.apple.WebKit.Networking',
})

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

export class AttributionError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`)
    this.code = code
    this.name = 'AttributionError'
  }
}

function fail(code, message) {
  throw new AttributionError(code, message)
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('MALFORMED', `${label} must be an object`)
  }
}

function assertSafePid(value, label) {
  if (!Number.isSafeInteger(value) || value < 2) {
    fail('MALFORMED', `${label} must be a decimal safe integer greater than one`)
  }
}

function assertSnapshotPid(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('MALFORMED', `${label} must be a positive decimal safe integer`)
  }
}

function assertPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacters(value)) {
    fail('MALFORMED', `${label} must be a non-empty path without control characters`)
  }
  if (
    !isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '..')
  ) {
    fail('MALFORMED', `${label} must be an absolute path without traversal`)
  }
}

function assertText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacters(value)) {
    fail('MALFORMED', `${label} must be a non-empty text value without control characters`)
  }
}

function deepEqualCoalition(left, right) {
  return Boolean(left && right && left.id === right.id && left.asn === right.asn)
}

function normaliseCoalition(value, label) {
  assertPlainObject(value, label)
  assertText(value.id, `${label}.id`)
  assertText(value.asn, `${label}.asn`)
  return { id: value.id, asn: value.asn }
}

function normaliseProcess(record, label = 'process') {
  assertPlainObject(record, label)
  assertSnapshotPid(record.pid, `${label}.pid`)
  if (!Number.isSafeInteger(record.ppid) || record.ppid < 0) {
    fail('MALFORMED', `${label}.ppid must be a nonnegative safe integer`)
  }
  assertText(record.start, `${label}.start`)
  assertPath(record.path, `${label}.path`)
  assertPath(record.realpath, `${label}.realpath`)
  return {
    pid: record.pid,
    ppid: record.ppid,
    start: record.start,
    path: record.path,
    realpath: record.realpath,
  }
}

function normaliseLsRecord(record, label = 'lsappinfo record') {
  assertPlainObject(record, label)
  assertSafePid(record.pid, `${label}.pid`)
  const path = record.path ?? record.executablePath
  const resolvedPath = record.realpath ?? record.executableRealpath ?? path
  assertPath(path, `${label}.path`)
  assertPath(resolvedPath, `${label}.realpath`)
  assertText(record.bundleId, `${label}.bundleId`)
  return {
    pid: record.pid,
    path,
    realpath: resolvedPath,
    bundleId: record.bundleId,
    coalition: normaliseCoalition(record.coalition, `${label}.coalition`),
  }
}

function normaliseSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) {
    fail('MALFORMED', 'process snapshot must be an array')
  }
  const seen = new Set()
  return snapshot.map((record) => {
    const normalized = normaliseProcess(record, 'process snapshot entry')
    if (seen.has(normalized.pid)) {
      fail('MALFORMED', `process snapshot has duplicate PID ${normalized.pid}`)
    }
    seen.add(normalized.pid)
    return normalized
  })
}

function normaliseApplications(applications) {
  if (!Array.isArray(applications)) {
    fail('MALFORMED', 'lsappinfo application records must be an array')
  }
  return applications.map((record) => normaliseLsRecord(record, 'lsappinfo application record'))
}

function normaliseInfoByPid(infoByPid) {
  const entries =
    infoByPid instanceof Map ? [...infoByPid.entries()] : Object.entries(infoByPid ?? {})
  const normalized = new Map()
  for (const [key, value] of entries) {
    const numericKey = typeof key === 'number' ? key : Number(key)
    assertSafePid(numericKey, 'lsappinfo info map key')
    const record = normaliseLsRecord(value, 'lsappinfo info record')
    if (record.pid !== numericKey || normalized.has(record.pid)) {
      fail('MALFORMED', 'lsappinfo info records have mismatched or duplicate PIDs')
    }
    normalized.set(record.pid, record)
  }
  return normalized
}

function expectedBundlePath(bundle) {
  return bundle.expectedBundlePath ?? EXPECTED_RELEASE_BUNDLE_PATH
}

export function assertExpectedReleaseBundle(bundle) {
  assertPlainObject(bundle, 'bundle descriptor')
  const expected = expectedBundlePath(bundle)
  const expectedRealpath = bundle.expectedBundleRealpath ?? expected
  const appRealpath = bundle.appBundleRealpath ?? bundle.appBundlePath
  assertPath(expected, 'bundle expected release path')
  assertPath(expectedRealpath, 'bundle expected release realpath')
  assertPath(bundle.appBundlePath, 'bundle appBundlePath')
  assertPath(appRealpath, 'bundle appBundleRealpath')
  assertPath(bundle.executablePath, 'bundle executablePath')
  assertPath(bundle.executableRealpath, 'bundle executableRealpath')
  if (bundle.appBundleSymlink === true || bundle.executableSymlink === true) {
    fail('BUNDLE_SYMLINK', 'release app bundle and executable must not be symbolic links')
  }
  if (
    resolve(appRealpath) !== resolve(expectedRealpath) ||
    !bundle.appBundlePath.endsWith('.app')
  ) {
    fail('BUNDLE_PATH', 'app bundle must real-resolve exactly to the worktree release bundle path')
  }
  const expectedExecutablePrefix = `${resolve(bundle.appBundlePath)}/Contents/MacOS/`
  const expectedExecutableRealpathPrefix = `${resolve(expectedRealpath)}/Contents/MacOS/`
  if (
    !bundle.executablePath.startsWith(expectedExecutablePrefix) ||
    !bundle.executableRealpath.startsWith(expectedExecutableRealpathPrefix)
  ) {
    fail(
      'BUNDLE_EXECUTABLE',
      'bundle executable must real-resolve exactly under the release bundle',
    )
  }
  const executableName = bundle.executablePath.slice(expectedExecutablePrefix.length)
  if (!/^[A-Za-z0-9._-]+$/.test(executableName)) {
    fail('BUNDLE_EXECUTABLE', 'bundle executable must be a simple executable filename')
  }
  if (
    resolve(bundle.executableRealpath) !== `${expectedExecutableRealpathPrefix}${executableName}`
  ) {
    fail(
      'BUNDLE_EXECUTABLE',
      'bundle executable must real-resolve exactly under the release bundle',
    )
  }
  if (bundle.bundleId !== EXPECTED_BUNDLE_ID) {
    fail('BUNDLE_ID', `bundle id must be ${EXPECTED_BUNDLE_ID}`)
  }
  assertText(bundle.bundleVersion, 'bundle bundleVersion')
  return {
    appBundlePath: resolve(bundle.appBundlePath),
    appBundleRealpath: resolve(appRealpath),
    executablePath: resolve(bundle.executablePath),
    executableRealpath: resolve(bundle.executableRealpath),
    bundleId: bundle.bundleId,
    bundleVersion: bundle.bundleVersion,
    expectedBundlePath: resolve(expected),
    expectedBundleRealpath: resolve(expectedRealpath),
  }
}

function parsePlistText(result, label) {
  const text = String(result?.stdout ?? result ?? '').trim()
  if (!text || hasControlCharacters(text)) {
    fail('BUNDLE_PLIST', `${label} could not be read from Info.plist`)
  }
  return text
}

async function invoke(runCommand, executable, argv, options = {}) {
  if (typeof runCommand !== 'function') {
    fail('MALFORMED', 'command runner must be a function')
  }
  return runCommand(executable, argv, {
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
    shell: false,
    ...options,
  })
}

export async function readReleaseBundle({
  appBundlePath = EXPECTED_RELEASE_BUNDLE_PATH,
  expectedBundlePath = EXPECTED_RELEASE_BUNDLE_PATH,
  filesystem = { lstat, readFile, realpath },
  runCommand,
} = {}) {
  assertPath(appBundlePath, 'app bundle path')
  assertPath(expectedBundlePath, 'expected release bundle path')
  let appStat
  try {
    appStat = await filesystem.lstat(appBundlePath)
  } catch (error) {
    fail('BUNDLE_UNAVAILABLE', `unable to inspect release app bundle: ${error.message}`)
  }
  if (appStat.isSymbolicLink()) {
    fail('BUNDLE_SYMLINK', 'release app bundle must not be a symbolic link')
  }
  if (!appStat.isDirectory()) {
    fail('BUNDLE_PATH', 'release app bundle must be a directory')
  }
  let appRealpath
  let expectedBundleRealpath
  try {
    appRealpath = await filesystem.realpath(appBundlePath)
    expectedBundleRealpath = await filesystem.realpath(expectedBundlePath)
  } catch (error) {
    fail('BUNDLE_UNAVAILABLE', `unable to resolve release app bundle: ${error.message}`)
  }
  if (resolve(appRealpath) !== resolve(expectedBundleRealpath)) {
    fail('BUNDLE_PATH', 'release app bundle does not real-resolve to the expected worktree path')
  }
  const infoPath = join(appBundlePath, 'Contents', 'Info.plist')
  const identifier = parsePlistText(
    await invoke(runCommand, '/usr/bin/plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      infoPath,
    ]),
    'CFBundleIdentifier',
  )
  const executableName = parsePlistText(
    await invoke(runCommand, '/usr/bin/plutil', [
      '-extract',
      'CFBundleExecutable',
      'raw',
      '-o',
      '-',
      infoPath,
    ]),
    'CFBundleExecutable',
  )
  const bundleVersion = parsePlistText(
    await invoke(runCommand, '/usr/bin/plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o',
      '-',
      infoPath,
    ]),
    'CFBundleShortVersionString',
  )
  if (identifier !== EXPECTED_BUNDLE_ID) {
    fail('BUNDLE_ID', `bundle id must be ${EXPECTED_BUNDLE_ID}`)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(executableName)) {
    fail('BUNDLE_EXECUTABLE', 'Info.plist CFBundleExecutable must be a simple filename')
  }
  const executablePath = join(appBundlePath, 'Contents', 'MacOS', executableName)
  let executableStat
  try {
    executableStat = await filesystem.lstat(executablePath)
  } catch (error) {
    fail('BUNDLE_UNAVAILABLE', `unable to inspect release executable: ${error.message}`)
  }
  if (executableStat.isSymbolicLink()) {
    fail('BUNDLE_SYMLINK', 'release executable must not be a symbolic link')
  }
  if (!executableStat.isFile()) {
    fail('BUNDLE_EXECUTABLE', 'release executable must be a regular file')
  }
  const executableRealpath = await filesystem.realpath(executablePath)
  const descriptor = assertExpectedReleaseBundle({
    appBundlePath,
    appBundleRealpath: appRealpath,
    executablePath,
    executableRealpath,
    bundleId: identifier,
    bundleVersion,
    expectedBundlePath,
    expectedBundleRealpath,
  })
  const executableBytes = await filesystem.readFile(executablePath)
  return {
    ...descriptor,
    executableSha256: createHash('sha256').update(executableBytes).digest('hex'),
  }
}

export function parsePsSnapshot(output) {
  if (typeof output !== 'string' || output.length === 0) {
    fail('MALFORMED_PS', 'ps output is empty or malformed')
  }
  const records = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    let fields
    if (line.includes('\t')) {
      fields = line.split('\t')
      if (fields.length !== 4) {
        fail('MALFORMED_PS', 'ps tabular output is malformed')
      }
    } else {
      const match =
        /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(
          line,
        ) ?? /^\s*(\d+)\s+(\d+)\s+(.+?)\s{2,}(.+?)\s*$/.exec(line)
      if (!match) {
        fail('MALFORMED_PS', 'ps output is malformed')
      }
      fields = [match[1], match[2], match[3], match[4]]
    }
    const pid = Number(fields[0].trim())
    const ppid = Number(fields[1].trim())
    const start = fields[2].trim()
    const path = fields[3].trim()
    if (!path.startsWith('/')) {
      // `comm=` returns a basename for some system daemons. It cannot be
      // realpath-attributed, so omit it rather than rejecting the full
      // snapshot; app and WebKit records use absolute executable paths.
      continue
    }
    records.push({ pid, ppid, start, path, realpath: path })
  }
  return normaliseSnapshot(records)
}

function parseKeyValueBlock(block) {
  const result = {}
  const expressions = {
    pid: /(?:^|\n|[;,])\s*(?:pid|PID)\s*[:=]\s*(\d+)/m,
    executablePath: /(?:^|\n)\s*executable\s+path\s*[:=]\s*["']?([^"'\n;,]+)["']?/im,
    path: /(?:^|\n)\s*path\s*[:=]\s*["']?([^"'\n;,]+)["']?/im,
    realpath: /(?:realpath|real\s+path)\s*[:=]\s*["']?([^"'\n;,]+)["']?/i,
    bundleId: /(?:bundleID|bundleId|bundle\s+id)\s*[:=]\s*["']?([^"'\n;,]+)["']?/i,
    coalitionId: /(?:coalition(?:\s+id)?)\s*[:=]\s*["']?([^\s{"'\n;,]+)["']?/i,
    coalitionMembers: /(?:coalition(?:\s+id)?)\s*[:=][^\n{]*\{([^}]*)\}/i,
    asn: /(?:ASN|asn)\s*[:=]\s*["']?([^"'\n;,]+)["']?/i,
  }
  for (const [key, expression] of Object.entries(expressions)) {
    const match = expression.exec(block)
    if (match) {
      result[key] = match[1].trim()
    }
  }
  if (result.executablePath) {
    result.path = result.executablePath
  }
  if (result.pid) {
    result.pid = Number(result.pid)
  }
  if (result.path && !result.realpath) {
    result.realpath = result.path
  }
  if (result.asn) {
    result.coalition = {
      id: result.coalitionId ?? `asn:${result.asn}`,
      asn: result.asn,
    }
  }
  if (result.coalitionMembers) {
    result.coalitionMembers = result.coalitionMembers
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 1)
  }
  return result
}

function parseLsappinfoText(output, label) {
  if (typeof output !== 'string' || output.trim() === '') {
    fail('MALFORMED_LSAPPINFO', `${label} output is empty or malformed`)
  }
  const trimmed = output.trim()
  try {
    const decoded = JSON.parse(trimmed)
    const records = Array.isArray(decoded) ? decoded : decoded.records
    if (!Array.isArray(records)) {
      fail('MALFORMED_LSAPPINFO', `${label} JSON must contain records`)
    }
    return records
  } catch (error) {
    if (error instanceof AttributionError) {
      throw error
    }
  }
  const blocks = /^\s*\d+\)\s/m.test(trimmed)
    ? trimmed.split(/(?=^\s*\d+\)\s)/m).filter((block) => block.trim())
    : /(^|\n)\s*ASN\s*[:=]/im.test(trimmed)
      ? trimmed.split(/(?=^\s*ASN\s*[:=])/im).filter((block) => block.trim())
      : trimmed.split(/\n\s*\n/).filter(Boolean)
  const records = blocks.map(parseKeyValueBlock).filter((record) => Object.keys(record).length > 0)
  if (records.length === 0) {
    fail('MALFORMED_LSAPPINFO', `${label} output is malformed`)
  }
  return records
}

export function parseLsappinfoApplications(output) {
  const rawRecords = parseLsappinfoText(output, 'lsappinfo list')
  const records = rawRecords.filter(
    (record) => typeof record.path === 'string' && isAbsolute(record.path),
  )
  if (records.length === 0) {
    fail('MALFORMED_LSAPPINFO', 'lsappinfo list contains no attributable records')
  }
  const normalized = normaliseApplications(records)
  for (const [index, record] of records.entries()) {
    if (Array.isArray(record.coalitionMembers) && record.coalitionMembers.length > 0) {
      Object.defineProperty(normalized[index].coalition, 'members', {
        configurable: false,
        enumerable: false,
        value: Object.freeze([...record.coalitionMembers]),
        writable: false,
      })
    }
  }
  return normalized
}

export function parseLsappinfoInfo(output, { fallbackPath, fallbackRealpath } = {}) {
  const records = parseLsappinfoText(output, 'lsappinfo info')
  if (records.length !== 1) {
    fail('MALFORMED_LSAPPINFO', 'lsappinfo info must contain exactly one process record')
  }
  const record = { ...records[0] }
  if (typeof record.path === 'string' && !isAbsolute(record.path)) {
    if (typeof fallbackPath !== 'string' || !isAbsolute(fallbackPath)) {
      fail('MALFORMED_LSAPPINFO', 'basename-only lsappinfo info requires an absolute ps fallback')
    }
    if (basename(record.path) !== basename(fallbackPath)) {
      fail('EXECUTABLE_MISMATCH', 'basename-only lsappinfo info disagrees with the ps executable')
    }
    record.path = fallbackPath
    record.realpath = fallbackRealpath ?? fallbackPath
  }
  return normaliseLsRecord(record, 'lsappinfo info record')
}

function assertSameProcessIdentity(previous, current, label) {
  if (!current) {
    fail('TARGET_DRIFT', `${label} PID disappeared during attribution revalidation`)
  }
  if (current.start !== previous.start) {
    fail('PID_REUSE', `${label} PID start identity changed during revalidation`)
  }
  if (current.path !== previous.path || current.realpath !== previous.realpath) {
    fail('EXECUTABLE_DRIFT', `${label} executable path changed during revalidation`)
  }
}

function isDescendantOf(process, rootPid, byPid) {
  let candidate = process
  const visited = new Set()
  while (candidate && candidate.ppid !== 0 && candidate.ppid !== 1) {
    if (visited.has(candidate.pid)) {
      return false
    }
    visited.add(candidate.pid)
    if (candidate.ppid === rootPid) {
      return true
    }
    candidate = byPid.get(candidate.ppid)
  }
  return false
}

function asSelected(role, process) {
  return {
    role,
    pid: process.pid,
    start: process.start,
    path: process.path,
    realpath: process.realpath,
  }
}

function asUnselected(process) {
  return {
    pid: process.pid,
    ppid: process.ppid,
    start: process.start,
    path: process.path,
    realpath: process.realpath,
    reason: 'unknown-coalition',
  }
}

function exactHelperMatch(process, expectedPath) {
  return process.realpath === expectedPath && process.path === expectedPath
}

function hasHelperBasename(process, expectedPath) {
  const expectedName = basename(expectedPath)
  return basename(process.path) === expectedName || basename(process.realpath) === expectedName
}

export function attributeProcessTree({
  rootPid,
  bundle,
  snapshot,
  applications,
  infoByPid,
  helperPaths = DEFAULT_HELPER_PATHS,
} = {}) {
  assertSafePid(rootPid, 'root PID')
  const releaseBundle = assertExpectedReleaseBundle(bundle)
  const processes = normaliseSnapshot(snapshot)
  const processByPid = new Map(processes.map((process) => [process.pid, process]))
  const root = processByPid.get(rootPid)
  if (!root) {
    fail('ROOT_PID_MISSING', 'root PID does not exist in the ps snapshot')
  }
  if (
    root.realpath !== releaseBundle.executableRealpath ||
    root.path !== releaseBundle.executablePath
  ) {
    fail(
      'ROOT_EXECUTABLE_MISMATCH',
      'root PID executable does not real-resolve exactly to the release executable',
    )
  }
  const appRecords = normaliseApplications(applications)
  const rootApplications = appRecords.filter(
    (record) =>
      record.pid === rootPid &&
      record.path === releaseBundle.executablePath &&
      record.realpath === releaseBundle.executableRealpath &&
      record.bundleId === releaseBundle.bundleId,
  )
  if (rootApplications.length !== 1) {
    fail(
      'ROOT_LSAPPINFO_MISMATCH',
      'lsappinfo list must have exactly one matching root PID and executable record',
    )
  }
  const info = normaliseInfoByPid(infoByPid)
  const rootInfo = info.get(rootPid)
  if (
    !rootInfo ||
    rootInfo.path !== releaseBundle.executablePath ||
    rootInfo.realpath !== releaseBundle.executableRealpath ||
    rootInfo.bundleId !== releaseBundle.bundleId
  ) {
    fail(
      'ROOT_LSAPPINFO_MISMATCH',
      'lsappinfo info must exactly match the release root executable and bundle id',
    )
  }
  const coalition = rootApplications[0].coalition
  if (!deepEqualCoalition(coalition, rootInfo.coalition)) {
    fail('COALITION_DRIFT', 'root lsappinfo list and info coalition evidence differs')
  }
  if (!helperPaths || typeof helperPaths !== 'object') {
    fail('MALFORMED', 'helper paths must be an object')
  }
  const roleOrder = ['web-content', 'gpu', 'networking']
  const selectedHelpers = []
  const governed = processes.filter((process) => {
    if (process.pid === rootPid) {
      return false
    }
    const processInfo = info.get(process.pid)
    return processInfo && deepEqualCoalition(processInfo.coalition, coalition)
  })

  for (const role of roleOrder) {
    const expectedPath = helperPaths[role]
    assertPath(expectedPath, `canonical ${role} helper path`)
    const roleCandidates = []
    for (const process of governed) {
      if (hasHelperBasename(process, expectedPath) && !exactHelperMatch(process, expectedPath)) {
        fail(
          'HELPER_PATH_OUTSIDE',
          `${role} helper has an outside or basename-only executable path`,
        )
      }
      if (exactHelperMatch(process, expectedPath)) {
        roleCandidates.push(process)
      }
    }
    if (roleCandidates.length === 0) {
      fail('HELPER_MISSING', `missing exact governed ${role} helper`)
    }
    if (roleCandidates.length !== 1) {
      fail('HELPER_DUPLICATE', `duplicate exact governed ${role} helpers`)
    }
    const process = roleCandidates[0]
    const processInfo = info.get(process.pid)
    if (
      !processInfo ||
      processInfo.path !== expectedPath ||
      processInfo.realpath !== expectedPath ||
      processInfo.bundleId !== HELPER_BUNDLE_IDS[role] ||
      !deepEqualCoalition(processInfo.coalition, coalition)
    ) {
      fail(
        'HELPER_LSAPPINFO_MISMATCH',
        `${role} helper has invalid LaunchServices bundle, path, or coalition evidence`,
      )
    }
    selectedHelpers.push(asSelected(role, process))
  }
  const selectedPids = new Set(selectedHelpers.map((selected) => selected.pid))
  const unselected = governed
    .filter((process) => !selectedPids.has(process.pid))
    .sort((left, right) => left.pid - right.pid)
    .map(asUnselected)
  const allDescendants = selectedHelpers.every((selected) =>
    isDescendantOf(processByPid.get(selected.pid), rootPid, processByPid),
  )
  return {
    method: allDescendants ? 'posix-descendant' : 'launchservices-coalition',
    rootPid,
    coalition: { ...coalition },
    preSnapshot: [...processes].sort((left, right) => left.pid - right.pid),
    postSnapshot: [...processes].sort((left, right) => left.pid - right.pid),
    selected: [asSelected('main', root), ...selectedHelpers],
    unselected,
  }
}

export function revalidateAttribution({
  baseline,
  rootPid,
  bundle,
  snapshot,
  applications,
  infoByPid,
  helperPaths,
} = {}) {
  assertPlainObject(baseline, 'baseline attribution')
  if (!Array.isArray(baseline.selected) || baseline.selected.length !== 4) {
    fail('MALFORMED', 'baseline attribution must include the exact four selected roles')
  }
  const processes = normaliseSnapshot(snapshot)
  const processByPid = new Map(processes.map((process) => [process.pid, process]))
  for (const selected of baseline.selected) {
    assertSameProcessIdentity(selected, processByPid.get(selected.pid), selected.role)
  }
  const currentInfo = normaliseInfoByPid(infoByPid)
  const rootInfo = currentInfo.get(rootPid)
  if (!rootInfo || !deepEqualCoalition(rootInfo.coalition, baseline.coalition)) {
    fail('COALITION_DRIFT', 'root coalition changed during attribution revalidation')
  }
  for (const selected of baseline.selected) {
    const selectedInfo = currentInfo.get(selected.pid)
    if (!selectedInfo || !deepEqualCoalition(selectedInfo.coalition, baseline.coalition)) {
      fail('COALITION_DRIFT', `${selected.role} coalition changed during attribution revalidation`)
    }
  }
  const revalidated = attributeProcessTree({
    rootPid,
    bundle,
    snapshot: processes,
    applications,
    infoByPid: currentInfo,
    helperPaths,
  })
  if (revalidated.method !== baseline.method) {
    fail('ATTRIBUTION_DRIFT', 'attribution method changed during revalidation')
  }
  return revalidated
}

export function compareAttributionIdentity(baseline, current) {
  assertPlainObject(baseline, 'baseline attribution')
  assertPlainObject(current, 'current attribution')
  if (!Array.isArray(baseline.selected) || !Array.isArray(current.selected)) {
    fail('MALFORMED', 'attribution comparison requires selected process records')
  }
  if (!deepEqualCoalition(baseline.coalition, current.coalition)) {
    fail('COALITION_DRIFT', 'LaunchServices coalition changed during revalidation')
  }
  if (baseline.method !== current.method || baseline.rootPid !== current.rootPid) {
    fail('ATTRIBUTION_DRIFT', 'attribution method or root PID changed during revalidation')
  }
  const currentByRole = new Map(current.selected.map((entry) => [entry.role, entry]))
  if (currentByRole.size !== current.selected.length) {
    fail('ATTRIBUTION_DRIFT', 'current attribution has duplicate selected roles')
  }
  for (const selected of baseline.selected) {
    const candidate = currentByRole.get(selected.role)
    if (!candidate || candidate.pid !== selected.pid) {
      fail('ATTRIBUTION_DRIFT', `${selected.role} PID changed during revalidation`)
    }
    assertSameProcessIdentity(selected, candidate, selected.role)
  }
  return current
}

export async function captureAttribution({
  rootPid,
  bundle,
  captureProcesses,
  captureApplications,
  captureInfoByPid,
  helperPaths,
} = {}) {
  if (
    typeof captureProcesses !== 'function' ||
    typeof captureApplications !== 'function' ||
    typeof captureInfoByPid !== 'function'
  ) {
    fail('MALFORMED', 'attribution capture requires process and LaunchServices capture functions')
  }
  const snapshot = await captureProcesses()
  const applications = await captureApplications()
  const infoByPid = await captureInfoByPid(
    normaliseSnapshot(snapshot).map((process) => process.pid),
  )
  return attributeProcessTree({ rootPid, bundle, snapshot, applications, infoByPid, helperPaths })
}

export async function captureMacosAttribution({
  rootPid,
  bundle,
  runCommand,
  resolveRealpath = realpath,
  helperPaths,
} = {}) {
  const ps = await invoke(runCommand, '/bin/ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,comm='])
  const rawSnapshot = parsePsSnapshot(String(ps?.stdout ?? ''))
  const snapshot = []
  // macOS `comm=` reports only a basename for some system daemons. Those
  // records cannot participate in strict path/realpath attribution, but they
  // must not make an otherwise valid app snapshot malformed. Keep only
  // absolute-path records; selected app/WebKit roles still fail closed if
  // their own paths are unavailable.
  const effectiveHelperPaths = {}
  for (const role of ['web-content', 'gpu', 'networking']) {
    const expectedPath = helperPaths?.[role] ?? DEFAULT_HELPER_PATHS[role]
    assertPath(expectedPath, `canonical ${role} helper path`)
    try {
      effectiveHelperPaths[role] = await resolveRealpath(expectedPath)
    } catch {
      fail('REALPATH_UNAVAILABLE', `could not resolve canonical ${role} helper path`)
    }
  }
  const helperBasenames = new Set(
    Object.values(effectiveHelperPaths).map((pathname) => basename(pathname)),
  )
  for (const record of rawSnapshot.filter(({ pid, path }) => pid > 1 && path.startsWith('/'))) {
    let resolved
    try {
      resolved = await resolveRealpath(record.path)
    } catch {
      if (record.pid === rootPid || helperBasenames.has(basename(record.path))) {
        fail('REALPATH_UNAVAILABLE', `could not resolve attributed process ${record.pid}`)
      }
      // Unknown processes are never selected or sampled. Retain their raw
      // executable path so a coalition member can still be reported as
      // unselected even when its optional realpath evidence is unavailable.
      resolved = record.path
    }
    snapshot.push({ ...record, path: resolved, realpath: resolved })
  }
  const listed = await invoke(runCommand, '/usr/bin/lsappinfo', ['list'])
  const applications = parseLsappinfoApplications(String(listed?.stdout ?? ''))
  const rootApplication = applications.find((record) => record.pid === rootPid)
  const rootMembers = new Set(rootApplication?.coalition?.members ?? [])
  const infoByPid = new Map()
  const infoCandidatePids = new Set([
    rootPid,
    ...snapshot
      .filter((process) => helperBasenames.has(basename(process.path)))
      .map((process) => process.pid),
  ])
  for (const pid of rootMembers) {
    if (snapshot.some((process) => process.pid === pid)) {
      infoCandidatePids.add(pid)
    }
  }
  const infoCandidates = snapshot.filter((process) => infoCandidatePids.has(process.pid))
  for (const process of infoCandidates) {
    const inspected = await invoke(runCommand, '/usr/bin/lsappinfo', [
      'info',
      '-pid',
      String(process.pid),
    ])
    let parsed
    try {
      parsed = parseLsappinfoInfo(String(inspected?.stdout ?? ''), {
        fallbackPath: process.path,
        fallbackRealpath: process.realpath,
      })
    } catch (error) {
      const isSelectedCandidate =
        process.pid === rootPid || helperBasenames.has(basename(process.path))
      if (isSelectedCandidate || !rootMembers.has(process.pid)) {
        throw error
      }
      // Some system coalition members (notably AudioToolbox's
      // SandboxHelper) are present in ps and in the root coalition but have
      // no LaunchServices record. Preserve them as unsampled unknown members
      // using the already-verified ps identity and coalition membership.
      parsed = {
        pid: process.pid,
        path: process.path,
        realpath: process.realpath,
        bundleId: 'unknown',
        coalition: rootApplication.coalition,
      }
    }
    infoByPid.set(process.pid, parsed)
  }
  const rootInfo = infoByPid.get(rootPid)
  if (rootInfo && rootMembers.size > 0) {
    for (const process of infoCandidates) {
      if (process.pid !== rootPid && rootMembers.has(process.pid)) {
        const processInfo = infoByPid.get(process.pid)
        if (processInfo) {
          processInfo.coalition = { ...rootInfo.coalition }
        }
      }
    }
  }
  return attributeProcessTree({
    rootPid,
    bundle,
    snapshot,
    applications,
    infoByPid,
    helperPaths: effectiveHelperPaths,
  })
}

export const MACOS_FIXED_TOOLS = Object.freeze({
  ps: '/bin/ps',
  lsappinfo: '/usr/bin/lsappinfo',
  plutil: '/usr/bin/plutil',
})

export async function isExecutableRegularFile(pathname, filesystem = { lstat }) {
  try {
    const details = await filesystem.lstat(pathname)
    return details.isFile() && !details.isSymbolicLink() && (details.mode & constants.S_IXUSR) !== 0
  } catch {
    return false
  }
}
