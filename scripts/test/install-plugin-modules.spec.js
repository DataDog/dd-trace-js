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
    assert.deepStrictEqual(readVersionsManifest().trustedDependencies, ['pino', 'pino-pretty'])

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

  it('supports a plugin filter that generates no workspaces', () => {
    fs.rmSync(path.join(versionsDir, 'node_modules'), { recursive: true, force: true })
    fs.rmSync(path.join(versionsDir, 'bun.lock'), { force: true })

    runInstall('not-a-plugin')
  })

  it('ignores malformed entries in Bun\'s central store', () => {
    runInstall('pino')
    const dotBun = path.join(versionsDir, 'node_modules', '.bun')
    fs.mkdirSync(path.join(dotBun, 'malformed'), { recursive: true })
    fs.mkdirSync(path.join(dotBun, 'package@'), { recursive: true })

    runInstall('pino')
  })

  it('does not require latest-version caps for forced transitive dependencies', () => {
    runInstall('google-cloud-vertexai')

    const manifest = require(path.join(versionsDir, '@google-cloud', 'vertexai', 'package.json'))
    assert.strictEqual(semver.subset(manifest.dependencies['google-auth-library'], '^9.0.0'), true)
    const vertexAI = require(path.join(versionsDir, '@google-cloud', 'vertexai'))
    const directAuthPath = fs.realpathSync(vertexAI.getPath('google-auth-library'))
    const vertexAuthPath = fs.realpathSync(createRequire(vertexAI.getPath()).resolve('google-auth-library'))
    assert.strictEqual(vertexAuthPath, directAuthPath)
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
  })

  it('makes the Bedrock HTTP handler reachable from its sandbox', () => {
    runInstall('aws-sdk')

    const bedrockFolder = path.join(versionsDir, '@aws-sdk', 'client-bedrock-runtime@3.422.0')
    const manifest = require(path.join(bedrockFolder, 'package.json'))
    assert.ok(semver.validRange(manifest.dependencies['@smithy/node-http-handler']))
    require(bedrockFolder).get('@smithy/node-http-handler')
  })

  it('injects a forced dependency missing from the package manifest', () => {
    runInstall('moleculer')

    const manifest = require(path.join(versionsDir, 'moleculer', 'package.json'))
    assert.strictEqual(manifest.dependencies.bluebird, '3.7.2')
  })

  it('makes the sqlite build dependency direct in knex sandboxes', () => {
    runInstall('knex')

    const manifest = require(path.join(versionsDir, 'knex@1', 'package.json'))
    assert.strictEqual(manifest.dependencies.tar, '7.5.4')
  })

  it('pins the Claude Agent SDK to its compatible zod major', () => {
    runInstall('claude-agent-sdk')

    const manifest = require(path.join(versionsDir, '@anthropic-ai', 'claude-agent-sdk', 'package.json'))
    assert.strictEqual(semver.subset(manifest.dependencies.zod, '^4.0.0'), true)
  })

  it('trusts the transitive native builder required by pg-native', () => {
    runInstall('pg')

    assert.ok(readVersionsManifest().trustedDependencies.includes('libpq'))
  })

  it('normalizes unprefixed GitHub shorthand dependencies for Bun', () => {
    runInstall('limitd-client')

    const manifest = readVersionsManifest()
    assert.strictEqual(manifest.overrides.hashlru, 'github:jfromaniello/hashlru#return_value_on_set')
  })

  it('scopes the q transitive override to q sandboxes', () => {
    runInstall('q')

    assert.deepStrictEqual(readVersionsManifest().overrides, {
      collections: '^5.0.0',
    })
    require(path.join(versionsDir, 'q')).get()
  })

  it('scopes the ai dependency repairs to ai sandboxes', () => {
    runInstall('ai')

    assert.deepStrictEqual(readVersionsManifest().overrides, {
      'zod-to-json-schema': '<3.25.0',
    })
    const manifest = require(path.join(versionsDir, 'ai', 'package.json'))
    assert.strictEqual(semver.subset(manifest.dependencies.zod, '^3.0.0'), true)
    require(path.join(versionsDir, 'ai@4.0.2')).get()
  })

  it('scopes the recorded OpenAI dependency graph to langchain sandboxes', () => {
    runInstall('langchain')

    assert.deepStrictEqual(readVersionsManifest().overrides, {
      '@langchain/openai@0.0.34/@langchain/core': '^0.2.0',
    })
    const manifest = require(path.join(versionsDir, 'langchain', 'package.json'))
    assert.strictEqual(manifest.dependencies['@langchain/openai'], '0.0.34')
    const langchain = require(path.join(versionsDir, 'langchain'))
    const requireFromOpenAI = createRequire(langchain.getPath('@langchain/openai'))
    const coreVersion = requireFromOpenAI('@langchain/core/package.json').version
    assert.strictEqual(semver.satisfies(coreVersion, '^0.2.0'), true)
  })
})

function readVersionsManifest () {
  return JSON.parse(fs.readFileSync(path.join(versionsDir, 'package.json'), 'utf8'))
}

/**
 * @param {string} plugin
 * @param {string} [binDirectory]
 * @param {string} [traceFile]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runInstall (plugin, binDirectory, traceFile) {
  const result = spawnInstall(plugin, {
    PATH: `${binDirectory ?? wrapperDirectory}:/usr/bin:/bin`,
    ...(traceFile && { DD_TEST_PACKAGE_MANAGER_TRACE_FILE: traceFile }),
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
 * @param {NodeJS.ProcessEnv} [env]
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
const { appendFileSync } = require('node:fs')

const args = process.argv.slice(2)
if (process.env.DD_TEST_PACKAGE_MANAGER_TRACE_FILE) {
  appendFileSync(process.env.DD_TEST_PACKAGE_MANAGER_TRACE_FILE, JSON.stringify(['bun', ...args]) + '\n')
}
if (process.env.DD_TEST_FAIL_BUN_INSTALL === 'true' && args[0] === 'install') process.exit(1)
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
