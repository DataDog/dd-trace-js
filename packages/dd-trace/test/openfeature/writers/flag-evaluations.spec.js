'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const nock = require('nock')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')
const constants = require('../../../src/openfeature/constants/constants')
const aggregationModule = require('../../../src/openfeature/writers/flag-evaluation-aggregation')
const { FlagEvaluationAggregator } = aggregationModule
const telemetryMetrics = require('../../../src/telemetry/metrics')

const endpoint = '/api/v2/flagevaluation'
const config = {
  url: new URL('http://localhost:8126'),
  service: 'checkout-service',
  env: 'test',
  version: '1.2.3',
}
const route = { url: config.url, basePath: '', headers: {} }

function loadWriter (overrides = {}) {
  const overriddenConstants = { ...constants, ...overrides }
  const aggregation = proxyquire('../../../src/openfeature/writers/flag-evaluation-aggregation', {
    '../constants/constants': overriddenConstants,
  })
  const payload = proxyquire('../../../src/openfeature/writers/flag-evaluation-payload', {
    '../constants/constants': overriddenConstants,
  })
  return proxyquire('../../../src/openfeature/writers/flag-evaluation-consumer', {
    '../constants/constants': overriddenConstants,
    './flag-evaluation-aggregation': aggregation,
    './flag-evaluation-payload': payload,
  })
}

function event (overrides = {}) {
  return {
    flagKey: 'checkout',
    variant: 'on',
    allocationKey: 'experiment',
    runtimeDefault: false,
    targetingKey: 'customer-1',
    attrs: Object.freeze({ plan: 'pro' }),
    observeFullEvaluationData: true,
    timestamp: 1_759_276_800_123,
    ...overrides,
  }
}

function nextImmediate () {
  return new Promise(resolve => setImmediate(resolve))
}

function captureRequests (path = endpoint, expected = 1) {
  const bodies = []
  let resolveReceived
  const received = new Promise(resolve => { resolveReceived = resolve })
  const scope = nock('http://localhost:8126')
    .persist()
    .post(path)
    .reply(202, (uri, body) => {
      bodies.push({ uri, body })
      if (bodies.length === expected) resolveReceived()
      return ''
    })
  return { bodies, received, scope }
}

function metricValue (name, reason) {
  const metrics = telemetryMetrics.manager.namespace('general').toJSON().metrics?.series ?? []
  const expectedTag = reason && 'reason:' + reason
  const metric = metrics.find(metric => metric.metric === name && (!expectedTag || metric.tags.includes(expectedTag)))
  return metric?.points[0][1] ?? 0
}

describe('OpenFeature flag evaluations writer', () => {
  let writer
  let intervalClock

  beforeEach(() => {
    intervalClock = sinon.useFakeTimers({
      shouldClearNativeTimers: true,
      toFake: ['setInterval', 'clearInterval'],
    })
  })

  afterEach(() => {
    writer?.destroy()
    writer = undefined
    nock.cleanAll()
    intervalClock.restore()
    sinon.restore()
    telemetryMetrics.manager.namespace('general').reset()
  })

  it('uses the production cardinality and lifecycle caps', () => {
    assert.strictEqual(constants.FLAG_EVALUATION_QUEUE_CAP, 4096)
    assert.strictEqual(constants.FLAG_EVALUATION_GLOBAL_CAP, 131_072)
    assert.strictEqual(constants.FLAG_EVALUATION_PER_FLAG_CAP, 10_000)
    assert.strictEqual(constants.FLAG_EVALUATION_DEGRADED_CAP, 32_768)
    assert.strictEqual(constants.FLAG_EVALUATION_FLUSH_INTERVAL, 10_000)
  })

  it('enforces existing-first lookup and all production aggregation boundaries', () => {
    const globalAggregator = new FlagEvaluationAggregator()
    for (let i = 0; i < constants.FLAG_EVALUATION_GLOBAL_CAP; i++) {
      globalAggregator.add(event({ flagKey: 'global-' + i, variant: 'one' }))
    }
    globalAggregator.add(event({ flagKey: 'global-0', variant: 'one' }))
    globalAggregator.add(event({ flagKey: 'global-overflow', variant: 'one' }))
    const globalResult = globalAggregator.take()

    assert.strictEqual(globalResult.full.size, 131_072)
    assert.strictEqual(globalResult.full.values().next().value.count, 2)
    assert.strictEqual(globalResult.degraded.size, 1)

    const perFlagAggregator = new FlagEvaluationAggregator()
    for (let i = 0; i < constants.FLAG_EVALUATION_PER_FLAG_CAP; i++) {
      perFlagAggregator.add(event({ flagKey: 'one-flag', variant: 'full-' + i }))
    }
    for (let i = 0; i <= constants.FLAG_EVALUATION_DEGRADED_CAP; i++) {
      perFlagAggregator.add(event({ flagKey: 'one-flag', variant: 'degraded-' + i }))
    }
    const perFlagResult = perFlagAggregator.take()

    assert.strictEqual(perFlagResult.full.size, 10_000)
    assert.strictEqual(perFlagResult.degraded.size, 32_768)
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'degraded_cap'), 1)
  })

  it('re-enforces strict consent in aggregation and AND-folds every merge', () => {
    const { FlagEvaluationAggregator: ReducedAggregator } = proxyquire(
      '../../../src/openfeature/writers/flag-evaluation-aggregation',
      {
        '../constants/constants': {
          ...constants,
          FLAG_EVALUATION_PER_FLAG_CAP: 0,
        },
      }
    )
    const aggregator = new ReducedAggregator()
    aggregator.add(event({
      flagKey: 'bypass',
      attrs: Object.freeze({ canary: 'must-not-survive' }),
      observeFullEvaluationData: true,
      timestamp: 1_759_276_800_300,
    }))
    aggregator.add(event({
      flagKey: 'bypass',
      attrs: Object.freeze({ canary: 'must-not-survive-either' }),
      observeFullEvaluationData: false,
      timestamp: 1_759_276_800_100,
    }))
    aggregator.add(event({
      flagKey: 'bypass',
      attrs: Object.freeze({ canary: 'still-must-not-survive' }),
      observeFullEvaluationData: true,
      timestamp: 1_759_276_800_400,
    }))
    const { full, degraded } = aggregator.take()
    const [entry] = degraded.values()
    assert.strictEqual(full.size, 0)
    assert.strictEqual(degraded.size, 1)
    assert.strictEqual(entry.consent, false)
    assert.strictEqual(entry.attrs, undefined)
    assert.strictEqual(entry.count, 3)
    assert.strictEqual(entry.first, 1_759_276_800_100)
    assert.strictEqual(entry.last, 1_759_276_800_400)
  })

  it('bounds the deferred queue at 4096 without doing aggregation work inline', () => {
    writer = new (loadWriter())(config)
    writer.setEnabled(true, route)

    for (let i = 0; i < 4096; i++) {
      assert.strictEqual(writer.hasCapacity(), true)
      assert.strictEqual(writer.enqueue(event({ timestamp: 1_759_276_800_000 + i })), true)
    }
    assert.strictEqual(writer.hasCapacity(), false)
    assert.strictEqual(writer.enqueue(event()), false)
    writer.setEnabled(false)
    writer.destroy()
    writer = undefined
  })

  it('aggregates out-of-order observations and enforces privacy at the wire boundary', async () => {
    const { bodies, received } = captureRequests()
    writer = new (loadWriter())(config)
    writer.setEnabled(true, route)
    const attrs = Object.freeze({ plan: 'pro' })

    writer.enqueue(event({ timestamp: 1_759_276_800_300, attrs }))
    writer.enqueue(event({ timestamp: 1_759_276_800_100, attrs }))
    writer.enqueue(event({
      flagKey: 'protected',
      targetingKey: 'customer-1',
      attrs: Object.freeze({ canary: 'must-not-appear' }),
      errorCode: 'FLAG_NOT_FOUND',
      observeFullEvaluationData: false,
    }))
    writer.enqueue(event({
      flagKey: 'strict-consent',
      targetingKey: '',
      attrs: Object.freeze({ canary: 'must-not-appear-either' }),
      observeFullEvaluationData: 1,
    }))
    writer.enqueue(event({ flagKey: 'consent-split', targetingKey: 'sha256_caller-text' }))
    writer.enqueue(event({
      flagKey: 'consent-split',
      targetingKey: 'sha256_caller-text',
      observeFullEvaluationData: false,
    }))
    await nextImmediate()
    writer.flush()
    await received

    assert.strictEqual(bodies.length, 1)
    assert.deepStrictEqual(bodies[0].body.context, {
      service: 'checkout-service',
      env: 'test',
      version: '1.2.3',
    })
    const rows = bodies[0].body.flagEvaluations
    const full = rows.find(row => row.flag.key === 'checkout')
    assert.strictEqual(full.evaluation_count, 2)
    assert.strictEqual(full.first_evaluation, 1_759_276_800_100)
    assert.strictEqual(full.last_evaluation, 1_759_276_800_300)
    assert.deepStrictEqual(full.context, { evaluation: { plan: 'pro' } })
    assert.strictEqual(full.targeting_key, 'customer-1')
    assert.strictEqual(full.targeting_rule, undefined)
    assert.deepStrictEqual(full.allocation, { key: 'experiment' })

    const protectedRow = rows.find(row => row.flag.key === 'protected')
    assert.strictEqual(
      protectedRow.targeting_key,
      'sha256_e83f10dcd2c68747c3f3ba14a54258d5c1843a8d75b0f5cb52c6f3df052a72d1'
    )
    assert.strictEqual(protectedRow.context, undefined)
    assert.deepStrictEqual(protectedRow.error, { message: 'FLAG_NOT_FOUND' })
    assert.strictEqual(JSON.stringify(bodies).includes('must-not-appear'), false)

    const strict = rows.find(row => row.flag.key === 'strict-consent')
    assert.strictEqual(strict.targeting_key, '')
    assert.strictEqual(strict.context, undefined)

    const consentSplit = rows.filter(row => row.flag.key === 'consent-split')
    assert.strictEqual(consentSplit.length, 2)
    assert.ok(consentSplit.some(row => row.targeting_key === 'sha256_caller-text'))
    assert.ok(consentSplit.some(row => row.targeting_key.startsWith('sha256_') &&
      row.targeting_key !== 'sha256_caller-text'))
  })

  it('uses existing buckets before caps and degrades deterministically through both tiers', async () => {
    const { bodies, received } = captureRequests()
    const Writer = loadWriter({
      FLAG_EVALUATION_GLOBAL_CAP: 2,
      FLAG_EVALUATION_PER_FLAG_CAP: 2,
      FLAG_EVALUATION_DEGRADED_CAP: 1,
    })
    writer = new Writer(config)
    writer.setEnabled(true, route)

    writer.enqueue(event({ variant: 'one', timestamp: 1_759_276_800_300 }))
    writer.enqueue(event({ variant: 'two' }))
    writer.enqueue(event({ variant: 'one', timestamp: 1_759_276_800_100 }))
    writer.enqueue(event({ variant: 'three', observeFullEvaluationData: true }))
    writer.enqueue(event({ variant: 'three', observeFullEvaluationData: false }))
    writer.enqueue(event({ variant: 'four' }))
    await nextImmediate()
    writer.flush()
    await received

    const rows = bodies.flatMap(({ body }) => body.flagEvaluations)
    const existing = rows.find(row => row.variant?.key === 'one')
    assert.strictEqual(existing.evaluation_count, 2)
    assert.strictEqual(existing.first_evaluation, 1_759_276_800_100)
    assert.strictEqual(existing.last_evaluation, 1_759_276_800_300)

    const degraded = rows.find(row => row.variant?.key === 'three')
    assert.strictEqual(degraded.evaluation_count, 2)
    assert.strictEqual(degraded.targeting_key, undefined)
    assert.strictEqual(degraded.context, undefined)
    assert.strictEqual(rows.some(row => row.variant?.key === 'four'), false)
    assert.strictEqual(metricValue('flagevaluation.rows.degraded', 'cardinality_cap'), 3)
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'degraded_cap'), 1)
  })

  it('splits full envelopes and degrades a row that exceeds its byte limit', async () => {
    const { bodies, received } = captureRequests(endpoint, 2)
    const Writer = loadWriter({
      EVP_EVENT_SIZE_LIMIT: 430,
      // The two valid rows must fit individually but not in a shared envelope.
      EVP_PAYLOAD_SIZE_LIMIT: 500,
    })
    writer = new Writer(config)
    writer.setEnabled(true, route)

    writer.enqueue(event({ flagKey: 'large', attrs: Object.freeze({ data: 'x'.repeat(240) }) }))
    writer.enqueue(event({ flagKey: 'second', targetingKey: 'customer-2' }))
    writer.enqueue(event({ flagKey: 'z'.repeat(500) }))
    await nextImmediate()
    writer.flush()
    await received

    assert.strictEqual(bodies.length, 2)
    for (const { body } of bodies) {
      assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 500)
    }
    const rows = bodies.flatMap(({ body }) => body.flagEvaluations)
    const large = rows.find(row => row.flag.key === 'large')
    assert.strictEqual(large.context, undefined)
    assert.strictEqual(large.targeting_key, undefined)
    assert.strictEqual(metricValue('flagevaluation.rows.degraded', 'payload_limit'), 2)
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'payload_limit'), 1)
    assert.strictEqual(metricValue('flagevaluation.payload.splits'), 1)
  })

  it('removes raw PII when a row fits the event limit but not a fresh envelope after splitting', () => {
    const { iterateFlagEvaluationPayloads } = proxyquire('../../../src/openfeature/writers/flag-evaluation-payload', {
      '../constants/constants': { ...constants, EVP_EVENT_SIZE_LIMIT: 1000, EVP_PAYLOAD_SIZE_LIMIT: 600 },
    })
    const aggregator = new FlagEvaluationAggregator()
    aggregator.add(event({ flagKey: 'first', targetingKey: undefined, attrs: undefined, timestamp: 100 }))
    aggregator.add(event({
      flagKey: 'second',
      targetingKey: 'post-split-target-canary',
      attrs: { secret: 'post-split-context-canary' + 'x'.repeat(240) },
      timestamp: 100,
    }))
    const { full, degraded } = aggregator.take()
    // The shared envelope consumes enough space that the second row needs degradation,
    // even on its own. Its undegraded row is still comfortably below the 1000-byte event cap.
    const iterator = iterateFlagEvaluationPayloads(full, degraded, { service: 's'.repeat(300) }, 100)
    const first = iterator.next().value
    // No per-event degradation has happened when the first envelope closes.
    assert.strictEqual(metricValue('flagevaluation.rows.degraded', 'payload_limit'), 0)
    const payloads = [first, ...iterator]
    assert.strictEqual(payloads.length, 2)
    assert.deepStrictEqual(payloads.map(payload => payload.evaluations), [1, 1])
    for (const payload of payloads) assert.ok(Buffer.byteLength(payload.encoded) <= 600)
    const bytes = Buffer.from(payloads[1].encoded)
    assert.strictEqual(bytes.includes('post-split-target-canary'), false)
    assert.strictEqual(bytes.includes('post-split-context-canary'), false)
    const [row] = JSON.parse(bytes.toString()).flagEvaluations
    assert.strictEqual(row.flag.key, 'second')
    assert.strictEqual(row.targeting_key, undefined)
    assert.strictEqual(row.context, undefined)
    assert.strictEqual(row.evaluation_count, 1)
    assert.strictEqual(metricValue('flagevaluation.rows.degraded', 'payload_limit'), 1)
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'payload_limit'), 0)
    assert.strictEqual(metricValue('flagevaluation.payload.splits'), 1)
  })

  it('validates inputs without coercion and isolates one row serialization failure', async () => {
    const { bodies, received } = captureRequests()
    writer = new (loadWriter())(config)
    writer.setEnabled(true, route)
    const queued = event({ flagKey: 'owned', attrs: Object.freeze({ original: true }) })
    writer.enqueue(queued)
    queued.attrs = Object.freeze({ changed: true })
    writer.enqueue(event({
      flagKey: 'safe',
      variant: '\uD800',
      targetingKey: '\uD800',
      errorCode: { toString () { throw new Error('must not coerce') } },
    }))
    writer.enqueue(event({ flagKey: 'bad' }))
    await nextImmediate()

    const stringify = JSON.stringify
    sinon.stub(JSON, 'stringify').callsFake(value => {
      if (value?.flag?.key === 'bad') throw new Error('row encoding failure')
      return stringify(value)
    })
    writer.flush()
    await received

    const rows = bodies[0].body.flagEvaluations
    assert.strictEqual(rows.some(row => row.flag.key === 'bad'), false)
    assert.deepStrictEqual(rows.find(row => row.flag.key === 'owned').context, {
      evaluation: { original: true },
    })
    const safe = rows.find(row => row.flag.key === 'safe')
    assert.strictEqual(safe.variant, undefined)
    assert.strictEqual(safe.targeting_key, undefined)
    assert.deepStrictEqual(safe.error, { message: 'GENERAL' })
    assert.strictEqual(metricValue('flagevaluation.targeting_key.omitted', 'invalid'), 1)
    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'serialization_error'), 1)
  })

  it('unrefs and cancels its deferred drain, interval, and beforeExit handler', () => {
    const handlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
    const initialHandlers = handlers.size
    const setImmediateSpy = sinon.spy(global, 'setImmediate')
    const clearImmediateSpy = sinon.spy(global, 'clearImmediate')
    writer = new (loadWriter())(config)
    writer._sendPayload = () => {}
    writer.setEnabled(true, route)
    assert.strictEqual(handlers.size, initialHandlers + 1)
    assert.strictEqual(intervalClock.countTimers(), 1)

    writer.enqueue(event())
    sinon.assert.calledOnce(setImmediateSpy)
    assert.strictEqual(setImmediateSpy.firstCall.returnValue.hasRef(), false)
    writer.destroy()
    writer.destroy()

    sinon.assert.calledOnce(clearImmediateSpy)
    assert.strictEqual(intervalClock.countTimers(), 0)
    assert.strictEqual(handlers.size, initialHandlers)
  })

  it('rejects unavailable events, applies route changes, and drains exactly once on destroy', async () => {
    const first = captureRequests('/first/api/v2/flagevaluation')
    const second = captureRequests('/second/api/v2/flagevaluation')
    writer = new (loadWriter())(config)

    assert.strictEqual(writer.hasCapacity(), false)
    assert.strictEqual(writer.enqueue(event()), false)
    writer.setEnabled(true, { ...route, basePath: '/first' })
    writer.enqueue(event({ flagKey: 'first' }))
    await nextImmediate()
    writer.flush()
    writer.setEnabled(true, { ...route, basePath: '/second' })
    writer.enqueue(event({ flagKey: 'second' }))
    writer.destroy()
    writer.destroy()
    await Promise.all([first.received, second.received])

    assert.strictEqual(first.bodies.length, 1)
    assert.strictEqual(second.bodies.length, 1)
    assert.strictEqual(second.bodies[0].body.flagEvaluations[0].flag.key, 'second')
    assert.strictEqual(writer.enqueue(event()), false)
  })

  it('drops accepted queued and aggregated counts exactly when a route becomes unavailable', async () => {
    writer = new (loadWriter())(config)
    const send = sinon.stub(writer, '_sendPayload')
    writer.setEnabled(true, route)
    writer.enqueue(event({ flagKey: 'aggregated' }))
    await nextImmediate()
    writer.enqueue(event({ flagKey: 'queued' }))

    writer.setEnabled(false)
    writer.setEnabled(true, route)
    writer.flush()

    assert.strictEqual(metricValue('flagevaluation.rows.dropped', 'unavailable'), 2)
    sinon.assert.notCalled(send)
  })

  it('reuses base transport fallback with the singular direct endpoint and auth headers', async () => {
    const local = nock('http://localhost:8126')
      .post('/evp_proxy/v4/api/v2/flagevaluation')
      .reply(405)
    let resolveDirect
    const directReceived = new Promise(resolve => { resolveDirect = resolve })
    const direct = nock('https://event-platform-intake.datadoghq.com', {
      reqheaders: { 'dd-api-key': 'test-api-key' },
    })
      .post(endpoint)
      .reply(202, () => {
        resolveDirect()
        return ''
      })
    writer = new (loadWriter())(config)
    writer.setEnabled(true, {
      url: config.url,
      basePath: '/evp_proxy/v4',
      headers: { 'x-datadog-evp-subdomain': 'event-platform-intake' },
      fallback: {
        url: new URL('https://event-platform-intake.datadoghq.com'),
        basePath: '',
        headers: { 'DD-API-KEY': 'test-api-key' },
      },
    })
    writer.enqueue(event())
    writer.flush()
    await directReceived

    local.done()
    direct.done()
  })

  it('keeps telemetry bounded and swallows repeated sink failures', () => {
    const flagEvaluationTelemetry = proxyquire('../../../src/openfeature/writers/flag-evaluation-telemetry', {})
    const namespace = telemetryMetrics.manager.namespace('general')
    sinon.stub(namespace, 'count').throws(new Error('sink failed'))

    flagEvaluationTelemetry.recordDropped('queue_overflow')
    flagEvaluationTelemetry.recordDropped('queue_overflow')
    flagEvaluationTelemetry.recordDegraded('cardinality_cap', 2)
    flagEvaluationTelemetry.recordContextTruncated('max_context_fields')
    flagEvaluationTelemetry.recordTargetingKeyOmitted()
    flagEvaluationTelemetry.recordHookError()
    flagEvaluationTelemetry.recordPayloadSplit()
    flagEvaluationTelemetry.recordDropped('customer-controlled-reason')
    assert.strictEqual(namespace.count.callCount, 7)
  })
})
