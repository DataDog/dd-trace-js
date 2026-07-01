'use strict'

/**
 * End-to-end integration tests against the real libdatadog pipeline.
 *
 * These exercise the tracer's full lifecycle (creation, tagging, finishing,
 * parent-child propagation, link/event serialization, and export) against an
 * actual NativeSpansInterface. Unit-level behavior is covered separately in
 * span.spec.js / span_context.spec.js / native_spans.spec.js / exporter.spec.js.
 */

const assert = require('node:assert/strict')
const sinon = require('sinon')

require('../setup/core')

const tags = require('../../../../ext/tags')

const { RESOURCE_NAME, SERVICE_NAME, SPAN_TYPE } = tags

describe('Native Spans Integration', () => {
  let Tracer
  let tracer
  let exportedSpans
  let originalMaxListeners

  before(() => {
    // Each tracer instantiation registers a beforeExit listener inside
    // NativeExporter. setup/core.js caps process.defaultMaxListeners at 6
    // for the leak detector. We need a fresh tracer per test, so allow
    // more listeners just for this suite.
    originalMaxListeners = process.getMaxListeners()
    process.setMaxListeners(0)
  })

  after(() => {
    process.setMaxListeners(originalMaxListeners)
  })

  beforeEach(() => {
    exportedSpans = []

    delete require.cache[require.resolve('../../src/config')]
    delete require.cache[require.resolve('../../src/tracer')]

    const getConfig = require('../../src/config')
    const config = getConfig({ service: 'test-service' })

    Tracer = require('../../src/tracer')
    tracer = new Tracer(config)

    if (tracer._exporter && tracer._exporter.export) {
      sinon.stub(tracer._exporter, 'export').callsFake((spans) => {
        exportedSpans.push(...spans)
      })
    }
  })

  afterEach(() => {
    sinon.restore()
  })

  it('initializes with NativeSpansInterface + NativeExporter wired into the tracer', () => {
    const NativeExporter = require('../../src/exporters/native')
    assert.ok(tracer._nativeSpans, 'tracer should have _nativeSpans')
    assert.ok(tracer._exporter instanceof NativeExporter, 'tracer should use NativeExporter')
  })

  it('runs a full span lifecycle end-to-end (create, tag, link, event, finish, export)', (done) => {
    const linked = tracer.startSpan('linked')
    linked.finish()

    const span = tracer.startSpan('lifecycle', {
      tags: { 'custom.tag': 'custom-value', 'numeric.tag': 42 },
    })
    span.setTag('http.url', 'https://example.com')
    span.addLink({ context: linked.context(), attributes: { reason: 'test' } })
    span.addEvent('event-1', { key: 'value' })

    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait for measurable duration */ }
    span.finish()

    assert.ok(span._duration > 0, 'duration should be positive')
    assert.strictEqual(span.context()._isFinished, true)
    assert.strictEqual(span.context().getTags()['custom.tag'], 'custom-value')
    assert.strictEqual(span.context().getTags()['numeric.tag'], 42)
    assert.strictEqual(span.context().getTags()['http.url'], 'https://example.com')

    const linksTag = JSON.parse(span.context().getTags()['_dd.span_links'])
    assert.strictEqual(linksTag.length, 1)
    const eventsTag = JSON.parse(span.context().getTags()['_dd.span_events'])
    assert.strictEqual(eventsTag.length, 1)
    assert.strictEqual(eventsTag[0].name, 'event-1')

    setTimeout(() => {
      const exported = exportedSpans.find(s => s.context()._name === 'lifecycle')
      assert.ok(exported, 'finished span should reach the exporter')
      done()
    }, 50)
  })

  it('only finishes once (double-finish is a no-op)', () => {
    const span = tracer.startSpan('double-finish')
    const processSpy = sinon.spy(tracer._processor, 'process')

    span.finish()
    span.finish()

    assert.strictEqual(processSpy.callCount, 1, 'processor.process should be called once')
  })

  it('propagates parent → child via tracer.trace under an active scope and exports both', (done) => {
    const parent = tracer.startSpan('parent')

    tracer.scope().activate(parent, () => {
      tracer.trace('child', {}, (child) => {
        assert.strictEqual(
          child.context()._parentId.toString(),
          parent.context()._spanId.toString(),
          'child._parentId should be the active parent span'
        )
        assert.strictEqual(
          child.context()._trace,
          parent.context()._trace,
          'parent and child share the trace object'
        )
      })
    })

    parent.finish()

    setTimeout(() => {
      const parentExport = exportedSpans.find(s => s.context()._name === 'parent')
      const childExport = exportedSpans.find(s => s.context()._name === 'child')
      assert.ok(parentExport, 'parent should be exported')
      assert.ok(childExport, 'child should be exported')
      done()
    }, 50)
  })

  it('applies service/resource/type via tracer.trace options', () => {
    tracer.trace('typed', { service: 'svc', resource: 'GET /x', type: 'web' }, (span) => {
      assert.strictEqual(span.context().getTags()[SERVICE_NAME], 'svc')
      assert.strictEqual(span.context().getTags()[RESOURCE_NAME], 'GET /x')
      assert.strictEqual(span.context().getTags()[SPAN_TYPE], 'web')
    })
  })

  it('propagates errors thrown inside tracer.trace callbacks', () => {
    const error = new Error('test')
    assert.throws(() => tracer.trace('erroring', {}, () => { throw error }), /^Error: test$/)
  })

  it('round-trips trace context through inject + extract', () => {
    const span = tracer.startSpan('inject-source')
    const carrier = {}

    tracer.inject(span.context(), 'text_map', carrier)
    const extracted = tracer.extract('text_map', carrier)

    assert.ok(extracted, 'should extract a context')
    assert.strictEqual(
      extracted._traceId.toString(),
      span.context()._traceId.toString(),
      'extracted traceId should match injected'
    )

    span.finish()
  })
})
