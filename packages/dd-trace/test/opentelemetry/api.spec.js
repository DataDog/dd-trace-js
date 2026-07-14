'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const API_OWNER_VERSION = require('../../../../package.json').optionalDependencies['@opentelemetry/api']

require('../setup/core')

describe('opentelemetry/api', () => {
  const globalKey = Symbol.for('opentelemetry.js.api.1')
  let previousGlobal

  beforeEach(() => {
    previousGlobal = Object.getOwnPropertyDescriptor(globalThis, globalKey)
  })

  afterEach(() => {
    sinon.restore()
    if (previousGlobal) Object.defineProperty(globalThis, globalKey, previousGlobal)
    else Reflect.deleteProperty(globalThis, globalKey)
    previousGlobal = undefined
  })

  /**
   * @param {object} [stubs]
   * @returns {typeof import('../../src/opentelemetry/api')}
   */
  function loadApi (stubs = {}) {
    proxyquire.noPreserveCache()
    try {
      return proxyquire('../../src/opentelemetry/api', stubs)
    } finally {
      proxyquire.preserveCache()
    }
  }

  /**
   * @param {object} globalApi
   */
  function setGlobalApi (globalApi) {
    Reflect.set(globalThis, globalKey, globalApi)
  }

  /**
   * @returns {NodeRequire}
   */
  function missingApplicationRequire () {
    const applicationRequire = () => {}
    applicationRequire.resolve = () => {
      const error = new Error('not found')
      error.code = 'MODULE_NOT_FOUND'
      throw error
    }
    return applicationRequire
  }

  it('captures the first application copies without changing the pinned owners', () => {
    const holder = loadApi({
      'node:module': { createRequire: () => missingApplicationRequire() },
    })
    const apiOwner = holder.getApiOwner()
    const apiLogsOwner = holder.getApiLogsOwner()
    const binding = holder.getApiBinding()
    const applicationApi = { trace: {} }
    const applicationApiLogs = { logs: {} }

    holder.setApi(applicationApi)
    holder.setApiLogs(applicationApiLogs)
    holder.setApi({ trace: { second: true } })
    holder.setApiLogs({ logs: { second: true } })

    assert.strictEqual(holder.getApi(), applicationApi)
    assert.strictEqual(binding.current, applicationApi)
    assert.strictEqual(holder.getApiLogs(), applicationApiLogs)
    assert.strictEqual(holder.getApiOwner(), apiOwner)
    assert.strictEqual(holder.getApiLogsOwner(), apiLogsOwner)
  })

  it('uses an application capture made before the first bridge read', () => {
    const holder = loadApi({
      'node:module': { createRequire: () => missingApplicationRequire() },
    })
    const applicationApi = { trace: {} }

    holder.setApi(applicationApi)

    assert.strictEqual(holder.getApi(), applicationApi)
    assert.strictEqual(holder.getApiBinding().current, applicationApi)
  })

  it('ignores an internal API before capturing an application copy', () => {
    const holder = loadApi({
      'node:module': { createRequire: () => missingApplicationRequire() },
    })
    const internalApi = { trace: { internal: true } }
    const applicationApi = { trace: { application: true } }

    holder.setApi(internalApi, '1.9.0', false, {
      moduleBaseDir: path.join(__dirname, '../../../../vendor/node_modules/@opentelemetry/api'),
    })
    holder.setApi(applicationApi, '1.9.0', false, {
      moduleBaseDir: '/app/node_modules/@opentelemetry/api',
    })

    assert.strictEqual(holder.getApi(), applicationApi)
  })

  it('resolves a supported application copy before the fallback', () => {
    const applicationApi = { trace: { application: true } }
    const applicationRequire = sinon.stub().withArgs('@opentelemetry/api').returns(applicationApi)
    applicationRequire.resolve = sinon.stub().returns(require.resolve('@opentelemetry/api-v14'))
    const holder = loadApi({
      'node:module': { createRequire: sinon.stub().returns(applicationRequire) },
    })

    assert.strictEqual(holder.getApi(), applicationApi)
    sinon.assert.calledOnceWithExactly(applicationRequire, '@opentelemetry/api')
  })

  it('resolves application copies from a directory entrypoint', () => {
    const entrypoint = '/app'
    const applicationRequire = missingApplicationRequire()
    const createRequire = sinon.stub().returns(applicationRequire)
    const existsSync = sinon.stub().callsFake(fs.existsSync)
    const statSync = sinon.stub().callsFake(fs.statSync)
    existsSync.withArgs(entrypoint).returns(true)
    statSync.withArgs(entrypoint).returns({ isDirectory: () => true })
    sinon.stub(require.main, 'filename').value(entrypoint)
    const holder = loadApi({
      'node:fs': { ...fs, existsSync, statSync },
      'node:module': { createRequire },
    })

    holder.getApi()

    sinon.assert.calledOnceWithExactly(createRequire, path.join(entrypoint, 'package.json'))
  })

  it('continues when an application copy cannot be loaded', () => {
    const failure = new Error('load failed')
    const applicationRequire = sinon.stub().throws(failure)
    applicationRequire.resolve = sinon.stub().returns(require.resolve('@opentelemetry/api-v14'))
    const debug = sinon.spy()
    const holder = loadApi({
      'node:module': { createRequire: sinon.stub().returns(applicationRequire) },
      '../log': { debug, error: sinon.spy(), warn: sinon.spy() },
    })

    assert.strictEqual(holder.getApi(), holder.getApiOwner())
    sinon.assert.calledOnceWithExactly(
      debug,
      'Unable to load the application-owned %s: %s',
      '@opentelemetry/api',
      failure
    )
  })

  it('rejects the first unsupported future application version', () => {
    const applicationApi = { trace: { application: true } }
    const applicationRequire = sinon.stub().returns(applicationApi)
    applicationRequire.resolve = sinon.stub().returns(require.resolve('@opentelemetry/api-v14'))
    const warn = sinon.spy()
    const holder = loadApi({
      'node:fs': {
        ...fs,
        readFileSync: () => JSON.stringify({ name: '@opentelemetry/api', version: '1.10.0' }),
      },
      'node:module': { createRequire: sinon.stub().returns(applicationRequire) },
      '../log': { debug: sinon.spy(), error: sinon.spy(), warn },
    })

    assert.notStrictEqual(holder.getApi(), applicationApi)
    sinon.assert.notCalled(applicationRequire)
    sinon.assert.calledOnceWithExactly(
      warn,
      'Unsupported application-owned %s@%s; supported versions are %s. Using the bundled fallback.',
      '@opentelemetry/api',
      '1.10.0',
      '>=1.4.1 <1.10.0'
    )
  })

  it('adopts a compatible diagnostic-only global before provider registration', () => {
    const diag = {}
    setGlobalApi({ version: '1.4.1', diag })

    loadApi().getApiOwner()

    const globalApi = Reflect.get(globalThis, globalKey)
    assert.strictEqual(globalApi.version, API_OWNER_VERSION)
    assert.strictEqual(globalApi.diag, diag)
  })

  it('adopts diagnostic state created after the pinned copy loads', () => {
    Reflect.deleteProperty(globalThis, globalKey)
    const holder = loadApi()
    const owner = holder.getApiOwner()
    Reflect.set(globalThis, globalKey, { version: '1.4.1', diag: {} })

    assert.strictEqual(holder.getApiOwner(), owner)
    assert.strictEqual(Reflect.get(globalThis, globalKey).version, API_OWNER_VERSION)
  })

  for (const [description, globalApi] of [
    ['a non-string version', { version: undefined, diag: {} }],
    ['the version immediately below the supported range', { version: '1.4.0', diag: {} }],
    ['the first unsupported future minor', { version: '1.10.0', diag: {} }],
    ['a signal owner', { version: '1.4.1', diag: {}, trace: {} }],
  ]) {
    it(`does not adopt ${description}`, () => {
      setGlobalApi(globalApi)

      loadApi().getApiOwner()

      assert.strictEqual(Reflect.get(globalThis, globalKey), globalApi)
    })
  }

  it('continues when a diagnostic-only global cannot be replaced', () => {
    const error = sinon.spy()
    Object.defineProperty(globalThis, globalKey, {
      configurable: true,
      value: { version: '1.4.1', diag: {} },
      writable: false,
    })

    loadApi({ '../log': { error } }).getApiOwner()

    sinon.assert.calledOnceWithExactly(error, 'Unable to prepare the OpenTelemetry API global owner.')
  })

  it('continues when inspecting a diagnostic-only global throws', () => {
    const failure = new Error('global inspection failed')
    const error = sinon.spy()
    setGlobalApi(new Proxy({ version: '1.4.1' }, {
      ownKeys () {
        throw failure
      },
    }))

    loadApi({ '../log': { error } }).getApiOwner()

    sinon.assert.calledOnceWithExactly(
      error,
      'Unable to prepare the OpenTelemetry API global owner: %s',
      failure
    )
  })
})
