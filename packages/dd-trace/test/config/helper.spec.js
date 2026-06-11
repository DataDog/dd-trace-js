'use strict'

const assert = require('assert')
const sinon = require('sinon')
const { it, describe, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')

require('../setup/core')

const { applyPm2ClusterEnv } = require('../../src/config/helper')

describe('applyPm2ClusterEnv', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = process.env
    process.env = {}
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('copies DD_* keys from pm2_env blob into process.env', () => {
    process.env.pm2_env = JSON.stringify({ DD_SERVICE: 'pm2-service', DD_ENV: 'pm2-env' })
    applyPm2ClusterEnv()
    assert.strictEqual(process.env.DD_SERVICE, 'pm2-service')
    assert.strictEqual(process.env.DD_ENV, 'pm2-env')
  })

  it('copies OTEL_* keys from pm2_env blob into process.env', () => {
    process.env.pm2_env = JSON.stringify({ OTEL_SERVICE_NAME: 'pm2-otel-service' })
    applyPm2ClusterEnv()
    assert.strictEqual(process.env.OTEL_SERVICE_NAME, 'pm2-otel-service')
  })

  it('does not overwrite DD_* keys already present in process.env', () => {
    process.env.DD_SERVICE = 'host-service'
    process.env.pm2_env = JSON.stringify({ DD_SERVICE: 'pm2-service' })
    applyPm2ClusterEnv()
    assert.strictEqual(process.env.DD_SERVICE, 'host-service')
  })

  it('does not overwrite OTEL_* keys already present in process.env', () => {
    process.env.OTEL_SERVICE_NAME = 'host-otel'
    process.env.pm2_env = JSON.stringify({ OTEL_SERVICE_NAME: 'pm2-otel' })
    applyPm2ClusterEnv()
    assert.strictEqual(process.env.OTEL_SERVICE_NAME, 'host-otel')
  })

  it('does not copy non-DD/OTEL keys', () => {
    process.env.pm2_env = JSON.stringify({ NODE_ENV: 'production', pm_id: 0 })
    applyPm2ClusterEnv()
    assert.strictEqual(process.env.NODE_ENV, undefined)
    assert.strictEqual(process.env.pm_id, undefined)
  })

  it('skips keys with null values', () => {
    process.env.pm2_env = JSON.stringify({ DD_SERVICE: null })
    applyPm2ClusterEnv()
    assert.strictEqual(process.env.DD_SERVICE, undefined)
  })

  it('coerces non-string values to string', () => {
    process.env.pm2_env = JSON.stringify({ DD_TRACE_SAMPLE_RATE: 0.5 })
    applyPm2ClusterEnv()
    assert.strictEqual(process.env.DD_TRACE_SAMPLE_RATE, '0.5')
  })

  it('does nothing when pm2_env is absent', () => {
    applyPm2ClusterEnv()
    assert.deepStrictEqual(Object.keys(process.env), [])
  })

  it('does nothing when pm2_env is not a string', () => {
    process.env.pm2_env = 42
    applyPm2ClusterEnv()
    assert.deepStrictEqual(Object.keys(process.env), ['pm2_env'])
  })

  it('does nothing when pm2_env is malformed JSON', () => {
    process.env.pm2_env = 'not-valid-json'
    applyPm2ClusterEnv()
    assert.deepStrictEqual(Object.keys(process.env), ['pm2_env'])
  })

  it('populates process.env before module exports are first accessed (early-read scenario)', () => {
    // Simulates the PM2 cluster mode timing: pm2_env is present in process.env
    // when helper.js is first required, so the module-level call runs before
    // index.js reads DD_TRACE_ENABLED / OTEL_TRACES_EXPORTER.
    process.env.pm2_env = JSON.stringify({ DD_TRACE_ENABLED: 'false', DD_SERVICE: 'early-service' })
    const { getValueFromEnvSources } = proxyquire.noPreserveCache()('../../src/config/helper', {})
    assert.strictEqual(getValueFromEnvSources('DD_TRACE_ENABLED'), 'false')
    assert.strictEqual(getValueFromEnvSources('DD_SERVICE'), 'early-service')
  })
})

describe('config-helper stable config sources', () => {
  let StableConfigStub

  beforeEach(() => {
    StableConfigStub = sinon.stub()
  })

  afterEach(() => {
    sinon.restore()
  })

  it('loads stable config when not in serverless environment', () => {
    StableConfigStub.callsFake(function () {
      this.localEntries = {
        DD_SERVICE: 'local-service',
        DD_ENV: 'local-env',
        DD_VERSION: 'local-version',
      }
      this.fleetEntries = {
        DD_SERVICE: 'fleet-service',
        DD_ENV: 'fleet-env',
      }
      this.warnings = []
    })

    const { getStableConfigSources } = proxyquire('../../src/config/helper', {
      '../serverless': {
        IS_SERVERLESS: false,
      },
      './stable': StableConfigStub,
    })

    const sources = getStableConfigSources()

    assert.strictEqual(StableConfigStub.calledOnce, true)
    assert.deepStrictEqual(sources.localStableConfig, {
      DD_SERVICE: 'local-service',
      DD_ENV: 'local-env',
      DD_VERSION: 'local-version',
    })
    assert.deepStrictEqual(sources.fleetStableConfig, {
      DD_SERVICE: 'fleet-service',
      DD_ENV: 'fleet-env',
    })
    assert.deepStrictEqual(sources.stableConfigWarnings, [])
  })

  it('does not load stable config in serverless environment', () => {
    const { getStableConfigSources } = proxyquire('../../src/config/helper', {
      '../serverless': {
        IS_SERVERLESS: true,
      },
      './stable': StableConfigStub,
    })

    const sources = getStableConfigSources()

    assert.strictEqual(StableConfigStub.called, false)
    assert.strictEqual(sources.localStableConfig, undefined)
    assert.strictEqual(sources.fleetStableConfig, undefined)
  })

  it('handles empty or missing stable config entries', () => {
    const { getStableConfigSources } = require('../../src/config/helper')

    const sources = getStableConfigSources()

    assert.deepStrictEqual(sources.localStableConfig, {})
    assert.deepStrictEqual(sources.fleetStableConfig, {})
  })
})

describe('config-helper env resolution', () => {
  let getValueFromEnvSources
  let getConfiguredEnvName
  let getEnvironmentVariable
  let resetModule
  let originalEnv

  function loadModule (overrides = {}) {
    // Ensure we always get a fresh copy of the module when needed
    const mod = proxyquire('../../src/config/helper', overrides)
    getValueFromEnvSources = mod.getValueFromEnvSources
    getConfiguredEnvName = mod.getConfiguredEnvName
    getEnvironmentVariable = mod.getEnvironmentVariable
    resetModule = () => {}
  }

  beforeEach(() => {
    originalEnv = process.env
    process.env = { ...originalEnv }

    loadModule({
      '../serverless': {
        IS_SERVERLESS: true,
      },
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

  it('returns the env name used for canonical values', () => {
    process.env.DD_TRACE_AGENT_HOSTNAME = 'alias-hostname'
    process.env.DD_AGENT_HOST = 'canonical-hostname'

    const envName = getConfiguredEnvName('DD_AGENT_HOST')

    assert.strictEqual(envName, 'DD_AGENT_HOST')
  })

  it('returns the env alias name when alias is used', () => {
    process.env.DD_TRACE_AGENT_HOSTNAME = 'alias-hostname'

    const envName = getConfiguredEnvName('DD_AGENT_HOST')

    assert.strictEqual(envName, 'DD_TRACE_AGENT_HOSTNAME')
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

  describe('with stable config and env vars', () => {
    beforeEach(() => {
      // Re-load module with stable config enabled (non-serverless)
      const StableConfigStub = sinon.stub()
      StableConfigStub.callsFake(function () {
        this.localEntries = {
          DD_SERVICE: 'local-service',
          DD_ENV: 'local-env',
        }
        this.fleetEntries = {
          DD_SERVICE: 'fleet-service',
        }
        this.warnings = []
      })

      const mod = proxyquire('../../src/config/helper', {
        '../serverless': {
          IS_SERVERLESS: false,
        },
        './stable': StableConfigStub,
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
          DD_SERVICE: 'local',
        }
        this.fleetEntries = {
          DD_TRACE_SAMPLE_RATE: '0.9',
          DD_SERVICE: 'fleet',
        }
        this.warnings = []
      })

      const mod = proxyquire('../../src/config/helper', {
        '../serverless': {
          IS_SERVERLESS: false,
        },
        './stable': StableConfigStub,
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
          DD_SERVICE: 'local-service',
        }
        this.fleetEntries = {
          DD_SERVICE: undefined,
        }
        this.warnings = []
      })

      const mod = proxyquire('../../src/config/helper', {
        '../serverless': {
          IS_SERVERLESS: false,
        },
        './stable': StableConfigStub,
      })

      getValueFromEnvSources = mod.getValueFromEnvSources

      assert.strictEqual(getValueFromEnvSources('DD_SERVICE'), 'local-service')
    })
  })
})
