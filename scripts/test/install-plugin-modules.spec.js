'use strict'

// `versions/bunfig.toml` pins the hoisted linker. The constrained PATH removes yarn from the
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
    assert.strictEqual(resolvedVersions['pino@4'], '4.17.6')
    assert.strictEqual(resolvedVersions['pino@5'], '5.17.0')
    assert.strictEqual(resolvedVersions['pino@>=5 <6.8.0'], '6.7.0')
    assert.strictEqual(fs.existsSync(path.join(versionsDir, 'node_modules', '.bun')), false)
    assert.deepStrictEqual(readVersionsManifest().trustedDependencies, ['pino', 'pino-pretty'])

    const lockPath = path.join(versionsDir, 'bun.lock')
    const firstLock = fs.readFileSync(lockPath, 'utf8')
    runInstall('pino')
    assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), firstLock)

    const packageManagerCalls = fs.readFileSync(traceFile, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.deepStrictEqual(packageManagerCalls, [
      ['bun', 'install', '--trust'],
      ['bun', 'install', '--trust'],
      ['bun', 'install', '--trust'],
      ['bun', 'install', '--trust'],
      ['bun', 'install', '--trust'],
      ['bun', 'install', '--trust'],
    ])
  })

  it('removes the shared Bun store when the Node ABI changes', () => {
    const staleMarker = path.join(versionsDir, 'node_modules', 'stale-abi-marker')
    fs.mkdirSync(path.dirname(staleMarker), { recursive: true })
    fs.writeFileSync(path.join(versionsDir, '.node-abi'), 'stale')
    fs.writeFileSync(staleMarker, '')

    runInstall('pino')

    assert.strictEqual(fs.existsSync(staleMarker), false)
  })

  it('reports guidance when Bun cannot install the generated workspaces', () => {
    const result = spawnInstall('express', {
      DD_TEST_FAIL_BUN_INSTALL: 'true',
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /If a plugin declares a version range that spans a major version that was never/)
    assert.match(result.stderr, /Original error:/)
  })

  it('does not retry a failed install against partial state', () => {
    const traceFile = path.join(wrapperDirectory, 'failed-install-trace.ndjson')
    const failureMarker = path.join(wrapperDirectory, 'failed-install')
    const result = spawnInstall('not-a-plugin', {
      DD_TEST_FAIL_BUN_INSTALL_ONCE_FILE: failureMarker,
      DD_TEST_PACKAGE_MANAGER_TRACE_FILE: traceFile,
    })

    assert.strictEqual(result.status, 1)
    assert.deepStrictEqual(
      fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(JSON.parse),
      [['bun', 'install', '--trust']]
    )
  })

  it('rejects conflicting declarative overrides', () => {
    const preload = path.join(wrapperDirectory, 'conflicting-overrides.js')
    fs.writeFileSync(preload, `
const externals = require(${JSON.stringify(path.join(repoRoot, 'packages/dd-trace/test/plugins/externals'))})
externals.express.push(
  { name: 'axios', overrides: { axios: '1' } },
  { name: 'axios', overrides: { axios: '2' } }
)
`)

    const result = spawnInstall('express', {
      NODE_OPTIONS: `--require=${preload}`,
    })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /Conflicting overrides for 'axios': '1' and '2'/)
  })

  // Both forms are what a reader reaches for when a single sandbox needs a different transitive, and Bun
  // takes either into the manifest and then ignores it.
  for (const [label, override, rejected] of [
    ['a Yarn-style selective path', "{ 'axios@1.0.0/follow-redirects': '^1' }", 'axios@1.0.0/follow-redirects'],
    ['an npm-style nested object', "{ axios: { 'follow-redirects': '^1' } }", 'axios'],
  ]) {
    it(`rejects ${label}, which Bun would silently ignore`, () => {
      const preload = path.join(wrapperDirectory, `override-${rejected.replaceAll(/\W/g, '-')}.js`)
      fs.writeFileSync(preload, `
const externals = require(${JSON.stringify(path.join(repoRoot, 'packages/dd-trace/test/plugins/externals'))})
externals.express.push({ name: 'axios', overrides: ${override} })
`)

      const result = spawnInstall('express', {
        NODE_OPTIONS: `--require=${preload}`,
      })

      assert.strictEqual(result.status, 1)
      assert.ok(result.stderr.includes(`Override '${rejected}' cannot be expressed as a Bun override`), result.stderr)
    })
  }

  it('supports a plugin filter that generates no workspaces', () => {
    fs.rmSync(path.join(versionsDir, 'node_modules'), { recursive: true, force: true })
    fs.rmSync(path.join(versionsDir, 'bun.lock'), { force: true })

    runInstall('not-a-plugin')
  })

  it('pins pubsub to a compatible grpc module instance', () => {
    runInstall('google-cloud-pubsub')

    const manifest = require(path.join(versionsDir, '@google-cloud', 'pubsub@1.2.0', 'package.json'))
    assert.strictEqual(semver.subset(manifest.dependencies['@grpc/grpc-js'], '~1.3.6'), true)
    const pubsub = require(path.join(versionsDir, '@google-cloud', 'pubsub@1.2.0'))
    const grpcVersion = JSON.parse(fs.readFileSync(pubsub.pkgJsonPath('@grpc/grpc-js'), 'utf8')).version
    assert.strictEqual(semver.satisfies(grpcVersion, '~1.3.6'), true)
    const directGrpcPath = fs.realpathSync(pubsub.getPath('@grpc/grpc-js'))
    const pubsubGrpcPath = fs.realpathSync(createRequire(pubsub.getPath()).resolve('@grpc/grpc-js'))
    assert.strictEqual(pubsubGrpcPath, directGrpcPath)
    assert.strictEqual(readVersionsManifest().overrides['@grpc/grpc-js'], '~1.3.6')
  })

  it('pins the Claude Agent SDK dependencies to compatible versions', () => {
    runInstall('claude-agent-sdk')

    const manifest = require(path.join(versionsDir, '@anthropic-ai', 'claude-agent-sdk', 'package.json'))
    assert.strictEqual(semver.subset(manifest.dependencies.zod, '^4.0.0'), true)

    const exactSdk = require(path.join(versionsDir, '@anthropic-ai', 'claude-agent-sdk@0.2.113'))
    const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    const sdkVersion = exactSdk.version()
    const platformVersion = JSON.parse(fs.readFileSync(exactSdk.pkgJsonPath(platformPackage), 'utf8')).version
    assert.strictEqual(platformVersion, sdkVersion)
  })

  it('keeps scoped package identities portable across path separators', () => {
    const preload = path.join(wrapperDirectory, 'windows-package-separators.js')
    fs.writeFileSync(preload, `
const path = require('node:path')
const nativeJoin = path.join
path.posix = { ...path.posix, join: nativeJoin }
/**
 * @param {...string} parts
 */
path.join = function join (...parts) {
  return parts[0].startsWith('@') ? path.win32.join(...parts) : nativeJoin(...parts)
}
`)

    runInstall('claude-agent-sdk', undefined, undefined, {
      NODE_OPTIONS: `--require=${preload}`,
    })

    const manifest = require(path.join(versionsDir, '@anthropic-ai', 'claude-agent-sdk', 'package.json'))
    assert.ok(manifest.dependencies.zod, 'expected the scoped workspace to receive its peer dependency')
    assert.strictEqual(semver.subset(manifest.dependencies.zod, '^4.0.0'), true)
  })

  it('trusts the transitive native builder required by pg-native', () => {
    runInstall('pg')

    assert.ok(readVersionsManifest().trustedDependencies.includes('libpq'))
  })

  it('scopes the q transitive override to q sandboxes', () => {
    runInstall('q')

    assert.deepStrictEqual(readVersionsManifest().overrides, {
      collections: '^5.0.0',
    })
    require(path.join(versionsDir, 'q')).get()
  })

  it('scopes the recorded OpenAI dependency graph to langchain sandboxes', () => {
    runInstall('langchain')

    // No override pins `@langchain/core` here. A workspace-wide one would drag langgraph's `>=1.1.16`
    // sandboxes down to the 0.2 line, and Bun ignores a selective one, so the range is left to
    // `@langchain/openai@0.0.34`'s own declaration — which is what the assertion below verifies.
    assert.deepStrictEqual(readVersionsManifest().overrides, {})
    const manifest = require(path.join(versionsDir, 'langchain', 'package.json'))
    assert.strictEqual(manifest.dependencies['@langchain/openai'], '0.0.34')
    const langchain = require(path.join(versionsDir, 'langchain'))
    const requireFromOpenAI = createRequire(langchain.getPath('@langchain/openai'))
    const coreVersion = requireFromOpenAI('@langchain/core/package.json').version
    assert.strictEqual(semver.satisfies(coreVersion, '^0.2.0'), true)
  })
})

/**
 * @returns {{ trustedDependencies: string[], overrides: Record<string, string> }}
 */
function readVersionsManifest () {
  return JSON.parse(fs.readFileSync(path.join(versionsDir, 'package.json'), 'utf8'))
}

/**
 * @param {string} plugin
 * @param {string} [binDirectory]
 * @param {string} [traceFile]
 * @param {Record<string, string | undefined>} [env]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runInstall (plugin, binDirectory, traceFile, env) {
  const result = spawnInstall(plugin, {
    PATH: `${binDirectory ?? wrapperDirectory}:/usr/bin:/bin`,
    ...(traceFile && { DD_TEST_PACKAGE_MANAGER_TRACE_FILE: traceFile }),
    ...env,
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
 * @param {string} plugin
 * @param {Record<string, string | undefined>} [env]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function spawnInstall (plugin, env = {}) {
  return spawnSync(process.execPath, [installScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLUGINS: plugin,
      PATH: `${wrapperDirectory}:/usr/bin:/bin`,
      ...env,
    },
  })
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
const { appendFileSync, existsSync, writeFileSync } = require('node:fs')

const args = process.argv.slice(2)
if (process.env.DD_TEST_PACKAGE_MANAGER_TRACE_FILE) {
  appendFileSync(process.env.DD_TEST_PACKAGE_MANAGER_TRACE_FILE, JSON.stringify(['bun', ...args]) + '\n')
}
if (process.env.DD_TEST_FAIL_BUN_INSTALL === 'true' && args[0] === 'install') process.exit(1)
if (process.env.DD_TEST_FAIL_BUN_INSTALL_ONCE_FILE &&
    args[0] === 'install' &&
    !existsSync(process.env.DD_TEST_FAIL_BUN_INSTALL_ONCE_FILE)) {
  writeFileSync(process.env.DD_TEST_FAIL_BUN_INSTALL_ONCE_FILE, '')
  process.exit(1)
}
const result = spawnSync(${JSON.stringify(bunBinary)}, args, { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
`)
  fs.chmodSync(bunWrapper, 0o755)

  fs.linkSync(process.execPath, path.join(directory, path.basename(process.execPath)))

  const npmWrapper = path.join(directory, 'npm')
  fs.writeFileSync(npmWrapper, String.raw`#!${process.execPath}
'use strict'

const { spawnSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')

const args = process.argv.slice(2)
if (process.env.DD_TEST_PACKAGE_MANAGER_TRACE_FILE) {
  appendFileSync(process.env.DD_TEST_PACKAGE_MANAGER_TRACE_FILE, JSON.stringify(['npm', ...args]) + '\n')
}
process.exit(1)
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
