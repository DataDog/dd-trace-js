'use strict'

require('../setup/core')

const assert = require('node:assert/strict')

// Both flags are read once, at construction: the tracer picks its span implementation
// from `DD_TRACE_EXPERIMENTAL_NATIVE_SPANS`, and the addon reads its stage switches
// when it loads. `FLUSH=0` keeps the suite from PUTting to an agent that is not there;
// every earlier stage still runs.
process.env.DD_TRACE_EXPERIMENTAL_NATIVE_SPANS = '1'
process.env.DD_NATIVE_SPANS_FLUSH = '0'

const getConfig = require('../../src/config')
const DatadogTracer = require('../../src/opentracing/tracer')
const NativeSpanContext = require('../../src/native-spans/span_context')

// Blackbox against the real construction path: a real `DatadogTracer` with the flag
// on, so `startSpan` returns whatever the flag actually selects. What reaches the
// agent is covered end to end by `benchmark/sirun/native-spans/parity.js`; this suite
// pins the public surface a caller above the construction point can rely on.
describe('native-spans span', () => {
  let tracer

  before(() => {
    tracer = new DatadogTracer(getConfig({
      service: 'native-spans-test',
      env: 'test',
      version: '1.2.3',
    }))

    assert.strictEqual(
      tracer._Span,
      require('../../src/native-spans/span'),
      'the flag did not select the native implementation'
    )
  })

  /**
   * @param {string} [name]
   * @param {object} [options]
   * @returns {object} A started span from the real tracer path.
   */
  function startSpan (name = 'test.span', options) {
    return tracer.startSpan(name, options)
  }

  describe('construction', () => {
    it('is recognised as a span by the tracer\'s own instanceof checks', () => {
      const span = startSpan()

      // `tracer.inject` and `getContext` both gate on `instanceof Span`; failing this
      // silently turns every parent lookup into a new root.
      assert.ok(span instanceof require('../../src/opentracing/span'))
      span.finish()
    })

    it('produces a context recognised as a span context', () => {
      const span = startSpan()

      assert.ok(span.context() instanceof require('../../src/opentracing/span_context'))
      assert.ok(span.context() instanceof NativeSpanContext)
      span.finish()
    })

    it('roots a new segment at itself', () => {
      const span = startSpan()
      const context = span.context()

      assert.strictEqual(context._segmentId, context._spanId)
      assert.strictEqual(context._parentId.toString(10), '0')
      span.finish()
    })

    it('puts the root span id in the low half of the trace id', () => {
      const context = startSpan().context()

      assert.strictEqual(context._traceId.hi, context._spanId.hi)
      assert.strictEqual(context._traceId.lo, context._spanId.lo)
    })

    it('keeps a child in its parent\'s segment and trace', () => {
      const parent = startSpan('parent')
      const child = startSpan('child', { childOf: parent })

      assert.strictEqual(child.context()._segmentId, parent.context()._segmentId)
      assert.strictEqual(child.context()._traceId, parent.context()._traceId)
      assert.strictEqual(child.context()._parentId, parent.context()._spanId)
      assert.notStrictEqual(child.context()._spanId, parent.context()._spanId)
    })

    it('gives a grandchild the same segment as the root', () => {
      const root = startSpan('root')
      const child = startSpan('child', { childOf: root })
      const grandchild = startSpan('grandchild', { childOf: child })

      assert.strictEqual(grandchild.context()._segmentId, root.context()._spanId)
      assert.strictEqual(grandchild.context()._parentId, child.context()._spanId)
    })

    it('keeps exactly the four ids on the context and nothing else', () => {
      const context = startSpan().context()

      assert.deepStrictEqual(Object.keys(context), ['_traceId', '_segmentId', '_spanId', '_parentId'])
    })

    it('exposes the tracer that created it', () => {
      assert.strictEqual(startSpan().tracer(), tracer)
    })
  })

  describe('ids', () => {
    it('renders a 128-bit trace id as 32 hex characters', () => {
      const context = startSpan().context()

      assert.match(context.toTraceId(true), /^[\da-f]{32}$/)
    })

    it('renders a 64-bit trace id as decimal', () => {
      const context = startSpan().context()

      assert.strictEqual(context.toTraceId(), context._traceId.toString(10))
      assert.match(context.toTraceId(), /^\d+$/)
    })

    it('renders span ids in both forms', () => {
      const context = startSpan().context()

      assert.match(context.toSpanId(true), /^[\da-f]{16}$/)
      assert.match(context.toSpanId(), /^\d+$/)
      assert.strictEqual(context.toBigIntSpanId(), context._spanId.toBigInt())
    })

    it('builds a traceparent from the same ids', () => {
      const context = startSpan().context()

      assert.strictEqual(
        context.toTraceparent(),
        `00-${context.toTraceId(true)}-${context.toSpanId(true)}-01`
      )
    })
  })

  describe('tags', () => {
    it('accepts every scalar shape without throwing', () => {
      const span = startSpan()

      span.setTag('string', 'value')
      span.setTag('number', 1.5)
      span.setTag('boolean-true', true)
      span.setTag('boolean-false', false)
      span.setTag('undefined', undefined)
      span.setTag('null', null)
      span.setTag('object', { toString: () => 'stringified' })
      span.setTag('nan', Number.NaN)
      span.finish()
    })

    it('accepts an Error under the error key', () => {
      const span = startSpan()

      span.setTag('error', new Error('boom'))
      span.finish()
    })

    it('accepts an error with a code but no message', () => {
      const span = startSpan()
      const error = Object.assign(new Error(''), { code: 'ERR_SOMETHING' })

      span.setTag('error', error)
      span.finish()
    })

    it('returns itself from setTag and addTags', () => {
      const span = startSpan()

      assert.strictEqual(span.setTag('a', 'b'), span)
      assert.strictEqual(span.addTags({ c: 'd' }), span)
    })

    it('ignores the shapes addTags does not accept', () => {
      const span = startSpan()

      assert.strictEqual(span.addTags(undefined), span)
      assert.strictEqual(span.addTags(null), span)
      assert.strictEqual(span.addTags('key:value'), span)
      assert.strictEqual(span.addTags(['key:value']), span)
    })

    it('reads back nothing, since no tag map is kept', () => {
      const span = startSpan()
      span.setTag('present', 'value')

      assert.strictEqual(span.context().getTag('present'), undefined)
      assert.strictEqual(span.context().hasTag('present'), false)
      assert.deepStrictEqual(span.context().getTags(), {})
    })

    it('accepts the tag mutators that have nothing to mutate', () => {
      const context = startSpan().context()

      context.deleteTag('anything')
      context.clearTags()
      assert.deepStrictEqual(context.getTags(), {})
    })
  })

  describe('baggage', () => {
    it('is a silent no-op in both directions', () => {
      const span = startSpan()

      assert.strictEqual(span.setBaggageItem('key', 'value'), span)
      assert.strictEqual(span.getBaggageItem('key'), undefined)
      assert.strictEqual(span.getAllBaggageItems(), '{}')
      assert.strictEqual(span.removeBaggageItem('key'), undefined)
      assert.strictEqual(span.removeAllBaggageItems(), undefined)
    })
  })

  describe('links and events', () => {
    it('links to another span', () => {
      const span = startSpan()
      const target = startSpan('target')

      span.addLink({ context: target.context(), attributes: { reason: 'test' } })
      span.finish()
    })

    it('links without attributes', () => {
      const span = startSpan()

      span.addLink({ context: startSpan('target').context() })
      span.finish()
    })

    it('drops link attributes that are not scalars or arrays of scalars', () => {
      const span = startSpan()

      span.addLink({
        context: startSpan('target').context(),
        attributes: { kept: 'yes', alsoKept: [1, 'two', true], dropped: { nested: true } },
      })
      span.finish()
    })

    it('returns itself from addLinks', () => {
      const span = startSpan()

      assert.strictEqual(span.addLinks([{ context: startSpan('target').context() }]), span)
    })

    it('adds a span pointer through the link path', () => {
      const span = startSpan()

      span.addSpanPointer('aws.s3.object', 'upstream', 'hash-value')
      span.finish()
    })

    it('adds an event with attributes, with a time, and with neither', () => {
      const span = startSpan()

      span.addEvent('with-attributes', { attempt: 1, ok: true })
      span.addEvent('with-time', 1_786_060_800_000)
      span.addEvent('bare')
      span.finish()
    })
  })

  describe('finish', () => {
    it('is idempotent', () => {
      const span = startSpan()

      span.finish()
      span.finish()
    })

    it('accepts an explicit finish time', () => {
      const span = startSpan()

      span.finish(Date.now() + 5)
    })

    it('falls back to now for an unparseable finish time', () => {
      const span = startSpan()

      span.finish('not a number')
    })
  })

  describe('inert methods', () => {
    it('keeps the OpenTracing log surface', () => {
      const span = startSpan()

      assert.strictEqual(span.log(), span)
      assert.strictEqual(span.logEvent(), undefined)
    })

    it('renames the operation', () => {
      const span = startSpan()

      assert.strictEqual(span.setOperationName('renamed'), span)
      span.finish()
    })

    it('describes itself with its ids', () => {
      const span = startSpan()
      const description = span.toString()

      assert.match(description, /^NativeSpan\{/)
      assert.ok(description.includes(span.context().toTraceId(true)))
    })

    it('inspects without reaching into private state', () => {
      const inspected = require('node:util').inspect(startSpan())

      assert.ok(inspected.includes('DatadogTracer'))
    })
  })
})
