'use strict'

const assert = require('node:assert/strict')

const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('FlaggingProvider', () => {
  let FlaggingProvider
  let mockTracer
  let mockConfig
  let mockChannel
  let log
  let channelStub
  let configurationSource
  let mockFlagEvalMetricsHook
  let mockFlagEvalMetricsHookClass
  let mockSpanEnrichmentHook
  let mockSpanEnrichmentHookClass
  let mockFlagEvalWriter
  let mockFlagEvalWriterClass
  let mockFlagEvalEVPHook
  let mockFlagEvalEVPHookClass
  let setEventDeliveryStrategyStub

  beforeEach(() => {
    mockTracer = {
      _config: { service: 'test-service' },
    }

    mockConfig = {
      service: 'test-service',
      version: '1.0.0',
      env: 'test',
      experimental: {
        flaggingProvider: {
          enabled: true,
          evaluationCountsEnabled: true,
          initializationTimeoutMs: 30_000,
          spanEnrichment: {
            enabled: true,
          },
        },
      },
    }

    mockChannel = {
      publish: sinon.spy(),
    }

    channelStub = sinon.stub().returns(mockChannel)
    configurationSource = {
      create: sinon.stub(),
    }

    log = {
      debug: sinon.spy(),
      info: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy(),
    }

    mockFlagEvalMetricsHook = {
      record: sinon.spy(),
    }
    mockFlagEvalMetricsHookClass = sinon.stub().returns(mockFlagEvalMetricsHook)

    mockSpanEnrichmentHook = {
      destroy: sinon.spy(),
    }
    mockSpanEnrichmentHookClass = sinon.stub().returns(mockSpanEnrichmentHook)

    mockFlagEvalWriter = {
      destroy: sinon.spy(),
      setEnabled: sinon.spy(),
    }
    mockFlagEvalWriterClass = sinon.stub().returns(mockFlagEvalWriter)

    mockFlagEvalEVPHook = {}
    mockFlagEvalEVPHookClass = sinon.stub().returns(mockFlagEvalEVPHook)

    setEventDeliveryStrategyStub = sinon.stub()

    // evaluationCountsEnabled defaults to true in mockConfig; tests that need the killswitch
    // set mockConfig.experimental.flaggingProvider.evaluationCountsEnabled = false directly.

    FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
      'dc-polyfill': {
        channel: channelStub,
      },
      '../log': log,
      './configuration_source': configurationSource,
      './flag-eval-metrics-hook': mockFlagEvalMetricsHookClass,
      './span-enrichment-hook': mockSpanEnrichmentHookClass,
      './writers/flag-evaluations': mockFlagEvalWriterClass,
      './writers/flag-eval-evp-hook': mockFlagEvalEVPHookClass,
      './writers/util': { setEventDeliveryStrategy: setEventDeliveryStrategyStub },
      '../../../../vendor/dist/@datadog/openfeature-node-server': { DatadogNodeServerProvider },
    })
  })

  describe('constructor', () => {
    it('should create exposure channel', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.ok(provider)
      sinon.assert.calledWith(channelStub, 'ffe:exposure:submit')
    })

    it('should log debug message on creation', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.ok(provider)
      sinon.assert.calledWith(log.debug, '%s created with timeout: %dms', 'FlaggingProvider', 30000)
    })
  })

  describe('hooks', () => {
    it('should create FlagEvalMetricsHook with config', () => {
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.calledOnceWithExactly(mockFlagEvalMetricsHookClass, mockConfig)
    })

    it('should create SpanEnrichmentHook with tracer when span enrichment is enabled', () => {
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.calledOnceWithExactly(mockSpanEnrichmentHookClass, mockTracer)
    })

    it('should not create SpanEnrichmentHook when span enrichment is disabled', () => {
      mockConfig.experimental.flaggingProvider.spanEnrichment.enabled = false
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.notCalled(mockSpanEnrichmentHookClass)
    })

    it('should not create SpanEnrichmentHook when spanEnrichment config is missing', () => {
      delete mockConfig.experimental.flaggingProvider.spanEnrichment
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.notCalled(mockSpanEnrichmentHookClass)
    })

    it('should register FlagEvalMetricsHook, FlagEvalEVPHook and SpanEnrichmentHook when all enabled', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.strictEqual(provider.hooks.length, 3)
      assert.strictEqual(provider.hooks[0], mockFlagEvalMetricsHook)
      assert.strictEqual(provider.hooks[1], mockFlagEvalEVPHook)
      assert.strictEqual(provider.hooks[2], mockSpanEnrichmentHook)
    })

    it('should only register FlagEvalMetricsHook + FlagEvalEVPHook when span enrichment is disabled', () => {
      mockConfig.experimental.flaggingProvider.spanEnrichment.enabled = false
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.strictEqual(provider.hooks.length, 2)
      assert.strictEqual(provider.hooks[0], mockFlagEvalMetricsHook)
      assert.strictEqual(provider.hooks[1], mockFlagEvalEVPHook)
    })

    it('should not register FlagEvalEVPHook when DD_FEATURE_FLAGS_EVALUATION_COUNTS_ENABLED=false', () => {
      mockConfig.experimental.flaggingProvider.evaluationCountsEnabled = false
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      assert.ok(!provider.hooks.includes(mockFlagEvalEVPHook),
        'EVP hook must not be registered when killswitch is false')
      sinon.assert.notCalled(mockFlagEvalWriterClass)
      sinon.assert.notCalled(setEventDeliveryStrategyStub)
      assert.ok(!setEventDeliveryStrategyStub.called,
        'agent probe must not run when the killswitch disables the writer')
    })

    it('applies the selected EVP delivery route', () => {
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.calledOnce(setEventDeliveryStrategyStub)
      const setEnabled = mockFlagEvalWriter.setEnabled
      const selectRoute = setEventDeliveryStrategyStub.firstCall.args[1]
      const route = {
        url: new URL('https://event-platform-intake.datadoghq.com'),
        basePath: '',
        headers: { 'DD-API-KEY': 'test-api-key' },
      }

      selectRoute(true, route)
      sinon.assert.calledWith(setEnabled, true, route)

      selectRoute(false)
      sinon.assert.calledWith(setEnabled, false)
    })

    it('OTel FlagEvalMetricsHook is always registered regardless of killswitch', () => {
      mockConfig.experimental.flaggingProvider.evaluationCountsEnabled = false
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      assert.ok(provider.hooks.includes(mockFlagEvalMetricsHook),
        'OTel FlagEvalMetricsHook must always be registered')
    })

    it('should log info message when span enrichment is enabled', () => {
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.calledWith(log.info, '%s span enrichment enabled', 'FlaggingProvider')
    })

    it('should log info message when span enrichment is disabled', () => {
      mockConfig.experimental.flaggingProvider.spanEnrichment.enabled = false
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.calledWith(log.info, '%s span enrichment disabled', 'FlaggingProvider')
    })
  })

  describe('onClose', () => {
    it('should call destroy on SpanEnrichmentHook when enabled', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      provider.onClose()

      sinon.assert.calledOnce(mockSpanEnrichmentHook.destroy)
    })

    it('should call destroy on FlagEvaluationsWriter when EVP enabled', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      provider.onClose()

      sinon.assert.calledOnce(mockFlagEvalWriter.destroy)
    })

    it('should not throw when span enrichment is disabled', () => {
      mockConfig.experimental.flaggingProvider.spanEnrichment.enabled = false
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      provider.onClose()

      sinon.assert.notCalled(mockSpanEnrichmentHook.destroy)
    })

    it('stops the attached configuration source', () => {
      const source = { start: sinon.spy(), stop: sinon.spy() }
      configurationSource.create.returns(source)
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      provider.onClose()

      sinon.assert.calledOnce(source.start)
      sinon.assert.calledOnce(source.stop)
    })

    it('applies source configurations through the provider boundary', () => {
      const source = { start: sinon.spy(), stop: sinon.spy() }
      configurationSource.create.returns(source)
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const ufc = { flags: {} }
      const applyConfiguration = configurationSource.create.firstCall.args[1]

      applyConfiguration(ufc)

      assert.strictEqual(provider.getConfiguration(), ufc)
    })

    it('closes owned resources only once', () => {
      const source = { start: sinon.spy(), stop: sinon.spy() }
      configurationSource.create.returns(source)
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      provider.onClose()
      provider.onClose()

      sinon.assert.calledOnce(source.stop)
      sinon.assert.calledOnce(mockSpanEnrichmentHook.destroy)
    })
  })

  describe('inheritance', () => {
    it('should extend DatadogNodeServerProvider', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.ok(provider instanceof DatadogNodeServerProvider)
    })
  })
})
