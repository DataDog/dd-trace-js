'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')

require('../../setup/core')
const { AUTO_KEEP, USER_KEEP, USER_REJECT } = require('../../../../../ext/priority')
const getConfig = require('../../../src/config')
const id = require('../../../src/id')
const Span = require('../../../src/opentracing/span')
const SpanContext = require('../../../src/opentracing/span_context')
const TextMapPropagator = require('../../../src/opentracing/propagation/text_map')
const TraceState = require('../../../src/opentracing/propagation/tracestate')
const PrioritySampler = require('../../../src/priority_sampler')
const { ASM } = require('../../../src/standalone/product')

describe('OpenTelemetry consistent probability sampling propagation', () => {
  let config
  let propagator

  beforeEach(() => {
    config = getConfig()
    config.tracePropagationStyle = {
      extract: ['tracecontext'],
      inject: ['tracecontext'],
    }
    config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = 'continue'
    propagator = new TextMapPropagator(config)
  })

  describe('local probability decisions', () => {
    const vectors = [
      [0.01, 'fd70a3d70a3d7', false],
      [0.1, 'e6666666666668', true],
      [0.2, 'ccccccccccccd', true],
      [0.5, '8', true],
      [0.99, '028f5c28f5c29', true],
    ]

    for (const [sampleRate, expectedThreshold, expectedKept] of vectors) {
      it(`emits the golden vector for rate ${sampleRate}`, () => {
        const { carrier, context } = sampleAndInject({ traceId: '1', sampleRate })

        assert.deepStrictEqual(parseOtel(carrier.tracestate), {
          rv: 'f0948a54d43b8e',
          th: expectedThreshold,
        })
        assert.strictEqual(context._sampling.priority >= AUTO_KEEP, expectedKept)
      })
    }

    it('emits the RFC worked example', () => {
      const { carrier } = sampleAndInject({
        traceId: '18444899399302180863',
        sampleRate: 0.1,
      })

      assert.deepStrictEqual(parseOtel(carrier.tracestate), {
        rv: 'ef284ace7a91e1',
        th: 'e6666666666668',
      })
    })

    it('adjusts rv up when 56-bit precision would reverse a keep', () => {
      const { carrier, context } = sampleAndInject({
        traceId: '263811222310854400',
        sampleRate: 0.1,
      })

      assert.deepStrictEqual(parseOtel(carrier.tracestate), {
        rv: 'e6666666666668',
        th: 'e6666666666668',
      })
      assert.strictEqual(context._sampling.priority, USER_KEEP)
    })

    it('adjusts rv down when 56-bit precision would reverse a drop', () => {
      const { carrier, context } = sampleAndInject({
        traceId: '5401449561355763072',
        sampleRate: 0.05,
      })

      assert.deepStrictEqual(parseOtel(carrier.tracestate), {
        rv: 'f333333333332f',
        th: 'f333333333333',
      })
      assert.strictEqual(context._sampling.priority, USER_REJECT)
    })

    it('emits a probability decision for the default agent rate', () => {
      const { carrier, context } = sampleAndInject({ traceId: '1' })

      assert.deepStrictEqual(parseOtel(carrier.tracestate), {
        rv: 'f0948a54d43b8e',
        th: '0',
      })
      assert.strictEqual(context._sampling.priority, AUTO_KEEP)
    })
  })

  describe('inherited decisions', () => {
    it('forwards rv, th, unknown OTel fields, and unrelated vendors with dd and ot leftmost', () => {
      const parent = extractParent({
        sampled: true,
        tracestate: 'congo=t61rcWkgMzE,ot=th:e6666666666668;foo:bar;rv:ef284ace7a91e1,dd=s:2;t.dm:-3',
      })
      const { span, prioritySampler } = startSpan({ parent, sampleRate: 0 })
      const carrier = inject(span, prioritySampler)
      const members = carrier.tracestate.split(',')

      assert.match(members[0], /^dd=/)
      assert.strictEqual(members[1], 'ot=th:e6666666666668;foo:bar;rv:ef284ace7a91e1')
      assert.strictEqual(parseTracestate(carrier.tracestate).congo, 't61rcWkgMzE')
      assert.strictEqual(span.context()._sampling.priority, USER_KEEP)
    })

    for (const sampled of [false, true]) {
      it(`forwards a th-only ${sampled ? 'keep' : 'drop'} without fabricating rv`, () => {
        const parent = extractParent({ sampled, tracestate: 'ot=th:e6666666666668' })
        const { span, prioritySampler } = startSpan({ parent, sampleRate: 0.5 })
        const carrier = inject(span, prioritySampler)

        assert.deepStrictEqual(parseOtel(carrier.tracestate), { th: 'e6666666666668' })
      })
    }

    for (const [source, sampleRate] of [['rule-based', 0.1], ['agent-based', undefined]]) {
      it(`does not fabricate fields after probing ${source} sampling on a sampled trace without ot`, () => {
        const parent = extractParent({ sampled: true, tracestate: 'dd=s:1' })
        const { span, prioritySampler } = startSpan({ parent, sampleRate })

        prioritySampler.isSampled(span)
        const carrier = inject(span, prioritySampler)

        assert.strictEqual(parseTracestate(carrier.tracestate).ot, undefined)
      })
    }

    it('preserves an unknown-only ot member without fabricating sampling fields', () => {
      const parent = extractParent({ sampled: true, tracestate: 'ot=foo:bar' })
      const { span, prioritySampler } = startSpan({ parent, sampleRate: 0.1 })
      const carrier = inject(span, prioritySampler)

      assert.deepStrictEqual(parseOtel(carrier.tracestate), { foo: 'bar' })
    })

    it('forwards malformed inherited rv and th unchanged', () => {
      const malformedBoth = extractParent({
        sampled: true,
        tracestate: 'dd=s:1,ot=rv:not-hex;th:not-hex,congo=value',
      })
      const first = startSpan({ parent: malformedBoth, sampleRate: 0.1 })
      const firstCarrier = inject(first.span, first.prioritySampler)

      assert.strictEqual(parseTracestate(firstCarrier.tracestate).ot, 'rv:not-hex;th:not-hex')
      assert.strictEqual(parseTracestate(firstCarrier.tracestate).congo, 'value')

      const malformedThreshold = extractParent({
        sampled: true,
        tracestate: 'ot=rv:1234567890abcd;th:not-hex',
      })
      const second = startSpan({ parent: malformedThreshold, sampleRate: 0.1 })
      const secondCarrier = inject(second.span, second.prioritySampler)

      assert.strictEqual(parseTracestate(secondCarrier.tracestate).ot, 'rv:1234567890abcd;th:not-hex')
    })
  })

  describe('non-probability decisions', () => {
    it('clears an inherited th and forwards rv when a manual tag overrides an upstream drop', () => {
      const parent = extractParent({
        sampled: false,
        traceId: '10',
        tracestate: 'ot=rv:65cd67504a538e;th:e6666666666668',
      })
      const { span, prioritySampler } = startSpan({ parent, sampleRate: 0.1 })

      span.setTag('manual.keep', true)
      const carrier = inject(span, prioritySampler)

      assert.deepStrictEqual(parseOtel(carrier.tracestate), { rv: '65cd67504a538e' })
      assert.strictEqual(span.context()._sampling.priority, USER_KEEP)
    })

    it('does not create ot fields for a local force-keep', () => {
      const { span, prioritySampler } = startSpan({ traceId: '1', sampleRate: 0.1 })

      prioritySampler.setPriority(span, USER_KEEP, ASM)
      const carrier = inject(span, prioritySampler)

      assert.strictEqual(parseTracestate(carrier.tracestate).ot, undefined)
    })

    it('does not create ot fields when a limiter turns a probability keep into a drop', () => {
      const { carrier, context } = sampleAndInject({ traceId: '1', sampleRate: 1, rateLimit: 0 })

      assert.strictEqual(parseTracestate(carrier.tracestate).ot, undefined)
      assert.strictEqual(context._sampling.priority, USER_REJECT)
    })

    it('keeps probability fields when the probability decision itself drops', () => {
      const { carrier, context } = sampleAndInject({ traceId: '1', sampleRate: 0, rateLimit: 0 })

      assert.deepStrictEqual(parseOtel(carrier.tracestate), {
        rv: 'f0948a54d43b8e',
        th: 'ffffffffffffff',
      })
      assert.strictEqual(context._sampling.priority, USER_REJECT)
    })
  })

  describe('limits and extraction behavior', () => {
    it('retains dd and ot as the first two of 32 members', () => {
      const tracestate = Array.from({ length: 32 }, (_, index) => `v${index}=x`).join(',')
      const { span, prioritySampler } = startSpan({ traceId: '1', sampleRate: 0.1 })
      span.context()._tracestate = TraceState.fromString(tracestate)

      const members = inject(span, prioritySampler).tracestate.split(',')

      assert.strictEqual(members.length, 32)
      assert.match(members[0], /^dd=/)
      assert.match(members[1], /^ot=/)
      assert.strictEqual(members[31], 'v29=x')
      assert.ok(!members.includes('v30=x'))
    })

    it('keeps complete OTel sub-fields within the 256-byte value cap', () => {
      const oversized = 'future:' + 'x'.repeat(220)
      const { span, prioritySampler } = startSpan({ traceId: '1', sampleRate: 0.1 })
      span.context()._tracestate = TraceState.fromString(`ot=${oversized};next:value`)

      const value = parseTracestate(inject(span, prioritySampler).tracestate).ot

      assert.ok(Buffer.byteLength(value) <= 256)
      assert.deepStrictEqual(parseOtelValue(value), {
        rv: 'f0948a54d43b8e',
        th: 'e6666666666668',
        next: 'value',
      })
    })

    for (const behavior of ['ignore', 'restart']) {
      it(`ignores inbound ot fields and creates a new decision with ${behavior}`, () => {
        config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = behavior
        const parent = extractParent({
          sampled: true,
          tracestate: 'ot=rv:1234567890abcd;th:8',
        })
        const { span, prioritySampler } = startSpan({ parent, sampleRate: 0.1 })
        const fields = parseOtel(inject(span, prioritySampler).tracestate)

        assert.strictEqual(fields.th, 'e6666666666668')
        assert.notStrictEqual(fields.rv, '1234567890abcd')
      })
    }
  })

  /**
   * Starts a real span and priority sampler, optionally continuing a remote context.
   *
   * @param {object} options
   * @param {string} [options.traceId]
   * @param {number} [options.sampleRate]
   * @param {number} [options.rateLimit]
   * @param {SpanContext} [options.parent]
   * @returns {{ span: Span, prioritySampler: PrioritySampler }}
   */
  function startSpan ({ traceId = '1', sampleRate, rateLimit = -1, parent } = {}) {
    const samplingConfig = { rateLimit }
    if (sampleRate !== undefined) samplingConfig.sampleRate = sampleRate
    const prioritySampler = new PrioritySampler('test', samplingConfig)
    parent ??= new SpanContext({
      traceId: id(traceId, 10),
      spanId: id('1', 10),
      isRemote: false,
    })
    const span = new Span(
      { _config: config, _service: 'test' },
      { process () {} },
      prioritySampler,
      { operationName: 'test', parent }
    )
    span.context().setTag('service.name', 'test')
    return { span, prioritySampler }
  }

  /**
   * Samples and injects a locally started trace.
   *
   * @param {object} options
   * @param {string} options.traceId
   * @param {number} [options.sampleRate]
   * @param {number} [options.rateLimit]
   * @returns {{ carrier: Record<string, string>, context: SpanContext }}
   */
  function sampleAndInject (options) {
    const { span, prioritySampler } = startSpan(options)
    return {
      carrier: inject(span, prioritySampler),
      context: span.context(),
    }
  }

  /**
   * Applies priority sampling and injects tracecontext headers.
   *
   * @param {Span} span
   * @param {PrioritySampler} prioritySampler
   * @returns {Record<string, string>}
   */
  function inject (span, prioritySampler) {
    prioritySampler.sample(span)
    return propagator.inject(span.context(), {})
  }

  /**
   * Extracts a remote W3C parent context.
   *
   * @param {object} options
   * @param {boolean} options.sampled
   * @param {string} options.tracestate
   * @param {string} [options.traceId]
   * @returns {SpanContext}
   */
  function extractParent ({ sampled, tracestate, traceId = '18444899399302180863' }) {
    const traceIdHex = BigInt(traceId).toString(16).padStart(32, '0')
    return propagator.extract({
      traceparent: `00-${traceIdHex}-0000000000000001-${sampled ? '01' : '00'}`,
      tracestate,
    })
  }
})

/**
 * Parses tracestate members by vendor.
 *
 * @param {string} tracestate
 * @returns {Record<string, string>}
 */
function parseTracestate (tracestate) {
  const result = {}
  for (const member of tracestate.split(',')) {
    const separator = member.indexOf('=')
    result[member.slice(0, separator)] = member.slice(separator + 1)
  }
  return result
}

/**
 * Parses an OTel member from tracestate.
 *
 * @param {string} tracestate
 * @returns {Record<string, string>}
 */
function parseOtel (tracestate) {
  return parseOtelValue(parseTracestate(tracestate).ot)
}

/**
 * Parses OTel sub-fields.
 *
 * @param {string | undefined} value
 * @returns {Record<string, string>}
 */
function parseOtelValue (value) {
  const result = {}
  if (value === undefined) return result
  for (const field of value.split(';')) {
    const separator = field.indexOf(':')
    if (separator !== -1) result[field.slice(0, separator)] = field.slice(separator + 1)
  }
  return result
}
