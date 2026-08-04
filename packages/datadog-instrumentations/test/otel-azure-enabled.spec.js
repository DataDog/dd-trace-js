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
})
