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
          API_VERSION_RANGE: '>=1.4.1 <1.10.0',
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
    return hooks
  }

  beforeEach(() => {
    hooks = load()
  })

  it('hooks @opentelemetry/api across the supported range', () => {
    sinon.assert.calledWith(addHook, {
      name: '@opentelemetry/api',
      versions: ['>=1.4.1 <1.10.0'],
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

  it('passes the loaded core API to the holder unchanged', () => {
    const api = { trace: {}, context: {} }
    const hookMetadata = { moduleBaseDir: '/app/node_modules/@opentelemetry/api' }

    assert.strictEqual(hooks.get('@opentelemetry/api')(api, '1.9.0', false, hookMetadata), api)
    sinon.assert.calledOnceWithExactly(setApi, api, '1.9.0', false, hookMetadata)
  })

  it('passes the loaded Logs API to the holder unchanged', () => {
    const apiLogs = { logs: {}, SeverityNumber: {} }
    const hookMetadata = { moduleBaseDir: '/app/node_modules/@opentelemetry/api-logs' }

    assert.strictEqual(hooks.get('@opentelemetry/api-logs')(apiLogs, '0.212.0', false, hookMetadata), apiLogs)
    sinon.assert.calledOnceWithExactly(setApiLogs, apiLogs, '0.212.0', false, hookMetadata)
  })
})
