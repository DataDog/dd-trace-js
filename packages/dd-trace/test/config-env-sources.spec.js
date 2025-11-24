'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const { it, describe, beforeEach, afterEach } = require('tap').mocha
const proxyquire = require('proxyquire')

require('./setup/core')

describe('ConfigEnvSources', () => {
  let ConfigEnvSources
  let createConfigEnvSources
  let getConfigEnvSources
  let resetConfigEnvSources
  let getEnvironmentVariablesStub
  let isInServerlessEnvironmentStub
  let StableConfigStub

  beforeEach(() => {
    // Reset stubs
    getEnvironmentVariablesStub = sinon.stub()
    isInServerlessEnvironmentStub = sinon.stub()
    StableConfigStub = sinon.stub()

    // Load module with stubs
    const mod = proxyquire('../src/config-env-sources', {
      './config-helper': {
        getEnvironmentVariables: getEnvironmentVariablesStub
      },
      './serverless': {
        isInServerlessEnvironment: isInServerlessEnvironmentStub
      },
      './config_stable': StableConfigStub
    })

    ConfigEnvSources = mod.ConfigEnvSources
    createConfigEnvSources = mod.createConfigEnvSources
    getConfigEnvSources = mod.getConfigEnvSources
    resetConfigEnvSources = mod.resetConfigEnvSources

    // Reset singleton
    resetConfigEnvSources()
  })

  afterEach(() => {
    sinon.restore()
    resetConfigEnvSources()
  })

  describe('constructor', () => {
    it('should merge sources in correct priority order: local < env < fleet', () => {
      isInServerlessEnvironmentStub.returns(false)
      
      // Mock stable config with local and fleet entries
      StableConfigStub.returns({
        localEntries: {
          DD_SERVICE: 'local-service',
          DD_ENV: 'local-env',
          DD_VERSION: 'local-version'
        },
        fleetEntries: {
          DD_SERVICE: 'fleet-service',
          DD_ENV: 'fleet-env'
        },
        warnings: []
      })

      // Mock environment variables
      getEnvironmentVariablesStub.returns({
        DD_SERVICE: 'env-service',
        DD_TRACE_ENABLED: 'true'
      })

      const sources = new ConfigEnvSources()

      // Fleet should win for DD_SERVICE
      expect(sources.DD_SERVICE).to.equal('fleet-service')
      // Fleet should win for DD_ENV
      expect(sources.DD_ENV).to.equal('fleet-env')
      // Env should win for DD_TRACE_ENABLED (not in stable config)
      expect(sources.DD_TRACE_ENABLED).to.equal('true')
      // Local should be used for DD_VERSION (not overridden)
      expect(sources.DD_VERSION).to.equal('local-version')
    })

    it('should use environment variables when stable config is not available', () => {
      isInServerlessEnvironmentStub.returns(false)
      
      // StableConfig throws error (not available)
      StableConfigStub.throws(new Error('Config not found'))

      getEnvironmentVariablesStub.returns({
        DD_SERVICE: 'env-service',
        DD_ENV: 'env-env'
      })

      const sources = new ConfigEnvSources()

      expect(sources.DD_SERVICE).to.equal('env-service')
      expect(sources.DD_ENV).to.equal('env-env')
    })

    it('should not load stable config in serverless environment', () => {
      isInServerlessEnvironmentStub.returns(true)

      getEnvironmentVariablesStub.returns({
        DD_SERVICE: 'env-service',
        DD_ENV: 'env-env'
      })

      const sources = new ConfigEnvSources()

      // StableConfig should not be called
      expect(StableConfigStub.called).to.be.false
      expect(sources.DD_SERVICE).to.equal('env-service')
      expect(sources.DD_ENV).to.equal('env-env')
    })

    it('should handle undefined values correctly', () => {
      isInServerlessEnvironmentStub.returns(false)
      
      StableConfigStub.returns({
        localEntries: {
          DD_SERVICE: 'local-service',
          DD_ENV: undefined
        },
        fleetEntries: {
          DD_VERSION: 'fleet-version'
        },
        warnings: []
      })

      getEnvironmentVariablesStub.returns({
        DD_TRACE_ENABLED: 'true',
        DD_TRACE_DEBUG: undefined
      })

      const sources = new ConfigEnvSources()

      expect(sources.DD_SERVICE).to.equal('local-service')
      expect(sources.DD_ENV).to.be.undefined
      expect(sources.DD_VERSION).to.equal('fleet-version')
      expect(sources.DD_TRACE_ENABLED).to.equal('true')
      expect(sources.DD_TRACE_DEBUG).to.be.undefined
    })

    it('should make values accessible as properties', () => {
      isInServerlessEnvironmentStub.returns(false)
      
      StableConfigStub.returns({
        localEntries: {},
        fleetEntries: {},
        warnings: []
      })

      getEnvironmentVariablesStub.returns({
        DD_SERVICE: 'my-service',
        DD_ENV: 'production'
      })

      const sources = new ConfigEnvSources()

      // Access as property
      expect(sources.DD_SERVICE).to.equal('my-service')
      // Access as bracket notation
      expect(sources['DD_ENV']).to.equal('production')
    })

    it('should handle empty stable config entries', () => {
      isInServerlessEnvironmentStub.returns(false)
      
      StableConfigStub.returns({
        localEntries: null,
        fleetEntries: undefined,
        warnings: []
      })

      getEnvironmentVariablesStub.returns({
        DD_SERVICE: 'env-service'
      })

      const sources = new ConfigEnvSources()

      expect(sources.DD_SERVICE).to.equal('env-service')
    })
  })

  describe('createConfigEnvSources', () => {
    it('should create a new ConfigEnvSources instance', () => {
      isInServerlessEnvironmentStub.returns(true)
      getEnvironmentVariablesStub.returns({})

      const sources1 = createConfigEnvSources()
      const sources2 = createConfigEnvSources()

      expect(sources1).to.be.instanceof(ConfigEnvSources)
      expect(sources2).to.be.instanceof(ConfigEnvSources)
      expect(sources1).to.not.equal(sources2)
    })
  })

  describe('getConfigEnvSources', () => {
    it('should return a singleton instance', () => {
      isInServerlessEnvironmentStub.returns(true)
      getEnvironmentVariablesStub.returns({})

      const sources1 = getConfigEnvSources()
      const sources2 = getConfigEnvSources()

      expect(sources1).to.be.instanceof(ConfigEnvSources)
      expect(sources1).to.equal(sources2)
    })

    it('should create instance only once', () => {
      isInServerlessEnvironmentStub.returns(false)
      
      StableConfigStub.returns({
        localEntries: {},
        fleetEntries: {},
        warnings: []
      })

      getEnvironmentVariablesStub.returns({})

      getConfigEnvSources()
      getConfigEnvSources()
      getConfigEnvSources()

      // StableConfig should only be called once
      expect(StableConfigStub.callCount).to.equal(1)
      expect(getEnvironmentVariablesStub.callCount).to.equal(1)
    })
  })

  describe('resetConfigEnvSources', () => {
    it('should reset the singleton instance', () => {
      isInServerlessEnvironmentStub.returns(true)
      getEnvironmentVariablesStub.returns({})

      const sources1 = getConfigEnvSources()
      resetConfigEnvSources()
      const sources2 = getConfigEnvSources()

      expect(sources1).to.not.equal(sources2)
    })

    it('should allow fresh instance creation with updated values', () => {
      isInServerlessEnvironmentStub.returns(true)
      
      getEnvironmentVariablesStub.onCall(0).returns({
        DD_SERVICE: 'service-1'
      })

      const sources1 = getConfigEnvSources()
      expect(sources1.DD_SERVICE).to.equal('service-1')

      resetConfigEnvSources()

      getEnvironmentVariablesStub.onCall(1).returns({
        DD_SERVICE: 'service-2'
      })

      const sources2 = getConfigEnvSources()
      expect(sources2.DD_SERVICE).to.equal('service-2')
    })
  })

  describe('priority scenarios', () => {
    it('should prioritize fleet over env over local', () => {
      isInServerlessEnvironmentStub.returns(false)
      
      StableConfigStub.returns({
        localEntries: {
          DD_TRACE_SAMPLE_RATE: '0.1',
          DD_TRACE_ENABLED: 'false',
          DD_SERVICE: 'local'
        },
        fleetEntries: {
          DD_TRACE_SAMPLE_RATE: '0.9',
          DD_SERVICE: 'fleet'
        },
        warnings: []
      })

      getEnvironmentVariablesStub.returns({
        DD_TRACE_SAMPLE_RATE: '0.5',
        DD_TRACE_ENABLED: 'true'
      })

      const sources = new ConfigEnvSources()

      // Fleet wins
      expect(sources.DD_TRACE_SAMPLE_RATE).to.equal('0.9')
      expect(sources.DD_SERVICE).to.equal('fleet')
      // Env wins (not in fleet)
      expect(sources.DD_TRACE_ENABLED).to.equal('true')
    })

    it('should not override defined values with undefined', () => {
      isInServerlessEnvironmentStub.returns(false)
      
      StableConfigStub.returns({
        localEntries: {
          DD_SERVICE: 'local-service'
        },
        fleetEntries: {
          DD_SERVICE: undefined
        },
        warnings: []
      })

      getEnvironmentVariablesStub.returns({
        DD_SERVICE: undefined
      })

      const sources = new ConfigEnvSources()

      // Local value should remain since higher priorities are undefined
      expect(sources.DD_SERVICE).to.equal('local-service')
    })
  })
})

describe('getEnvironmentVariableSources', () => {
  let getEnvironmentVariableSources
  let ConfigEnvSources
  let getConfigEnvSources
  let resetConfigEnvSources
  let getEnvironmentVariablesStub
  let isInServerlessEnvironmentStub

  beforeEach(() => {
    // Reset stubs
    getEnvironmentVariablesStub = sinon.stub()
    isInServerlessEnvironmentStub = sinon.stub().returns(true)

    // Load config-env-sources with stubs
    const configEnvSourcesMod = proxyquire('../src/config-env-sources', {
      './config-helper': {
        getEnvironmentVariables: getEnvironmentVariablesStub
      },
      './serverless': {
        isInServerlessEnvironment: isInServerlessEnvironmentStub
      }
    })

    ConfigEnvSources = configEnvSourcesMod.ConfigEnvSources
    getConfigEnvSources = configEnvSourcesMod.getConfigEnvSources
    resetConfigEnvSources = configEnvSourcesMod.resetConfigEnvSources
    getEnvironmentVariableSources = configEnvSourcesMod.getEnvironmentVariableSources

    // Reset singleton
    resetConfigEnvSources()
  })

  afterEach(() => {
    sinon.restore()
    resetConfigEnvSources()
  })

  it('should return value from ConfigEnvSources for supported configuration', () => {
    getEnvironmentVariablesStub.returns({
      DD_SERVICE: 'my-service',
      DD_ENV: 'production'
    })

    const value = getEnvironmentVariableSources('DD_SERVICE')

    expect(value).to.equal('my-service')
  })

  it('should fall back to alias if canonical name is not set', () => {
    getEnvironmentVariablesStub.returns({
      DD_TRACE_AGENT_HOSTNAME: 'alias-hostname'
    })

    // DD_AGENT_HOST is the canonical name, DD_TRACE_AGENT_HOSTNAME is an alias
    const value = getEnvironmentVariableSources('DD_AGENT_HOST')

    expect(value).to.equal('alias-hostname')
  })

  it('should return undefined if neither canonical nor alias is set', () => {
    getEnvironmentVariablesStub.returns({
      DD_SERVICE: 'my-service'
    })

    const value = getEnvironmentVariableSources('DD_ENV')

    expect(value).to.be.undefined
  })

  it('should prefer canonical name over alias', () => {
    getEnvironmentVariablesStub.returns({
      DD_AGENT_HOST: 'canonical-hostname',
      DD_TRACE_AGENT_HOSTNAME: 'alias-hostname'
    })

    const value = getEnvironmentVariableSources('DD_AGENT_HOST')

    expect(value).to.equal('canonical-hostname')
  })

  it('should throw error for unsupported DD_ configuration', () => {
    getEnvironmentVariablesStub.returns({})

    expect(() => {
      getEnvironmentVariableSources('DD_UNSUPPORTED_CONFIG')
    }).to.throw('Missing DD_UNSUPPORTED_CONFIG env/configuration in "supported-configurations.json" file.')
  })

  it('should throw error for unsupported OTEL_ configuration', () => {
    getEnvironmentVariablesStub.returns({})

    expect(() => {
      getEnvironmentVariableSources('OTEL_UNSUPPORTED_CONFIG')
    }).to.throw('Missing OTEL_UNSUPPORTED_CONFIG env/configuration in "supported-configurations.json" file.')
  })

  it('should return value for non-DD/OTEL environment variables', () => {
    getEnvironmentVariablesStub.returns({
      NODE_ENV: 'production',
      PATH: '/usr/bin'
    })

    const value = getEnvironmentVariableSources('NODE_ENV')

    expect(value).to.equal('production')
  })

  it('should use singleton ConfigEnvSources instance', () => {
    getEnvironmentVariablesStub.returns({
      DD_SERVICE: 'my-service'
    })

    getEnvironmentVariableSources('DD_SERVICE')
    getEnvironmentVariableSources('DD_ENV')

    // getEnvironmentVariables should only be called once (when singleton is created)
    expect(getEnvironmentVariablesStub.callCount).to.equal(1)
  })

  it('should work with merged values from stable config and env vars', () => {
    const StableConfigStub = sinon.stub().returns({
      localEntries: {
        DD_SERVICE: 'local-service'
      },
      fleetEntries: {
        DD_SERVICE: 'fleet-service'
      },
      warnings: []
    })

    const isInServerlessStub = sinon.stub().returns(false)
    const getEnvVarsStub = sinon.stub().returns({
      DD_ENV: 'production'
    })

    // Re-setup with stable config stub
    resetConfigEnvSources()
    const configEnvSourcesMod = proxyquire('../src/config-env-sources', {
      './config-helper': {
        getEnvironmentVariables: getEnvVarsStub
      },
      './serverless': {
        isInServerlessEnvironment: isInServerlessStub
      },
      './config_stable': StableConfigStub
    })

    const getEnvVarSources = configEnvSourcesMod.getEnvironmentVariableSources

    // Fleet should win for DD_SERVICE
    expect(getEnvVarSources('DD_SERVICE')).to.equal('fleet-service')
    // Env var should be used for DD_ENV
    expect(getEnvVarSources('DD_ENV')).to.equal('production')
  })
})

