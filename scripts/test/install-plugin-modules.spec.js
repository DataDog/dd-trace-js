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
const bunBinDir = path.dirname(bunBinary)
let bunTraceDirectory

describe('scripts/install_plugin_modules.js', function () {
  this.timeout(180_000)

  before(() => {
    bunTraceDirectory = createBunWrapper()
    if (!fs.existsSync(versionsDir)) return
    for (const entry of fs.readdirSync(versionsDir)) {
      if (entry === 'bunfig.toml') continue
      fs.rmSync(path.join(versionsDir, entry), { recursive: true, force: true })
    }
  })

  after(() => {
    fs.rmSync(bunTraceDirectory, { recursive: true, force: true })
  })

  it('installs every pino sandbox to a version satisfying its declared range, using bun (not yarn)', () => {
    const traceFile = path.join(bunTraceDirectory, 'trace.ndjson')
    runInstall('pino', bunTraceDirectory, traceFile)

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

    const pinoPrettyMetadataFields = fs.readFileSync(traceFile, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter(args => args[0] === 'pm' && args[1] === 'view' && args[2] === 'pino-pretty')
      .map(args => args[3])
      .sort()
    assert.deepStrictEqual(pinoPrettyMetadataFields, ['time', 'versions'])
  })

  it('defers package ranges to Bun when registry metadata is unavailable', () => {
    const traceFile = path.join(bunTraceDirectory, 'failed-metadata-trace.ndjson')
    const result = runInstall('express', bunTraceDirectory, traceFile, 'express')

    assert.match(result.stderr, /bun pm view failed for express:/)
  })

  it('skips a published package version inside the release-age window', () => {
    const traceFile = path.join(bunTraceDirectory, 'recent-metadata-trace.ndjson')
    runInstall('pino', bunTraceDirectory, traceFile, undefined, 'pino')

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
      PATH: `${binDirectory ?? bunBinDir}:/usr/bin:/bin`,
      ...(traceFile && { DD_BUN_TRACE_FILE: traceFile }),
      ...(metadataFailurePackage && { DD_BUN_FAIL_METADATA_PACKAGE: metadataFailurePackage }),
      ...(recentMetadataPackage && { DD_BUN_RECENT_METADATA_PACKAGE: recentMetadataPackage }),
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
function createBunWrapper () {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'dd-trace-bun-wrapper-'))
  const wrapper = path.join(directory, 'bun')
  fs.writeFileSync(wrapper, String.raw`#!${process.execPath}
'use strict'

const { spawnSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const args = process.argv.slice(2)
appendFileSync(process.env.DD_BUN_TRACE_FILE, JSON.stringify(args) + '\n')
if (args[0] === 'pm' && args[1] === 'view' && args[2] === process.env.DD_BUN_FAIL_METADATA_PACKAGE) process.exit(1)
if (args[0] === 'pm' && args[1] === 'view' && args[2] === process.env.DD_BUN_RECENT_METADATA_PACKAGE) {
  const output = args[3] === 'versions'
    ? ['4.17.5', '4.17.6']
    : { '4.17.5': '2000-01-01T00:00:00.000Z', '4.17.6': '2999-01-01T00:00:00.000Z' }
  process.stdout.write(JSON.stringify(output))
  process.exit(0)
}
const result = spawnSync(${JSON.stringify(bunBinary)}, args, { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
`)
  fs.chmodSync(wrapper, 0o755)
  return directory
}

function resolveBunBinary () {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
  const result = spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf8' })
  const located = result.stdout.trim()
  assert.ok(located, `could not locate bun on PATH (stderr: ${result.stderr.trim()})`)
  return located
}
