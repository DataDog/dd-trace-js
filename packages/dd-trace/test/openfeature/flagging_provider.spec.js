'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
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
  let mockFlagEvalMetricsHook
  let mockFlagEvalMetricsHookClass
  let mockSpanEnrichmentHook
  let mockSpanEnrichmentHookClass
  let mockFlagEvalWriter
  let mockFlagEvalWriterClass
  let mockFlagEvalEVPHook
  let mockFlagEvalEVPHookClass

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
    }
    mockFlagEvalWriterClass = sinon.stub().returns(mockFlagEvalWriter)

    mockFlagEvalEVPHook = {}
    mockFlagEvalEVPHookClass = sinon.stub().returns(mockFlagEvalEVPHook)

    // evaluationCountsEnabled defaults to true in mockConfig; tests that need the killswitch
    // set mockConfig.experimental.flaggingProvider.evaluationCountsEnabled = false directly.

    FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
      'dc-polyfill': {
        channel: channelStub,
      },
      '../log': log,
      './flag-eval-metrics-hook': mockFlagEvalMetricsHookClass,
      './span-enrichment-hook': mockSpanEnrichmentHookClass,
      './writers/flag_evaluations': mockFlagEvalWriterClass,
      './writers/flag_eval_evp_hook': mockFlagEvalEVPHookClass,
    })
  })

  describe('constructor', () => {
    it('should initialize with tracer and config', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.strictEqual(provider._tracer, mockTracer)
      assert.strictEqual(provider._config, mockConfig)
    })

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

  describe('_setConfiguration', () => {
    it('should call setConfiguration when method exists', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const setConfigSpy = sinon.spy(provider, 'setConfiguration')
      const ufc = { flags: { 'test-flag': {} } }

      provider._setConfiguration(ufc)

      sinon.assert.calledOnceWithExactly(setConfigSpy, ufc)
      sinon.assert.calledWith(log.debug, '%s provider configuration updated', 'FlaggingProvider')
    })

    it('should handle null/undefined configuration gracefully', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      provider._setConfiguration(null)
      provider._setConfiguration(undefined)
    })

    it('should not throw when setConfiguration is not a function', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      provider.setConfiguration = null // Remove the method

      provider._setConfiguration({ flags: {} })

      // Should still log the debug message
      sinon.assert.calledWith(log.debug, '%s provider configuration updated', 'FlaggingProvider')
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

    it('should not register FlagEvalEVPHook when DD_FLAGGING_EVALUATION_COUNTS_ENABLED=false', () => {
      mockConfig.experimental.flaggingProvider.evaluationCountsEnabled = false
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      assert.ok(!provider.hooks.includes(mockFlagEvalEVPHook),
        'EVP hook must not be registered when killswitch is false')
      sinon.assert.notCalled(mockFlagEvalWriterClass)
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
  })

  describe('inheritance', () => {
    it('should extend DatadogNodeServerProvider', () => {
      const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.ok(provider instanceof DatadogNodeServerProvider)
    })
  })

  // Pins the bundler-opaque require gate against accidental regression to a
  // direct `require('@datadog/openfeature-node-server')`, which would leak
  // the optional peer chain into customer bundles (see #8635).
  describe('bundler-opaque require gate', () => {
    const modulePath = require.resolve('../../src/openfeature/flagging_provider')

    afterEach(() => {
      delete require.cache[modulePath]
      delete globalThis.__webpack_require__
      delete globalThis.__non_webpack_require__
    })

    it('uses `require` outside a bundler', () => {
      assert.strictEqual(typeof globalThis.__webpack_require__, 'undefined')
      delete require.cache[modulePath]

      const ReloadedFlaggingProvider = require(modulePath)

      assert.strictEqual(typeof ReloadedFlaggingProvider, 'function')
      assert.strictEqual(ReloadedFlaggingProvider.name, 'FlaggingProvider')
    })

    it('uses `__non_webpack_require__` under a webpack runtime', () => {
      let escapeHatchCalls = 0
      globalThis.__webpack_require__ = () => {
        throw new Error('webpack require must not run for the optional peer')
      }
      globalThis.__non_webpack_require__ = (request) => {
        escapeHatchCalls++
        return require(request)
      }
      delete require.cache[modulePath]

      const ReloadedFlaggingProvider = require(modulePath)

      assert.strictEqual(escapeHatchCalls, 1)
      assert.strictEqual(typeof ReloadedFlaggingProvider, 'function')
      assert.strictEqual(ReloadedFlaggingProvider.name, 'FlaggingProvider')
    })

    it('does not statically require `@datadog/openfeature-node-server`', () => {
      const fs = require('node:fs')
      const source = fs.readFileSync(modulePath, 'utf8')

      assert.doesNotMatch(
        source,
        /require\(\s*['"]@datadog\/openfeature-node-server['"]\s*\)/,
        'a literal require would let bundlers resolve the optional peer chain at build time'
      )
    })
  })
})
