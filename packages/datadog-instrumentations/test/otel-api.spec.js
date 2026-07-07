'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

describe('otel-api instrumentation', () => {
  let addHook
  let setApi

  /**
   * Load `otel-api.js` with `addHook` and the holder's `setApi` stubbed, so the test can
   * assert what version ranges the hooks register and that a hook hands the required module
   * to the holder unchanged.
   *
   * @returns {{ hooks: Map<string, (moduleExports: object) => object> }}
   */
  function load () {
    addHook = sinon.spy()
    setApi = sinon.spy()
    proxyquire('../src/otel-api', {
      './helpers/instrument': { addHook },
      '../../dd-trace/src/opentelemetry/api': {
        API: '@opentelemetry/api',
        API_LOGS: '@opentelemetry/api-logs',
        setApi,
      },
    })
    const hooks = new Map()
    for (const call of addHook.getCalls()) {
      hooks.set(call.args[0].name, call.args[1])
    }
    return { hooks }
  }

  beforeEach(() => {
    load()
  })

  it('hooks @opentelemetry/api across the supported major range', () => {
    sinon.assert.calledWith(addHook, {
      name: '@opentelemetry/api',
      versions: ['>=1.0.0 <1.10.0'],
    })
  })

  it('hooks @opentelemetry/api-logs across its published pre-1.0 range', () => {
    sinon.assert.calledWith(addHook, {
      name: '@opentelemetry/api-logs',
      versions: ['>=0.33.0 <1.0.0'],
    })
  })

  it('captures the required module into the holder and returns it unchanged', () => {
    const { hooks } = load()
    const api = { trace: {}, context: {} }
    const returned = hooks.get('@opentelemetry/api')(api)
    assert.strictEqual(returned, api)
    sinon.assert.calledOnceWithExactly(setApi, '@opentelemetry/api', api)
  })

  it('captures @opentelemetry/api-logs under its own package name', () => {
    const { hooks } = load()
    const apiLogs = { logs: {}, SeverityNumber: {} }
    const returned = hooks.get('@opentelemetry/api-logs')(apiLogs)
    assert.strictEqual(returned, apiLogs)
    sinon.assert.calledOnceWithExactly(setApi, '@opentelemetry/api-logs', apiLogs)
  })
})
