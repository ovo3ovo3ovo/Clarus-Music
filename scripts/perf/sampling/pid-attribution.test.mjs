import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import {
  DEFAULT_HELPER_PATHS,
  EXPECTED_BUNDLE_ID,
  assertExpectedReleaseBundle,
  attributeProcessTree,
  parseLsappinfoApplications,
  parseLsappinfoInfo,
  parsePsSnapshot,
  readReleaseBundle,
  revalidateAttribution,
} from './pid-attribution.mjs'

const BUNDLE =
  '/private/tmp/clarus music performance/src-tauri/target/release/bundle/macos/Clarus Music.app'
const EXECUTABLE = `${BUNDLE}/Contents/MacOS/simplemusic`
const COALITION = { id: '17', asn: '0x40000017' }

function processRecord({ pid, ppid = 1, start = `start-${pid}`, path, realpath = path }) {
  return { pid, ppid, start, path, realpath }
}

function infoRecord({ pid, path, realpath = path, bundleId, coalition = COALITION }) {
  return { pid, path, realpath, bundleId, coalition }
}

function fixture({ withOtherInstance = true } = {}) {
  const root = processRecord({ pid: 4101, path: EXECUTABLE })
  const web = processRecord({ pid: 4102, path: DEFAULT_HELPER_PATHS['web-content'] })
  const gpu = processRecord({ pid: 4103, path: DEFAULT_HELPER_PATHS.gpu })
  const networking = processRecord({ pid: 4104, path: DEFAULT_HELPER_PATHS.networking })
  const unknown = processRecord({
    pid: 4105,
    path: '/System/Library/Frameworks/Other.framework/helper',
  })
  const other = processRecord({
    pid: 5101,
    path: '/Applications/Clarus Music.app/Contents/MacOS/simplemusic',
  })
  const snapshot = [root, web, gpu, networking, unknown, ...(withOtherInstance ? [other] : [])]
  const applications = [
    infoRecord({ pid: root.pid, path: EXECUTABLE, bundleId: EXPECTED_BUNDLE_ID }),
    ...(withOtherInstance
      ? [
          infoRecord({
            pid: other.pid,
            path: other.path,
            bundleId: EXPECTED_BUNDLE_ID,
            coalition: { id: 'other', asn: '0x40000099' },
          }),
        ]
      : []),
  ]
  const infoByPid = new Map([
    [root.pid, infoRecord({ pid: root.pid, path: EXECUTABLE, bundleId: EXPECTED_BUNDLE_ID })],
    [
      web.pid,
      infoRecord({
        pid: web.pid,
        path: web.path,
        bundleId: 'com.apple.WebKit.WebContent',
      }),
    ],
    [gpu.pid, infoRecord({ pid: gpu.pid, path: gpu.path, bundleId: 'com.apple.WebKit.GPU' })],
    [
      networking.pid,
      infoRecord({
        pid: networking.pid,
        path: networking.path,
        bundleId: 'com.apple.WebKit.Networking',
      }),
    ],
    [
      unknown.pid,
      infoRecord({ pid: unknown.pid, path: unknown.path, bundleId: 'com.apple.Other' }),
    ],
    ...(withOtherInstance
      ? [
          [
            other.pid,
            infoRecord({
              pid: other.pid,
              path: other.path,
              bundleId: EXPECTED_BUNDLE_ID,
              coalition: { id: 'other', asn: '0x40000099' },
            }),
          ],
        ]
      : []),
  ])
  return {
    bundle: {
      appBundlePath: BUNDLE,
      expectedBundlePath: BUNDLE,
      executablePath: EXECUTABLE,
      executableRealpath: EXECUTABLE,
      bundleId: EXPECTED_BUNDLE_ID,
      bundleVersion: '0.1.0',
    },
    snapshot,
    applications,
    infoByPid,
  }
}

function attribute(overrides = {}) {
  const state = fixture()
  return attributeProcessTree({ rootPid: 4101, ...state, ...overrides })
}

test('attributes the exact path-spaced release root rather than another same-named instance', () => {
  const result = attribute()
  assert.equal(result.method, 'launchservices-coalition')
  assert.equal(result.rootPid, 4101)
  assert.deepEqual(result.coalition, COALITION)
  assert.deepEqual(
    result.selected.map((entry) => [entry.role, entry.pid, entry.realpath]),
    [
      ['main', 4101, EXECUTABLE],
      ['web-content', 4102, DEFAULT_HELPER_PATHS['web-content']],
      ['gpu', 4103, DEFAULT_HELPER_PATHS.gpu],
      ['networking', 4104, DEFAULT_HELPER_PATHS.networking],
    ],
  )
  assert.deepEqual(
    result.unselected.map((entry) => entry.pid),
    [4105],
  )
})

test('uses posix-descendant only when every WebKit helper is in the exact root tree', () => {
  const state = fixture({ withOtherInstance: false })
  for (const process of state.snapshot) {
    if (process.pid !== 4101) {
      process.ppid = 4101
    }
  }
  const result = attributeProcessTree({ rootPid: 4101, ...state })
  assert.equal(result.method, 'posix-descendant')
})

test('rejects old installed bundles and non-release bundle descriptors before attribution', () => {
  const state = fixture()
  assert.throws(
    () =>
      assertExpectedReleaseBundle({
        ...state.bundle,
        appBundlePath: '/Applications/Clarus Music.app',
        executablePath: '/Applications/Clarus Music.app/Contents/MacOS/simplemusic',
        executableRealpath: '/Applications/Clarus Music.app/Contents/MacOS/simplemusic',
      }),
    /release bundle path/i,
  )
  assert.throws(
    () => assertExpectedReleaseBundle({ ...state.bundle, bundleId: 'com.example.other' }),
    /bundle id/i,
  )
  assert.throws(
    () => assertExpectedReleaseBundle({ ...state.bundle, appBundleSymlink: true }),
    /symbolic link/i,
  )
})

test('readReleaseBundle accepts a real release bundle through a /tmp prefix alias but rejects an outside bundle', async () => {
  const aliasBundle = '/tmp/clarus-worktree/src-tauri/target/release/bundle/macos/Clarus Music.app'
  const expectedBundle =
    '/private/tmp/clarus-worktree/src-tauri/target/release/bundle/macos/Clarus Music.app'
  const aliasExecutable = `${aliasBundle}/Contents/MacOS/simplemusic`
  const expectedExecutable = `${expectedBundle}/Contents/MacOS/simplemusic`
  const directory = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }
  const file = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }
  const filesystem = {
    lstat: async (pathname) => {
      if (pathname === aliasBundle) return directory
      if (pathname === aliasExecutable) return file
      throw new Error(`unexpected lstat ${pathname}`)
    },
    readFile: async (pathname) => {
      assert.equal(pathname, aliasExecutable)
      return Buffer.from('release executable')
    },
    realpath: async (pathname) => {
      if (pathname === aliasBundle || pathname === expectedBundle) return expectedBundle
      if (pathname === aliasExecutable) return expectedExecutable
      throw new Error(`unexpected realpath ${pathname}`)
    },
  }
  const runCommand = async (_executable, argv) => {
    const value = {
      CFBundleIdentifier: EXPECTED_BUNDLE_ID,
      CFBundleExecutable: 'simplemusic',
      CFBundleShortVersionString: '0.1.0',
    }[argv[1]]
    return { stdout: value }
  }

  const bundle = await readReleaseBundle({
    appBundlePath: aliasBundle,
    expectedBundlePath: expectedBundle,
    filesystem,
    runCommand,
  })
  assert.equal(bundle.appBundlePath, aliasBundle)
  assert.equal(bundle.executablePath, aliasExecutable)
  assert.equal(bundle.executableRealpath, expectedExecutable)

  await assert.rejects(
    readReleaseBundle({
      appBundlePath: '/private/tmp/old-worktree/Clarus Music.app',
      expectedBundlePath: expectedBundle,
      filesystem: {
        ...filesystem,
        lstat: async () => directory,
        realpath: async (pathname) =>
          pathname === expectedBundle
            ? expectedBundle
            : '/private/tmp/old-worktree/Clarus Music.app',
      },
      runCommand,
    }),
    /does not real-resolve to the expected worktree path/i,
  )
})

test('rejects missing, duplicate, outside, basename-only, and malformed helper evidence', () => {
  const missing = fixture()
  missing.snapshot = missing.snapshot.filter((entry) => entry.pid !== 4104)
  missing.infoByPid.delete(4104)
  assert.throws(() => attributeProcessTree({ rootPid: 4101, ...missing }), /missing.*networking/i)

  const duplicate = fixture()
  duplicate.snapshot.push(processRecord({ pid: 4202, path: DEFAULT_HELPER_PATHS['web-content'] }))
  duplicate.infoByPid.set(
    4202,
    infoRecord({
      pid: 4202,
      path: DEFAULT_HELPER_PATHS['web-content'],
      bundleId: 'com.apple.WebKit.WebContent',
    }),
  )
  assert.throws(
    () => attributeProcessTree({ rootPid: 4101, ...duplicate }),
    /duplicate.*web-content/i,
  )

  const outside = fixture()
  outside.snapshot.find((entry) => entry.pid === 4102).path = '/tmp/com.apple.WebKit.WebContent'
  outside.snapshot.find((entry) => entry.pid === 4102).realpath = '/tmp/com.apple.WebKit.WebContent'
  outside.infoByPid.set(
    4102,
    infoRecord({
      pid: 4102,
      path: '/tmp/com.apple.WebKit.WebContent',
      bundleId: 'com.apple.WebKit.WebContent',
    }),
  )
  assert.throws(() => attributeProcessTree({ rootPid: 4101, ...outside }), /outside.*web-content/i)

  const basenameOnly = fixture()
  basenameOnly.snapshot.find((entry) => entry.pid === 4102).path = 'com.apple.WebKit.WebContent'
  basenameOnly.snapshot.find((entry) => entry.pid === 4102).realpath = 'com.apple.WebKit.WebContent'
  assert.throws(() => attributeProcessTree({ rootPid: 4101, ...basenameOnly }), /absolute path/i)

  assert.throws(() => parsePsSnapshot('4101 bad start /path'), /malformed/i)
  assert.throws(() => parseLsappinfoApplications('bundleID="x"'), /malformed/i)
})

test('revalidation detects PID reuse, executable changes, and coalition drift', () => {
  const state = fixture()
  const baseline = attributeProcessTree({ rootPid: 4101, ...state })

  const pidReuse = fixture()
  pidReuse.snapshot.find((entry) => entry.pid === 4102).start = 'reused'
  assert.throws(() => revalidateAttribution({ baseline, rootPid: 4101, ...pidReuse }), /PID_REUSE/i)

  const executable = fixture()
  executable.snapshot.find((entry) => entry.pid === 4103).realpath = '/tmp/other-gpu'
  assert.throws(
    () => revalidateAttribution({ baseline, rootPid: 4101, ...executable }),
    /EXECUTABLE_DRIFT|outside/i,
  )

  const coalition = fixture()
  coalition.infoByPid.set(
    4104,
    infoRecord({
      pid: 4104,
      path: DEFAULT_HELPER_PATHS.networking,
      bundleId: 'com.apple.WebKit.Networking',
      coalition: { id: 'different', asn: '0x40009999' },
    }),
  )
  assert.throws(
    () => revalidateAttribution({ baseline, rootPid: 4101, ...coalition }),
    /COALITION_DRIFT|coalition/i,
  )
})

test('parses distinct ASN-owned LaunchServices records without choosing by process name', () => {
  const records = parseLsappinfoApplications(`
ASN: 0x40000017
pid=4101
bundleID="com.ovo3ovo3ovo.clarusmusic"
executable path="${EXECUTABLE}"

ASN: 0x40000099
pid=5101
bundleID="com.ovo3ovo3ovo.clarusmusic"
executable path="/Applications/Clarus Music.app/Contents/MacOS/simplemusic"
`)
  assert.equal(records.length, 2)
  assert.deepEqual(records[0].coalition, { id: 'asn:0x40000017', asn: '0x40000017' })
  assert.equal(records[1].path, '/Applications/Clarus Music.app/Contents/MacOS/simplemusic')
})

test('accepts launchd PID 1 in a process snapshot while keeping attribution roots above one', () => {
  const records = parsePsSnapshot(`1\t0\tlaunchd\t/sbin/launchd\n4101\t1\tapp\t${EXECUTABLE}`)
  assert.deepEqual(
    records.map(({ pid, ppid }) => ({ pid, ppid })),
    [
      { pid: 1, ppid: 0 },
      { pid: 4101, ppid: 1 },
    ],
  )
})

test('parses macOS lsappinfo list blocks by executable path and coalition', () => {
  const realExecutable =
    '/private/tmp/clarus-music-performance-phase-1/src-tauri/target/release/bundle/macos/Clarus Music.app/Contents/MacOS/simplemusic'
  const records = parseLsappinfoApplications(`
96) "Clarus Music" ASN:0x0-0x90a90a:
    bundleID="com.ovo3ovo3ovo.clarusmusic"
    bundle path="/private/tmp/clarus-music-performance-phase-1/src-tauri/target/release/bundle/macos/Clarus Music.app"
    executable path="${realExecutable}"
    pid = 92504 type="Foreground"
    coalition: 26560
97) "Clarus Music Networking" ASN:0x0-0x90b90b:
    bundleID="com.apple.WebKit.Networking"
    bundle path="/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc"
    executable path="/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking"
    pid = 92509 type="UIElement"
    coalition: 26561
98) "Clarus Music Web Content" ASN:0x0-0x90d90d:
    bundleID="com.apple.WebKit.WebContent"
    bundle path=[ NULL ]
    executable path="com.apple.WebKit.WebContent"
    pid = 92510 type="UIElement"
    coalition: 26562
`)
  assert.deepEqual(records, [
    {
      pid: 92504,
      path: realExecutable,
      realpath: realExecutable,
      bundleId: 'com.ovo3ovo3ovo.clarusmusic',
      coalition: { id: '26560', asn: '0x0-0x90a90a:' },
    },
    {
      pid: 92509,
      path: '/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking',
      realpath:
        '/System/Volumes/Preboot/Cryptexes/OS/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking',
      bundleId: 'com.apple.WebKit.Networking',
      coalition: { id: '26561', asn: '0x0-0x90b90b:' },
    },
  ])
})

test('parses a real lsappinfo info record using executable path rather than bundle path', () => {
  const realExecutable =
    '/private/tmp/clarus-music-performance-phase-1/src-tauri/target/release/bundle/macos/Clarus Music.app/Contents/MacOS/simplemusic'
  const record = parseLsappinfoInfo(`
"Clarus Music" ASN:0x0-0x90a90a:
    bundleID="com.ovo3ovo3ovo.clarusmusic"
    bundle path="/private/tmp/clarus-music-performance-phase-1/src-tauri/target/release/bundle/macos/Clarus Music.app"
    executable path="${realExecutable}"
    pid = 92504
    coalition: 26560
`)
  assert.equal(record.path, realExecutable)
  assert.equal(record.bundleId, 'com.ovo3ovo3ovo.clarusmusic')
  assert.deepEqual(record.coalition, { id: '26560', asn: '0x0-0x90a90a:' })
})

test('maps a basename-only WebContent info path to the verified ps executable', () => {
  const record = parseLsappinfoInfo(
    `
"Clarus Music Web Content" ASN:0x0-0x90d90d:
    bundleID="com.apple.WebKit.WebContent"
    bundle path=[ NULL ]
    executable path="com.apple.WebKit.WebContent"
    pid = 92510
    coalition: 26562
`,
    {
      fallbackPath: DEFAULT_HELPER_PATHS['web-content'],
      fallbackRealpath: DEFAULT_HELPER_PATHS['web-content'],
    },
  )
  assert.equal(record.path, DEFAULT_HELPER_PATHS['web-content'])
  assert.equal(record.realpath, DEFAULT_HELPER_PATHS['web-content'])
})
