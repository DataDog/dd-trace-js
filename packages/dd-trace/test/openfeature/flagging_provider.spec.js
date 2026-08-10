'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

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
  let configurationSource
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
      './configuration_source': configurationSource,
      './flag-eval-metrics-hook': mockFlagEvalMetricsHookClass,
      './span-enrichment-hook': mockSpanEnrichmentHookClass,
      './writers/flag_evaluations': mockFlagEvalWriterClass,
      './writers/flag_eval_evp_hook': mockFlagEvalEVPHookClass,
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

  describe('observeFullEvaluationData snapshot', () => {
    it('passes a getConsent accessor to the EVP hook, not to the OTel/span hooks', () => {
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      // The EVP hook is the only consumer of consent. Any other hook receiving
      // an accessor would be a channel bypassing the intended path.
      sinon.assert.calledOnce(mockFlagEvalEVPHookClass)
      const evpArgs = mockFlagEvalEVPHookClass.firstCall.args
      assert.strictEqual(evpArgs[0], mockFlagEvalWriter)
      assert.strictEqual(typeof evpArgs[1], 'function', 'EVP hook must receive a getConsent function')

      // OTel hook takes only config.
      sinon.assert.calledOnce(mockFlagEvalMetricsHookClass)
      sinon.assert.calledWith(mockFlagEvalMetricsHookClass, mockConfig)
    })

    it('starts with observeFullEvaluationData=false before any setConfiguration call', () => {
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new
      const getConsent = mockFlagEvalEVPHookClass.firstCall.args[1]

      assert.strictEqual(getConsent(), false, 'default snapshot must be consent-off')
    })

    it('reflects setConfiguration({ observeFullEvaluationData: true }) atomically', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const getConsent = mockFlagEvalEVPHookClass.firstCall.args[1]

      provider.setConfiguration({
        createdAt: '2026-01-01T00:00:00Z',
        format: 'SERVER',
        environment: { name: 'test' },
        flags: {},
        observeFullEvaluationData: true,
      })

      assert.strictEqual(getConsent(), true)
    })

    it('coerces observeFullEvaluationData to false for non-boolean values (fail-closed)', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const getConsent = mockFlagEvalEVPHookClass.firstCall.args[1]

      for (const value of [undefined, null, 1, 0, 'true', 'false', {}, []]) {
        provider.setConfiguration({
          createdAt: '2026-01-01T00:00:00Z',
          format: 'SERVER',
          environment: { name: 'test' },
          flags: {},
          observeFullEvaluationData: value,
        })
        assert.strictEqual(getConsent(), false,
          `value ${JSON.stringify(value)} must coerce to false (strict === true)`)
      }
    })

    it('ignores observeFullEvaluationData nested inside environment (FFL-2784 placement drift)', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const getConsent = mockFlagEvalEVPHookClass.firstCall.args[1]

      provider.setConfiguration({
        createdAt: '2026-01-01T00:00:00Z',
        format: 'SERVER',
        environment: { name: 'test', observeFullEvaluationData: true },
        flags: {},
      })

      assert.strictEqual(getConsent(), false,
        'consent nested inside environment MUST NOT be read; the field lives at UFC root')
    })

    it('resets to observeFullEvaluationData=false when configuration is unset', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const getConsent = mockFlagEvalEVPHookClass.firstCall.args[1]

      provider.setConfiguration({
        createdAt: '2026-01-01T00:00:00Z',
        format: 'SERVER',
        environment: { name: 'test' },
        flags: {},
        observeFullEvaluationData: true,
      })
      assert.strictEqual(getConsent(), true)

      provider.setConfiguration(undefined)
      assert.strictEqual(getConsent(), false, 'unsetting configuration must revert consent to false')
    })

    it('swaps consent atomically — a reader sees either the old or the new snapshot, never a torn pair', () => {
      // The snapshot is Object.frozen. There is no observable intermediate state.
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const getConsent = mockFlagEvalEVPHookClass.firstCall.args[1]

      provider.setConfiguration({
        createdAt: '2026-01-01T00:00:00Z',
        format: 'SERVER',
        environment: { name: 'e1' },
        flags: {},
        observeFullEvaluationData: false,
      })
      const before = getConsent()

      provider.setConfiguration({
        createdAt: '2026-01-02T00:00:00Z',
        format: 'SERVER',
        environment: { name: 'e2' },
        flags: {},
        observeFullEvaluationData: true,
      })
      const after = getConsent()

      assert.strictEqual(before, false)
      assert.strictEqual(after, true)
    })

    it('does not expose a public consent accessor on the provider', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      // No public getter / method / property leaks consent.
      assert.strictEqual(typeof provider.getConsent, 'undefined')
      assert.strictEqual(typeof provider.observeFullEvaluationData, 'undefined')
      assert.strictEqual(typeof provider.isObserveFullEvaluationDataEnabled, 'undefined')
    })
  })

  describe('inheritance', () => {
    it('should extend DatadogNodeServerProvider', () => {
      const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.ok(provider instanceof DatadogNodeServerProvider)
    })
  })

  // Pins the optional-peer gate against leaking the provider chain into customer bundles (#8635).
  // `file-tracing.spec.js` covers the same wrapper's nft contract.
  describe('optional-peer gate', () => {
    const modulePath = require.resolve('../../src/openfeature/flagging_provider')
    const providerModulePath = require.resolve('../../src/openfeature/require-provider')
    const peer = '@datadog/openfeature-node-server'

    afterEach(() => {
      delete require.cache[modulePath]
      delete require.cache[providerModulePath]
      delete globalThis.__webpack_require__
      delete globalThis.__non_webpack_require__
    })

    it('uses `require` outside a bundler', () => {
      assert.strictEqual(typeof globalThis.__webpack_require__, 'undefined')
      delete require.cache[modulePath]
      delete require.cache[providerModulePath]

      const ReloadedFlaggingProvider = require(modulePath)

      assert.strictEqual(typeof ReloadedFlaggingProvider, 'function')
      assert.strictEqual(ReloadedFlaggingProvider.name, 'FlaggingProvider')
    })

    it('uses `__non_webpack_require__`, never `__webpack_require__`, under webpack', () => {
      const loadCalls = []
      globalThis.__webpack_require__ = () => {
        throw new Error('webpack require must not run for an optional peer')
      }
      /** @param {string} request */
      globalThis.__non_webpack_require__ = (request) => {
        loadCalls.push(request)
        return require(request)
      }

      delete require.cache[modulePath]
      delete require.cache[providerModulePath]
      const ReloadedFlaggingProvider = require(modulePath)

      assert.deepStrictEqual(loadCalls, [peer])
      assert.strictEqual(typeof ReloadedFlaggingProvider, 'function')
    })

    it('falls back to `require` when `__non_webpack_require__` is absent', () => {
      globalThis.__webpack_require__ = () => {
        throw new Error('webpack require must not run for an optional peer')
      }

      delete require.cache[modulePath]
      delete require.cache[providerModulePath]
      const ReloadedFlaggingProvider = require(modulePath)

      assert.strictEqual(typeof ReloadedFlaggingProvider, 'function')
    })

    it('keeps the provider load opaque to bundlers', () => {
      const source = fs.readFileSync(providerModulePath, 'utf8')

      assert.doesNotMatch(
        source,
        /require\(\s*['"]@datadog\/openfeature-node-server['"]\s*\)/,
        'a literal require would let bundlers resolve the optional peer chain at build time'
      )
      assert.doesNotMatch(
        source,
        /\brequire\(\s*[^'"\s]/,
        'a dynamic require would create a webpack expression dependency'
      )
    })
  })
})
