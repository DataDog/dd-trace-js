'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('EvalMetricsHook', () => {
  let EvalMetricsHook
  let mockCounter
  let mockMeter
  let mockOtelApi
  let log

  beforeEach(() => {
    mockCounter = {
      add: sinon.spy(),
    }

    mockMeter = {
      createCounter: sinon.stub().returns(mockCounter),
    }

    mockOtelApi = {
      metrics: {
        getMeter: sinon.stub().returns(mockMeter),
      },
    }

    log = {
      warn: sinon.spy(),
      debug: sinon.spy(),
    }

    EvalMetricsHook = proxyquire('../../src/openfeature/eval-metrics-hook', {
      '@opentelemetry/api': mockOtelApi,
      '../log': log,
    })
  })

  function makeConfig (otelMetricsEnabled = true) {
    return { otelMetricsEnabled }
  }

  function hookContext (flagKey = 'flag') {
    return { flagKey }
  }

  function evalDetails (overrides = {}) {
    return { variant: 'on', reason: 'TARGETING_MATCH', ...overrides }
  }

  describe('finally()', () => {
    it('should be a no-op when disabled', () => {
      const metrics = new EvalMetricsHook(makeConfig(false))
      metrics.finally(hookContext(), evalDetails())

      sinon.assert.notCalled(mockCounter.add)
      sinon.assert.notCalled(mockOtelApi.metrics.getMeter)
    })

    it('should create counter lazily on first call', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      sinon.assert.notCalled(mockOtelApi.metrics.getMeter)

      metrics.finally(hookContext('my-flag'), evalDetails())

      sinon.assert.calledOnceWithExactly(mockOtelApi.metrics.getMeter, 'dd-trace-js/openfeature')
      sinon.assert.calledWith(mockMeter.createCounter, 'feature_flag.evaluations', {
        description: 'Number of feature flag evaluations',
        unit: '{evaluation}',
      })
    })

    it('should cache the counter after first call', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(hookContext(), evalDetails())
      metrics.finally(hookContext(), evalDetails())

      sinon.assert.calledOnce(mockOtelApi.metrics.getMeter)
    })

    it('should add counter with basic attributes', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(hookContext('my-flag'), evalDetails())

      sinon.assert.calledOnce(mockCounter.add)
      const [value, attributes] = mockCounter.add.firstCall.args
      assert.strictEqual(value, 1)
      assert.deepStrictEqual(attributes, {
        'feature_flag.key': 'my-flag',
        'feature_flag.result.variant': 'on',
        'feature_flag.result.reason': 'targeting_match',
      })
    })

    it('should lowercase the reason', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(hookContext(), evalDetails({ reason: 'DEFAULT' }))

      const [, attributes] = mockCounter.add.firstCall.args
      assert.strictEqual(attributes['feature_flag.result.reason'], 'default')
    })

    it('should use empty string for variant when variant is undefined', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(hookContext(), evalDetails({ variant: undefined }))

      const [, attributes] = mockCounter.add.firstCall.args
      assert.strictEqual(attributes['feature_flag.result.variant'], '')
    })

    it('should include error.type when errorCode is set', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(
        hookContext('flag'),
        evalDetails({ variant: undefined, reason: 'ERROR', errorCode: 'TYPE_MISMATCH' })
      )

      const [, attributes] = mockCounter.add.firstCall.args
      assert.deepStrictEqual(attributes, {
        'feature_flag.key': 'flag',
        'feature_flag.result.variant': '',
        'feature_flag.result.reason': 'error',
        'error.type': 'type_mismatch',
      })
    })

    it('should lowercase errorCode in error.type', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(hookContext(), evalDetails({ reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' }))

      const [, attributes] = mockCounter.add.firstCall.args
      assert.strictEqual(attributes['error.type'], 'flag_not_found')
    })

    it('should omit error.type when errorCode is falsy', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(hookContext(), evalDetails())

      const [, attributes] = mockCounter.add.firstCall.args
      assert.ok(!Object.hasOwn(attributes, 'error.type'))
    })

    it('should include allocation_key when set', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(
        hookContext('flag'),
        evalDetails({ flagMetadata: { allocationKey: 'default-allocation' } })
      )

      const [, attributes] = mockCounter.add.firstCall.args
      assert.deepStrictEqual(attributes, {
        'feature_flag.key': 'flag',
        'feature_flag.result.variant': 'on',
        'feature_flag.result.reason': 'targeting_match',
        'feature_flag.result.allocation_key': 'default-allocation',
      })
    })

    it('should omit allocation_key when flagMetadata is absent', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(hookContext(), evalDetails())

      const [, attributes] = mockCounter.add.firstCall.args
      assert.ok(!Object.hasOwn(attributes, 'feature_flag.result.allocation_key'))
    })

    it('should omit allocation_key when flagMetadata is empty', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(hookContext(), evalDetails({ flagMetadata: {} }))

      const [, attributes] = mockCounter.add.firstCall.args
      assert.ok(!Object.hasOwn(attributes, 'feature_flag.result.allocation_key'))
    })

    it('should skip when OTel api throws', () => {
      mockOtelApi.metrics.getMeter.throws(new Error('OTel not ready'))
      const metrics = new EvalMetricsHook(makeConfig(true))

      metrics.finally(hookContext(), evalDetails())

      sinon.assert.notCalled(mockCounter.add)
      sinon.assert.calledOnce(log.warn)

      // Fix the OTel API and verify retry succeeds
      mockOtelApi.metrics.getMeter.returns(mockMeter)
      metrics.finally(hookContext(), evalDetails())

      sinon.assert.calledOnce(mockCounter.add)
    })

    it('should handle null/undefined hookContext gracefully', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(undefined, evalDetails())
      metrics.finally(null, evalDetails())

      assert.strictEqual(mockCounter.add.callCount, 2)
      assert.strictEqual(mockCounter.add.firstCall.args[1]['feature_flag.key'], '')
    })

    it('should handle null/undefined evaluationDetails gracefully', () => {
      const metrics = new EvalMetricsHook(makeConfig(true))
      metrics.finally(hookContext(), undefined)
      metrics.finally(hookContext(), null)

      assert.strictEqual(mockCounter.add.callCount, 2)
    })
  })
})
