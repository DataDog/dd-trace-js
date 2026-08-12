'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

describe('otel-azure-enabled', () => {
  function loadWithEnv (env) {
    const values = {
      DD_TRACE_OTEL_ENABLED: env.ddTraceOtelEnabled,
      OTEL_SDK_DISABLED: env.otelSdkDisabled,
      DD_TRACE_AZURE_DURABLE_FUNCTIONS_ENABLED: env.nativeDurableEnabled,
    }
    return proxyquire('../../src/helpers/otel-azure-enabled', {
      '../../../dd-trace/src/config/helper': {
        getValueFromEnvSources: (name) => values[name],
      },
    })
  }

  it('disables when DD_TRACE_OTEL_ENABLED is false', () => {
    const { isOtelAzureInstrumentationEnabled } = loadWithEnv({ ddTraceOtelEnabled: false })
    assert.equal(isOtelAzureInstrumentationEnabled(), false)
  })

  it('disables when OTEL_SDK_DISABLED is true', () => {
    const { isOtelAzureInstrumentationEnabled } = loadWithEnv({ otelSdkDisabled: true })
    assert.equal(isOtelAzureInstrumentationEnabled(), false)
  })

  it('disables when native durable plugin is enabled', () => {
    const { isOtelAzureInstrumentationEnabled } = loadWithEnv({
      ddTraceOtelEnabled: true,
      nativeDurableEnabled: true,
    })
    assert.equal(isOtelAzureInstrumentationEnabled(), false)
  })

  it('enables when OTel is on and native durable plugin is disabled', () => {
    const { isOtelAzureInstrumentationEnabled } = loadWithEnv({
      ddTraceOtelEnabled: true,
      nativeDurableEnabled: false,
    })
    assert.equal(isOtelAzureInstrumentationEnabled(), true)
  })

  it('enables when OTEL_SDK_DISABLED=false opts in and native durable is disabled', () => {
    const { isOtelAzureInstrumentationEnabled } = loadWithEnv({
      otelSdkDisabled: false,
      nativeDurableEnabled: false,
    })
    assert.equal(isOtelAzureInstrumentationEnabled(), true)
  })

  it('reports isOtelSdkEnabled directly when DD_TRACE_OTEL_ENABLED opts in', () => {
    const { isOtelSdkEnabled } = loadWithEnv({ ddTraceOtelEnabled: true })
    assert.equal(isOtelSdkEnabled(), true)
  })

  it('stays disabled by default when neither OTel opt-in is set', () => {
    const { isOtelSdkEnabled, isOtelAzureInstrumentationEnabled } = loadWithEnv({})
    assert.equal(isOtelSdkEnabled(), false)
    assert.equal(isOtelAzureInstrumentationEnabled(), false)
  })
})

function tracingChannelStub () {
  return {
    subscribe () {},
    unsubscribe () {},
    hasSubscribers: false,
  }
}

describe('azure-functions OTel gating', () => {
  function loadHook (enabled) {
    let patchAppCalled = false
    const app = {}
    for (const method of [
      'deleteRequest', 'http', 'get', 'patch', 'post', 'put',
      'serviceBusQueue', 'serviceBusTopic', 'eventHub', 'cosmosDB',
    ]) {
      app[method] = function () {}
    }

    proxyquire('../../src/azure-functions', {
      './helpers/otel-azure-enabled': {
        isOtelAzureInstrumentationEnabled: () => enabled,
      },
      './otel-azure-functions': {
        patchApp: (patchedApp) => {
          patchAppCalled = true
          assert.equal(patchedApp, app)
        },
      },
      './helpers/instrument': {
        addHook: (opts, fn) => {
          if (opts.name === '@azure/functions') fn({ app })
        },
      },
      'dc-polyfill': { tracingChannel: tracingChannelStub },
      '../../datadog-shimmer': require('../../../datadog-shimmer'),
    })

    return patchAppCalled
  }

  it('patches OTel handlers when instrumentation is enabled', () => {
    assert.equal(loadHook(true), true)
  })

  it('skips OTel handlers when instrumentation is disabled', () => {
    assert.equal(loadHook(false), false)
  })
})

describe('azure-durable-functions OTel gating', () => {
  function loadHook (enabled) {
    let patchAppCalled = false
    const app = {
      entity () {},
      activity () {},
      orchestration () {},
    }

    proxyquire('../../src/azure-durable-functions', {
      './helpers/otel-azure-enabled': {
        isOtelAzureInstrumentationEnabled: () => enabled,
      },
      './otel-azure-durable-functions': {
        patchApp: () => { patchAppCalled = true },
      },
      './helpers/instrument': {
        addHook: (opts, fn) => {
          if (opts.name === 'durable-functions') fn({ app })
        },
      },
      'dc-polyfill': { tracingChannel: tracingChannelStub },
      '../../datadog-shimmer': require('../../../datadog-shimmer'),
    })

    return patchAppCalled
  }

  it('patches OTel handlers when instrumentation is enabled', () => {
    assert.equal(loadHook(true), true)
  })

  it('skips OTel handlers when instrumentation is disabled', () => {
    assert.equal(loadHook(false), false)
  })
})

describe('otel-azure-functions', () => {
  it('wraps HTTP and generic registration methods', () => {
    const { patchApp } = proxyquire('../../src/otel-azure-functions', {
      '../../datadog-shimmer': require('../../../datadog-shimmer'),
    })
    const app = {
      deleteRequest (name, arg) { return arg },
      http (name, arg) { return arg },
      get (name, arg) { return arg },
      patch (name, arg) { return arg },
      post (name, arg) { return arg },
      put (name, arg) { return arg },
      generic (name, options) { return options },
    }

    patchApp(app)

    assert.notEqual(app.http, undefined)
    assert.notEqual(app.generic, undefined)
  })
})

describe('otel-azure-durable-functions', () => {
  it('wraps orchestration, activity, and entity registration methods', () => {
    const { patchApp } = proxyquire('../../src/otel-azure-durable-functions', {
      '../../datadog-shimmer': require('../../../datadog-shimmer'),
    })
    const app = {
      entity (name, arg) { return arg },
      activity (name, options) { return options },
      orchestration (name, handler) { return handler },
    }

    patchApp(app)

    assert.notEqual(app.entity, undefined)
    assert.notEqual(app.activity, undefined)
    assert.notEqual(app.orchestration, undefined)
  })
})
