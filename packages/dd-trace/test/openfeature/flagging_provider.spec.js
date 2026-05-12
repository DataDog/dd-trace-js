'use strict'

const assert = require('node:assert/strict')

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
  let mockEvalMetricsHook
  let mockEvalMetricsHookClass

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
          initializationTimeoutMs: 30_000,
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

    mockEvalMetricsHook = {
      record: sinon.spy(),
    }
    mockEvalMetricsHookClass = sinon.stub().returns(mockEvalMetricsHook)

    FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
      'dc-polyfill': {
        channel: channelStub,
      },
      '../log': log,
      './eval-metrics-hook': mockEvalMetricsHookClass,
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
  })

  describe('hooks', () => {
    it('should create EvalMetricsHook with config', () => {
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.calledOnceWithExactly(mockEvalMetricsHookClass, mockConfig)
    })

    it('should register EvalMetricsHook as a hook', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.strictEqual(provider.hooks.length, 1)
      assert.strictEqual(provider.hooks[0], mockEvalMetricsHook)
    })
  })

  describe('inheritance', () => {
    it('should extend DatadogNodeServerProvider', () => {
      const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.ok(provider instanceof DatadogNodeServerProvider)
    })
  })
})
