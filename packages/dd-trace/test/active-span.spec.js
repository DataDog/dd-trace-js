'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { storage } = require('../../datadog-core')
const {
  createStoreRetirement,
  enterSpanForRetirement,
  getLiveSpan,
  getRetiredSpanContext,
  kPendingStoreRetirements,
  retirePendingSpans,
} = require('../src/active-span')
const id = require('../src/id')
const SpanContext = require('../src/opentracing/span_context')

require('./setup/core')

const legacyStorage = storage('legacy')

/**
 * @param {import('../src/opentracing/span')} span
 */
function eraseTrace (span) {
  const trace = span.context()._trace
  trace.started = []
  retirePendingSpans(trace, trace[kPendingStoreRetirements])
}

describe('active span retirement', () => {
  let context
  let span
  let tracer

  beforeEach(() => {
    context = {
      _baggageItems: {},
    }
    tracer = {}
    span = {
      _duration: 1,
      context: () => context,
      tracer: () => tracer,
    }
    context._trace = { started: [span] }
  })

  afterEach(() => {
    legacyStorage.enterWith(undefined)
  })

  it('retires every store after the span is processed', () => {
    const retirement = createStoreRetirement()
    const firstStore = enterSpanForRetirement(span, {}, retirement)
    const secondStore = { ...firstStore }
    legacyStorage.enterWith(secondStore)

    retirement.retire()

    assert.strictEqual(getLiveSpan(firstStore), span)
    assert.strictEqual(getLiveSpan(secondStore), span)

    eraseTrace(span)

    assert.strictEqual(getLiveSpan(firstStore), undefined)
    assert.strictEqual(getLiveSpan(secondStore), undefined)
    assert.strictEqual(firstStore.span, secondStore.span)
    assert.strictEqual(firstStore.span.context(), context)
    assert.strictEqual(secondStore.span.context(), context)
  })

  it('preserves an explicitly re-entered span after the retirement boundary', () => {
    const retirement = createStoreRetirement()
    const firstStore = enterSpanForRetirement(span, {}, retirement)

    retirement.retire()
    eraseTrace(span)

    const lateStore = { ...firstStore, span }
    legacyStorage.enterWith(lateStore)

    assert.strictEqual(getLiveSpan(lateStore), span)
  })

  it('returns one retired span facade per context', () => {
    const retirement = createStoreRetirement()
    const store = enterSpanForRetirement(span, {}, retirement)

    retirement.retire()
    eraseTrace(span)

    const retiredSpan = store.span

    assert.strictEqual(store.span, retiredSpan)
    assert.strictEqual(getRetiredSpanContext(retiredSpan), context)
    assert.strictEqual(retiredSpan.context(), context)
    assert.strictEqual(retiredSpan.tracer(), tracer)
    assert.strictEqual(retiredSpan.setTag('late', true), retiredSpan)
    assert.strictEqual(context.late, undefined)
  })

  it('materializes the propagation context only when late work reads it', () => {
    const traceId = id('1234567890abcdef')
    const originalDescriptor = Object.getOwnPropertyDescriptor(SpanContext.prototype, '_traceId')
    let materializations = 0
    Object.defineProperty(SpanContext.prototype, '_traceId', {
      configurable: true,
      get () { return undefined },
      /**
       * @param {unknown} value
       */
      set (value) {
        materializations++
        Object.defineProperty(this, '_traceId', {
          configurable: true,
          value,
          writable: true,
        })
      },
    })

    try {
      context._traceId = traceId
      context._spanId = id('abcdef1234567890')
      context._parentId = null
      context._trace.tags = {}
      const retirement = createStoreRetirement(context)
      const store = enterSpanForRetirement(span, {}, retirement)

      retirement.retire()
      eraseTrace(span)

      assert.strictEqual(materializations, 0)
      store.span.setBaggageItem('first', 'value')
      assert.strictEqual(store.span.getBaggageItem('first'), 'value')
      store.span.removeBaggageItem('first')
      store.span.setBaggageItem('second', 'value')
      store.span.removeAllBaggageItems()
      store.span.setBaggageItem('final', 'value')

      const retiredContext = store.span.context()
      assert.strictEqual(retiredContext._traceId, traceId)
      assert.deepStrictEqual(retiredContext._baggageItems, { final: 'value' })
      assert.strictEqual(materializations, 1)
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(SpanContext.prototype, '_traceId', originalDescriptor)
      } else {
        delete SpanContext.prototype._traceId
      }
    }
  })

  it('preserves baggage on the retired span facade', () => {
    const retirement = createStoreRetirement()
    const store = enterSpanForRetirement(span, {}, retirement)

    retirement.retire()
    eraseTrace(span)

    const retiredSpan = store.span
    retiredSpan.setBaggageItem('key', 'value')

    assert.strictEqual(retiredSpan.getBaggageItem('key'), 'value')
    assert.strictEqual(retiredSpan.getAllBaggageItems(), '{"key":"value"}')

    retiredSpan.removeBaggageItem('key')
    assert.strictEqual(retiredSpan.getBaggageItem('key'), undefined)
  })

  it('retains only propagation state from a supplied parent context', () => {
    const traceId = id('1234567890abcdef')
    const spanId = id('abcdef1234567890')
    const parentId = id('0123456789abcdef')
    const sourceContext = new SpanContext({
      traceId,
      spanId,
      parentId,
      isRemote: false,
      sampling: { priority: 1 },
      baggageItems: { baggage: 'value' },
    })
    sourceContext._traceparent = 'traceparent'
    sourceContext._tracestate = 'tracestate'
    sourceContext._trace.origin = 'synthetics'
    sourceContext._trace.record = true
    sourceContext._trace.isRecording = false
    sourceContext.setTag('request.object', {})
    const retirement = createStoreRetirement(sourceContext)
    const store = enterSpanForRetirement(span, {}, retirement)

    retirement.retire()
    eraseTrace(span)

    const parent = store.span.context()
    assert.notStrictEqual(parent, sourceContext)
    assert.strictEqual(parent._traceId, traceId)
    assert.strictEqual(parent._spanId, spanId)
    assert.strictEqual(parent._parentId, parentId)
    assert.strictEqual(parent._sampling, sourceContext._sampling)
    assert.strictEqual(parent._baggageItems, sourceContext._baggageItems)
    assert.strictEqual(parent._traceparent, 'traceparent')
    assert.strictEqual(parent._tracestate, 'tracestate')
    assert.strictEqual(parent._trace.origin, 'synthetics')
    assert.strictEqual(parent._trace.record, true)
    assert.strictEqual(parent._trace.isRecording, false)
    assert.deepStrictEqual(parent.getTags(), {})
    assert.deepStrictEqual(parent._trace.started, [])
    assert.deepStrictEqual(parent._trace.finished, [])
  })
})
