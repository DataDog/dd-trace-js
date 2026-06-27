'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { describe, it, before, after } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

const LOADER_PATH = '../../src/opentelemetry/api'

// A nested entrypoint (build/src/index.js, as the real package ships) so the version
// reader has to walk up directories to find the package's own package.json.
function nestedEntry (packageName) {
  return `/app/node_modules/${packageName}/build/src/index.js`
}

/**
 * Builds a `require`-like stub that resolves a package to `api`.
 *
 * @param {object} api - The module object to return for the package.
 * @param {string} resolvePath - Path returned by `require.resolve`.
 * @returns {sinon.SinonStub}
 */
function fakeRequire (api, resolvePath) {
  const req = sinon.stub().returns(api)
  req.resolve = sinon.stub().returns(resolvePath)
  return req
}

/**
 * @param {object} [options]
 * @param {string} [options.packageName] - The OTel API package the loader resolves.
 * @param {number} [options.ddMajor] - Value of the mocked `DD_MAJOR` constant.
 * @param {sinon.SinonStub} [options.appRequire] - `require` returned by `createRequire`.
 * @param {object} [options.ddApi] - Copy returned by dd-trace's own `require`.
 * @param {string} [options.version] - Version reported for the resolved copy.
 * @param {string} [options.range] - Declared package range.
 * @param {string} [options.depField] - package.json field that declares the range.
 * @param {boolean} [options.versionReadable] - When false, no package.json can be read.
 * @param {boolean} [options.missing] - When true, requiring the package throws.
 */
function buildLoader ({
  packageName = '@opentelemetry/api', ddMajor = 6, appRequire, ddApi = { copy: 'dd-trace' }, version = '1.9.0',
  range = '>=1.0.0 <1.10.0', depField = 'peerDependencies', versionReadable = true, missing = false,
} = {}) {
  const warn = sinon.spy()
  const createRequire = sinon.stub()
  if (appRequire) createRequire.returns(appRequire)

  const packageJsonSuffix = `${packageName}/package.json`
  const stubs = {
    '../../../../version': { DD_MAJOR: ddMajor },
    '../log': { warn },
    '../../../../package.json': { [depField]: { [packageName]: range } },
    'node:fs': {
      // The package's own package.json only lives at the package root, so the loader
      // must walk up from the nested entrypoint; everything in between throws ENOENT.
      // path.join normalizes to the platform separator, so match on '/' after a rewrite.
      readFileSync (path) {
        if (versionReadable && path.replaceAll('\\', '/').endsWith(packageJsonSuffix)) {
          return JSON.stringify({ name: packageName, version })
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    },
    'node:module': { createRequire },
  }

  // A `null` stub makes proxyquire throw MODULE_NOT_FOUND for that require.
  stubs[packageName] = missing ? null : Object.assign(ddApi, { '@noCallThru': true })

  const otelApi = proxyquire(LOADER_PATH, stubs)
  return { loader: otelApi.forPackage(packageName), warn, createRequire, ddApi }
}

describe('opentelemetry/api loader', () => {
  it('resolves dd-trace\'s own copy on v6 without consulting the application entrypoint', () => {
    const { loader, createRequire, ddApi } = buildLoader({ ddMajor: 6 })
    assert.strictEqual(loader.load(), ddApi)
    assert.strictEqual(loader.isAvailable(), true)
    assert.ok(createRequire.notCalled)
  })

  it('prefers the application copy on v5', () => {
    const appApi = { copy: 'app' }
    const appRequire = fakeRequire(appApi, nestedEntry('@opentelemetry/api'))
    const { loader, createRequire } = buildLoader({ ddMajor: 5, appRequire })
    assert.strictEqual(loader.load(), appApi)
    assert.ok(createRequire.calledOnce)
  })

  it('falls back to dd-trace\'s bundled copy on v5 when the application copy is absent', () => {
    const appRequire = sinon.stub().throws(new Error('not found'))
    appRequire.resolve = sinon.stub().throws(new Error('not found'))
    const { loader, ddApi } = buildLoader({ ddMajor: 5, appRequire })
    assert.strictEqual(loader.load(), ddApi)
  })

  it('throws a clear error and reports unavailable when not installed', () => {
    const { loader } = buildLoader({ missing: true })
    assert.strictEqual(loader.isAvailable(), false)
    assert.throws(() => loader.load(), { message: /@opentelemetry\/api is not installed/ })
  })

  it('warns when the resolved version is at the unsupported upper bound', () => {
    const { loader, warn } = buildLoader({ version: '1.10.0' })
    loader.load()
    assert.ok(warn.calledOnce)
    assert.match(warn.firstCall.args[0], /outside the range dd-trace supports/)
    assert.ok(warn.firstCall.args.includes('1.10.0'))
  })

  it('warns when the resolved major is above the supported range', () => {
    const { loader, warn } = buildLoader({ version: '2.0.0' })
    loader.load()
    assert.ok(warn.calledOnce)
  })

  it('does not warn when the resolved version is the last supported one', () => {
    const { loader, warn } = buildLoader({ version: '1.9.0' })
    loader.load()
    assert.ok(warn.notCalled)
  })

  it('reads the supported range from optionalDependencies when declared there (v5)', () => {
    const { loader, warn } = buildLoader({ version: '1.10.0', depField: 'optionalDependencies' })
    loader.load()
    assert.ok(warn.calledOnce)
  })

  it('loads without warning or crashing when the version cannot be determined', () => {
    const { loader, warn, ddApi } = buildLoader({ versionReadable: false })
    assert.strictEqual(loader.load(), ddApi)
    assert.ok(warn.notCalled)
  })

  it('warns at most once across repeated loads', () => {
    const { loader, warn } = buildLoader({ version: '1.10.0' })
    loader.load()
    loader.load()
    loader.isAvailable()
    assert.ok(warn.calledOnce)
  })
})

// The logs pipeline shares @opentelemetry/api-logs the same way, through forPackage().
// Its declared range is the pre-1.0 `<1.0.0`, and its unsupported-version consequence
// is dropped log records rather than no-op spans.
describe('opentelemetry/api loader for @opentelemetry/api-logs', () => {
  const packageName = '@opentelemetry/api-logs'

  it('resolves dd-trace\'s own copy on v6', () => {
    const { loader, createRequire, ddApi } = buildLoader({ packageName, range: '<1.0.0', version: '0.212.0' })
    assert.strictEqual(loader.load(), ddApi)
    assert.strictEqual(loader.isAvailable(), true)
    assert.ok(createRequire.notCalled)
  })

  it('prefers the application copy on v5', () => {
    const appApi = { copy: 'app-logs' }
    const appRequire = fakeRequire(appApi, nestedEntry(packageName))
    const { loader } = buildLoader({ packageName, ddMajor: 5, range: '<1.0.0', appRequire })
    assert.strictEqual(loader.load(), appApi)
  })

  it('throws a clear error and reports unavailable when not installed', () => {
    const { loader } = buildLoader({ packageName, range: '<1.0.0', missing: true })
    assert.strictEqual(loader.isAvailable(), false)
    assert.throws(() => loader.load(), { message: /@opentelemetry\/api-logs is not installed/ })
  })

  it('warns about dropped log records at the first unsupported version', () => {
    const { loader, warn } = buildLoader({ packageName, range: '<1.0.0', version: '1.0.0' })
    loader.load()
    assert.ok(warn.calledOnce)
    assert.match(warn.firstCall.args[0], /outside the range dd-trace supports/)
    assert.ok(warn.firstCall.args.includes('1.0.0'))
    assert.ok(warn.firstCall.args.includes('OpenTelemetry log records may be dropped.'))
  })

  it('does not warn at the last supported version', () => {
    const { loader, warn } = buildLoader({ packageName, range: '<1.0.0', version: '0.999.0' })
    loader.load()
    assert.ok(warn.notCalled)
  })
})

// The v5 path roots application resolution at the entrypoint. A directory entrypoint
// (`node .`, `node path/to/app`) sets process.argv[1] to the directory while
// require.main.filename holds the resolved file; createRequire rooted at the directory
// resolves from its parent and misses the app's own @opentelemetry/api (issue #6882).
// require.main can't be faked per-module in-process, so a real child launched with each
// entrypoint shape is the only place the two globals diverge as they do in production.
describe('opentelemetry/api loader application entrypoint (v5)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dd-trace-otel-entry-'))
  const appDir = join(root, 'app')
  const appEntry = join(appDir, 'index.js')
  const apiDir = join(appDir, 'node_modules', '@opentelemetry', 'api')

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  before(() => {
    mkdirSync(apiDir, { recursive: true })
    writeFileSync(join(apiDir, 'package.json'), JSON.stringify({ name: '@opentelemetry/api', version: '1.9.0' }))
    writeFileSync(join(apiDir, 'index.js'), 'module.exports = { COPY: \'app\' }\n')
    // Forces the v5 path (DD_MAJOR mocked) so applicationRequire actually runs; the real
    // require.main / process.argv[1] of this child drive the resolution base under test.
    writeFileSync(appEntry, [
      'const proxyquire = require(' + JSON.stringify(require.resolve('proxyquire')) + ')',
      'const { load } = proxyquire(' + JSON.stringify(require.resolve('../../src/opentelemetry/api')) + ', {',
      '  \'../../../../version\': { DD_MAJOR: 5, \'@noCallThru\': true },',
      '})',
      'try { process.stdout.write(load().COPY ?? \'no-copy\') } catch { process.stdout.write(\'threw\') }',
    ].join('\n') + '\n')
  })

  /**
   * Launches the fixture app with a given entrypoint argument and returns what copy of
   * `@opentelemetry/api` the loader resolved (`'app'` when the application's copy won).
   *
   * @param {string} entrypoint - The path passed to `node` (directory or file).
   * @returns {string}
   */
  function resolvedCopy (entrypoint) {
    return execFileSync(process.execPath, [entrypoint], { encoding: 'utf8' })
  }

  it('resolves the application copy for a directory entrypoint (node path/to/app)', () => {
    assert.strictEqual(resolvedCopy(appDir), 'app')
  })

  it('resolves the application copy for a file entrypoint (node path/to/app/index.js)', () => {
    assert.strictEqual(resolvedCopy(appEntry), 'app')
  })
})

// The stubbed suite above fakes node:fs, so it cannot catch a separator mismatch between
// path.join (platform-native) and the version walk. This suite writes a real package tree
// and lets the production node:fs/node:path run, so the walk is exercised on every platform.
describe('opentelemetry/api loader version walk on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'dd-trace-otel-api-'))
  const packageDir = join(root, 'node_modules', '@opentelemetry', 'api')
  const entry = join(packageDir, 'build', 'src', 'index.js')

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * Builds the loader pointed at a real `@opentelemetry/api` tree, faking only the
   * application `require` and the supported range. node:fs and node:path stay real.
   *
   * @param {string} version - Version written to the on-disk package.json.
   * @returns {{ loader: { load: () => object }, warn: sinon.SinonSpy }}
   */
  function buildDiskLoader (version) {
    mkdirSync(join(packageDir, 'build', 'src'), { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@opentelemetry/api', version }))
    writeFileSync(entry, '')

    const warn = sinon.spy()
    const appApi = { copy: 'app', '@noCallThru': true }
    const loader = proxyquire(LOADER_PATH, {
      '../../../../version': { DD_MAJOR: 5 },
      '../log': { warn },
      '../../../../package.json': { peerDependencies: { '@opentelemetry/api': '>=1.0.0 <1.10.0' } },
      'node:module': { createRequire: sinon.stub().returns(fakeRequire(appApi, entry)) },
      '@opentelemetry/api': appApi,
    })
    return { loader, warn }
  }

  it('reads the version from a nested entrypoint and warns when unsupported', () => {
    const { loader, warn } = buildDiskLoader('1.10.0')
    loader.load()
    assert.ok(warn.calledOnce)
    assert.match(warn.firstCall.args[0], /outside the range dd-trace supports/)
  })

  it('reads the version from a nested entrypoint and stays silent when supported', () => {
    const { loader, warn } = buildDiskLoader('1.9.0')
    loader.load()
    assert.ok(warn.notCalled)
  })
})
