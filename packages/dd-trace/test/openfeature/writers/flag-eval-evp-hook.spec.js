'use strict'

const assert = require('node:assert/strict')

const { InMemoryProvider, OpenFeature, ProviderEvents, ProviderStatus } = require('@openfeature/server-sdk')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')
const { snapshotEvaluationContext } = require('../../../src/openfeature/writers/flag-evaluation-context')
const telemetryMetrics = require('../../../src/telemetry/metrics')

const config = {
  url: new URL('http://localhost:8126'),
  service: 'checkout',
  featureFlags: { DD_FLAGGING_EVALUATION_COUNTS_ENABLED: true },
}
const route = { url: config.url, basePath: '/evp_proxy/v2' }
const now = 1_759_276_800_000

function details (consent = true, extra = {}) {
  return {
    value: true,
    variant: 'on',
    flagMetadata: {
      __dd_observe_full_evaluation_data: consent,
      __dd_eval_timestamp_ms: now - 100,
      __dd_allocation_key: 'allocation',
      ...extra,
    },
  }
}

function metricValue (name, reason) {
  const series = telemetryMetrics.manager.namespace('general').toJSON().metrics?.series ?? []
  return series.find(metric => metric.metric === name &&
    (!reason || metric.tags.includes('reason:' + reason)))?.points[0][1] ?? 0
}

describe('FlagEvalEVPHook', () => {
  let clock
  let hook
  let Hook
  let writer
  let Writer
  let selectRoute
  let stopDeliveryStrategy
  let snapshotContext

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now })
    writer = {
      getUnavailableReason: sinon.stub().returns('unavailable'),
      hasCapacity: sinon.stub().returns(true),
      enqueue: sinon.spy(),
      setEnabled: sinon.spy(enabled => writer.getUnavailableReason.returns(enabled ? undefined : 'unavailable')),
      destroy: sinon.spy(),
    }
    Writer = sinon.stub().returns(writer)
    stopDeliveryStrategy = sinon.spy()
    selectRoute = sinon.stub().returns(stopDeliveryStrategy)
    snapshotContext = sinon.spy(snapshotEvaluationContext)
    Hook = proxyquire('../../../src/openfeature/writers/flag-eval-evp-hook', {
      './flag-evaluations': Writer,
      './flag-evaluation-context': { snapshotEvaluationContext: snapshotContext },
      './util': { setExposureDeliveryStrategy: selectRoute },
    })
    hook = new Hook(config)
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    hook?.destroy()
    clock.restore()
    sinon.restore()
    telemetryMetrics.manager.namespace('general').reset()
  })

  function enable () {
    selectRoute.firstCall.args[1](true, route)
  }

  it('reuses route selection and captures detached context with evaluation-time metadata', () => {
    enable()
    const context = { targetingKey: 'customer', nested: { plan: 'pro' } }
    hook.finally({ flagKey: 'flag', context }, details())
    context.nested.plan = 'changed'
    clock.tick(1000)
    sinon.assert.calledOnceWithExactly(Writer, config)
    sinon.assert.calledOnceWithExactly(selectRoute, config, sinon.match.func)
    sinon.assert.calledOnceWithExactly(writer.setEnabled, true, route)
    const [event] = writer.enqueue.firstCall.args
    assert.strictEqual(event.flagKey, 'flag')
    assert.strictEqual(event.targetingKey, 'customer')
    assert.strictEqual(event.variant, 'on')
    assert.strictEqual(event.runtimeDefault, false)
    assert.strictEqual(event.allocationKey, 'allocation')
    assert.strictEqual(event.targetingRuleKey, undefined)
    assert.strictEqual(event.timestamp, now - 100)
    assert.strictEqual(event.observeFullEvaluationData, true)
    assert.deepStrictEqual({ ...event.attrs }, { 'nested.plan': 'pro' })
    assert.ok(Object.isFrozen(event.attrs))
  })

  for (const consent of [false, undefined, null, 'true', 1]) {
    it(`never traverses context without strict consent (${consent})`, () => {
      enable()
      const context = { targetingKey: 'customer', nested: { plan: 'pro' } }
      const result = details()
      result.flagMetadata.__dd_observe_full_evaluation_data = consent
      hook.finally({ flagKey: 'flag', context }, result)
      sinon.assert.notCalled(snapshotContext)
      assert.strictEqual(writer.enqueue.firstCall.args[0].attrs, undefined)
      assert.strictEqual(writer.enqueue.firstCall.args[0].observeFullEvaluationData, false)
    })
  }

  it('counts unavailable, full and closed separately before touching context', () => {
    const getContext = sinon.spy(() => { throw new Error('context accessed') })
    const input = { flagKey: 'flag', get context () { return getContext() } }
    hook.finally(input, details())
    enable()
    writer.hasCapacity.returns(false)
    hook.finally(input, details())
    hook.destroy()
    hook.finally(input, details())
    sinon.assert.notCalled(getContext)
    sinon.assert.notCalled(writer.enqueue)
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'unavailable'), 1)
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'pre_queue_overflow'), 1)
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'closed'), 1)
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'queue_overflow'), 0)
  })

  it('uses the default-enabled path when the featureFlags group is absent', () => {
    hook.destroy()
    hook = new Hook({ ...config, featureFlags: undefined })
    selectRoute.lastCall.args[1](true, route)
    hook.finally({ flagKey: 'flag', context: {} }, details())
    assert.strictEqual(writer.enqueue.lastCall.args[0].flagKey, 'flag')
  })

  it('counts worker failure separately before touching context', () => {
    enable()
    writer.getUnavailableReason.returns('worker_failure')
    const input = { flagKey: 'flag', get context () { throw new Error('context accessed') } }
    hook.finally(input, details())
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'worker_failure'), 1)
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'unavailable'), 0)
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'pre_queue_overflow'), 0)
    sinon.assert.notCalled(writer.enqueue)
  })

  it('ignores discovery callbacks after close and closes only once', () => {
    hook.destroy()
    enable()
    hook.destroy()
    sinon.assert.calledOnce(writer.destroy)
    sinon.assert.calledOnce(stopDeliveryStrategy)
    sinon.assert.callOrder(stopDeliveryStrategy, writer.destroy)
    sinon.assert.notCalled(writer.setEnabled)
  })

  it('recovers agentless delivery without credentials and cancels recovery on close', () => {
    hook.destroy()
    writer.setEnabled.resetHistory()
    const discover = sinon.stub()
    const util = proxyquire('../../../src/openfeature/writers/util', {
      '../../evp_proxy/discovery': { discoverEVPProxy: discover },
      '../../evp_proxy/direct': { createDirectEVPRoute: () => undefined },
    })
    const RecoveringHook = proxyquire('../../../src/openfeature/writers/flag-eval-evp-hook', {
      './flag-evaluations': Writer,
      './util': util,
    })
    hook = new RecoveringHook({
      ...config, featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless' },
    })
    discover.firstCall.args[2](null, route)
    const initialRoute = writer.setEnabled.lastCall.args[1]
    initialRoute.onUnavailable()
    sinon.assert.calledWithExactly(writer.setEnabled, false, undefined)
    clock.tick(59_999)
    sinon.assert.calledOnce(discover)
    clock.tick(1)
    sinon.assert.calledTwice(discover)
    discover.secondCall.args[2](null, route)
    assert.strictEqual(writer.setEnabled.lastCall.args[0], true)
    writer.setEnabled.lastCall.args[1].onUnavailable()
    hook.destroy()
    clock.tick(60_000)
    sinon.assert.calledTwice(discover)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('reads consent once, ignores DoLog and never reads errorMessage or a guessed rule', () => {
    enable()
    for (const doLog of [true, false]) {
      const result = details(true, { doLog, __dd_do_log: doLog, splitSerialId: 'not-a-rule' })
      const readConsent = sinon.spy(() => true)
      Object.defineProperty(result.flagMetadata, '__dd_observe_full_evaluation_data', { get: readConsent })
      Object.defineProperty(result, 'errorMessage', { get () { throw new Error('secret') } })
      result.errorCode = 'FLAG_NOT_FOUND'
      hook.finally({ flagKey: 'flag', context: { targetingKey: 'customer' } }, result)
      sinon.assert.calledOnce(readConsent)
    }
    assert.deepStrictEqual(writer.enqueue.firstCall.args, writer.enqueue.secondCall.args)
    assert.strictEqual(writer.enqueue.firstCall.args[0].errorCode, 'FLAG_NOT_FOUND')
    assert.strictEqual(writer.enqueue.firstCall.args[0].targetingRuleKey, undefined)
  })

  for (const timestamp of [undefined, null, '123', NaN, Infinity, 1.5, 8_640_000_000_000_001]) {
    it(`falls back to capture time for invalid timestamp ${timestamp}`, () => {
      enable()
      hook.finally({ flagKey: 'flag', context: {} }, details(true, { __dd_eval_timestamp_ms: timestamp }))
      assert.strictEqual(writer.enqueue.firstCall.args[0].timestamp, now)
    })
  }

  it('forwards invalid targeting inputs to writer validation without duplicate omission telemetry', () => {
    enable()
    const targetingKey = { toString () { throw new Error('must not coerce') } }
    hook.finally({ flagKey: 'flag', context: { targetingKey } }, details(false))
    assert.strictEqual(writer.enqueue.firstCall.args[0].targetingKey, targetingKey)
    assert.strictEqual(metricValue('flagevaluation.targeting_key.omitted'), 0)
  })

  it('reports each snapshot truncation reason at most once per evaluation', () => {
    enable()
    hook.finally({ flagKey: 'flag', context: { a: 'x'.repeat(257), b: 'y'.repeat(257) } }, details())
    assert.strictEqual(metricValue('flagevaluation.context.truncated', 'max_value_length'), 1)
    sinon.assert.calledOnce(writer.enqueue)
  })

  it('contains hook exceptions even when the telemetry sink throws', () => {
    enable()
    const input = { flagKey: 'flag', get context () { throw new Error('secret-error') } }
    hook.finally(input, details())
    assert.strictEqual(metricValue('flagevaluation.hook.errors'), 1)
    sinon.stub(telemetryMetrics.manager.namespace('general'), 'count').throws(new Error('sink failed'))
    hook.finally(input, details())
    sinon.assert.notCalled(writer.enqueue)
  })

  for (const terminal of [
    'success', 'returned-error', 'throw', 'not-ready', 'fatal', 'type-mismatch', 'before-error', 'after-error',
  ]) {
    it(`captures the real SDK finally path for ${terminal}`, async () => {
      enable()
      const provider = new InMemoryProvider({ flag: { defaultVariant: 'on', variants: { on: 'wrong type' } } })
      provider.hooks = [hook]
      const resolution = details()
      if (terminal === 'returned-error') resolution.errorCode = 'FLAG_NOT_FOUND'
      if (terminal === 'type-mismatch') {
        sinon.spy(provider, 'resolveBooleanEvaluation')
      } else {
        sinon.stub(provider, 'resolveBooleanEvaluation').callsFake(() => {
          if (terminal === 'throw') throw new Error('error-only-canary')
          return resolution
        })
      }
      let finishInitialization
      if (terminal === 'not-ready') {
        provider.initialize = () => new Promise(resolve => { finishInitialization = resolve })
      }
      OpenFeature.setProvider('evp-hook', provider)
      if (terminal === 'fatal') provider.events.emit(ProviderEvents.Error, { errorCode: 'PROVIDER_FATAL' })
      const client = OpenFeature.getClient('evp-hook')
      if (terminal === 'before-error') client.addHooks({ before () { throw new Error('before-error-canary') } })
      if (terminal === 'after-error') client.addHooks({ after () { throw new Error('after-error-canary') } })
      assert.strictEqual(client.providerStatus, terminal === 'not-ready'
        ? ProviderStatus.NOT_READY
        : terminal === 'fatal' ? ProviderStatus.FATAL : ProviderStatus.READY)
      const result = await client.getBooleanDetails('flag', false, {
        targetingKey: 'customer', plan: 'pro',
      })
      sinon.assert.calledOnce(writer.enqueue)
      const [event] = writer.enqueue.firstCall.args
      assert.strictEqual(event.flagKey, 'flag')
      assert.strictEqual(event.errorCode, result.errorCode)
      assert.strictEqual(event.runtimeDefault, result.variant === undefined)
      assert.strictEqual(event.observeFullEvaluationData,
        result.flagMetadata?.__dd_observe_full_evaluation_data === true)
      if (['throw', 'not-ready', 'fatal', 'type-mismatch', 'before-error', 'after-error'].includes(terminal)) {
        assert.strictEqual(event.observeFullEvaluationData, false)
        assert.strictEqual(event.timestamp, now)
        assert.strictEqual(event.attrs, undefined)
      }
      if (['not-ready', 'fatal', 'before-error'].includes(terminal)) {
        sinon.assert.notCalled(provider.resolveBooleanEvaluation)
      }
      finishInitialization?.()
    })
  }
})
