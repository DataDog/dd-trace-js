'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { describe, it, after } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

const LOADER_PATH = '../../src/opentelemetry/api'

// A nested entrypoint (build/src/index.js, as the real package ships) so the version
// reader has to walk up directories to find the package's own package.json.
const NESTED_ENTRY = '/app/node_modules/@opentelemetry/api/build/src/index.js'
const PACKAGE_JSON_SUFFIX = '@opentelemetry/api/package.json'

/**
 * Builds a `require`-like stub that resolves `@opentelemetry/api` to `api`.
 *
 * @param {object} api - The module object to return for `@opentelemetry/api`.
 * @param {string} [resolvePath] - Path returned by `require.resolve`.
 * @returns {sinon.SinonStub}
 */
function fakeRequire (api, resolvePath = NESTED_ENTRY) {
  const req = sinon.stub().returns(api)
  req.resolve = sinon.stub().returns(resolvePath)
  return req
}

/**
 * @param {object} [options]
 * @param {number} [options.ddMajor] - Value of the mocked `DD_MAJOR` constant.
 * @param {sinon.SinonStub} [options.appRequire] - `require` returned by `createRequire`.
 * @param {object} [options.ddApi] - Copy returned by dd-trace's own `require`.
 * @param {string} [options.version] - Version reported for the resolved copy.
 * @param {string} [options.range] - Declared `@opentelemetry/api` range.
 * @param {string} [options.depField] - package.json field that declares the range.
 * @param {boolean} [options.versionReadable] - When false, no package.json can be read.
 * @param {boolean} [options.missing] - When true, requiring `@opentelemetry/api` throws.
 */
function buildLoader ({
  ddMajor = 6, appRequire, ddApi = { copy: 'dd-trace' }, version = '1.9.0',
  range = '>=1.0.0 <1.10.0', depField = 'peerDependencies', versionReadable = true, missing = false,
} = {}) {
  const warn = sinon.spy()
  const createRequire = sinon.stub()
  if (appRequire) createRequire.returns(appRequire)

  const stubs = {
    '../../../../version': { DD_MAJOR: ddMajor },
    '../log': { warn },
    '../../../../package.json': { [depField]: { '@opentelemetry/api': range } },
    'node:fs': {
      // The package's own package.json only lives at the package root, so the loader
      // must walk up from the nested entrypoint; everything in between throws ENOENT.
      // path.join normalizes to the platform separator, so match on '/' after a rewrite.
      readFileSync (path) {
        if (versionReadable && path.replaceAll('\\', '/').endsWith(PACKAGE_JSON_SUFFIX)) {
          return JSON.stringify({ name: '@opentelemetry/api', version })
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    },
    'node:module': { createRequire },
  }

  // A `null` stub makes proxyquire throw MODULE_NOT_FOUND for that require.
  stubs['@opentelemetry/api'] = missing ? null : Object.assign(ddApi, { '@noCallThru': true })

  return { loader: proxyquire(LOADER_PATH, stubs), warn, createRequire, ddApi }
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
    const { loader, createRequire } = buildLoader({ ddMajor: 5, appRequire: fakeRequire(appApi) })
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
    assert.match(warn.firstCall.args[0], /newer than dd-trace supports/)
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
    assert.match(warn.firstCall.args[0], /newer than dd-trace supports/)
  })

  it('reads the version from a nested entrypoint and stays silent when supported', () => {
    const { loader, warn } = buildDiskLoader('1.9.0')
    loader.load()
    assert.ok(warn.notCalled)
  })
})
