'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')

require('../setup/core')

const FakeAgent = require('../../../../integration-tests/helpers/fake-agent')
const tags = require('../../../../ext/tags')

const { RESOURCE_NAME, SERVICE_NAME, SPAN_TYPE } = tags

describe('Native Spans Integration', () => {
  let beforeExitHandlers
  let handlersBefore
  let agent
  let sentTraces
  let tracer

  beforeEach(async () => {
    beforeExitHandlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
    handlersBefore = new Set(beforeExitHandlers)
    sentTraces = []
    agent = await new FakeAgent().start()
    agent.on('message', ({ payload }) => sentTraces.push(...payload))

    process.env.DD_TRACE_NATIVE_SPAN_EVENTS = 'true'
    delete require.cache[require.resolve('../../src/config')]
    delete require.cache[require.resolve('../../src/tracer')]

    const getConfig = require('../../src/config')
    const config = getConfig({
      flushInterval: 60_000,
      hostname: '127.0.0.1',
      port: agent.port,
      service: 'test-service',
    })
    const Tracer = require('../../src/tracer')
    tracer = new Tracer(config)
  })

  afterEach(async () => {
    delete process.env.DD_TRACE_NATIVE_SPAN_EVENTS
    for (const handler of beforeExitHandlers) {
      if (!handlersBefore.has(handler)) beforeExitHandlers.delete(handler)
    }
    sinon.restore()
    await agent.stop()
  })

  function materialize () {
    return new Promise((resolve) => tracer._exporter.flush(resolve))
  }

  /**
   * @param {string} name Span name
   * @returns {object|undefined}
   */
  function findSpan (name) {
    for (const trace of sentTraces) {
      const span = trace.find(span => span.name === name)
      if (span) return span
    }
  }

  it('wires one JS span model through the native exporter', () => {
    const NativeExporter = require('../../src/exporters/native')
    const DatadogSpan = require('../../src/opentracing/span')

    const span = tracer.startSpan('request')

    assert.ok(span instanceof DatadogSpan)
    assert.ok(tracer._exporter instanceof NativeExporter)
    assert.strictEqual(span.context()._nativeSpanId, undefined)
  })

  it('encodes finalized tags, links, events, and meta_struct for the binding', async () => {
    const linked = tracer.startSpan('linked', { startTime: 1000 })
    linked.finish(1001)

    const span = tracer.startSpan('lifecycle', {
      startTime: 1000,
      tags: { 'custom.tag': 'custom-value', 'numeric.tag': 42 },
    })
    span.setTag('http.url', 'https://example.com')
    span.addLink({ context: linked.context(), attributes: { reason: 'test' } })
    span.addEvent('event-1', { key: 'value' }, 1000.5)
    span.meta_struct = {
      '_dd.appsec.s.req.body': {
        account: 'ruben',
        omitted: undefined,
      },
    }
    span.finish(1001)
    await materialize()

    const exported = findSpan('lifecycle')
    assert.ok(exported)
    assert.strictEqual(exported.meta['custom.tag'], 'custom-value')
    assert.strictEqual(exported.metrics['numeric.tag'], 42)
    assert.strictEqual(JSON.parse(exported.meta['_dd.span_links']).length, 1)
    assert.strictEqual(exported.span_events[0].name, 'event-1')
    assert.ok(exported.meta_struct['_dd.appsec.s.req.body'] instanceof Uint8Array)
  })

  it('only finishes once', async () => {
    const span = tracer.startSpan('double-finish')
    const processSpan = sinon.spy(tracer._processor, 'process')

    span.finish()
    span.finish()
    await materialize()

    sinon.assert.calledOnce(processSpan)
  })

  it('exports a parent and child in one finalized chunk', async () => {
    const parent = tracer.startSpan('parent')

    tracer.scope().activate(parent, () => {
      tracer.trace('child', {}, child => {
        assert.strictEqual(child.context()._parentId.toString(), parent.context()._spanId.toString())
        assert.strictEqual(child.context()._trace, parent.context()._trace)
      })
    })
    parent.finish()
    await materialize()

    assert.ok(findSpan('parent'))
    assert.ok(findSpan('child'))
    assert.strictEqual(sentTraces.length, 1)
  })

  it('applies service, resource, and type through tracer.trace options', async () => {
    tracer.trace('typed', { service: 'svc', resource: 'GET /x', type: 'web' }, span => {
      assert.strictEqual(span.context().getTags()[SERVICE_NAME], 'svc')
      assert.strictEqual(span.context().getTags()[RESOURCE_NAME], 'GET /x')
      assert.strictEqual(span.context().getTags()[SPAN_TYPE], 'web')
    })
    await materialize()

    const exported = findSpan('typed')
    assert.strictEqual(exported.service, 'svc')
    assert.strictEqual(exported.resource, 'GET /x')
    assert.strictEqual(exported.type, 'web')
  })

  it('uses only the final representation after tag replacement and deletion', async () => {
    const span = tracer.startSpan('final-tags')

    span.setTag('dynamic.tag', 'first')
    span.setTag('dynamic.tag', 42)
    span.setTag('removed.tag', 'present')
    span.setTag('removed.tag', undefined)
    span.addTags({ obj: { a: 1, b: 'x' } })
    span.context().clearTags()
    span.setTag('service.name', 'test-service')
    span.setTag('dynamic.tag', 42)
    span.finish()
    await materialize()

    const exported = findSpan('final-tags')
    assert.strictEqual(exported.meta['dynamic.tag'], undefined)
    assert.strictEqual(exported.metrics['dynamic.tag'], 42)
    assert.strictEqual(exported.meta['removed.tag'], undefined)
    assert.strictEqual(exported.metrics['obj.a'], undefined)
    assert.strictEqual(exported.meta['obj.b'], undefined)
  })

  it('uses the final cleared error state', async () => {
    const span = tracer.startSpan('final-error')

    span.setTag('error.message', 'first')
    span.context().deleteTag('error.message')
    span.setTag('error', 0)
    span.finish()
    await materialize()

    const exported = findSpan('final-error')
    assert.strictEqual(exported.error, 0)
    assert.strictEqual(exported.meta['error.message'], undefined)
  })

  it('propagates errors thrown inside tracer.trace callbacks', async () => {
    const error = new Error('test')
    assert.throws(() => tracer.trace('erroring', {}, () => { throw error }), /^Error: test$/)
    await materialize()
  })

  it('round-trips trace context through inject and extract', async () => {
    const span = tracer.startSpan('inject-source')
    const carrier = {}

    tracer.inject(span.context(), 'text_map', carrier)
    const extracted = tracer.extract('text_map', carrier)

    assert.ok(extracted)
    assert.strictEqual(extracted._traceId.toString(), span.context()._traceId.toString())
    span.finish()
    await materialize()
  })
})
