'use strict'

const assert = require('node:assert/strict')

const { ComparisonStrategy, MultiProvider, OpenFeature, ProviderEvents } = require('@openfeature/server-sdk')
const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const telemetryMetrics = require('../../src/telemetry/metrics')
const { hashTargetingKey } = require('../../src/openfeature/encoding')
const { debugChannel } = require('../../src/log/channels')

const parameter = 'dd_evaluation_telemetry_opt_out'
const option = 'DD_FEATURE_FLAGS_EVALUATION_TELEMETRY_PER_SUBJECT_OPT_OUT_ENABLED'
const exposureChannel = channel('ffe:exposure:submit')
const finishChannel = channel('dd-trace:span:finish')

function configuration (consent = false) {
  return {
    createdAt: '2026-10-15T00:00:00Z',
    format: 'SERVER',
    environment: { name: 'test' },
    observeFullEvaluationData: consent,
    flags: {
      flag: {
        key: 'flag',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: { on: { key: 'on', value: /** @type {import('@openfeature/core').FlagValue} */ (true) } },
        allocations: [{
          key: 'experiment',
          doLog: true,
          splits: [{ variationKey: 'on', shards: [], serialId: 42 }],
        }],
      },
    },
  }
}

describe('evaluation telemetry opt-out', () => {
  let clock
  let Provider
  let providers
  let counter
  let requests
  let exposures
  let onExposure
  let span
  let customFinally
  let originalOptOutEnvironment

  beforeEach(() => {
    originalOptOutEnvironment = process.env[option]
    delete process.env[option]
    clock = sinon.useFakeTimers({ now: 1_792_022_400_000 })
    providers = []
    requests = []
    exposures = []
    counter = { add: sinon.spy() }
    customFinally = sinon.spy()
    span = { setTag: sinon.spy(), context: () => ({ _trace: { started: [span] } }) }
    onExposure = event => exposures.push(event)
    exposureChannel.subscribe(onExposure)

    const BaseWriter = proxyquire('../../src/openfeature/writers/base', {
      '../../exporters/common/request': (body, options, callback) => {
        requests.push({ body: JSON.parse(body), path: options.path })
        callback(null, '', 202)
      },
    })
    const Consumer = /** @type {typeof import('../../src/openfeature/writers/flag-evaluation-consumer')} */ (
      proxyquire('../../src/openfeature/writers/flag-evaluation-consumer', { './base': BaseWriter })
    )
    // The actual consumer records serialized counts without a worker or network transport.
    class Writer extends Consumer {
      getUnavailableReason () { return this.hasCapacity() ? undefined : 'unavailable' }
    }
    Object.assign(Writer, { '@noCallThru': true })
    const EVPHook = proxyquire('../../src/openfeature/writers/flag-eval-evp-hook', {
      './flag-evaluations': Writer,
      './util': {
        setExposureDeliveryStrategy: (config, onRoute) => {
          onRoute(true, { url: config.url, basePath: '/evp_proxy/v2' })
        },
      },
    })
    const MetricsHook = proxyquire('../../src/openfeature/eval-metrics-hook', {
      '@opentelemetry/api': { metrics: { getMeter: () => ({ createCounter: () => counter }) } },
    })
    Provider = proxyquire('../../src/openfeature/flagging_provider', {
      './configuration_source': { create: () => undefined },
      './writers/flag-eval-evp-hook': EVPHook,
      './eval-metrics-hook': MetricsHook,
    })
  })

  afterEach(async () => {
    if (originalOptOutEnvironment === undefined) delete process.env[option]
    else process.env[option] = originalOptOutEnvironment
    for (const provider of providers) provider.onClose()
    await OpenFeature.clearProviders()
    OpenFeature.clearHooks()
    OpenFeature.setContext({})
    exposureChannel.unsubscribe(onExposure)
    telemetryMetrics.manager.namespace('general').reset()
    clock.restore()
    sinon.restore()
  })

  async function register (enabled, consent = false, name = 'telemetry-opt-out', ready = true) {
    const config = {
      url: new URL('http://localhost:8126'),
      service: 'telemetry-opt-out',
      DD_METRICS_OTEL_ENABLED: true,
      featureFlags: {
        [option]: enabled,
        DD_FLAGGING_EVALUATION_COUNTS_ENABLED: true,
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 1000,
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_SPAN_ENRICHMENT_ENABLED: true,
      },
    }
    const provider = new Provider({ scope: () => ({ active: () => span }) }, config)
    providers.push(provider)
    if (ready) {
      provider.setConfiguration(configuration(consent))
      await OpenFeature.setProviderAndWait(name, provider)
    } else {
      OpenFeature.setProvider(name, provider)
    }
    const client = OpenFeature.getClient(name)
    client.addHooks({ finally: customFinally })
    return { provider, client, config }
  }

  function signals () {
    finishChannel.publish(span)
    for (const provider of providers) provider.onClose()
    const rows = requests.flatMap(request => request.body.flagEvaluations)
    return {
      evaluations: rows.reduce((total, row) => total + row.evaluation_count, 0),
      metrics: counter.add.callCount,
      spanTags: span.setTag.callCount,
      exposures: exposures.length,
      customerHooks: customFinally.callCount,
    }
  }

  it('suppresses all evaluation signals and preserves the assignment and exposure', async () => {
    const { client } = await register(true)
    const details = await client.getBooleanDetails('flag', false, { targetingKey: 'opted-out', [parameter]: true })
    assert.deepStrictEqual({ value: details.value, variant: details.variant, reason: details.reason }, {
      value: true, variant: 'on', reason: 'STATIC',
    })
    assert.deepStrictEqual(signals(), { evaluations: 0, metrics: 0, spanTags: 0, exposures: 1, customerHooks: 1 })
    assert.deepStrictEqual(exposures[0].subject.attributes, { [parameter]: true })
  })

  for (const enabled of [false, true]) {
    it(`retains the attribute for targeting and exposures with activation=${enabled}`, async () => {
      const { provider, client } = await register(enabled)
      const config = configuration()
      provider.setConfiguration({
        ...config,
        flags: {
          flag: {
            ...config.flags.flag,
            allocations: [{
              ...config.flags.flag.allocations[0],
              rules: [{ conditions: [{ operator: 'ONE_OF', attribute: parameter, value: ['true'] }] }],
            }],
          },
        },
      })
      const matched = await client.getBooleanDetails('flag', false, { targetingKey: 'subject', [parameter]: true })
      assert.strictEqual(matched.value, true)
      assert.strictEqual(matched.flagMetadata.allocationKey, 'experiment')
      const unmatched = await client.getBooleanDetails('flag', false, { targetingKey: 'subject', [parameter]: false })
      assert.strictEqual(unmatched.value, false)
      assert.deepStrictEqual(exposures[0].subject.attributes, { [parameter]: true })
      const counts = signals()
      assert.strictEqual(counts.evaluations, enabled ? 1 : 2)
      assert.strictEqual(counts.metrics, enabled ? 1 : 2)
      assert.strictEqual(counts.exposures, 1)
    })
  }

  for (const { environment, explicit, suppressed } of [
    { environment: undefined, explicit: undefined, suppressed: false },
    { environment: 'true', explicit: undefined, suppressed: true },
    { environment: 'false', explicit: undefined, suppressed: false },
    { environment: 'invalid', explicit: undefined, suppressed: false },
    { environment: 'true', explicit: false, suppressed: false },
    { environment: 'false', explicit: true, suppressed: true },
  ]) {
    it(`resolves per-subject configuration env=${environment}, code=${explicit}`, async () => {
      if (environment !== undefined) process.env[option] = environment
      // Config tracks precedence at module scope; isolate each simulated process configuration.
      const Config = proxyquire('../../src/config', {})
      const resolved = new Config({
        featureFlags: { enableEvaluationTelemetryOptOutParameter: explicit },
      })
      const { client } = await register(resolved.featureFlags[option])
      const result = await client.getBooleanDetails('flag', false, { targetingKey: 'subject', [parameter]: true })
      assert.deepStrictEqual({ value: result.value, variant: result.variant, reason: result.reason }, {
        value: true, variant: 'on', reason: 'STATIC',
      })
      const count = suppressed ? 0 : 1
      assert.deepStrictEqual(signals(), {
        evaluations: count, metrics: count, spanTags: count * 2, exposures: 1, customerHooks: 1,
      })
    })
  }

  it('requires a subject opt-out even when the environment enables support', async () => {
    process.env[option] = 'true'
    const Config = proxyquire('../../src/config', {})
    const resolved = new Config()
    const { client } = await register(resolved.featureFlags[option])
    await client.getBooleanValue('flag', false, { targetingKey: 'subject' })
    assert.deepStrictEqual(signals(), { evaluations: 1, metrics: 1, spanTags: 2, exposures: 1, customerHooks: 1 })
  })

  it('preserves all supported flag types while suppressing evaluation telemetry', async () => {
    const { client, provider } = await register(true)
    const context = { targetingKey: 'subject', [parameter]: true }
    for (const { type, value, evaluate } of [
      { type: 'BOOLEAN', value: true, evaluate: () => client.getBooleanDetails('flag', false, context) },
      { type: 'STRING', value: 'enabled', evaluate: () => client.getStringDetails('flag', 'default', context) },
      { type: 'NUMERIC', value: 3.5, evaluate: () => client.getNumberDetails('flag', 0, context) },
      { type: 'JSON', value: { enabled: true }, evaluate: () => client.getObjectDetails('flag', {}, context) },
    ]) {
      const next = configuration()
      next.flags.flag.variationType = type
      next.flags.flag.variations.on.value = value
      provider.setConfiguration(next)
      context.targetingKey = type
      const result = await evaluate()
      assert.deepStrictEqual({ value: result.value, variant: result.variant, reason: result.reason }, {
        value, variant: 'on', reason: 'STATIC',
      })
    }
    assert.deepStrictEqual(signals(), { evaluations: 0, metrics: 0, spanTags: 0, exposures: 4, customerHooks: 4 })
  })

  for (const value of [undefined, false, null, 'true', 'false', 1, 0, {}, []]) {
    it(`keeps telemetry for a non-true parameter: ${JSON.stringify(value)}`, async () => {
      const { client } = await register(true)
      const context = /** @type {import('@openfeature/core').EvaluationContext} */ (
        { targetingKey: 'allowed', [parameter]: value }
      )
      const result = await client.getBooleanValue('flag', false, context)
      assert.strictEqual(result, true)
      assert.deepStrictEqual(signals(), { evaluations: 1, metrics: 1, spanTags: 2, exposures: 1, customerHooks: 1 })
    })
  }

  for (const enabled of [undefined, false, null, 'true', 1]) {
    it(`ignores the parameter without strict provider activation: ${JSON.stringify(enabled)}`, async () => {
      const { client } = await register(enabled)
      await client.getBooleanValue('flag', false, { targetingKey: 'allowed', [parameter]: true })
      assert.deepStrictEqual(signals(), { evaluations: 1, metrics: 1, spanTags: 2, exposures: 1, customerHooks: 1 })
    })
  }

  it('does not recognize old or differently cased parameter names', async () => {
    const { client } = await register(true)
    await client.getBooleanValue('flag', false, {
      targetingKey: 'allowed',
      dd_telemetry_opt_out: true,
      ddEvaluationTelemetryOptOut: true,
      DD_EVALUATION_TELEMETRY_OPT_OUT: true,
    })
    assert.deepStrictEqual(signals(), { evaluations: 1, metrics: 1, spanTags: 2, exposures: 1, customerHooks: 1 })
  })

  for (const consent of [false, true]) {
    it(`preserves queued events, exposures and reporting consent=${consent}`, async () => {
      const { client } = await register(true, consent)
      for (const targetingKey of ['before', 'suppressed', 'after']) {
        const result = await client.getBooleanDetails('flag', false, {
          targetingKey, [parameter]: targetingKey === 'suppressed', plan: 'pro',
        })
        assert.strictEqual(result.value, true)
        assert.strictEqual(result.flagMetadata.__dd_observe_full_evaluation_data, consent)
      }
      assert.deepStrictEqual(signals(), { evaluations: 2, metrics: 2, spanTags: 2, exposures: 3, customerHooks: 3 })
      const rows = requests.flatMap(request => request.body.flagEvaluations)
      assert.deepStrictEqual(rows.map(row => row.targeting_key).sort(), ['before', 'after'].map(key =>
        consent ? key : 'sha256_' + hashTargetingKey(key)
      ).sort())
      for (const row of rows) {
        assert.deepStrictEqual(row.context, consent
          ? { evaluation: { [parameter]: false, plan: 'pro' } }
          : undefined)
      }
      const subjects = JSON.parse(span.setTag.getCalls().find(call => call.args[0] === 'ffe_subjects_enc').args[1])
      assert.deepStrictEqual(Object.keys(subjects).sort(), ['before', 'after'].map(hashTargetingKey).sort())
      assert.ok(requests.every(request => request.path === '/evp_proxy/v2/api/v2/flagevaluation'))
    })
  }

  it('preserves exposure deduplication when the same subject changes the parameter', async () => {
    const { client } = await register(true)
    for (const optedOut of [true, false, true, false]) {
      assert.strictEqual(await client.getBooleanValue('flag', false, {
        targetingKey: 'same-subject', [parameter]: optedOut,
      }), true)
    }
    const optedOutExposures = [...exposures]
    const baseline = await register(false, false, 'baseline')
    for (const optedOut of [true, false, true, false]) {
      await baseline.client.getBooleanValue('flag', false, { targetingKey: 'same-subject', [parameter]: optedOut })
    }
    // The dependency includes context attributes in its exposure cache key, so these are two assignments.
    assert.deepStrictEqual(exposures.slice(optedOutExposures.length), optedOutExposures)
    assert.deepStrictEqual(signals(), { evaluations: 6, metrics: 6, spanTags: 4, exposures: 4, customerHooks: 8 })
  })

  it('captures activation at provider construction', async () => {
    const { client, config } = await register(true)
    config.featureFlags[option] = false
    await client.getBooleanValue('flag', false, { targetingKey: 'opted-out', [parameter]: true })
    assert.deepStrictEqual(signals(), { evaluations: 0, metrics: 0, spanTags: 0, exposures: 1, customerHooks: 1 })
  })

  it('honors per-evaluation overrides and customer before hooks in the merged context', async () => {
    const { client } = await register(true)
    OpenFeature.setContext({ [parameter]: true })
    await client.getBooleanValue('flag', false, { targetingKey: 'allowed', [parameter]: false })
    client.addHooks({ before: () => ({ [parameter]: true }) })
    await client.getBooleanValue('flag', false, { targetingKey: 'suppressed', [parameter]: false })
    assert.deepStrictEqual(signals(), { evaluations: 1, metrics: 1, spanTags: 2, exposures: 2, customerHooks: 2 })
  })

  for (const initial of [false, true]) {
    it(`does not emit if an after hook changes opt-out from ${initial} to ${!initial}`, async () => {
      const { client } = await register(true)
      let optedOut = initial
      client.addHooks({
        before ({ context }) {
          Object.defineProperty(context, parameter, {
            enumerable: true,
            configurable: true,
            get: () => optedOut,
            set: value => { optedOut = value },
          })
        },
        after () { optedOut = !initial },
      })
      assert.strictEqual(await client.getBooleanValue('flag', false, { targetingKey: 'subject' }), true)
      assert.deepStrictEqual(signals(), { evaluations: 0, metrics: 0, spanTags: 0, exposures: 1, customerHooks: 1 })
    })
  }

  it('captures a failing before hook decision before a customer error hook changes it', async () => {
    const { client } = await register(true)
    const onError = sinon.spy(({ context }) => { context[parameter] = false })
    client.addHooks({ before () { throw new Error('before failed') }, error: onError })
    const result = await client.getBooleanDetails('flag', false, { targetingKey: 'subject', [parameter]: true })
    assert.strictEqual(result.value, false)
    assert.strictEqual(result.errorCode, 'GENERAL')
    sinon.assert.calledOnce(onError)
    assert.deepStrictEqual(signals(), { evaluations: 0, metrics: 0, spanTags: 0, exposures: 0, customerHooks: 1 })
  })

  for (const [failure, errorCode] of Object.entries({
    missing: 'FLAG_NOT_FOUND',
    'type-mismatch': 'TYPE_MISMATCH',
    'no-config': 'PROVIDER_NOT_READY',
    'not-ready': 'PROVIDER_NOT_READY',
    fatal: 'PROVIDER_FATAL',
    'after-hook': 'GENERAL',
  })) {
    it(`preserves defaults and errors without new telemetry on ${failure}`, async () => {
      const { client, provider } = await register(true, false, 'telemetry-opt-out', failure !== 'not-ready')
      if (failure === 'no-config') provider.setConfiguration(undefined)
      if (failure === 'fatal') provider.events.emit(ProviderEvents.Error, { errorCode: 'PROVIDER_FATAL' })
      if (failure === 'after-hook') client.addHooks({ after () { throw new Error('after failed') } })
      const context = { targetingKey: 'subject', [parameter]: true }
      const result = failure === 'type-mismatch'
        ? await client.getStringDetails('flag', 'fallback', context)
        : await client.getBooleanDetails(failure === 'missing' ? 'missing' : 'flag', false, context)
      assert.strictEqual(result.value, failure === 'type-mismatch' ? 'fallback' : false)
      assert.strictEqual(result.reason, 'ERROR')
      assert.strictEqual(result.errorCode, errorCode)
      if (failure === 'not-ready') provider.setConfiguration(configuration())
      assert.deepStrictEqual(signals(), {
        evaluations: 0, metrics: 0, spanTags: 0, exposures: 0, customerHooks: 1,
      })
    })
  }

  it('isolates nested calls from their outer evaluation', async () => {
    const { client } = await register(true)
    client.addHooks({
      async after ({ context }) {
        if (context.targetingKey === 'outer') {
          assert.strictEqual(await client.getBooleanValue('flag', false, {
            targetingKey: 'inner', [parameter]: false,
          }), true)
        }
      },
    })
    assert.strictEqual(await client.getBooleanValue('flag', false, {
      targetingKey: 'outer', [parameter]: true,
    }), true)
    assert.deepStrictEqual(signals(), { evaluations: 1, metrics: 1, spanTags: 2, exposures: 2, customerHooks: 2 })
  })

  it('isolates concurrent subjects while after hooks overlap', async () => {
    const { client } = await register(true)
    let arrivals = 0
    let release
    const barrier = new Promise(resolve => { release = resolve })
    client.addHooks({ after () { if (++arrivals === 4) release(); return barrier } })
    const results = await Promise.all([true, false, true, false].map((optedOut, i) =>
      client.getBooleanValue('flag', false, { targetingKey: 'subject-' + i, [parameter]: optedOut })
    ))
    assert.deepStrictEqual(results, [true, true, true, true])
    assert.deepStrictEqual(signals(), { evaluations: 2, metrics: 2, spanTags: 2, exposures: 4, customerHooks: 4 })
  })

  it('keeps independent activation settings inside a concurrent MultiProvider', async () => {
    const enabled = await register(true, false, 'enabled')
    const disabled = await register(false, false, 'disabled')
    const multi = new MultiProvider([
      { name: 'enabled', provider: enabled.provider },
      { name: 'disabled', provider: disabled.provider },
    ], new ComparisonStrategy(disabled.provider))
    await OpenFeature.setProviderAndWait('multi', multi)
    const client = OpenFeature.getClient('multi')
    client.addHooks({ finally: customFinally })
    const results = await Promise.all(['a', 'b'].map(targetingKey =>
      client.getBooleanDetails('flag', false, { targetingKey, [parameter]: true })
    ))
    assert.ok(results.every(result => result.value === true), JSON.stringify(results))
    assert.deepStrictEqual(signals(), { evaluations: 2, metrics: 2, spanTags: 2, exposures: 4, customerHooks: 2 })
  })

  it('keeps the outer decision when a nested evaluation decides differently', async () => {
    const { client } = await register(true)
    let outerOptedOut = true
    client.addHooks({
      before ({ context }) {
        if (context.targetingKey !== 'outer') return
        // The SDK freezes the merged context after before hooks. An accessor can still change its value.
        Object.defineProperty(context, parameter, {
          enumerable: true,
          configurable: true,
          get: () => outerOptedOut,
          set: value => { outerOptedOut = value },
        })
      },
      async after ({ context }) {
        if (context.targetingKey !== 'outer') return
        outerOptedOut = false
        assert.strictEqual(await client.getBooleanValue('flag', false, { targetingKey: 'inner' }), true)
      },
    })
    assert.strictEqual(await client.getBooleanValue('flag', false, { targetingKey: 'outer' }), true)
    assert.deepStrictEqual(signals(), { evaluations: 1, metrics: 1, spanTags: 2, exposures: 2, customerHooks: 2 })
  })

  it('keeps debug logging for an opted-out subject', async () => {
    const messages = []
    const onDebug = message => { messages.push(String(message)) }
    debugChannel.subscribe(onDebug)
    try {
      const provider = new Provider({ scope: () => ({ active: () => span }) }, {
        url: new URL('http://localhost:8126'),
        debug: true,
        featureFlags: {
          [option]: true,
          DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 1000,
        },
      })
      providers.push(provider)
      provider.setConfiguration(configuration())
      await OpenFeature.setProviderAndWait('debug', provider)
      messages.length = 0
      const client = OpenFeature.getClient('debug')
      await client.getBooleanValue('flag', false, { targetingKey: 'subject', [parameter]: true })
      assert.strictEqual(messages.filter(message => message.startsWith('Feature Flags: evaluated flag:')).length, 1)
      assert.strictEqual(signals().evaluations, 0)
    } finally {
      debugChannel.unsubscribe(onDebug)
    }
  })

  it('keeps the result and telemetry when the parameter cannot be read', async () => {
    const { client } = await register(true)
    client.addHooks({
      before ({ context }) {
        // Context merges skip this non-enumerable property. Only the opt-out check reads it.
        Object.defineProperty(context, parameter, { get () { throw new Error('unreadable') } })
      },
    })
    const result = await client.getBooleanDetails('flag', false, { targetingKey: 'subject' })
    assert.deepStrictEqual({ value: result.value, reason: result.reason, errorCode: result.errorCode }, {
      value: true, reason: 'STATIC', errorCode: undefined,
    })
    assert.deepStrictEqual(signals(), { evaluations: 1, metrics: 1, spanTags: 2, exposures: 1, customerHooks: 1 })
  })

  it('wraps only hooks that implement finally alone', () => {
    for (const Hook of [
      require('../../src/openfeature/eval-metrics-hook'),
      require('../../src/openfeature/span-enrichment-hook'),
      require('../../src/openfeature/writers/flag-eval-evp-hook'),
    ]) {
      for (const stage of ['before', 'after', 'error']) {
        // The wrapper forwards only finally, so another stage would run only with activation disabled.
        assert.strictEqual(Hook.prototype[stage], undefined, `${Hook.name}.${stage} would be skipped by the wrapper`)
      }
    }
  })
})
