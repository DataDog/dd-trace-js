'use strict'

const assert = require('node:assert/strict')

const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
const { ErrorCode, OpenFeature } = require('@openfeature/server-sdk')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const { snapshotEvaluationContext } = require('../../src/openfeature/writers/flag-evaluation-context')
const telemetryMetrics = require('../../src/telemetry/metrics')

const now = 1_759_276_800_000

describe('FlaggingProvider EVP lifecycle', () => {
  let clock
  let provider
  let request
  let selectRoute
  let Provider
  let handlers
  let config
  let snapshotContext

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now })
    handlers = new Set(globalThis[Symbol.for('dd-trace')].beforeExitHandlers)
    request = sinon.stub().callsFake((body, options, callback) => callback(null, '', 202))
    const BaseWriter = proxyquire('../../src/openfeature/writers/base', {
      '../../exporters/common/request': request,
    })
    const Consumer = /** @type {typeof import('../../src/openfeature/writers/flag-evaluation-consumer')} */ (
      proxyquire('../../src/openfeature/writers/flag-evaluation-consumer', { './base': BaseWriter })
    )
    // Keep SDK-to-serialization semantics at the consumer boundary under fake time.
    // Separate producer and real-process tests cover worker ownership and scheduling.
    class Writer extends Consumer {
      getUnavailableReason () { return this.hasCapacity() ? undefined : 'unavailable' }
    }
    Writer['@noCallThru'] = true
    selectRoute = sinon.stub()
    snapshotContext = sinon.stub().callsFake(snapshotEvaluationContext)
    const Hook = proxyquire('../../src/openfeature/writers/flag-eval-evp-hook', {
      './flag-evaluations': Writer,
      './flag-evaluation-context': { snapshotEvaluationContext: snapshotContext },
      './util': { setExposureDeliveryStrategy: selectRoute },
    })
    Provider = proxyquire('../../src/openfeature/flagging_provider', {
      './writers/flag-eval-evp-hook': Hook,
      './configuration_source': { create: sinon.stub() },
      '../../../../vendor/dist/@datadog/openfeature-node-server': { DatadogNodeServerProvider },
    })
    config = {
      url: new URL('http://localhost:8126'),
      service: 'checkout',
      featureFlags: {
        DD_FLAGGING_EVALUATION_COUNTS_ENABLED: true,
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 1000,
      },
    }
  })

  afterEach(async () => {
    provider?.onClose()
    await OpenFeature.clearProviders()
    assert.deepStrictEqual(globalThis[Symbol.for('dd-trace')].beforeExitHandlers, handlers)
    clock.runMicrotasks()
    assert.strictEqual(clock.countTimers(), 0)
    clock.restore()
    sinon.restore()
    telemetryMetrics.manager.namespace('general').reset()
  })

  async function register (enabled = true) {
    config.featureFlags.DD_FLAGGING_EVALUATION_COUNTS_ENABLED = enabled
    provider = new Provider({}, config)
    provider.setConfiguration({ flags: {} })
    await OpenFeature.setProviderAndWait('evp-lifecycle', provider)
    return OpenFeature.getClient('evp-lifecycle')
  }

  function enable () {
    selectRoute.firstCall.args[1](true, { url: config.url, basePath: '/evp_proxy/v2' })
  }

  function resolve (consent, doLog) {
    sinon.stub(provider, 'resolveBooleanEvaluation').returns({
      value: true,
      variant: 'on',
      flagMetadata: {
        __dd_observe_full_evaluation_data: consent,
        __dd_eval_timestamp_ms: now - 100,
        __dd_allocation_key: 'allocation',
        __dd_do_log: doLog,
      },
    })
  }

  for (const consent of [false, true]) {
    it(`preserves the count when a targeting-key accessor throws, consent=${consent}`, async () => {
      const client = await register()
      enable()
      resolve(consent, true)
      // A before hook can install an accessor after OpenFeature's initial context merge.
      provider.hooks.push({
        before (hookContext) {
          Object.defineProperty(hookContext.context, 'targetingKey', {
            enumerable: true,
            get () { throw new Error('targeting-accessor-secret-canary') },
          })
        },
      })
      assert.strictEqual(await client.getBooleanValue('flag', false, { plan: 'pro' }), true)
      provider.onClose()
      assert.strictEqual(request.callCount, 1)
      const bytes = Buffer.from(request.firstCall.args[0])
      const [row] = JSON.parse(bytes.toString()).flagEvaluations
      assert.strictEqual(row.evaluation_count, 1)
      assert.strictEqual(row.targeting_key, undefined)
      assert.strictEqual(row.variant.key, 'on')
      assert.deepStrictEqual(row.context?.evaluation, consent ? { plan: 'pro' } : undefined)
      assert.strictEqual(bytes.includes('targeting-accessor-secret-canary'), false)
      const series = telemetryMetrics.manager.namespace('general').toJSON().metrics?.series ?? []
      const omitted = series.find(metric => metric.metric === 'flagevaluation.targeting_key.omitted')
      assert.strictEqual(omitted?.points[0][1], 1)
      assert.strictEqual(series.some(metric => metric.metric === 'flagevaluation.hook.errors'), false)
      assert.strictEqual(series.some(metric => metric.metric === 'flagevaluation.rows.dropped'), false)
    })

    for (const code of [ErrorCode.FLAG_NOT_FOUND, 'error-code-canary']) {
      it(`preserves default/count and strips raw errors for ${code}, consent=${consent}`, async () => {
        const client = await register()
        enable()
        sinon.stub(provider, 'resolveBooleanEvaluation').returns({
          value: false,
          errorCode: code,
          errorMessage: 'error-message-only-canary',
          flagMetadata: { __dd_observe_full_evaluation_data: consent },
        })
        for (const targetingKey of ['', undefined]) {
          assert.strictEqual(await client.getBooleanValue('error', false, { targetingKey, plan: 'pro' }), false)
        }
        provider.onClose()
        const bytes = Buffer.from(request.firstCall.args[0])
        const rows = JSON.parse(bytes).flagEvaluations
        assert.strictEqual(rows.length, 2)
        assert.deepStrictEqual(rows.map(row => row.targeting_key), ['', undefined])
        for (const row of rows) {
          assert.strictEqual(row.evaluation_count, 1)
          assert.strictEqual(row.runtime_default_used, true)
          assert.strictEqual(row.error.message, code === 'error-code-canary' ? 'GENERAL' : code)
          assert.deepStrictEqual(row.context, consent ? { evaluation: { plan: 'pro' } } : undefined)
        }
        assert.strictEqual(bytes.includes(Buffer.from('error-message-only-canary')), false)
        assert.strictEqual(bytes.includes(Buffer.from('error-code-canary')), false)
      })
    }
  }

  for (const consent of [false, true]) {
    it(`preserves counts and privacy when snapshotting fails, consent=${consent}`, async () => {
      const client = await register()
      enable()
      resolve(consent, false)
      snapshotContext.onFirstCall().throws(new Error('snapshot-error-secret-canary'))
      snapshotContext.onSecondCall().throws(new Error('snapshot-error-secret-canary'))
      const targetingKey = 'jane.doe@datadoghq.com'
      for (let i = 0; i < 2; i++) {
        assert.strictEqual(await client.getBooleanValue('checkout', false, {
          targetingKey, secret: 'failed-context-canary',
        }), true)
      }
      // A failed snapshot must not disable capture of subsequent healthy evaluations.
      assert.strictEqual(await client.getBooleanValue('checkout', false, { targetingKey, plan: 'pro' }), true)
      provider.onClose()

      sinon.assert.calledOnce(request)
      const bytes = Buffer.from(request.firstCall.args[0])
      const rows = JSON.parse(bytes.toString()).flagEvaluations
      assert.deepStrictEqual(rows.map(row => row.evaluation_count), consent ? [2, 1] : [3])
      assert.deepStrictEqual(rows.map(row => row.context), consent
        ? [undefined, { evaluation: { plan: 'pro' } }]
        : [undefined])
      for (const row of rows) {
        assert.strictEqual(row.targeting_key, consent
          ? targetingKey
          : 'sha256_b4698f9b6d186781fa8dc59e533578fa2d8379a46b1cf6db85cda6aa9c99e51b')
        assert.deepStrictEqual(row.variant, { key: 'on' })
        assert.deepStrictEqual(row.allocation, { key: 'allocation' })
        assert.strictEqual(row.first_evaluation, now - 100)
        assert.strictEqual(row.last_evaluation, now - 100)
      }
      assert.strictEqual(bytes.includes('snapshot-error-secret-canary'), false)
      assert.strictEqual(bytes.includes('failed-context-canary'), false)
      assert.strictEqual(snapshotContext.callCount, consent ? 3 : 0)
      const series = telemetryMetrics.manager.namespace('general').toJSON().metrics?.series ?? []
      const failures = series.find(metric => metric.metric === 'flagevaluation.context.truncated' &&
        metric.tags.includes('reason:snapshot_error'))
      assert.strictEqual(failures?.points[0][1] ?? 0, consent ? 2 : 0)
      assert.strictEqual(series.some(metric => metric.metric === 'flagevaluation.hook.errors'), false)
      assert.strictEqual(series.some(metric => metric.metric === 'flagevaluation.rows.dropped'), false)
      assert.strictEqual(series.some(metric => metric.metric === 'flagevaluation.rows.degraded'), false)
    })
  }

  for (const doLog of [false, true]) {
    it(`drains accepted events exactly once and releases owned resources with DoLog=${doLog}`, async () => {
      const client = await register()
      enable()
      resolve(true, doLog)
      const context = { targetingKey: 'full-customer', nested: { plan: 'pro' } }
      await client.getBooleanValue('checkout', false, context)
      context.nested.plan = 'changed-after-evaluation'
      sinon.assert.notCalled(request)
      assert.strictEqual(globalThis[Symbol.for('dd-trace')].beforeExitHandlers.size, handlers.size + 1)
      assert.ok(clock.countTimers() > 0)
      clock.setSystemTime(now + 1000)
      provider.onClose()
      provider.onClose()
      enable()
      sinon.assert.calledOnce(request)
      const [encoded, options] = request.firstCall.args
      const [row] = JSON.parse(encoded).flagEvaluations
      assert.strictEqual(options.path, '/evp_proxy/v2/api/v2/flagevaluation')
      assert.strictEqual(row.evaluation_count, 1)
      assert.strictEqual(row.first_evaluation, now - 100)
      assert.strictEqual(row.last_evaluation, now - 100)
      assert.strictEqual(row.timestamp, now + 1000)
      assert.strictEqual(row.targeting_key, 'full-customer')
      assert.deepStrictEqual(row.context.evaluation, { 'nested.plan': 'pro' })
      assert.strictEqual(row.targeting_rule, undefined)
      assert.strictEqual(encoded.includes('changed-after-evaluation'), false)
    })
  }

  it('never buffers unavailable evaluations or revives the writer after close', async () => {
    const client = await register()
    resolve(true, true)
    await client.getBooleanValue('before-route', false)
    enable()
    await client.getBooleanValue('accepted', false)
    provider.onClose()
    enable()
    await client.getBooleanValue('after-close', false)
    clock.tick(20_000)
    sinon.assert.calledOnce(request)
    assert.deepStrictEqual(JSON.parse(request.firstCall.args[0]).flagEvaluations.map(row => row.flag.key), ['accepted'])
  })

  it('keeps evaluation working without EVP route, timers or request work when disabled', async () => {
    const client = await register(false)
    resolve(true, true)
    assert.strictEqual(await client.getBooleanValue('disabled', false, { targetingKey: 'customer' }), true)
    provider.onClose()
    sinon.assert.notCalled(selectRoute)
    sinon.assert.notCalled(request)
  })

  it('omits an invalid targeting key once without dropping the evaluation', async () => {
    const client = await register()
    enable()
    resolve(false, false)
    await client.getBooleanValue('invalid', false, { targetingKey: '\uD800', secret: 'protected-context' })
    provider.onClose()
    const [encoded] = request.firstCall.args
    const [row] = JSON.parse(encoded).flagEvaluations
    assert.strictEqual(row.evaluation_count, 1)
    assert.strictEqual(row.targeting_key, undefined)
    assert.strictEqual(row.context, undefined)
    assert.strictEqual(encoded.includes('protected-context'), false)
    const series = telemetryMetrics.manager.namespace('general').toJSON().metrics.series
    assert.strictEqual(series.find(metric => metric.metric === 'flagevaluation.targeting_key.omitted').points[0][1], 1)
  })
})
