'use strict'

const assert = require('assert')
const sinon = require('sinon')
const { it, describe, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')

require('./setup/core')

describe('config-helper stable config sources', () => {
  let isInServerlessEnvironmentStub
  let StableConfigStub

  beforeEach(() => {
    isInServerlessEnvironmentStub = sinon.stub()
    StableConfigStub = sinon.stub()
  })

  afterEach(() => {
    sinon.restore()
  })

  it('loads stable config when not in serverless environment', () => {
    isInServerlessEnvironmentStub.returns(false)

    StableConfigStub.callsFake(function () {
      this.localEntries = {
        DD_SERVICE: 'local-service',
        DD_ENV: 'local-env',
        DD_VERSION: 'local-version'
      }
      this.fleetEntries = {
        DD_SERVICE: 'fleet-service',
        DD_ENV: 'fleet-env'
      }
      this.warnings = []
    })

    const { getStableConfigSources } = proxyquire('../src/config/helper', {
      '../serverless': {
        isInServerlessEnvironment: isInServerlessEnvironmentStub
      },
      './stable': StableConfigStub
    })

    const sources = getStableConfigSources()

    assert.strictEqual(StableConfigStub.calledOnce, true)
    assert.deepStrictEqual(sources.localStableConfig, {
      DD_SERVICE: 'local-service',
      DD_ENV: 'local-env',
      DD_VERSION: 'local-version'
    })
    assert.deepStrictEqual(sources.fleetStableConfig, {
      DD_SERVICE: 'fleet-service',
      DD_ENV: 'fleet-env'
    })
    assert.deepStrictEqual(sources.stableConfigWarnings, [])
  })

  it('does not load stable config in serverless environment', () => {
    isInServerlessEnvironmentStub.returns(true)

    const { getStableConfigSources } = proxyquire('../src/config/helper', {
      '../serverless': {
        isInServerlessEnvironment: isInServerlessEnvironmentStub
      },
      './stable': StableConfigStub
    })

    const sources = getStableConfigSources()

    assert.strictEqual(StableConfigStub.called, false)
    assert.strictEqual(sources.localStableConfig, undefined)
    assert.strictEqual(sources.fleetStableConfig, undefined)
  })

  it('handles empty or missing stable config entries', () => {
    const { getStableConfigSources } = require('../src/config/helper')

    const sources = getStableConfigSources()

    assert.deepStrictEqual(sources.localStableConfig, {})
    assert.deepStrictEqual(sources.fleetStableConfig, {})
  })
})

describe('config-helper env resolution', () => {
  let getValueFromEnvSources
  let getEnvironmentVariable
  let resetModule
  let isInServerlessEnvironmentStub
  let originalEnv

  function loadModule (overrides = {}) {
    // Ensure we always get a fresh copy of the module when needed
    const mod = proxyquire('../src/config/helper', overrides)
    getValueFromEnvSources = mod.getValueFromEnvSources
    getEnvironmentVariable = mod.getEnvironmentVariable
    resetModule = () => {}
  }

  beforeEach(() => {
    originalEnv = process.env
    process.env = { ...originalEnv }
    isInServerlessEnvironmentStub = sinon.stub().returns(true)

    loadModule({
      '../serverless': {
        isInServerlessEnvironment: isInServerlessEnvironmentStub
      }
    })
  })

  afterEach(() => {
    sinon.restore()
    process.env = originalEnv
    if (resetModule) resetModule()
  })

  it('returns value from env for supported configuration', () => {
    process.env.DD_SERVICE = 'my-service'
    process.env.DD_ENV = 'production'

    const value = getValueFromEnvSources('DD_SERVICE')

    assert.strictEqual(value, 'my-service')
  })

  it('falls back to alias if canonical name is not set', () => {
    process.env.DD_TRACE_AGENT_HOSTNAME = 'alias-hostname'

    const value = getValueFromEnvSources('DD_AGENT_HOST')

    assert.strictEqual(value, 'alias-hostname')
  })

  it('returns undefined if neither canonical nor alias is set', () => {
    process.env.DD_SERVICE = 'my-service'

    const value = getValueFromEnvSources('DD_ENV')

    assert.strictEqual(value, undefined)
  })

  it('prefers canonical name over alias', () => {
    process.env.DD_AGENT_HOST = 'canonical-hostname'
    process.env.DD_TRACE_AGENT_HOSTNAME = 'alias-hostname'

    const value = getValueFromEnvSources('DD_AGENT_HOST')

    assert.strictEqual(value, 'canonical-hostname')
  })

  it('throws for unsupported DD_ configuration', () => {
    assert.throws(
      () => getEnvironmentVariable('DD_UNSUPPORTED_CONFIG'),
      /Missing DD_UNSUPPORTED_CONFIG env\/configuration in "supported-configurations\.json" file\./
    )
  })

  it('throws for unsupported OTEL_ configuration', () => {
    assert.throws(
      () => getEnvironmentVariable('OTEL_UNSUPPORTED_CONFIG'),
      /Missing OTEL_UNSUPPORTED_CONFIG env\/configuration in "supported-configurations\.json" file\./
    )
  })

  it('returns value for non-DD/OTEL environment variables', () => {
    process.env.NODE_ENV = 'production'

    const value = getValueFromEnvSources('NODE_ENV')

    assert.strictEqual(value, 'production')
  })

  it('calls serverless detection only once when resolving multiple envs', () => {
    process.env.DD_SERVICE = 'my-service'

    getValueFromEnvSources('DD_SERVICE')
    getValueFromEnvSources('DD_ENV')

    assert.strictEqual(isInServerlessEnvironmentStub.callCount, 1)
  })

  describe('with stable config and env vars', () => {
    beforeEach(() => {
      // Re-load module with stable config enabled (non-serverless)
      const StableConfigStub = sinon.stub()
      StableConfigStub.callsFake(function () {
        this.localEntries = {
          DD_SERVICE: 'local-service',
          DD_ENV: 'local-env'
        }
        this.fleetEntries = {
          DD_SERVICE: 'fleet-service'
        }
        this.warnings = []
      })

      const isInServerlessStub = sinon.stub().returns(false)

      const mod = proxyquire('../src/config/helper', {
        '../serverless': {
          isInServerlessEnvironment: isInServerlessStub
        },
        './stable': StableConfigStub
      })

      getValueFromEnvSources = mod.getValueFromEnvSources
      getEnvironmentVariable = mod.getEnvironmentVariable
    })

    it('uses fleet over env over local', () => {
      process.env.DD_TRACE_SAMPLE_RATE = '0.5'
      process.env.DD_TRACE_ENABLED = 'true'

      const StableConfigStub = sinon.stub()
      StableConfigStub.callsFake(function () {
        this.localEntries = {
          DD_TRACE_SAMPLE_RATE: '0.1',
          DD_TRACE_ENABLED: 'false',
          DD_SERVICE: 'local'
        }
        this.fleetEntries = {
          DD_TRACE_SAMPLE_RATE: '0.9',
          DD_SERVICE: 'fleet'
        }
        this.warnings = []
      })

      const isInServerlessStub = sinon.stub().returns(false)

      const mod = proxyquire('../src/config/helper', {
        '../serverless': {
          isInServerlessEnvironment: isInServerlessStub
        },
        './stable': StableConfigStub
      })

      getValueFromEnvSources = mod.getValueFromEnvSources

      assert.strictEqual(getValueFromEnvSources('DD_TRACE_SAMPLE_RATE'), '0.9')
      assert.strictEqual(getValueFromEnvSources('DD_SERVICE'), 'fleet')
      assert.strictEqual(getValueFromEnvSources('DD_TRACE_ENABLED'), 'true')
    })

    it('does not override defined values with undefined', () => {
      const StableConfigStub = sinon.stub()
      StableConfigStub.callsFake(function () {
        this.localEntries = {
          DD_SERVICE: 'local-service'
        }
        this.fleetEntries = {
          DD_SERVICE: undefined
        }
        this.warnings = []
      })

      const isInServerlessStub = sinon.stub().returns(false)

      const mod = proxyquire('../src/config/helper', {
        '../serverless': {
          isInServerlessEnvironment: isInServerlessStub
        },
        './stable': StableConfigStub
      })

      getValueFromEnvSources = mod.getValueFromEnvSources

      assert.strictEqual(getValueFromEnvSources('DD_SERVICE'), 'local-service')
    })
  })
})
