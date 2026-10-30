'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')
const { inspect } = require('node:util')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const actualGetAgentlessTelemetryUrl = require('../../src/telemetry/agentless-url')
require('../setup/core')

const describeNotWindows = os.platform() !== 'win32' ? describe : describe.skip

describeNotWindows('crashtracker', () => {
  let crashtracker
  let binding
  let config
  let identityRefreshChannel
  let libdatadogExtras
  let log
  let getAgentlessTelemetryUrl

  before(() => {
    require('../../src/process-tags').initialize()
  })

  beforeEach(() => {
    libdatadogExtras = require('@datadog/libdatadog-extras')

    binding = libdatadogExtras.load('crashtracker')

    config = {
      url: new URL('http://127.0.0.1:7357'),
      DD_AGENTLESS_ENABLED: false,
      tags: {
        foo: 'bar',
      },
    }

    log = {
      error: sinon.stub(),
    }
    identityRefreshChannel = {
      subscribe: sinon.stub(),
    }
    getAgentlessTelemetryUrl = sinon.stub().callsFake(actualGetAgentlessTelemetryUrl)

    sinon.stub(binding, 'init')
    sinon.stub(binding, 'updateConfig')
    sinon.stub(binding, 'updateMetadata')
    sinon.stub(binding, 'reportUncaughtExceptionMonitor')

    crashtracker = proxyquire('../../src/crashtracking/crashtracker', {
      'dc-polyfill': { channel: sinon.stub().returns(identityRefreshChannel) },
      '../log': log,
      '../telemetry/agentless-url': getAgentlessTelemetryUrl,
    })
  })

  afterEach(() => {
    process.removeAllListeners('uncaughtExceptionMonitor')
    binding.init.restore()
    binding.updateConfig.restore()
    binding.updateMetadata.restore()
    binding.reportUncaughtExceptionMonitor.restore()
  })

  describe('start', () => {
    it('should initialize the binding', () => {
      crashtracker.start(config)

      sinon.assert.called(binding.init)
      sinon.assert.notCalled(log.error)
    })

    it('should initialize the binding only once', () => {
      crashtracker.start(config)
      crashtracker.start(config)

      sinon.assert.calledOnce(binding.init)
    })

    it('should reconfigure when started multiple times', () => {
      crashtracker.start(config)
      crashtracker.start(config)

      sinon.assert.called(binding.updateConfig)
      sinon.assert.called(binding.updateMetadata)
    })

    it('should handle errors', () => {
      crashtracker.start(null)

      sinon.assert.calledOnce(log.error)
      assert.strictEqual(process.listenerCount('uncaughtExceptionMonitor'), 0)

      crashtracker.start(config)

      sinon.assert.calledOnce(binding.init)
    })

    it('should resolve frames out-of-process on Linux and in-process elsewhere', () => {
      crashtracker.start(config)

      const initConfig = binding.init.firstCall.args[0]
      const expected = os.platform() === 'linux'
        ? 'EnabledWithSymbolsInReceiver'
        : 'EnabledWithInprocessSymbols'

      assert.strictEqual(initConfig.resolve_frames, expected)
    })

    it('should handle unix sockets', () => {
      config.url = new URL('unix:///var/datadog/apm/test.socket')

      crashtracker.start(config)

      sinon.assert.called(binding.init)
      sinon.assert.notCalled(log.error)
    })

    it('should configure independent direct intakes in agentless mode', () => {
      config.DD_AGENTLESS_ENABLED = true
      config.DD_API_KEY = 'test-api-key'
      config.site = 'US3.DatadogHQ.com'

      crashtracker.start(config)

      sinon.assert.calledOnce(binding.init)
      assert.strictEqual(binding.init.firstCall.args[0].endpoint, null)
      assert.deepStrictEqual(binding.init.firstCall.args[1].env, [
        ['_DD_DIRECT_SUBMISSION_ENABLED', 'true'],
        ['DD_API_KEY', 'test-api-key'],
        ['DD_SITE', 'us3.datadoghq.com'],
        ['DD_APM_TELEMETRY_DD_URL', 'https://instrumentation-telemetry-intake.us3.datadoghq.com'],
        ['DD_TRACE_AGENT_URL', 'https://instrumentation-telemetry-intake.us3.datadoghq.com'],
      ])
      sinon.assert.notCalled(log.error)
    })

    it('should use the staging telemetry intake in agentless mode', () => {
      config.DD_AGENTLESS_ENABLED = true
      config.DD_API_KEY = 'test-api-key'
      config.site = 'datad0g.com'

      crashtracker.start(config)

      assert.deepStrictEqual(binding.init.firstCall.args[1].env, [
        ['_DD_DIRECT_SUBMISSION_ENABLED', 'true'],
        ['DD_API_KEY', 'test-api-key'],
        ['DD_SITE', 'datad0g.com'],
        ['DD_APM_TELEMETRY_DD_URL', 'https://all-http-intake.logs.datad0g.com'],
        ['DD_TRACE_AGENT_URL', 'https://all-http-intake.logs.datad0g.com'],
      ])
      sinon.assert.notCalled(log.error)
    })

    it('should preserve proxy and TLS settings in the receiver environment', () => {
      config.DD_AGENTLESS_ENABLED = true
      config.DD_API_KEY = 'test-api-key'
      config.site = 'datadoghq.com'
      getAgentlessTelemetryUrl.returns(new URL('http://127.0.0.1:1234'))
      const environment = {
        HTTP_PROXY: 'http://uppercase-http-proxy',
        HTTPS_PROXY: 'http://uppercase-https-proxy',
        NO_PROXY: 'uppercase-no-proxy',
        http_proxy: 'http://lowercase-http-proxy',
        https_proxy: 'http://lowercase-https-proxy',
        no_proxy: 'lowercase-no-proxy',
        SSL_CERT_FILE: '/path/to/certificate.pem',
        SSL_CERT_DIR: '/path/to/certificates',
      }
      const previousEnvironment = {}
      for (const [name, value] of Object.entries(environment)) {
        previousEnvironment[name] = process.env[name]
        process.env[name] = value
      }

      try {
        crashtracker.start(config)
      } finally {
        for (const [name, value] of Object.entries(previousEnvironment)) {
          if (value === undefined) {
            delete process.env[name]
          } else {
            process.env[name] = value
          }
        }
      }

      assert.deepStrictEqual(binding.init.firstCall.args[1].env, [
        ['_DD_DIRECT_SUBMISSION_ENABLED', 'true'],
        ['DD_API_KEY', 'test-api-key'],
        ['DD_SITE', 'datadoghq.com'],
        ['DD_APM_TELEMETRY_DD_URL', 'http://127.0.0.1:1234'],
        ['DD_TRACE_AGENT_URL', 'http://127.0.0.1:1234'],
        ['HTTP_PROXY', 'http://uppercase-http-proxy'],
        ['HTTPS_PROXY', 'http://uppercase-https-proxy'],
        ['NO_PROXY', 'uppercase-no-proxy'],
        ['http_proxy', 'http://lowercase-http-proxy'],
        ['https_proxy', 'http://lowercase-https-proxy'],
        ['no_proxy', 'lowercase-no-proxy'],
        ['SSL_CERT_FILE', '/path/to/certificate.pem'],
        ['SSL_CERT_DIR', '/path/to/certificates'],
      ])
      sinon.assert.notCalled(log.error)
    })

    it('should not initialize agentless crash tracking without an API key', () => {
      config.DD_AGENTLESS_ENABLED = true
      config.site = 'datadoghq.com'

      crashtracker.start(config)

      sinon.assert.notCalled(binding.init)
      sinon.assert.calledOnce(log.error)
      assert.match(log.error.firstCall.args[1].message, /DD_API_KEY is required/)
      assert.strictEqual(process.listenerCount('uncaughtExceptionMonitor'), 0)
    })

    it('should reject an agentless site that could redirect the API key', () => {
      config.DD_AGENTLESS_ENABLED = true
      config.DD_API_KEY = 'test-api-key'
      config.site = 'datadoghq.com@evil.example'

      crashtracker.start(config)

      sinon.assert.notCalled(binding.init)
      sinon.assert.calledOnce(log.error)
      assert.match(log.error.firstCall.args[1].message, /Invalid DD_SITE/)
      assert.strictEqual(process.listenerCount('uncaughtExceptionMonitor'), 0)
    })
  })

  describe('configure', () => {
    it('should reconfigure the binding when started', () => {
      crashtracker.start(config)
      crashtracker.configure(config)

      sinon.assert.called(binding.updateConfig)
      sinon.assert.called(binding.updateMetadata)
    })

    it('should reconfigure the binding only when started', () => {
      crashtracker.configure(config)

      sinon.assert.notCalled(binding.updateConfig)
      sinon.assert.notCalled(binding.updateMetadata)
    })

    it('should handle errors', () => {
      crashtracker.start(config)
      crashtracker.configure(null)

      crashtracker.configure(config)
    })
  })

  describe('identity refresh', () => {
    it('should reconfigure the binding with refreshed tags when the identity-refresh channel fires', () => {
      crashtracker.start(config)

      const refreshedConfig = { ...config, tags: { foo: 'baz' } }
      identityRefreshChannel.subscribe.firstCall.args[0](refreshedConfig)

      sinon.assert.called(binding.updateMetadata)
      const metadata = binding.updateMetadata.lastCall.args[0]
      assert.ok(metadata.tags.includes('foo:baz'), `Expected tags to include foo:baz, got ${inspect(metadata.tags)}`)
    })

    it('should subscribe only after successful initialization', () => {
      binding.init.throws(new Error('init failed'))

      crashtracker.start(config)

      sinon.assert.notCalled(identityRefreshChannel.subscribe)
    })
  })

  describe('uncaughtExceptionMonitor', () => {
    it('should register a listener on start', () => {
      assert.strictEqual(process.listenerCount('uncaughtExceptionMonitor'), 0)
      crashtracker.start(config)

      assert.strictEqual(process.listenerCount('uncaughtExceptionMonitor'), 1)
    })

    it('should not register a listener when start is called multiple times', () => {
      crashtracker.start(config)
      crashtracker.start(config)

      assert.strictEqual(process.listenerCount('uncaughtExceptionMonitor'), 1)
    })

    it('should forward the error and origin to the binding', () => {
      crashtracker.start(config)

      const error = new Error('boom')
      process.emit('uncaughtExceptionMonitor', error, 'uncaughtException')

      sinon.assert.calledOnceWithExactly(binding.reportUncaughtExceptionMonitor, error, 'uncaughtException')
    })

    it('should not register a listener when init fails', () => {
      binding.init.throws(new Error('init failed'))

      crashtracker.start(config)

      sinon.assert.calledOnce(log.error)
      assert.strictEqual(process.listenerCount('uncaughtExceptionMonitor'), 0)
    })
  })

  describe('process tags', () => {
    it('should include process tags in metadata', () => {
      crashtracker.start(config)

      sinon.assert.calledOnce(binding.init)
      const metadata = binding.init.firstCall.args[2]

      assert.ok(metadata)
      assert.ok(Array.isArray(metadata.tags), `Expected array, got ${inspect(metadata.tags)}`)

      // Check that process tags are included
      const hasEntrypointType = metadata.tags.some(tag => tag.startsWith('entrypoint.type:'))
      const hasEntrypointName = metadata.tags.some(tag => tag.startsWith('entrypoint.name:'))
      const hasEntrypointWorkdir = metadata.tags.some(tag => tag.startsWith('entrypoint.workdir:'))
      const hasEntrypointBasedir = metadata.tags.some(tag => tag.startsWith('entrypoint.basedir:'))

      assert.ok(hasEntrypointType, 'should include entrypoint.type tag')
      assert.ok(hasEntrypointName, 'should include entrypoint.name tag')
      assert.ok(hasEntrypointWorkdir, 'should include entrypoint.workdir tag')
      assert.ok(hasEntrypointBasedir, 'should include entrypoint.basedir tag')
    })

    it('should include user tags and process tags together', () => {
      crashtracker.start(config)

      const metadata = binding.init.firstCall.args[2]

      // Check that user tags are included
      const hasFooTag = metadata.tags.some(tag => tag === 'foo:bar')
      assert.ok(hasFooTag, 'should include user-defined tags')

      // Check that process tags are also included
      const hasProcessTags = metadata.tags.some(tag => tag.startsWith('entrypoint.'))
      assert.ok(hasProcessTags, 'should include process tags')
    })

    it('should update process tags when reconfiguring', () => {
      crashtracker.start(config)
      crashtracker.configure(config)

      sinon.assert.called(binding.updateMetadata)
      const metadata = binding.updateMetadata.firstCall.args[0]

      assert.ok(metadata)
      assert.ok(Array.isArray(metadata.tags), `Expected array, got ${inspect(metadata.tags)}`)

      // Verify process tags are in the updated metadata
      const hasProcessTags = metadata.tags.some(tag => tag.startsWith('entrypoint.'))
      assert.ok(hasProcessTags, 'should include process tags in updated metadata')
    })
  })
})
