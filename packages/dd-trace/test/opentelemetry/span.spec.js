'use strict'

const t = require('tap')
require('../setup/core')

const sinon = require('sinon')
const { performance } = require('perf_hooks')
const { timeOrigin } = performance
const { timeInputToHrTime } = require('@opentelemetry/core')

const { expect } = require('chai')
const tracer = require('../../').init()

const api = require('@opentelemetry/api')
const TracerProvider = require('../../src/opentelemetry/tracer_provider')
const SpanContext = require('../../src/opentelemetry/span_context')
const { NoopSpanProcessor } = require('../../src/opentelemetry/span_processor')

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE, IGNORE_OTEL_ERROR } = require('../../src/constants')
const { SERVICE_NAME, RESOURCE_NAME } = require('../../../../ext/tags')
const kinds = require('../../../../ext/kinds')
const format = require('../../src/format')

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

t.test('OTel Span', t => {
  t.test('should inherit service and host name from tracer', t => {
    const span = makeSpan('name')

    const context = span._ddSpan.context()
    expect(context._tags[SERVICE_NAME]).to.equal(tracer._tracer._service)
    expect(context._hostname).to.equal(tracer._hostname)
    t.end()
  })

  t.test('should expose parent span id', t => {
    tracer.trace('outer', (outer) => {
      const span = makeSpan('name', {})
      expect(span.parentSpanId).to.equal(outer.context()._spanId.toString(16))
    })
    t.end()
  })

  t.test('should expose span name', t => {
    const span = makeSpan('name')

    expect(span.name).to.equal('name')
    t.end()
  })

  t.test('span name default mapping', t => {
    // Explicitly named operation
    t.test('should map span name from operation.name', t => {
      const span = makeSpan(undefined, {
        attributes: {
          'operation.name': 'test'
        }
      })

      expect(span.name).to.equal('test')
      t.end()
    })

    // HTTP server and client requests
    for (const key of ['http.method', 'http.request.method']) {
      for (const kind of [api.SpanKind.CLIENT, api.SpanKind.SERVER]) {
        const kindName = spanKindNames[kind]
        t.test(`should map span name from ${kindName} kind with ${key}`, t => {
          const span = makeSpan(undefined, { kind, attributes: { [key]: 'GET' } })
          expect(span.name).to.equal(`http.${kindName}.request`)
          t.end()
        })
      }
    }

    // Database operations
    t.test('should map span name from db.system if client kind', t => {
      const span = makeSpan(undefined, {
        kind: api.SpanKind.CLIENT,
        attributes: {
          'db.system': 'mysql'
        }
      })

      expect(span.name).to.equal('mysql.query')
      t.end()
    })

    // Messaging systems
    for (const kind of [
      api.SpanKind.CLIENT,
      api.SpanKind.SERVER,
      api.SpanKind.PRODUCER,
      api.SpanKind.CONSUMER
    ]) {
      const kindName = spanKindNames[kind]
      t.test(`should map span name from messaging.system and messaging.operation when ${kindName} kind`, t => {
        const attributes = {
          'messaging.system': kindName,
          'messaging.operation': 'send'
        }
        const span = makeSpan(undefined, { kind, attributes })
        expect(span.name).to.equal(`${kindName}.send`)
        t.end()
      })
    }

    // AWS client request
    t.test('should map span name from rpc.system of aws-api if client kind', t => {
      const span = makeSpan(undefined, {
        kind: api.SpanKind.CLIENT,
        attributes: {
          'rpc.system': 'aws-api'
        }
      })

      expect(span.name).to.equal('aws.client.request')
      t.end()
    })

    t.test('should map span name from rpc.system of aws-api with rpc.service if client kind', t => {
      const span = makeSpan(undefined, {
        kind: api.SpanKind.CLIENT,
        attributes: {
          'rpc.system': 'aws-api',
          'rpc.service': 's3'
        }
      })

      expect(span.name).to.equal('aws.s3.request')
      t.end()
    })

    // RPC client and server requests
    for (const kind of [api.SpanKind.CLIENT, api.SpanKind.SERVER]) {
      const kindName = spanKindNames[kind]
      t.test(`should map span name from other rpc.system if ${kindName} kind`, t => {
        const span = makeSpan(undefined, {
          kind,
          attributes: {
            'rpc.system': 'system'
          }
        })

        expect(span.name).to.equal(`system.${kindName}.request`)
        t.end()
      })
    }

    // FaaS invocations
    t.test('should map span name from faas.invoked_provider and faas.invoked_name if client kind', t => {
      const span = makeSpan(undefined, {
        kind: api.SpanKind.CLIENT,
        attributes: {
          'faas.invoked_provider': 'provider',
          'faas.invoked_name': 'name'
        }
      })

      expect(span.name).to.equal('provider.name.invoke')
      t.end()
    })

    t.test('should map span name from faas.trigger if server kind', t => {
      const span = makeSpan(undefined, {
        kind: api.SpanKind.SERVER,
        attributes: {
          'faas.trigger': 'trigger'
        }
      })

      expect(span.name).to.equal('trigger.invoke')
      t.end()
    })

    // GraphQL
    t.test('should map span name from graphql.operation.type', t => {
      const span = makeSpan(undefined, {
        attributes: {
          'graphql.operation.type': 'query'
        }
      })

      expect(span.name).to.equal('graphql.server.request')
      t.end()
    })

    // Network
    for (const kind of [api.SpanKind.CLIENT, api.SpanKind.SERVER]) {
      const kindName = spanKindNames[kind]

      t.test(`should map span name when ${kindName} kind with network.protocol.name`, t => {
        const span = makeSpan(undefined, {
          kind,
          attributes: {
            'network.protocol.name': 'protocol'
          }
        })

        expect(span.name).to.equal(`protocol.${kindName}.request`)
        t.end()
      })

      t.test(`should map span name when ${kindName} kind without network.protocol.name`, t => {
        const span = makeSpan(undefined, {
          kind
        })

        expect(span.name).to.equal(`${kindName}.request`)
        t.end()
      })
    }

    // Default to span.kind
    for (const kind of [
      api.SpanKind.INTERNAL,
      api.SpanKind.PRODUCER,
      api.SpanKind.CONSUMER
    ]) {
      const kindName = spanKindNames[kind]
      t.test(`should map span name with ${kindName} kind`, t => {
        const span = makeSpan(undefined, { kind })
        expect(span.name).to.equal(kindName)
        t.end()
      })
    }

    t.test('should map span name with default span kind of internal', t => {
      const span = makeSpan()
      expect(span.name).to.equal('internal')
      t.end()
    })
    t.end()
  })

  t.test('should copy span name to resource.name', t => {
    const span = makeSpan('name')

    const context = span._ddSpan.context()
    expect(context._tags[RESOURCE_NAME]).to.equal('name')
    t.end()
  })

  t.test('should expose span context', t => {
    const span = makeSpan('name')

    const spanContext = span.spanContext()
    expect(spanContext).to.be.an.instanceOf(SpanContext)
    expect(spanContext._ddContext).to.be.equal(span._ddSpan.context())
    t.end()
  })

  t.test('should expose duration', t => {
    const span = makeSpan('name')
    span.end()

    expect(span.duration).to.equal(span._ddSpan._duration)
    t.end()
  })

  t.test('should expose trace provider resource', t => {
    const resource = 'resource'
    const tracerProvider = new TracerProvider({
      resource
    })
    const tracer = tracerProvider.getTracer()

    const span = tracer.startSpan('name')

    expect(span.resource).to.equal(resource)
    t.end()
  })

  t.test('should expose tracer instrumentation library', t => {
    const tracerProvider = new TracerProvider()
    const tracer = tracerProvider.getTracer('library name', '1.2.3')

    const span = tracer.startSpan('name')

    expect(span.instrumentationLibrary).to.eql({
      name: 'library name',
      version: '1.2.3'
    })
    t.end()
  })

  t.test('should update span name', t => {
    const span = makeSpan('name')
    span.updateName('new name')

    expect(span.name).to.equal('new name')
    t.end()
  })

  t.test('should set attributes', t => {
    const span = makeSpan('name')

    const { _tags } = span._ddSpan.context()

    span.setAttribute('foo', 'bar')
    expect(_tags).to.have.property('foo', 'bar')

    span.setAttributes({ baz: 'buz' })
    expect(_tags).to.have.property('baz', 'buz')
    t.end()
  })

  t.test('should remap http.response.status_code', t => {
    t.test('should remap when setting attributes', t => {
      const span = makeSpan('name')

      const { _tags } = span._ddSpan.context()

      span.setAttributes({ 'http.response.status_code': 200 })
      expect(_tags).to.have.property('http.status_code', '200')
      t.end()
    })

    t.test('should remap when setting singular attribute', t => {
      const span = makeSpan('name')

      const { _tags } = span._ddSpan.context()

      span.setAttribute('http.response.status_code', 200)
      expect(_tags).to.have.property('http.status_code', '200')
      t.end()
    })
    t.end()
  })

  t.test('should set span links', t => {
    const span = makeSpan('name')
    const span2 = makeSpan('name2')
    const span3 = makeSpan('name3')

    const { _links } = span._ddSpan

    span.addLink(span2.spanContext())
    expect(_links).to.have.lengthOf(1)

    span.addLink(span3.spanContext())
    expect(_links).to.have.lengthOf(2)
    t.end()
  })

  t.test('should add span pointers', t => {
    const span = makeSpan('name')
    const { _links } = span._ddSpan

    span.addSpanPointer('pointer_kind', 'd', 'abc123')
    expect(_links).to.have.lengthOf(1)
    expect(_links[0].attributes).to.deep.equal({
      'ptr.kind': 'pointer_kind',
      'ptr.dir': 'd',
      'ptr.hash': 'abc123',
      'link.kind': 'span-pointer'
    })
    expect(_links[0].context.toTraceId()).to.equal('0')
    expect(_links[0].context.toSpanId()).to.equal('0')

    span.addSpanPointer('another_kind', 'd', '1234567')
    expect(_links).to.have.lengthOf(2)
    expect(_links[1].attributes).to.deep.equal({
      'ptr.kind': 'another_kind',
      'ptr.dir': 'd',
      'ptr.hash': '1234567',
      'link.kind': 'span-pointer'
    })
    expect(_links[1].context.toTraceId()).to.equal('0')
    expect(_links[1].context.toSpanId()).to.equal('0')
    t.end()
  })

  t.test('should set status', t => {
    const unset = makeSpan('name')
    const unsetCtx = unset._ddSpan.context()
    unset.setStatus({ code: 0, message: 'unset' })
    expect(unsetCtx._tags).to.not.have.property(ERROR_MESSAGE)

    const ok = makeSpan('name')
    const okCtx = ok._ddSpan.context()
    ok.setStatus({ code: 1, message: 'ok' })
    expect(okCtx._tags).to.not.have.property(ERROR_MESSAGE)
    expect(okCtx._tags).to.not.have.property(IGNORE_OTEL_ERROR)

    const error = makeSpan('name')
    const errorCtx = error._ddSpan.context()
    error.setStatus({ code: 2, message: 'error' })
    expect(errorCtx._tags).to.have.property(ERROR_MESSAGE, 'error')
    expect(errorCtx._tags).to.have.property(IGNORE_OTEL_ERROR, false)
    t.end()
  })

  t.test('should record exceptions', t => {
    const span = makeSpan('name')

    class TestError extends Error {}

    const error = new TestError('test message')
    const datenow = Date.now()
    span.recordException(error, datenow)

    const { _tags } = span._ddSpan.context()
    expect(_tags).to.have.property(ERROR_TYPE, error.name)
    expect(_tags).to.have.property(ERROR_MESSAGE, error.message)
    expect(_tags).to.have.property(ERROR_STACK, error.stack)
    expect(_tags).to.have.property(IGNORE_OTEL_ERROR, true)

    const events = span._ddSpan._events
    expect(events).to.have.lengthOf(1)
    expect(events).to.deep.equal([{
      name: error.name,
      attributes: {
        'exception.message': error.message,
        'exception.stacktrace': error.stack
      },
      startTime: datenow
    }])

    let formatted = format(span._ddSpan)
    expect(formatted).to.have.property('error', 0)
    expect(formatted.meta).to.not.have.property('doNotSetTraceError')

    // Set error code
    span.setStatus({ code: 2, message: 'error' })

    formatted = format(span._ddSpan)
    expect(formatted).to.have.property('error', 1)

    span.recordException(new Error('foobar'), Date.now())

    // Keep the error set to 1
    formatted = format(span._ddSpan)
    expect(formatted).to.have.property('error', 1)
    expect(formatted).to.have.property('meta')
    expect(formatted.meta).to.have.property('error.message', 'foobar')
    t.end()
  })

  t.test('should record exception without passing in time', t => {
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
    expect(_tags).to.have.property(ERROR_TYPE, error.name)
    expect(_tags).to.have.property(ERROR_MESSAGE, error.message)
    expect(_tags).to.have.property(ERROR_STACK, error.stack)

    const events = span._ddSpan._events
    expect(events).to.have.lengthOf(1)
    expect(events).to.deep.equal([{
      name: error.name,
      attributes: {
        'exception.message': error.message,
        'exception.stacktrace': error.stack
      },
      startTime: timeInMilliseconds
    }])
    stub.restore()
    t.end()
  })

  t.test('should not set status on already ended spans', t => {
    const span = makeSpan('name')
    span.end()

    const { _tags } = span._ddSpan.context()

    span.setStatus({ code: 2, message: 'error' })
    expect(_tags).to.not.have.property(ERROR_MESSAGE, 'error')
    t.end()
  })

  t.test('should mark ended and expose recording state', t => {
    const span = makeSpan('name')

    expect(span.ended).to.equal(false)
    expect(span.isRecording()).to.equal(true)
    expect(span._ddSpan).to.have.property('_duration', undefined)

    span.end()

    expect(span.ended).to.equal(true)
    expect(span.isRecording()).to.equal(false)
    expect(span._ddSpan).to.have.property('_duration')
    t.end()
  })

  t.test('should trigger span processor events', t => {
    const tracerProvider = new TracerProvider()
    const tracer = tracerProvider.getTracer()

    const processor = new NoopSpanProcessor()
    processor.onStart = sinon.stub()
    processor.onEnd = sinon.stub()
    tracerProvider.addSpanProcessor(processor)

    expect(processor.onStart).to.have.not.been.called
    expect(processor.onEnd).to.have.not.been.called

    const span = tracer.startSpan('name')

    expect(processor.onStart).to.have.been.calledWith(span, span._context)
    expect(processor.onEnd).to.have.not.been.called

    span.end()

    expect(processor.onStart).to.have.been.calledWith(span, span._context)
    expect(processor.onEnd).to.have.been.calledWith(span)
    t.end()
  })

  t.test('should add span events', t => {
    const span1 = makeSpan('span1')
    const span2 = makeSpan('span2')
    const datenow = Date.now()
    span1.addEvent('Web page unresponsive',
      { 'error.code': '403', 'unknown values': [1, ['h', 'a', [false]]] }, datenow)
    span2.addEvent('Web page loaded')
    span2.addEvent('Button changed color', { colors: [112, 215, 70], 'response.time': 134.3, success: true })
    const events1 = span1._ddSpan._events
    const events2 = span2._ddSpan._events
    expect(events1).to.have.lengthOf(1)
    expect(events1).to.deep.equal([{
      name: 'Web page unresponsive',
      startTime: datenow,
      attributes: {
        'error.code': '403',
        'unknown values': [1]
      }
    }])
    expect(events2).to.have.lengthOf(2)
    t.end()
  })
  t.end()
})
