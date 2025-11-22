'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { describe, it } = require('tap').mocha
const sinon = require('sinon')
const { performance } = require('perf_hooks')
const { timeOrigin } = performance
const { timeInputToHrTime } = require('@opentelemetry/core')

require('../setup/core')

const tracer = require('../../').init()

const api = require('@opentelemetry/api')
const TracerProvider = require('../../src/opentelemetry/tracer_provider')
const SpanContext = require('../../src/opentelemetry/span_context')
const { NoopSpanProcessor } = require('../../src/opentelemetry/span_processor')

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE, IGNORE_OTEL_ERROR } = require('../../src/constants')
const { SERVICE_NAME, RESOURCE_NAME, SPAN_KIND } = require('../../../../ext/tags')
const kinds = require('../../../../ext/kinds')
const spanFormat = require('../../src/span_format')

const spanKindNames = {
  [api.SpanKind.INTERNAL]: kinds.INTERNAL,
  [api.SpanKind.SERVER]: kinds.SERVER,
  [api.SpanKind.CLIENT]: kinds.CLIENT,
  [api.SpanKind.PRODUCER]: kinds.PRODUCER,
  [api.SpanKind.CONSUMER]: kinds.CONSUMER
}

function makeSpan (...args) {
  const tracerProvider = new TracerProvider()
  tracerProvider.register()
  const tracer = tracerProvider.getTracer()
  return tracer.startSpan(...args)
}

describe('OTel Span', () => {
  it('should inherit service and host name from tracer', () => {
    const span = makeSpan('name')

    const context = span._ddSpan.context()
    assert.strictEqual(context._tags[SERVICE_NAME], tracer._tracer._service)
    assert.strictEqual(context._hostname, tracer._hostname)
  })

  it('should expose parent span id', () => {
    tracer.trace('outer', (outer) => {
      const span = makeSpan('name', {})
      assert.strictEqual(span.parentSpanId, outer.context()._spanId.toString(16))
    })
  })

  it('should expose span name', () => {
    const span = makeSpan('name')

    assert.strictEqual(span.name, 'name')
  })

  describe('span name default mapping', () => {
    // Explicitly named operation
    it('should map span name from operation.name', () => {
      const span = makeSpan(undefined, {
        attributes: {
          'operation.name': 'test'
        }
      })

      assert.strictEqual(span.name, 'test')
    })

    // HTTP server and client requests
    for (const key of ['http.method', 'http.request.method']) {
      for (const kind of [api.SpanKind.CLIENT, api.SpanKind.SERVER]) {
        const kindName = spanKindNames[kind]
        it(`should map span name from ${kindName} kind with ${key}`, () => {
          const span = makeSpan(undefined, { kind, attributes: { [key]: 'GET' } })
          assert.strictEqual(span.name, `http.${kindName}.request`)
        })
      }
    }

    // Database operations
    it('should map span name from db.system if client kind', () => {
      const span = makeSpan(undefined, {
        kind: api.SpanKind.CLIENT,
        attributes: {
          'db.system': 'mysql'
        }
      })

      assert.strictEqual(span.name, 'mysql.query')
    })

    // Messaging systems
    for (const kind of [
      api.SpanKind.CLIENT,
      api.SpanKind.SERVER,
      api.SpanKind.PRODUCER,
      api.SpanKind.CONSUMER
    ]) {
      const kindName = spanKindNames[kind]
      it(`should map span name from messaging.system and messaging.operation when ${kindName} kind`, () => {
        const attributes = {
          'messaging.system': kindName,
          'messaging.operation': 'send'
        }
        const span = makeSpan(undefined, { kind, attributes })
        assert.strictEqual(span.name, `${kindName}.send`)
      })
    }

    // AWS client request
    it('should map span name from rpc.system of aws-api if client kind', () => {
      const span = makeSpan(undefined, {
        kind: api.SpanKind.CLIENT,
        attributes: {
          'rpc.system': 'aws-api'
        }
      })

      assert.strictEqual(span.name, 'aws.client.request')
    })

    it('should map span name from rpc.system of aws-api with rpc.service if client kind', () => {
      const span = makeSpan(undefined, {
        kind: api.SpanKind.CLIENT,
        attributes: {
          'rpc.system': 'aws-api',
          'rpc.service': 's3'
        }
      })

      assert.strictEqual(span.name, 'aws.s3.request')
    })

    // RPC client and server requests
    for (const kind of [api.SpanKind.CLIENT, api.SpanKind.SERVER]) {
      const kindName = spanKindNames[kind]
      it(`should map span name from other rpc.system if ${kindName} kind`, () => {
        const span = makeSpan(undefined, {
          kind,
          attributes: {
            'rpc.system': 'system'
          }
        })

        assert.strictEqual(span.name, `system.${kindName}.request`)
      })
    }

    // FaaS invocations
    it('should map span name from faas.invoked_provider and faas.invoked_name if client kind', () => {
      const span = makeSpan(undefined, {
        kind: api.SpanKind.CLIENT,
        attributes: {
          'faas.invoked_provider': 'provider',
          'faas.invoked_name': 'name'
        }
      })

      assert.strictEqual(span.name, 'provider.name.invoke')
    })

    it('should map span name from faas.trigger if server kind', () => {
      const span = makeSpan(undefined, {
        kind: api.SpanKind.SERVER,
        attributes: {
          'faas.trigger': 'trigger'
        }
      })

      assert.strictEqual(span.name, 'trigger.invoke')
    })

    // GraphQL
    it('should map span name from graphql.operation.type', () => {
      const span = makeSpan(undefined, {
        attributes: {
          'graphql.operation.type': 'query'
        }
      })

      assert.strictEqual(span.name, 'graphql.server.request')
    })

    // Network
    for (const kind of [api.SpanKind.CLIENT, api.SpanKind.SERVER]) {
      const kindName = spanKindNames[kind]

      it(`should map span name when ${kindName} kind with network.protocol.name`, () => {
        const span = makeSpan(undefined, {
          kind,
          attributes: {
            'network.protocol.name': 'protocol'
          }
        })

        assert.strictEqual(span.name, `protocol.${kindName}.request`)
      })

      it(`should map span name when ${kindName} kind without network.protocol.name`, () => {
        const span = makeSpan(undefined, {
          kind
        })

        assert.strictEqual(span.name, `${kindName}.request`)
      })
    }

    // Default to span.kind
    for (const kind of [
      api.SpanKind.INTERNAL,
      api.SpanKind.PRODUCER,
      api.SpanKind.CONSUMER
    ]) {
      const kindName = spanKindNames[kind]
      it(`should map span name with ${kindName} kind`, () => {
        const span = makeSpan(undefined, { kind })
        assert.strictEqual(span.name, kindName)
      })
    }

    it('should map span name with default span kind of internal', () => {
      const span = makeSpan()
      assert.strictEqual(span.name, 'internal')
    })
  })

  it('should copy span name to resource.name', () => {
    const span = makeSpan('name')

    const context = span._ddSpan.context()
    assert.strictEqual(context._tags[RESOURCE_NAME], 'name')
  })

  it('should copy span kind to span.kind', () => {
    const span = makeSpan('name', { kind: api.SpanKind.CONSUMER })

    const context = span._ddSpan.context()
    assert.strictEqual(context._tags[SPAN_KIND], kinds.CONSUMER)
  })

  it('should expose span context', () => {
    const span = makeSpan('name')

    const spanContext = span.spanContext()
    assert.ok(spanContext instanceof SpanContext)
    assert.strictEqual(spanContext._ddContext, span._ddSpan.context())
  })

  it('should expose duration', () => {
    const span = makeSpan('name')
    span.end()

    assert.strictEqual(span.duration, span._ddSpan._duration)
  })

  it('should expose trace provider resource', () => {
    const resource = 'resource'
    const tracerProvider = new TracerProvider({
      resource
    })
    const tracer = tracerProvider.getTracer()

    const span = tracer.startSpan('name')

    assert.strictEqual(span.resource, resource)
  })

  it('should expose tracer instrumentation library', () => {
    const tracerProvider = new TracerProvider()
    const tracer = tracerProvider.getTracer('library name', '1.2.3')

    const span = tracer.startSpan('name')

    assert.deepStrictEqual(span.instrumentationLibrary, {
      name: 'library name',
      version: '1.2.3'
    })
  })

  it('should update span name', () => {
    const span = makeSpan('name')
    span.updateName('new name')

    assert.strictEqual(span.name, 'new name')
  })

  it('should set attributes', () => {
    const span = makeSpan('name')

    const { _tags } = span._ddSpan.context()

    span.setAttribute('foo', 'bar')
    assert.strictEqual(_tags.foo, 'bar')

    span.setAttributes({ baz: 'buz' })
    assert.strictEqual(_tags.baz, 'buz')
  })

  describe('should remap http.response.status_code', () => {
    it('should remap when setting attributes', () => {
      const span = makeSpan('name')

      const { _tags } = span._ddSpan.context()

      span.setAttributes({ 'http.response.status_code': 200 })
      assert.strictEqual(_tags['http.status_code'], '200')
    })

    it('should remap when setting singular attribute', () => {
      const span = makeSpan('name')

      const { _tags } = span._ddSpan.context()

      span.setAttribute('http.response.status_code', 200)
      assert.strictEqual(_tags['http.status_code'], '200')
    })
  })

  it('should set span links', () => {
    const span = makeSpan('name')
    const span2 = makeSpan('name2')
    const span3 = makeSpan('name3')

    const { _links } = span._ddSpan

    span.addLink({ context: span2.spanContext() })
    assert.strictEqual(_links.length, 1)

    span.addLink({ context: span3.spanContext() })
    assert.strictEqual(_links.length, 2)
  })

  it('should add span pointers', () => {
    const span = makeSpan('name')
    const { _links } = span._ddSpan

    span.addSpanPointer('pointer_kind', 'd', 'abc123')
    assert.strictEqual(_links.length, 1)
    assert.deepStrictEqual(_links[0].attributes, {
      'ptr.kind': 'pointer_kind',
      'ptr.dir': 'd',
      'ptr.hash': 'abc123',
      'link.kind': 'span-pointer'
    })
    assert.strictEqual(_links[0].context.toTraceId(), '0')
    assert.strictEqual(_links[0].context.toSpanId(), '0')

    span.addSpanPointer('another_kind', 'd', '1234567')
    assert.strictEqual(_links.length, 2)
    assert.deepStrictEqual(_links[1].attributes, {
      'ptr.kind': 'another_kind',
      'ptr.dir': 'd',
      'ptr.hash': '1234567',
      'link.kind': 'span-pointer'
    })
    assert.strictEqual(_links[1].context.toTraceId(), '0')
    assert.strictEqual(_links[1].context.toSpanId(), '0')
  })

  it('should set status', () => {
    const unset = makeSpan('name')
    const unsetCtx = unset._ddSpan.context()
    unset.setStatus({ code: 0, message: 'unset' })
    assert.ok(!Object.hasOwn(unsetCtx._tags, ERROR_MESSAGE))

    const ok = makeSpan('name')
    const okCtx = ok._ddSpan.context()
    ok.setStatus({ code: 1, message: 'ok' })
    assert.ok(!Object.hasOwn(okCtx._tags, ERROR_MESSAGE))
    assert.ok(!Object.hasOwn(okCtx._tags, IGNORE_OTEL_ERROR))

    const error = makeSpan('name')
    const errorCtx = error._ddSpan.context()
    error.setStatus({ code: 2, message: 'error' })
    assert.strictEqual(errorCtx._tags[ERROR_MESSAGE], 'error')
    assert.strictEqual(errorCtx._tags[IGNORE_OTEL_ERROR], false)
  })

  it('should record exceptions', () => {
    const span = makeSpan('name')

    class TestError extends Error {}

    const error = new TestError('test message')
    const datenow = Date.now()
    span.recordException(error, datenow)

    const { _tags } = span._ddSpan.context()
    assert.strictEqual(_tags[ERROR_TYPE], error.name)
    assert.strictEqual(_tags[ERROR_MESSAGE], error.message)
    assert.strictEqual(_tags[ERROR_STACK], error.stack)
    assert.strictEqual(_tags[IGNORE_OTEL_ERROR], true)

    const events = span._ddSpan._events
    assert.strictEqual(events.length, 1)
    assert.deepStrictEqual(events, [{
      name: error.name,
      attributes: {
        'exception.message': error.message,
        'exception.stacktrace': error.stack
      },
      startTime: datenow
    }])

    let formatted = spanFormat(span._ddSpan)
    assert.strictEqual(formatted.error, 0)
    assert.ok(!Object.hasOwn(formatted.meta, 'doNotSetTraceError'))

    // Set error code
    span.setStatus({ code: 2, message: 'error' })

    formatted = spanFormat(span._ddSpan)
    assert.strictEqual(formatted.error, 1)

    span.recordException(new Error('foobar'), Date.now())

    // Keep the error set to 1
    formatted = spanFormat(span._ddSpan)
    assert.strictEqual(formatted.error, 1)
    assert.ok(Object.hasOwn(formatted, 'meta'))
    assert.strictEqual(formatted.meta['error.message'], 'foobar')
  })

  it('should record exception without passing in time', () => {
    const stub = sinon.stub(performance, 'now').returns(60000)
    const span = makeSpan('name')

    class TestError extends Error {
      constructor () {
        super('test message')
      }
    }

    const time = timeInputToHrTime(60000 + timeOrigin)
    const timeInMilliseconds = time[0] * 1e3 + time[1] / 1e6

    const error = new TestError()
    span.recordException(error)

    const { _tags } = span._ddSpan.context()
    assert.strictEqual(_tags[ERROR_TYPE], error.name)
    assert.strictEqual(_tags[ERROR_MESSAGE], error.message)
    assert.strictEqual(_tags[ERROR_STACK], error.stack)

    const events = span._ddSpan._events
    assert.strictEqual(events.length, 1)
    assert.deepStrictEqual(events, [{
      name: error.name,
      attributes: {
        'exception.message': error.message,
        'exception.stacktrace': error.stack
      },
      startTime: timeInMilliseconds
    }])
    stub.restore()
  })

  it('should not set status on already ended spans', () => {
    const span = makeSpan('name')
    span.end()

    const { _tags } = span._ddSpan.context()

    span.setStatus({ code: 2, message: 'error' })
    assert.ok(!(ERROR_MESSAGE in _tags) || _tags[ERROR_MESSAGE] !== 'error')
  })

  it('should mark ended and expose recording state', () => {
    const span = makeSpan('name')

    assert.strictEqual(span.ended, false)
    assert.strictEqual(span.isRecording(), true)
    assert.strictEqual(span._ddSpan._duration, undefined)

    span.end()

    assert.strictEqual(span.ended, true)
    assert.strictEqual(span.isRecording(), false)
    assert.ok(Object.hasOwn(span._ddSpan, '_duration'))
  })

  it('should trigger span processor events', () => {
    const tracerProvider = new TracerProvider()
    const tracer = tracerProvider.getTracer()

    const processor = new NoopSpanProcessor()
    processor.onStart = sinon.stub()
    processor.onEnd = sinon.stub()
    tracerProvider.addSpanProcessor(processor)

    expect(processor.onStart).to.have.not.been.called
    expect(processor.onEnd).to.have.not.been.called

    const span = tracer.startSpan('name')

    sinon.assert.calledWith(processor.onStart, span, span._context)
    expect(processor.onEnd).to.have.not.been.called

    span.end()

    sinon.assert.calledWith(processor.onStart, span, span._context)
    sinon.assert.calledWith(processor.onEnd, span)
  })

  it('should add span events', () => {
    const span1 = makeSpan('span1')
    const span2 = makeSpan('span2')
    const datenow = Date.now()
    span1.addEvent('Web page unresponsive',
      { 'error.code': '403', 'unknown values': [1, ['h', 'a', [false]]] }, datenow)
    span2.addEvent('Web page loaded')
    span2.addEvent('Button changed color', { colors: [112, 215, 70], 'response.time': 134.3, success: true })
    const events1 = span1._ddSpan._events
    const events2 = span2._ddSpan._events
    assert.strictEqual(events1.length, 1)
    assert.deepStrictEqual(events1, [{
      name: 'Web page unresponsive',
      startTime: datenow,
      attributes: {
        'error.code': '403',
        'unknown values': [1]
      }
    }])
    assert.strictEqual(events2.length, 2)
  })
})
