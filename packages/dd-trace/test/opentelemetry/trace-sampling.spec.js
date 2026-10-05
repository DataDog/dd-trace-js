'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const { TEXT_MAP } = require('../../../../ext/formats')
const { getConfigFresh } = require('../helpers/config')
const OtlpHttpTraceExporter = require('../../src/opentelemetry/trace/otlp_http_trace_exporter')
const TraceState = require('../../src/opentracing/propagation/tracestate')
const otelSampling = require('../../src/otel-sampling')

describe('OTLP consistent probability sampling', () => {
  let config
  let Tracer
  let sendPayload

  afterEach(() => sinon.restore())

  beforeEach(() => {
    sinon.useFakeTimers()
    config = getConfigFresh()
    config.OTEL_TRACES_EXPORTER = 'otlp'
    config.OTEL_TRACES_SPAN_METRICS_ENABLED = false
    config.stats.DD_TRACE_STATS_COMPUTATION_ENABLED = false
    config.tracePropagationStyle = { inject: ['tracecontext'], extract: ['datadog', 'tracecontext'] }
    config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = 'continue'
    config.sampler = { sampleRate: 0.1 }

    const exporter = new OtlpHttpTraceExporter('http://localhost:4318/v1/traces', {}, 1000, {}, false)
    // @ts-expect-error - Stub the protected transport boundary; sampling, formatting and serialization remain real.
    sendPayload = sinon.stub(exporter, 'sendPayload')
    Tracer = proxyquire('../../src/opentracing/tracer', {
      '../opentelemetry/trace': { createOtlpTraceExporter: () => exporter },
    })
  })

  /** @param {number} [call] */
  function exportedSpans (call = 0) {
    assert.ok(sendPayload.callCount > call, 'expected an OTLP payload')
    return JSON.parse(sendPayload.getCall(call).args[0]).resourceSpans[0].scopeSpans[0].spans
  }

  /**
   * @param {import('../../src/opentracing/tracer')} tracer
   * @param {string} [traceId]
   */
  function undecidedParent (tracer, traceId = '18444899399302180863') {
    return tracer.extract(TEXT_MAP, {
      'x-datadog-trace-id': traceId,
      'x-datadog-parent-id': '1',
    })
  }

  /**
   * @param {import('../../src/opentracing/tracer')} tracer
   * @param {string} [tracestate]
   */
  function sampledParent (tracer, tracestate) {
    return tracer.extract(TEXT_MAP, {
      traceparent: '00-1111111111111111fff972474538efff-0000000000000001-01',
      tracestate,
    })
  }

  for (const [source, sampler, threshold] of [
    ['rule', { sampleRate: 0.1 }, 'e6666666666668'],
    ['agent fallback', {}, '0'],
  ]) {
    it(`exports a ${source} probability decision on every span without injecting`, () => {
      config.sampler = sampler
      const tracer = new Tracer(config)
      const root = tracer.startSpan('root', { childOf: undecidedParent(tracer) })
      const child = tracer.startSpan('child', { childOf: root })

      child.finish()
      root.finish()

      const spans = exportedSpans()
      assert.strictEqual(spans.length, 2)
      for (const span of spans) {
        assert.strictEqual(span.flags, 1)
        const state = TraceState.fromString(span.traceState)
        assert.strictEqual(state.get('ot'), `rv:ef284ace7a91e1;th:${threshold}`)
        assert.strictEqual(state.get('dd'), undefined)
      }
    })
  }

  it('exports the corrected random value at the 56-bit keep boundary', () => {
    const tracer = new Tracer(config)
    tracer.startSpan('boundary', { childOf: undecidedParent(tracer, '263811222310854400') }).finish()

    const [span] = exportedSpans()
    assert.strictEqual(TraceState.fromString(span.traceState).get('ot'), 'rv:e6666666666668;th:e6666666666668')
    assert.strictEqual(span.flags, 1)
  })

  it('exports the same sampling fields as propagation across partial flushes', () => {
    config.flushMinSpans = 1
    const tracer = new Tracer(config)
    const root = tracer.startSpan('root', { childOf: undecidedParent(tracer) })
    const child = tracer.startSpan('child', { childOf: root })
    const carrier = {}
    tracer.inject(child, TEXT_MAP, carrier)

    child.finish()
    root.finish()

    assert.strictEqual(sendPayload.callCount, 2)
    const expected = TraceState.fromString(carrier.tracestate).get('ot')
    for (const span of [...exportedSpans(0), ...exportedSpans(1)]) {
      assert.strictEqual(TraceState.fromString(span.traceState).get('ot'), expected)
      assert.strictEqual(span.flags, 1)
    }
  })

  for (const ot of [undefined, 'foo:bar', 'th:8', 'rv:ef284ace7a91e1', 'th:e6666666666668;foo:bar;rv:ef284ace7a91e1']) {
    it(`preserves an inherited decision with ot=${ot}`, () => {
      config.sampler = { sampleRate: 0 }
      const tracer = new Tracer(config)
      const inherited = 'dd=s:2;p:0000000000000001,congo=value'
      const parent = sampledParent(tracer, ot ? `${inherited},ot=${ot}` : inherited)
      tracer.startSpan('inherited', { childOf: parent }).finish()

      const [span] = exportedSpans()
      const state = TraceState.fromString(span.traceState)
      assert.strictEqual(state.get('ot'), ot)
      assert.strictEqual(state.get('congo'), 'value')
      assert.strictEqual(state.get('dd'), 's:2;p:0000000000000001')
      assert.strictEqual(span.flags, 1)
    })
  }

  it('exports normalized inherited sampling fields', () => {
    const tracer = new Tracer(config)
    const parent = sampledParent(tracer, 'ot=rv:ef284ace7a91e1;th:invalid;foo:bar')
    tracer.startSpan('normalized', { childOf: parent }).finish()

    assert.strictEqual(TraceState.fromString(exportedSpans()[0].traceState).get('ot'), 'rv:ef284ace7a91e1;foo:bar')
  })

  for (const inherited of [false, true]) {
    it(`builds sampling state once per chunk (${inherited ? 'inherited' : 'local'})`, () => {
      config.sampler = { sampleRate: 1 }
      const tracer = new Tracer(config)
      const original = 'ot=rv:ef284ace7a91e1;th:8,congo=value'
      const parent = inherited ? sampledParent(tracer, original) : undecidedParent(tracer)
      const update = sinon.spy(otelSampling, 'updateOtelTraceState')
      const root = tracer.startSpan('root', { childOf: parent })
      for (let index = 0; index < 2; index++) {
        tracer.startSpan('child', { childOf: root }).finish()
      }

      sinon.assert.notCalled(update)
      root.finish()

      sinon.assert.calledOnce(update)
      const spans = exportedSpans()
      assert.strictEqual(spans.length, 3)
      for (const span of spans) {
        const state = TraceState.fromString(span.traceState)
        assert.strictEqual(state.get('ot'), inherited ? 'rv:ef284ace7a91e1;th:8' : 'rv:ef284ace7a91e1;th:0')
        assert.strictEqual(state.get('congo'), inherited ? 'value' : undefined)
        assert.strictEqual(span.flags, 1)
      }
      assert.strictEqual(parent._tracestate?.toString(), inherited ? original : undefined)
    })

    it(`updates sampling state after a partial flush (${inherited ? 'inherited' : 'local'})`, () => {
      config.flushMinSpans = 1
      config.sampler = { sampleRate: 1 }
      const tracer = new Tracer(config)
      const original = 'ot=rv:ef284ace7a91e1;th:8,congo=value'
      const parent = inherited ? sampledParent(tracer, original) : undecidedParent(tracer)
      const update = sinon.spy(otelSampling, 'updateOtelTraceState')
      const root = tracer.startSpan('root', { childOf: parent })
      tracer.startSpan('child', { childOf: root }).finish()

      sinon.assert.calledOnce(update)
      assert.strictEqual(TraceState.fromString(exportedSpans()[0].traceState).get('ot'),
        inherited ? 'rv:ef284ace7a91e1;th:8' : 'rv:ef284ace7a91e1;th:0')
      root.setTag('manual.keep', true)
      root.finish()

      sinon.assert.calledTwice(update)
      const [span] = exportedSpans(1)
      const state = TraceState.fromString(span.traceState)
      assert.strictEqual(state.get('ot'), inherited ? 'rv:ef284ace7a91e1' : undefined)
      assert.strictEqual(state.get('congo'), inherited ? 'value' : undefined)
      assert.strictEqual(span.flags, 1)
      assert.strictEqual(parent._tracestate?.toString(), inherited ? original : undefined)
    })

    it(`does not export a threshold for a manual keep (${inherited ? 'inherited' : 'local'})`, () => {
      const tracer = new Tracer(config)
      const parent = inherited ? sampledParent(tracer, 'ot=rv:ef284ace7a91e1;th:8') : undefined
      const root = tracer.startSpan('manual', { childOf: parent })
      root.setTag('manual.keep', true)
      root.finish()

      const [span] = exportedSpans()
      assert.strictEqual(TraceState.fromString(span.traceState).get('ot'), inherited ? 'rv:ef284ace7a91e1' : undefined)
      assert.strictEqual(span.flags, 1)
    })
  }

  for (const behavior of ['restart', 'ignore']) {
    it(`generates a new sampling decision after ${behavior}`, () => {
      config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = behavior
      config.sampler = { sampleRate: 1 }
      const tracer = new Tracer(config)
      const parent = sampledParent(tracer, 'ot=rv:ef284ace7a91e1;th:8')
      tracer.startSpan('new-trace', { childOf: parent }).finish()

      const [span] = exportedSpans()
      assert.notStrictEqual(span.traceId, '1111111111111111fff972474538efff')
      assert.match(TraceState.fromString(span.traceState).get('ot'), /^rv:[0-9a-f]{14};th:0$/)
      assert.strictEqual(span.flags, 1)
    })
  }

  it('builds empty sampling state once for a manually kept chunk', () => {
    const tracer = new Tracer(config)
    const update = sinon.spy(otelSampling, 'updateOtelTraceState')
    const root = tracer.startSpan('manual')
    root.setTag('manual.keep', true)
    for (let index = 0; index < 2; index++) {
      tracer.startSpan('child', { childOf: root }).finish()
    }
    root.finish()

    sinon.assert.calledOnce(update)
    const spans = exportedSpans()
    assert.strictEqual(spans.length, 3)
    for (const span of spans) {
      assert.strictEqual(TraceState.fromString(span.traceState).size, 0)
      assert.strictEqual(span.flags, 1)
    }
  })

  for (const [sampler, traceId] of [
    [{ sampleRate: 0 }, undefined],
    [{ sampleRate: 1, rateLimit: 0 }, undefined],
    [{ sampleRate: 0.1 }, '2'],
  ]) {
    it(`does not export a rejected trace with ${JSON.stringify(sampler)}`, () => {
      config.sampler = sampler
      const tracer = new Tracer(config)
      const update = sinon.spy(otelSampling, 'updateOtelTraceState')
      tracer.startSpan('rejected', { childOf: undecidedParent(tracer, traceId) }).finish()

      sinon.assert.notCalled(update)
      sinon.assert.notCalled(sendPayload)
    })
  }
})
