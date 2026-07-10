'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('otel-api instrumentation', () => {
  let addHook
  let hooks
  let setApi
  let setApiLogs

  /**
   * Load `otel-api.js` with `addHook` and the holder's `setApi` stubbed, so the test can
   * assert what version ranges the hooks register and that a hook hands the required module
   * to the holder unchanged.
   *
   * @returns {{ hooks: Map<string, (moduleExports: object) => object> }}
   */
  function load () {
    addHook = sinon.spy()
    setApi = sinon.spy(api => api)
    setApiLogs = sinon.spy(apiLogs => apiLogs)
    proxyquire.noPreserveCache()
    try {
      proxyquire('../src/otel-api', {
        './helpers/instrument': { addHook },
        '../../dd-trace/src/opentelemetry/api': {
          API_LOGS_VERSION_RANGE: '>=0.33.0 <1.0.0',
          API_VERSION_RANGE: '>=1.0.0 <1.10.0',
          setApi,
          setApiLogs,
        },
      })
    } finally {
      proxyquire.preserveCache()
    }
    const hooks = new Map()
    for (const call of addHook.getCalls()) {
      hooks.set(call.args[0].name, call.args[1])
    }
    return { hooks }
  }

  beforeEach(() => {
    ({ hooks } = load())
  })

  it('hooks @opentelemetry/api across the supported major range', () => {
    sinon.assert.calledWith(addHook, {
      name: '@opentelemetry/api',
      versions: ['>=1.0.0 <1.10.0'],
      patchDefault: false,
    }, setApi)
  })

  it('hooks @opentelemetry/api-logs across its published pre-1.0 range', () => {
    sinon.assert.calledWith(addHook, {
      name: '@opentelemetry/api-logs',
      versions: ['>=0.33.0 <1.0.0'],
      patchDefault: false,
    }, setApiLogs)
  })

  it('captures the required module into the holder and returns it unchanged', () => {
    const api = { trace: {}, context: {} }
    const returned = hooks.get('@opentelemetry/api')(api)
    assert.strictEqual(returned, api)
    sinon.assert.calledOnceWithExactly(setApi, api)
  })

  it('captures @opentelemetry/api-logs under its own package name', () => {
    const apiLogs = { logs: {}, SeverityNumber: {} }
    const returned = hooks.get('@opentelemetry/api-logs')(apiLogs)
    assert.strictEqual(returned, apiLogs)
    sinon.assert.calledOnceWithExactly(setApiLogs, apiLogs)
  })
})
