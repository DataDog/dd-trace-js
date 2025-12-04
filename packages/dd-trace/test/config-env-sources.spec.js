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
  let isInServerlessEnvironmentStub
  let StableConfigStub

  beforeEach(() => {
    // Reset stubs
    isInServerlessEnvironmentStub = sinon.stub()
    StableConfigStub = sinon.stub()

    // Load module with stubs
    const mod = proxyquire('../src/config-env-sources', {
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
    it('should load stable config when not in serverless environment', () => {
      isInServerlessEnvironmentStub.returns(false)

      // Mock stable config with local and fleet entries
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

      const sources = new ConfigEnvSources()

      expect(StableConfigStub.calledOnce).to.be.true
      expect(sources.localStableConfig).to.deep.equal({
        DD_SERVICE: 'local-service',
        DD_ENV: 'local-env',
        DD_VERSION: 'local-version'
      })
      expect(sources.fleetStableConfig).to.deep.equal({
        DD_SERVICE: 'fleet-service',
        DD_ENV: 'fleet-env'
      })
    })

    it('should not load stable config in serverless environment', () => {
      isInServerlessEnvironmentStub.returns(true)

      const sources = new ConfigEnvSources()

      // StableConfig should not be called
      expect(StableConfigStub.called).to.be.false
      expect(sources.localStableConfig).to.deep.equal({})
      expect(sources.fleetStableConfig).to.deep.equal({})
    })

    it('should handle empty or missing stable config entries', () => {
      isInServerlessEnvironmentStub.returns(false)

      StableConfigStub.callsFake(function () {
        this.localEntries = null
        this.fleetEntries = undefined
        this.warnings = []
      })

      const sources = new ConfigEnvSources()

      expect(sources.localStableConfig).to.deep.equal({})
      expect(sources.fleetStableConfig).to.deep.equal({})
    })
  })

  describe('createConfigEnvSources', () => {
    it('should create a new ConfigEnvSources instance', () => {
      isInServerlessEnvironmentStub.returns(true)

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

      const sources1 = getConfigEnvSources()
      const sources2 = getConfigEnvSources()

      expect(sources1).to.be.instanceof(ConfigEnvSources)
      expect(sources1).to.equal(sources2)
    })

    it('should create instance only once', () => {
      isInServerlessEnvironmentStub.returns(false)

      StableConfigStub.callsFake(function () {
        this.localEntries = {}
        this.fleetEntries = {}
        this.warnings = []
      })

      getConfigEnvSources()
      getConfigEnvSources()
      getConfigEnvSources()

      // StableConfig should only be instantiated once
      expect(StableConfigStub.callCount).to.equal(1)
    })
  })

  describe('resetConfigEnvSources', () => {
    it('should reset the singleton instance', () => {
      isInServerlessEnvironmentStub.returns(true)

      const sources1 = getConfigEnvSources()
      resetConfigEnvSources()
      const sources2 = getConfigEnvSources()

      expect(sources1).to.not.equal(sources2)
    })

    it('should allow fresh instance creation with updated values', () => {
      isInServerlessEnvironmentStub.returns(false)

      StableConfigStub.onCall(0).callsFake(function () {
        this.localEntries = {
          DD_SERVICE: 'service-1'
        }
        this.fleetEntries = {}
        this.warnings = []
      })

      StableConfigStub.onCall(1).callsFake(function () {
        this.localEntries = {
          DD_SERVICE: 'service-2'
        }
        this.fleetEntries = {}
        this.warnings = []
      })

      const sources1 = getConfigEnvSources()
      expect(sources1.localStableConfig.DD_SERVICE).to.equal('service-1')

      resetConfigEnvSources()

      const sources2 = getConfigEnvSources()
      expect(sources2.localStableConfig.DD_SERVICE).to.equal('service-2')
    })
  })
})

describe('getResolvedEnv', () => {
  let getResolvedEnv
  let resetConfigEnvSources
  let isInServerlessEnvironmentStub
  let originalEnv

  beforeEach(() => {
    isInServerlessEnvironmentStub = sinon.stub().returns(true)
    originalEnv = process.env
    process.env = { ...originalEnv }

    const configEnvSourcesMod = proxyquire('../src/config-env-sources', {
      './serverless': {
        isInServerlessEnvironment: isInServerlessEnvironmentStub
      }
    })

    resetConfigEnvSources = configEnvSourcesMod.resetConfigEnvSources
    getResolvedEnv = configEnvSourcesMod.getResolvedEnv

    // Reset singleton
    resetConfigEnvSources()
  })

  afterEach(() => {
    sinon.restore()
    resetConfigEnvSources()
    process.env = originalEnv
  })

  it('should return value from ConfigEnvSources for supported configuration', () => {
    process.env.DD_SERVICE = 'my-service'
    process.env.DD_ENV = 'production'

    const value = getResolvedEnv('DD_SERVICE')

    expect(value).to.equal('my-service')
  })

  it('should fall back to alias if canonical name is not set', () => {
    process.env.DD_TRACE_AGENT_HOSTNAME = 'alias-hostname'

    // DD_AGENT_HOST is the canonical name, DD_TRACE_AGENT_HOSTNAME is an alias
    const value = getResolvedEnv('DD_AGENT_HOST')

    expect(value).to.equal('alias-hostname')
  })

  it('should return undefined if neither canonical nor alias is set', () => {
    process.env.DD_SERVICE = 'my-service'

    const value = getResolvedEnv('DD_ENV')

    expect(value).to.be.undefined
  })

  it('should prefer canonical name over alias', () => {
    process.env.DD_AGENT_HOST = 'canonical-hostname'
    process.env.DD_TRACE_AGENT_HOSTNAME = 'alias-hostname'

    const value = getResolvedEnv('DD_AGENT_HOST')

    expect(value).to.equal('canonical-hostname')
  })

  it('should throw error for unsupported DD_ configuration', () => {
    expect(() => {
      getResolvedEnv('DD_UNSUPPORTED_CONFIG')
    }).to.throw('Missing DD_UNSUPPORTED_CONFIG env/configuration in "supported-configurations.json" file.')
  })

  it('should throw error for unsupported OTEL_ configuration', () => {
    expect(() => {
      getResolvedEnv('OTEL_UNSUPPORTED_CONFIG')
    }).to.throw('Missing OTEL_UNSUPPORTED_CONFIG env/configuration in "supported-configurations.json" file.')
  })

  it('should return value for non-DD/OTEL environment variables', () => {
    process.env.NODE_ENV = 'production'
    process.env.PATH = '/usr/bin'

    const value = getResolvedEnv('NODE_ENV')

    expect(value).to.equal('production')
  })

  it('should use singleton ConfigEnvSources instance', () => {
    isInServerlessEnvironmentStub.returns(true)
    process.env.DD_SERVICE = 'my-service'

    getResolvedEnv('DD_SERVICE')
    getResolvedEnv('DD_ENV')

    // ConfigEnvSources should only be instantiated once (isInServerlessEnvironment called once)
    expect(isInServerlessEnvironmentStub.callCount).to.equal(1)
  })

  it('should work with merged values from stable config and env vars', () => {
    const StableConfigStub = sinon.stub()
    StableConfigStub.callsFake(function () {
      this.localEntries = {
        DD_SERVICE: 'local-service'
      }
      this.fleetEntries = {
        DD_SERVICE: 'fleet-service'
      }
      this.warnings = []
    })

    const isInServerlessStub = sinon.stub().returns(false)
    process.env.DD_ENV = 'production'

    // Re-setup with stable config stub
    resetConfigEnvSources()
    const configEnvSourcesMod = proxyquire('../src/config-env-sources', {
      './serverless': {
        isInServerlessEnvironment: isInServerlessStub
      },
      './config_stable': StableConfigStub
    })

    const getResolvedEnvFn = configEnvSourcesMod.getResolvedEnv

    // Fleet should win for DD_SERVICE
    expect(getResolvedEnvFn('DD_SERVICE')).to.equal('fleet-service')
    // Env var should be used for DD_ENV
    expect(getResolvedEnvFn('DD_ENV')).to.equal('production')
  })

  describe('priority scenarios', () => {
    it('should prioritize fleet over env over local', () => {
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

      process.env.DD_TRACE_SAMPLE_RATE = '0.5'
      process.env.DD_TRACE_ENABLED = 'true'

      resetConfigEnvSources()
      const configEnvSourcesMod = proxyquire('../src/config-env-sources', {
        './serverless': {
          isInServerlessEnvironment: isInServerlessStub
        },
        './config_stable': StableConfigStub
      })

      const getResolvedEnvFn = configEnvSourcesMod.getResolvedEnv

      // Fleet wins
      expect(getResolvedEnvFn('DD_TRACE_SAMPLE_RATE')).to.equal('0.9')
      expect(getResolvedEnvFn('DD_SERVICE')).to.equal('fleet')
      // Env wins (not in fleet)
      expect(getResolvedEnvFn('DD_TRACE_ENABLED')).to.equal('true')
    })

    it('should not override defined values with undefined', () => {
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

      // Env var is not set (undefined)

      resetConfigEnvSources()
      const configEnvSourcesMod = proxyquire('../src/config-env-sources', {
        './serverless': {
          isInServerlessEnvironment: isInServerlessStub
        },
        './config_stable': StableConfigStub
      })

      const getResolvedEnvFn = configEnvSourcesMod.getResolvedEnv

      // Local value should remain since higher priorities are undefined
      expect(getResolvedEnvFn('DD_SERVICE')).to.equal('local-service')
    })
  })

  describe('compatibility with getEnvironmentVariable', () => {
    it('should return env var values when no stable config exists (serverless)', () => {
      // Set up env without stable config (serverless mode)
      isInServerlessEnvironmentStub.returns(true)
      process.env.DD_SERVICE = 'my-service'
      process.env.DD_ENV = 'production'
      process.env.DD_TRACE_AGENT_PORT = '8126'

      resetConfigEnvSources()
      const configEnvSourcesMod = proxyquire('../src/config-env-sources', {
        './serverless': {
          isInServerlessEnvironment: isInServerlessEnvironmentStub
        }
      })

      const getResolvedEnvFn = configEnvSourcesMod.getResolvedEnv

      // Should return the env var values directly (no stable config involved)
      expect(getResolvedEnvFn('DD_SERVICE')).to.equal('my-service')
      expect(getResolvedEnvFn('DD_ENV')).to.equal('production')
      expect(getResolvedEnvFn('DD_TRACE_AGENT_PORT')).to.equal('8126')
    })

    it('should return undefined for unset values', () => {
      isInServerlessEnvironmentStub.returns(true)
      process.env.DD_SERVICE = 'my-service'

      resetConfigEnvSources()
      const configEnvSourcesMod = proxyquire('../src/config-env-sources', {
        './serverless': {
          isInServerlessEnvironment: isInServerlessEnvironmentStub
        }
      })

      const getResolvedEnvFn = configEnvSourcesMod.getResolvedEnv

      // Should return undefined for unset supported config
      expect(getResolvedEnvFn('DD_ENV')).to.be.undefined
      expect(getResolvedEnvFn('DD_VERSION')).to.be.undefined
    })

    it('should throw same error for unsupported configuration', () => {
      isInServerlessEnvironmentStub.returns(true)

      resetConfigEnvSources()
      const configEnvSourcesMod = proxyquire('../src/config-env-sources', {
        './serverless': {
          isInServerlessEnvironment: isInServerlessEnvironmentStub
        }
      })

      const getResolvedEnvFn = configEnvSourcesMod.getResolvedEnv

      // Both should throw for unsupported DD_ vars
      expect(() => getResolvedEnvFn('DD_UNSUPPORTED_VAR')).to.throw(
        'Missing DD_UNSUPPORTED_VAR env/configuration in "supported-configurations.json" file.'
      )
    })
  })
})
