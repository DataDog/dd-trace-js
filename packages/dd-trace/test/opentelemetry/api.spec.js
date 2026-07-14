'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const API_OWNER_VERSION = require('../../../../package.json').dependencies['@opentelemetry/api']

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

  it('uses pinned compatibility-max copies for every bridge operation', () => {
    const holder = loadApi()

    assert.strictEqual(holder.getApi(), require('@opentelemetry/api'))
    assert.strictEqual(holder.getApiOwner(), require('@opentelemetry/api'))
    assert.strictEqual(holder.getApiLogs(), require('@opentelemetry/api-logs'))
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
