'use strict'

// `versions/bunfig.toml` pins the isolated linker. The constrained PATH removes yarn from the
// spawned child's lookup, so a regression that re-introduces it fails to launch.

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')

// eslint-disable-next-line n/no-restricted-require
const semver = require('semver')

const repoRoot = path.resolve(__dirname, '..', '..')
const installScript = path.join(repoRoot, 'scripts', 'install_plugin_modules.js')
const versionsDir = path.join(repoRoot, 'versions')
// Resolve the runtime location of bun. CI installs bun two different ways (the official
// `~/.bun/bin/bun` install script on dev machines and `npm install -g bun@<ver>` in the
// `actions/node` composite, which lands it under `npm prefix -g`), so a hard-coded path
// would silently fail on whichever environment doesn't match. Honour `BUN_BIN` for
// explicit overrides, fall back to a `which bun` lookup against the current PATH.
const bunBinary = resolveBunBinary()
const npmBinary = resolveBinary('npm')
let wrapperDirectory

describe('scripts/install_plugin_modules.js', function () {
  this.timeout(180_000)

  before(() => {
    wrapperDirectory = createPackageManagerWrappers()
    if (!fs.existsSync(versionsDir)) return
    for (const entry of fs.readdirSync(versionsDir)) {
      if (entry === 'bunfig.toml') continue
      fs.rmSync(path.join(versionsDir, entry), { recursive: true, force: true })
    }
  })

  after(() => {
    fs.rmSync(wrapperDirectory, { recursive: true, force: true })
  })

  it('installs every pino sandbox to a version satisfying its declared range, using bun (not yarn)', () => {
    const traceFile = path.join(wrapperDirectory, 'trace.ndjson')
    runInstall('pino', wrapperDirectory, traceFile)

    const sandboxFolders = fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('pino@'))
      .map(entry => entry.name)
      .sort()

    assert.ok(
      sandboxFolders.length >= 4,
      `expected at least four pino@<ver> sandboxes (two ranges × {coerced, raw}), got: ${sandboxFolders.join(', ')}`
    )

    const resolvedVersions = {}
    const expectedVersions = {}
    for (const folder of sandboxFolders) {
      // Resolve from inside the sandbox so the assertion follows the same lookup path as the plugin tests.
      const sandboxIndex = path.join(versionsDir, folder, 'index.js')
      const sandboxRequire = createRequire(sandboxIndex)
      const resolved = JSON.parse(fs.readFileSync(sandboxRequire.resolve('pino/package.json'), 'utf8')).version
      const declaredRange = folder.slice('pino@'.length)
      resolvedVersions[folder] = resolved
      expectedVersions[folder] = semver.satisfies(resolved, declaredRange)
        ? resolved
        : `range '${declaredRange}' violated by '${resolved}'`
    }

    assert.deepStrictEqual(resolvedVersions, expectedVersions)

    const pinoPrettyMetadataCalls = fs.readFileSync(traceFile, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter(args => args[0] === 'npm' && args[1] === 'view' && args[2] === 'pino-pretty')
    assert.deepStrictEqual(pinoPrettyMetadataCalls, [
      ['npm', 'view', 'pino-pretty', 'time', 'versions', '--json', '--update-notifier=false'],
    ])
  })

  it('defers package ranges to Bun when registry metadata is unavailable', () => {
    const traceFile = path.join(wrapperDirectory, 'failed-metadata-trace.ndjson')
    const result = runInstall('express', wrapperDirectory, traceFile, 'express')

    assert.match(result.stderr, /npm view failed for express:/)
  })

  it('skips a published package version inside the release-age window', () => {
    const traceFile = path.join(wrapperDirectory, 'recent-metadata-trace.ndjson')
    runInstall('pino', wrapperDirectory, traceFile, undefined, 'pino')

    for (const folder of ['pino', 'pino@4']) {
      const manifest = require(path.join(versionsDir, folder, 'package.json'))
      assert.strictEqual(manifest.dependencies.pino, '4.17.5')
    }
  })

  it('ignores unpublished versions left in registry time metadata', () => {
    runInstall('mariadb')

    const manifest = require(path.join(versionsDir, 'mariadb@2', 'package.json'))
    assert.strictEqual(manifest.dependencies.mariadb, '2.5.6')
  })

  it('does not require latest-version caps for forced transitive dependencies', () => {
    runInstall('google-cloud-vertexai')

    const manifest = require(path.join(versionsDir, '@google-cloud', 'vertexai', 'package.json'))
    assert.match(manifest.dependencies['google-auth-library'], /^9\./)
  })

  it('normalizes unprefixed GitHub shorthand dependencies for Bun', () => {
    runInstall('limitd-client')

    const manifest = require(path.join(versionsDir, 'package.json'))
    assert.strictEqual(manifest.overrides.hashlru, 'github:jfromaniello/hashlru#return_value_on_set')
  })
})

/**
 * @param {string} plugin
 * @param {string} [binDirectory]
 * @param {string} [traceFile]
 * @param {string} [metadataFailurePackage]
 * @param {string} [recentMetadataPackage]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runInstall (plugin, binDirectory, traceFile, metadataFailurePackage, recentMetadataPackage) {
  const result = spawnSync(process.execPath, [installScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLUGINS: plugin,
      PATH: `${binDirectory ?? wrapperDirectory}:/usr/bin:/bin`,
      ...(traceFile && { DD_TEST_PACKAGE_MANAGER_TRACE_FILE: traceFile }),
      ...(metadataFailurePackage && { DD_TEST_FAIL_METADATA_PACKAGE: metadataFailurePackage }),
      ...(recentMetadataPackage && { DD_TEST_RECENT_METADATA_PACKAGE: recentMetadataPackage }),
    },
  })

  assert.strictEqual(
    result.status,
    0,
    `install_plugin_modules.js exited with status ${result.status} (signal ${result.signal}).\n` +
      `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  )
  return result
}

/**
 * @returns {string}
 */
function createPackageManagerWrappers () {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'dd-trace-bun-wrapper-'))
  const bunWrapper = path.join(directory, 'bun')
  fs.writeFileSync(bunWrapper, String.raw`#!${process.execPath}
'use strict'

const { spawnSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const args = process.argv.slice(2)
if (process.env.DD_TEST_PACKAGE_MANAGER_TRACE_FILE) {
  appendFileSync(process.env.DD_TEST_PACKAGE_MANAGER_TRACE_FILE, JSON.stringify(['bun', ...args]) + '\n')
}
const result = spawnSync(${JSON.stringify(bunBinary)}, args, { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
`)
  fs.chmodSync(bunWrapper, 0o755)

  const npmWrapper = path.join(directory, 'npm')
  fs.writeFileSync(npmWrapper, String.raw`#!${process.execPath}
'use strict'

const { spawnSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const args = process.argv.slice(2)
if (process.env.DD_TEST_PACKAGE_MANAGER_TRACE_FILE) {
  appendFileSync(process.env.DD_TEST_PACKAGE_MANAGER_TRACE_FILE, JSON.stringify(['npm', ...args]) + '\n')
}
if (args[0] === 'view' && args[1] === process.env.DD_TEST_FAIL_METADATA_PACKAGE) process.exit(1)
if (args[0] === 'view' && args[1] === process.env.DD_TEST_RECENT_METADATA_PACKAGE) {
  process.stdout.write(JSON.stringify({
    versions: ['4.17.5', '4.17.6'],
    time: {
      '4.17.5': '2000-01-01T00:00:00.000Z',
      '4.17.6': '2999-01-01T00:00:00.000Z',
    },
  }))
  process.exit(0)
}
const result = spawnSync(process.execPath, [${JSON.stringify(npmBinary)}, ...args], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
`)
  fs.chmodSync(npmWrapper, 0o755)
  return directory
}

function resolveBunBinary () {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
  return resolveBinary('bun')
}

/**
 * @param {string} name
 * @returns {string}
 */
function resolveBinary (name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
  const located = result.stdout.trim()
  assert.ok(located, `could not locate ${name} on PATH (stderr: ${result.stderr.trim()})`)
  return located
}
