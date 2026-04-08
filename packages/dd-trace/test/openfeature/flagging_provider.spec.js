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
  let tagSpansForEvaluation

  beforeEach(() => {
    mockTracer = {
      _config: { service: 'test-service' },
      scope: () => ({ active: () => ({}) }),
    }

    mockConfig = {
      service: 'test-service',
      version: '1.0.0',
      env: 'test',
      experimental: {
        flaggingProvider: {
          enabled: true,
          initializationTimeoutMs: 30_000,
          maxFlagTags: 300,
        },
      },
    }

    mockChannel = {
      publish: sinon.spy(),
    }

    channelStub = sinon.stub().returns(mockChannel)

    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy(),
    }

    tagSpansForEvaluation = sinon.spy()

    FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
      'dc-polyfill': {
        channel: channelStub,
      },
      '../log': log,
      './span_tagger': { tagSpansForEvaluation },
    })
  })

  afterEach(() => {
    sinon.restore()
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
  })

  describe('inheritance', () => {
    it('should extend DatadogNodeServerProvider', () => {
      const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.ok(provider instanceof DatadogNodeServerProvider)
    })
  })

  describe('span tagging on resolve methods', () => {
    const resolveMethodConfigs = [
      { method: 'resolveBooleanEvaluation', defaultValue: false },
      { method: 'resolveStringEvaluation', defaultValue: 'default' },
      { method: 'resolveNumberEvaluation', defaultValue: 0 },
      { method: 'resolveObjectEvaluation', defaultValue: {} },
    ]

    for (const { method, defaultValue } of resolveMethodConfigs) {
      describe(method, () => {
        it('should call tagSpansForEvaluation with correct params', async () => {
          const provider = new FlaggingProvider(mockTracer, mockConfig)
          const context = { targetingKey: 'user-1' }

          await provider[method]('test-flag', defaultValue, context)

          sinon.assert.calledOnce(tagSpansForEvaluation)
          const [tracer, params] = tagSpansForEvaluation.firstCall.args
          assert.strictEqual(tracer, mockTracer)
          assert.strictEqual(params.flagKey, 'test-flag')
          assert.strictEqual(params.maxFlagTags, 300)
        })

        it('should still return the evaluation result', async () => {
          const provider = new FlaggingProvider(mockTracer, mockConfig)

          const result = await provider[method]('test-flag', defaultValue, { targetingKey: 'user-1' })

          assert.ok(Object.hasOwn(result, 'value'))
        })
      })
    }

    it('should pass variant from result when present', async () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const parentProto = Object.getPrototypeOf(Object.getPrototypeOf(provider))
      const stub = sinon.stub(parentProto, 'resolveBooleanEvaluation').resolves({
        value: true,
        variant: 'treatment',
        reason: 'TARGETING_MATCH',
      })

      try {
        await provider.resolveBooleanEvaluation('test-flag', false, { targetingKey: 'user-1' })

        const [, params] = tagSpansForEvaluation.firstCall.args
        assert.strictEqual(params.variantKey, 'treatment')
      } finally {
        stub.restore()
      }
    })

    it('should fall back to stringified value when variant is absent', async () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const parentProto = Object.getPrototypeOf(Object.getPrototypeOf(provider))
      const stub = sinon.stub(parentProto, 'resolveBooleanEvaluation').resolves({
        value: false,
        reason: 'DEFAULT',
      })

      try {
        await provider.resolveBooleanEvaluation('test-flag', false, { targetingKey: 'user-1' })

        const [, params] = tagSpansForEvaluation.firstCall.args
        assert.strictEqual(params.variantKey, 'false')
      } finally {
        stub.restore()
      }
    })
  })
})
