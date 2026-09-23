'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
const { ErrorCode, OpenFeature, ProviderEvents } = require('@openfeature/server-sdk')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
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
      isAvailable () { return this.hasCapacity() }
    }
    Writer['@noCallThru'] = true
    selectRoute = sinon.stub()
    const Hook = proxyquire('../../src/openfeature/writers/flag-eval-evp-hook', {
      './flag-evaluations': Writer,
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
      featureFlags: { DD_FLAGGING_EVALUATION_COUNTS_ENABLED: true },
      experimental: { flaggingProvider: { initializationTimeoutMs: 1000 } },
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

  // Resolver-controlled metadata tests the SDK-to-wire contract without claiming
  // that the installed (pre-consent) evaluator produces the unpublished metadata.
  for (const consent of [undefined, false, true, 'true', 1, null]) {
    it(`enforces strict consent in raw request bytes (${JSON.stringify(consent)})`, async () => {
      const client = await register()
      enable()
      resolve(consent, false)
      const context = { targetingKey: 'target-canary@example.test', nested: { value: 'context-canary' } }
      await client.getBooleanValue('consent', false, context)
      context.targetingKey = 'mutated-target-canary'
      context.nested.value = 'mutated-context-canary'
      provider.onClose()
      const bytes = Buffer.from(request.firstCall.args[0])
      const [row] = JSON.parse(bytes).flagEvaluations
      assert.strictEqual(row.evaluation_count, 1)
      assert.strictEqual(row.runtime_default_used, undefined)
      assert.strictEqual(bytes.includes(Buffer.from('mutated-')), false)
      if (consent === true) {
        assert.strictEqual(row.targeting_key, 'target-canary@example.test')
        assert.deepStrictEqual(row.context.evaluation, { 'nested.value': 'context-canary' })
      } else {
        const digest = createHash('sha256').update('target-canary@example.test').digest('hex')
        assert.strictEqual(row.targeting_key, 'sha256_' + digest)
        assert.strictEqual(bytes.includes(Buffer.from('target-canary@example.test')), false)
        assert.strictEqual(bytes.includes(Buffer.from('context-canary')), false)
        assert.strictEqual(row.context, undefined)
      }
    })
  }

  for (const consent of [false, true]) {
    for (const code of [...Object.values(ErrorCode), 'error-code-canary']) {
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

  for (const terminal of ['throw', 'not-ready', 'fatal', 'missing', 'type-mismatch']) {
    it(`protects raw bytes and retains counts on the real SDK ${terminal} path`, async () => {
      let finishInitialization
      if (terminal === 'not-ready') {
        provider = new Provider({}, config)
        provider.initialize = () => new Promise(resolve => { finishInitialization = resolve })
        OpenFeature.setProvider('evp-lifecycle', provider)
      } else {
        await register()
      }
      enable()
      if (terminal === 'throw') {
        sinon.stub(provider, 'resolveBooleanEvaluation').throws(new Error('error-message-only-canary'))
      }
      if (terminal === 'fatal') provider.events.emit(ProviderEvents.Error, { errorCode: 'PROVIDER_FATAL' })
      if (terminal === 'type-mismatch') {
        provider.setConfiguration({
          flags: {
            flag: {
              key: 'flag',
              enabled: true,
              variationType: 'STRING',
              variations: { on: { key: 'on', value: 'wrong-type' } },
              allocations: [{ key: 'all', rules: [], splits: [{ variationKey: 'on', shards: [] }], doLog: false }],
            },
          },
        })
      }
      const details = await OpenFeature.getClient('evp-lifecycle').getBooleanDetails('flag', false, {
        targetingKey: 'terminal-target-canary', secret: 'terminal-context-canary',
      })
      finishInitialization?.()
      provider.onClose()
      const bytes = Buffer.from(request.firstCall.args[0])
      const [row] = JSON.parse(bytes).flagEvaluations
      const expected = {
        throw: 'GENERAL',
        'not-ready': 'PROVIDER_NOT_READY',
        fatal: 'PROVIDER_FATAL',
        missing: 'FLAG_NOT_FOUND',
        'type-mismatch': 'TYPE_MISMATCH',
      }[terminal]
      assert.strictEqual(details.value, false)
      assert.strictEqual(details.errorCode, expected)
      assert.strictEqual(row.error.message, expected)
      assert.strictEqual(row.evaluation_count, 1)
      assert.strictEqual(row.runtime_default_used, true)
      assert.strictEqual(row.targeting_key,
        'sha256_' + createHash('sha256').update('terminal-target-canary').digest('hex'))
      assert.strictEqual(row.context, undefined)
      for (const canary of ['terminal-target-canary', 'terminal-context-canary', 'error-message-only-canary']) {
        assert.strictEqual(bytes.includes(Buffer.from(canary)), false)
      }
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
