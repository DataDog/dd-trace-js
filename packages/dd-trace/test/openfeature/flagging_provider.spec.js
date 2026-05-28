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
