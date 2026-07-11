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

  it('ignores a capture marked as dd-trace-owned', () => {
    const internal = { copy: 'internal' }
    holder.setApi(internal, '1.9.0', false, { applicationOwned: false })

    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))
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

  it('prefers a capture closest to the application root', () => {
    const nested = { copy: 'nested' }
    const application = { copy: 'application' }
    holder.setApi(nested, '1.9.0', false, {
      moduleBaseDir: path.join(process.cwd(), 'node_modules', 'helper', 'node_modules', '@opentelemetry', 'api'),
    })
    holder.setApi(application, '1.9.0', false, {
      moduleBaseDir: path.join(process.cwd(), 'node_modules', '@opentelemetry', 'api'),
    })

    assert.strictEqual(holder.getApi(), application)
  })

  it('prefers a nested entrypoint capture over a shallower working directory capture', () => {
    assert.ok(require.main)
    const applicationDirectory = path.join(process.cwd(), 'packages', 'application')
    require.main.filename = path.join(applicationDirectory, 'app.js')
    const workingDirectoryCopy = { copy: 'working-directory' }
    const applicationCopy = { copy: 'application' }
    holder.setApi(workingDirectoryCopy, '1.9.0', false, {
      moduleBaseDir: path.join(process.cwd(), 'node_modules', '@opentelemetry', 'api'),
    })
    holder.setApi(applicationCopy, '1.9.0', false, {
      moduleBaseDir: path.join(applicationDirectory, 'custom', 'node_modules', '@opentelemetry', 'api'),
    })

    assert.strictEqual(holder.getApi(), applicationCopy)
  })

  it('ranks captures from the ESM entrypoint when require.main has no filename', () => {
    assert.ok(require.main)
    delete require.main.filename
    const entrypointDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-api-entrypoint-'))
    temporaryDirectories.push(entrypointDirectory)
    process.argv[1] = path.join(entrypointDirectory, 'app.mjs')
    const nested = { copy: 'nested' }
    const application = { copy: 'application' }
    holder.setApi(nested, '1.9.0', false, {
      moduleBaseDir: path.join(os.tmpdir(), 'dependency', 'node_modules', '@opentelemetry', 'api'),
    })
    holder.setApi(application, '1.9.0', false, {
      moduleBaseDir: path.join(entrypointDirectory, 'node_modules', '@opentelemetry', 'api'),
    })

    assert.strictEqual(holder.getApi(), application)
  })

  it('binds a custom application copy captured after an internal copy before registration', () => {
    const internal = { copy: 'internal' }
    const application = { copy: 'application' }
    const activate = sinon.spy()
    const deactivate = sinon.spy()
    holder.setApi(internal, '1.9.0', false, {
      applicationOwned: false,
      moduleBaseDir: path.join(process.cwd(), 'node_modules', '@opentelemetry', 'api'),
    })
    holder.setApi(application, '1.9.0', false, {
      moduleBaseDir: path.join(process.cwd(), 'custom', 'node_modules', '@opentelemetry', 'api'),
    })
    holder.registerApi({ activate, deactivate })

    assert.strictEqual(holder.getApi(), application)
    sinon.assert.calledOnceWithExactly(activate, application)
    sinon.assert.notCalled(deactivate)
  })

  it('deactivates every registration before activating a late application copy', () => {
    const internal = { copy: 'internal' }
    const application = { copy: 'application' }
    const calls = []
    holder.setApi(internal, '1.9.0')
    for (const signal of ['trace', 'metrics', 'logs']) {
      holder.registerApi({
        activate: api => calls.push(`activate ${signal} ${api.copy}`),
        deactivate: api => calls.push(`deactivate ${signal} ${api.copy}`),
      })
    }

    const binding = holder.getApiBinding()
    holder.setApi(application, '1.9.0', false, { applicationOwned: true })

    assert.strictEqual(holder.getApi(), application)
    assert.strictEqual(binding.current, application)
    assert.deepStrictEqual(calls, [
      'activate trace internal',
      'activate metrics internal',
      'activate logs internal',
      'deactivate trace internal',
      'deactivate metrics internal',
      'deactivate logs internal',
      'activate trace application',
      'activate metrics application',
      'activate logs application',
    ])
  })

  it('continues a late transition when registrations throw', () => {
    const error = sinon.spy()
    holder = freshHolder(sinon.stub().returns(createFailingApplicationRequire(
      Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    )), {
      '../log': { error },
    })
    const internal = { copy: 'internal' }
    const application = { copy: 'application' }
    const activationError = new Error('activate failed')
    const deactivationError = new Error('deactivate failed')
    const activate = sinon.stub()
    const deactivate = sinon.spy()
    holder.setApi(internal, '1.9.0')
    holder.registerApi({
      activate,
      deactivate: sinon.stub().throws(deactivationError),
    })
    holder.registerApi({
      activate: sinon.stub().onSecondCall().throws(activationError),
      deactivate,
    })

    holder.setApi(application, '1.9.0', false, { applicationOwned: true })

    assert.strictEqual(holder.getApi(), application)
    sinon.assert.calledOnceWithExactly(deactivate, internal)
    sinon.assert.calledTwice(activate)
    sinon.assert.calledWithExactly(activate.secondCall, application)
    assert.deepStrictEqual(error.args, [
      ['Error deactivating the previous %s registration.', '@opentelemetry/api', deactivationError],
      ['Error activating the new %s registration.', '@opentelemetry/api', activationError],
    ])
  })

  it('transfers the core API global version before activating a different copy', () => {
    const globalKey = Symbol.for('opentelemetry.js.api.1')
    const previous = Reflect.get(globalThis, globalKey)
    const globalApi = { version: '1.8.0' }
    Reflect.set(globalThis, globalKey, globalApi)

    try {
      holder.setApi({ copy: 'internal' }, '1.8.0')
      holder.registerApi({ activate: sinon.spy(), deactivate: sinon.spy() })

      holder.setApi({ copy: 'application' }, '1.9.0', false, { applicationOwned: true })

      assert.strictEqual(globalApi.version, '1.9.0')
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, globalKey)
      else Reflect.set(globalThis, globalKey, previous)
    }
  })

  it('continues a transition when the core API global version cannot be transferred', () => {
    const globalKey = Symbol.for('opentelemetry.js.api.1')
    const previous = Reflect.get(globalThis, globalKey)
    Reflect.set(globalThis, globalKey, Object.freeze({ version: '1.8.0' }))
    const error = sinon.spy()
    holder = freshHolder(sinon.stub().returns(createFailingApplicationRequire(
      Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    )), {
      '../log': { error },
    })
    const application = { copy: 'application' }
    const activate = sinon.spy()

    try {
      holder.setApi({ copy: 'internal' }, '1.8.0')
      holder.registerApi({ activate, deactivate: sinon.spy() })

      holder.setApi(application, '1.9.0', false, { applicationOwned: true })

      assert.strictEqual(holder.getApi(), application)
      sinon.assert.calledWithExactly(activate.secondCall, application)
      sinon.assert.calledOnceWithExactly(
        error,
        'Unable to transfer the OpenTelemetry API global to version %s.',
        '1.9.0',
        sinon.match.instanceOf(TypeError)
      )
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, globalKey)
      else Reflect.set(globalThis, globalKey, previous)
    }
  })

  it('updates the priority when the selected copy is later identified as application-owned', () => {
    const api = { copy: 'shared' }
    const activate = sinon.spy()
    const deactivate = sinon.spy()
    holder.setApi(api, '1.9.0')
    holder.registerApi({ activate, deactivate })

    holder.setApi(api, '1.9.0', false, { applicationOwned: true })
    holder.setApi({ copy: 'internal' }, '1.9.0', false, { applicationOwned: false })

    assert.strictEqual(holder.getApi(), api)
    sinon.assert.calledOnceWithExactly(activate, api)
    sinon.assert.notCalled(deactivate)
  })

  it('keeps an internal late capture from replacing the registered application copy', () => {
    const application = { copy: 'application' }
    const internal = { copy: 'internal' }
    const activate = sinon.spy()
    const deactivate = sinon.spy()
    holder.setApi(application, '1.9.0', false, { applicationOwned: true })
    holder.registerApi({ activate, deactivate })

    holder.setApi(internal, '1.9.0', false, {
      applicationOwned: false,
      moduleBaseDir: path.join(process.cwd(), 'node_modules', '@opentelemetry', 'api'),
    })

    assert.strictEqual(holder.getApi(), application)
    sinon.assert.calledOnceWithExactly(activate, application)
    sinon.assert.notCalled(deactivate)
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

  it('moves a preloaded copy to a late explicitly application-owned copy', () => {
    const preloaded = { copy: 'preloaded' }
    const application = { copy: 'application' }
    const applicationRequire = sinon.stub()
    applicationRequire.resolve = sinon.stub().returns(createPackageEntry('@opentelemetry/api', '1.9.0'))
    applicationRequire.withArgs('@opentelemetry/api').returns(preloaded)
    holder = freshHolder(sinon.stub().returns(applicationRequire))
    const activate = sinon.spy()
    const deactivate = sinon.spy()
    holder.registerApi({ activate, deactivate })

    holder.setApi(application, '1.9.0', false, { applicationOwned: true })

    assert.strictEqual(holder.getApi(), application)
    sinon.assert.calledOnceWithExactly(deactivate, preloaded)
    assert.deepStrictEqual(activate.args, [[preloaded], [application]])
  })

  it('prefers the working-directory API over a launcher dependency', () => {
    assert.ok(require.main)
    const launcherDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-launcher-'))
    temporaryDirectories.push(launcherDirectory)
    require.main.filename = path.join(launcherDirectory, 'cli.js')

    const application = { copy: 'application' }
    const launcher = { copy: 'launcher' }
    const applicationRequire = sinon.stub()
    applicationRequire.resolve = sinon.stub().returns(createPackageEntry('@opentelemetry/api', '1.9.0'))
    applicationRequire.withArgs('@opentelemetry/api').returns(application)
    const launcherRequire = sinon.stub()
    launcherRequire.resolve = sinon.stub().returns(createPackageEntry('@opentelemetry/api', '1.9.0'))
    launcherRequire.withArgs('@opentelemetry/api').returns(launcher)
    const createRequire = sinon.stub()
    createRequire.withArgs(path.join(process.cwd(), 'package.json')).returns(applicationRequire)
    createRequire.withArgs(require.main.filename).returns(launcherRequire)
    holder = freshHolder(createRequire)

    assert.strictEqual(holder.getApi(), application)
    sinon.assert.notCalled(launcherRequire)
  })

  it('prefers a nested application entrypoint over the working-directory API', () => {
    assert.ok(require.main)
    const entrypoint = path.join(process.cwd(), 'packages', 'app', 'index.js')
    require.main.filename = entrypoint

    const workspace = { copy: 'workspace' }
    const application = { copy: 'application' }
    const workspaceRequire = sinon.stub()
    workspaceRequire.resolve = sinon.stub().returns(createPackageEntry('@opentelemetry/api', '1.0.0'))
    workspaceRequire.withArgs('@opentelemetry/api').returns(workspace)
    const applicationRequire = sinon.stub()
    applicationRequire.resolve = sinon.stub().returns(createPackageEntry('@opentelemetry/api', '1.9.0'))
    applicationRequire.withArgs('@opentelemetry/api').returns(application)
    const createRequire = sinon.stub()
    createRequire.withArgs(entrypoint).returns(applicationRequire)
    createRequire.withArgs(path.join(process.cwd(), 'package.json')).returns(workspaceRequire)
    holder = freshHolder(createRequire)

    assert.strictEqual(holder.getApi(), application)
    sinon.assert.notCalled(workspaceRequire)
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

  it('warns when the application API version is unsupported', () => {
    const applicationRequire = sinon.stub()
    applicationRequire.resolve = sinon.stub().returns(createPackageEntry('@opentelemetry/api', '1.10.0'))
    const warn = sinon.spy()
    holder = freshHolder(sinon.stub().returns(applicationRequire), {
      '../log': { warn },
    })

    holder.getApi()

    sinon.assert.calledOnceWithExactly(
      warn,
      'Unsupported application-owned %s@%s; supported versions are %s. Using the bundled fallback.',
      '@opentelemetry/api',
      '1.10.0',
      '>=1.0.0 <1.10.0'
    )
  })

  it('roots application resolution inside a directory entrypoint', () => {
    assert.ok(require.main)
    const entrypoint = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-entrypoint-'))
    temporaryDirectories.push(entrypoint)
    require.main.filename = entrypoint
    const notFound = Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    const createRequire = sinon.stub().returns(createFailingApplicationRequire(notFound))
    holder = freshHolder(createRequire)

    holder.getApi()

    assert.deepStrictEqual(createRequire.args, [
      [path.join(process.cwd(), 'package.json')],
      [path.join(entrypoint, 'package.json')],
    ])
  })

  it('roots application resolution at process.argv for an ESM entrypoint', () => {
    assert.ok(require.main)
    delete require.main.filename
    process.argv[1] = path.join(os.tmpdir(), 'app.mjs')
    const notFound = Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    const createRequire = sinon.stub().returns(createFailingApplicationRequire(notFound))
    holder = freshHolder(createRequire)

    holder.getApi()

    assert.deepStrictEqual(createRequire.args, [
      [path.join(process.cwd(), 'package.json')],
      [process.argv[1]],
    ])
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
