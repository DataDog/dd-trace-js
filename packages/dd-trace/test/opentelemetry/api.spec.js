'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

/**
 * Loads a fresh copy of the holder so each test starts with empty captures.
 *
 * @param {typeof import('node:module').createRequire} [createRequire]
 * @param {Record<string, object>} [stubs]
 * @returns {typeof import('../../src/opentelemetry/api')}
 */
function freshHolder (createRequire, stubs = {}) {
  if (createRequire) stubs['node:module'] = { createRequire }
  proxyquire.noPreserveCache()
  try {
    return proxyquire('../../src/opentelemetry/api', stubs)
  } finally {
    proxyquire.preserveCache()
  }
}

describe('opentelemetry/api holder', () => {
  let holder
  let mainFilename
  let argvEntrypoint
  let temporaryDirectories

  beforeEach(() => {
    mainFilename = require.main?.filename
    argvEntrypoint = process.argv[1]
    temporaryDirectories = []
    const notFound = Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    holder = freshHolder(sinon.stub().returns(createFailingApplicationRequire(notFound)))
  })

  afterEach(() => {
    if (require.main) require.main.filename = mainFilename
    process.argv[1] = argvEntrypoint
    for (const directory of temporaryDirectories) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
    sinon.restore()
  })

  /**
   * @param {string} packageName
   * @param {string} version
   * @param {string} [manifestName]
   * @returns {string}
   */
  function createPackageEntry (packageName, version, manifestName = packageName) {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-api-'))
    const packageDirectory = path.join(temporaryDirectory, 'node_modules', ...packageName.split('/'))
    const entry = path.join(packageDirectory, 'build', 'index.js')
    temporaryDirectories.push(temporaryDirectory)
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({
      name: manifestName,
      version,
    }))
    fs.writeFileSync(entry, '')
    return entry
  }

  /**
   * @param {Error} error
   * @returns {NodeRequire}
   */
  function createFailingApplicationRequire (error) {
    const applicationRequire = sinon.stub()
    applicationRequire.resolve = sinon.stub().throws(error)
    return /** @type {NodeRequire} */ (applicationRequire)
  }

  it('falls back to the bundled copy when nothing has been captured', () => {
    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))
    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))
    assert.strictEqual(holder.getApiLogs(), require('@opentelemetry/api-logs'))
  })

  it('retries the fallback and accepts an application capture after a load failure', () => {
    const error = new Error('fallback failed')
    sinon.stub(Module, '_load').callThrough().withArgs('@opentelemetry/api').onFirstCall().throws(error)

    assert.throws(() => holder.getApi(), { message: 'fallback failed' })
    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))

    const application = { copy: 'application' }
    holder.setApi(application)
    assert.strictEqual(holder.getApi(), application)
  })

  it('returns the captured copy over the bundled fallback', () => {
    const api = { trace: {}, context: {} }
    holder.setApi(api)
    assert.strictEqual(holder.getApi(), api)
    assert.notStrictEqual(holder.getApi(), require('@opentelemetry/api'))
  })

  it('keeps the two packages independent', () => {
    const apiLogs = { logs: {} }
    holder.setApiLogs(apiLogs)
    assert.strictEqual(holder.getApiLogs(), apiLogs)
    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))
  })

  it('ignores a second capture so the first application copy wins', () => {
    const first = { copy: 'first' }
    const second = { copy: 'second' }
    holder.setApi(first)
    holder.setApi(second)
    assert.strictEqual(holder.getApi(), first)
  })

  it('prefers the entrypoint API over an earlier internal capture', () => {
    const internal = { copy: 'internal' }
    const application = { copy: 'application' }
    const applicationRequire = sinon.stub()
    applicationRequire.resolve = sinon.stub().returns(createPackageEntry('@opentelemetry/api', '1.9.0'))
    applicationRequire.withArgs('@opentelemetry/api').returns(application)
    holder = freshHolder(sinon.stub().returns(applicationRequire))

    holder.setApi(internal)

    assert.strictEqual(holder.getApi(), application)
  })

  for (const [packageName, getter, version, supported] of [
    ['@opentelemetry/api', 'getApi', '1.0.0', true],
    ['@opentelemetry/api', 'getApi', '1.9.999', true],
    ['@opentelemetry/api', 'getApi', '1.10.0-alpha.1', false],
    ['@opentelemetry/api', 'getApi', '1.10.0', false],
    ['@opentelemetry/api-logs', 'getApiLogs', '0.32.999', false],
    ['@opentelemetry/api-logs', 'getApiLogs', '0.33.0', true],
    ['@opentelemetry/api-logs', 'getApiLogs', '0.999.999', true],
    ['@opentelemetry/api-logs', 'getApiLogs', '1.0.0', false],
  ]) {
    it(`${supported ? 'loads' : 'rejects'} ${packageName}@${version} from the application`, () => {
      const application = { copy: 'application' }
      const applicationRequire = sinon.stub()
      applicationRequire.resolve = sinon.stub().returns(createPackageEntry(packageName, version))
      applicationRequire.withArgs(packageName).returns(application)
      holder = freshHolder(sinon.stub().returns(applicationRequire))

      const loaded = holder[getter]()

      if (supported) {
        assert.strictEqual(loaded, application)
        sinon.assert.calledOnceWithExactly(applicationRequire, packageName)
      } else {
        assert.notStrictEqual(loaded, application)
        sinon.assert.notCalled(applicationRequire)
      }
    })
  }

  it('roots application resolution inside a directory entrypoint', () => {
    assert.ok(require.main)
    const entrypoint = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-entrypoint-'))
    temporaryDirectories.push(entrypoint)
    require.main.filename = entrypoint
    const notFound = Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    const createRequire = sinon.stub().returns(createFailingApplicationRequire(notFound))
    holder = freshHolder(createRequire)

    holder.getApi()

    sinon.assert.calledOnceWithExactly(createRequire, path.join(entrypoint, 'package.json'))
  })

  it('roots application resolution at process.argv for an ESM entrypoint', () => {
    assert.ok(require.main)
    delete require.main.filename
    process.argv[1] = path.join(os.tmpdir(), 'app.mjs')
    const notFound = Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    const createRequire = sinon.stub().returns(createFailingApplicationRequire(notFound))
    holder = freshHolder(createRequire)

    holder.getApi()

    sinon.assert.calledOnceWithExactly(createRequire, process.argv[1])
  })

  it('roots application resolution in the working directory without an entrypoint', () => {
    assert.ok(require.main)
    delete require.main.filename
    delete process.argv[1]
    const notFound = Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    const createRequire = sinon.stub().returns(createFailingApplicationRequire(notFound))
    holder = freshHolder(createRequire)

    holder.getApi()

    sinon.assert.calledOnceWithExactly(createRequire, path.join(process.cwd(), 'package.json'))
  })

  it('falls back without logging when the application does not install the package', () => {
    const notFound = Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    const debug = sinon.spy()
    holder = freshHolder(sinon.stub().returns(createFailingApplicationRequire(notFound)), {
      '../log': { debug },
    })

    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))
    sinon.assert.notCalled(debug)
  })

  it('logs an unexpected application resolution failure and falls back', () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const debug = sinon.spy()
    holder = freshHolder(sinon.stub().returns(createFailingApplicationRequire(error)), {
      '../log': { debug },
    })

    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))
    sinon.assert.calledOnceWithExactly(
      debug,
      'Unable to load the application-owned %s; using the bundled fallback.',
      '@opentelemetry/api',
      error
    )
  })

  it('logs an application package load failure and falls back', () => {
    const error = Object.assign(new Error('missing internal module'), { code: 'MODULE_NOT_FOUND' })
    const applicationRequire = sinon.stub().throws(error)
    applicationRequire.resolve = sinon.stub().returns(createPackageEntry('@opentelemetry/api', '1.9.0'))
    const debug = sinon.spy()
    holder = freshHolder(sinon.stub().returns(applicationRequire), {
      '../log': { debug },
    })

    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))
    sinon.assert.calledOnceWithExactly(
      debug,
      'Unable to load the application-owned %s; using the bundled fallback.',
      '@opentelemetry/api',
      error
    )
  })

  it('rejects a resolved entry whose manifest belongs to another package', () => {
    const applicationRequire = sinon.stub()
    applicationRequire.resolve = sinon.stub().returns(
      createPackageEntry('@opentelemetry/api', '1.9.0', '@opentelemetry/not-api')
    )
    holder = freshHolder(sinon.stub().returns(applicationRequire))

    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))
    sinon.assert.notCalled(applicationRequire)
  })

  for (const [packageName, getter, setter] of [
    ['@opentelemetry/api', 'getApi', 'setApi'],
    ['@opentelemetry/api-logs', 'getApiLogs', 'setApiLogs'],
  ]) {
    it(`loads the application's ${packageName} copy before the fallback`, () => {
      const application = { copy: 'application' }
      const applicationRequire = sinon.stub()
      applicationRequire.resolve = sinon.stub().withArgs(packageName).returns(require.resolve(packageName))
      applicationRequire.withArgs(packageName).returns(application)
      holder = freshHolder(sinon.stub().returns(applicationRequire))

      assert.strictEqual(holder[getter](), application)
    })

    it(`does not treat dd-trace's ${packageName} fallback as an application capture`, () => {
      const notFound = Object.assign(new Error(`Cannot find module '${packageName}'`), {
        code: 'MODULE_NOT_FOUND',
      })
      const applicationRequire = sinon.stub()
      applicationRequire.resolve = sinon.stub().throws(notFound)
      holder = freshHolder(sinon.stub().returns(applicationRequire))

      const fallback = { copy: 'fallback' }
      sinon.stub(Module, '_load').callThrough().withArgs(packageName).callsFake(
        /** @returns {object} */
        () => {
          holder[setter](fallback)
          return fallback
        }
      )

      assert.strictEqual(holder[getter](), fallback)

      const application = { copy: 'application' }
      holder[setter](application)
      assert.strictEqual(holder[getter](), application)
    })
  }
})
